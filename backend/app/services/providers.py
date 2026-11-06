"""Chat provider abstraction and the Claude implementation.

The conversation service talks to a ``ChatProvider``. ``ClaudeProvider`` streams
replies from the Anthropic Messages API with the official SDK.
``UnconfiguredProvider`` is used when no API key is set: it streams a clear
system notice instead of an AI reply.
"""

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol

import anthropic

from app.core.config import Settings

log = logging.getLogger(__name__)


@dataclass(slots=True)
class ChatTurn:
    role: Literal["user", "assistant"]
    content: str
    #: Memory context attached to a user turn (sent as a separate block before the text).
    context: str | None = None
    memory_ids: tuple[str, ...] = ()
    #: For an assistant turn that used tools: the exact API messages of the exchange
    #: (assistant content blocks, user tool_result blocks, ...), replayed verbatim.
    exchange: list[dict] | None = None

    def to_params(self) -> list[dict]:
        if self.exchange:
            return self.exchange
        if self.context:
            return [{
                "role": self.role,
                "content": [{"type": "text", "text": self.context}, {"type": "text", "text": self.content}],
            }]
        return [{"role": self.role, "content": self.content}]

    def size(self) -> int:
        """Approximate size in characters, for history budgeting."""
        if self.exchange:
            return len(json.dumps(self.exchange))
        return len(self.content) + len(self.context or "")


@dataclass(slots=True)
class TextDelta:
    text: str


@dataclass(slots=True)
class TextReset:
    """Discard text streamed so far (a mid-stream refusal was handed to a fallback model)."""


@dataclass(slots=True)
class Started:
    """Emitted when the model starts responding; input-side usage is known at this point."""

    model: str
    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass(slots=True)
class ToolUseStart:
    """Claude started a tool call (input still streaming). `server` = Anthropic-run tool (web search)."""

    id: str
    name: str
    server: bool = False


@dataclass(slots=True)
class Completed:
    stop_reason: str = "end_turn"
    model: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    refusal_category: str | None = None
    #: The response's content blocks as API params (thinking, text, tool_use, server tool blocks).
    content: list[dict] = field(default_factory=list)
    web_search_requests: int = 0


ProviderEvent = Started | TextDelta | TextReset | ToolUseStart | Completed


class ProviderJSONError(Exception):
    """A streamed tool input could not be parsed (possible with eager input streaming); retry the request."""


class ProviderError(Exception):
    """A provider failure with a message that is safe to show the user."""

    def __init__(self, user_message: str, *, usage: "Completed | None" = None, retryable: bool = False):
        super().__init__(user_message)
        self.user_message = user_message
        self.usage = usage  # tokens billed before the failure, if any
        self.retryable = retryable  # transient (rate limit, overload, network): worth retrying later


class ChatProvider(Protocol):
    name: str
    #: Role used to store the provider's output. "system" output is shown to the
    #: user but never sent back to the model as conversation history.
    output_role: Literal["assistant", "system"]

    @property
    def configured(self) -> bool: ...

    def stream(
        self,
        history: list[ChatTurn],
        *,
        model: str,
        max_tokens: int,
        system: str,
        effort: str | None = None,
        tools: list[dict] | None = None,
        tail: list[dict] | None = None,
    ) -> AsyncIterator[ProviderEvent]: ...


# ---------------------------------------------------------------------------
# Unconfigured
# ---------------------------------------------------------------------------

UNCONFIGURED_NOTICE = (
    "Claude is not connected, so I can't reply. Your message has been saved to this "
    "conversation. Add ANTHROPIC_API_KEY to the .env file in the JARVIS folder and "
    "restart the backend to enable responses."
)


class UnconfiguredProvider:
    name = "unconfigured"
    output_role: Literal["assistant", "system"] = "system"

    @property
    def configured(self) -> bool:
        return False

    async def stream(
        self, history: list[ChatTurn], *, model: str, max_tokens: int, system: str, effort: str | None = None,
        tools: list[dict] | None = None, tail: list[dict] | None = None,
    ) -> AsyncIterator[ProviderEvent]:
        words = UNCONFIGURED_NOTICE.split(" ")
        for i, word in enumerate(words):
            yield TextDelta(word if i == 0 else " " + word)
        yield Completed(stop_reason="not_configured")


# ---------------------------------------------------------------------------
# Claude
# ---------------------------------------------------------------------------

#: Models that accept server-side refusal fallback in its "default" form.
FALLBACK_CAPABLE_MODELS = frozenset({"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"})
FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _api_message(exc: anthropic.APIStatusError) -> str:
    """The API's own error message (e.g. 'max_tokens: ...'), without the raw JSON envelope."""
    body = exc.body
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
    return exc.message


def _retryable(exc: Exception) -> bool:
    if isinstance(exc, (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.APITimeoutError)):
        return True
    return isinstance(exc, anthropic.APIStatusError) and (exc.status_code >= 500 or exc.status_code == 529)


def _error_message(exc: Exception) -> str:
    """Translate SDK exceptions into user-facing text (never includes credentials)."""
    if isinstance(exc, anthropic.AuthenticationError):
        return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in your .env file."
    if isinstance(exc, anthropic.PermissionDeniedError):
        return "This API key doesn't have access to the selected model or feature."
    if isinstance(exc, anthropic.NotFoundError):
        return "The selected Claude model wasn't found. Check the model name in Settings."
    if isinstance(exc, anthropic.RateLimitError):
        return "Claude's rate limit was reached. Wait a moment and try again."
    if isinstance(exc, anthropic.BadRequestError):
        return f"Claude rejected the request: {_api_message(exc)}"
    if isinstance(exc, anthropic.APITimeoutError):
        return "The request to Claude timed out. Try again."
    if isinstance(exc, anthropic.APIConnectionError):
        return "Couldn't reach the Anthropic API. Check your internet connection."
    if isinstance(exc, anthropic.APIStatusError):
        if exc.status_code == 529 or exc.status_code >= 500:
            return "Claude is temporarily unavailable or overloaded. Try again shortly."
        return f"Claude API error ({exc.status_code}): {_api_message(exc)}"
    return "Unexpected error while talking to Claude."


class ClaudeProvider:
    name = "claude"
    output_role: Literal["assistant", "system"] = "assistant"

    def __init__(self, settings: Settings, client: anthropic.AsyncAnthropic | None = None):
        if client is None:
            if settings.anthropic_api_key is None:
                raise ValueError("ANTHROPIC_API_KEY is not set")
            client = anthropic.AsyncAnthropic(
                api_key=settings.anthropic_api_key.get_secret_value(),
                timeout=settings.request_timeout_seconds,
                max_retries=settings.max_retries,
            )
        self.client = client
        self.refusal_fallback = settings.refusal_fallback

    @property
    def configured(self) -> bool:
        return True

    def build_request(
        self,
        history: list[ChatTurn],
        *,
        model: str,
        max_tokens: int,
        system: str,
        effort: str | None,
        tools: list[dict] | None = None,
        tail: list[dict] | None = None,
    ) -> dict:
        messages = [p for t in history for p in t.to_params()] + list(tail or [])
        request: dict = {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            # Automatic prompt caching: the conversation prefix is re-read at ~10% of the input price.
            "cache_control": {"type": "ephemeral"},
        }
        # Thinking is left at each model's default (adaptive on current models). Effort is
        # only sent when the user chose one, so older models that reject it keep working.
        if effort:
            request["output_config"] = {"effort": effort}
        if tools:
            request["tools"] = tools
        if self.refusal_fallback and model in FALLBACK_CAPABLE_MODELS:
            request["fallbacks"] = "default"
            request["betas"] = [FALLBACK_BETA]
        return request

    async def stream(
        self, history: list[ChatTurn], *, model: str, max_tokens: int, system: str, effort: str | None = None,
        tools: list[dict] | None = None, tail: list[dict] | None = None,
    ) -> AsyncIterator[ProviderEvent]:
        request = self.build_request(
            history, model=model, max_tokens=max_tokens, system=system, effort=effort, tools=tools, tail=tail
        )
        try:
            async with self.client.beta.messages.stream(**request) as stream:
                async for event in stream:
                    if event.type == "content_block_start" and getattr(event.content_block, "type", None) in ("tool_use", "server_tool_use"):
                        block = event.content_block
                        yield ToolUseStart(id=block.id, name=block.name, server=block.type == "server_tool_use")
                    elif event.type == "text":
                        yield TextDelta(event.text)
                    elif event.type == "message_start":
                        u = event.message.usage
                        yield Started(
                            model=event.message.model,
                            input_tokens=u.input_tokens or 0,
                            cache_read_tokens=u.cache_read_input_tokens or 0,
                            cache_write_tokens=u.cache_creation_input_tokens or 0,
                        )
                    elif event.type == "content_block_start" and getattr(event.content_block, "type", None) == "fallback":
                        # The previous model declined mid-stream; its partial output must be discarded.
                        yield TextReset()
                final = await stream.get_final_message()
        except anthropic.AnthropicError as exc:
            request_id = getattr(getattr(exc, "response", None), "headers", {}).get("request-id", "-")
            log.warning("Claude request failed: %s (request-id %s)", type(exc).__name__, request_id)
            raise ProviderError(_error_message(exc), retryable=_retryable(exc)) from exc
        except ValueError as exc:  # unparseable streamed tool input (eager input streaming)
            raise ProviderJSONError(str(exc)) from exc

        usage = final.usage
        server_use = getattr(usage, "server_tool_use", None)
        details = getattr(final, "stop_details", None)
        yield Completed(
            stop_reason=final.stop_reason or "end_turn",
            model=final.model,
            input_tokens=usage.input_tokens or 0,
            output_tokens=usage.output_tokens or 0,
            cache_read_tokens=usage.cache_read_input_tokens or 0,
            cache_write_tokens=usage.cache_creation_input_tokens or 0,
            refusal_category=getattr(details, "category", None) if final.stop_reason == "refusal" else None,
            content=[block.model_dump(mode="json", exclude_none=True) for block in final.content],
            web_search_requests=(getattr(server_use, "web_search_requests", 0) or 0) if server_use else 0,
        )


@dataclass(slots=True)
class TextResult:
    text: str
    usage: Completed


async def complete_text(
    provider: "ClaudeProvider", *, model: str, system: str, prompt: str, max_tokens: int = 2000
) -> TextResult:
    """One non-streaming request returning plain text (used by tools such as the summarizer)."""
    request = provider.build_request([ChatTurn("user", prompt)], model=model, max_tokens=max_tokens, system=system, effort=None)
    request.pop("cache_control", None)
    try:
        response = await provider.client.beta.messages.create(**request)
    except anthropic.AnthropicError as exc:
        log.warning("Claude request failed: %s", type(exc).__name__)
        raise ProviderError(_error_message(exc), retryable=_retryable(exc)) from exc
    usage = Completed(
        stop_reason=response.stop_reason or "end_turn",
        model=response.model,
        input_tokens=response.usage.input_tokens or 0,
        output_tokens=response.usage.output_tokens or 0,
        cache_read_tokens=response.usage.cache_read_input_tokens or 0,
        cache_write_tokens=response.usage.cache_creation_input_tokens or 0,
    )
    if response.stop_reason == "refusal":
        raise ProviderError("Claude declined this request.", usage=usage)
    return TextResult(text="".join(b.text for b in response.content if b.type == "text").strip(), usage=usage)


@dataclass(slots=True)
class JsonResult:
    data: dict
    usage: Completed


async def complete_json(
    provider: "ClaudeProvider", *, model: str, system: str, prompt: str, schema: dict, max_tokens: int = 4000
) -> JsonResult:
    """One non-streaming request constrained to a JSON schema (structured outputs)."""
    request = provider.build_request(
        [ChatTurn("user", prompt)], model=model, max_tokens=max_tokens, system=system, effort=None
    )
    request.pop("cache_control", None)  # one-off request: nothing to reuse
    request["output_config"] = {"format": {"type": "json_schema", "schema": schema}}
    try:
        response = await provider.client.beta.messages.create(**request)
    except anthropic.AnthropicError as exc:
        log.warning("Claude JSON request failed: %s", type(exc).__name__)
        raise ProviderError(_error_message(exc), retryable=_retryable(exc)) from exc
    usage = Completed(
        stop_reason=response.stop_reason or "end_turn",
        model=response.model,
        input_tokens=response.usage.input_tokens or 0,
        output_tokens=response.usage.output_tokens or 0,
        cache_read_tokens=response.usage.cache_read_input_tokens or 0,
        cache_write_tokens=response.usage.cache_creation_input_tokens or 0,
    )
    if response.stop_reason == "refusal":
        raise ProviderError("Claude declined this request.", usage=usage)
    if response.stop_reason == "max_tokens":
        raise ProviderError("Claude's answer was cut off before it finished. Try again.", usage=usage)
    text_ = "".join(b.text for b in response.content if b.type == "text")
    try:
        data = json.loads(text_)
    except json.JSONDecodeError as exc:
        raise ProviderError("Claude returned an unreadable answer. Try again.", usage=usage) from exc
    if not isinstance(data, dict):
        raise ProviderError("Claude returned an unexpected answer. Try again.", usage=usage)
    return JsonResult(data=data, usage=usage)


def build_provider(settings: Settings) -> ChatProvider:
    if settings.anthropic_api_key and settings.anthropic_api_key.get_secret_value().strip():
        return ClaudeProvider(settings)
    return UnconfiguredProvider()
