"""Add soft-delete flags for exercises and workouts.

Revision ID: 0003_soft_delete_entities
Revises: 0002_effective_workout_exercises
Create Date: 2026-08-22
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_soft_delete_entities"
down_revision = "0002_effective_workout_exercises"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("exercise") as batch_op:
        batch_op.add_column(sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()))
    with op.batch_alter_table("workout") as batch_op:
        batch_op.add_column(sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("workout") as batch_op:
        batch_op.drop_column("is_active")
    with op.batch_alter_table("exercise") as batch_op:
        batch_op.drop_column("is_active")
