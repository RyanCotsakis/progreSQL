"""Make workout membership and order effective dated.

Revision ID: 0002_effective_workout_exercises
Revises: 0001_initial
Create Date: 2026-08-22
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_effective_workout_exercises"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workout_exercise_new",
        sa.Column("workout_exercise_id", sa.Integer(), primary_key=True),
        sa.Column("workout_id", sa.Integer(), sa.ForeignKey("workout.workout_id", ondelete="CASCADE"), nullable=False),
        sa.Column("exercise_id", sa.Integer(), sa.ForeignKey("exercise.exercise_id", ondelete="RESTRICT"), nullable=False),
        sa.Column("exercise_order", sa.Integer(), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("effective_to", sa.Date()),
        sa.CheckConstraint("exercise_order > 0", name="ck_exercise_order_positive"),
        sa.CheckConstraint("effective_to IS NULL OR effective_to > effective_from", name="ck_workout_exercise_valid_period"),
        sa.UniqueConstraint("workout_id", "exercise_id", "effective_from", name="uq_workout_exercise_start"),
        sa.UniqueConstraint("workout_id", "exercise_order", "effective_from", name="uq_workout_exercise_order_start"),
    )
    op.execute("""INSERT INTO workout_exercise_new
        (workout_id, exercise_id, exercise_order, effective_from, effective_to)
        SELECT workout_id, exercise_id, exercise_order, '1900-01-01', NULL FROM workout_exercise""")
    op.drop_table("workout_exercise")
    op.rename_table("workout_exercise_new", "workout_exercise")
    op.create_index("ix_workout_exercise_period", "workout_exercise", ["workout_id", "effective_from", "effective_to"])


def downgrade() -> None:
    op.drop_index("ix_workout_exercise_period", table_name="workout_exercise")
    op.create_table(
        "workout_exercise_old",
        sa.Column("workout_id", sa.Integer(), sa.ForeignKey("workout.workout_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("exercise_id", sa.Integer(), sa.ForeignKey("exercise.exercise_id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("exercise_order", sa.Integer(), nullable=False),
        sa.CheckConstraint("exercise_order > 0", name="ck_exercise_order_positive"),
        sa.UniqueConstraint("workout_id", "exercise_order", name="uq_workout_exercise_order"),
    )
    op.execute("""INSERT INTO workout_exercise_old (workout_id, exercise_id, exercise_order)
        SELECT workout_id, exercise_id, exercise_order FROM workout_exercise WHERE effective_to IS NULL""")
    op.drop_table("workout_exercise")
    op.rename_table("workout_exercise_old", "workout_exercise")
