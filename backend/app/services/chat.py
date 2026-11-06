"""Conversation turn handling: persist the user message, stream the provider
response as Server-Sent Events, and persist the result (including partial
output when the client disconnects or cancels).
"""

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime

import anyio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.models import ApiUsage, Conversation, Message, MessageRole, MessageStatus, User
from app.schemas import MessageOut
from app.services.preferences import load_preferences
from app.services.prompts import build_system_prompt
from app.services.providers import ChatProvider, ChatTurn, Completed, ProviderError, Started, TextDelta, TextReset

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
    return [ChatTurn(role=m.role.value, content=m.content) for m in rows if m.content.strip()]


CHARS_PER_TOKEN = 4  # conservative-enough estimate for budgeting; no network call needed


def trim_history(turns: list[ChatTurn], max_tokens: int) -> list[ChatTurn]:
    """Keep the newest turns that fit the token budget; the result always starts with a user turn.

    The latest user turn is always kept, even if it alone exceeds the budget (the API
    will then report the problem rather than us silently truncating the user's text).
    """
    budget = max_tokens * CHARS_PER_TOKEN
    kept: list[ChatTurn] = []
    used = 0
    for turn in reversed(turns):
        cost = len(turn.content)
        if kept and used + cost > budget:
            break
        kept.append(turn)
        used += cost
    kept.reverse()
    while kept and kept[0].role != "user":
        kept.pop(0)
    return kept


def _usage_row(completed: Completed | None, started: Started | None, parts: list[str], configured: bool) -> dict | None:
    """Usage to record for a turn. Billed tokens are recorded even when a reply is cancelled or
    fails mid-stream: input tokens are exact (from message_start); output is then estimated."""
    if not configured:
        return None
    if completed and (completed.input_tokens or completed.output_tokens):
        return {
            "model": completed.model or (started.model if started else "unknown"),
            "input_tokens": completed.input_tokens,
            "output_tokens": completed.output_tokens,
            "cache_read_tokens": completed.cache_read_tokens,
            "cache_write_tokens": completed.cache_write_tokens,
        }
    if started:
        return {
            "model": started.model,
            "input_tokens": started.input_tokens,
            "output_tokens": -(-sum(len(p) for p in parts) // CHARS_PER_TOKEN),  # ceil estimate
            "cache_read_tokens": started.cache_read_tokens,
            "cache_write_tokens": started.cache_write_tokens,
        }
    return None


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
            user = await db.get(User, user_id)
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
            started: Started | None = None
            try:
                system = build_system_prompt(prefs, user.display_name or user.username, date.today())
                events = provider.stream(
                    trim_history(history, settings.max_context_tokens),
                    model=model,
                    max_tokens=max_tokens,
                    system=system,
                    effort=prefs.effort or None,
                )
                # aclosing() closes the upstream HTTP stream immediately on cancel, so no more tokens are billed.
                async with contextlib.aclosing(events):
                    async for event in events:
                        if cancel_event.is_set():
                            final_status = MessageStatus.cancelled
                            break
                        if isinstance(event, TextDelta):
                            parts.append(event.text)
                            yield sse("delta", {"text": event.text})
                        elif isinstance(event, TextReset):
                            parts.clear()
                            yield sse("reset", {})
                        elif isinstance(event, Started):
                            started = event
                        elif isinstance(event, Completed):
                            completed = event
            except (asyncio.CancelledError, anyio.get_cancelled_exc_class()):
                final_status = MessageStatus.cancelled
                raise
            except ProviderError as exc:
                final_status = MessageStatus.error
                error = exc.user_message
            except Exception:  # unexpected failure: log it, persist a generic error, keep the stream alive
                log.exception("Provider error in conversation %s", conversation_id)
                final_status = MessageStatus.error
                error = "Unexpected error while generating the response."
            finally:
                # Shield persistence from client-disconnect cancellation.
                with anyio.CancelScope(shield=True):
                    reply.content = "".join(parts)
                    if completed:
                        if completed.model:
                            reply.model = completed.model
                        if completed.stop_reason == "refusal":
                            # Partial output from a declined request must not be kept or replayed.
                            final_status = MessageStatus.error
                            reply.content = ""
                            category = f" (category: {completed.refusal_category})" if completed.refusal_category else ""
                            error = f"Claude declined to respond to this request{category}."
                        elif completed.stop_reason == "max_tokens":
                            error = "Reached the maximum output length, so this response may be cut off."
                        reply.input_tokens = completed.input_tokens or None
                        reply.output_tokens = completed.output_tokens or None
                    reply.status = final_status
                    reply.error = error
                    conversation.updated_at = datetime.now(UTC)
                    usage = _usage_row(completed, started, parts, provider.configured)
                    if usage:
                        db.add(ApiUsage(user_id=user_id, conversation_id=conversation_id, message_id=reply.id, **usage))
                    await db.commit()

            yield sse("reply_done", MessageOut.model_validate(reply).model_dump(mode="json"))
    finally:
        registry.finish(conversation_id)
