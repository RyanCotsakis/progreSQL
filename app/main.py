from __future__ import annotations

import calendar
import json
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import streamlit as st
from sqlalchemy import MetaData, Table, inspect, select

from app.db import get_session
from app.models import ExerciseSettingsHistory
from app.services import (
    ValidationError, create_exercise_with_initial_state, create_workout,
    deactivate_exercise, deactivate_workout, exercises, log_workout,
    recent_sessions, session_details, set_exercise_state,
    set_workout_exercises, state_for_date, update_exercise, update_workout,
    workout_exercises_for_date, workouts,
)

st.set_page_config(page_title="ProgreSQL 💪", page_icon="💪", layout="wide")


def flash(action, message="Saved."):
    try:
        action()
        st.session_state.saved_message = message
    except ValidationError as exc:
        st.error(str(exc))


def prescription_table(session, items, on_date):
    rows = []
    for item in items:
        state = state_for_date(session, item.exercise_id, on_date)
        rows.append({"Exercise": item.exercise.exercise_name, "Weight (kg)": float(state.weight) if state else "—", "Max reps": state.max_reps if state else "—", "Sets": state.sets if state else "—"})
    st.dataframe(rows, hide_index=True, use_container_width=True)


def back_to_library():
    # A workout draft is only meaningful while its editor is open. Returning to
    # the library deliberately discards it so a later visit reads the database.
    reset_workout_draft()
    st.session_state.app_view = "library"
    st.rerun()


def reset_workout_draft():
    st.session_state.pop("workout_draft_signature", None)
    st.session_state.pop("workout_draft_ids", None)
    for key in list(st.session_state):
        if key.startswith("workout_exercises_"):
            del st.session_state[key]


def selectable_table(rows, key):
    event = st.dataframe(rows, hide_index=True, use_container_width=True, key=key, on_select="rerun", selection_mode="single-row")
    selected = event.selection.rows
    return selected[0] if selected else None


def library_page(session):
    st.title("Workouts & exercises")
    st.caption("Select a row to edit it. Exercise prescriptions and workout composition stay auditable by date.")
    all_workouts, all_exercises = workouts(session), exercises(session)
    st.subheader("View / edit workouts")
    if all_workouts:
        rows = [
            {
                "Workout": w.workout_name,
                "Description": w.description or "—",
                "Exercises today": ", ".join(item.exercise.exercise_name for item in workout_exercises_for_date(session, w.workout_id, date.today())) or "—",
            }
            for w in all_workouts
        ]
        selected = selectable_table(rows, "workout_library_table")
        if selected is not None:
            st.session_state.edit_workout_id = all_workouts[selected].workout_id
            st.session_state.app_view = "workout_edit"
            st.rerun()
    else:
        st.caption("No workouts yet.")
    if st.button("Create workout", type="primary"):
        st.session_state.app_view = "workout_create"
        st.rerun()
    st.subheader("View / edit exercises")
    if all_exercises:
        rows = []
        for exercise in all_exercises:
            state = state_for_date(session, exercise.exercise_id, date.today())
            rows.append({"Exercise": exercise.exercise_name, "Muscle group": exercise.muscle_group or "—", "Equipment": exercise.equipment or "—", "Description": exercise.description or "—", "Weight (kg)": float(state.weight) if state else "—", "Max reps": state.max_reps if state else "—", "Sets": state.sets if state else "—"})
        selected = selectable_table(rows, "exercise_library_table")
        if selected is not None:
            st.session_state.edit_exercise_id = all_exercises[selected].exercise_id
            st.session_state.app_view = "exercise_edit"
            st.rerun()
    else:
        st.caption("No exercises yet.")
    if st.button("Create exercise", type="primary"):
        st.session_state.app_view = "exercise_create"
        st.rerun()
    st.subheader("Recent workout sessions")
    sessions = recent_sessions(session, 12)
    if sessions:
        st.dataframe([{"Date": s.workout_date, "Workout": s.workout.workout_name} for s in sessions], hide_index=True, use_container_width=True)
    else:
        st.caption("No workouts logged yet.")


def workout_create_page(session):
    if st.button("← Back to workouts & exercises"):
        back_to_library()
    st.title("Create workout")
    with st.form("new_workout"):
        name, description = st.text_input("Name"), st.text_area("Description")
        if st.form_submit_button("Create workout", type="primary"):
            try:
                workout = create_workout(session, name, description)
                reset_workout_draft()
                st.session_state.edit_workout_id, st.session_state.app_view = workout.workout_id, "workout_edit"
                st.session_state.saved_message = "Workout created."
                st.rerun()
            except ValidationError as exc:
                st.error(str(exc))


def workout_edit_page(session):
    workout = next((w for w in workouts(session) if w.workout_id == st.session_state.get("edit_workout_id")), None)
    if not workout:
        st.warning("That workout is no longer available.")
        back_to_library()
    if st.button("← Back to workouts & exercises"):
        back_to_library()
    st.title(f"Edit workout: {workout.workout_name}")
    with st.expander("Edit workout details"):
        with st.form("edit_workout"):
            name, description = st.text_input("Name", workout.workout_name), st.text_area("Description", workout.description or "")
            if st.form_submit_button("Save details"):
                flash(lambda: update_workout(session, workout, name, description))
                st.rerun()
    effective_from = st.date_input("Apply exercise changes from", date.today(), key=f"workout_date_{workout.workout_id}")
    current = workout_exercises_for_date(session, workout.workout_id, effective_from)
    signature = (workout.workout_id, effective_from.isoformat())
    selection_key = f"workout_exercises_{workout.workout_id}_{effective_from.isoformat()}"
    if st.session_state.get("workout_draft_signature") != signature:
        st.session_state.workout_draft_signature = signature
        st.session_state.workout_draft_ids = [item.exercise_id for item in current]
        st.session_state[selection_key] = list(st.session_state.workout_draft_ids)
    draft = st.session_state.workout_draft_ids
    by_id = {exercise.exercise_id: exercise for exercise in exercises(session)}
    st.subheader("Change exercises")
    st.caption("Choose the exercises, then arrange them below. Nothing is written to the database until you save.")
    selected_ids = st.multiselect(
        "Exercises in this workout", list(by_id),
        format_func=lambda item: by_id[item].exercise_name,
        key=selection_key,
    )
    if set(selected_ids) != set(draft):
        # Keep existing members in their arranged order, and append only newly
        # selected exercises. This is all local state until Save exercises.
        draft[:] = [item for item in draft if item in selected_ids]
        draft.extend(item for item in selected_ids if item not in draft)
    if not draft:
        st.info("No exercises are in this workout yet.")
    for index, exercise_id in enumerate(draft):
        cols = st.columns([8, 1, 1])
        cols[0].write(f"{index + 1}. **{by_id[exercise_id].exercise_name}**")
        if cols[1].button("↑", key=f"draft_up_{exercise_id}", disabled=index == 0):
            draft[index - 1], draft[index] = draft[index], draft[index - 1]
            st.rerun()
        if cols[2].button("↓", key=f"draft_down_{exercise_id}", disabled=index == len(draft) - 1):
            draft[index + 1], draft[index] = draft[index], draft[index + 1]
            st.rerun()
    if st.button("Save exercises", type="primary"):
        flash(lambda: set_workout_exercises(session, workout, draft, effective_from), "Exercises saved.")
        st.rerun()
    if st.button("Delete workout"):
        deactivate_workout(session, workout)
        st.session_state.saved_message = "Workout deleted."
        back_to_library()


def exercise_create_page(session):
    if st.button("← Back to workouts & exercises"):
        back_to_library()
    st.title("Create exercise")
    with st.form("new_exercise"):
        name, group, equipment, description = st.text_input("Name"), st.text_input("Muscle group"), st.text_input("Equipment"), st.text_area("Description")
        st.subheader("Initial state")
        weight = st.number_input("Weight (kg)", min_value=0.0, value=0.0, step=2.5, format="%.1f")
        reps, sets = st.number_input("Max reps", min_value=1, value=12), st.number_input("Sets", min_value=1, value=3)
        effective, notes = st.date_input("Effective from", date.today()), st.text_area("State notes (optional)")
        if st.form_submit_button("Create exercise", type="primary"):
            try:
                exercise = create_exercise_with_initial_state(session, name, group, equipment, description, effective, Decimal(str(weight)), reps, sets, notes)
                st.session_state.edit_exercise_id, st.session_state.app_view = exercise.exercise_id, "exercise_edit"
                st.session_state.saved_message = "Exercise created."
                st.rerun()
            except ValidationError as exc:
                st.error(str(exc))


def exercise_edit_page(session):
    exercise = next((e for e in exercises(session) if e.exercise_id == st.session_state.get("edit_exercise_id")), None)
    if not exercise:
        st.warning("That exercise is no longer available.")
        back_to_library()
    state = state_for_date(session, exercise.exercise_id, date.today())
    if st.button("← Back to workouts & exercises"):
        back_to_library()
    st.title(f"Edit exercise: {exercise.exercise_name}")
    st.subheader("State history")
    history = session.scalars(select(ExerciseSettingsHistory).where(ExerciseSettingsHistory.exercise_id == exercise.exercise_id).order_by(ExerciseSettingsHistory.effective_from)).all()
    if history:
        st.dataframe([{"Effective from": row.effective_from, "Effective to": row.effective_to or "—", "Weight (kg)": float(row.weight), "Max reps": row.max_reps, "Sets": row.sets} for row in history], hide_index=True, use_container_width=True)
    else:
        st.caption("No state changes yet.")
    with st.expander("Edit exercise metadata", expanded=False):
        with st.form("edit_exercise"):
            name, group = st.text_input("Name", exercise.exercise_name), st.text_input("Muscle group", exercise.muscle_group or "")
            equipment, description = st.text_input("Equipment", exercise.equipment or ""), st.text_area("Description", exercise.description or "")
            if st.form_submit_button("Save metadata"):
                flash(lambda: update_exercise(session, exercise, name, group, equipment, description))
                st.rerun()
    with st.expander("Change exercise state", expanded=True):
        with st.form("state_change"):
            weight = st.number_input("Weight (kg)", min_value=0.0, value=float(state.weight) if state else 0.0, step=2.5, format="%.1f")
            reps, sets = st.number_input("Max reps", min_value=1, value=state.max_reps if state else 12), st.number_input("Sets", min_value=1, value=state.sets if state else 3)
            effective, notes = st.date_input("Effective from", date.today()), st.text_area("Notes (optional)")
            if st.form_submit_button("Add state change"):
                flash(lambda: set_exercise_state(session, exercise.exercise_id, effective, Decimal(str(weight)), reps, sets, notes), "State change saved.")
                st.rerun()
    if st.button("Delete exercise"):
        deactivate_exercise(session, exercise)
        st.session_state.saved_message = "Exercise deleted."
        back_to_library()


def history_page(session):
    st.title("Log workouts")
    records = recent_sessions(session, 100)
    if "history_selected_date" not in st.session_state:
        st.session_state.history_selected_date = date.today()
    if "history_calendar_month" not in st.session_state:
        st.session_state.history_calendar_month = date.today().replace(day=1)
    selected_date = st.session_state.history_selected_date
    month = st.session_state.history_calendar_month
    previous_month = (month.replace(day=1) - timedelta(days=1)).replace(day=1)
    next_month = (month.replace(day=28) + timedelta(days=4)).replace(day=1)
    previous, title, today_button, following = st.columns([2, 5, 2, 2])
    if previous.button("← Previous month"):
        st.session_state.history_calendar_month = previous_month
        st.rerun()
    title.markdown(f"### {month:%B %Y}")
    if today_button.button("Today"):
        st.session_state.history_selected_date = date.today()
        st.session_state.history_calendar_month = date.today().replace(day=1)
        st.rerun()
    if following.button("Next month →"):
        st.session_state.history_calendar_month = next_month
        st.rerun()
    by_day = {}
    for record in records:
        if record.workout_date.year == month.year and record.workout_date.month == month.month:
            by_day.setdefault(record.workout_date, []).append(record)
    st.subheader("Select workout date")
    st.markdown("<style>.st-key-calendar_grid {max-width: 75%; margin-inline: auto;} .st-key-calendar_grid [data-testid='stHorizontalBlock'] {gap: 0.25rem;} @media (max-width: 800px) {.st-key-calendar_grid {max-width: 100%;}}</style>", unsafe_allow_html=True)
    with st.container(key="calendar_grid"):
        headers = st.columns(7)
        for column, label in zip(headers, calendar.day_abbr):
            column.caption(label)
        for week in calendar.monthcalendar(month.year, month.month):
            columns = st.columns(7)
            for column, day_number in zip(columns, week):
                if not day_number:
                    continue
                day_date, day_records = date(month.year, month.month, day_number), by_day.get(date(month.year, month.month, day_number), [])
                color = "#7b1fa2" if day_date == selected_date and day_records else "#c62828" if day_date == selected_date else "#1976d2" if day_records else None
                container_key = f"calendar_day_{day_date:%Y%m%d}"
                if color:
                    st.markdown(f"<style>.st-key-{container_key} button {{background-color: {color} !important; border-color: {color} !important; color: white !important;}}</style>", unsafe_allow_html=True)
                with column:
                    # A fixed-height cell keeps the entire calendar grid aligned,
                    # while leaving room to show the logged workout names.
                    with st.container(height=132, border=False, key=container_key):
                        if st.button(str(day_number), key=f"calendar_{day_date.isoformat()}", type="secondary"):
                            st.session_state.history_selected_date = day_date
                            st.rerun()
                        if day_records:
                            st.caption(", ".join(record.workout.workout_name for record in day_records))
    st.subheader(f"Log a workout on {selected_date:%A, %d %B %Y}")
    all_workouts = workouts(session)
    if all_workouts:
        selected = st.selectbox("Workout to log", all_workouts, format_func=lambda workout: workout.workout_name)
        items = workout_exercises_for_date(session, selected.workout_id, selected_date)
        if items:
            prescription_table(session, items, selected_date)
            if st.button(f"Log {selected.workout_name} on {selected_date:%d %b}", type="primary"):
                flash(lambda: log_workout(session, selected.workout_id, selected_date), "Workout logged.")
                st.rerun()
        else:
            st.info("This workout has no exercises configured for the selected date.")
    else:
        st.info("Create a workout first.")
    logged = [record for record in records if record.workout_date == selected_date]
    if logged:
        st.subheader(f"Already logged on {selected_date:%d %B %Y}")
        for record in logged:
            record, details = session_details(session, record.workout_session_id)
            st.markdown(f"#### {record.workout.workout_name}")
            st.dataframe([{"Exercise": exercise.exercise_name, "Weight (kg)": float(state.weight) if state else "—", "Max reps": state.max_reps if state else "—", "Sets": state.sets if state else "—"} for exercise, state in details], hide_index=True, use_container_width=True)


def _admin_value(column, value):
    if value == "": return None
    try: value_type = column.type.python_type
    except NotImplementedError: return value
    if value is not None and value_type is date and isinstance(value, str): return date.fromisoformat(value)
    if value is not None and value_type is Decimal and not isinstance(value, Decimal): return Decimal(str(value))
    return value


def admin_page(session):
    st.title("Admin")
    st.warning("Changes are applied directly to the database. Row deletions cannot be undone.")
    table_name = st.selectbox("Select a table", inspect(session.bind).get_table_names(), key="admin_table_selection")
    # A data editor retains client-side state by key. Give it a fresh identity
    # when the chosen table changes so it can never show another table's rows.
    if st.session_state.get("admin_editor_table") != table_name:
        st.session_state.admin_editor_table = table_name
        st.session_state.admin_editor_revision = st.session_state.get("admin_editor_revision", 0) + 1
    table = Table(table_name, MetaData(), autoload_with=session.bind)
    primary_keys = [column.name for column in table.primary_key.columns]
    rows = [dict(row, **{"Delete row": False}) for row in session.execute(select(table)).mappings()]
    st.caption("Edit values in place. Tick **Delete row** and save to remove a row.")
    edited = st.data_editor(rows, num_rows="fixed", disabled=primary_keys, key=f"admin_editor_{table_name}_{st.session_state.admin_editor_revision}", hide_index=True, use_container_width=True)
    if st.button("Save changes", type="primary"):
        try:
            records = edited if isinstance(edited, list) else edited.to_dict("records")
            for row in records:
                where = [table.c[key] == _admin_value(table.c[key], row[key]) for key in primary_keys]
                if row.get("Delete row"):
                    session.execute(table.delete().where(*where))
                else:
                    values = {column.name: _admin_value(column, row[column.name]) for column in table.columns if column.name not in primary_keys}
                    session.execute(table.update().where(*where).values(**values))
            session.commit()
            st.session_state.saved_message = "Database changes saved."
            st.session_state.admin_editor_revision += 1
            st.rerun()
        except Exception as exc:
            session.rollback(); st.error(f"Could not save changes: {exc}")
            st.caption("Rows referenced elsewhere must be removed first, or use the normal deactivation controls.")
    with st.expander("Add a row"):
        st.caption("Use a JSON object only for uncommon administrative inserts.")
        payload = st.text_area("Row values (JSON)", placeholder='{"column_name": "value"}', key=f"admin_add_{table_name}")
        if st.button("Add row"):
            try:
                data = json.loads(payload)
                if not isinstance(data, dict): raise ValueError("JSON must be an object.")
                session.execute(table.insert().values(**{name: _admin_value(table.c[name], value) for name, value in data.items() if name in table.c}))
                session.commit()
                st.session_state.saved_message = "Row added."
                st.session_state.admin_editor_revision += 1
                st.rerun()
            except Exception as exc:
                session.rollback(); st.error(f"Could not add row: {exc}")


session = get_session()
try:
    if "app_view" not in st.session_state: st.session_state.app_view = "library"
    if message := st.session_state.pop("saved_message", None):
        st.toast(message, icon="✅", duration="short")
    log_tab, library_tab, admin_tab = st.tabs(["Log workouts", "Workouts & exercises", "Admin"])
    with library_tab:
        {"library": library_page, "workout_create": workout_create_page, "workout_edit": workout_edit_page, "exercise_create": exercise_create_page, "exercise_edit": exercise_edit_page}[st.session_state.app_view](session)
    with log_tab: history_page(session)
    with admin_tab: admin_page(session)
finally:
    session.close()
