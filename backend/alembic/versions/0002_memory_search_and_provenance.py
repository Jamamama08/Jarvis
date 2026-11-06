"""memory search and provenance

Adds memories.source / memories.last_used_at and an FTS5 full-text index over
memory content, kept in sync with triggers (external-content table keyed on
the memories rowid).

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FTS_STATEMENTS = [
    """
    CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 2'
    )
    """,
    """
    CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END
    """,
    """
    CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END
    """,
    """
    CREATE TRIGGER memories_fts_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END
    """,
    "INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')",
]


def upgrade() -> None:
    with op.batch_alter_table("memories", schema=None) as batch_op:
        batch_op.add_column(sa.Column("source", sa.String(length=16), server_default="user", nullable=False))
        batch_op.add_column(sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True))
    for statement in FTS_STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    for name in ("memories_fts_au", "memories_fts_ad", "memories_fts_ai"):
        op.execute(f"DROP TRIGGER IF EXISTS {name}")
    op.execute("DROP TABLE IF EXISTS memories_fts")
    with op.batch_alter_table("memories", schema=None) as batch_op:
        batch_op.drop_column("last_used_at")
        batch_op.drop_column("source")
