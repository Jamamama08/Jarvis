"""Health, settings, and maintenance endpoints."""

from fastapi import APIRouter, Request
from sqlalchemy import text

from app import __version__
from app.api.deps import AppSettings, CurrentUser, DbSession
from app.schemas import BackupOut, ServerInfo, SettingsOut, UserPreferences, UserPreferencesUpdate
from app.services.backup import create_backup, list_backups
from app.services.preferences import load_preferences, update_preferences

CURRENT_PHASE = 1

router = APIRouter(prefix="/api", tags=["system"])


def _server_info(request: Request) -> ServerInfo:
    settings = request.app.state.settings
    provider = request.app.state.provider
    return ServerInfo(
        version=__version__,
        phase=CURRENT_PHASE,
        ai_provider="claude" if provider.name == "claude" else "unconfigured",
        ai_configured=provider.configured,
        default_model=settings.default_model,
        default_max_output_tokens=settings.max_output_tokens,
    )


@router.get("/health")
async def health(db: DbSession) -> dict:
    """Unauthenticated liveness check. Reveals no user data."""
    await db.execute(text("SELECT 1"))
    return {"status": "ok", "version": __version__}


@router.get("/settings", response_model=SettingsOut)
async def get_settings(request: Request, user: CurrentUser, db: DbSession) -> SettingsOut:
    return SettingsOut(preferences=await load_preferences(db, user.id), server=_server_info(request))


@router.patch("/settings", response_model=UserPreferences)
async def patch_settings(body: UserPreferencesUpdate, user: CurrentUser, db: DbSession) -> UserPreferences:
    return await update_preferences(db, user.id, body)


@router.get("/system/backups", response_model=list[BackupOut])
async def get_backups(user: CurrentUser, settings: AppSettings) -> list[BackupOut]:
    return list_backups(settings)


@router.post("/system/backups", response_model=BackupOut, status_code=201)
async def post_backup(user: CurrentUser, settings: AppSettings) -> BackupOut:
    return await create_backup(settings)
