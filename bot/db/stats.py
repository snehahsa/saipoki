"""Battle & economy stat tracking for leaderboards."""

from __future__ import annotations

import asyncio
import time

from bot.db.sqlite import db_connection, init_db
from db.connection import table_columns

STAT_COLUMNS = (
    "stats_wagered",
    "stats_battles",
    "stats_wins",
    "stats_losses",
    "stats_xp",
)


def _ensure_stats_columns_sync(conn) -> None:
    user_cols = table_columns(conn, "users")
    for col in STAT_COLUMNS:
        if col not in user_cols:
            conn.execute(
                f"ALTER TABLE users ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0"
            )


def _inc_stat_sync(telegram_id, column: str, delta: int) -> None:
    if column not in STAT_COLUMNS:
        raise ValueError(f"Invalid stat column: {column}")
    init_db()
    tg_id = str(telegram_id)
    with db_connection() as conn:
        _ensure_stats_columns_sync(conn)
        conn.execute(
            f"""
            UPDATE users
            SET {column} = {column} + ?, updated_at = ?
            WHERE telegram_id = ?
            """,
            (int(delta), int(time.time()), tg_id),
        )


async def record_wager(telegram_id, amount: int) -> None:
    if amount <= 0:
        return
    await asyncio.to_thread(_inc_stat_sync, telegram_id, "stats_wagered", int(amount))


async def record_battle_outcome(
    winner_id,
    loser_id,
    *,
    game_id=None,
    bet=None,
    source: str = "telegram",
) -> None:
    init_db()

    def sync():
        with db_connection() as conn:
            _ensure_stats_columns_sync(conn)
            try:
                import sys
                from pathlib import Path

                webp = Path(__file__).resolve().parent.parent.parent / "webp"
                if str(webp) not in sys.path:
                    sys.path.insert(0, str(webp))
                from trainer_stats import record_battle_outcome_on_conn

                record_battle_outcome_on_conn(
                    conn,
                    winner_id,
                    loser_id,
                    game_id=game_id,
                    bet=bet,
                    source=source,
                )
            except Exception:
                now = int(time.time())
                for tg_id, wins, losses, xp_delta in (
                    (str(winner_id), 1, 0, 20),
                    (str(loser_id), 0, 1, 0),
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

    await asyncio.to_thread(sync)
