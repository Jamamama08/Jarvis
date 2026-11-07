"""Tiny HTTP helpers (stdlib, run in a thread) with timeouts and size limits.
Tests replace `fetch` to avoid real network calls."""

import json
import urllib.error
import urllib.request

MAX_BYTES = 5_000_000
USER_AGENT = "JARVIS-personal-assistant/1.0"


class IntegrationError(Exception):
    """User-facing integration problem."""


def _fetch(url: str, *, method: str = "GET", data: bytes | None = None, headers: dict | None = None, timeout: float = 15) -> bytes:
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - http(s) validated by callers
            body = resp.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise IntegrationError(f"The server answered {exc.code} {exc.reason}.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise IntegrationError(f"Couldn't connect: {getattr(exc, 'reason', exc)}") from exc
    if len(body) > MAX_BYTES:
        raise IntegrationError("The response was too large.")
    return body


fetch = _fetch  # replaceable in tests


def get_json(url: str, timeout: float = 15) -> dict:
    try:
        return json.loads(fetch(url, timeout=timeout))
    except ValueError as exc:
        raise IntegrationError("The service returned an unreadable answer.") from exc


def require_http(url: str) -> str:
    url = url.strip()
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    if not url.startswith(("https://", "http://")):
        raise IntegrationError("The address must start with https:// (or http://).")
    return url
