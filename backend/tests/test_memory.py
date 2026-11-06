"""Phase 3: memory engine, projects, retrieval into chat, and Claude suggestions."""

import json

import httpx2
import pytest

from app.services.memory import content_hash, fts_query, normalize, similarity
from app.services.memory_suggest import looks_secret

from .conftest import PASSWORD
from .test_claude import FakeAnthropic, _send, claude_client, fake, stream_body  # noqa: F401  (fixtures)


async def _add(c, content, **kw):
    return await c.post("/api/memories", json={"content": content, **kw})


# --- Unit ---------------------------------------------------------------------


def test_normalisation_and_hash():
    assert normalize("  Prefers   METRIC units! ") == "prefers metric units"
    assert content_hash("Prefers metric units.") == content_hash("prefers  metric UNITS")
    assert similarity("Tony prefers metric units", "Tony prefers the metric units") >= 0.8
    assert similarity("Likes coffee", "Hates tea") == 0.0


def test_fts_query_is_injection_safe():
    q = fts_query('pepper" OR user_id:* NEAR(', mode="all")
    assert q == '"pepper" AND "or" AND "user" AND "id" AND "near"*'
    assert fts_query("the of and", mode="any") is None
    assert fts_query("What is my favourite coffee?", mode="any") == '"favourite" OR "coffee"'


def test_secret_filter():
    assert looks_secret("API key is sk-ant-abcdefghijklmnop")
    assert looks_secret("Card 4111 1111 1111 1111")
    assert looks_secret("password: hunter22")
    assert not looks_secret("Prefers dark roast coffee")


# --- CRUD, duplicates, history --------------------------------------------------


async def test_memory_crud_and_history(auth_client):
    c = auth_client
    r = await _add(c, "Prefers metric units.", category="preference", importance=4)
    assert r.status_code == 201
    m = r.json()
    assert m["approved"] is True and m["source"] == "user" and m["importance"] == 4

    r = await c.patch(f"/api/memories/{m['id']}", json={"content": "Prefers metric units and 24-hour time."})
    assert r.status_code == 200 and r.json()["content"] == "Prefers metric units and 24-hour time."
    # A no-op update writes no history.
    await c.patch(f"/api/memories/{m['id']}", json={"importance": 4})

    history = (await c.get(f"/api/memories/{m['id']}/history")).json()
    assert [h["action"] for h in history] == ["update", "create"]
    assert history[0]["old_content"] == "Prefers metric units."

    listing = (await c.get("/api/memories")).json()
    assert listing["total"] == 1 and listing["counts"]["preference"] == 1

    assert (await c.delete(f"/api/memories/{m['id']}")).status_code == 204
    assert (await c.get(f"/api/memories/{m['id']}")).status_code == 404
    # History survives a normal delete...
    history = (await c.get(f"/api/memories/{m['id']}/history")).json()
    assert history[0]["action"] == "delete"
    recent = (await c.get("/api/memories/history")).json()
    assert recent[0]["action"] == "delete"


async def test_purge_erases_history(auth_client):
    c = auth_client
    m = (await _add(c, "Allergic to peanuts.", category="personal")).json()
    assert (await c.delete(f"/api/memories/{m['id']}", params={"purge_history": True})).status_code == 204
    assert (await c.get(f"/api/memories/{m['id']}/history")).status_code == 404
    assert all(h["memory_id"] != m["id"] for h in (await c.get("/api/memories/history")).json())


async def test_duplicates_are_prevented(auth_client):
    c = auth_client
    first = (await _add(c, "Tony prefers dark roast coffee.")).json()
    r = await _add(c, "tony PREFERS dark-roast coffee")
    assert r.status_code == 409 and r.json()["existing_id"] == first["id"]
    assert "already exists" in r.json()["detail"]
    r = await _add(c, "Tony prefers the dark roast coffee.")
    assert r.status_code == 409 and "very similar" in r.json()["detail"]
    r = await _add(c, "Tony prefers the dark roast coffee.", allow_near_duplicate=True)
    assert r.status_code == 201
    # Editing into an exact duplicate is refused.
    other = (await _add(c, "Lives in Malibu.")).json()
    r = await c.patch(f"/api/memories/{other['id']}", json={"content": "Tony prefers dark roast coffee"})
    assert r.status_code == 409


async def test_validation(auth_client):
    c = auth_client
    assert (await _add(c, "   ")).status_code in (409, 422)
    assert (await _add(c, "x", category="secrets")).status_code == 422
    assert (await _add(c, "x", importance=9)).status_code == 422
    assert (await _add(c, "Fine", project_id="nope")).status_code == 404


async def test_full_text_search_and_filters(auth_client):
    c = auth_client
    await _add(c, "Building a new arc reactor prototype in the lab.", category="project")
    await _add(c, "Prefers green tea in the afternoon.", category="preference")
    await _add(c, "Daughter Morgan loves cheeseburgers.", category="personal")
    hits = (await c.get("/api/memories", params={"q": "reactor"})).json()
    assert [m["content"] for m in hits["items"]] == ["Building a new arc reactor prototype in the lab."]
    # Prefix match on the last term, stemming (porter) on others.
    assert (await c.get("/api/memories", params={"q": "cheeseburg"})).json()["total"] == 1
    assert (await c.get("/api/memories", params={"q": "loving cheeseburgers"})).json()["total"] == 1
    assert (await c.get("/api/memories", params={"category": "preference"})).json()["total"] == 1
    assert (await c.get("/api/memories", params={"q": "zzz"})).json()["total"] == 0
    # FTS index follows edits and deletes (triggers).
    mid = hits["items"][0]["id"]
    await c.patch(f"/api/memories/{mid}", json={"content": "Building a new suit prototype."})
    assert (await c.get("/api/memories", params={"q": "reactor"})).json()["total"] == 0
    assert (await c.get("/api/memories", params={"q": "suit"})).json()["total"] == 1
    await c.delete(f"/api/memories/{mid}")
    assert (await c.get("/api/memories", params={"q": "suit"})).json()["total"] == 0


async def test_memories_are_private(app, auth_client):
    from app.core.security import hash_password
    from app.models import User

    async with app.state.db.sessionmaker() as db:
        db.add(User(username="pepper", display_name="Pepper", password_hash=hash_password(PASSWORD)))
        await db.commit()
    mine = (await _add(auth_client, "Secret lab location is the basement.")).json()
    token = (await auth_client.post("/api/auth/login", json={"username": "pepper", "password": PASSWORD})).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await auth_client.get("/api/memories", headers=h)).json()["total"] == 0
    assert (await auth_client.get("/api/memories", params={"q": "basement"}, headers=h)).json()["total"] == 0
    assert (await auth_client.get(f"/api/memories/{mine['id']}", headers=h)).status_code == 404
    assert (await auth_client.patch(f"/api/memories/{mine['id']}", json={"content": "x y z"}, headers=h)).status_code == 404
    assert (await auth_client.delete(f"/api/memories/{mine['id']}", headers=h)).status_code == 404
    assert (await auth_client.get(f"/api/memories/{mine['id']}/history", headers=h)).status_code == 404
    # The same content can exist for another user (duplicates are per user).
    assert (await auth_client.post("/api/memories", json={"content": "Secret lab location is the basement."}, headers=h)).status_code == 201


async def test_projects(auth_client):
    c = auth_client
    p = (await c.post("/api/projects", json={"name": " Mark 50 ", "description": "Nanotech suit"})).json()
    assert p["name"] == "Mark 50" and p["status"] == "active"
    m = (await _add(c, "Mark 50 uses nanite storage in the arc reactor housing.", category="project", project_id=p["id"])).json()
    r = await c.patch(f"/api/projects/{p['id']}", json={"status": "paused", "progress_notes": "Waiting on nanites."})
    assert r.json()["status"] == "paused" and r.json()["memory_count"] == 1
    assert (await c.get("/api/memories", params={"project_id": p["id"]})).json()["total"] == 1
    assert (await c.patch(f"/api/projects/{p['id']}", json={"status": "exploded"})).status_code == 422
    assert (await c.delete(f"/api/projects/{p['id']}")).status_code == 204
    # Memories survive project deletion, unlinked.
    assert (await c.get(f"/api/memories/{m['id']}")).json()["project_id"] is None
    assert (await c.get("/api/projects")).json() == []


async def test_memories_persist_across_restart(settings):
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            token = (await c.post("/api/auth/setup", json={"username": "tony", "password": PASSWORD})).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            await c.post("/api/memories", json={"content": "Favourite band is AC/DC."}, headers=h)
    app2 = create_app(settings)
    async with app2.router.lifespan_context(app2):
        async with AsyncClient(transport=ASGITransport(app=app2), base_url="http://t") as c:
            r = await c.get("/api/memories", params={"q": "band"}, headers=h)
            assert r.json()["items"][0]["content"] == "Favourite band is AC/DC."


# --- Retrieval into chat ----------------------------------------------------------


def _user_blocks(body: dict, index: int = -1):
    content = body["messages"][index]["content"]
    return content if isinstance(content, list) else [{"type": "text", "text": content}]


async def test_relevant_memories_are_sent_once_and_stored(claude_client, fake):
    c = claude_client
    await _add(c, "Prefers to be called Boss.", category="preference", importance=5)
    await _add(c, "Coffee order is a double espresso.", category="preference", importance=2)
    await _add(c, "Owns a dog named Dum-E.", category="personal", importance=2)
    cid = (await c.post("/api/conversations", json={})).json()["id"]

    fake.queue_stream(stream_body(["One espresso coming up."]))
    events = await _send(c, cid, "Order my usual coffee")
    blocks = _user_blocks(fake.body())
    assert len(blocks) == 2 and blocks[1]["text"] == "Order my usual coffee"
    context = blocks[0]["text"]
    assert context.startswith("<memory_context>")
    assert "Prefers to be called Boss." in context  # core (importance >= 4)
    assert "double espresso" in context  # full-text match
    assert "Dum-E" not in context  # irrelevant
    user_event = next(d for e, d in events if e == "user_message")
    assert len(user_event["memory_ids"]) == 2

    # Second turn: history replays the first turn byte-identically, and already-sent memories aren't repeated.
    fake.queue_stream(stream_body(["Dum-E is fine."]))
    await _send(c, cid, "How is my dog doing? Also more coffee")
    body = fake.body()
    assert body["messages"][0]["content"] == [{"type": "text", "text": context}, {"type": "text", "text": "Order my usual coffee"}]
    new_context = _user_blocks(body)[0]["text"]
    assert "Dum-E" in new_context and "espresso" not in new_context and "Boss" not in new_context

    # Memory ids are exposed on stored messages, and last_used_at is set.
    msgs = (await c.get(f"/api/conversations/{cid}")).json()["messages"]
    assert len(msgs[0]["memory_ids"]) == 2 and len(msgs[2]["memory_ids"]) == 1
    boss = (await c.get("/api/memories", params={"q": "Boss"})).json()["items"][0]
    assert boss["last_used_at"] is not None


async def test_pending_memories_and_disabled_memory_are_not_sent(claude_client, fake):
    c = claude_client
    app = c.app
    from app.models import MemoryCategory
    from app.services import memory as mem

    async with app.state.db.sessionmaker() as db:
        user_id = (await c.get("/api/auth/me")).json()["id"]
        await mem.create_memory(db, user_id, content="Pending: likes jazz.", category=MemoryCategory.preference,
                                importance=5, approved=False, source="assistant")
        await db.commit()
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    fake.queue_stream(stream_body(["ok"]))
    await _send(c, cid, "Play some jazz")
    assert isinstance(fake.body()["messages"][-1]["content"], str)  # no memory block at all

    await _add(c, "Loves classic rock and jazz.", importance=5)
    await c.patch("/api/settings", json={"memory_enabled": False})
    fake.queue_stream(stream_body(["ok"]))
    await _send(c, cid, "Play some jazz again")
    assert isinstance(fake.body()["messages"][-1]["content"], str)


# --- Suggestions --------------------------------------------------------------------


def _json_message(data: dict, *, stop_reason: str = "end_turn") -> httpx2.Response:
    return httpx2.Response(200, json={
        "id": "msg_json", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
        "content": [{"type": "text", "text": json.dumps(data)}],
        "stop_reason": stop_reason, "stop_sequence": None,
        "usage": {"input_tokens": 900, "output_tokens": 60, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
    })


async def test_suggest_memories_creates_pending_for_approval(claude_client, fake):
    c = claude_client
    existing = (await _add(c, "Prefers metric units.", category="preference")).json()
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    fake.queue_stream(stream_body(["Noted."]))
    await _send(c, cid, "I'm vegetarian, and I'm training for the Malibu half marathon in March.")

    fake.responses.append(_json_message({"memories": [
        {"content": "Is vegetarian.", "category": "personal", "importance": 4},
        {"content": "Training for the Malibu half marathon in March.", "category": "project", "importance": 3},
        {"content": "prefers METRIC units", "category": "preference", "importance": 3},  # duplicate
        {"content": "Password: hunter22", "category": "personal", "importance": 5},  # secret
        {"content": "Odd category", "category": "nonsense", "importance": 99},
    ]}))
    r = await c.post(f"/api/conversations/{cid}/suggest-memories")
    assert r.status_code == 200, r.text
    out = r.json()
    assert [m["content"] for m in out["created"]] == [
        "Is vegetarian.", "Training for the Malibu half marathon in March.", "Odd category"]
    assert out["skipped_duplicates"] == 2
    assert all(m["approved"] is False and m["source"] == "assistant" and m["source_conversation_id"] == cid for m in out["created"])
    assert out["created"][2]["category"] == "knowledge" and out["created"][2]["importance"] == 5

    # The extraction request: structured output, transcript as data, existing memories listed.
    body = fake.body()
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert "stream" not in body or body["stream"] is False
    prompt = body["messages"][0]["content"]
    assert "Prefers metric units." in prompt and "USER: I'm vegetarian" in prompt and "ASSISTANT: Noted." in prompt

    # Pending suggestions are listed separately and never sent to Claude until approved.
    assert (await c.get("/api/memories", params={"state": "pending"})).json()["total"] == 3
    assert (await c.get("/api/memories")).json()["total"] == 1
    veg, marathon, odd = out["created"]
    r = await c.post(f"/api/memories/{veg['id']}/approve")
    assert r.json()["approved"] is True
    assert (await c.post(f"/api/memories/{marathon['id']}/reject")).status_code == 204
    assert (await c.get(f"/api/memories/{marathon['id']}")).status_code == 404
    assert (await c.post(f"/api/memories/{veg['id']}/reject")).status_code == 409  # approved: delete instead
    actions = [h["action"] for h in (await c.get(f"/api/memories/{veg['id']}/history")).json()]
    assert actions == ["approve", "suggest"]
    assert [h["action"] for h in (await c.get(f"/api/memories/{marathon['id']}/history")).json()] == ["reject", "suggest"]

    # Usage of the extraction call is recorded.
    usage = (await c.get("/api/usage")).json()["totals"]
    assert usage["requests"] == 2 and usage["input_tokens"] >= 900


async def test_suggest_memories_errors(claude_client, fake):
    c = claude_client
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    # Empty conversation: no API call.
    r = await c.post(f"/api/conversations/{cid}/suggest-memories")
    assert r.json() == {"created": [], "skipped_duplicates": 0} and fake.requests == []
    fake.queue_stream(stream_body(["hi"]))
    await _send(c, cid, "hello")
    fake.responses.append(_json_message({}, stop_reason="refusal"))
    r = await c.post(f"/api/conversations/{cid}/suggest-memories")
    assert r.status_code == 502 and r.json()["detail"] == "Claude declined this request."
    assert (await c.get("/api/usage")).json()["totals"]["requests"] == 2  # refusal still recorded
    fake.queue_error(429, "rate_limit_error", "slow down")
    r = await c.post(f"/api/conversations/{cid}/suggest-memories")
    assert r.status_code == 502 and "rate limit" in r.json()["detail"]
    assert (await c.post("/api/conversations/nope/suggest-memories")).status_code == 404


async def test_suggest_requires_claude(auth_client):
    cid = (await auth_client.post("/api/conversations", json={})).json()["id"]
    r = await auth_client.post(f"/api/conversations/{cid}/suggest-memories")
    assert r.status_code == 409
