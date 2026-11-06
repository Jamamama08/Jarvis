"""Health, settings, and maintenance endpoints."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query, Request
from sqlalchemy import func, select, text

from app import __version__
from app.api.deps import AppSettings, CurrentUser, DbSession
from app.models import ApiUsage
from app.schemas import (
    BackupOut,
    ModelOption,
    ServerInfo,
    SettingsOut,
    UsageRow,
    UsageSummary,
    UserPreferences,
    UserPreferencesUpdate,
)
from app.services.backup import create_backup, list_backups
from app.services.models_catalog import MODELS, estimate_cost
from app.services.preferences import load_preferences, update_preferences

CURRENT_PHASE = 2

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
        refusal_fallback=settings.refusal_fallback,
        models=[
            ModelOption(
                id=m.id,
                label=m.label,
                description=m.description,
                input_per_mtok=m.input_per_mtok,
                output_per_mtok=m.output_per_mtok,
            )
            for m in MODELS
        ],
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


@router.get("/usage", response_model=UsageSummary)
async def usage(user: CurrentUser, db: DbSession, days: int = Query(default=30, ge=1, le=3650)) -> UsageSummary:
    """Token usage recorded for this user's Claude requests, with estimated cost."""
    since = datetime.now(UTC) - timedelta(days=days)
    rows = (
        await db.execute(
            select(
                ApiUsage.model,
                func.count(ApiUsage.id),
                func.sum(ApiUsage.input_tokens),
                func.sum(ApiUsage.output_tokens),
                func.sum(ApiUsage.cache_read_tokens),
                func.sum(ApiUsage.cache_write_tokens),
            )
            .where(ApiUsage.user_id == user.id, ApiUsage.created_at >= since)
            .group_by(ApiUsage.model)
            .order_by(ApiUsage.model)
        )
    ).all()
    by_model = [
        UsageRow(
            model=model,
            requests=n,
            input_tokens=i or 0,
            output_tokens=o or 0,
            cache_read_tokens=cr or 0,
            cache_write_tokens=cw or 0,
            estimated_cost_usd=estimate_cost(model, i or 0, o or 0, cr or 0, cw or 0),
        )
        for model, n, i, o, cr, cw in rows
    ]
    costs = [r.estimated_cost_usd for r in by_model]
    totals = UsageRow(
        model="all",
        requests=sum(r.requests for r in by_model),
        input_tokens=sum(r.input_tokens for r in by_model),
        output_tokens=sum(r.output_tokens for r in by_model),
        cache_read_tokens=sum(r.cache_read_tokens for r in by_model),
        cache_write_tokens=sum(r.cache_write_tokens for r in by_model),
        estimated_cost_usd=None if any(c is None for c in costs) else round(sum(costs), 6),
    )
    return UsageSummary(days=days, totals=totals, by_model=by_model)
