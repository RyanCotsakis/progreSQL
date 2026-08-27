"""One-way, initial data import from the local SQLite database to PostgreSQL.

The SQLite database is opened only for reads. This script refuses to run if
any destination application table already contains data, preventing accidental
merges or overwrites.
"""

from __future__ import annotations

from pathlib import Path
import tomllib

from sqlalchemy import MetaData, create_engine, func, select, text


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_URL = f"sqlite:///{PROJECT_ROOT / 'gym.db'}"
SECRETS_PATH = PROJECT_ROOT / ".streamlit" / "secrets.toml"
TABLE_NAMES = (
    "exercise",
    "workout",
    "exercise_settings_history",
    "workout_exercise",
    "workout_session",
)


def get_database_url() -> str:
    with SECRETS_PATH.open("rb") as secrets_file:
        database_url = tomllib.load(secrets_file).get("database_url")
    if not database_url or "PASTE_YOUR_NEON" in database_url:
        raise RuntimeError(f"Set a real database_url in {SECRETS_PATH} first.")
    return database_url


def count_rows(connection, table) -> int:
    return connection.execute(select(func.count()).select_from(table)).scalar_one()


def reset_primary_key_sequences(connection, tables) -> None:
    for table in tables:
        for column in table.primary_key.columns:
            sequence = connection.execute(
                text("SELECT pg_get_serial_sequence(:table_name, :column_name)"),
                {"table_name": table.name, "column_name": column.name},
            ).scalar_one_or_none()
            maximum = connection.execute(select(func.max(column))).scalar_one()
            if sequence and maximum is not None:
                connection.execute(
                    text("SELECT setval(CAST(:sequence AS regclass), :value, true)"),
                    {"sequence": sequence, "value": maximum},
                )


def main() -> None:
    source = create_engine(SOURCE_URL)
    target = create_engine(get_database_url())
    source_metadata = MetaData()
    target_metadata = MetaData()
    source_metadata.reflect(bind=source, only=TABLE_NAMES)
    target_metadata.reflect(bind=target, only=TABLE_NAMES)
    source_tables = [source_metadata.tables[name] for name in TABLE_NAMES]
    target_tables = [target_metadata.tables[name] for name in TABLE_NAMES]

    with source.connect() as source_connection, target.begin() as target_connection:
        existing = {
            table.name: count_rows(target_connection, table)
            for table in target_tables
        }
        if any(existing.values()):
            raise RuntimeError(f"Destination is not empty; refusing to import: {existing}")

        copied = {}
        for source_table, target_table in zip(source_tables, target_tables, strict=True):
            rows = [dict(row) for row in source_connection.execute(select(source_table)).mappings()]
            if rows:
                target_connection.execute(target_table.insert(), rows)
            copied[target_table.name] = len(rows)

        reset_primary_key_sequences(target_connection, target_tables)
        copied_counts = {table.name: count_rows(target_connection, table) for table in target_tables}
        if copied != copied_counts:
            raise RuntimeError(f"Import verification failed: expected {copied}, got {copied_counts}")

    print(f"Imported and verified: {copied}")


if __name__ == "__main__":
    main()
