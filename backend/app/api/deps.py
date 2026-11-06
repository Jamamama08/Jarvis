"""Shared FastAPI dependencies: DB session and authenticated user."""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import Settings
from app.core.security import hash_token
from app.models import AuthSession, User


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.db.sessionmaker() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db)]
AppSettings = Annotated[Settings, Depends(get_settings_dep)]


def _extract_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return None


async def get_current_session(request: Request, db: DbSession) -> AuthSession:
    token = _extract_token(request)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated", {"WWW-Authenticate": "Bearer"})
    result = await db.execute(
        select(AuthSession).options(selectinload(AuthSession.user)).where(AuthSession.token_hash == hash_token(token))
    )
    session = result.scalar_one_or_none()
    now = datetime.now(UTC)
    if session is None or session.expires_at <= now or not session.user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired or invalid", {"WWW-Authenticate": "Bearer"})
    # Throttle writes: only bump last_used_at once a minute.
    if now - session.last_used_at > timedelta(minutes=1):
        session.last_used_at = now
        await db.commit()
    return session


async def get_current_user(session: Annotated[AuthSession, Depends(get_current_session)]) -> User:
    return session.user


CurrentUser = Annotated[User, Depends(get_current_user)]
CurrentSession = Annotated[AuthSession, Depends(get_current_session)]
