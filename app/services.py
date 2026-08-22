from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import Select, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.models import Exercise, ExerciseSettingsHistory, Workout, WorkoutExercise, WorkoutSession


class ValidationError(ValueError):
    """Raised when an operation would violate tracker business rules."""


def create_exercise(session: Session, name: str, muscle_group: str | None = None, equipment: str | None = None, description: str | None = None) -> Exercise:
    exercise = Exercise(exercise_name=name.strip(), muscle_group=muscle_group or None, equipment=equipment or None, description=description or None)
    session.add(exercise)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ValidationError("An exercise with that name already exists.") from exc
    return exercise


def update_exercise(session: Session, exercise: Exercise, name: str, muscle_group: str | None, equipment: str | None, description: str | None) -> None:
    exercise.exercise_name, exercise.muscle_group, exercise.equipment, exercise.description = name.strip(), muscle_group or None, equipment or None, description or None
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ValidationError("An exercise with that name already exists.") from exc


def create_workout(session: Session, name: str, description: str | None = None) -> Workout:
    workout = Workout(workout_name=name.strip(), description=description or None)
    session.add(workout)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ValidationError("A workout with that name already exists.") from exc
    return workout


def update_workout(session: Session, workout: Workout, name: str, description: str | None) -> None:
    workout.workout_name, workout.description = name.strip(), description or None
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ValidationError("A workout with that name already exists.") from exc


def add_exercise_to_workout(session: Session, workout: Workout, exercise: Exercise) -> None:
    if any(item.exercise_id == exercise.exercise_id for item in workout.exercises):
        raise ValidationError("That exercise is already in this workout.")
    workout.exercises.append(WorkoutExercise(exercise=exercise, exercise_order=len(workout.exercises) + 1))
    session.commit()


def remove_exercise_from_workout(session: Session, workout: Workout, exercise_id: int) -> None:
    item = next((row for row in workout.exercises if row.exercise_id == exercise_id), None)
    if not item:
        return
    workout.exercises.remove(item)
    for order, row in enumerate(workout.exercises, start=1):
        row.exercise_order = order
    session.commit()


def move_workout_exercise(session: Session, workout: Workout, exercise_id: int, direction: int) -> None:
    items = sorted(workout.exercises, key=lambda row: row.exercise_order)
    index = next((i for i, row in enumerate(items) if row.exercise_id == exercise_id), None)
    if index is None or not 0 <= index + direction < len(items):
        return
    items[index], items[index + direction] = items[index + direction], items[index]
    # Two phase values avoid the uniqueness constraint while swapping.
    for i, row in enumerate(items, start=1001):
        row.exercise_order = i
    session.flush()
    for i, row in enumerate(items, start=1):
        row.exercise_order = i
    session.commit()


def state_for_date(session: Session, exercise_id: int, on_date: date) -> ExerciseSettingsHistory | None:
    return session.scalar(select(ExerciseSettingsHistory).where(
        ExerciseSettingsHistory.exercise_id == exercise_id,
        ExerciseSettingsHistory.effective_from <= on_date,
        (ExerciseSettingsHistory.effective_to.is_(None)) | (ExerciseSettingsHistory.effective_to > on_date),
    ).order_by(ExerciseSettingsHistory.effective_from.desc()))


def set_exercise_state(session: Session, exercise_id: int, effective_from: date, weight: Decimal | float | str, max_reps: int, sets: int, notes: str | None = None) -> ExerciseSettingsHistory:
    """Insert a state change, splitting the period that covers its start date.

    Existing history is never overwritten; a same-date correction is rejected so it
    can be explicitly handled later rather than silently losing audit information.
    """
    weight = Decimal(str(weight))
    if weight < 0 or max_reps <= 0 or sets <= 0:
        raise ValidationError("Weight must be non-negative; reps and sets must be positive.")
    with session.begin_nested():
        exists = session.scalar(select(ExerciseSettingsHistory.exercise_settings_id).where(
            ExerciseSettingsHistory.exercise_id == exercise_id,
            ExerciseSettingsHistory.effective_from == effective_from,
        ))
        if exists:
            raise ValidationError("A state change already starts on this date. Historical rows are not overwritten.")
        covering = state_for_date(session, exercise_id, effective_from)
        if covering:
            inherited_end = covering.effective_to
            covering.effective_to = effective_from
        else:
            # A new state in a gap (including before the first future state) ends
            # at the next known change, so it cannot overlap that later period.
            next_state = session.scalar(select(ExerciseSettingsHistory).where(
                ExerciseSettingsHistory.exercise_id == exercise_id,
                ExerciseSettingsHistory.effective_from > effective_from,
            ).order_by(ExerciseSettingsHistory.effective_from))
            inherited_end = next_state.effective_from if next_state else None
        new_state = ExerciseSettingsHistory(exercise_id=exercise_id, effective_from=effective_from, effective_to=inherited_end, weight=weight, max_reps=max_reps, sets=sets, notes=notes or None)
        session.add(new_state)
        session.flush()
    session.commit()
    return new_state


def log_workout(session: Session, workout_id: int, workout_date: date, notes: str | None = None) -> WorkoutSession:
    record = WorkoutSession(workout_id=workout_id, workout_date=workout_date, notes=notes or None)
    session.add(record)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ValidationError("This workout is already logged on that date.") from exc
    return record


def workouts(session: Session) -> list[Workout]:
    return list(session.scalars(select(Workout).options(joinedload(Workout.exercises).joinedload(WorkoutExercise.exercise)).order_by(Workout.workout_name)).unique())


def exercises(session: Session) -> list[Exercise]:
    return list(session.scalars(select(Exercise).order_by(Exercise.exercise_name)))


def recent_sessions(session: Session, limit: int = 12) -> list[WorkoutSession]:
    return list(session.scalars(select(WorkoutSession).options(joinedload(WorkoutSession.workout)).order_by(WorkoutSession.workout_date.desc(), WorkoutSession.workout_session_id.desc()).limit(limit)))


def session_details(session: Session, workout_session_id: int) -> tuple[WorkoutSession, list[tuple[Exercise, ExerciseSettingsHistory | None]]]:
    record = session.scalar(select(WorkoutSession).options(joinedload(WorkoutSession.workout).joinedload(Workout.exercises).joinedload(WorkoutExercise.exercise)).where(WorkoutSession.workout_session_id == workout_session_id))
    if not record:
        raise ValidationError("Workout session not found.")
    details = [(item.exercise, state_for_date(session, item.exercise_id, record.workout_date)) for item in sorted(record.workout.exercises, key=lambda item: item.exercise_order)]
    return record, details
