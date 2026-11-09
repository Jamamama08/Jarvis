"""visual lessons

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-09 01:45:39.340485
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0006'
down_revision: str | None = '0005'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('lessons',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('user_id', sa.String(length=32), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('source_name', sa.String(length=255), nullable=False),
    sa.Column('source_kind', sa.String(length=16), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('level', sa.String(length=16), nullable=False),
    sa.Column('slides', sa.JSON(), nullable=False),
    sa.Column('overview', sa.JSON(), nullable=False),
    sa.Column('scenes', sa.JSON(), nullable=False),
    sa.Column('progress', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('lessons', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_lessons_user_id'), ['user_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('lessons', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_lessons_user_id'))

    op.drop_table('lessons')
