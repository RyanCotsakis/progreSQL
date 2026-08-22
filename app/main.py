from __future__ import annotations

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
from app.services import (ValidationError, add_exercise_to_workout, create_exercise, create_workout, exercises, log_workout, move_workout_exercise, recent_sessions, remove_exercise_from_workout, session_details, set_exercise_state, state_for_date, update_exercise, update_workout, workouts)

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

def log_page(session):
    st.title("Log workout")
    all_workouts = workouts(session)
    if not all_workouts: st.info("Create a workout first."); return
    choices = {w.workout_name: w for w in all_workouts}
    selected_name = st.selectbox("Workout", choices)
    selected = choices[selected_name]
    workout_date = st.date_input("Date", date.today())
    st.subheader(selected.workout_name)
    for item in selected.exercises:
        st.write(f"**{item.exercise.exercise_name}**  \n{fmt(state_for_date(session, item.exercise_id, workout_date))}")
    if st.button("Log Workout", type="primary"):
        flash(lambda: log_workout(session, selected.workout_id, workout_date))

def workouts_page(session):
    st.title("Workouts")
    with st.expander("Create workout"):
        with st.form("new_workout"):
            name = st.text_input("Name"); desc = st.text_area("Description")
            if st.form_submit_button("Create"): flash(lambda: create_workout(session, name, desc))
    all_workouts = workouts(session)
    if not all_workouts: return
    workout = st.selectbox("Edit workout", all_workouts, format_func=lambda w: w.workout_name)
    with st.form("edit_workout"):
        name = st.text_input("Name", workout.workout_name); desc = st.text_area("Description", workout.description or "")
        if st.form_submit_button("Save details"): flash(lambda: update_workout(session, workout, name, desc))
    available = [e for e in exercises(session) if not any(row.exercise_id == e.exercise_id for row in workout.exercises)]
    if available:
        exercise = st.selectbox("Add exercise", available, format_func=lambda e: e.exercise_name)
        if st.button("Add to workout"): flash(lambda: add_exercise_to_workout(session, workout, exercise))
    st.subheader("Exercise order")
    for index, item in enumerate(workout.exercises):
        cols = st.columns([7, 1, 1, 1])
        cols[0].write(f"{index + 1}. {item.exercise.exercise_name}")
        if cols[1].button("↑", key=f"up{item.exercise_id}"): move_workout_exercise(session, workout, item.exercise_id, -1); st.rerun()
        if cols[2].button("↓", key=f"down{item.exercise_id}"): move_workout_exercise(session, workout, item.exercise_id, 1); st.rerun()
        if cols[3].button("Remove", key=f"rm{item.exercise_id}"): remove_exercise_from_workout(session, workout, item.exercise_id); st.rerun()

def exercises_page(session):
    st.title("Exercises")
    with st.expander("Create exercise"):
        with st.form("new_exercise"):
            name = st.text_input("Name"); group = st.text_input("Muscle group"); equipment = st.text_input("Equipment"); desc = st.text_area("Description")
            if st.form_submit_button("Create"): flash(lambda: create_exercise(session, name, group, equipment, desc))
    all_exercises = exercises(session)
    if not all_exercises: return
    exercise = st.selectbox("Exercise", all_exercises, format_func=lambda e: e.exercise_name)
    with st.expander("Edit exercise metadata"):
        with st.form("edit_exercise"):
            name = st.text_input("Name", exercise.exercise_name); group = st.text_input("Muscle group", exercise.muscle_group or ""); equipment = st.text_input("Equipment", exercise.equipment or ""); desc = st.text_area("Description", exercise.description or "")
            if st.form_submit_button("Save metadata"): flash(lambda: update_exercise(session, exercise, name, group, equipment, desc))
    state = state_for_date(session, exercise.exercise_id, date.today())
    st.subheader("Current state")
    st.write(fmt(state))
    with st.expander("Change exercise state"):
        with st.form("state_change"):
            weight = st.number_input("Weight (kg)", min_value=0.0, value=float(state.weight) if state else 0.0, step=0.5)
            reps = st.number_input("Max reps", min_value=1, value=state.max_reps if state else 8)
            sets = st.number_input("Sets", min_value=1, value=state.sets if state else 3)
            effective = st.date_input("Effective from", date.today())
            notes = st.text_area("Notes (optional)")
            if st.form_submit_button("Add state change"): flash(lambda: set_exercise_state(session, exercise.exercise_id, effective, Decimal(str(weight)), reps, sets, notes))
    st.subheader("State history")
    history = session.scalars(select(ExerciseSettingsHistory).where(ExerciseSettingsHistory.exercise_id == exercise.exercise_id).order_by(ExerciseSettingsHistory.effective_from)).all()
    if history: st.dataframe([{"Effective from": h.effective_from, "Effective to": h.effective_to or "—", "Weight (kg)": float(h.weight), "Max reps": h.max_reps, "Sets": h.sets} for h in history], hide_index=True, use_container_width=True)

def history_page(session):
    st.title("Workout history")
    records = recent_sessions(session, 100)
    if not records: st.info("No workouts logged yet."); return
    record = st.selectbox("Workout session", records, format_func=lambda r: f"{r.workout_date:%d %b %Y} — {r.workout.workout_name}")
    record, details = session_details(session, record.workout_session_id)
    st.subheader(f"{record.workout.workout_name} — {record.workout_date:%d %B %Y}")
    for exercise, state in details: st.write(f"**{exercise.exercise_name}** — {fmt(state)}")

session = get_session()
try:
    page = st.sidebar.radio("Navigate", ["Home", "Log workout", "Workouts", "Exercises", "History"])
    {"Home": home, "Log workout": log_page, "Workouts": workouts_page, "Exercises": exercises_page, "History": history_page}[page](session)
finally:
    session.close()
