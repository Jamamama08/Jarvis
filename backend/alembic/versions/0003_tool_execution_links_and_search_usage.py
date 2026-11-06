"""tool execution links and search usage

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-06 21:35:33.154024
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0003'
down_revision: str | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('api_usage', schema=None) as batch_op:
        batch_op.add_column(sa.Column('web_search_requests', sa.Integer(), server_default='0', nullable=False))

    with op.batch_alter_table('tool_executions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('message_id', sa.String(length=32), nullable=True))
        batch_op.add_column(sa.Column('tool_use_id', sa.String(length=100), nullable=True))
        batch_op.create_index(batch_op.f('ix_tool_executions_message_id'), ['message_id'], unique=False)
        batch_op.create_foreign_key('fk_tool_executions_message_id', 'messages', ['message_id'], ['id'], ondelete='CASCADE')



def downgrade() -> None:
    with op.batch_alter_table('tool_executions', schema=None) as batch_op:
        # WARNING: constraint name is None; this directive will fail as
        # rendered.  Add a name, or use a naming convention; see
        # https://alembic.sqlalchemy.org/en/latest/naming.html
        batch_op.drop_constraint('fk_tool_executions_message_id', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_tool_executions_message_id'))
        batch_op.drop_column('tool_use_id')
        batch_op.drop_column('message_id')

    with op.batch_alter_table('api_usage', schema=None) as batch_op:
        batch_op.drop_column('web_search_requests')

