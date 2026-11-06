"""Chat provider abstraction.

The conversation service talks to a ``ChatProvider``. Phase 1 ships only the
``UnconfiguredProvider``, which produces an explicit system notice instead of
an AI reply. Phase 2 adds a ``ClaudeProvider`` implementing the same protocol
(streaming, usage, cancellation), so nothing above this layer changes.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol

from app.core.config import Settings


@dataclass(slots=True)
class ChatTurn:
    role: Literal["user", "assistant"]
    content: str


@dataclass(slots=True)
class TextDelta:
    text: str


@dataclass(slots=True)
class Completed:
    stop_reason: str = "end_turn"
    input_tokens: int = 0
    output_tokens: int = 0
    extra: dict = field(default_factory=dict)


ProviderEvent = TextDelta | Completed


class ChatProvider(Protocol):
    name: str
    #: Role used to store the provider's output. "system" output is shown to the
    #: user but never sent back to the model as conversation history.
    output_role: Literal["assistant", "system"]

    @property
    def configured(self) -> bool: ...

    def stream(
        self, history: list[ChatTurn], *, model: str, max_tokens: int, system: str
    ) -> AsyncIterator[ProviderEvent]: ...


UNCONFIGURED_NOTICE = (
    "Claude is not connected yet, so I can't reply. Your message has been saved to this "
    "conversation. AI responses arrive in Phase 2: add ANTHROPIC_API_KEY to your .env file "
    "and restart the backend once that phase is installed."
)


class UnconfiguredProvider:
    name = "unconfigured"
    output_role: Literal["assistant", "system"] = "system"

    @property
    def configured(self) -> bool:
        return False

    async def stream(
        self, history: list[ChatTurn], *, model: str, max_tokens: int, system: str
    ) -> AsyncIterator[ProviderEvent]:
        # Emitted in word-sized chunks so the frontend streaming path is exercised end to end.
        words = UNCONFIGURED_NOTICE.split(" ")
        for i, word in enumerate(words):
            yield TextDelta(word if i == 0 else " " + word)
        yield Completed(stop_reason="not_configured")


def build_provider(settings: Settings) -> ChatProvider:
    # Phase 2: return ClaudeProvider(settings) when settings.anthropic_api_key is set.
    return UnconfiguredProvider()
