from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
import sys

import pyotp

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import streamlit as st
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from streamlit_calendar import calendar
from sqlalchemy import MetaData, Table, inspect, select

from app.db import DEFAULT_DATABASE_URL, configure_database, get_session
from app.models import ExerciseSettingsHistory
from app.services import (
    ValidationError, create_exercise_with_initial_state, create_workout,
    deactivate_exercise, deactivate_workout, delete_workout_session, exercises, log_workout,
    last_recorded_workout_date, recent_sessions, session_details, sessions_on_date, set_exercise_state,
    states_for_date,
    set_workout_exercises, state_for_date, update_exercise, update_workout,
    workout_exercises_for_date, workouts,
)

st.set_page_config(page_title="ProgreSQL", page_icon="💪", layout="wide")

AUTH_SESSION_TIMEOUT = timedelta(hours=1)
APP_VERSION = "1.0.1"


def require_authorized_user() -> None:
    """Protect this single-user app with a password and authenticator code."""
    required_secrets = ("auth_username", "auth_password_hash", "auth_totp_secret")
    missing = [name for name in required_secrets if not st.secrets.get(name)]
    if missing:
        st.error("Authentication has not been configured. Run scripts/setup_local_auth.py locally.")
        st.stop()

    authenticated_at = st.session_state.get("authenticated_at")
    if st.session_state.get("authenticated") and isinstance(authenticated_at, datetime):
        if datetime.now() - authenticated_at >= AUTH_SESSION_TIMEOUT:
            st.session_state.clear()
            st.warning("Your session has expired. Please sign in again.")
        else:
            st.sidebar.caption(f"Signed in as {st.secrets.auth_username}")
            if st.sidebar.button("Sign out"):
                st.session_state.clear()
                st.rerun()
            return
    elif st.session_state.get("authenticated"):
        # Sessions created before the timeout was introduced must reauthenticate.
        st.session_state.clear()

    st.title("ProgreSQL")
    st.caption("Sign in with your password and Microsoft Authenticator code.")
    with st.form("login"):
        username = st.text_input("Username", autocomplete="username")
        password = st.text_input("Password", type="password", autocomplete="current-password")
        totp_code = st.text_input("Authenticator code", max_chars=6, autocomplete="one-time-code")
        submitted = st.form_submit_button("Sign in", type="primary")

    if submitted:
        password_hasher = PasswordHasher()
        try:
            password_ok = password_hasher.verify(st.secrets.auth_password_hash, password)
        except (InvalidHashError, VerificationError):
            password_ok = False
        username_ok = username.casefold() == str(st.secrets.auth_username).casefold()
        totp_ok = pyotp.TOTP(st.secrets.auth_totp_secret).verify(totp_code, valid_window=1)
        if username_ok and password_ok and totp_ok:
            st.session_state.authenticated = True
            st.session_state.authenticated_at = datetime.now()
            st.rerun()
        st.error("Invalid username, password, or authenticator code.")
    st.caption(f"Version {APP_VERSION}")
    st.stop()


require_authorized_user()
configure_database(st.secrets.get("database_url", DEFAULT_DATABASE_URL))


def flash(action, message="Saved."):
    try:
        action()
        st.session_state.saved_message = message
    except ValidationError as exc:
        st.error(str(exc))


def prepare_exercise_editor(table_key, exercise_ids):
    """Record a selected exercise before the dataframe-selection rerun."""
    selection = st.session_state.get(table_key, {}).get("selection", {})
    selected_rows = selection.get("rows", [])
    if not selected_rows:
        return
    st.session_state.edit_exercise_id = exercise_ids[selected_rows[0]]
    st.session_state.app_view = "exercise_edit"
    st.session_state.main_navigation = "Workouts & exercises"


def selectable_prescription_table(exercise_states, key):
    """Show prescriptions whose selected row opens the exercise editor."""
    rows = [
        {
            "Exercise": exercise.exercise_name,
            "Weight (kg)": float(state.weight) if state else "—",
            "Max reps": state.max_reps if state else "—",
            "Sets": state.sets if state else "—",
        }
        for exercise, state in exercise_states
    ]
    selectable_table(
        rows,
        key,
        on_select=lambda: prepare_exercise_editor(
            key, [exercise.exercise_id for exercise, _ in exercise_states]
        ),
    )


def prescription_table(session, items, on_date, key):
    states = states_for_date(session, [item.exercise_id for item in items], on_date)
    selectable_prescription_table(
        [(item.exercise, states.get(item.exercise_id)) for item in items], key
    )


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


def selectable_table(rows, key, on_select="rerun"):
    event = st.dataframe(rows, hide_index=True, width="stretch", key=key, on_select=on_select, selection_mode="single-row")
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
        current_states = states_for_date(session, [exercise.exercise_id for exercise in all_exercises], date.today())
        rows = []
        for exercise in all_exercises:
            state = current_states.get(exercise.exercise_id)
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
        st.dataframe([{"Date": s.workout_date, "Workout": s.workout.workout_name} for s in sessions], hide_index=True, width="stretch")
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
    # Preserve a deactivated exercise in this date's composition so historical
    # workout versions can still be viewed and amended without losing members.
    by_id = {exercise.exercise_id: exercise for exercise in exercises(session)}
    by_id.update({item.exercise_id: item.exercise for item in current})
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
        st.dataframe([{"Effective from": row.effective_from, "Effective to": row.effective_to or "—", "Weight (kg)": float(row.weight), "Max reps": row.max_reps, "Sets": row.sets} for row in history], hide_index=True, width="stretch")
    else:
        st.caption("No state changes yet.")
    last_session_date = last_recorded_workout_date(session)
    if history and last_session_date and last_session_date >= history[0].effective_from:
        chart_history = [row for row in history if row.effective_from <= last_session_date]
        if chart_history:
            chart_rows = [
                # A timezone-free midnight keeps Vega from converting a date
                # into a local time label (for example, "6 AM").
                {"Date": f"{row.effective_from.isoformat()}T00:00:00", "Weight (kg)": float(row.weight)}
                for row in chart_history
            ]
            # The final point extends the last prescription through the latest
            # recorded session, rather than leaving the chart at its last change.
            if chart_rows[-1]["Date"] != f"{last_session_date.isoformat()}T00:00:00":
                chart_rows.append({"Date": f"{last_session_date.isoformat()}T00:00:00", "Weight (kg)": chart_rows[-1]["Weight (kg)"]})
            highest_weight = max(row["Weight (kg)"] for row in chart_rows)
            chart_start = history[0].effective_from
            span_days = (last_session_date - chart_start).days
            tick_count = min(10, span_days + 1)
            tick_offsets = (
                [0]
                if tick_count == 1
                else sorted({round(index * span_days / (tick_count - 1)) for index in range(tick_count)})
            )
            # Supply the ticks explicitly: Vega otherwise may choose multiple
            # time-based ticks which format to the same calendar date.
            date_ticks = [f"{(chart_start + timedelta(days=offset)).isoformat()}T00:00:00" for offset in tick_offsets]
            st.subheader("Weight progression")
            st.vega_lite_chart(
                chart_rows,
                {
                    "mark": {"type": "line", "interpolate": "step-after", "point": True},
                    "encoding": {
                        "x": {
                            "field": "Date", "type": "temporal", "title": "Date",
                            "axis": {"format": "%d %b", "values": date_ticks, "labelOverlap": "greedy"},
                        },
                        "y": {"field": "Weight (kg)", "type": "quantitative", "title": "Weight (kg)", "scale": {"domain": [0, highest_weight]}},
                    },
                },
                width="stretch",
            )
    elif history:
        st.caption("Weight progression will appear after a workout session is logged for this period.")
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
        try:
            deactivate_exercise(session, exercise)
        except ValidationError as exc:
            st.toast(str(exc), icon="⚠️", duration="long")
        else:
            st.session_state.saved_message = "Exercise deleted."
            back_to_library()


def history_page(session):
    st.title("Log workouts")
    if "history_selected_date" not in st.session_state:
        st.session_state.history_selected_date = date.today()
    records = recent_sessions(session, 100)
    calendar_events = [
        {
            "id": str(record.workout_session_id),
            "title": record.workout.workout_name,
            "start": record.workout_date.isoformat(),
            "allDay": True,
            "backgroundColor": "#1976d2",
            "borderColor": "#1976d2",
            "extendedProps": {"workout_session_id": record.workout_session_id},
        }
        for record in records
    ]
    calendar_state = calendar(
        events=calendar_events,
        options={
            "initialView": "dayGridMonth",
            "initialDate": st.session_state.history_selected_date.isoformat(),
            "headerToolbar": {"left": "prev,next today", "center": "title", "right": ""},
            "firstDay": 1,
            "fixedWeekCount": False,
            "showNonCurrentDates": False,
            "navLinks": False,
            "editable": False,
            "selectable": False,
            "timeZone": "UTC",
            "height": "auto",
        },
        callbacks=["dateClick", "eventClick"],
        key="workout_calendar",
    )
    callback = calendar_state.get("callback") if calendar_state else None
    if callback == "dateClick":
        st.session_state.history_selected_date = date.fromisoformat(calendar_state["dateClick"]["date"][:10])
        st.session_state.pop("history_selected_session_id", None)
    elif callback == "eventClick":
        event = calendar_state["eventClick"]["event"]
        st.session_state.history_selected_date = date.fromisoformat(event["start"][:10])
        st.session_state.history_selected_session_id = int(event["extendedProps"]["workout_session_id"])

    selected_date = st.session_state.history_selected_date
    logged = sessions_on_date(session, selected_date)
    selected_session_id = st.session_state.get("history_selected_session_id")
    if selected_session_id and not any(record.workout_session_id == selected_session_id for record in logged):
        st.session_state.pop("history_selected_session_id", None)
        selected_session_id = None
    displayed_records = (
        [record for record in logged if record.workout_session_id == selected_session_id]
        if selected_session_id else logged
    )
    if displayed_records:
        st.subheader(f"Already logged on {selected_date:%d %B %Y}")
        for record in displayed_records:
            record, details = session_details(session, record.workout_session_id)
            st.markdown(f"#### {record.workout.workout_name}")
            st.write(record.workout.description or "No workout description.")
            if st.button("Delete entry", key=f"delete_session_{record.workout_session_id}"):
                try:
                    delete_workout_session(session, record.workout_session_id)
                except ValidationError as exc:
                    st.error(str(exc))
                else:
                    st.session_state.saved_message = "Workout entry deleted."
                    st.session_state.pop("history_selected_session_id", None)
                    st.rerun()
            selectable_prescription_table(
                details,
                key=f"logged_workout_exercises_{record.workout_session_id}",
            )
            st.markdown("**Session notes**")
            st.write(record.notes or "No session notes.")
    st.subheader(f"Log a workout on {selected_date:%A, %d %B %Y}")
    all_workouts = workouts(session)
    if all_workouts:
        selected = st.selectbox("Workout to log", all_workouts, format_func=lambda workout: workout.workout_name)
        items = workout_exercises_for_date(session, selected.workout_id, selected_date)
        if items:
            prescription_table(
                session,
                items,
                selected_date,
                key=f"new_workout_exercises_{selected.workout_id}_{selected_date.isoformat()}",
            )
            session_notes = st.text_area("Session notes (optional)", key=f"session_notes_{selected.workout_id}_{selected_date.isoformat()}")
            if st.button(f"Log {selected.workout_name} on {selected_date:%d %b}", type="primary"):
                flash(lambda: log_workout(session, selected.workout_id, selected_date, session_notes), "Workout logged.")
                st.rerun()
        else:
            st.info("This workout has no exercises configured for the selected date.")
    else:
        st.info("Create a workout first.")
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
    edited = st.data_editor(rows, num_rows="fixed", disabled=primary_keys, key=f"admin_editor_{table_name}_{st.session_state.admin_editor_revision}", hide_index=True, width="stretch")
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
    section = st.radio("Navigate", ["Log workouts", "Workouts & exercises", "Admin"], horizontal=True, label_visibility="collapsed", key="main_navigation")
    if section == "Workouts & exercises":
        {"library": library_page, "workout_create": workout_create_page, "workout_edit": workout_edit_page, "exercise_create": exercise_create_page, "exercise_edit": exercise_edit_page}[st.session_state.app_view](session)
    elif section == "Log workouts":
        history_page(session)
    else:
        admin_page(session)
finally:
    session.close()
