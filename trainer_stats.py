"""Trainer XP, levels, battle outcome logging — shared by UI and TG battles."""

from __future__ import annotations

import json
import time
from typing import Any, Optional

from db.connection import table_columns

XP_PER_WIN = 1
WINS_PER_LEVEL = 3

STAT_COLUMNS = (
    "stats_wagered",
    "stats_battles",
    "stats_wins",
    "stats_losses",
    "stats_xp",
)


def level_from_xp(xp: int) -> int:
    """Level 1 at 0 XP; level 2 at 3 wins (3 XP); each +3 wins = +1 level."""
    return max(1, int(xp) // WINS_PER_LEVEL + 1)


def xp_progress(xp: int) -> dict[str, int]:
    """XP toward next level (0–2 of 3 within current level band)."""
    xp = max(0, int(xp))
    into_level = xp % WINS_PER_LEVEL
    return {
        "xp": xp,
        "level": level_from_xp(xp),
        "xp_into_level": into_level,
        "xp_to_next_level": WINS_PER_LEVEL - into_level if into_level else WINS_PER_LEVEL,
        "wins_per_level": WINS_PER_LEVEL,
    }


def ensure_trainer_stats_schema(conn) -> None:
    user_cols = table_columns(conn, "users")
    for col in STAT_COLUMNS:
        if col not in user_cols:
            conn.execute(
                f"ALTER TABLE users ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0"
            )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS battle_outcome_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id TEXT,
            winner_id TEXT NOT NULL,
            loser_id TEXT NOT NULL,
            bet INTEGER,
            source TEXT NOT NULL DEFAULT 'unknown',
            created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_battle_outcome_log_winner
        ON battle_outcome_log(winner_id, created_at DESC)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_user
        ON leaderboard_snapshots(telegram_id, created_at DESC)
        """
    )


def backfill_xp_from_wins(conn: sqlite3.Connection) -> None:
    if conn.execute(
        "SELECT 1 FROM app_meta WHERE key = ?", ("stats_xp_backfill_v1",)
    ).fetchone():
        return
    ensure_trainer_stats_schema(conn)
    conn.execute(
        """
        UPDATE users SET stats_xp = stats_wins
        WHERE stats_xp = 0 AND stats_wins > 0
        """
    )
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?, ?)",
        ("stats_xp_backfill_v1", "1"),
    )


def trainer_stats_row(row: sqlite3.Row | dict) -> dict[str, Any]:
    battles = int(row["stats_battles"] or 0)
    wins = int(row["stats_wins"] or 0)
    losses = int(row["stats_losses"] or 0)
    xp = int(row["stats_xp"] if "stats_xp" in row.keys() else wins)
    prog = xp_progress(xp)
    return {
        "stats_wagered": int(row["stats_wagered"] or 0),
        "stats_battles": battles,
        "stats_wins": wins,
        "stats_losses": losses,
        "stats_xp": xp,
        "level": prog["level"],
        "xp_into_level": prog["xp_into_level"],
        "xp_to_next_level": prog["xp_to_next_level"],
        "wins_per_level": WINS_PER_LEVEL,
        "win_rate": round(100 * wins / battles) if battles >= 3 else None,
    }


def record_battle_outcome_on_conn(
    conn: sqlite3.Connection,
    winner_id: int | str,
    loser_id: int | str,
    *,
    game_id: Optional[str] = None,
    bet: Optional[int] = None,
    source: str = "unknown",
) -> None:
    """Record PvP outcome for both players — UI and TG paths use this."""
    ensure_trainer_stats_schema(conn)
    now = int(time.time())
    winner_s = str(winner_id)
    loser_s = str(loser_id)

    for tg_id, wins, losses, xp_delta in (
        (winner_s, 1, 0, XP_PER_WIN),
        (loser_s, 0, 1, 0),
    ):
        conn.execute(
            """
            UPDATE users SET
                stats_battles = stats_battles + 1,
                stats_wins = stats_wins + ?,
                stats_losses = stats_losses + ?,
                stats_xp = stats_xp + ?,
                updated_at = ?
            WHERE telegram_id = ?
            """,
            (wins, losses, xp_delta, now, tg_id),
        )

    conn.execute(
        """
        INSERT INTO battle_outcome_log (game_id, winner_id, loser_id, bet, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (game_id, winner_s, loser_s, bet, source, now),
    )


def save_leaderboard_snapshot(
    conn: sqlite3.Connection,
    telegram_id: str,
    payload: dict[str, Any],
) -> None:
    ensure_trainer_stats_schema(conn)
    conn.execute(
        """
        INSERT INTO leaderboard_snapshots (telegram_id, snapshot_json, created_at)
        VALUES (?, ?, ?)
        """,
        (telegram_id, json.dumps(payload), int(time.time())),
    )
