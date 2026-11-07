"""Desktop app allow-list and browser status."""

import sys

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import AppSettings, CurrentUser, DbSession
from app.automation import desktop
from app.models import DesktopApp

router = APIRouter(prefix="/api", tags=["automation"])


class DesktopAppIn(BaseModel):
    name: str = Field(pattern=desktop.NAME_PATTERN)
    path: str = Field(min_length=1, max_length=1024)
    args: list[str] = Field(default_factory=list)
    allow_target: bool = False
    description: str = Field(default="", max_length=500)


class DesktopAppOut(BaseModel):
    id: str
    name: str
    path: str
    args: list[str]
    allow_target: bool
    description: str


class AutomationStatus(BaseModel):
    desktop_enabled: bool
    desktop_reason: str | None
    platform: str
    browser_enabled: bool
    browser_headless: bool
    browser_private_network: bool
    browser_open_url: str | None


def _out(app: DesktopApp) -> DesktopAppOut:
    return DesktopAppOut(id=app.id, name=app.name, path=app.path, args=list(app.args or []),
                         allow_target=app.allow_target, description=app.description)


@router.get("/automation/status", response_model=AutomationStatus)
async def automation_status(request: Request, user: CurrentUser, settings: AppSettings) -> AutomationStatus:
    reason = None
    if not settings.desktop_control_active:
        reason = ("Desktop control is off because the server isn't running on this computer's loopback address. "
                  "Set JARVIS_DESKTOP_CONTROL_ENABLED=true only if this server runs on the computer you want to control.")
    return AutomationStatus(
        desktop_enabled=settings.desktop_control_active,
        desktop_reason=reason,
        platform=sys.platform,
        browser_enabled=settings.browser_enabled,
        browser_headless=settings.browser_headless,
        browser_private_network=settings.browser_allow_private_network,
        browser_open_url=request.app.state.browser.current_url(user.id),
    )


@router.get("/browser/installed")
async def browser_installed(request: Request, user: CurrentUser) -> dict:
    return {"installed": await request.app.state.browser.installed()}


@router.post("/browser/install")
async def install_browser(request: Request, user: CurrentUser, db: DbSession, dry_run: bool = False) -> dict:
    """One-time browser download (~150 MB). Installing software is reserved for the owner account."""
    from app.api.integrations import is_owner
    from app.automation.browser import BrowserError

    if not await is_owner(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the owner account can install the browser.")
    try:
        output = await request.app.state.browser.install(dry_run=dry_run)
    except BrowserError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    return {"installed": dry_run or await request.app.state.browser.installed(), "log": output[-2000:]}


@router.post("/browser/close", status_code=status.HTTP_204_NO_CONTENT)
async def close_browser(request: Request, user: CurrentUser) -> None:
    await request.app.state.browser.close_session(user.id)


@router.get("/desktop/apps", response_model=list[DesktopAppOut])
async def list_apps(user: CurrentUser, db: DbSession):
    rows = (await db.execute(select(DesktopApp).where(DesktopApp.user_id == user.id).order_by(DesktopApp.name))).scalars()
    return [_out(a) for a in rows]


@router.post("/desktop/apps", response_model=DesktopAppOut, status_code=status.HTTP_201_CREATED)
async def add_app(body: DesktopAppIn, user: CurrentUser, db: DbSession):
    """Approve an app. Only the user can do this (there is no tool for it)."""
    try:
        path = desktop.validate_app_path(body.path)
        args = desktop.validate_args(body.args)
    except desktop.DesktopError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    exists = (await db.execute(select(DesktopApp).where(DesktopApp.user_id == user.id, DesktopApp.name == body.name.strip()))).scalar_one_or_none()
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "An app with that name already exists.")
    app = DesktopApp(user_id=user.id, name=body.name.strip(), path=str(path), args=args,
                     allow_target=body.allow_target, description=body.description.strip())
    db.add(app)
    await db.commit()
    return _out(app)


@router.delete("/desktop/apps/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_app(app_id: str, user: CurrentUser, db: DbSession) -> None:
    app = await db.get(DesktopApp, app_id)
    if app is None or app.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "App not found")
    await db.delete(app)
    await db.commit()
