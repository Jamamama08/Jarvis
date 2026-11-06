"""autonomous tasks

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-06 22:15:54.394459
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0005'
down_revision: str | None = '0004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('api_usage', schema=None) as batch_op:
        batch_op.add_column(sa.Column('task_id', sa.String(length=32), nullable=True))
        batch_op.create_index(batch_op.f('ix_api_usage_task_id'), ['task_id'], unique=False)
        batch_op.create_foreign_key('fk_api_usage_task_id', 'tasks', ['task_id'], ['id'], ondelete='SET NULL')

    with op.batch_alter_table('tasks', schema=None) as batch_op:
        batch_op.add_column(sa.Column('kind', sa.String(length=16), server_default='todo', nullable=False))



def downgrade() -> None:
    with op.batch_alter_table('tasks', schema=None) as batch_op:
        batch_op.drop_column('kind')

    with op.batch_alter_table('api_usage', schema=None) as batch_op:
        # WARNING: constraint name is None; this directive will fail as
        # rendered.  Add a name, or use a naming convention; see
        # https://alembic.sqlalchemy.org/en/latest/naming.html
        batch_op.drop_constraint('fk_api_usage_task_id', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_api_usage_task_id'))
        batch_op.drop_column('task_id')

