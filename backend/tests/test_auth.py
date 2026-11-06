from app.core.security import hash_password, verify_password

from .conftest import PASSWORD


def test_password_hashing_roundtrip():
    h = hash_password("s3cret-pass")
    assert h.startswith("scrypt$") and "s3cret" not in h
    assert verify_password("s3cret-pass", h)
    assert not verify_password("wrong", h)
    assert not verify_password("x", "garbage")


async def test_health_is_public(client):
    r = await client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert r.headers["x-content-type-options"] == "nosniff"


async def test_setup_flow(client):
    r = await client.get("/api/auth/status")
    assert r.json() == {"setup_required": True, "setup_token_required": False}

    r = await client.post("/api/auth/setup", json={"username": "tony", "password": "short"})
    assert r.status_code == 422

    r = await client.post("/api/auth/setup", json={"username": "Tony", "password": PASSWORD})
    assert r.status_code == 201
    body = r.json()
    assert body["user"]["username"] == "tony" and body["token"]

    assert (await client.get("/api/auth/status")).json()["setup_required"] is False
    # Setup can only happen once.
    r = await client.post("/api/auth/setup", json={"username": "other", "password": PASSWORD})
    assert r.status_code == 409


async def test_protected_routes_require_auth(client):
    for method, path in [("get", "/api/conversations"), ("get", "/api/settings"), ("get", "/api/auth/me"),
                         ("post", "/api/system/backups")]:
        r = await getattr(client, method)(path)
        assert r.status_code == 401, path
    r = await client.get("/api/conversations", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


async def test_login_logout(auth_client):
    c = auth_client
    r = await c.post("/api/auth/login", json={"username": "TONY", "password": PASSWORD})
    assert r.status_code == 200
    token = r.json()["token"]
    r = await c.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.json()["display_name"] == "Tony"
    r = await c.post("/api/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 204
    r = await c.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


async def test_login_rate_limit(auth_client):
    for _ in range(5):
        r = await auth_client.post("/api/auth/login", json={"username": "tony", "password": "wrong-password"})
        assert r.status_code == 401
    r = await auth_client.post("/api/auth/login", json={"username": "tony", "password": PASSWORD})
    assert r.status_code == 429


async def test_change_password_revokes_other_sessions(auth_client):
    c = auth_client
    other = (await c.post("/api/auth/login", json={"username": "tony", "password": PASSWORD})).json()["token"]
    r = await c.post("/api/auth/password", json={"current_password": "bad", "new_password": "newpassword1"})
    assert r.status_code == 400
    r = await c.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "newpassword1"})
    assert r.status_code == 204
    assert (await c.get("/api/auth/me")).status_code == 200  # current session survives
    assert (await c.get("/api/auth/me", headers={"Authorization": f"Bearer {other}"})).status_code == 401
    r = await c.post("/api/auth/login", json={"username": "tony", "password": "newpassword1"})
    assert r.status_code == 200


async def test_exposed_server_requires_setup_token(tmp_path):
    from httpx import ASGITransport, AsyncClient

    from app.core.config import Settings
    from app.main import create_app

    s = Settings(data_dir=tmp_path / "d", frontend_dist=None, host="0.0.0.0", setup_token="tok-123", _env_file=None)
    app = create_app(s)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            assert (await c.get("/api/auth/status")).json()["setup_token_required"] is True
            r = await c.post("/api/auth/setup", json={"username": "tony", "password": PASSWORD})
            assert r.status_code == 403
            r = await c.post("/api/auth/setup", json={"username": "tony", "password": PASSWORD, "setup_token": "tok-123"})
            assert r.status_code == 201
