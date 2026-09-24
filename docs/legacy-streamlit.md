# ProgreSQL 💪

A deliberately small, single-user Streamlit app for logging that you completed a workout and keeping an auditable history of each exercise's prescribed weight, maximum reps, and sets. It does not track individual sets, actual repetitions, or RPE.

## Architecture

SQLite is accessed through SQLAlchemy. Alembic owns the database schema; the application never calls `create_all` at runtime. The small service layer in `app/services.py` owns all state changes and transactions.

## Public cloud deployment

The deployed app uses a private username, Argon2 password hash, and TOTP code
from Microsoft Authenticator. It uses hosted PostgreSQL instead of the
ephemeral filesystem on Streamlit Community Cloud. See
`.streamlit/secrets.toml.example` for the required secrets; the real secrets
file is ignored by Git.

Before deploying:

1. Create a PostgreSQL database and save its SQLAlchemy URL as `database_url`.
2. Run `uv run python scripts/setup_local_auth.py`, scan the generated QR code
   with Microsoft Authenticator, and paste the printed secrets into your local
   `.streamlit/secrets.toml` file.
3. Put the database URL and three generated authentication secrets into
   Streamlit Community Cloud's Secrets settings.
4. Run the migrations against PostgreSQL once before first use (PowerShell):
   `$env:DATABASE_URL = 'postgresql+psycopg://...'; uv run alembic upgrade head`

Do not store `gym.db` in the public repository or rely on it for deployed
data. Keep periodic PostgreSQL backups from your database provider.

| Table | Purpose |
| --- | --- |
| `exercise` | Stable exercise identity and metadata. |
| `workout` / `workout_exercise` | A reusable workout definition with effective-dated exercise membership and order. |
| `workout_session` | The fact that a workout was performed on a date. |
| `exercise_settings_history` | Time-bounded weight / max-reps / sets prescriptions. |

Exercise identity is separate from state because its prescription changes over time. Settings use SCD Type 2 periods: adding a state closes the row covering its effective date and inserts a new row. Workout exercise membership and ordering use the same date-range approach. A workout session stores only a workout and date; when it is displayed, the app resolves both its exercise list and each exercise's state using `effective_from <= date < effective_to` (or no end date). This means old workouts always show the configuration that applied at the time, while a change made effective on a session's date is reflected in that session.

Future-dated changes are supported: the old state remains applicable until the new state's effective date.

## Local setup

This project uses [uv](https://docs.astral.sh/uv/). Install uv if it is not already available, then run:

```powershell
uv sync
uv run alembic upgrade head
uv run streamlit run app/main.py
```

The first command creates `.venv` and installs Streamlit, SQLAlchemy, Alembic, and pytest. The migration creates the local `gym.db` file.

Run the test suite with:

```powershell
uv run pytest
```

## Reset the local database

To discard all local workout data and recreate an empty database from the
migrations, run:

```powershell
Remove-Item .\gym.db
uv run alembic upgrade head
```

## Everyday workflow

1. Create exercises and add their initial state.
2. Create workouts and arrange their exercises.
3. Select a workout and date, then press **Log Workout**.
4. When your prescription changes, use **Change exercise state** with the effective date.

Normal UI flows intentionally do not delete exercises or workouts, protecting the history referenced by logged sessions.
