from datetime import date

import pytest
from sqlalchemy.orm import sessionmaker

from app.db import Base, make_engine
from app.services import (ValidationError, add_exercise_to_workout, create_exercise, create_workout, log_workout, session_details, set_exercise_state, state_for_date)


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
