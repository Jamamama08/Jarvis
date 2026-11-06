"""Run Alembic migrations programmatically (used at startup and in tests)."""

from pathlib import Path

from alembic import command
from alembic.config import Config

BACKEND_DIR = Path(__file__).resolve().parents[1]


def alembic_config(database_url: str) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", sync_url(database_url))
    cfg.attributes["configure_logger"] = False
    return cfg


def sync_url(url: str) -> str:
    return url.replace("+aiosqlite", "")


def include_name(name, type_, parent_names) -> bool:
    """Alembic filter: skip FTS5 virtual/shadow tables, which migrations manage with raw SQL."""
    return not (type_ == "table" and name and name.startswith("memories_fts"))


def upgrade_to_head(database_url: str) -> None:
    command.upgrade(alembic_config(database_url), "head")
