"""Phase 8: secret store, API key management, email (SMTP/IMAP), calendar (.ics), notifications, weather."""

import asyncio
import email as email_lib
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import anthropic
import pytest

from app.core.config import Settings
from app.core.secrets import SecretStore
from app.integrations import calendar, http, notify, weather
from app.integrations import email as mail
from app.integrations.http import IntegrationError

from .conftest import PASSWORD
from .test_claude import _send, claude_client, fake, stream_body  # noqa: F401  (fixtures)
from .test_tools import tool_stream

# --- Local servers ---------------------------------------------------------------------------

ICS = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:standup@test
DTSTART:{monday}T090000Z
DTEND:{monday}T091500Z
RRULE:FREQ=DAILY;COUNT=30
SUMMARY:Lab standup
LOCATION:Workshop
END:VEVENT
BEGIN:VEVENT
UID:expo@test
DTSTART;VALUE=DATE:{expo}
DTEND;VALUE=DATE:{expo_end}
SUMMARY:Stark Expo
END:VEVENT
END:VCALENDAR
"""
RECEIVED: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        from datetime import date, timedelta

        today = date.today()
        body = ICS.format(monday=today.strftime("%Y%m%d"), expo=(today + timedelta(days=2)).strftime("%Y%m%d"),
                          expo_end=(today + timedelta(days=3)).strftime("%Y%m%d"))
        if self.path == "/bad.ics":
            body = "<html>not a calendar</html>"
        data = body.replace("\n", "\r\n").encode()
        self.send_response(200)
        self.send_header("content-type", "text/calendar")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        RECEIVED.append({"path": self.path, "headers": dict(self.headers), "body": self.rfile.read(length).decode()})
        self.send_response(200)
        self.send_header("content-length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


@pytest.fixture(scope="module")
def web():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def smtp():
    from aiosmtpd.controller import Controller

    messages: list = []

    class H:
        async def handle_DATA(self, server, session, envelope):
            messages.append({"from": envelope.mail_from, "to": envelope.rcpt_tos, "msg": email_lib.message_from_bytes(envelope.content)})
            return "250 OK"

    import socket

    with socket.socket() as sock:  # aiosmtpd doesn't report the port it picked for port=0
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    ctl = Controller(H(), hostname="127.0.0.1", port=port)
    ctl.start()
    yield port, messages
    ctl.stop()


class FakeIMAP:
    """Stands in for imaplib.IMAP4 (no IMAP server in the test environment)."""

    import imaplib as _imaplib

    error = _imaplib.IMAP4.error

    MESSAGES = {
        b"1": (b"\\Seen", b"From: Pepper <pepper@stark.com>\r\nTo: tony@stark.com\r\nSubject: Board meeting\r\nDate: Mon, 3 Nov 2026 10:00:00 +0000\r\n\r\nThe board meets Friday at 10.\r\n"),
        b"2": (b"", b"From: Happy <happy@stark.com>\r\nTo: tony@stark.com\r\nSubject: Car\r\nDate: Tue, 4 Nov 2026 10:00:00 +0000\r\nContent-Type: text/html\r\n\r\n<p>The car is <b>ready</b>.</p><script>x()</script>\r\n"),
    }
    searches: list = []

    def __init__(self, host, port, timeout=None):
        self.host = host

    def login(self, user, password):
        import imaplib

        if password != "app-password":
            raise imaplib.IMAP4.error("AUTHENTICATIONFAILED")

    def select(self, folder, readonly=False):
        return ("OK", [b"2"]) if folder in ('"INBOX"', "INBOX") else ("NO", [b"no such folder"])

    def uid(self, command, *args):
        if command == "SEARCH":
            FakeIMAP.searches.append(args)
            text = " ".join(a for a in args if isinstance(a, str))
            ids = [u for u, (_, raw) in self.MESSAGES.items() if "car" not in text.lower() or b"Car" in raw]
            if "UNSEEN" in args:
                ids = [u for u in ids if b"\\Seen" not in self.MESSAGES[u][0]]
            return "OK", [b" ".join(ids)]
        uid = args[0]
        if uid not in self.MESSAGES:
            return "OK", [None]
        flags, raw = self.MESSAGES[uid]
        return "OK", [(b"1 (UID " + uid + b" BODY[] {n}", raw), b" FLAGS (" + flags + b"))"]

    def starttls(self, ssl_context=None):
        pass

    def logout(self):
        pass


@pytest.fixture
def fake_imap(monkeypatch):
    monkeypatch.setattr(mail.imaplib, "IMAP4", FakeIMAP)
    monkeypatch.setattr(mail.imaplib, "IMAP4_SSL", lambda host, port, ssl_context=None, timeout=None: FakeIMAP(host, port))
    FakeIMAP.searches = []
    return FakeIMAP


def email_cfg(smtp_port=25, **kw):
    return {"username": "tony@stark.com", "password": "app-password", "imap_host": "imap.stark.com",
            "smtp_host": "127.0.0.1", "smtp_port": smtp_port, "smtp_security": "none", **kw}


# --- Secret store -----------------------------------------------------------------------------


def test_secret_store(tmp_path):
    store = SecretStore(tmp_path / "secrets.json")
    store.set("anthropic_api_key", "sk-ant-x")
    store.update_user("u1", "email", {"password": "p"})
    store.update_user("u2", "calendar", {"url": "https://x"})
    assert SecretStore(tmp_path / "secrets.json").get("anthropic_api_key") == "sk-ant-x"
    assert store.user("u1") == {"email": {"password": "p"}} and store.user("u2") == {"calendar": {"url": "https://x"}}
    store.update_user("u1", "email", None)
    assert store.user("u1") == {}
    if os.name == "posix":
        assert oct((tmp_path / "secrets.json").stat().st_mode & 0o777) == "0o600"
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".secrets-")]  # no temp files left


# --- Claude API key -------------------------------------------------------------------------


class FakeModels:
    def __init__(self, ok):
        self.ok = ok

    async def list(self, limit=1):
        if not self.ok:
            import httpx2

            raise anthropic.AuthenticationError("bad key", response=httpx2.Response(401, request=httpx2.Request("GET", "https://x")), body=None)
        return []


class FakeKeyClient:
    def __init__(self, ok):
        self.models = FakeModels(ok)


async def test_api_key_set_from_settings_by_owner_only(auth_client):
    c = auth_client
    app = c._transport.app
    app.state.key_check_client = lambda key: FakeKeyClient(ok=key.endswith("good-key-123456"))
    status = (await c.get("/api/integrations")).json()["anthropic"]
    assert status == {"configured": False, "source": None, "editable": True}
    r = await c.put("/api/integrations/anthropic", json={"api_key": "sk-ant-api03-bad-key-1234567"})
    assert r.status_code == 422 and "rejected" in r.json()["detail"]
    r = await c.put("/api/integrations/anthropic", json={"api_key": "sk-ant-api03-good-key-123456"})
    assert r.status_code == 204
    settings = (await c.get("/api/settings")).json()["server"]
    assert settings["ai_configured"] is True  # took effect without a restart
    assert app.state.task_runner.provider is app.state.provider
    for path in ("/api/integrations", "/api/settings"):
        assert "good-key" not in (await c.get(path)).text
    assert (await c.get("/api/integrations")).json()["anthropic"]["source"] == "settings"

    # A second account can't change it.
    from app.core.security import hash_password
    from app.models import User

    async with app.state.db.sessionmaker() as db:
        db.add(User(username="pepper", display_name="P", password_hash=hash_password(PASSWORD)))
        await db.commit()
    token = (await c.post("/api/auth/login", json={"username": "pepper", "password": PASSWORD})).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await c.get("/api/integrations", headers=h)).json()["anthropic"]["editable"] is False
    assert (await c.put("/api/integrations/anthropic", json={"api_key": "sk-ant-api03-good-key-123456"}, headers=h)).status_code == 403
    assert (await c.delete("/api/integrations/anthropic", headers=h)).status_code == 403

    assert (await c.delete("/api/integrations/anthropic")).status_code == 204
    assert (await c.get("/api/settings")).json()["server"]["ai_configured"] is False


async def test_env_key_wins_and_is_not_editable(tmp_path):
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    app = create_app(Settings(data_dir=tmp_path, frontend_dist=None, _env_file=None, ANTHROPIC_API_KEY="sk-ant-from-env-123456"))
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            token = (await c.post("/api/auth/setup", json={"username": "tony", "password": PASSWORD})).json()["token"]
            h = {"Authorization": f"Bearer {token}"}
            assert (await c.get("/api/integrations", headers=h)).json()["anthropic"] == {"configured": True, "source": "env", "editable": False}
            assert (await c.put("/api/integrations/anthropic", json={"api_key": "sk-ant-api03-other-123456"}, headers=h)).status_code == 409


# --- Email ------------------------------------------------------------------------------------


def test_smtp_send_and_validation(smtp):
    port, messages = smtp
    cfg = mail.EmailConfig.from_dict(email_cfg(port))
    assert mail.send(cfg, "Pepper <pepper@stark.com>, happy@stark.com", "Dinner", "At 8?", cc="rhodey@stark.com").startswith("Sent to")
    m = messages[0]
    assert m["to"] == ["pepper@stark.com", "happy@stark.com", "rhodey@stark.com"]
    assert m["msg"]["Subject"] == "Dinner" and m["msg"]["From"] == "tony@stark.com" and "At 8?" in m["msg"].get_payload()
    with pytest.raises(IntegrationError, match="line breaks"):
        mail.send(cfg, "pepper@stark.com", "Hi\r\nBcc: evil@x.com", "x")
    with pytest.raises(IntegrationError, match="Invalid email"):
        mail.send(cfg, "not-an-address", "Hi", "x")


def test_imap_search_read_and_auth(fake_imap):
    cfg = mail.EmailConfig.from_dict(email_cfg())
    found = mail.search(cfg)
    assert [m["subject"] for m in found] == ["Car", "Board meeting"]  # newest first
    assert found[0]["unread"] is True and found[1]["unread"] is False
    assert found[0]["snippet"] == "The car is ready ."  # HTML stripped, script removed
    mail.search(cfg, 'car" OR ALL "x\r\n')
    assert fake_imap.searches[-1][-1] == '"car  OR ALL  x"'  # quotes/newlines can't break out of the search string
    assert [m["subject"] for m in mail.search(cfg, unread_only=True)] == ["Car"]
    msg = mail.read(cfg, "1")
    assert msg["subject"] == "Board meeting" and "Friday at 10" in msg["body"]
    with pytest.raises(IntegrationError, match="numbers"):
        mail.read(cfg, "1:*")
    with pytest.raises(IntegrationError, match="app password"):
        mail.search(mail.EmailConfig.from_dict(email_cfg(password="wrong")))
    assert mail.test(cfg).startswith("Connected. Inbox has 2 messages")


async def test_email_tools_and_settings_api(claude_client, fake, smtp, fake_imap):
    c = claude_client
    port, messages = smtp
    # Not configured yet: the tool says where to set it up.
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    fake.queue_stream(tool_stream([("e0", "email_search", {})]))
    fake.queue_stream(stream_body(["ok"]))
    await _send(c, cid, "any mail?")
    assert "Settings → Connections" in fake.body()["messages"][-1]["content"][0]["content"]

    cfg = email_cfg(port)
    assert (await c.put("/api/integrations/email", json={**cfg, "password": None})).status_code == 422
    assert (await c.put("/api/integrations/email", json=cfg)).status_code == 204
    # Updating without a password keeps the stored one; the password is never returned.
    assert (await c.put("/api/integrations/email", json={**cfg, "password": None, "from_address": "Tony <tony@stark.com>"})).status_code == 204
    status = (await c.get("/api/integrations")).json()["email"]
    assert status["configured"] and status["username"] == "tony@stark.com" and "password" not in status
    assert "app-password" not in (await c.get("/api/integrations")).text
    assert (await c.post("/api/integrations/email/test")).json()["message"].startswith("Connected.")

    await c.put("/api/tools/policies", json={"scope": "tool:email_send", "decision": "allow"})
    fake.queue_stream(tool_stream([
        ("e1", "email_search", {"query": "board"}),
        ("e2", "email_read", {"message_id": "1"}),
        ("e3", "email_send", {"to": "pepper@stark.com", "subject": "Re: Board meeting", "body": "I'll be there."}),
    ]))
    fake.queue_stream(stream_body(["Replied."]))
    await _send(c, cid, "Reply to Pepper about the board meeting")
    results = [r["content"] for r in fake.body()["messages"][-1]["content"]]
    assert results[0].startswith("[Untrusted content") and "Board meeting" in results[0]
    assert "The board meets Friday at 10." in results[1]
    assert results[2] == "Sent to pepper@stark.com."
    assert messages[-1]["msg"]["From"] == "Tony <tony@stark.com>" and messages[-1]["msg"]["Subject"] == "Re: Board meeting"
    log = (await c.get("/api/tools/executions", params={"tool": "email_send"})).json()[0]
    assert log["summary"] == 'send email to pepper@stark.com: "Re: Board meeting"'

    assert (await c.delete("/api/integrations/email")).status_code == 204
    assert (await c.get("/api/integrations")).json()["email"]["configured"] is False


# --- Calendar ---------------------------------------------------------------------------------


def test_calendar_feed_with_recurrence(web):
    start, end = calendar.window(7)
    found = calendar.events(web + "/cal.ics", start, end)
    standups = [e for e in found if e["title"] == "Lab standup"]
    assert len(standups) == 7  # daily recurrence expanded inside the window
    expo = next(e for e in found if e["title"] == "Stark Expo")
    assert expo["all_day"] is True
    text = calendar.describe(found, start, end)
    assert "(all day): Stark Expo" in text and "@ Workshop" in text
    with pytest.raises(IntegrationError, match="valid iCalendar"):
        calendar.events(web + "/bad.ics", start, end)
    assert http.require_http("webcal://example.com/x.ics") == "https://example.com/x.ics"
    with pytest.raises(IntegrationError):
        http.require_http("file:///etc/passwd")


async def test_calendar_and_notification_tools(claude_client, fake, web):
    c = claude_client
    assert (await c.put("/api/integrations/calendar", json={"url": "ftp://nope.example.com/x"})).status_code == 422
    assert (await c.put("/api/integrations/calendar", json={"url": web + "/cal.ics"})).status_code == 204
    assert "event(s) in the next 7 days" in (await c.post("/api/integrations/calendar/test")).json()["message"]
    assert (await c.put("/api/integrations/notifications", json={"url": web + "/hook"})).status_code == 204
    RECEIVED.clear()
    assert (await c.post("/api/integrations/notifications/test")).json()["message"] == "Sent a test notification (json)."
    assert json.loads(RECEIVED[-1]["body"]) == {"title": "JARVIS", "message": "Test notification: it works."}

    await c.put("/api/tools/policies", json={"scope": "tool:send_notification", "decision": "allow"})
    cid = (await c.post("/api/conversations", json={})).json()["id"]
    fake.queue_stream(tool_stream([
        ("c1", "calendar_events", {"days": 3}),
        ("n1", "send_notification", {"title": "Reminder", "message": "Expo in 2 days"}),
    ]))
    fake.queue_stream(stream_body(["Done."]))
    await _send(c, cid, "What's on, and remind me on my phone")
    results = [r["content"] for r in fake.body()["messages"][-1]["content"]]
    assert "Lab standup" in results[0] and "Stark Expo" in results[0]
    assert results[1] == "Notification sent (json)." and json.loads(RECEIVED[-1]["body"])["message"] == "Expo in 2 days"
    status = (await c.get("/api/integrations")).json()
    assert status["calendar"] == {"configured": True} and web not in json.dumps(status)  # private URL not returned


def test_notification_kinds(web, monkeypatch):
    assert notify.kind("https://ntfy.sh/my-topic") == "ntfy"
    assert notify.kind("https://discord.com/api/webhooks/1/abc") == "discord"
    assert notify.kind("https://hooks.slack.com/services/x") == "slack"
    calls = []
    monkeypatch.setattr(http, "fetch", lambda url, **kw: calls.append((url, kw)) or b"")
    notify.send("https://ntfy.sh/topic", "Héllo", "Body")
    assert calls[-1][1]["data"] == b"Body" and calls[-1][1]["headers"]["Title"] == "H?llo"
    notify.send("https://discord.com/api/webhooks/1/abc", "T", "M")
    assert json.loads(calls[-1][1]["data"]) == {"content": "**T**\nM"}


# --- Weather ----------------------------------------------------------------------------------


def test_weather(monkeypatch):
    def fake_fetch(url, **kw):
        if "geocoding" in url:
            if "Nowhere" in url:
                return b'{"results": []}'
            return json.dumps({"results": [{"name": "Malibu", "admin1": "California", "country": "United States", "latitude": 34.0, "longitude": -118.7}]}).encode()
        assert "latitude=34.0" in url and "temperature_unit=fahrenheit" in url
        return json.dumps({
            "current": {"temperature_2m": 75, "apparent_temperature": 76, "weather_code": 1, "wind_speed_10m": 8, "relative_humidity_2m": 40},
            "daily": {"time": ["2026-11-06", "2026-11-07"], "weather_code": [0, 61], "temperature_2m_min": [58, 57],
                      "temperature_2m_max": [76, 70], "precipitation_probability_max": [0, 60]},
        }).encode()

    monkeypatch.setattr(http, "fetch", fake_fetch)
    out = weather.forecast("Malibu", 2, "imperial")
    assert out.splitlines()[0] == "Weather for Malibu, California, United States (source: Open-Meteo)"
    assert "Now: 75°F, feels like 76°F, mainly clear, wind 8 mph, humidity 40%" in out
    assert "2026-11-07: light rain, 57°F to 70°F, rain chance 60%" in out
    with pytest.raises(IntegrationError, match="Couldn't find"):
        weather.forecast("Nowhere")


async def test_automatic_backup_scheduler(tmp_path):
    from app.services import backup

    settings = Settings(data_dir=tmp_path, frontend_dist=None, _env_file=None, backup_interval_hours=24)
    (tmp_path / "jarvis.db").write_bytes(b"")
    import sqlite3

    sqlite3.connect(tmp_path / "jarvis.db").execute("create table t(x)").connection.commit()
    task = asyncio.create_task(backup.backup_scheduler(settings, check_every_seconds=0.05))
    await asyncio.sleep(0.3)
    task.cancel()
    assert len(backup.list_backups(settings)) == 1  # one backup, not one per check
    assert backup.latest_backup_age_hours(settings) < 0.01


async def test_browser_install_endpoint(auth_client):
    c = auth_client
    assert (await c.get("/api/browser/installed")).json() == {"installed": True}  # Chromium is present in this environment
    r = await c.post("/api/browser/install", params={"dry_run": True})
    assert r.status_code == 200 and "chromium" in r.json()["log"].lower()
    from app.core.security import hash_password
    from app.models import User

    async with c._transport.app.state.db.sessionmaker() as db:
        db.add(User(username="pepper", display_name="P", password_hash=hash_password(PASSWORD)))
        await db.commit()
    token = (await c.post("/api/auth/login", json={"username": "pepper", "password": PASSWORD})).json()["token"]
    r = await c.post("/api/browser/install", params={"dry_run": True}, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_python_executable_when_frozen(monkeypatch):
    import sys

    from app.tools.builtin import python_exec

    assert python_exec.python_executable() == sys.executable
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(python_exec.shutil, "which", lambda name: None)
    assert python_exec.python_executable() is None
    monkeypatch.setattr(python_exec.shutil, "which", lambda name: "/usr/bin/python3" if name == "python3" else None)
    assert python_exec.python_executable() == "/usr/bin/python3"


async def test_parent_watchdog():
    import subprocess
    import sys

    from app.core.watchdog import pid_alive, watch_parent

    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(0.3)"])
    assert pid_alive(proc.pid)
    # Reap the child as soon as it exits (in real use the watched process is our parent, not a child,
    # so it can't linger as an un-reaped zombie that still looks alive).
    reaper = asyncio.get_running_loop().run_in_executor(None, proc.wait)
    gone = asyncio.Event()
    await asyncio.wait_for(watch_parent(proc.pid, on_gone=gone.set, interval=0.05), 5)
    await reaper
    assert gone.is_set() and not pid_alive(proc.pid) and not pid_alive(0)
