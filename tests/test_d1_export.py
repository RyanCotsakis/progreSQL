import sqlite3

import pytest
from sqlalchemy.orm import Session

from app.db import Base, make_engine
from app.services import create_exercise_with_initial_state
from datetime import date
from scripts.export_to_d1 import export, ROOT


def test_export_preserves_data_and_refuses_nonempty_import(tmp_path):
    source = tmp_path / "source.sqlite"
    url = f"sqlite:///{source}"
    engine = make_engine(url)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        create_exercise_with_initial_state(session, "Ryan's squat", "Legs", None, "Line 1\nLine 2", date(2026, 1, 1), "67.50", 8, 3)
    engine.dispose()
    result = export(url, tmp_path / "export")
    assert result["verified"]
    assert result["tables"]["exercise"] == 1
    with sqlite3.connect(":memory:") as target:
        target.executescript((ROOT / "migrations/0001_initial.sql").read_text())
        sql = (tmp_path / "export/import.sql").read_text()
        target.executescript(sql)
        assert target.execute("SELECT exercise_name,description FROM exercise").fetchone() == ("Ryan's squat", "Line 1\nLine 2")
        assert target.execute("SELECT weight FROM exercise_settings_history").fetchone()[0] == 67.5
        with pytest.raises(sqlite3.IntegrityError):
            target.executescript(sql)
        assert target.execute("SELECT COUNT(*) FROM exercise").fetchone()[0] == 1
    with pytest.raises(FileExistsError):
        export(url, tmp_path / "export")
