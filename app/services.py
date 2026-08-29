from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
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


def create_exercise_with_initial_state(session: Session, name: str, muscle_group: str | None, equipment: str | None, description: str | None, effective_from: date, weight: Decimal | float | str, max_reps: int, sets: int, notes: str | None = None) -> Exercise:
    """Create an exercise and its first prescription in one transaction."""
    weight = Decimal(str(weight))
    if weight < 0 or max_reps <= 0 or sets <= 0:
        raise ValidationError("Weight must be non-negative; reps and sets must be positive.")
    exercise = Exercise(exercise_name=name.strip(), muscle_group=muscle_group or None, equipment=equipment or None, description=description or None)
    session.add(exercise)
    try:
        session.flush()
        session.add(ExerciseSettingsHistory(
            exercise_id=exercise.exercise_id,
            effective_from=effective_from,
            weight=weight,
            max_reps=max_reps,
            sets=sets,
            notes=notes or None,
        ))
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


def deactivate_exercise(session: Session, exercise: Exercise) -> None:
    active_workouts = list(session.scalars(
        select(Workout.workout_name).distinct()
        .join(WorkoutExercise, WorkoutExercise.workout_id == Workout.workout_id)
        .where(
            WorkoutExercise.exercise_id == exercise.exercise_id,
            WorkoutExercise.effective_to.is_(None),
            Workout.is_active.is_(True),
        )
        .order_by(Workout.workout_name)
    ))
    if active_workouts:
        raise ValidationError(
            "Cannot delete this exercise because it is still active in: "
            + ", ".join(active_workouts)
            + ". Remove it from those workouts or delete the workouts first."
        )
    exercise.is_active = False
    session.commit()


def deactivate_workout(session: Session, workout: Workout) -> None:
    workout.is_active = False
    session.commit()


def workout_exercises_for_date(session: Session, workout_id: int, on_date: date) -> list[WorkoutExercise]:
    """Return the workout composition in force on a date, in display order."""
    return list(session.scalars(select(WorkoutExercise).options(joinedload(WorkoutExercise.exercise)).where(
        WorkoutExercise.workout_id == workout_id,
        WorkoutExercise.effective_from <= on_date,
        (WorkoutExercise.effective_to.is_(None)) | (WorkoutExercise.effective_to > on_date),
    ).order_by(WorkoutExercise.exercise_order)))


def set_workout_exercises(session: Session, workout: Workout, exercise_ids: list[int], effective_from: date) -> None:
    """Replace a workout's complete exercise/order snapshot from a chosen date.

    A session resolves this snapshot by its workout date. Replacing a snapshot on
    the same date deliberately updates that day's view, including any session
    already logged for the day.
    """
    if len(exercise_ids) != len(set(exercise_ids)):
        raise ValidationError("Select each exercise only once.")
    current = workout_exercises_for_date(session, workout.workout_id, effective_from)
    next_change = session.scalar(select(WorkoutExercise.effective_from).where(
        WorkoutExercise.workout_id == workout.workout_id,
        WorkoutExercise.effective_from > effective_from,
    ).order_by(WorkoutExercise.effective_from))
    for item in current:
        if item.effective_from == effective_from:
            session.delete(item)
        else:
            item.effective_to = effective_from
    session.flush()
    for order, exercise_id in enumerate(exercise_ids, start=1):
        session.add(WorkoutExercise(
            workout_id=workout.workout_id,
            exercise_id=exercise_id,
            exercise_order=order,
            effective_from=effective_from,
            effective_to=next_change,
        ))
    session.commit()


def add_exercise_to_workout(session: Session, workout: Workout, exercise: Exercise) -> None:
    """Compatibility helper preserving the original always-applicable behavior."""
    baseline = date(1900, 1, 1)
    items = workout_exercises_for_date(session, workout.workout_id, baseline)
    if any(item.exercise_id == exercise.exercise_id for item in items):
        raise ValidationError("That exercise is already in this workout.")
    set_workout_exercises(session, workout, [item.exercise_id for item in items] + [exercise.exercise_id], baseline)


def remove_exercise_from_workout(session: Session, workout: Workout, exercise_id: int, effective_from: date | None = None) -> None:
    on_date = effective_from or date.today()
    set_workout_exercises(session, workout, [item.exercise_id for item in workout_exercises_for_date(session, workout.workout_id, on_date) if item.exercise_id != exercise_id], on_date)


def move_workout_exercise(session: Session, workout: Workout, exercise_id: int, direction: int, effective_from: date | None = None) -> None:
    on_date = effective_from or date.today()
    items = workout_exercises_for_date(session, workout.workout_id, on_date)
    index = next((i for i, item in enumerate(items) if item.exercise_id == exercise_id), None)
    if index is None or not 0 <= index + direction < len(items):
        return
    items[index], items[index + direction] = items[index + direction], items[index]
    set_workout_exercises(session, workout, [item.exercise_id for item in items], on_date)


def state_for_date(session: Session, exercise_id: int, on_date: date) -> ExerciseSettingsHistory | None:
    return session.scalar(select(ExerciseSettingsHistory).where(
        ExerciseSettingsHistory.exercise_id == exercise_id,
        ExerciseSettingsHistory.effective_from <= on_date,
        (ExerciseSettingsHistory.effective_to.is_(None)) | (ExerciseSettingsHistory.effective_to > on_date),
    ).order_by(ExerciseSettingsHistory.effective_from.desc()))


def states_for_date(session: Session, exercise_ids: list[int], on_date: date) -> dict[int, ExerciseSettingsHistory]:
    """Return the effective state for each requested exercise in one query."""
    if not exercise_ids:
        return {}
    states = session.scalars(select(ExerciseSettingsHistory).where(
        ExerciseSettingsHistory.exercise_id.in_(exercise_ids),
        ExerciseSettingsHistory.effective_from <= on_date,
        (ExerciseSettingsHistory.effective_to.is_(None)) | (ExerciseSettingsHistory.effective_to > on_date),
    )).all()
    return {state.exercise_id: state for state in states}


def set_exercise_state(session: Session, exercise_id: int, effective_from: date, weight: Decimal | float | str, max_reps: int, sets: int, notes: str | None = None) -> ExerciseSettingsHistory:
    """Insert a state change, splitting the period that covers its start date.

    A same-date correction overwrites the existing state while preserving its
    effective date range.
    """
    weight = Decimal(str(weight))
    if weight < 0 or max_reps <= 0 or sets <= 0:
        raise ValidationError("Weight must be non-negative; reps and sets must be positive.")
    with session.begin_nested():
        existing = session.scalar(select(ExerciseSettingsHistory).where(
            ExerciseSettingsHistory.exercise_id == exercise_id,
            ExerciseSettingsHistory.effective_from == effective_from,
        ))
        if existing:
            existing.weight = weight
            existing.max_reps = max_reps
            existing.sets = sets
            existing.notes = notes or None
            session.flush()
            new_state = existing
        else:
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


def delete_workout_session(session: Session, workout_session_id: int) -> None:
    record = session.get(WorkoutSession, workout_session_id)
    if not record:
        raise ValidationError("Workout session not found.")
    session.delete(record)
    session.commit()


def workouts(session: Session) -> list[Workout]:
    return list(session.scalars(select(Workout).where(Workout.is_active.is_(True)).order_by(Workout.workout_name)))


def exercises(session: Session) -> list[Exercise]:
    return list(session.scalars(select(Exercise).where(Exercise.is_active.is_(True)).order_by(Exercise.exercise_name)))


def recent_sessions(session: Session, limit: int = 12) -> list[WorkoutSession]:
    return list(session.scalars(select(WorkoutSession).options(joinedload(WorkoutSession.workout)).order_by(WorkoutSession.workout_date.desc(), WorkoutSession.workout_session_id.desc()).limit(limit)))


def sessions_on_date(session: Session, on_date: date) -> list[WorkoutSession]:
    return list(session.scalars(select(WorkoutSession).options(joinedload(WorkoutSession.workout)).where(
        WorkoutSession.workout_date == on_date,
    ).order_by(WorkoutSession.workout_session_id)))


def last_recorded_workout_date(session: Session) -> date | None:
    """Return the date of the latest workout session, if one has been logged."""
    return session.scalar(select(func.max(WorkoutSession.workout_date)))


def session_details(session: Session, workout_session_id: int) -> tuple[WorkoutSession, list[tuple[Exercise, ExerciseSettingsHistory | None]]]:
    record = session.scalar(select(WorkoutSession).options(joinedload(WorkoutSession.workout)).where(WorkoutSession.workout_session_id == workout_session_id))
    if not record:
        raise ValidationError("Workout session not found.")
    items = workout_exercises_for_date(session, record.workout_id, record.workout_date)
    states = states_for_date(session, [item.exercise_id for item in items], record.workout_date)
    details = [(item.exercise, states.get(item.exercise_id)) for item in items]
    return record, details
