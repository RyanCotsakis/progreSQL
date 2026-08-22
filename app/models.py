from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp(), onupdate=func.current_timestamp(), nullable=False)


class Exercise(TimestampMixin, Base):
    __tablename__ = "exercise"
    exercise_id: Mapped[int] = mapped_column(primary_key=True)
    exercise_name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    muscle_group: Mapped[Optional[str]] = mapped_column(String(80))
    equipment: Mapped[Optional[str]] = mapped_column(String(80))
    description: Mapped[Optional[str]] = mapped_column(Text)
    settings_history: Mapped[list["ExerciseSettingsHistory"]] = relationship(back_populates="exercise", cascade="all, delete-orphan")


class Workout(TimestampMixin, Base):
    __tablename__ = "workout"
    workout_id: Mapped[int] = mapped_column(primary_key=True)
    workout_name: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    exercises: Mapped[list["WorkoutExercise"]] = relationship(back_populates="workout", cascade="all, delete-orphan", order_by="WorkoutExercise.effective_from, WorkoutExercise.exercise_order")
    sessions: Mapped[list["WorkoutSession"]] = relationship(back_populates="workout")


class WorkoutExercise(Base):
    __tablename__ = "workout_exercise"
    workout_exercise_id: Mapped[int] = mapped_column(primary_key=True)
    workout_id: Mapped[int] = mapped_column(ForeignKey("workout.workout_id", ondelete="CASCADE"), nullable=False)
    exercise_id: Mapped[int] = mapped_column(ForeignKey("exercise.exercise_id", ondelete="RESTRICT"), nullable=False)
    exercise_order: Mapped[int] = mapped_column(Integer, nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[Optional[date]] = mapped_column(Date)
    workout: Mapped[Workout] = relationship(back_populates="exercises")
    exercise: Mapped[Exercise] = relationship()
    __table_args__ = (
        UniqueConstraint("workout_id", "exercise_id", "effective_from", name="uq_workout_exercise_start"),
        UniqueConstraint("workout_id", "exercise_order", "effective_from", name="uq_workout_exercise_order_start"),
        CheckConstraint("exercise_order > 0", name="ck_exercise_order_positive"),
        CheckConstraint("effective_to IS NULL OR effective_to > effective_from", name="ck_workout_exercise_valid_period"),
        Index("ix_workout_exercise_period", "workout_id", "effective_from", "effective_to"),
    )


class WorkoutSession(Base):
    __tablename__ = "workout_session"
    workout_session_id: Mapped[int] = mapped_column(primary_key=True)
    workout_id: Mapped[int] = mapped_column(ForeignKey("workout.workout_id", ondelete="RESTRICT"), nullable=False)
    workout_date: Mapped[date] = mapped_column(Date, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp(), nullable=False)
    workout: Mapped[Workout] = relationship(back_populates="sessions")
    __table_args__ = (UniqueConstraint("workout_id", "workout_date", name="uq_workout_session_date"), Index("ix_workout_session_date", "workout_date"))


class ExerciseSettingsHistory(Base):
    __tablename__ = "exercise_settings_history"
    exercise_settings_id: Mapped[int] = mapped_column(primary_key=True)
    exercise_id: Mapped[int] = mapped_column(ForeignKey("exercise.exercise_id", ondelete="RESTRICT"), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[Optional[date]] = mapped_column(Date)
    weight: Mapped[Decimal] = mapped_column(Numeric(7, 2), nullable=False)
    max_reps: Mapped[int] = mapped_column(Integer, nullable=False)
    sets: Mapped[int] = mapped_column(Integer, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.current_timestamp(), nullable=False)
    exercise: Mapped[Exercise] = relationship(back_populates="settings_history")
    __table_args__ = (
        UniqueConstraint("exercise_id", "effective_from", name="uq_exercise_settings_start"),
        CheckConstraint("weight >= 0", name="ck_settings_weight_nonnegative"),
        CheckConstraint("max_reps > 0", name="ck_settings_reps_positive"),
        CheckConstraint("sets > 0", name="ck_settings_sets_positive"),
        CheckConstraint("effective_to IS NULL OR effective_to > effective_from", name="ck_settings_valid_period"),
        Index("ix_settings_exercise_period", "exercise_id", "effective_from", "effective_to"),
    )
