from __future__ import annotations

from pathlib import Path
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATABASE_URL = f"sqlite:///{PROJECT_ROOT / 'gym.db'}"


class Base(DeclarativeBase):
    pass


def _enable_sqlite_foreign_keys(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def make_engine(database_url: str = DEFAULT_DATABASE_URL) -> Engine:
    engine = create_engine(database_url, future=True)
    if database_url.startswith("sqlite"):
        event.listen(engine, "connect", _enable_sqlite_foreign_keys)
    return engine


engine = make_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)


def configure_database(database_url: str) -> None:
    """Point the application at a database before opening any sessions.

    Production supplies this URL through Streamlit secrets. Keeping SQLite as
    the default means local development and the test suite need no secrets.
    """
    global engine, SessionLocal
    if database_url == str(engine.url):
        return
    engine.dispose()
    engine = make_engine(database_url)
    SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)


def get_session() -> Session:
    return SessionLocal()
