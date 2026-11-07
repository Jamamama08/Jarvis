"""Connections: the Claude API key and the user's email, calendar and notification settings.

Secrets are written to the server-side secret store and never returned: responses
only say whether something is configured, plus non-secret details (host, username).
"""

from typing import Literal

import anthropic
import anyio
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.integrations import calendar, email, notify
from app.integrations.http import IntegrationError
from app.models import User
from app.services.providers import api_key_source, build_provider

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


async def is_owner(db, user: User) -> bool:
    """The first account created on this server is the owner (manages server-wide settings)."""
    first = (await db.execute(select(User.id).order_by(User.created_at, User.id).limit(1))).scalar_one_or_none()
    return first == user.id


def install_provider(request: Request) -> None:
    """Rebuild the Claude provider after the key changes; takes effect for new messages and tasks."""
    app = request.app
    provider = build_provider(app.state.settings, app.state.secrets.get("anthropic_api_key"))
    app.state.provider = provider
    runner = getattr(app.state, "task_runner", None)
    if runner is not None:
        runner.provider = provider


class Status(BaseModel):
    anthropic: dict
    email: dict
    calendar: dict
    notifications: dict
    weather: dict


@router.get("", response_model=Status)
async def status_(request: Request, user: CurrentUser, db: DbSession) -> Status:
    store = request.app.state.secrets
    mine = store.user(user.id)
    source = api_key_source(request.app.state.settings, store.get("anthropic_api_key"))
    em = mine.get("email") or {}
    return Status(
        anthropic={"configured": source is not None, "source": source, "editable": await is_owner(db, user) and source != "env"},
        email={"configured": bool(em), "username": em.get("username"), "imap_host": em.get("imap_host"),
               "smtp_host": em.get("smtp_host"), "imap_port": em.get("imap_port"), "smtp_port": em.get("smtp_port"),
               "imap_security": em.get("imap_security"), "smtp_security": em.get("smtp_security"), "from_address": em.get("from_address")},
        calendar={"configured": bool((mine.get("calendar") or {}).get("url"))},
        notifications={"configured": bool((mine.get("notifications") or {}).get("url")),
                       "kind": notify.kind((mine.get("notifications") or {}).get("url", "")) if mine.get("notifications") else None},
        weather={"configured": True, "provider": "Open-Meteo (free, no key)"},
    )


# --- Claude API key -----------------------------------------------------------------------


class KeyBody(BaseModel):
    api_key: str = Field(min_length=20, max_length=300)


@router.put("/anthropic", status_code=status.HTTP_204_NO_CONTENT)
async def set_key(body: KeyBody, request: Request, user: CurrentUser, db: DbSession) -> None:
    if not await is_owner(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner account can change the Claude API key.")
    if api_key_source(request.app.state.settings, None) == "env":
        raise HTTPException(status.HTTP_409_CONFLICT, "The key is set in the server's .env file; change it there.")
    key = body.api_key.strip()
    client = request.app.state.key_check_client(key)
    try:
        await client.models.list(limit=1)  # free call: proves the key works
    except anthropic.AuthenticationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Anthropic rejected this key.") from exc
    except anthropic.APIError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Couldn't reach Anthropic to check the key. Try again.") from exc
    request.app.state.secrets.set("anthropic_api_key", key)
    install_provider(request)


@router.delete("/anthropic", status_code=status.HTTP_204_NO_CONTENT)
async def remove_key(request: Request, user: CurrentUser, db: DbSession) -> None:
    if not await is_owner(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner account can change the Claude API key.")
    request.app.state.secrets.set("anthropic_api_key", None)
    install_provider(request)


# --- Email --------------------------------------------------------------------------------


class EmailBody(BaseModel):
    username: str = Field(min_length=3, max_length=300)
    password: str | None = Field(default=None, max_length=300, description="Omit to keep the stored password.")
    imap_host: str = Field(min_length=3, max_length=255, pattern=r"^[A-Za-z0-9.\-]+$")
    imap_port: int = Field(default=993, ge=1, le=65535)
    imap_security: Literal["ssl", "starttls", "none"] = "ssl"
    smtp_host: str = Field(min_length=3, max_length=255, pattern=r"^[A-Za-z0-9.\-]+$")
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_security: Literal["starttls", "ssl", "none"] = "starttls"
    from_address: str = Field(default="", max_length=300)


async def _check(fn, *args) -> str:
    try:
        return await anyio.to_thread.run_sync(fn, *args)
    except IntegrationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


@router.put("/email", status_code=status.HTTP_204_NO_CONTENT)
async def set_email(body: EmailBody, request: Request, user: CurrentUser) -> None:
    store = request.app.state.secrets
    existing = store.user(user.id).get("email") or {}
    data = body.model_dump()
    data["password"] = body.password if body.password is not None else existing.get("password")
    if not data["password"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter the (app) password.")
    store.update_user(user.id, "email", data)


@router.post("/email/test")
async def test_email(request: Request, user: CurrentUser) -> dict:
    cfg = request.app.state.secrets.user(user.id).get("email")
    if not cfg:
        raise HTTPException(status.HTTP_409_CONFLICT, "Email isn't set up.")
    return {"message": await _check(email.test, email.EmailConfig.from_dict(cfg))}


# --- Calendar & notifications ---------------------------------------------------------------


class UrlBody(BaseModel):
    url: str = Field(min_length=10, max_length=2000)


@router.put("/calendar", status_code=status.HTTP_204_NO_CONTENT)
async def set_calendar(body: UrlBody, request: Request, user: CurrentUser) -> None:
    try:
        from app.integrations.http import require_http

        url = require_http(body.url)
    except IntegrationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    request.app.state.secrets.update_user(user.id, "calendar", {"url": url})


@router.post("/calendar/test")
async def test_calendar(request: Request, user: CurrentUser) -> dict:
    cfg = request.app.state.secrets.user(user.id).get("calendar")
    if not cfg:
        raise HTTPException(status.HTTP_409_CONFLICT, "The calendar isn't set up.")
    start, end = calendar.window(7)

    def run() -> str:
        found = calendar.events(cfg["url"], start, end)
        return f"Connected. {len(found)} event(s) in the next 7 days."

    return {"message": await _check(run)}


@router.put("/notifications", status_code=status.HTTP_204_NO_CONTENT)
async def set_notifications(body: UrlBody, request: Request, user: CurrentUser) -> None:
    try:
        from app.integrations.http import require_http

        url = require_http(body.url)
    except IntegrationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    request.app.state.secrets.update_user(user.id, "notifications", {"url": url})


@router.post("/notifications/test")
async def test_notifications(request: Request, user: CurrentUser) -> dict:
    cfg = request.app.state.secrets.user(user.id).get("notifications")
    if not cfg:
        raise HTTPException(status.HTTP_409_CONFLICT, "Notifications aren't set up.")
    kind = await _check(notify.send, cfg["url"], "JARVIS", "Test notification: it works.")
    return {"message": f"Sent a test notification ({kind})."}


@router.delete("/{section}", status_code=status.HTTP_204_NO_CONTENT)
async def remove(section: Literal["email", "calendar", "notifications"], request: Request, user: CurrentUser) -> None:
    request.app.state.secrets.update_user(user.id, section, None)
