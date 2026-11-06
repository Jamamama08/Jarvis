"""Consistent online SQLite backups using the sqlite3 backup API."""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import anyio
from fastapi import HTTPException

from app.core.config import Settings
from app.schemas import BackupOut

KEEP_BACKUPS = 20


def backup_dir(settings: Settings) -> Path:
    return settings.data_dir / "backups"


def _describe(path: Path) -> BackupOut:
    stat = path.stat()
    return BackupOut(
        filename=path.name, size_bytes=stat.st_size, created_at=datetime.fromtimestamp(stat.st_mtime, UTC)
    )


def backup_sync(source: Path, dest_dir: Path, keep: int = KEEP_BACKUPS) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S-%f")
    dest = dest_dir / f"jarvis-{stamp}.db"
    src = sqlite3.connect(source)
    try:
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    # Retention: keep the newest `keep` backups.
    backups = sorted(dest_dir.glob("jarvis-*.db"))
    for old in backups[:-keep]:
        old.unlink(missing_ok=True)
    return dest


async def create_backup(settings: Settings) -> BackupOut:
    if settings.sqlite_path is None or not settings.sqlite_path.exists():
        raise HTTPException(400, "Backups are only supported for file-based SQLite databases")
    dest = await anyio.to_thread.run_sync(backup_sync, settings.sqlite_path, backup_dir(settings))
    return _describe(dest)


def list_backups(settings: Settings) -> list[BackupOut]:
    directory = backup_dir(settings)
    if not directory.exists():
        return []
    return [_describe(p) for p in sorted(directory.glob("jarvis-*.db"), reverse=True)]
