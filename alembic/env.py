from logging.config import fileConfig
import os
from pathlib import Path
import tomllib
from alembic import context
from sqlalchemy import engine_from_config, pool
from app.db import Base
import app.models  # noqa: F401

config = context.config
# In deployment, migrations target the same hosted PostgreSQL database as the
# app. Locally, read the ignored Streamlit secrets file so credentials never
# need to be pasted into a shell command. An explicit environment variable
# still takes precedence for CI or other deployment tooling.
local_secrets_path = Path(__file__).resolve().parent.parent / ".streamlit" / "secrets.toml"
local_database_url = None
if local_secrets_path.exists():
    with local_secrets_path.open("rb") as secrets_file:
        local_database_url = tomllib.load(secrets_file).get("database_url")
if database_url := os.environ.get("DATABASE_URL") or local_database_url:
    config.set_main_option("sqlalchemy.url", database_url)
if config.config_file_name:
    fileConfig(config.config_file_name)
target_metadata = Base.metadata

def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()

def run_migrations_online() -> None:
    connectable = engine_from_config(config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
