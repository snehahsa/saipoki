"""Backward-compatible DB entrypoints — delegates to shared db package."""

from db.connection import db_connection, get_db_path, init_db

__all__ = ["db_connection", "get_db_path", "init_db"]
