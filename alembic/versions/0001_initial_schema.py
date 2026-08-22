"""Initial gym tracker schema.

Revision ID: 0001_initial
Revises:
Create Date: 2026-08-22
"""
from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("exercise",
        sa.Column("exercise_id", sa.Integer(), primary_key=True),
        sa.Column("exercise_name", sa.String(120), nullable=False, unique=True),
        sa.Column("muscle_group", sa.String(80)), sa.Column("equipment", sa.String(80)), sa.Column("description", sa.Text()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False))
    op.create_table("workout",
        sa.Column("workout_id", sa.Integer(), primary_key=True), sa.Column("workout_name", sa.String(120), nullable=False, unique=True), sa.Column("description", sa.Text()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False), sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False))
    op.create_table("workout_exercise",
        sa.Column("workout_id", sa.Integer(), sa.ForeignKey("workout.workout_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("exercise_id", sa.Integer(), sa.ForeignKey("exercise.exercise_id", ondelete="RESTRICT"), primary_key=True), sa.Column("exercise_order", sa.Integer(), nullable=False),
        sa.CheckConstraint("exercise_order > 0", name="ck_exercise_order_positive"),
        sa.UniqueConstraint("workout_id", "exercise_order", name="uq_workout_exercise_order"))
    op.create_table("workout_session",
        sa.Column("workout_session_id", sa.Integer(), primary_key=True), sa.Column("workout_id", sa.Integer(), sa.ForeignKey("workout.workout_id", ondelete="RESTRICT"), nullable=False),
        sa.Column("workout_date", sa.Date(), nullable=False), sa.Column("notes", sa.Text()), sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.UniqueConstraint("workout_id", "workout_date", name="uq_workout_session_date"))
    op.create_index("ix_workout_session_date", "workout_session", ["workout_date"])
    op.create_table("exercise_settings_history",
        sa.Column("exercise_settings_id", sa.Integer(), primary_key=True), sa.Column("exercise_id", sa.Integer(), sa.ForeignKey("exercise.exercise_id", ondelete="RESTRICT"), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False), sa.Column("effective_to", sa.Date()), sa.Column("weight", sa.Numeric(7, 2), nullable=False), sa.Column("max_reps", sa.Integer(), nullable=False), sa.Column("sets", sa.Integer(), nullable=False), sa.Column("notes", sa.Text()), sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.CheckConstraint("weight >= 0", name="ck_settings_weight_nonnegative"), sa.CheckConstraint("max_reps > 0", name="ck_settings_reps_positive"), sa.CheckConstraint("sets > 0", name="ck_settings_sets_positive"), sa.CheckConstraint("effective_to IS NULL OR effective_to > effective_from", name="ck_settings_valid_period"), sa.UniqueConstraint("exercise_id", "effective_from", name="uq_exercise_settings_start"))
    op.create_index("ix_settings_exercise_period", "exercise_settings_history", ["exercise_id", "effective_from", "effective_to"])


def downgrade() -> None:
    op.drop_index("ix_settings_exercise_period", table_name="exercise_settings_history")
    op.drop_table("exercise_settings_history")
    op.drop_index("ix_workout_session_date", table_name="workout_session")
    op.drop_table("workout_session")
    op.drop_table("workout_exercise")
    op.drop_table("workout")
    op.drop_table("exercise")
