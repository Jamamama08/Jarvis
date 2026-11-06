"""ClaudeProvider tests against a mocked Anthropic API.

The mock transport replays the real Messages API streaming wire format, so the
official SDK's parsing, accumulation and error mapping run exactly as in
production; only the network is replaced.
"""

import asyncio
import json

import anthropic
import httpx2
import pytest
from httpx import ASGITransport, AsyncClient

from app.core.config import Settings
from app.main import create_app
from app.services.chat import trim_history
from app.services.providers import ChatTurn, ClaudeProvider, UnconfiguredProvider, build_provider

from .conftest import PASSWORD, parse_sse


def frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def stream_body(
    texts: list[str],
    *,
    model: str = "claude-opus-5-5",
    stop_reason: str = "end_turn",
    stop_details: dict | None = None,
    usage: dict | None = None,
    fallback_after: int | None = None,
) -> list[str]:
    usage = usage or {"input_tokens": 120, "output_tokens": 30, "cache_read_input_tokens": 80, "cache_creation_input_tokens": 40}
    frames = [
        frame(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_test", "type": "message", "role": "assistant", "model": model, "content": [],
                    "stop_reason": None, "stop_sequence": None,
                    "usage": {**usage, "output_tokens": 1},
                },
            },
        )
    ]
    index = 0
    frames.append(frame("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}))
    for i, text in enumerate(texts):
        if fallback_after is not None and i == fallback_after:
            frames.append(frame("content_block_stop", {"type": "content_block_stop", "index": index}))
            index += 1
            frames.append(frame("content_block_start", {"type": "content_block_start", "index": index, "content_block": {
                "type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}}}))
            frames.append(frame("content_block_stop", {"type": "content_block_stop", "index": index}))
            index += 1
            frames.append(frame("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}))
        frames.append(frame("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": text}}))
    frames.append(frame("content_block_stop", {"type": "content_block_stop", "index": index}))
    delta: dict = {"stop_reason": stop_reason, "stop_sequence": None}
    if stop_details is not None:
        delta["stop_details"] = stop_details
    frames.append(frame("message_delta", {"type": "message_delta", "delta": delta, "usage": {"output_tokens": usage["output_tokens"]}}))
    frames.append(frame("message_stop", {"type": "message_stop"}))
    return frames


class FakeAnthropic:
    """Records requests and replies with queued responses."""

    def __init__(self):
        self.requests: list[httpx2.Request] = []
        self.responses: list[httpx2.Response] = []

    def queue_stream(self, frames: list[str] | httpx2.AsyncByteStream):
        headers = {"content-type": "text/event-stream"}
        if isinstance(frames, list):
            self.responses.append(httpx2.Response(200, headers=headers, content="".join(frames).encode()))
        else:  # a live stream object, so tests can observe when the SDK closes it
            self.responses.append(httpx2.Response(200, headers=headers, stream=frames))

    def queue_error(self, status: int, error_type: str, message: str):
        self.responses.append(
            httpx2.Response(status, json={"type": "error", "error": {"type": error_type, "message": message}})
        )

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.responses.pop(0)

    def body(self, i: int = -1) -> dict:
        return json.loads(self.requests[i].content)

    def client(self) -> anthropic.AsyncAnthropic:
        return anthropic.AsyncAnthropic(
            api_key="sk-ant-test-key-1234567890",
            max_retries=0,
            http_client=anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(self.handler)),
        )


@pytest.fixture
def fake():
    return FakeAnthropic()


@pytest.fixture
async def claude_client(tmp_path, fake):
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=None, _env_file=None)
    app = create_app(settings)
    app.state.provider = ClaudeProvider(settings, client=fake.client())
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.post("/api/auth/setup", json={"username": "tony", "password": PASSWORD, "display_name": "Tony"})
            c.headers["Authorization"] = f"Bearer {r.json()['token']}"
            c.app = app  # type: ignore[attr-defined]
            yield c


async def _send(c, cid: str, content: str):
    r = await asyncio.wait_for(c.post(f"/api/conversations/{cid}/messages", json={"content": content}), 10)
    assert r.status_code == 200
    return parse_sse(r.text)


async def test_streams_reply_and_records_usage(claude_client, fake):
    c = claude_client
    fake.queue_stream(stream_body(["Good evening", ", Tony."]))
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    events = await _send(c, cid, "Hello JARVIS")

    assert "".join(d["text"] for e, d in events if e == "delta") == "Good evening, Tony."
    done = events[-1][1]
    assert done["role"] == "assistant" and done["status"] == "complete" and done["model"] == "claude-opus-5-5"
    assert done["content"] == "Good evening, Tony." and done["error"] is None

    body = fake.body()
    assert body["model"] == "claude-opus-5-5"
    assert body["messages"] == [{"role": "user", "content": "Hello JARVIS"}]
    assert "You are JARVIS" in body["system"] and "Tony" in body["system"]
    assert body["cache_control"] == {"type": "ephemeral"}
    assert body["fallbacks"] == "default"
    assert "output_config" not in body and "thinking" not in body
    assert body["stream"] is True
    headers = fake.requests[-1].headers
    assert headers["anthropic-beta"] == "server-side-fallback-2026-07-01"
    assert "sk-ant-test-key-1234567890" in headers["authorization"]

    usage = (await c.get("/api/usage")).json()
    assert usage["totals"]["requests"] == 1
    assert usage["by_model"][0] == {
        "model": "claude-opus-5-5", "requests": 1, "input_tokens": 120, "output_tokens": 30,
        "cache_read_tokens": 80, "cache_write_tokens": 40,
        # (120*4 + 40*4*1.25 + 80*4*0.1 + 30*20) / 1e6
        "estimated_cost_usd": pytest.approx(0.001312),
    }
    msgs = (await c.get(f"/api/conversations/{cid}")).json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]


async def test_history_and_preferences_are_sent(claude_client, fake):
    c = claude_client
    await c.patch("/api/settings", json={"assistant_name": "FRIDAY", "model": "claude-sonnet-5-5", "effort": "low", "max_output_tokens": 2000})
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    fake.queue_stream(stream_body(["First answer"], model="claude-sonnet-5-5"))
    await _send(c, cid, "Question one")
    fake.queue_stream(stream_body(["Second answer"], model="claude-sonnet-5-5"))
    await _send(c, cid, "Question two")

    body = fake.body()
    assert body["model"] == "claude-sonnet-5-5" and body["max_tokens"] == 2000
    assert body["output_config"] == {"effort": "low"}
    assert "You are FRIDAY" in body["system"]
    assert body["messages"] == [
        {"role": "user", "content": "Question one"},
        {"role": "assistant", "content": "First answer"},
        {"role": "user", "content": "Question two"},
    ]


async def test_models_without_fallback_support_omit_it(claude_client, fake):
    c = claude_client
    await c.patch("/api/settings", json={"model": "claude-haiku-4-5"})
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    fake.queue_stream(stream_body(["ok"], model="claude-haiku-4-5"))
    await _send(c, cid, "hi")
    assert "fallbacks" not in fake.body()
    assert "anthropic-beta" not in fake.requests[-1].headers


async def test_refusal_discards_partial_output(claude_client, fake):
    c = claude_client
    fake.queue_stream(stream_body(["Here is how"], stop_reason="refusal", stop_details={"type": "refusal", "category": "cyber", "explanation": None}))
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    done = (await _send(c, cid, "something declined"))[-1][1]
    assert done["status"] == "error" and done["content"] == ""
    assert done["error"] == "Claude declined to respond to this request (category: cyber)."
    # A refused reply is not replayed as history on the next turn.
    fake.queue_stream(stream_body(["fine"]))
    await _send(c, cid, "something else")
    assert [m["role"] for m in fake.body()["messages"]] == ["user", "user"]


async def test_mid_stream_fallback_resets_text(claude_client, fake):
    c = claude_client
    fake.queue_stream(stream_body(["partial from first model", "Answer from fallback."], model="claude-opus-4-8", fallback_after=1))
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    events = await _send(c, cid, "hi")
    names = [e for e, _ in events]
    assert "reset" in names
    done = events[-1][1]
    assert done["content"] == "Answer from fallback." and done["model"] == "claude-opus-4-8"


async def test_max_tokens_is_flagged(claude_client, fake):
    c = claude_client
    fake.queue_stream(stream_body(["A long answer that"], stop_reason="max_tokens"))
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    done = (await _send(c, cid, "write a lot"))[-1][1]
    assert done["status"] == "complete" and done["content"] == "A long answer that"
    assert "maximum output length" in done["error"]


@pytest.mark.parametrize(
    ("status", "etype", "expected"),
    [
        (401, "authentication_error", "Anthropic rejected the API key"),
        (404, "not_found_error", "model wasn't found"),
        (429, "rate_limit_error", "rate limit"),
        (529, "overloaded_error", "temporarily unavailable or overloaded"),
        (400, "invalid_request_error", "Claude rejected the request: max_tokens too large"),
    ],
)
async def test_api_errors_become_friendly_messages(claude_client, fake, status, etype, expected):
    c = claude_client
    fake.queue_error(status, etype, "max_tokens too large" if status == 400 else "nope")
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    events = await _send(c, cid, "hi")
    done = events[-1][1]
    assert done["status"] == "error" and expected in done["error"]
    assert "sk-ant-test" not in json.dumps(events)
    assert (await c.get("/api/usage")).json()["totals"]["requests"] == 0


async def test_cancel_closes_upstream_stream(claude_client, fake):
    """Cancelling must close the HTTP stream to Anthropic so generation (and billing) stops."""
    c = claude_client
    closed = asyncio.Event()
    started = asyncio.Event()
    head = stream_body(["x"])[:3]  # message_start, content_block_start, first delta

    class SlowBody(httpx2.AsyncByteStream):
        async def __aiter__(self):
            for chunk in head:
                yield chunk.encode()
            started.set()
            try:
                for _ in range(500):
                    await asyncio.sleep(0.01)
                    yield frame("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "."}}).encode()
            finally:
                closed.set()

        async def aclose(self):
            closed.set()

    fake.queue_stream(SlowBody())
    cid = (await c.post("/api/conversations", json={})).json()["id"]

    async def cancel_soon():
        await started.wait()
        await asyncio.sleep(0.05)
        assert (await c.post(f"/api/conversations/{cid}/cancel")).json() == {"cancelled": True}

    canceller = asyncio.create_task(asyncio.wait_for(cancel_soon(), 10))
    events = await _send(c, cid, "go")
    await canceller
    done = events[-1][1]
    assert done["status"] == "cancelled" and done["content"].startswith("x")
    await asyncio.wait_for(closed.wait(), 5)
    # Tokens billed before the cancel are still recorded (input exact, output estimated).
    row = (await c.get("/api/usage")).json()["by_model"][0]
    assert row["requests"] == 1 and row["input_tokens"] == 120 and row["output_tokens"] >= 1


def test_build_provider_selects_by_key(tmp_path):
    base = {"data_dir": tmp_path, "frontend_dist": None, "_env_file": None}
    assert isinstance(build_provider(Settings(**base)), UnconfiguredProvider)
    assert isinstance(build_provider(Settings(**base, ANTHROPIC_API_KEY="  ")), UnconfiguredProvider)
    assert isinstance(build_provider(Settings(**base, ANTHROPIC_API_KEY="sk-ant-x")), ClaudeProvider)
    assert isinstance(build_provider(Settings(**base, ANTHROPIC_API_KEY="sk-ant-x", refusal_fallback=False)), ClaudeProvider)


async def test_settings_never_expose_api_key(tmp_path):
    settings = Settings(data_dir=tmp_path / "d", frontend_dist=None, _env_file=None, ANTHROPIC_API_KEY="sk-ant-secret-value-123")
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            token = (await c.post("/api/auth/setup", json={"username": "tony", "password": PASSWORD})).json()["token"]
            r = await c.get("/api/settings", headers={"Authorization": f"Bearer {token}"})
            assert r.json()["server"]["ai_configured"] is True
            assert r.json()["server"]["default_model"] == "claude-opus-5-5"
            assert "sk-ant-secret" not in r.text


def test_trim_history():
    turns = [
        ChatTurn("user", "a" * 400), ChatTurn("assistant", "b" * 400),
        ChatTurn("user", "c" * 400), ChatTurn("assistant", "d" * 400), ChatTurn("user", "e" * 40),
    ]
    # Budget of 250 tokens ~ 1000 chars: keeps the newest turns, and must start with a user turn.
    kept = trim_history(turns, 250)
    assert [t.content[0] for t in kept] == ["c", "d", "e"]
    assert trim_history(turns, 1_000_000) == turns
    # The latest user turn is always kept even if it exceeds the budget.
    assert trim_history([ChatTurn("user", "z" * 10_000)], 10) == [ChatTurn("user", "z" * 10_000)]
