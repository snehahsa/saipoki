"""Trainer XP, levels, battle outcome logging — shared by UI and TG battles."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Optional

from db.connection import table_columns
from quest_engine import parse_quest_progress
from xp_levels import level_progress, xp_rewards

STAT_COLUMNS = (
    "stats_wagered",
    "stats_battles",
    "stats_wins",
    "stats_losses",
    "stats_xp",
)

REWARDS = xp_rewards()
XP_PER_QUEST_STEP = REWARDS["quest_step"]
XP_PER_BATTLE_WIN = REWARDS["battle_win"]


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


def _fetch_stats_row(conn: sqlite3.Connection, telegram_id: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp, quest_progress
        FROM users WHERE telegram_id = ?
        """,
        (str(telegram_id),),
    ).fetchone()


def trainer_stats_row(
    row: sqlite3.Row | dict,
    quest_progress: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    battles = int(row["stats_battles"] or 0)
    wins = int(row["stats_wins"] or 0)
    losses = int(row["stats_losses"] or 0)
    xp = int(row["stats_xp"] if "stats_xp" in row.keys() else 0)
    if quest_progress is None:
        raw = row["quest_progress"] if "quest_progress" in row.keys() else None
        quest_progress = parse_quest_progress(raw)
    prog = level_progress(wins, xp, quest_progress)
    return {
        "stats_wagered": int(row["stats_wagered"] or 0),
        "stats_battles": battles,
        "stats_wins": wins,
        "stats_losses": losses,
        "stats_xp": xp,
        "level": prog["level"],
        "level_title": prog["level_title"],
        "level_description": prog["level_description"],
        "xp_into_level": prog["xp_into_level"],
        "xp_span": prog["xp_span"],
        "xp_to_next_level": prog["xp_to_next_level"],
        "next_level": prog["next_level"],
        "next_level_title": prog["next_level_title"],
        "wins_to_next_level": prog["wins_to_next_level"],
        "blocking_quests": prog["blocking_quests"],
        "win_rate": round(100 * wins / battles) if battles >= 3 else None,
    }


def _level_snapshot(conn: sqlite3.Connection, telegram_id: str) -> dict[str, Any]:
    row = _fetch_stats_row(conn, telegram_id)
    if not row:
        return {"level": 0, "stats_xp": 0}
    stats = trainer_stats_row(row)
    return {"level": stats["level"], "stats_xp": stats["stats_xp"]}


def award_xp_on_conn(
    conn: sqlite3.Connection,
    telegram_id: str,
    amount: int,
) -> dict[str, Any]:
    """Add XP and return trainer stats plus level-up metadata."""
    ensure_trainer_stats_schema(conn)
    amount = max(0, int(amount))
    tg_id = str(telegram_id)
    before = _level_snapshot(conn, tg_id)
    now = int(time.time())
    conn.execute(
        "UPDATE users SET stats_xp = stats_xp + ?, updated_at = ? WHERE telegram_id = ?",
        (amount, now, tg_id),
    )
    row = _fetch_stats_row(conn, tg_id)
    if not row:
        return {
            "xp_gained": amount,
            "leveled_up": False,
            "old_level": before["level"],
            "new_level": before["level"],
            "trainer_stats": None,
        }
    stats = trainer_stats_row(row)
    new_level = int(stats["level"])
    old_level = int(before["level"])
    return {
        "xp_gained": amount,
        "leveled_up": new_level > old_level,
        "old_level": old_level,
        "new_level": new_level,
        "trainer_stats": stats,
    }


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


def backfill_xp_rewards(conn: sqlite3.Connection) -> None:
    """Recalculate XP from wins (20 each) + completed quest steps (5 each)."""
    if conn.execute(
        "SELECT 1 FROM app_meta WHERE key = ?", ("stats_xp_v2_backfill",)
    ).fetchone():
        return
    ensure_trainer_stats_schema(conn)
    rows = conn.execute(
        "SELECT telegram_id, stats_wins, quest_progress, stats_xp FROM users"
    ).fetchall()
    for row in rows:
        progress = parse_quest_progress(row["quest_progress"])
        expected = int(row["stats_wins"] or 0) * XP_PER_BATTLE_WIN
        expected += len(progress.get("completed_steps") or []) * XP_PER_QUEST_STEP
        if int(row["stats_xp"] or 0) != expected:
            conn.execute(
                "UPDATE users SET stats_xp = ? WHERE telegram_id = ?",
                (expected, row["telegram_id"]),
            )
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?, ?)",
        ("stats_xp_v2_backfill", "1"),
    )


def record_battle_outcome_on_conn(
    conn: sqlite3.Connection,
    winner_id: int | str,
    loser_id: int | str,
    *,
    game_id: Optional[str] = None,
    bet: Optional[int] = None,
    source: str = "unknown",
) -> dict[str, Any]:
    """Record PvP outcome for both players — returns winner level-up metadata."""
    ensure_trainer_stats_schema(conn)
    now = int(time.time())
    winner_s = str(winner_id)
    loser_s = str(loser_id)
    winner_before = _level_snapshot(conn, winner_s)

    for tg_id, wins, losses in (
        (winner_s, 1, 0),
        (loser_s, 0, 1),
    ):
        conn.execute(
            """
            UPDATE users SET
                stats_battles = stats_battles + 1,
                stats_wins = stats_wins + ?,
                stats_losses = stats_losses + ?,
                updated_at = ?
            WHERE telegram_id = ?
            """,
            (wins, losses, now, tg_id),
        )

    winner_xp = award_xp_on_conn(conn, winner_s, XP_PER_BATTLE_WIN)

    conn.execute(
        """
        INSERT INTO battle_outcome_log (game_id, winner_id, loser_id, bet, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (game_id, winner_s, loser_s, bet, source, now),
    )

    return {
        "winner_xp_gained": XP_PER_BATTLE_WIN,
        "winner_leveled_up": winner_xp.get("leveled_up", False),
        "winner_old_level": winner_before["level"],
        "winner_new_level": winner_xp.get("new_level", winner_before["level"]),
        "winner_trainer_stats": winner_xp.get("trainer_stats"),
    }


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


# Backwards-compatible helpers used by leaderboard.py
def level_from_xp(xp: int, wins: int = 0, quest_progress: dict | None = None) -> int:
    progress = quest_progress or {"completed_steps": [], "removed_quests": []}
    return level_progress(wins, xp, progress)["level"]


def xp_progress(xp: int, wins: int = 0, quest_progress: dict | None = None) -> dict[str, int]:
    progress = quest_progress or {"completed_steps": [], "removed_quests": []}
    prog = level_progress(wins, xp, progress)
    return {
        "xp": xp,
        "level": prog["level"],
        "xp_into_level": prog["xp_into_level"],
        "xp_to_next_level": prog["xp_to_next_level"],
        "wins_per_level": prog["wins_to_next_level"] or 0,
    }
