"""Wipe saved player / app data from the database (dev reset)."""

from __future__ import annotations

from typing import Any

from db.connection import is_postgres

# Child tables first, then users and meta.
_CLEAR_TABLES = (
    "market_listings",
    "deposits",
    "withdrawals",
    "kins_withdrawals",
    "kins_payments",
    "wallet_challenges",
    "poketab_messages",
    "poketab_user_state",
    "friend_requests",
    "friendships",
    "poketab_battle_invites",
    "poketab_card_daily_usage",
    "battle_outcome_log",
    "leaderboard_snapshots",
    "battle_games",
    "exclusive_winners",
    "users",
    "app_meta",
)


def _list_tables(conn: Any) -> set[str]:
    if is_postgres():
        rows = conn.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            """
        ).fetchall()
        return {str(row["table_name"]) for row in rows}

    rows = conn.execute(
        """
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        """
    ).fetchall()
    names: set[str] = set()
    for row in rows:
        name = row["name"] if isinstance(row, dict) or hasattr(row, "keys") else row[0]
        names.add(str(name))
    return names


def clear_all_saved_data(conn: Any) -> dict[str, int]:
    """Delete all saved rows. Returns {table: rows_deleted}."""
    existing = _list_tables(conn)
    cleared: dict[str, int] = {}

    for table in _CLEAR_TABLES:
        if table not in existing:
            continue
        before = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()
        count = int(before["n"] if isinstance(before, dict) or hasattr(before, "keys") else before[0])
        conn.execute(f"DELETE FROM {table}")
        cleared[table] = count

    return cleared
