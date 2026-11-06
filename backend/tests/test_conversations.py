from app.services.chat import title_from
from app.services.providers import UNCONFIGURED_NOTICE

from .conftest import PASSWORD, parse_sse


async def test_conversation_crud(auth_client):
    c = auth_client
    r = await c.post("/api/conversations", json={})
    assert r.status_code == 201
    cid = r.json()["id"]
    assert r.json()["title"] == "New conversation"

    r = await c.patch(f"/api/conversations/{cid}", json={"title": "  Plans  ", "pinned": True})
    assert r.json()["title"] == "Plans" and r.json()["pinned"] is True
    assert (await c.patch(f"/api/conversations/{cid}", json={"title": "   "})).status_code == 422

    listing = (await c.get("/api/conversations")).json()
    assert [x["id"] for x in listing] == [cid]

    assert (await c.delete(f"/api/conversations/{cid}")).status_code == 204
    assert (await c.get(f"/api/conversations/{cid}")).status_code == 404
    assert (await c.get("/api/conversations")).json() == []


async def test_send_message_streams_and_persists(auth_client):
    c = auth_client
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    r = await c.post(f"/api/conversations/{cid}/messages", json={"content": "Hello JARVIS, what's on today?"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(r.text)
    names = [e for e, _ in events]
    assert names[:3] == ["user_message", "conversation", "reply_start"]
    assert names[-1] == "reply_done"
    streamed = "".join(d["text"] for e, d in events if e == "delta")
    assert streamed == UNCONFIGURED_NOTICE
    done = events[-1][1]
    assert done["status"] == "complete" and done["role"] == "system" and done["content"] == UNCONFIGURED_NOTICE

    detail = (await c.get(f"/api/conversations/{cid}")).json()
    assert detail["title"] == "Hello JARVIS, what's on today?"
    assert [(m["seq"], m["role"]) for m in detail["messages"]] == [(1, "user"), (2, "system")]

    # Second turn keeps ordering.
    await c.post(f"/api/conversations/{cid}/messages", json={"content": "again"})
    detail = (await c.get(f"/api/conversations/{cid}")).json()
    assert [m["seq"] for m in detail["messages"]] == [1, 2, 3, 4]
    assert detail["title"] == "Hello JARVIS, what's on today?"  # auto-title only once

    listing = (await c.get("/api/conversations")).json()
    assert listing[0]["message_count"] == 4
    assert listing[0]["preview"].startswith("Claude is not connected")


async def test_blank_message_rejected(auth_client):
    cid = (await auth_client.post("/api/conversations", json={})).json()["id"]
    r = await auth_client.post(f"/api/conversations/{cid}/messages", json={"content": "   "})
    assert r.status_code == 422


async def test_search_conversations(auth_client):
    c = auth_client
    a = (await c.post("/api/conversations", json={"title": "Vacation planning"})).json()["id"]
    b = (await c.post("/api/conversations", json={})).json()["id"]
    await c.post(f"/api/conversations/{b}/messages", json={"content": "Remind me about the arc reactor"})
    assert [x["id"] for x in (await c.get("/api/conversations", params={"q": "vacation"})).json()] == [a]
    assert [x["id"] for x in (await c.get("/api/conversations", params={"q": "reactor"})).json()] == [b]


async def test_users_cannot_access_each_others_conversations(app, auth_client):
    from app.core.security import hash_password
    from app.models import User

    async with app.state.db.sessionmaker() as db:
        db.add(User(username="pepper", display_name="Pepper", password_hash=hash_password(PASSWORD)))
        await db.commit()
    cid = (await auth_client.post("/api/conversations", json={})).json()["id"]
    token = (await auth_client.post("/api/auth/login", json={"username": "pepper", "password": PASSWORD})).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await auth_client.get(f"/api/conversations/{cid}", headers=h)).status_code == 404
    assert (await auth_client.delete(f"/api/conversations/{cid}", headers=h)).status_code == 404
    assert (await auth_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"}, headers=h)).status_code == 404
    assert (await auth_client.get("/api/conversations", headers=h)).json() == []


async def test_cancel_marks_reply_cancelled(app, auth_client):
    """A provider that waits forever is cancelled through the cancel endpoint; partial text is kept."""
    import asyncio

    from app.services.providers import Completed, TextDelta

    started = asyncio.Event()

    class SlowProvider:
        name = "slow"
        output_role = "assistant"
        configured = True

        async def stream(self, history, *, model, max_tokens, system, effort=None):
            yield TextDelta("partial")
            started.set()
            for _ in range(200):
                await asyncio.sleep(0.01)
                yield TextDelta(".")
            yield Completed()

    app.state.provider = SlowProvider()
    cid = (await auth_client.post("/api/conversations", json={})).json()["id"]

    async def cancel_soon():
        await started.wait()
        r = await auth_client.post(f"/api/conversations/{cid}/cancel")
        assert r.json() == {"cancelled": True}

    canceller = asyncio.create_task(asyncio.wait_for(cancel_soon(), 10))
    r = await asyncio.wait_for(auth_client.post(f"/api/conversations/{cid}/messages", json={"content": "go"}), 10)
    await canceller
    done = parse_sse(r.text)[-1][1]
    assert done["status"] == "cancelled" and done["content"].startswith("partial")
    assert len(done["content"]) < len("partial") + 200
    msgs = (await auth_client.get(f"/api/conversations/{cid}")).json()["messages"]
    assert msgs[-1]["status"] == "cancelled"
    # Registry is released, so a new turn can start.
    assert not app.state.generations.is_active(cid)


async def test_provider_error_is_persisted(app, auth_client):
    class BrokenProvider:
        name = "broken"
        output_role = "assistant"
        configured = True

        async def stream(self, history, *, model, max_tokens, system, effort=None):
            raise RuntimeError("upstream exploded")
            yield  # pragma: no cover

    app.state.provider = BrokenProvider()
    cid = (await auth_client.post("/api/conversations", json={})).json()["id"]
    r = await auth_client.post(f"/api/conversations/{cid}/messages", json={"content": "hi"})
    done = parse_sse(r.text)[-1][1]
    # Internal exception details are logged, not shown to the user.
    assert done["status"] == "error" and done["error"] == "Unexpected error while generating the response."
    assert "exploded" not in r.text


def test_title_from():
    assert title_from("  hello   world ") == "hello world"
    long = "word " * 40
    t = title_from(long)
    assert len(t) <= 61 and t.endswith("…")
