"""User preferences stored as key/value rows in app_settings."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AppSetting
from app.schemas import UserPreferences, UserPreferencesUpdate

_PREFIX = "pref."


async def load_preferences(db: AsyncSession, user_id: str) -> UserPreferences:
    rows = (
        await db.execute(select(AppSetting).where(AppSetting.user_id == user_id, AppSetting.key.like(f"{_PREFIX}%")))
    ).scalars()
    stored = {row.key.removeprefix(_PREFIX): row.value for row in rows}
    known = {k: v for k, v in stored.items() if k in UserPreferences.model_fields}
    try:
        return UserPreferences(**known)
    except ValueError:
        # A stored value became invalid (e.g. limits changed); fall back per-field.
        prefs = UserPreferences()
        for key, value in known.items():
            try:
                prefs = UserPreferences(**{**prefs.model_dump(), key: value})
            except ValueError:
                continue
        return prefs


async def update_preferences(db: AsyncSession, user_id: str, update: UserPreferencesUpdate) -> UserPreferences:
    changes = update.model_dump(exclude_unset=True, exclude_none=True)
    if changes:
        existing = {
            row.key: row
            for row in (
                await db.execute(
                    select(AppSetting).where(
                        AppSetting.user_id == user_id, AppSetting.key.in_([_PREFIX + k for k in changes])
                    )
                )
            ).scalars()
        }
        for key, value in changes.items():
            row = existing.get(_PREFIX + key)
            if row is None:
                db.add(AppSetting(user_id=user_id, key=_PREFIX + key, value=value))
            else:
                row.value = value
        await db.commit()
    return await load_preferences(db, user_id)
