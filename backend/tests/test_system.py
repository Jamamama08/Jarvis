import sqlite3

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine

from app.core.db import Base
from app.core.logging import redact
from app.migrations import sync_url


async def test_settings_defaults_and_update(auth_client):
    r = await auth_client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert body["preferences"]["assistant_name"] == "JARVIS"
    assert body["server"]["ai_configured"] is False and body["server"]["phase"] == 2
    assert body["server"]["models"][0]["id"] == "claude-opus-5-5"
    assert "api_key" not in r.text.lower()

    r = await auth_client.patch("/api/settings", json={"assistant_name": "Friday", "speech_rate": 1.5})
    assert r.status_code == 200 and r.json()["assistant_name"] == "Friday"
    r = await auth_client.patch("/api/settings", json={"speech_rate": 9})
    assert r.status_code == 422
    for bad in ({"effort": "extreme"}, {"model": "Bad Model!"}, {"max_output_tokens": 999_999}):
        assert (await auth_client.patch("/api/settings", json=bad)).status_code == 422, bad
    assert (await auth_client.get("/api/settings")).json()["preferences"]["speech_rate"] == 1.5


async def test_data_persists_across_restart(settings):
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    from .conftest import PASSWORD

    app = create_app(settings)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            token = (await c.post("/api/auth/setup", json={"username": "tony", "password": PASSWORD})).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            cid = (await c.post("/api/conversations", json={"title": "Persist me"}, headers=h)).json()["id"]
            await c.post(f"/api/conversations/{cid}/messages", json={"content": "remember"}, headers=h)

    app2 = create_app(settings)
    async with app2.router.lifespan_context(app2):
        async with AsyncClient(transport=ASGITransport(app=app2), base_url="http://t") as c:
            detail = (await c.get(f"/api/conversations/{cid}", headers=h)).json()
            assert detail["title"] == "Persist me"
            assert detail["messages"][0]["content"] == "remember"


async def test_backup(auth_client, settings):
    r = await auth_client.post("/api/system/backups")
    assert r.status_code == 201
    name = r.json()["filename"]
    path = settings.data_dir / "backups" / name
    con = sqlite3.connect(path)
    tables = {row[0] for row in con.execute("select name from sqlite_master where type='table'")}
    con.close()
    assert {"users", "conversations", "messages", "memories", "tasks", "tool_executions"} <= tables
    listing = (await auth_client.get("/api/system/backups")).json()
    assert listing[0]["filename"] == name


async def test_migrations_match_models(app, settings):
    engine = create_engine(sync_url(settings.resolved_database_url))
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    engine.dispose()
    assert diff == [], diff


def test_redaction():
    assert "sk-ant-***" in redact("key sk-ant-api03-abcdefghijklmnop")
    assert "abc123def456" not in redact("Authorization: Bearer abc123def456ghi")
    assert "hunter22" not in redact('{"password": "hunter22"}')


async def test_spa_served_when_dist_present(tmp_path):
    from httpx import ASGITransport, AsyncClient

    from app.core.config import Settings
    from app.main import create_app

    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>jarvis</html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("nope")
    app = create_app(Settings(data_dir=tmp_path / "d", frontend_dist=dist, _env_file=None))
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            assert "jarvis" in (await c.get("/")).text
            assert "jarvis" in (await c.get("/conversations/abc")).text
            assert (await c.get("/assets/app.js")).text == "console.log(1)"
            assert "nope" not in (await c.get("/../secret.txt")).text
            assert (await c.get("/api/nope")).status_code == 404
            assert (await c.get("/api/health")).status_code == 200
