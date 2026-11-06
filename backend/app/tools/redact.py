"""Redaction for tool logs: secrets never reach the tool_executions table."""

import re
from typing import Any

from app.core.logging import redact as redact_text

_SECRET_KEY = re.compile(r"(?i)(pass(word|phrase)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)")


def redact_value(value: Any, key: str = "") -> Any:
    if key and _SECRET_KEY.search(key):
        return "***"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {k: redact_value(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_value(v) for v in value]
    return value


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated {len(text) - limit} characters]"
