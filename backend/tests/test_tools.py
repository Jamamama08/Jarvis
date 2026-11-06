"""Phase 5: tool registry, permissions, built-in tools and the agent loop."""

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from pydantic import BaseModel

from app.core.config import Settings
from app.models import PermissionDecision, PermissionLevel
from app.services.providers import UnconfiguredProvider
from app.tools import permissions
from app.tools.base import Tool, ToolContext, ToolError
from app.tools.builtin.basic import safe_eval
from app.tools.builtin.files import resolve_path
from app.tools.builtin.python_exec import run_python_code
from app.tools.redact import redact_value
from app.tools.registry import ToolRegistry, default_registry

from .test_claude import _send, claude_client, fake, frame, stream_body  # noqa: F401  (fixtures)

# --- Unit: calculator ------------------------------------------------------------------


def test_calculator():
    assert safe_eval("(1250 * 0.15) + sqrt(81)") == 196.5
    assert safe_eval("2^10") == 1024
    assert safe_eval("round(pi, 3)") == 3.142
    assert safe_eval("factorial(5) // 7 % 4") == 1
    for bad, msg in [("__import__('os')", "Unsupported"), ("(1).real", "Unsupported"), ("9**9**9", "too large"),
                     ("1/0", "Division by zero"), ("factorial(5000)", "too large"), ("2 +", "Not a valid"),
                     ("True + 1", "Unsupported"), ("x" * 600, "too long")]:
        with pytest.raises(ToolError, match=msg):
            safe_eval(bad)


# --- Unit: workspace confinement -----------------------------------------------------------


def test_paths_are_confined_to_workspace(tmp_path):
    root = (tmp_path / "ws").resolve()
    root.mkdir()
    (tmp_path / "secret.txt").write_text("nope")
    (root / "ok.txt").write_text("fine")
    os.symlink(tmp_path / "secret.txt", root / "link.txt")
    assert resolve_path(root, "ok.txt") == root / "ok.txt"
    assert resolve_path(root, str(root / "ok.txt")) == root / "ok.txt"
    for bad in ("../secret.txt", str(tmp_path / "secret.txt"), "link.txt", "sub/../../secret.txt", ""):
        with pytest.raises(ToolError):
            resolve_path(root, bad)


# --- Unit: Python runner ------------------------------------------------------------------


async def test_python_runner_env_timeout_and_errors(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak")
    workspace = tmp_path / "w"
    workspace.mkdir()
    (workspace / "data.txt").write_text("workspace!")
    code, out, err, timed_out = await run_python_code(
        "import os; print(os.environ.get('ANTHROPIC_API_KEY')); print(open('data.txt').read())", workspace, 10
    )
    assert code == 0 and out.splitlines() == ["None", "workspace!"] and not timed_out
    code, out, err, timed_out = await run_python_code("import time; time.sleep(30)", tmp_path, 1)
    assert timed_out and code is None
    code, out, err, _ = await run_python_code("raise SystemExit('boom')", tmp_path, 10)
    assert code == 1 and "boom" in err


# --- Unit: permissions, registry, redaction --------------------------------------------------


class _In(BaseModel):
    x: int = 0


async def _noop(ctx, args):
    return "ok"


def _tool(name, level):
    return Tool(name, "d", _In, level, _noop)


def test_permission_resolution():
    auto, restricted, sensitive = (_tool("a", PermissionLevel.automatic), _tool("r", PermissionLevel.restricted),
                                   _tool("s", PermissionLevel.sensitive))
    assert [permissions.resolve(t, {}) for t in (auto, restricted, sensitive)] == ["allow", "ask", "ask"]
    policies = {"level:restricted": PermissionDecision.allow, "tool:a": PermissionDecision.deny,
                "level:sensitive": PermissionDecision.allow}
    assert permissions.resolve(auto, policies) == "deny"  # tool rule beats default
    assert permissions.resolve(restricted, policies) == "allow"  # level rule
    assert permissions.resolve(sensitive, policies) == "ask"  # sensitive can never be auto-allowed


def test_registry():
    reg = default_registry()
    names = [t["name"] for t in reg.definitions(Settings(_env_file=None))]
    assert names == sorted(names) and len(names) == len(set(names))
    assert all(t["eager_input_streaming"] is True and t["input_schema"]["type"] == "object" for t in reg.definitions(Settings(_env_file=None)))
    levels = {t.name: t.level for t in reg.all()}
    assert levels["write_file"] == "restricted" and levels["run_python"] == "restricted"
    assert levels["delete_file"] == "sensitive" and levels["read_file"] == "automatic"
    assert "run_python" not in [t["name"] for t in reg.definitions(Settings(_env_file=None, python_tool_enabled=False))]
    with pytest.raises(ValueError):
        ToolRegistry([_tool("a", PermissionLevel.automatic), _tool("a", PermissionLevel.automatic)])
    with pytest.raises(ValueError):
        ToolRegistry([_tool("bad name!", PermissionLevel.automatic)])


def test_redaction():
    out = redact_value({"path": "x", "password": "hunter2", "nested": {"api_key": "k", "note": "Bearer abcdefghijklmnop"}})
    assert out == {"path": "x", "password": "***", "nested": {"api_key": "***", "note": "Bearer ***"}}


# --- Agent loop -----------------------------------------------------------------------------


def tool_stream(calls: list[tuple[str, str, dict]], *, text: str = "", model: str = "claude-opus-5-5",
                stop_reason: str = "tool_use", usage: dict | None = None, thinking: bool = True) -> list[str]:
    """SSE frames for a response containing (thinking), optional text, then tool_use blocks."""
    usage = usage or {"input_tokens": 300, "output_tokens": 40, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
    frames = [frame("message_start", {"type": "message_start", "message": {
        "id": "msg_t", "type": "message", "role": "assistant", "model": model, "content": [],
        "stop_reason": None, "stop_sequence": None, "usage": {**usage, "output_tokens": 1}}})]
    i = 0
    if thinking:
        frames += [
            frame("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            frame("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "signature_delta", "signature": "sig-abc"}}),
            frame("content_block_stop", {"type": "content_block_stop", "index": i}),
        ]
        i += 1
    if text:
        frames += [
            frame("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}),
            frame("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": text}}),
            frame("content_block_stop", {"type": "content_block_stop", "index": i}),
        ]
        i += 1
    for tid, name, inp in calls:
        frames += [
            frame("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": tid, "name": name, "input": {}}}),
            frame("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(inp)}}),
            frame("content_block_stop", {"type": "content_block_stop", "index": i}),
        ]
        i += 1
    frames.append(frame("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": usage["output_tokens"]}}))
    frames.append(frame("message_stop", {"type": "message_stop"}))
    return frames


async def _conversation(c) -> str:
    return (await c.post("/api/conversations", json={})).json()["id"]


def _events(events, name):
    return [d for e, d in events if e == name]


async def test_automatic_tool_runs_and_exchange_is_replayed(claude_client, fake):
    c = claude_client
    cid = await _conversation(c)
    fake.queue_stream(tool_stream([("toolu_1", "calculator", {"expression": "1250 * 0.15"})], text="Let me calculate."))
    fake.queue_stream(stream_body(["15% of 1250 is 187.5."]))
    events = await _send(c, cid, "What is 15% of 1250?")

    first, second = fake.body(0), fake.body(1)
    assert [t.get("name") for t in first["tools"]] == sorted(t.get("name") for t in first["tools"])
    assert "calculator" in [t["name"] for t in first["tools"]]
    # Second request carries the assistant's blocks (thinking with signature, text, tool_use) and the result.
    assert second["messages"][-2]["role"] == "assistant"
    blocks = second["messages"][-2]["content"]
    assert [b["type"] for b in blocks] == ["thinking", "text", "tool_use"]
    assert blocks[0]["signature"] == "sig-abc" and blocks[2]["input"] == {"expression": "1250 * 0.15"}
    assert second["messages"][-1] == {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "1250 * 0.15 = 187.5", "is_error": False}]}

    assert _events(events, "tool_start")[0]["name"] == "calculator"
    result = _events(events, "tool_result")[0]
    assert result["status"] == "succeeded" and result["summary"] == "1250 * 0.15" and "187.5" in result["output"]
    done = events[-1][1]
    assert done["content"] == "Let me calculate.\n\n15% of 1250 is 187.5." and done["status"] == "complete"
    assert [t["tool_name"] for t in done["tools"]] == ["calculator"]

    # Reloading shows the tool on the message; the next turn replays the exchange byte-identically.
    msgs = (await c.get(f"/api/conversations/{cid}")).json()["messages"]
    assert msgs[1]["tools"][0]["status"] == "succeeded"
    fake.queue_stream(stream_body(["You're welcome."]))
    await _send(c, cid, "Thanks")
    replay = fake.body()["messages"]
    # [user, assistant(thinking/text/tool_use), user(tool_result), assistant(final), user("Thanks")]
    assert replay[:3] == second["messages"]
    assert [b["type"] for b in replay[3]["content"]] == ["text"] and replay[3]["content"][0]["text"] == "15% of 1250 is 187.5."
    assert replay[4] == {"role": "user", "content": "Thanks"} and len(replay) == 5
    # Two requests for the first turn, one for the second; all recorded.
    assert (await c.get("/api/usage")).json()["totals"]["requests"] == 3


async def _wait_pending(c, timeout=5.0) -> dict:
    for _ in range(int(timeout / 0.02)):
        pending = (await c.get("/api/tools/executions", params={"status": "pending_approval"})).json()
        if pending:
            return pending[0]
        await asyncio.sleep(0.02)
    raise AssertionError("no pending approval")


async def test_restricted_tool_waits_for_approval(claude_client, fake):
    c = claude_client
    workspace = Path(c.app.state.settings.resolved_workspace_dir)
    cid = await _conversation(c)
    fake.queue_stream(tool_stream([("toolu_w", "write_file", {"path": "notes/plan.md", "content": "# Plan\n", "mode": "create"})]))
    fake.queue_stream(stream_body(["Saved."]))

    async def approve():
        pending = await _wait_pending(c)
        assert pending["tool_name"] == "write_file" and pending["permission_level"] == "restricted"
        assert pending["summary"] == "create notes/plan.md (7 chars)"
        assert not (workspace / "notes/plan.md").exists()  # nothing runs before approval
        r = await c.post(f"/api/tools/executions/{pending['id']}/decision", json={"approve": True, "remember": True})
        assert r.status_code == 204

    approver = asyncio.create_task(approve())
    events = await _send(c, cid, "Save a plan")
    await approver
    assert (workspace / "notes/plan.md").read_text() == "# Plan\n"
    statuses = [d["status"] for e, d in events if e in ("tool_call", "tool_result")]
    assert statuses == ["pending_approval", "running", "succeeded"]
    # "remember" stored an allow rule, so the next write runs without asking.
    overview = (await c.get("/api/tools")).json()
    write = next(t for t in overview["tools"] if t["name"] == "write_file")
    assert write["decision"] == "allow" and write["rule"] == "tool"
    fake.queue_stream(tool_stream([("toolu_w2", "write_file", {"path": "notes/plan.md", "content": "more\n", "mode": "append"})]))
    fake.queue_stream(stream_body(["Appended."]))
    events = await _send(c, cid, "Add more")
    assert [d["status"] for e, d in events if e in ("tool_call", "tool_result")] == ["running", "succeeded"]
    assert (workspace / "notes/plan.md").read_text() == "# Plan\nmore\n"


async def test_declined_and_blocked_tools_do_not_run(claude_client, fake):
    c = claude_client
    workspace = Path(c.app.state.settings.resolved_workspace_dir)
    (workspace / "keep.txt").write_text("important")
    cid = await _conversation(c)
    fake.queue_stream(tool_stream([("toolu_d", "delete_file", {"path": "keep.txt"})]))
    fake.queue_stream(stream_body(["Okay, I won't."]))

    async def decline():
        pending = await _wait_pending(c)
        assert pending["permission_level"] == "sensitive"
        await c.post(f"/api/tools/executions/{pending['id']}/decision", json={"approve": False})

    t = asyncio.create_task(decline())
    events = await _send(c, cid, "Delete keep.txt")
    await t
    assert (workspace / "keep.txt").exists()
    assert _events(events, "tool_result")[0]["status"] == "denied"
    tool_result = fake.body()["messages"][-1]["content"][0]
    assert tool_result["is_error"] is True and "did not approve" in tool_result["content"]

    # Sensitive tools can't be set to allow; a deny rule blocks without asking.
    r = await c.put("/api/tools/policies", json={"scope": "tool:delete_file", "decision": "allow"})
    assert r.status_code == 422
    assert (await c.put("/api/tools/policies", json={"scope": "tool:delete_file", "decision": "deny"})).status_code == 204
    fake.queue_stream(tool_stream([("toolu_d2", "delete_file", {"path": "keep.txt"})]))
    fake.queue_stream(stream_body(["Blocked."]))
    events = await _send(c, cid, "Delete it anyway")
    assert _events(events, "tool_result")[0]["status"] == "denied" and not _events(events, "tool_call")
    assert (workspace / "keep.txt").exists()
    # A level rule: restricted -> allow (sensitive stays ask), and rules can be removed.
    assert (await c.put("/api/tools/policies", json={"scope": "level:restricted", "decision": "allow"})).status_code == 204
    assert (await c.put("/api/tools/policies", json={"scope": "level:sensitive", "decision": "allow"})).status_code == 422
    assert (await c.put("/api/tools/policies", json={"scope": "tool:delete_file", "decision": None})).status_code == 204
    tools = {t["name"]: t for t in (await c.get("/api/tools")).json()["tools"]}
    assert tools["run_python"]["decision"] == "allow" and tools["run_python"]["rule"] == "level"
    assert tools["delete_file"]["decision"] == "ask" and tools["delete_file"]["rule"] == "default"
    assert (await c.put("/api/tools/policies", json={"scope": "tool:nope", "decision": "deny"})).status_code == 404


async def test_approval_timeout_and_cancel_while_waiting(claude_client, fake):
    c = claude_client
    c.app.state.settings.approval_timeout_seconds = 0.2
    cid = await _conversation(c)
    fake.queue_stream(tool_stream([("toolu_p", "run_python", {"code": "print(1)"})]))
    fake.queue_stream(stream_body(["No answer, so I didn't run it."]))
    events = await _send(c, cid, "Run code")
    assert _events(events, "tool_result")[0]["error"] == "Approval timed out."

    c.app.state.settings.approval_timeout_seconds = 30
    fake.queue_stream(tool_stream([("toolu_p2", "run_python", {"code": "print(2)"})]))

    async def cancel():
        await _wait_pending(c)
        assert (await c.post(f"/api/conversations/{cid}/cancel")).json() == {"cancelled": True}

    t = asyncio.create_task(cancel())
    events = await _send(c, cid, "Run code again")
    await t
    done = events[-1][1]
    assert done["status"] == "cancelled" and _events(events, "tool_result")[0]["status"] == "cancelled"
    # The stored exchange stays valid: the next turn replays tool_use followed by its tool_result.
    fake.queue_stream(stream_body(["ok"]))
    await _send(c, cid, "never mind")
    msgs = fake.body()["messages"]
    tool_use_ids = [b["id"] for m in msgs if m["role"] == "assistant" and isinstance(m["content"], list) for b in m["content"] if b["type"] == "tool_use"]
    result_ids = [b["tool_use_id"] for m in msgs if m["role"] == "user" and isinstance(m["content"], list) for b in m["content"] if b.get("type") == "tool_result"]
    assert set(tool_use_ids) == set(result_ids) == {"toolu_p", "toolu_p2"}


async def test_invalid_input_and_unknown_tool(claude_client, fake):
    c = claude_client
    cid = await _conversation(c)
    fake.queue_stream(tool_stream([("toolu_a", "calculator", {"expr": 1}), ("toolu_b", "launch_missiles", {})]))
    fake.queue_stream(stream_body(["Sorry."]))
    events = await _send(c, cid, "go")
    results = fake.body()["messages"][-1]["content"]
    assert results[0]["is_error"] and "Invalid input for calculator: expression: Field required" in results[0]["content"]
    assert results[1]["is_error"] and results[1]["content"] == "Unknown tool: launch_missiles"
    assert [d["status"] for d in _events(events, "tool_result")] == ["failed", "failed"]


async def test_loop_limits(claude_client, fake):
    c = claude_client
    c.app.state.settings.max_tool_iterations = 3
    cid = await _conversation(c)
    for i in range(3):
        fake.queue_stream(tool_stream([(f"toolu_{i}", "current_datetime", {})]))
    events = await _send(c, cid, "loop forever")
    done = events[-1][1]
    assert len(fake.requests) == 3 and done["status"] == "complete"
    assert "Stopped after 3 steps" in done["error"]

    c.app.state.settings.max_tool_iterations = 10
    c.app.state.settings.turn_token_budget = 10_000
    fake.queue_stream(tool_stream([("toolu_big", "current_datetime", {})], usage={"input_tokens": 9_000, "output_tokens": 2_000, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}))
    events = await _send(c, cid, "expensive")
    assert "token budget" in events[-1][1]["error"] and len(fake.requests) == 4


async def test_tools_can_be_disabled_and_web_search_is_opt_in(claude_client, fake):
    c = claude_client
    cid = await _conversation(c)
    await c.patch("/api/settings", json={"tools_enabled": False})
    fake.queue_stream(stream_body(["hi"]))
    await _send(c, cid, "hi")
    assert "tools" not in fake.body()
    assert "Tools are turned off" in fake.body()["system"]

    await c.patch("/api/settings", json={"tools_enabled": True, "web_search_enabled": True})
    fake.queue_stream([*stream_body([])[:1],
        frame("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {}}}),
        frame("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"query\": \"jarvis news\"}"}}),
        frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
        frame("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [
            {"type": "web_search_result", "title": "JARVIS online", "url": "https://example.com/j", "encrypted_content": "xyz", "page_age": None}]}}),
        frame("content_block_stop", {"type": "content_block_stop", "index": 1}),
        frame("content_block_start", {"type": "content_block_start", "index": 2, "content_block": {"type": "text", "text": ""}}),
        frame("content_block_delta", {"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": "Found it."}}),
        frame("content_block_stop", {"type": "content_block_stop", "index": 2}),
        frame("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                                "usage": {"output_tokens": 10, "server_tool_use": {"web_search_requests": 1}}}),
        frame("message_stop", {"type": "message_stop"}),
    ])
    events = await _send(c, cid, "news?")
    names = [t.get("name") for t in fake.body()["tools"]]
    assert "web_search" in names and "web_fetch" in names
    assert next(t for t in fake.body()["tools"] if t["name"] == "web_search")["type"] == "web_search_20260209"
    logged = _events(events, "tool_result")[0]
    assert logged["tool_name"] == "web_search" and logged["summary"] == "jarvis news" and "example.com/j" in logged["output"]
    usage = (await c.get("/api/usage")).json()["by_model"][0]
    assert usage["estimated_cost_usd"] > 0.01  # includes $0.01 for the search
    # The server tool exchange is replayed next turn.
    fake.queue_stream(stream_body(["ok"]))
    await _send(c, cid, "thanks")
    replayed = fake.body()["messages"][-2]["content"]
    assert [b["type"] for b in replayed] == ["server_tool_use", "web_search_tool_result", "text"]


async def test_memory_and_task_tools(claude_client, fake):
    c = claude_client
    await c.post("/api/memories", json={"content": "Prefers oat milk in coffee.", "category": "preference"})
    cid = await _conversation(c)
    fake.queue_stream(tool_stream([
        ("t1", "search_memories", {"query": "coffee milk"}),
        ("t2", "suggest_memory", {"content": "Is learning Japanese.", "category": "project", "importance": 3}),
        ("t3", "suggest_memory", {"content": "Bank password is hunter22", "category": "personal"}),
        ("t4", "create_task", {"title": "Book flights to Tokyo"}),
        ("t5", "list_tasks", {}),
    ]))
    fake.queue_stream(stream_body(["Done."]))
    await _send(c, cid, "Remember I'm learning Japanese and add a task")
    results = [r["content"] for r in fake.body()["messages"][-1]["content"]]
    assert "oat milk" in results[0]
    assert "NOT remembered yet" in results[1]
    assert "looks like a secret" in results[2]
    assert results[3].startswith("Created task") and "Book flights to Tokyo" in results[4]
    pending = (await c.get("/api/memories", params={"state": "pending"})).json()["items"]
    assert [m["content"] for m in pending] == ["Is learning Japanese."] and pending[0]["approved"] is False
    tasks = (await c.get("/api/tasks")).json()
    assert tasks[0]["title"] == "Book flights to Tokyo" and tasks[0]["conversation_id"] == cid
    r = await c.patch(f"/api/tasks/{tasks[0]['id']}", json={"status": "completed"})
    assert r.json()["status"] == "completed" and r.json()["finished_at"]
    assert (await c.get("/api/tasks", params={"state": "open"})).json() == []


async def test_file_tools_and_summarizer(claude_client, fake):
    import httpx2

    c = claude_client
    workspace = Path(c.app.state.settings.resolved_workspace_dir)
    (workspace / "docs").mkdir()
    (workspace / "docs" / "report.md").write_text("# Q3 report\n\nRevenue grew 12%.\nCosts fell.\n")
    (workspace / ".hidden").write_text("revenue secret")
    cid = await _conversation(c)
    fake.queue_stream(tool_stream([
        ("f1", "search_files", {"query": "revenue"}),
        ("f2", "read_file", {"path": "docs/report.md", "start_line": 3, "max_lines": 1}),
        ("f3", "read_file", {"path": "../../etc/passwd"}),
        ("f4", "summarize_document", {"path": "docs/report.md"}),
    ]))
    fake.responses.append(httpx2.Response(200, json={
        "id": "m", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
        "content": [{"type": "text", "text": "Revenue up 12%, costs down."}], "stop_reason": "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": 50, "output_tokens": 8, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}))
    fake.queue_stream(stream_body(["Here's the summary."]))
    events = await _send(c, cid, "Summarize my report")
    results = fake.body()["messages"][-1]["content"]
    assert results[0]["content"] == "docs/report.md:3: Revenue grew 12%."  # hidden file skipped
    assert results[1]["content"] == "docs/report.md (lines 3-3 of 4)\nRevenue grew 12%.\n[1 more lines; call again with start_line=4]"
    assert results[2]["is_error"] and "outside the workspace" in results[2]["content"]
    assert results[3]["content"] == "Revenue up 12%, costs down."
    assert "<document name=\"docs/report.md\">" in fake.body(1)["messages"][0]["content"]
    # The summarizer's own Claude request is recorded too (3 requests total).
    assert (await c.get("/api/usage")).json()["totals"]["requests"] == 3
    assert [d["status"] for d in _events(events, "tool_result")] == ["succeeded", "succeeded", "failed", "succeeded"]


async def test_tool_logs_are_redacted_and_private(claude_client, fake):
    c = claude_client
    cid = await _conversation(c)
    await c.put("/api/tools/policies", json={"scope": "tool:write_file", "decision": "allow"})
    fake.queue_stream(tool_stream([("w1", "write_file", {"path": "creds.txt", "content": "api_key=sk-ant-abcdefghijklmnop", "mode": "create"})]))
    fake.queue_stream(stream_body(["Saved."]))
    await _send(c, cid, "save it")
    log = (await c.get("/api/tools/executions")).json()[0]
    assert "sk-ant-abcdefghijklmnop" not in json.dumps(log)
    # Other users can't see executions or decide on them.
    from app.core.security import hash_password
    from app.models import User

    from .conftest import PASSWORD

    async with c.app.state.db.sessionmaker() as db:
        db.add(User(username="pepper", display_name="Pepper", password_hash=hash_password(PASSWORD)))
        await db.commit()
    token = (await c.post("/api/auth/login", json={"username": "pepper", "password": PASSWORD})).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await c.get("/api/tools/executions", headers=h)).json() == []
    assert (await c.post(f"/api/tools/executions/{log['id']}/decision", json={"approve": True}, headers=h)).status_code == 409
    assert (await c.get("/api/tasks", headers=h)).json() == []


async def test_unconfigured_provider_gets_no_tools(auth_client):
    r = await auth_client.get("/api/tools")
    assert r.status_code == 200 and r.json()["web_search_enabled"] is False
    assert any(t["name"] == "calculator" for t in r.json()["tools"])
    cid = (await auth_client.post("/api/conversations", json={})).json()["id"]
    r = await auth_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"})
    assert "tool_start" not in r.text and r.status_code == 200
    assert isinstance(UnconfiguredProvider(), UnconfiguredProvider)


def test_python_executable_is_this_interpreter():
    assert Path(sys.executable).exists()


async def test_disconnect_at_any_point_still_saves_a_final_state(claude_client, fake):
    """Regression: a client disconnect (task cancellation) landing during the agent loop's own
    commits used to invalidate the session, so the reply could stay 'streaming' forever."""
    from sqlalchemy import select

    from app.models import Message
    from app.services.chat import run_turn

    c = claude_client
    app = c.app
    user_id = (await c.get("/api/auth/me")).json()["id"]
    for delay_steps in range(0, 31):
        cid = await _conversation(c)
        fake.queue_stream(tool_stream([("toolu_x", "calculator", {"expression": "2+2"})]))
        fake.queue_stream(stream_body(["Four."]))
        cancel = asyncio.Event()
        app.state.generations.start(cid)

        async def consume():
            async for _ in run_turn(
                sessionmaker=app.state.db.sessionmaker, settings=app.state.settings, provider=app.state.provider,
                registry=app.state.generations, cancel_event=cancel, user_id=user_id, conversation_id=cid,
                content="what is 2+2", tools=app.state.tools, approvals=app.state.approvals,
            ):
                pass

        # Cancel through an anyio cancel scope, as uvicorn/Starlette do on disconnect. Unlike
        # task.cancel(), this is level-triggered: every later unshielded await is cancelled too.
        import anyio

        async with anyio.create_task_group() as tg:
            tg.start_soon(consume)
            await asyncio.sleep(delay_steps * 0.002)  # sweep 0-60 ms so cancels land inside commits
            tg.cancel_scope.cancel()
        async with app.state.db.sessionmaker() as db:
            replies = list((await db.execute(select(Message).where(Message.conversation_id == cid, Message.role == "assistant"))).scalars())
        assert all(r.status != "streaming" for r in replies), (delay_steps, [r.status for r in replies])
        if delay_steps > 0:  # step 0 cancels before run_turn starts; the registry's stale timeout covers that
            assert not app.state.generations.is_active(cid)
        fake.responses.clear()
