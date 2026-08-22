from __future__ import annotations

import calendar
from datetime import date
from decimal import Decimal
from pathlib import Path
import sys

# Streamlit executes this file as a script, which puts ``app/`` rather than the
# project root on ``sys.path``.  Add the root so absolute package imports work
# with the documented ``streamlit run app/main.py`` command.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import streamlit as st
from sqlalchemy import select

from app.db import get_session
from app.models import Exercise, ExerciseSettingsHistory, Workout
from app.services import (ValidationError, create_exercise, create_workout, exercises, log_workout, move_workout_exercise, recent_sessions, session_details, set_exercise_state, set_workout_exercises, state_for_date, update_exercise, update_workout, workout_exercises_for_date, workouts)

st.set_page_config(page_title="Gym Tracker", page_icon="🏋️", layout="wide")

def fmt(state):
    return "No state configured" if not state else f"{state.weight:g} kg × {state.max_reps} reps × {state.sets} sets"

def flash(action):
    try:
        action(); st.success("Saved.")
    except ValidationError as exc:
        st.error(str(exc))

def home(session):
    st.title("Gym Tracker")
    st.caption("A quick record of workouts and the training prescription behind them.")
    st.subheader("Current training")
    current = [(exercise, state_for_date(session, exercise.exercise_id, date.today())) for exercise in exercises(session)]
    if current:
        for exercise, state in current: st.write(f"**{exercise.exercise_name}** — {fmt(state)}")
    else: st.info("Create an exercise, then add its first state to begin.")
    st.subheader("Recent workouts")
    sessions = recent_sessions(session, 8)
    if sessions: st.dataframe([{"Date": item.workout_date, "Workout": item.workout.workout_name} for item in sessions], hide_index=True, use_container_width=True)
    else: st.caption("No workouts logged yet.")

def workouts_page(session):
    st.title("Workouts")
    create_option = "Create workout"
    all_workouts = workouts(session)
    selection = st.selectbox(
        "Workout",
        [create_option, *all_workouts],
        format_func=lambda item: item if isinstance(item, str) else item.workout_name,
    )
    if selection == create_option:
        st.subheader("Create workout")
        with st.form("new_workout"):
            name = st.text_input("Name"); desc = st.text_area("Description")
            if st.form_submit_button("Create"): flash(lambda: create_workout(session, name, desc))
        return
    workout = selection
    with st.form("edit_workout"):
        name = st.text_input("Name", workout.workout_name); desc = st.text_area("Description", workout.description or "")
        if st.form_submit_button("Save details"): flash(lambda: update_workout(session, workout, name, desc))
    effective_from = st.date_input("Change effective from", date.today(), key=f"workout_date_{workout.workout_id}")
    current_items = workout_exercises_for_date(session, workout.workout_id, effective_from)
    all_exercises = exercises(session)
    selected_exercises = st.multiselect(
        "Exercises",
        all_exercises,
        default=[item.exercise for item in current_items],
        format_func=lambda exercise: exercise.exercise_name,
        key=f"workout_exercises_{workout.workout_id}_{effective_from.isoformat()}",
        help="Selected exercises are included in this workout from the effective date. Save to apply changes.",
    )
    if st.button("Save exercises", type="primary"):
        current_ids = [item.exercise_id for item in current_items]
        selected_ids = [exercise.exercise_id for exercise in selected_exercises]
        ordered_ids = [exercise_id for exercise_id in current_ids if exercise_id in selected_ids]
        ordered_ids.extend(exercise_id for exercise_id in selected_ids if exercise_id not in ordered_ids)
        flash(lambda: set_workout_exercises(session, workout, ordered_ids, effective_from))
        st.rerun()
    st.subheader("Exercises")
    if not current_items:
        st.caption("No exercises are configured for this date.")
    for index, item in enumerate(current_items):
        cols = st.columns([7, 1, 1, 1])
        cols[0].write(f"{index + 1}. {item.exercise.exercise_name}")
        if cols[1].button("↑", key=f"up{item.workout_exercise_id}"): move_workout_exercise(session, workout, item.exercise_id, -1, effective_from); st.rerun()
        if cols[2].button("↓", key=f"down{item.workout_exercise_id}"): move_workout_exercise(session, workout, item.exercise_id, 1, effective_from); st.rerun()

def exercises_page(session):
    st.title("Exercises")
    create_option = "Create exercise"
    all_exercises = exercises(session)
    selection = st.selectbox(
        "Exercise",
        [create_option, *all_exercises],
        format_func=lambda item: item if isinstance(item, str) else item.exercise_name,
    )
    if selection == create_option:
        st.subheader("Create exercise")
        with st.form("new_exercise"):
            name = st.text_input("Name"); group = st.text_input("Muscle group"); equipment = st.text_input("Equipment"); desc = st.text_area("Description")
            if st.form_submit_button("Create"): flash(lambda: create_exercise(session, name, group, equipment, desc))
        return
    exercise = selection
    with st.expander("Edit exercise metadata"):
        with st.form("edit_exercise"):
            name = st.text_input("Name", exercise.exercise_name); group = st.text_input("Muscle group", exercise.muscle_group or ""); equipment = st.text_input("Equipment", exercise.equipment or ""); desc = st.text_area("Description", exercise.description or "")
            if st.form_submit_button("Save metadata"): flash(lambda: update_exercise(session, exercise, name, group, equipment, desc))
    state = state_for_date(session, exercise.exercise_id, date.today())
    st.subheader("Current state")
    st.write(fmt(state))
    with st.expander("Change exercise state"):
        with st.form("state_change"):
            weight = st.number_input("Weight (kg)", min_value=0.0, value=float(state.weight) if state else 0.0, step=2.5, format="%.1f")
            reps = st.number_input("Max reps", min_value=1, value=state.max_reps if state else 12)
            sets = st.number_input("Sets", min_value=1, value=state.sets if state else 3)
            effective = st.date_input("Effective from", date.today())
            notes = st.text_area("Notes (optional)")
            if st.form_submit_button("Add state change"): flash(lambda: set_exercise_state(session, exercise.exercise_id, effective, Decimal(str(weight)), reps, sets, notes))
    st.subheader("State history")
    history = session.scalars(select(ExerciseSettingsHistory).where(ExerciseSettingsHistory.exercise_id == exercise.exercise_id).order_by(ExerciseSettingsHistory.effective_from)).all()
    if history: st.dataframe([{"Effective from": h.effective_from, "Effective to": h.effective_to or "—", "Weight (kg)": float(h.weight), "Max reps": h.max_reps, "Sets": h.sets} for h in history], hide_index=True, use_container_width=True)

def history_page(session):
    st.title("Workout history")
    all_workouts = workouts(session)
    st.subheader("Log workout")
    if all_workouts:
        selected = st.selectbox("Workout to log", all_workouts, format_func=lambda workout: workout.workout_name)
        workout_date = st.date_input("Workout date", date.today())
        items = workout_exercises_for_date(session, selected.workout_id, workout_date)
        if items:
            for item in items:
                st.write(f"**{item.exercise.exercise_name}** — {fmt(state_for_date(session, item.exercise_id, workout_date))}")
            if st.button("Log workout", type="primary"):
                flash(lambda: log_workout(session, selected.workout_id, workout_date))
        else:
            st.info("This workout has no exercises configured for that date.")
    else:
        st.info("Create a workout first.")

    st.subheader("Calendar")
    records = recent_sessions(session, 100)
    if not records:
        st.caption("No workouts logged yet.")
        return
    month = st.date_input("Month", date.today().replace(day=1), key="history_month")
    by_day = {}
    for record in records:
        if record.workout_date.year == month.year and record.workout_date.month == month.month:
            by_day.setdefault(record.workout_date, []).append(record)
    headers = st.columns(7)
    for column, label in zip(headers, calendar.day_abbr):
        column.caption(label)
    for week in calendar.monthcalendar(month.year, month.month):
        columns = st.columns(7)
        for column, day in zip(columns, week):
            if not day:
                continue
            day_date = date(month.year, month.month, day)
            day_records = by_day.get(day_date, [])
            if column.button(str(day), key=f"calendar_{day_date.isoformat()}", type="primary" if day_records else "secondary"):
                st.session_state.history_selected_date = day_date
            if day_records:
                column.caption(", ".join(record.workout.workout_name for record in day_records))
    selected_date = st.session_state.get("history_selected_date")
    dated_records = [record for record in records if record.workout_date == selected_date]
    if not dated_records:
        st.caption("Select a workout day to view its details.")
        return
    record = st.selectbox("Workout session", dated_records, format_func=lambda item: item.workout.workout_name)
    record, details = session_details(session, record.workout_session_id)
    st.subheader(f"{record.workout.workout_name} — {record.workout_date:%d %B %Y}")
    for exercise, state in details: st.write(f"**{exercise.exercise_name}** — {fmt(state)}")

session = get_session()
try:
    page = st.sidebar.radio("Navigate", ["Home", "Workouts", "Exercises", "History"])
    {"Home": home, "Workouts": workouts_page, "Exercises": exercises_page, "History": history_page}[page](session)
finally:
    session.close()
