"""SQLite persistence for balances, battles, and exclusive winners."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, Optional

from bot.db.sqlite import db_connection, init_db
from bot.utils.config_reader import config

QUEST_PROGRESS_DEFAULT = '{"completed_steps":[],"removed_quests":[]}'


async def _run(func, *args, **kwargs):
    return await asyncio.to_thread(func, *args, **kwargs)


def _user_row_to_dict(row) -> dict:
    return dict(row) if row else {}


# USERS


def _ensure_user_sync(tg_userid, name=None, username=None):
    init_db()
    tg_id = str(tg_userid)
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE telegram_id = ?", (tg_id,)
        ).fetchone()
        if row:
            return _user_row_to_dict(row)

        now = int(time.time())
        name = name or f"Player_{tg_userid}"
        username = username or f"player_{tg_userid}"
        conn.execute(
            """
            INSERT INTO users (
                telegram_id, username, display_name, skin, badges,
                quest_progress, holds, vault, balance, created_at, updated_at
            ) VALUES (?, ?, ?, NULL, '[]', ?, '[]', '[]', ?, ?, ?)
            """,
            (
                tg_id,
                username,
                name,
                QUEST_PROGRESS_DEFAULT,
                config.start_balance,
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM users WHERE telegram_id = ?", (tg_id,)
        ).fetchone()
        return _user_row_to_dict(row)


async def ensure_user(tg_userid, name=None, username=None):
    return await _run(_ensure_user_sync, tg_userid, name, username)


def _credit_welcome_balance_sync(tg_userid) -> bool:
    """One-time starter Chips for web-only accounts that never hit /start."""
    init_db()
    tg_id = str(tg_userid)
    with db_connection() as conn:
        row = conn.execute(
            "SELECT balance FROM users WHERE telegram_id = ?", (tg_id,)
        ).fetchone()
        if row is None or int(row["balance"] or 0) != 0:
            return False
        conn.execute(
            """
            UPDATE users
            SET balance = ?, updated_at = ?
            WHERE telegram_id = ? AND balance = 0
            """,
            (config.start_balance, int(time.time()), tg_id),
        )
        return True


async def credit_welcome_balance(tg_userid) -> bool:
    return await _run(_credit_welcome_balance_sync, tg_userid)


async def is_user_exist(tg_userid):
    init_db()

    def sync():
        with db_connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM users WHERE telegram_id = ?", (str(tg_userid),)
            ).fetchone()
            return row is not None

    return await _run(sync)


# GAME


def _row_to_game_doc(row) -> dict:
    state = json.loads(row["state_json"])
    state["_id"] = row["id"]
    state["bet"] = row["bet"]
    state["winner"] = row["winner"]
    state["creation_time"] = row["creation_time"]
    return state


def _create_new_game_sync(game_info: dict) -> str:
    init_db()
    from bot.utils.callbacks import new_game_id

    game_id = new_game_id()
    player1_id = game_info["player1"]["id"]
    player2_id = game_info["player2"]["id"]
    bet = game_info.get("bet")
    creation_time = game_info.get("creation_time", time.time())

    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO battle_games (
                id, player1_id, player2_id, bet, winner, creation_time, state_json
            ) VALUES (?, ?, ?, ?, NULL, ?, ?)
            """,
            (
                game_id,
                player1_id,
                player2_id,
                bet,
                creation_time,
                json.dumps(game_info),
            ),
        )
    return game_id


async def create_new_game(game_info):
    return await _run(_create_new_game_sync, game_info)


def _get_game_by_id_sync(game_id) -> Optional[dict]:
    init_db()
    game_id = str(game_id)
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM battle_games WHERE id = ?", (game_id,)
        ).fetchone()
        if not row and len(game_id) < 36:
            row = conn.execute(
                """
                SELECT * FROM battle_games
                WHERE id LIKE ?
                ORDER BY creation_time DESC
                LIMIT 1
                """,
                (f"{game_id}%",),
            ).fetchone()
        if not row:
            return None
        return _row_to_game_doc(row)


async def get_game_by_id(game_id):
    return await _run(_get_game_by_id_sync, game_id)


def _update_game_sync(game_id, game_info: dict):
    init_db()
    game_id = str(game_id)
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM battle_games WHERE id = ?", (game_id,)
        ).fetchone()
        if not row:
            return

        state = json.loads(row["state_json"])
        state.update(game_info)
        winner = state.get("winner", row["winner"])
        bet = state.get("bet", row["bet"])

        conn.execute(
            """
            UPDATE battle_games
            SET state_json = ?, bet = ?, winner = ?
            WHERE id = ?
            """,
            (json.dumps(state), bet, winner, game_id),
        )


async def update_game(game_id, game_info):
    await _run(_update_game_sync, game_id, game_info)


async def get_exclusive_winners():
    init_db()

    def sync():
        with db_connection() as conn:
            rows = conn.execute(
                """
                SELECT telegram_id AS userid, wins, name, username
                FROM exclusive_winners
                ORDER BY wins DESC
                LIMIT 10
                """
            ).fetchall()
            return [dict(row) for row in rows]

    return await _run(sync)


async def get_user_balance(tg_userid):
    init_db()

    def sync():
        with db_connection() as conn:
            row = conn.execute(
                "SELECT balance FROM users WHERE telegram_id = ?", (str(tg_userid),)
            ).fetchone()
            if row is None:
                return None
            return int(row["balance"] or 0)

    balance = await _run(sync)
    if balance is None:
        return 0
    return balance


async def get_user_pin(tg_userid) -> Optional[str]:
    init_db()

    def sync():
        with db_connection() as conn:
            row = conn.execute(
                "SELECT pin FROM users WHERE telegram_id = ?", (str(tg_userid),)
            ).fetchone()
            if row is None:
                return None
            pin = row["pin"] if "pin" in row.keys() else None
            if pin and str(pin).isdigit() and len(str(pin)) == 3:
                return str(pin)
            return None

    return await _run(sync)


async def get_active_game(tg_userid):
    init_db()

    def sync():
        with db_connection() as conn:
            row = conn.execute(
                """
                SELECT * FROM battle_games
                WHERE winner IS NULL
                  AND (player1_id = ? OR player2_id = ?)
                ORDER BY creation_time DESC
                LIMIT 1
                """,
                (tg_userid, tg_userid),
            ).fetchone()
            if not row:
                return None
            return _row_to_game_doc(row)

    return await _run(sync)


def _adjust_balance_sync(tg_userid, delta: int):
    init_db()
    with db_connection() as conn:
        conn.execute(
            """
            UPDATE users
            SET balance = balance + ?, updated_at = ?
            WHERE telegram_id = ?
            """,
            (delta, int(time.time()), str(tg_userid)),
        )


async def deposit_tokens(tg_userid, amount, game_id=str(10000)):
    await ensure_user(tg_userid)
    await _run(_adjust_balance_sync, tg_userid, int(amount))


async def withdraw_tokens(tg_userid, amount, game_id=str(10000)):
    await ensure_user(tg_userid)
    await _run(_adjust_balance_sync, tg_userid, -int(amount))


async def deposit_burn(amount):
    init_db()

    def sync():
        with db_connection() as conn:
            row = conn.execute(
                "SELECT value FROM app_meta WHERE key = ?", ("prize_pool_burn",)
            ).fetchone()
            current = float(row["value"]) if row else 0.0
            conn.execute(
                """
                INSERT INTO app_meta (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                ("prize_pool_burn", str(current + float(amount))),
            )

    await _run(sync)


def _clear_realm_data_sync() -> dict[str, int]:
    init_db()
    with db_connection() as conn:
        users = int(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] or 0)
        battles = int(conn.execute("SELECT COUNT(*) FROM battle_games").fetchone()[0] or 0)
        exclusive = int(
            conn.execute("SELECT COUNT(*) FROM exclusive_winners").fetchone()[0] or 0
        )
        conn.execute("DELETE FROM users")
        conn.execute("DELETE FROM battle_games")
        conn.execute("DELETE FROM exclusive_winners")
        return {"users": users, "battles": battles, "exclusive_winners": exclusive}


async def clear_realm_data() -> dict[str, int]:
    return await _run(_clear_realm_data_sync)


async def clear_all_users() -> int:
    """Legacy wrapper — returns user count removed."""
    result = await clear_realm_data()
    return result["users"]


async def increase_exclusive_win(tg_userid):
    init_db()

    def sync():
        tg_id = str(tg_userid)
        with db_connection() as conn:
            row = conn.execute(
                "SELECT * FROM exclusive_winners WHERE telegram_id = ?", (tg_id,)
            ).fetchone()
            if row:
                conn.execute(
                    "UPDATE exclusive_winners SET wins = wins + 1 WHERE telegram_id = ?",
                    (tg_id,),
                )
                return

            user = conn.execute(
                "SELECT display_name, username FROM users WHERE telegram_id = ?", (tg_id,)
            ).fetchone()
            name = user["display_name"] if user else f"Player_{tg_userid}"
            username = user["username"] if user else f"player_{tg_userid}"
            conn.execute(
                """
                INSERT INTO exclusive_winners (telegram_id, wins, name, username)
                VALUES (?, 1, ?, ?)
                """,
                (tg_id, name, username),
            )

    await _run(sync)
