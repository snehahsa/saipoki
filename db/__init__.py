"""Shared database access (SQLite locally, PostgreSQL on Railway)."""

from db.connection import (
    db_connection,
    get_db_connection,
    get_db_path,
    init_db,
    is_postgres,
    table_columns,
)

__all__ = [
    "db_connection",
    "get_db_connection",
    "get_db_path",
    "init_db",
    "is_postgres",
    "table_columns",
]
