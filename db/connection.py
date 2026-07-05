"""SQLite + PostgreSQL connection wrapper with ? placeholder compatibility."""

from __future__ import annotations

import os
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Optional

from db.paths import monorepo_root, webp_root

_INIT_DONE = False


def database_url() -> Optional[str]:
    return os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")


def is_postgres() -> bool:
    url = database_url() or ""
    return url.startswith("postgres://") or url.startswith("postgresql://")


def _normalize_pg_url(url: str) -> str:
    if url.startswith("postgres://"):
        return "postgresql://" + url[len("postgres://") :]
    return url


def get_db_path() -> Path:
    env_path = os.getenv("DB_PATH") or os.getenv("SQLITE_DB_PATH")
    if env_path:
        raw = env_path
    elif Path("/data").is_dir() and os.access("/data", os.W_OK):
        # Railway / Docker volume — survives redeploys when mounted at /data
        raw = "/data/users.db"
    else:
        raw = str(webp_root() / "users.db")
    path = Path(raw)
    if not path.is_absolute():
        path = monorepo_root() / path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def table_columns(conn: Any, table: str) -> set[str]:
    if is_postgres():
        rows = conn.execute(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ?
            """,
            (table,),
        ).fetchall()
        return {row["column_name"] for row in rows}
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {row[1] for row in rows}


def _adapt_ddl(sql: str) -> str:
    sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
    sql = re.sub(r"\bAUTOINCREMENT\b", "", sql, flags=re.IGNORECASE)
    return sql


def _adapt_sql(sql: str) -> str:
    if not is_postgres():
        return sql

    adapted = sql
    if "INSERT OR IGNORE" in adapted:
        adapted = adapted.replace("INSERT OR IGNORE", "INSERT")
        if "friendships" in adapted and "ON CONFLICT" not in adapted.upper():
            adapted = adapted.rstrip().rstrip(";") + " ON CONFLICT (user_low, user_high) DO NOTHING"

    adapted = adapted.replace("?", "%s")

    upper = adapted.strip().upper()
    if upper.startswith("INSERT INTO POKETAB_BATTLE_INVITES") and "RETURNING" not in upper:
        adapted = adapted.rstrip().rstrip(";") + " RETURNING id"
    if upper.startswith("INSERT INTO POKETAB_MESSAGES") and "RETURNING" not in upper:
        adapted = adapted.rstrip().rstrip(";") + " RETURNING id"

    if "CREATE TABLE" in upper or "CREATE INDEX" in upper:
        adapted = _adapt_ddl(adapted)

    return adapted


class CompatCursor:
    def __init__(self, cursor: Any, postgres: bool, lastrowid: Optional[int] = None):
        self._cursor = cursor
        self._postgres = postgres
        self._lastrowid = lastrowid

    def fetchone(self) -> Any:
        return self._cursor.fetchone()

    def fetchall(self) -> list[Any]:
        return self._cursor.fetchall()

    @property
    def lastrowid(self) -> Optional[int]:
        if self._postgres:
            return self._lastrowid
        return self._cursor.lastrowid

    @property
    def rowcount(self) -> int:
        return self._cursor.rowcount


class CompatConnection:
    """Drop-in subset of sqlite3.Connection used across the codebase."""

    def __init__(self, raw: Any, postgres: bool):
        self._conn = raw
        self._postgres = postgres

    def execute(self, sql: str, params: Iterable[Any] | None = None):
        params = tuple(params or ())
        sql_adapted = _adapt_sql(sql)
        if self._postgres:
            import psycopg2.extras

            cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql_adapted, params or None)
            lastrowid = None
            if " RETURNING id" in sql_adapted.upper():
                row = cur.fetchone()
                if row:
                    lastrowid = row.get("id")
            return CompatCursor(cur, True, lastrowid=lastrowid)

        cur = self._conn.execute(sql_adapted, params)
        return CompatCursor(cur, False)

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "CompatConnection":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type:
            self.rollback()
        else:
            self.commit()
        self.close()
        return False


def _open_raw():
    if is_postgres():
        import psycopg2

        return psycopg2.connect(_normalize_pg_url(database_url()))

    path = get_db_path()
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def get_db_connection() -> CompatConnection:
    return CompatConnection(_open_raw(), is_postgres())


@contextmanager
def db_connection():
    conn = get_db_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    global _INIT_DONE
    if _INIT_DONE:
        return

    if is_postgres():
        from db.schema import init_postgres_schema

        with db_connection() as conn:
            init_postgres_schema(conn)
    else:
        from db.schema_sqlite import init_sqlite_schema

        with db_connection() as conn:
            init_sqlite_schema(conn)

    _INIT_DONE = True
