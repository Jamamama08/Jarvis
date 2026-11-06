"""Phase 7: autonomous tasks (plan, parallel/sequential steps, approvals, retries, verify, cancel, limits)."""

import asyncio
import json
import re
from pathlib import Path

import anthropic
import httpx2
import pytest
from httpx import ASGITransport, AsyncClient

from app.core.config import Settings
from app.main import create_app
from app.services.providers import ClaudeProvider
from app.services.tasks import parse_step_result

from .conftest import PASSWORD
from .test_claude import stream_body
from .test_tools import tool_stream

STEP_RE = re.compile(r"Your step \((\d+) of (\d+)\): (.+)")


class RoutedAnthropic:
    """Answers planner, verifier and step requests by content (parallel steps arrive in any order)."""

    def __init__(self):
        self.plan: dict = {"summary": "", "steps": []}
        self.verdict: dict = {"success": True, "summary": "All done.", "issues": []}
        self.steps: dict[str, list] = {}  # step title -> queued responses (frames list, ("error", status), or ("delay", s, frames))
        self.requests: list[dict] = []

    def client(self) -> anthropic.AsyncAnthropic:
        return anthropic.AsyncAnthropic(api_key="sk-ant-test", max_retries=0,
                                        http_client=anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(self.handler)))

    def step_requests(self, title: str) -> list[dict]:
        return [r for r in self.requests if "Your step" in json.dumps(r) and title in self._prompt(r)]

    @staticmethod
    def _prompt(body: dict) -> str:
        content = body["messages"][0]["content"]
        return content if isinstance(content, str) else json.dumps(content)

    @staticmethod
    def _json_msg(data: dict) -> httpx2.Response:
        return httpx2.Response(200, json={
            "id": "m", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": [{"type": "text", "text": json.dumps(data)}], "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 200, "output_tokens": 50, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}})

    async def handler(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        system = body.get("system", "")
        if "plan autonomous tasks" in system:
            return self._json_msg(self.plan)
        if "check whether an autonomous task" in system:
            return self._json_msg(self.verdict)
        match = STEP_RE.search(self._prompt(body))
        title = match.group(3).split("\\n")[0].strip() if match else ""
        queue = self.steps.get(title) or [stream_body([f"Result for {title}. STEP_RESULT: success"])]
        item = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(item, tuple) and item[0] == "error":
            return httpx2.Response(item[1], json={"type": "error", "error": {"type": "overloaded_error", "message": "busy"}})
        if isinstance(item, tuple) and item[0] == "delay":
            await asyncio.sleep(item[1])
            item = item[2]
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content="".join(item).encode())


def plan_step(title, *, deps=(), parallel=False, instructions=None):
    return {"title": title, "instructions": instructions or f"Do {title}.", "depends_on": list(deps), "parallel_safe": parallel}


@pytest.fixture
def routed():
    return RoutedAnthropic()


@pytest.fixture
async def tc(tmp_path, routed):
    settings = Settings(data_dir=tmp_path / "data", frontend_dist=None, _env_file=None, task_retry_base_seconds=0)
    app = create_app(settings)
    app.state.provider = ClaudeProvider(settings, client=routed.client())
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", timeout=60) as c:
            r = await c.post("/api/auth/setup", json={"username": "tony", "password": PASSWORD})
            c.headers["Authorization"] = f"Bearer {r.json()['token']}"
            c.app = app  # type: ignore[attr-defined]
            yield c


async def wait_done(c, task_id: str, timeout: float = 20) -> dict:
    for _ in range(int(timeout / 0.05)):
        d = (await c.get(f"/api/agent-tasks/{task_id}")).json()
        if not d["running"] and d["status"] not in ("pending", "running", "waiting_approval"):
            return d
        await asyncio.sleep(0.05)
    raise AssertionError(f"task still {d['status']}")


async def wait_status(c, task_id: str, status: str, timeout: float = 20) -> dict:
    for _ in range(int(timeout / 0.05)):
        d = (await c.get(f"/api/agent-tasks/{task_id}")).json()
        if d["status"] == status:
            return d
        await asyncio.sleep(0.05)
    raise AssertionError(f"never reached {status}: {d['status']}")


def test_parse_step_result():
    assert parse_step_result("Found 3 options.\nSTEP_RESULT: success", None) == (True, "Found 3 options.", "")
    assert parse_step_result("Tried.\nSTEP_RESULT: failure: site was down", None) == (False, "Tried.", "site was down")
    assert parse_step_result("Answer without marker", None) == (True, "Answer without marker", "")
    assert parse_step_result("partial", "Stopped after 10 steps") == (False, "partial", "Stopped after 10 steps")
    assert parse_step_result("", None)[0] is False


async def test_plan_parallel_research_then_approved_write(tc, routed):
    c = tc
    workspace = Path(c.app.state.settings.resolved_workspace_dir)
    routed.plan = {"summary": "Research two suits, then write a comparison.", "steps": [
        plan_step("Research Mark 42", parallel=True),
        plan_step("Research Mark 50", parallel=True),
        plan_step("Write comparison", deps=[1, 2]),
    ]}
    routed.steps["Research Mark 42"] = [("delay", 0.4, stream_body(["Mark 42: modular. STEP_RESULT: success"]))]
    routed.steps["Research Mark 50"] = [("delay", 0.4, stream_body(["Mark 50: nanotech. STEP_RESULT: success"]))]
    routed.steps["Write comparison"] = [
        tool_stream([("w1", "write_file", {"path": "suits.md", "content": "# Suits\n", "mode": "create"})]),
        stream_body(["Wrote suits.md. STEP_RESULT: success"]),
    ]
    routed.verdict = {"success": True, "summary": "**Done.** Compared both suits in `suits.md`.", "issues": []}

    r = await c.post("/api/agent-tasks", json={"goal": "Compare the Mark 42 and Mark 50 and save a report"})
    assert r.status_code == 201
    tid = r.json()["id"]
    waiting = await wait_status(c, tid, "waiting_approval")
    assert waiting["steps_done"] == 2 and waiting["steps_total"] == 3
    pending = next(t for t in (await c.get(f"/api/agent-tasks/{tid}")).json()["tools"] if t["status"] == "pending_approval")
    assert pending["tool_name"] == "write_file"
    assert (await c.post(f"/api/tools/executions/{pending['id']}/decision", json={"approve": True})).status_code == 204
    d = await wait_done(c, tid)

    assert d["status"] == "completed" and d["result"].startswith("**Done.**") and d["plan_summary"].startswith("Research two")
    assert (workspace / "suits.md").read_text() == "# Suits\n"
    steps = {s["title"]: s for s in d["steps"]}
    a, b = steps["Research Mark 42"], steps["Research Mark 50"]
    assert a["parallel_safe"] and b["parallel_safe"] and steps["Write comparison"]["depends_on"] == [1, 2]
    # The two research steps overlapped in time (ran in parallel)...
    assert a["started_at"] < b["finished_at"] and b["started_at"] < a["finished_at"]
    # ...and the write step started only after both finished, with their results in its prompt.
    assert steps["Write comparison"]["started_at"] >= max(a["finished_at"], b["finished_at"])
    write_prompt = routed._prompt(routed.step_requests("Write comparison")[0])
    assert "Mark 42: modular." in write_prompt and "Mark 50: nanotech." in write_prompt
    # Parallel steps only get read-only tools; no step can start nested tasks.
    research_tools = {t.get("name") for t in routed.step_requests("Research Mark 42")[0]["tools"]}
    assert "write_file" not in research_tools and "read_file" in research_tools and "start_task" not in research_tools
    write_tools = {t.get("name") for t in routed.step_requests("Write comparison")[0]["tools"]}
    assert "write_file" in write_tools and "start_task" not in write_tools and "check_task" not in write_tools
    assert d["tokens"] > 0 and d["estimated_cost_usd"] > 0
    assert [t["tool_name"] for t in d["tools"]] == ["write_file"]


async def test_parallel_step_cannot_use_restricted_tools(tc, routed):
    c = tc
    routed.plan = {"summary": "", "steps": [plan_step("Sneaky", parallel=True)]}
    routed.steps["Sneaky"] = [
        tool_stream([("w1", "write_file", {"path": "x.txt", "content": "x"})]),
        stream_body(["Couldn't write. STEP_RESULT: success"]),
    ]
    tid = (await c.post("/api/agent-tasks", json={"goal": "Try something sneaky"})).json()["id"]
    d = await wait_done(c, tid)
    tool = d["tools"][0]
    assert tool["status"] == "denied" and "parallel" in tool["error"]
    assert not (Path(c.app.state.settings.resolved_workspace_dir) / "x.txt").exists()


async def test_step_failure_retry_and_dependency_skip(tc, routed):
    c = tc
    routed.plan = {"summary": "", "steps": [
        plan_step("Flaky"), plan_step("Broken"), plan_step("Needs broken", deps=[2]), plan_step("Independent"),
        plan_step("Bad deps", deps=[7, 5]),  # forward/self references are dropped by the planner sanitiser
    ]}
    routed.steps["Flaky"] = [stream_body(["Hmm. STEP_RESULT: failure: site was down"]), stream_body(["Got it. STEP_RESULT: success"])]
    routed.steps["Broken"] = [stream_body(["No. STEP_RESULT: failure: impossible"])]
    tid = (await c.post("/api/agent-tasks", json={"goal": "Do several things"})).json()["id"]
    routed.verdict = {"success": False, "summary": "Partly done.", "issues": ["Step 2 failed: impossible"]}
    d = await wait_done(c, tid)
    steps = {s["title"]: s for s in d["steps"]}
    assert steps["Flaky"]["status"] == "completed" and steps["Flaky"]["attempts"] == 2
    retry_prompt = routed._prompt(routed.step_requests("Flaky")[1])
    assert "A previous attempt at this step failed: site was down" in retry_prompt
    assert steps["Broken"]["status"] == "failed" and steps["Broken"]["error"] == "impossible" and steps["Broken"]["attempts"] == 2
    assert steps["Needs broken"]["status"] == "cancelled" and "Skipped" in steps["Needs broken"]["error"]
    assert steps["Independent"]["status"] == "completed"
    assert steps["Bad deps"]["depends_on"] == [] and steps["Bad deps"]["status"] == "completed"
    assert d["status"] == "failed" and d["issues"] == ["Step 2 failed: impossible"] and d["result"] == "Partly done."


async def test_transient_api_errors_are_retried(tc, routed):
    c = tc
    routed.plan = {"summary": "", "steps": [plan_step("Busy")]}
    routed.steps["Busy"] = [("error", 529), ("error", 529), stream_body(["Finally. STEP_RESULT: success"])]
    tid = (await c.post("/api/agent-tasks", json={"goal": "Survive an overload"})).json()["id"]
    d = await wait_done(c, tid)
    assert d["status"] == "completed" and d["steps"][0]["status"] == "completed"
    assert len(routed.step_requests("Busy")) == 3


async def test_cancel_while_waiting_for_approval(tc, routed):
    c = tc
    routed.plan = {"summary": "", "steps": [plan_step("Write it"), plan_step("Afterwards", deps=[1])]}
    routed.steps["Write it"] = [tool_stream([("w1", "write_file", {"path": "a.txt", "content": "a"})])]
    tid = (await c.post("/api/agent-tasks", json={"goal": "Write a file"})).json()["id"]
    await wait_status(c, tid, "waiting_approval")
    assert (await c.post(f"/api/agent-tasks/{tid}/cancel")).status_code == 204
    d = await wait_done(c, tid)
    assert d["status"] == "cancelled"
    assert {s["status"] for s in d["steps"]} == {"cancelled"}
    assert d["tools"][0]["status"] == "cancelled"
    assert (await c.post(f"/api/agent-tasks/{tid}/cancel")).status_code == 409
    assert not (Path(c.app.state.settings.resolved_workspace_dir) / "a.txt").exists()


async def test_token_budget_and_concurrency_limits(tc, routed):
    c = tc
    c.app.state.settings.task_token_budget = 10_000
    routed.plan = {"summary": "", "steps": [plan_step("Big"), plan_step("Next")]}
    routed.steps["Big"] = [stream_body(["Huge. STEP_RESULT: success"], usage={"input_tokens": 12_000, "output_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})]
    tid = (await c.post("/api/agent-tasks", json={"goal": "Use lots of tokens"})).json()["id"]
    d = await wait_done(c, tid)
    assert d["status"] == "failed" and "token budget" in d["error"]
    assert [s["status"] for s in d["steps"]] == ["completed", "cancelled"]

    c.app.state.settings.task_token_budget = 1_000_000
    c.app.state.settings.max_concurrent_tasks = 1
    routed.plan = {"summary": "", "steps": [plan_step("Slow")]}
    routed.steps["Slow"] = [("delay", 0.5, stream_body(["ok STEP_RESULT: success"]))]
    first = (await c.post("/api/agent-tasks", json={"goal": "First slow task"})).json()["id"]
    r = await c.post("/api/agent-tasks", json={"goal": "Second task"})
    assert r.status_code == 409 and "limit 1" in r.json()["detail"]
    await wait_done(c, first)
    assert (await c.delete(f"/api/agent-tasks/{first}")).status_code == 204
    assert (await c.get(f"/api/agent-tasks/{first}")).status_code == 404
    from sqlalchemy import func, select

    from app.models import ApiUsage, Task

    async with c.app.state.db.sessionmaker() as db:
        assert (await db.execute(select(func.count()).select_from(Task).where(Task.parent_id == first))).scalar_one() == 0
        assert (await db.execute(select(func.count()).select_from(ApiUsage))).scalar_one() > 0  # usage history kept


async def test_start_and_check_task_from_chat(tc, routed):
    from .test_tools import _wait_pending

    c = tc
    routed.plan = {"summary": "One step.", "steps": [plan_step("Look up")]}
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    # The chat turn: Claude calls start_task (needs approval), then answers.
    chat_responses = [
        tool_stream([("s1", "start_task", {"goal": "Find the best coffee grinder under $200"})]),
        stream_body(["Started it."]),
    ]
    original = routed.handler

    async def handler(request):
        body = json.loads(request.content)
        if body.get("messages") and body["messages"][0].get("content") == "Research grinders for me":
            routed.requests.append(body)
            return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content="".join(chat_responses.pop(0)).encode())
        return await original(request)

    routed.handler = handler
    c.app.state.provider.client = routed.client()

    async def approve():
        p = await _wait_pending(c)
        assert p["tool_name"] == "start_task" and p["summary"] == "Find the best coffee grinder under $200"
        await c.post(f"/api/tools/executions/{p['id']}/decision", json={"approve": True})

    t = asyncio.create_task(approve())
    r = await c.post(f"/api/conversations/{cid}/messages", json={"content": "Research grinders for me"})
    await t
    assert "Started autonomous task" in r.text
    tasks = (await c.get("/api/agent-tasks")).json()
    assert tasks[0]["goal"] == "Find the best coffee grinder under $200" and tasks[0]["conversation_id"] == cid
    d = await wait_done(c, tasks[0]["id"])
    assert d["status"] == "completed"
    # The to-do list doesn't show autonomous tasks or their steps.
    assert (await c.get("/api/tasks")).json() == []


async def test_interrupted_tasks_are_marked_on_startup(tmp_path):
    from app.models import Task, TaskStatus, User

    settings = Settings(data_dir=tmp_path / "d", frontend_dist=None, _env_file=None)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with app.state.db.sessionmaker() as db:
            u = User(username="tony", display_name="T", password_hash="x")
            db.add(u)
            await db.flush()
            db.add(Task(user_id=u.id, kind="agent", title="t", status=TaskStatus.running))
            db.add(Task(user_id=u.id, kind="todo", title="todo stays", status=TaskStatus.pending))
            await db.commit()
    app2 = create_app(settings)
    async with app2.router.lifespan_context(app2):
        async with app2.state.db.sessionmaker() as db:
            from sqlalchemy import select

            rows = {t.title: t for t in (await db.execute(select(Task))).scalars()}
            assert rows["t"].status == TaskStatus.failed and "restarted" in rows["t"].error
            assert rows["todo stays"].status == TaskStatus.pending


async def test_agent_tasks_are_private(tc, routed):
    c = tc
    routed.plan = {"summary": "", "steps": [plan_step("Only")]}
    tid = (await c.post("/api/agent-tasks", json={"goal": "Private things"})).json()["id"]
    await wait_done(c, tid)
    from app.core.security import hash_password
    from app.models import User

    async with c.app.state.db.sessionmaker() as db:
        db.add(User(username="pepper", display_name="P", password_hash=hash_password(PASSWORD)))
        await db.commit()
    token = (await c.post("/api/auth/login", json={"username": "pepper", "password": PASSWORD})).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await c.get(f"/api/agent-tasks/{tid}", headers=h)).status_code == 404
    assert (await c.get("/api/agent-tasks", headers=h)).json() == []
    assert (await c.post(f"/api/agent-tasks/{tid}/rerun", headers=h)).status_code == 404
    rerun = await c.post(f"/api/agent-tasks/{tid}/rerun")
    assert rerun.status_code == 201 and rerun.json()["goal"] == "Private things"
    await wait_done(c, rerun.json()["id"])


async def test_agent_tasks_need_claude(auth_client):
    r = await auth_client.post("/api/agent-tasks", json={"goal": "Anything at all"})
    assert r.status_code == 409 and "Claude" in r.json()["detail"]
