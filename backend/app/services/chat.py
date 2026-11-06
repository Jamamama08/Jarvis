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
from dataclasses import dataclass
from datetime import UTC, date, datetime

import anyio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.db import safe_commit, shielded_session
from app.models import (
    ApiUsage,
    Conversation,
    Message,
    MessageRole,
    MessageStatus,
    PermissionDecision,
    PermissionLevel,
    ToolExecution,
    ToolExecutionStatus,
    User,
)
from app.schemas import MessageOut
from app.services.memory import build_memory_context
from app.services.preferences import load_preferences
from app.services.prompts import build_system_prompt
from app.services.providers import (
    ChatProvider,
    ChatTurn,
    Completed,
    ProviderError,
    ProviderJSONError,
    Started,
    TextDelta,
    TextReset,
    ToolUseStart,
)
from app.tools import executor, permissions
from app.tools.base import ToolContext
from app.tools.executor import ApprovalBroker
from app.tools.registry import ToolRegistry
from app.tools.server_tools import describe_server_result, web_tool_definitions

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
    turns = []
    for m in rows:
        if not m.content.strip() and not (isinstance(m.blocks, dict) and m.blocks.get("exchange")):
            continue
        blocks = m.blocks if isinstance(m.blocks, dict) else {}
        turns.append(
            ChatTurn(
                role=m.role.value,
                content=m.content,
                context=blocks.get("memory_context") or None,
                memory_ids=tuple(m.memory_ids),
                exchange=blocks.get("exchange") or None,
            )
        )
    return turns


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
        cost = turn.size()
        if kept and used + cost > budget:
            break
        kept.append(turn)
        used += cost
    kept.reverse()
    while kept and kept[0].role != "user":
        kept.pop(0)
    return kept


def _usage_row(completed: Completed | None, started: Started | None, parts: list[str], configured: bool) -> dict | None:
    """Usage to record for one model request. Billed tokens are recorded even when a reply is cancelled or
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
            "web_search_requests": completed.web_search_requests,
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


def _tokens(usage: dict) -> int:
    return usage["input_tokens"] + usage["output_tokens"] + usage["cache_read_tokens"] + usage["cache_write_tokens"]


def close_exchange(exchange: list[dict], reason: str) -> None:
    """Make a stored exchange valid to replay: every tool_use must have a tool_result."""
    if not exchange or exchange[-1]["role"] != "assistant":
        return
    pending = [b["id"] for b in exchange[-1]["content"] if isinstance(b, dict) and b.get("type") == "tool_use"]
    if pending:
        exchange.append({
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tid, "is_error": True, "content": reason} for tid in pending],
        })


def _joined(parts: list[list[str]]) -> str:
    return "\n\n".join(t for t in ("".join(p).strip() for p in parts) if t)


@dataclass
class TurnState:
    """Mutable state of one agent turn, shared with the tool-call helper."""

    cancelled: bool = False
    tokens_used: int = 0


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
    tools: ToolRegistry | None = None,
    approvals: ApprovalBroker | None = None,
    services: dict | None = None,
) -> AsyncIterator[str]:
    """Async generator of SSE frames for one user turn: the agent loop.

    Each iteration streams one model request. If Claude calls tools, each call is validated,
    checked against the user's permissions (pausing for approval when needed), executed with a
    timeout and logged; the results go back to Claude. The loop ends when Claude answers without
    calling tools, or when a limit (iterations, wall-clock time, token budget) is reached.
    Caller must have called registry.start().
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + settings.turn_timeout_seconds
    try:
        async with shielded_session(sessionmaker) as db:
            conversation = await db.get(Conversation, conversation_id)
            user = await db.get(User, user_id)
            prefs = await load_preferences(db, user_id)
            model = prefs.model or settings.default_model
            max_tokens = prefs.max_output_tokens or settings.max_output_tokens

            seq = await _next_seq(db, conversation_id)
            user_msg = Message(conversation_id=conversation_id, seq=seq, role=MessageRole.user, content=content)
            if prefs.memory_enabled and provider.configured:
                # Attach relevant approved memories to this turn, skipping ones already present in the
                # history that will be sent. Stored with the message so replays are byte-identical.
                prior = trim_history(await _history(db, conversation_id) + [ChatTurn("user", content)], settings.max_context_tokens)
                already_sent = {mid for turn in prior for mid in turn.memory_ids}
                memory_context = await build_memory_context(db, user_id, content, exclude_ids=already_sent)
                if memory_context:
                    user_msg.blocks = {"memory_context": memory_context.text, "memory_ids": memory_context.memory_ids}
            db.add(user_msg)
            if conversation.title == DEFAULT_TITLE:
                conversation.title = title_from(content)
            conversation.updated_at = datetime.now(UTC)
            await db.flush()
            history = trim_history(await _history(db, conversation_id), settings.max_context_tokens)

            reply = Message(
                conversation_id=conversation_id,
                seq=seq + 1,
                role=MessageRole(provider.output_role),
                content="",
                status=MessageStatus.streaming,
                model=model if provider.configured else None,
            )
            db.add(reply)
            await safe_commit(db)

            yield sse("user_message", MessageOut.model_validate(user_msg).model_dump(mode="json"))
            yield sse("conversation", {"id": conversation.id, "title": conversation.title})
            yield sse("reply_start", MessageOut.model_validate(reply).model_dump(mode="json"))

            use_tools = bool(tools) and prefs.tools_enabled and provider.configured
            tool_defs: list[dict] = tools.definitions(settings) if use_tools else []
            if provider.configured and prefs.web_search_enabled:
                tool_defs = tool_defs + web_tool_definitions(model)
            system = build_system_prompt(
                prefs, user.display_name or user.username, date.today(),
                tools_enabled=use_tools, web_search=provider.configured and prefs.web_search_enabled,
            )

            state = TurnState()
            parts: list[list[str]] = []  # displayed text, one list per model request
            exchange: list[dict] = []  # API messages produced during this turn (for replay)
            used_tools = False
            final_status = MessageStatus.complete
            error: str | None = None
            notice: str | None = None
            last: Completed | None = None
            iteration = 0
            json_retries = 0
            try:
                while True:
                    if iteration >= settings.max_tool_iterations:
                        notice = f"Stopped after {iteration} steps (the limit per message). Ask me to continue if needed."
                        break
                    if loop.time() >= deadline:
                        notice = "Stopped because this message hit the time limit."
                        break
                    iteration += 1
                    iter_parts: list[str] = []
                    parts.append(iter_parts)
                    completed: Completed | None = None
                    started: Started | None = None
                    try:
                        events = provider.stream(
                            history, model=model, max_tokens=max_tokens, system=system,
                            effort=prefs.effort or None, tools=tool_defs or None, tail=exchange,
                        )
                        # aclosing() closes the upstream HTTP stream immediately on cancel, so no more tokens are billed.
                        async with contextlib.aclosing(events):
                            async for event in events:
                                if cancel_event.is_set():
                                    state.cancelled = True
                                    break
                                if isinstance(event, TextDelta):
                                    iter_parts.append(event.text)
                                    yield sse("delta", {"text": event.text})
                                elif isinstance(event, TextReset):
                                    iter_parts.clear()
                                    yield sse("reset", {"text": _joined(parts[:-1])})
                                elif isinstance(event, ToolUseStart):
                                    yield sse("tool_start", {"id": event.id, "name": event.name, "server": event.server})
                                elif isinstance(event, Started):
                                    started = event
                                elif isinstance(event, Completed):
                                    completed = event
                    except ProviderJSONError:
                        # A streamed tool input was unparseable; nothing ran. Re-issue the request (bounded).
                        await _record_usage(db, user_id, conversation_id, reply.id, _usage_row(None, started, iter_parts, True), state)
                        parts.pop()
                        json_retries += 1
                        if json_retries > 2:
                            raise ProviderError("Claude produced an unreadable tool request several times. Try rephrasing.")
                        yield sse("reset", {"text": _joined(parts)})
                        continue
                    finally:
                        if completed is not None or state.cancelled:
                            await _record_usage(db, user_id, conversation_id, reply.id, _usage_row(completed, started, iter_parts, provider.configured), state)

                    if state.cancelled:
                        break
                    last = completed
                    if completed is None:
                        raise ProviderError("The response ended unexpectedly.")
                    if completed.stop_reason == "refusal":
                        break  # handled at finalisation: partial output is discarded
                    if not provider.configured:
                        break
                    exchange.append({"role": "assistant", "content": completed.content})
                    if completed.content and any(b.get("type") == "server_tool_use" for b in completed.content):
                        used_tools = True
                        async for frame in _log_server_tools(sessionmaker, user_id, conversation_id, reply.id, completed.content):
                            yield frame
                    if completed.stop_reason == "pause_turn":
                        continue  # a server tool paused the turn; re-send to resume
                    tool_uses = [b for b in completed.content if b.get("type") == "tool_use"]
                    if completed.stop_reason != "tool_use" or not tool_uses:
                        if completed.stop_reason == "max_tokens":
                            notice = "Reached the maximum output length, so this response may be cut off."
                        break
                    used_tools = True
                    results: list[dict] = []
                    for block in tool_uses:
                        holder: dict = {}
                        async for frame in _tool_call(
                            block, holder, state=state, sessionmaker=sessionmaker, settings=settings, provider=provider,
                            tools=tools, approvals=approvals, cancel_event=cancel_event, user_id=user_id,
                            conversation_id=conversation_id, message_id=reply.id, model=model, usage_db=db,
                            services=services or {},
                        ):
                            yield frame
                        results.append(holder["result"])
                    exchange.append({"role": "user", "content": results})
                    if state.cancelled:
                        break
                    if state.tokens_used >= settings.turn_token_budget:
                        notice = f"Stopped because this message used its token budget ({settings.turn_token_budget:,} tokens)."
                        break
            except (asyncio.CancelledError, anyio.get_cancelled_exc_class()):
                state.cancelled = True
                raise
            except ProviderError as exc:
                final_status = MessageStatus.error
                error = exc.user_message
            except Exception:  # unexpected failure: log it, persist a generic error, keep the stream alive
                log.exception("Agent loop error in conversation %s", conversation_id)
                final_status = MessageStatus.error
                error = "Unexpected error while generating the response."
            finally:
                # Shield persistence from client-disconnect cancellation.
                with anyio.CancelScope(shield=True):
                    if state.cancelled:
                        final_status = MessageStatus.cancelled
                    reply.content = _joined(parts)
                    if last and last.model:
                        reply.model = last.model
                    if last and last.stop_reason == "refusal" and not state.cancelled:
                        # Output from a declined request must not be kept or replayed.
                        final_status = MessageStatus.error
                        reply.content = ""
                        exchange = []
                        category = f" (category: {last.refusal_category})" if last.refusal_category else ""
                        error = f"Claude declined to respond to this request{category}."
                    if final_status == MessageStatus.complete and notice:
                        error = notice
                    if used_tools and exchange:
                        close_exchange(exchange, "Cancelled: the turn ended before this tool ran.")
                        reply.blocks = {"exchange": exchange}
                    if last:
                        reply.input_tokens = last.input_tokens or None
                        reply.output_tokens = last.output_tokens or None
                    reply.status = final_status
                    reply.error = error
                    conversation.updated_at = datetime.now(UTC)
                    await safe_commit(db)

            done = MessageOut.model_validate(reply).model_dump(mode="json")
            done["tools"] = await _message_tools(db, reply.id)
            yield sse("reply_done", done)
    finally:
        registry.finish(conversation_id)


async def _record_usage(db: AsyncSession, user_id: str, conversation_id: str, message_id: str, usage: dict | None, state: TurnState) -> None:
    if not usage:
        return
    state.tokens_used += _tokens(usage)
    db.add(ApiUsage(user_id=user_id, conversation_id=conversation_id, message_id=message_id, **usage))
    await safe_commit(db)


async def _message_tools(db: AsyncSession, message_id: str) -> list[dict]:
    rows = (
        await db.execute(select(ToolExecution).where(ToolExecution.message_id == message_id).order_by(ToolExecution.created_at))
    ).scalars()
    return [executor.to_out(r, summary=(r.input or {}).get("_summary", "")) for r in rows]


async def _log_server_tools(sessionmaker, user_id: str, conversation_id: str, message_id: str, content: list[dict]) -> AsyncIterator[str]:
    """Record Anthropic-run web search/fetch calls in the activity log and show them in the UI."""
    results = {b.get("tool_use_id"): b for b in content if str(b.get("type", "")).endswith("_tool_result")}
    async with shielded_session(sessionmaker) as tdb:
        for block in content:
            if block.get("type") != "server_tool_use":
                continue
            result = results.get(block.get("id"))
            ok, text = describe_server_result(result) if result else (False, "No result returned.")
            summary = str((block.get("input") or {}).get("query") or (block.get("input") or {}).get("url") or block.get("name"))
            ex = ToolExecution(
                user_id=user_id, conversation_id=conversation_id, message_id=message_id, tool_use_id=block.get("id"),
                tool_name=str(block.get("name")), permission_level=PermissionLevel.automatic,
                status=ToolExecutionStatus.succeeded if ok else ToolExecutionStatus.failed,
                input={**executor.log_input(block.get("input") or {}), "_summary": summary[:200]},
                output=executor.log_output(text) if ok else None, error=None if ok else text,
                duration_ms=None, finished_at=datetime.now(UTC),
            )
            tdb.add(ex)
            await safe_commit(tdb)
            yield sse("tool_result", executor.to_out(ex, summary=summary[:200]))


async def _tool_call(
    block: dict,
    holder: dict,
    *,
    state: TurnState,
    sessionmaker,
    settings: Settings,
    provider: ChatProvider,
    tools: ToolRegistry,
    approvals: ApprovalBroker | None,
    cancel_event: asyncio.Event,
    user_id: str,
    conversation_id: str,
    message_id: str,
    model: str,
    usage_db: AsyncSession,
    services: dict,
) -> AsyncIterator[str]:
    """Validate, authorise, run and log one tool call. Puts the tool_result block in holder['result']."""
    tool_use_id, name, raw = block["id"], block.get("name", ""), block.get("input")
    tool = tools.get(name)
    if tool is not None and not tool.enabled(settings):
        tool = None
    prep = executor.prepare(tool, name, raw)

    def result(text: str, is_error: bool) -> None:
        holder["result"] = {"type": "tool_result", "tool_use_id": tool_use_id, "content": text, "is_error": is_error}

    async with shielded_session(sessionmaker) as tdb:
        execution = ToolExecution(
            user_id=user_id, conversation_id=conversation_id, message_id=message_id, tool_use_id=tool_use_id,
            tool_name=name[:100], permission_level=tool.level if tool else PermissionLevel.automatic,
            status=ToolExecutionStatus.running, input={**(executor.log_input(raw) or {}), "_summary": prep.summary},
        )
        tdb.add(execution)

        async def emit(event: str) -> str:
            await safe_commit(tdb)
            return sse(event, executor.to_out(execution, summary=prep.summary))

        if prep.error:
            executor.finished(execution, ToolExecutionStatus.failed)
            execution.error = prep.error
            result(prep.error, True)
            yield await emit("tool_result")
            return

        if tool.preview is not None:
            # Describe the call using live state (e.g. the element's label and the site) for the approval prompt.
            try:
                async with shielded_session(sessionmaker) as preview_db:
                    preview_ctx = ToolContext(db=preview_db, user_id=user_id, conversation_id=conversation_id,
                                              settings=settings, provider=provider, model=model, services=services)
                    prep.summary = (await asyncio.wait_for(tool.preview(preview_ctx, prep.args), 5))[:300]
                execution.input = {**(execution.input or {}), "_summary": prep.summary}
            except Exception:  # cosmetic: fall back to the static summary
                pass

        decision = permissions.resolve(tool, await permissions.load_policies(tdb, user_id))
        if decision == PermissionDecision.deny:
            executor.finished(execution, ToolExecutionStatus.denied)
            execution.error = "Blocked by your permission settings."
            result(f"The user's permission settings block {tool.name}. Don't retry it; explain what you would have done.", True)
            yield await emit("tool_result")
            return

        if decision == PermissionDecision.ask:
            execution.status = ToolExecutionStatus.pending_approval
            yield await emit("tool_call")
            if approvals is None:
                outcome = {"approve": False}
            else:
                future = approvals.register(execution.id, user_id)
                cancel_wait = asyncio.ensure_future(cancel_event.wait())
                try:
                    done, _ = await asyncio.wait({future, cancel_wait}, timeout=settings.approval_timeout_seconds, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    cancel_wait.cancel()
                    approvals.discard(execution.id)
                if future in done and not future.cancelled():
                    outcome = future.result()
                elif cancel_wait in done or cancel_event.is_set():
                    outcome = {"cancelled": True}
                else:
                    outcome = {"timeout": True}
            if outcome.get("cancelled"):
                state.cancelled = True
                executor.finished(execution, ToolExecutionStatus.cancelled)
                execution.error = "Cancelled before approval."
                result("The user stopped the response before approving this action.", True)
                yield await emit("tool_result")
                return
            if not outcome.get("approve"):
                executor.finished(execution, ToolExecutionStatus.denied)
                execution.error = "Approval timed out." if outcome.get("timeout") else "Declined by you."
                result(
                    f"The user did not approve {tool.name}"
                    + (" (no answer in time)" if outcome.get("timeout") else "")
                    + ". Don't retry the same action unless they ask; offer an alternative or explain.",
                    True,
                )
                yield await emit("tool_result")
                return
            if outcome.get("remember") and tool.level == PermissionLevel.restricted:
                await permissions.set_policy(tdb, user_id, permissions.tool_scope(tool.name), PermissionDecision.allow, level=tool.level)
            execution.status = ToolExecutionStatus.approved

        execution.status = ToolExecutionStatus.running
        yield await emit("tool_call")

        async def record(usage: Completed) -> None:
            row = _usage_row(usage, None, [], True)
            await _record_usage(usage_db, user_id, conversation_id, message_id, row, state)

        # Each tool gets its own session so a failing tool can't break the turn's persistence.
        async with shielded_session(sessionmaker) as tool_session:
            ctx = ToolContext(
                db=tool_session, user_id=user_id, conversation_id=conversation_id, settings=settings,
                provider=provider, model=model, record_usage=record, services=services,
            )
            ok, output, duration = await executor.run(
                tool, ctx, prep.args, default_timeout=settings.tool_timeout_seconds, output_limit=settings.max_tool_output_chars
            )
            if ok:
                await safe_commit(tool_session)
            else:
                await tool_session.rollback()
        execution.duration_ms = duration
        if ok:
            executor.finished(execution, ToolExecutionStatus.succeeded)
            execution.output = executor.log_output(output)
        else:
            executor.finished(execution, ToolExecutionStatus.failed)
            execution.error = executor.log_output(output)
        result(output, not ok)
        yield await emit("tool_result")
