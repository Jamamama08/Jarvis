"""Async SQLAlchemy engine/session management."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import Settings


class Base(DeclarativeBase):
    pass


def _enable_sqlite_pragmas(dbapi_connection, _record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


class Database:
    def __init__(self, settings: Settings):
        url = settings.resolved_database_url
        if settings.sqlite_path:
            settings.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        self.engine: AsyncEngine = create_async_engine(url, future=True)
        if url.startswith("sqlite"):
            event.listen(self.engine.sync_engine, "connect", _enable_sqlite_pragmas)
        self.sessionmaker = async_sessionmaker(self.engine, expire_on_commit=False)

    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.sessionmaker() as session:
            yield session

    async def dispose(self) -> None:
        await self.engine.dispose()


@asynccontextmanager
async def shielded_session(sessionmaker: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    """A session whose close() finishes even if the surrounding task is cancelled (client
    disconnects), so connections return to the pool cleanly."""
    session = sessionmaker()
    try:
        yield session
    finally:
        with anyio.CancelScope(shield=True):
            await session.close()


async def safe_commit(session: AsyncSession) -> None:
    """Commit, shielded from cancellation: a commit interrupted half-way invalidates the session,
    which would make every later write in the same session (e.g. saving a cancelled reply) fail."""
    with anyio.CancelScope(shield=True):
        await session.commit()
