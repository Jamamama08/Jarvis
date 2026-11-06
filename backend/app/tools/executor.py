"""Tool execution: input validation, approvals, timeouts and redacted logging."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from app.models import ToolExecution, ToolExecutionStatus
from app.schemas import ToolExecutionOut
from app.tools.base import Tool, ToolContext, ToolError
from app.tools.redact import redact_value, truncate

UI_OUTPUT_CHARS = 4000


class ApprovalBroker:
    """Holds the futures for tool calls waiting for the user's decision."""

    def __init__(self) -> None:
        self._pending: dict[str, tuple[str, asyncio.Future]] = {}

    def register(self, execution_id: str, user_id: str) -> asyncio.Future:
        future = asyncio.get_running_loop().create_future()
        self._pending[execution_id] = (user_id, future)
        return future

    def resolve(self, execution_id: str, user_id: str, decision: dict) -> bool:
        entry = self._pending.get(execution_id)
        if entry is None or entry[0] != user_id or entry[1].done():
            return False
        entry[1].set_result(decision)
        return True

    def discard(self, execution_id: str) -> None:
        entry = self._pending.pop(execution_id, None)
        if entry and not entry[1].done():
            entry[1].cancel()

    def is_pending(self, execution_id: str) -> bool:
        return execution_id in self._pending


@dataclass
class Prepared:
    tool: Tool | None
    args: BaseModel | None
    error: str | None
    summary: str


def prepare(tool: Tool | None, name: str, raw_input: object) -> Prepared:
    """Validate a tool call's input. Invalid input never reaches the handler."""
    if tool is None:
        return Prepared(None, None, f"Unknown tool: {name}", name)
    if not isinstance(raw_input, dict):
        return Prepared(tool, None, json.dumps({"INVALID_JSON": json.dumps(raw_input)[:2000]}), tool.name)
    try:
        args = tool.input_model.model_validate(raw_input)
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(map(str, e['loc'])) or 'input'}: {e['msg']}" for e in exc.errors()[:5])
        return Prepared(tool, None, f"Invalid input for {tool.name}: {problems}", tool.name)
    return Prepared(tool, args, None, truncate(tool.describe_call(args), 200))


async def run(tool: Tool, ctx: ToolContext, args: BaseModel, *, default_timeout: float, output_limit: int) -> tuple[bool, str, int]:
    """Run a tool with a timeout. Returns (ok, text for Claude, duration in ms). Never raises (except cancellation)."""
    timeout = tool.timeout or default_timeout
    if tool.name == "run_python":
        timeout = default_timeout + 5  # the subprocess enforces its own limit; this is a backstop
    start = time.monotonic()
    try:
        output = await asyncio.wait_for(tool.handler(ctx, args), timeout)
        ok = True
    except TimeoutError:
        output, ok = f"{tool.name} timed out after {timeout:g} seconds.", False
    except ToolError as exc:
        output, ok = str(exc), False
    except Exception as exc:  # unexpected bug in a tool: report generically, keep the loop alive
        import logging

        logging.getLogger(__name__).exception("Tool %s crashed", tool.name)
        output, ok = f"{tool.name} failed unexpectedly ({type(exc).__name__}).", False
    return ok, truncate(str(output), output_limit), int((time.monotonic() - start) * 1000)


def log_input(raw_input: object) -> dict | None:
    if isinstance(raw_input, dict):
        value = redact_value(raw_input)
        text = json.dumps(value)
        if len(text) > 20_000:
            return {"_truncated": truncate(text, 20_000)}
        return value
    return {"_raw": truncate(str(raw_input), 2000)}


def log_output(text: str) -> str:
    return truncate(redact_value(text), 20_000)


def to_out(execution: ToolExecution, summary: str | None = None) -> dict:
    out = ToolExecutionOut.model_validate(execution)
    if summary is not None:
        out.summary = summary
    if out.output:
        out.output = truncate(out.output, UI_OUTPUT_CHARS)
    return out.model_dump(mode="json")


def finished(execution: ToolExecution, status: ToolExecutionStatus) -> None:
    from datetime import UTC, datetime

    execution.status = status
    execution.finished_at = datetime.now(UTC)


__all__ = [
    "ApprovalBroker",
    "Prepared",
    "prepare",
    "run",
    "log_input",
    "log_output",
    "to_out",
    "finished",
]
