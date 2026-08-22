from __future__ import annotations

import calendar
import json
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
from sqlalchemy import MetaData, Table, inspect, select

from app.db import get_session
from app.models import Exercise, ExerciseSettingsHistory, Workout
from app.services import (ValidationError, create_exercise_with_initial_state, create_workout, deactivate_exercise, deactivate_workout, exercises, log_workout, move_workout_exercise, recent_sessions, session_details, set_exercise_state, set_workout_exercises, state_for_date, update_exercise, update_workout, workout_exercises_for_date, workouts)

st.set_page_config(page_title="ProgreSQL 💪", page_icon="🏋️", layout="wide")

def fmt(state):
    return "No state configured" if not state else f"{state.weight:g} kg × {state.max_reps} reps × {state.sets} sets"

def flash(action):
    try:
        action(); st.success("Saved.")
    except ValidationError as exc:
        st.error(str(exc))

def home(session):
    st.title("ProgreSQL 💪")
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
    all_workouts = workouts(session)
    st.subheader("Existing workouts")
    if all_workouts:
        st.dataframe([
            {
                "Workout": workout.workout_name,
                "Description": workout.description or "—",
                "Exercises today": ", ".join(item.exercise.exercise_name for item in workout_exercises_for_date(session, workout.workout_id, date.today())) or "No exercises",
            }
            for workout in all_workouts
        ], hide_index=True, use_container_width=True)
    else:
        st.caption("No workouts yet.")
    if st.session_state.pop("reset_workout_selection", False):
        st.session_state.pop("workout_selection", None)
    if "new_workout_id" in st.session_state:
        st.session_state.workout_selection = st.session_state.pop("new_workout_id")
        st.success("Workout created.")
    workout_by_id = {workout.workout_id: workout for workout in all_workouts}
    if st.button("Create workout", type="primary"):
        st.session_state.workout_mode = "create"
        st.rerun()
    if st.session_state.get("workout_mode") == "create":
        st.subheader("Create workout")
        if st.button("Back to existing workouts"):
            st.session_state.workout_mode = "edit"
            st.rerun()
        with st.form("new_workout"):
            name = st.text_input("Name"); desc = st.text_area("Description")
            if st.form_submit_button("Create"):
                try:
                    st.session_state.new_workout_id = create_workout(session, name, desc).workout_id
                    st.session_state.workout_mode = "edit"
                    st.rerun()
                except ValidationError as exc:
                    st.error(str(exc))
        return
    if not workout_by_id:
        st.info("Create a workout to configure its exercises.")
        return
    selection = st.selectbox(
        "Workout",
        list(workout_by_id),
        format_func=lambda item: workout_by_id[item].workout_name,
        key="workout_selection",
    )
    workout = workout_by_id[selection]
    effective_from = st.date_input("View / change date", date.today(), key=f"workout_date_{workout.workout_id}")
    current_items = workout_exercises_for_date(session, workout.workout_id, effective_from)
    st.subheader(f"Exercises on {effective_from:%d %B %Y}")
    if not current_items:
        st.caption("No exercises are configured for this date.")
    for index, item in enumerate(current_items):
        st.write(f"{index + 1}. {item.exercise.exercise_name}")
    with st.expander("Edit workout details"):
        with st.form("edit_workout"):
            name = st.text_input("Name", workout.workout_name); desc = st.text_area("Description", workout.description or "")
            if st.form_submit_button("Save details"):
                try:
                    update_workout(session, workout, name, desc)
                    st.rerun()
                except ValidationError as exc:
                    st.error(str(exc))
    st.subheader("Change exercises")
    all_exercises = exercises(session)
    exercise_by_id = {exercise.exercise_id: exercise for exercise in all_exercises}
    active_exercise_ids = list(exercise_by_id)
    selected_exercise_ids = st.multiselect(
        "Exercises",
        active_exercise_ids,
        default=[item.exercise_id for item in current_items if item.exercise_id in exercise_by_id],
        format_func=lambda exercise_id: exercise_by_id[exercise_id].exercise_name,
        key=f"workout_exercises_{workout.workout_id}_{effective_from.isoformat()}_{','.join(map(str, active_exercise_ids))}",
        help="Selected exercises are included in this workout from the effective date. Save to apply changes.",
    )
    if st.button("Save exercises", type="primary"):
        current_ids = [item.exercise_id for item in current_items]
        selected_ids = selected_exercise_ids
        ordered_ids = [exercise_id for exercise_id in current_ids if exercise_id in selected_ids]
        ordered_ids.extend(exercise_id for exercise_id in selected_ids if exercise_id not in ordered_ids)
        flash(lambda: set_workout_exercises(session, workout, ordered_ids, effective_from))
        st.rerun()
    for index, item in enumerate(current_items):
        cols = st.columns([7, 1, 1, 1, 1])
        cols[0].write(f"{index + 1}. {item.exercise.exercise_name}")
        if cols[1].button("↑", key=f"up{item.workout_exercise_id}"): move_workout_exercise(session, workout, item.exercise_id, -1, effective_from); st.rerun()
        if cols[2].button("↓", key=f"down{item.workout_exercise_id}"): move_workout_exercise(session, workout, item.exercise_id, 1, effective_from); st.rerun()
        if cols[3].button("Remove", key=f"remove{item.workout_exercise_id}"):
            set_workout_exercises(session, workout, [row.exercise_id for row in current_items if row.exercise_id != item.exercise_id], effective_from)
            st.rerun()
    if st.button("Deactivate workout"):
        deactivate_workout(session, workout)
        st.session_state.reset_workout_selection = True
        st.rerun()

def exercises_page(session):
    st.title("Exercises")
    all_exercises = exercises(session)
    st.subheader("Existing exercises")
    if all_exercises:
        st.dataframe([
            {
                "Exercise": exercise.exercise_name,
                "Muscle group": exercise.muscle_group or "—",
                "Equipment": exercise.equipment or "—",
                "Description": exercise.description or "—",
                "Current state": fmt(state_for_date(session, exercise.exercise_id, date.today())),
            }
            for exercise in all_exercises
        ], hide_index=True, use_container_width=True)
    else:
        st.caption("No exercises yet.")
    if st.session_state.pop("reset_exercise_selection", False):
        st.session_state.pop("exercise_selection", None)
    if "new_exercise_id" in st.session_state:
        st.session_state.exercise_selection = st.session_state.pop("new_exercise_id")
        st.success("Exercise created.")
    exercise_by_id = {exercise.exercise_id: exercise for exercise in all_exercises}
    if st.button("Create exercise", type="primary"):
        st.session_state.exercise_mode = "create"
        st.rerun()
    if st.session_state.get("exercise_mode") == "create":
        st.subheader("Create exercise")
        if st.button("Back to existing exercises"):
            st.session_state.exercise_mode = "edit"
            st.rerun()
        with st.form("new_exercise"):
            name = st.text_input("Name"); group = st.text_input("Muscle group"); equipment = st.text_input("Equipment"); desc = st.text_area("Description")
            st.subheader("Initial state")
            weight = st.number_input("Weight (kg)", min_value=0.0, value=0.0, step=2.5, format="%.1f", key="new_exercise_weight")
            reps = st.number_input("Max reps", min_value=1, value=12, key="new_exercise_reps")
            sets = st.number_input("Sets", min_value=1, value=3, key="new_exercise_sets")
            effective = st.date_input("Effective from", date.today(), key="new_exercise_effective")
            notes = st.text_area("State notes (optional)")
            if st.form_submit_button("Create"):
                try:
                    st.session_state.new_exercise_id = create_exercise_with_initial_state(session, name, group, equipment, desc, effective, Decimal(str(weight)), reps, sets, notes).exercise_id
                    st.session_state.exercise_mode = "edit"
                    st.rerun()
                except ValidationError as exc:
                    st.error(str(exc))
        return
    if not exercise_by_id:
        st.info("Create an exercise to configure its state.")
        return
    selection = st.selectbox(
        "Exercise",
        list(exercise_by_id),
        format_func=lambda item: exercise_by_id[item].exercise_name,
        key="exercise_selection",
    )
    exercise = exercise_by_id[selection]
    state = state_for_date(session, exercise.exercise_id, date.today())
    st.subheader("Current state")
    st.write(fmt(state))
    st.subheader("State history")
    history = session.scalars(select(ExerciseSettingsHistory).where(ExerciseSettingsHistory.exercise_id == exercise.exercise_id).order_by(ExerciseSettingsHistory.effective_from)).all()
    if history: st.dataframe([{"Effective from": h.effective_from, "Effective to": h.effective_to or "—", "Weight (kg)": float(h.weight), "Max reps": h.max_reps, "Sets": h.sets} for h in history], hide_index=True, use_container_width=True)
    else: st.caption("No state changes yet.")
    with st.expander("Edit exercise metadata"):
        with st.form("edit_exercise"):
            name = st.text_input("Name", exercise.exercise_name); group = st.text_input("Muscle group", exercise.muscle_group or ""); equipment = st.text_input("Equipment", exercise.equipment or ""); desc = st.text_area("Description", exercise.description or "")
            if st.form_submit_button("Save metadata"):
                try:
                    update_exercise(session, exercise, name, group, equipment, desc)
                    st.rerun()
                except ValidationError as exc:
                    st.error(str(exc))
    with st.expander("Change exercise state"):
        with st.form("state_change"):
            weight = st.number_input("Weight (kg)", min_value=0.0, value=float(state.weight) if state else 0.0, step=2.5, format="%.1f")
            reps = st.number_input("Max reps", min_value=1, value=state.max_reps if state else 12)
            sets = st.number_input("Sets", min_value=1, value=state.sets if state else 3)
            effective = st.date_input("Effective from", date.today())
            notes = st.text_area("Notes (optional)")
            if st.form_submit_button("Add state change"):
                try:
                    set_exercise_state(session, exercise.exercise_id, effective, Decimal(str(weight)), reps, sets, notes)
                    st.rerun()
                except ValidationError as exc:
                    st.error(str(exc))
    if st.button("Deactivate exercise"):
        deactivate_exercise(session, exercise)
        st.session_state.reset_exercise_selection = True
        st.rerun()

def history_page(session):
    st.title("Log workouts")
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
                st.rerun()
            if day_records:
                column.caption(", ".join(record.workout.workout_name for record in day_records))
    selected_date = st.session_state.get("history_selected_date")
    dated_records = [record for record in records if record.workout_date == selected_date]
    if not dated_records:
        st.caption("Select a workout day to view its details.")
        return
    st.subheader(f"Workouts on {selected_date:%d %B %Y}")
    for record in dated_records:
        record, details = session_details(session, record.workout_session_id)
        st.markdown(f"#### {record.workout.workout_name}")
        for exercise, state in details: st.write(f"**{exercise.exercise_name}** — {fmt(state)}")


def _admin_value(column, value):
    if value == "":
        return None
    try:
        value_type = column.type.python_type
    except NotImplementedError:
        return value
    if value is not None and value_type is date and isinstance(value, str):
        return date.fromisoformat(value)
    if value is not None and value_type is Decimal and not isinstance(value, Decimal):
        return Decimal(str(value))
    return value


def admin_page(session):
    st.title("Admin")
    st.warning("Admin changes are applied directly to the database. Hard deletes cannot be undone.")
    table_names = inspect(session.bind).get_table_names()
    table_name = st.selectbox("Table", table_names)
    table = Table(table_name, MetaData(), autoload_with=session.bind)
    primary_keys = [column.name for column in table.primary_key.columns]
    rows = [dict(row) for row in session.execute(select(table)).mappings()]
    st.subheader("Rows")
    edited_rows = st.data_editor(rows, num_rows="fixed", disabled=primary_keys, key=f"admin_editor_{table_name}")
    if st.button("Save row edits"):
        try:
            for row in edited_rows.to_dict("records"):
                where = [table.c[key] == row[key] for key in primary_keys]
                values = {column.name: _admin_value(column, row[column.name]) for column in table.columns if column.name not in primary_keys}
                session.execute(table.update().where(*where).values(**values))
            session.commit()
            st.success("Row edits saved.")
        except Exception as exc:
            session.rollback()
            st.error(f"Could not save edits: {exc}")
    st.subheader("Add row")
    payload = st.text_area("JSON object", placeholder='{"column_name": "value"}', key=f"admin_add_{table_name}")
    if st.button("Add row"):
        try:
            data = json.loads(payload)
            if not isinstance(data, dict):
                raise ValueError("JSON must be an object.")
            values = {name: _admin_value(table.c[name], value) for name, value in data.items() if name in table.c}
            session.execute(table.insert().values(**values))
            session.commit()
            st.rerun()
        except Exception as exc:
            session.rollback()
            st.error(f"Could not add row: {exc}")
    st.subheader("Hard delete row")
    if not primary_keys:
        st.caption("This table has no primary key.")
        return
    if len(primary_keys) == 1:
        example = "[1, 2, 3]"
    else:
        example = '[{"primary_key_1": 1, "primary_key_2": 2}]'
    key_payload = st.text_area(
        "Primary key list (JSON)",
        placeholder=example,
        key=f"admin_delete_{table_name}",
        help="For a single-column primary key, enter a JSON list of values. For a composite key, enter a list of JSON objects.",
    )
    if st.button("Hard delete rows"):
        try:
            keys = json.loads(key_payload)
            if not isinstance(keys, list) or not keys:
                raise ValueError("Enter a non-empty JSON list.")
            for key_value in keys:
                if len(primary_keys) == 1 and not isinstance(key_value, dict):
                    key_value = {primary_keys[0]: key_value}
                if not isinstance(key_value, dict) or any(key not in key_value for key in primary_keys):
                    raise ValueError(f"Each entry must include: {', '.join(primary_keys)}.")
                session.execute(table.delete().where(*[
                    table.c[key] == _admin_value(table.c[key], key_value[key]) for key in primary_keys
                ]))
            session.commit()
            st.rerun()
        except Exception as exc:
            session.rollback()
            st.error(f"Could not hard delete rows: {exc}")
            st.caption("Delete rows that reference these records first, or use soft deletion for records that must remain in history.")

session = get_session()
try:
    st.sidebar.title("ProgreSQL 💪")
    page = st.sidebar.radio("Navigation", ["Home", "Workouts", "Exercises", "Log workouts", "Admin"], label_visibility="collapsed")
    {"Home": home, "Workouts": workouts_page, "Exercises": exercises_page, "Log workouts": history_page, "Admin": admin_page}[page](session)
finally:
    session.close()
