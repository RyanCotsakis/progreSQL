from datetime import date

import pytest
from sqlalchemy.orm import sessionmaker

from app.db import Base, make_engine
from app.services import (ValidationError, add_exercise_to_workout, create_exercise, create_exercise_with_initial_state, create_workout, deactivate_exercise, deactivate_workout, exercises, last_recorded_workout_date, log_workout, recent_sessions, session_details, set_exercise_state, set_workout_exercises, state_for_date, workout_exercises_for_date, workouts)


@pytest.fixture
def session():
    engine = make_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    yield db
    db.close(); engine.dispose()


def setup_push(session):
    bench = create_exercise(session, "Bench Press", "Chest", "Barbell")
    push = create_workout(session, "Push")
    add_exercise_to_workout(session, push, bench)
    return bench, push


def test_create_exercise_workout_and_session(session):
    bench, push = setup_push(session)
    assert bench.exercise_name == "Bench Press"
    assert push.exercises[0].exercise_id == bench.exercise_id
    record = log_workout(session, push.workout_id, date(2026, 1, 15))
    assert record.workout_date == date(2026, 1, 15)


def test_last_recorded_workout_date(session):
    assert last_recorded_workout_date(session) is None
    _, push = setup_push(session)
    log_workout(session, push.workout_id, date(2026, 1, 10))
    log_workout(session, push.workout_id, date(2026, 1, 12))

    assert last_recorded_workout_date(session) == date(2026, 1, 12)


def test_create_exercise_with_initial_state(session):
    exercise = create_exercise_with_initial_state(session, "Deadlift", "Back", "Barbell", None, date(2026, 1, 1), 100, 5, 3)
    state = state_for_date(session, exercise.exercise_id, date(2026, 1, 1))
    assert state is not None
    assert (state.weight, state.max_reps, state.sets) == (100, 5, 3)


def test_scd2_future_change_closes_previous_and_resolves_dates(session):
    bench, _ = setup_push(session)
    first = set_exercise_state(session, bench.exercise_id, date(2026, 1, 1), 60, 10, 3)
    future = set_exercise_state(session, bench.exercise_id, date(2026, 3, 1), 65, 10, 3)
    assert first.effective_to == date(2026, 3, 1)
    assert future.effective_to is None
    assert state_for_date(session, bench.exercise_id, date(2026, 2, 28)).weight == 60
    assert state_for_date(session, bench.exercise_id, date(2026, 3, 1)).weight == 65


def test_future_first_state_does_not_apply_before_its_effective_date(session):
    bench, _ = setup_push(session)
    set_exercise_state(session, bench.exercise_id, date(2026, 3, 1), 65, 10, 3)
    assert state_for_date(session, bench.exercise_id, date(2026, 2, 28)) is None
    assert state_for_date(session, bench.exercise_id, date(2026, 3, 1)).weight == 65
    january = set_exercise_state(session, bench.exercise_id, date(2026, 1, 1), 60, 10, 3)
    assert january.effective_to == date(2026, 3, 1)


def test_inserting_mid_history_splits_a_period_without_overlap(session):
    bench, _ = setup_push(session)
    set_exercise_state(session, bench.exercise_id, date(2026, 1, 1), 60, 10, 3)
    set_exercise_state(session, bench.exercise_id, date(2026, 7, 1), 70, 8, 3)
    inserted = set_exercise_state(session, bench.exercise_id, date(2026, 3, 1), 65, 10, 3)
    assert inserted.effective_to == date(2026, 7, 1)
    assert state_for_date(session, bench.exercise_id, date(2026, 2, 1)).weight == 60
    assert state_for_date(session, bench.exercise_id, date(2026, 4, 1)).weight == 65
    assert state_for_date(session, bench.exercise_id, date(2026, 8, 1)).weight == 70
    with pytest.raises(ValidationError):
        set_exercise_state(session, bench.exercise_id, date(2026, 3, 1), 66, 8, 3)


def test_historical_workout_uses_state_effective_on_workout_date(session):
    bench, push = setup_push(session)
    set_exercise_state(session, bench.exercise_id, date(2026, 1, 1), 60, 10, 3)
    january = log_workout(session, push.workout_id, date(2026, 1, 15))
    set_exercise_state(session, bench.exercise_id, date(2026, 3, 1), 65, 10, 3)
    march = log_workout(session, push.workout_id, date(2026, 3, 10))
    set_exercise_state(session, bench.exercise_id, date(2026, 7, 1), 70, 8, 3)
    _, january_details = session_details(session, january.workout_session_id)
    _, march_details = session_details(session, march.workout_session_id)
    assert january_details[0][1].weight == 60
    assert march_details[0][1].weight == 65
    assert state_for_date(session, bench.exercise_id, date(2026, 8, 1)).weight == 70


def test_prevents_duplicate_session_same_workout_and_date(session):
    _, push = setup_push(session)
    log_workout(session, push.workout_id, date(2026, 1, 15))
    with pytest.raises(ValidationError):
        log_workout(session, push.workout_id, date(2026, 1, 15))


def test_workout_composition_is_effective_dated_and_same_day_edits_apply_to_session(session):
    bench, push = setup_push(session)
    squat = create_exercise(session, "Squat", "Legs", "Barbell")
    january_session = log_workout(session, push.workout_id, date(2026, 1, 15))

    set_workout_exercises(session, push, [squat.exercise_id, bench.exercise_id], date(2026, 1, 15))

    assert [item.exercise.exercise_name for item in workout_exercises_for_date(session, push.workout_id, date(2026, 1, 14))] == ["Bench Press"]
    assert [item.exercise.exercise_name for item in workout_exercises_for_date(session, push.workout_id, date(2026, 1, 15))] == ["Squat", "Bench Press"]
    _, details = session_details(session, january_session.workout_session_id)
    assert [exercise.exercise_name for exercise, _ in details] == ["Squat", "Bench Press"]


def test_soft_deleted_entities_are_hidden_from_active_lists_but_remain_in_history(session):
    bench, push = setup_push(session)
    record = log_workout(session, push.workout_id, date(2026, 1, 15))
    deactivate_exercise(session, bench)
    deactivate_workout(session, push)

    assert exercises(session) == []
    assert workouts(session) == []
    assert recent_sessions(session)[0].workout_session_id == record.workout_session_id
    _, details = session_details(session, record.workout_session_id)
    assert details[0][0].exercise_name == "Bench Press"
