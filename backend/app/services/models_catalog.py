"""Curated Claude model list and per-token prices (USD per million tokens).

Prices are used only for *estimates* shown in the UI; Anthropic's invoice is
authoritative. Cache writes are billed at 1.25x input and cache reads at 0.1x
input for the default 5-minute cache.
"""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ModelInfo:
    id: str
    label: str
    description: str
    input_per_mtok: float
    output_per_mtok: float


MODELS: tuple[ModelInfo, ...] = (
    ModelInfo("claude-opus-5-5", "Claude Opus 5.5", "Most capable everyday model (recommended default)", 4.0, 20.0),
    ModelInfo("claude-sonnet-5-5", "Claude Sonnet 5.5", "Fast and capable, half the price of Opus", 2.0, 10.0),
    ModelInfo("claude-haiku-5-5", "Claude Haiku 5.5", "Fastest and cheapest, for simple requests", 0.10, 0.50),
    ModelInfo("claude-fable-5-1", "Claude Fable 5.1", "Anthropic's most capable model; premium price", 10.0, 50.0),
)

_BY_ID = {m.id: m for m in MODELS}


def estimate_cost(model: str, input_tokens: int, output_tokens: int, cache_read: int, cache_write: int) -> float | None:
    info = _BY_ID.get(model)
    if info is None:
        return None
    per = 1_000_000
    return (
        input_tokens * info.input_per_mtok
        + cache_write * info.input_per_mtok * 1.25
        + cache_read * info.input_per_mtok * 0.1
        + output_tokens * info.output_per_mtok
    ) / per
