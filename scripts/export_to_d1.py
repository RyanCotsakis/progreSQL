"""Read-only PostgreSQL/SQLite snapshot -> verified SQLite file and D1 SQL import.

Uses DATABASE_URL, or database_url from the existing local Streamlit secrets.
Never changes the source or contacts Cloudflare. Output contains private data.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tomllib

from sqlalchemy import MetaData, create_engine, select, text

ROOT = Path(__file__).resolve().parent.parent
TABLES = ("exercise", "workout", "exercise_settings_history", "workout_exercise", "workout_session")


def source_url() -> str:
    if value := os.environ.get("DATABASE_URL"):
        return value
    secrets = ROOT / ".streamlit" / "secrets.toml"
    if secrets.exists():
        with secrets.open("rb") as handle:
            if value := tomllib.load(handle).get("database_url"):
                return value
    raise RuntimeError("Set DATABASE_URL or configure database_url in local Streamlit secrets.")


def normalize(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ") if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


def export(url: str, output: Path) -> dict:
    # Refuse overwrites: each export is an independently reviewable snapshot.
    output.mkdir(parents=True, exist_ok=False)
    schema = (ROOT / "migrations" / "0001_initial.sql").read_text(encoding="utf-8")
    engine = create_engine(url, hide_parameters=True)
    snapshot: dict[str, list[dict]] = {}
    try:
        with engine.connect() as conn:
            if engine.dialect.name == "postgresql":
                conn = conn.execution_options(isolation_level="REPEATABLE READ")
                conn.execute(text("SET TRANSACTION READ ONLY"))
            elif engine.dialect.name == "sqlite":
                conn.exec_driver_sql("PRAGMA query_only=ON")
                conn.exec_driver_sql("BEGIN")
            else:
                raise RuntimeError("Only PostgreSQL and SQLite sources are supported.")
            metadata = MetaData()
            metadata.reflect(bind=conn, only=TABLES)
            for name in TABLES:
                table = metadata.tables[name]
                snapshot[name] = [
                    {key: normalize(value) for key, value in row.items()}
                    for row in conn.execute(select(table).order_by(*table.primary_key.columns)).mappings()
                ]
            conn.rollback()
    finally:
        engine.dispose()

    counts = {name: len(rows) for name, rows in snapshot.items()}
    database = output / "snapshot.sqlite"
    with sqlite3.connect(database) as target:
        target.execute("PRAGMA foreign_keys=ON")
        target.executescript(schema)
        sql = [
            "-- Apply migrations/0001_initial.sql first. Import into an EMPTY database only.",
            "CREATE TABLE _progresql_import_guard (empty INTEGER NOT NULL CHECK (empty=1));",
            "INSERT INTO _progresql_import_guard SELECT " + " AND ".join(f"NOT EXISTS(SELECT 1 FROM {name})" for name in TABLES) + ";",
        ]
        for name, rows in snapshot.items():
            columns = [r[1] for r in target.execute(f"PRAGMA table_info({name})")]
            if rows and set(rows[0]) != set(columns):
                raise RuntimeError(f"Source schema differs for {name}; review migrations before importing.")
            for row in rows:
                values = [row[col] for col in columns]
                statement = f"INSERT INTO {name} ({','.join(columns)}) VALUES "
                target.execute(statement + "(" + ",".join("?" for _ in columns) + ")", values)
                literals = [target.execute("SELECT quote(?)", (value,)).fetchone()[0] for value in values]
                sql.append(statement + "(" + ",".join(literals) + ");")
            actual = target.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
            if actual != counts[name]:
                raise RuntimeError(f"Row count mismatch in {name}.")
        if target.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("Foreign-key verification failed.")
        if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite integrity verification failed.")
        sql.append("DROP TABLE _progresql_import_guard;")

    sql_file = output / "import.sql"
    sql_file.write_text("\n".join(sql) + "\n", encoding="utf-8")
    # Replay the exact SQL file against a second database, not just the bound inserts.
    with sqlite3.connect(":memory:") as replay:
        replay.execute("PRAGMA foreign_keys=ON")
        replay.executescript(schema)
        replay.executescript(sql_file.read_text(encoding="utf-8"))
        with sqlite3.connect(database) as original:
            for name in TABLES:
                if replay.execute(f"SELECT * FROM {name} ORDER BY 1").fetchall() != original.execute(f"SELECT * FROM {name} ORDER BY 1").fetchall():
                    raise RuntimeError(f"SQL replay differs for {name}.")
        if replay.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("SQL replay foreign-key verification failed.")
    manifest = {"tables": counts, "verified": True, "sql_sha256": hashlib.sha256(sql_file.read_bytes()).hexdigest()}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "exports" / datetime.now().strftime("%Y%m%d-%H%M%S"))
    args = parser.parse_args()
    try:
        manifest = export(source_url(), args.output)
    except Exception as exc:
        # Connection exceptions can include credentials or SQL data: do not print them.
        print(f"Export failed ({type(exc).__name__}). Check source connectivity, schema, and that the output directory is new. No source data was changed.", file=sys.stderr)
        raise SystemExit(1) from None
    print(f"Verified export: {args.output.resolve()}")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
