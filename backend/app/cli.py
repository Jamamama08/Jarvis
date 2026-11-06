"""Maintenance CLI: `python -m app.cli migrate|backup|create-user`."""

import argparse
import asyncio
import getpass
import sys

from app.core.config import get_settings
from app.migrations import upgrade_to_head
from app.services.backup import backup_dir, backup_sync


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate", help="Apply database migrations")
    sub.add_parser("backup", help="Create a consistent backup of the SQLite database")
    sub.add_parser("reset-password", help="Reset a user's password (local recovery)").add_argument("username")
    args = parser.parse_args(argv)
    settings = get_settings()

    if args.cmd == "migrate":
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        upgrade_to_head(settings.resolved_database_url)
        print("Database is up to date.")
    elif args.cmd == "backup":
        if not settings.sqlite_path or not settings.sqlite_path.exists():
            print("No SQLite database found.", file=sys.stderr)
            return 1
        print(f"Backup written to {backup_sync(settings.sqlite_path, backup_dir(settings))}")
    elif args.cmd == "reset-password":
        return asyncio.run(_reset_password(args.username, settings))
    return 0


async def _reset_password(username: str, settings) -> int:
    from sqlalchemy import delete, select

    from app.core.db import Database
    from app.core.security import hash_password
    from app.models import AuthSession, User

    password = getpass.getpass("New password: ")
    if len(password) < settings.min_password_length or password != getpass.getpass("Confirm: "):
        print(f"Passwords must match and be at least {settings.min_password_length} characters.", file=sys.stderr)
        return 1
    db = Database(settings)
    try:
        async with db.sessionmaker() as s:
            user = (await s.execute(select(User).where(User.username == username.lower()))).scalar_one_or_none()
            if not user:
                print("No such user.", file=sys.stderr)
                return 1
            user.password_hash = hash_password(password)
            await s.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
            await s.commit()
    finally:
        await db.dispose()
    print("Password updated; all sessions revoked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
