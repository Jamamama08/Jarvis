"""Core tool types.

A tool is a name, a description written for Claude (saying *when* to use it), a
Pydantic input model (validated before anything runs), a permission level, an
async handler and a timeout. Handlers raise ToolError for expected failures;
the executor turns any failure into an error result for Claude.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import PermissionLevel

if TYPE_CHECKING:
    from app.core.config import Settings
    from app.services.providers import ChatProvider, Completed


class ToolError(Exception):
    """An expected failure, reported to Claude as an error result (message is shown as-is)."""


@dataclass
class ToolContext:
    db: AsyncSession
    user_id: str
    conversation_id: str | None
    settings: Settings
    provider: ChatProvider
    model: str
    #: Called with the usage of any Claude request a tool makes (e.g. the summarizer).
    record_usage: Callable[[Completed], Awaitable[None]] | None = None
    #: Shared services from the app (e.g. "browser": BrowserManager).
    services: dict = field(default_factory=dict)

    @property
    def workspace(self) -> Path:
        root = self.settings.resolved_workspace_dir
        root.mkdir(parents=True, exist_ok=True)
        return root


Handler = Callable[[ToolContext, Any], Awaitable[str]]


@dataclass
class Tool:
    name: str
    description: str
    input_model: type[BaseModel]
    level: PermissionLevel
    handler: Handler
    timeout: float | None = None  # seconds; None = settings.tool_timeout_seconds
    #: One-line human summary of a call, shown in approval prompts and the activity log.
    summarize: Callable[[Any], str] | None = None
    #: Optional check whether the tool is offered at all (e.g. a disabled feature).
    enabled: Callable[[Settings], bool] = field(default=lambda settings: True)
    #: Optional async description of what a call will do, using live state (shown in approvals).
    preview: Callable[[ToolContext, Any], Awaitable[str]] | None = None

    def definition(self) -> dict:
        schema = self.input_model.model_json_schema()
        schema.pop("title", None)
        for prop in schema.get("properties", {}).values():
            prop.pop("title", None)
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": schema,
            # Stream tool inputs as they're generated; inputs are validated with Pydantic before running.
            "eager_input_streaming": True,
        }

    def describe_call(self, args: BaseModel) -> str:
        if self.summarize:
            try:
                return self.summarize(args)
            except Exception:  # pragma: no cover - summaries are cosmetic
                pass
        return ", ".join(f"{k}={v!r}"[:80] for k, v in args.model_dump().items())
