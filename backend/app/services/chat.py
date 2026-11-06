"""Conversation turn handling: persist the user message, stream the provider
response as Server-Sent Events, and persist the result (including partial
output when the client disconnects or cancels).
"""

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import anyio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.models import Conversation, Message, MessageRole, MessageStatus
from app.schemas import MessageOut
from app.services.preferences import load_preferences
from app.services.providers import ChatProvider, ChatTurn, Completed, TextDelta

log = logging.getLogger(__name__)

DEFAULT_TITLE = "New conversation"


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def title_from(content: str, limit: int = 60) -> str:
    text = " ".join(content.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return (cut or text[:limit]) + "…"


class GenerationRegistry:
    """Tracks in-flight generations so they can be cancelled explicitly."""

    #: Entries older than this are considered abandoned (e.g. the stream never started).
    STALE_AFTER_SECONDS = 15 * 60

    def __init__(self) -> None:
        self._active: dict[str, asyncio.Event] = {}
        self._started: dict[str, float] = {}

    def start(self, conversation_id: str) -> asyncio.Event:
        now = time.monotonic()
        if conversation_id in self._active and now - self._started[conversation_id] < self.STALE_AFTER_SECONDS:
            raise RuntimeError("busy")
        event = asyncio.Event()
        self._active[conversation_id] = event
        self._started[conversation_id] = now
        return event

    def finish(self, conversation_id: str) -> None:
        self._active.pop(conversation_id, None)
        self._started.pop(conversation_id, None)

    def cancel(self, conversation_id: str) -> bool:
        event = self._active.get(conversation_id)
        if event is None:
            return False
        event.set()
        return True

    def is_active(self, conversation_id: str) -> bool:
        return conversation_id in self._active


async def _next_seq(db: AsyncSession, conversation_id: str) -> int:
    current = (
        await db.execute(select(func.max(Message.seq)).where(Message.conversation_id == conversation_id))
    ).scalar_one()
    return (current or 0) + 1


async def _history(db: AsyncSession, conversation_id: str) -> list[ChatTurn]:
    rows = (
        await db.execute(
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                Message.role.in_([MessageRole.user, MessageRole.assistant]),
                Message.status.in_([MessageStatus.complete, MessageStatus.cancelled]),
            )
            .order_by(Message.seq)
        )
    ).scalars()
    return [ChatTurn(role=m.role.value, content=m.content) for m in rows if m.content]


async def run_turn(
    *,
    sessionmaker: async_sessionmaker[AsyncSession],
    settings: Settings,
    provider: ChatProvider,
    registry: GenerationRegistry,
    cancel_event: asyncio.Event,
    user_id: str,
    conversation_id: str,
    content: str,
) -> AsyncIterator[str]:
    """Async generator of SSE frames for one user turn. Caller must have called registry.start()."""
    try:
        async with sessionmaker() as db:
            conversation = await db.get(Conversation, conversation_id)
            prefs = await load_preferences(db, user_id)
            model = prefs.model or settings.default_model
            max_tokens = prefs.max_output_tokens or settings.max_output_tokens

            seq = await _next_seq(db, conversation_id)
            user_msg = Message(conversation_id=conversation_id, seq=seq, role=MessageRole.user, content=content)
            db.add(user_msg)
            if conversation.title == DEFAULT_TITLE:
                conversation.title = title_from(content)
            conversation.updated_at = datetime.now(UTC)
            await db.flush()
            history = await _history(db, conversation_id)

            reply = Message(
                conversation_id=conversation_id,
                seq=seq + 1,
                role=MessageRole(provider.output_role),
                content="",
                status=MessageStatus.streaming,
                model=model if provider.configured else None,
            )
            db.add(reply)
            await db.commit()

            yield sse("user_message", MessageOut.model_validate(user_msg).model_dump(mode="json"))
            yield sse("conversation", {"id": conversation.id, "title": conversation.title})
            yield sse("reply_start", MessageOut.model_validate(reply).model_dump(mode="json"))

            parts: list[str] = []
            final_status = MessageStatus.complete
            error: str | None = None
            completed: Completed | None = None
            try:
                system = f"You are {prefs.assistant_name}, a personal AI assistant."
                async for event in provider.stream(history, model=model, max_tokens=max_tokens, system=system):
                    if cancel_event.is_set():
                        final_status = MessageStatus.cancelled
                        break
                    if isinstance(event, TextDelta):
                        parts.append(event.text)
                        yield sse("delta", {"text": event.text})
                    elif isinstance(event, Completed):
                        completed = event
            except (asyncio.CancelledError, anyio.get_cancelled_exc_class()):
                final_status = MessageStatus.cancelled
                raise
            except Exception as exc:  # provider failure: persist and report, don't crash the stream
                log.exception("Provider error in conversation %s", conversation_id)
                final_status = MessageStatus.error
                error = f"{type(exc).__name__}: {exc}"
            finally:
                # Shield persistence from client-disconnect cancellation.
                with anyio.CancelScope(shield=True):
                    reply.content = "".join(parts)
                    reply.status = final_status
                    reply.error = error
                    if completed:
                        reply.input_tokens = completed.input_tokens or None
                        reply.output_tokens = completed.output_tokens or None
                    conversation.updated_at = datetime.now(UTC)
                    await db.commit()

            yield sse("reply_done", MessageOut.model_validate(reply).model_dump(mode="json"))
    finally:
        registry.finish(conversation_id)
