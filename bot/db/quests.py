"""Quest step completion from Telegram events."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from bot.db.sqlite import db_connection, init_db

_WEBP_DIR = Path(__file__).resolve().parents[2]
if not (_WEBP_DIR / "app.py").is_file() and (_WEBP_DIR / "webp" / "app.py").is_file():
    _WEBP_DIR = _WEBP_DIR / "webp"


def _quest_engine():
    webp_path = str(_WEBP_DIR)
    if webp_path not in sys.path:
        sys.path.insert(0, webp_path)
    from quest_engine import apply_quest_trigger, backfill_quest_triggers

    return apply_quest_trigger, backfill_quest_triggers


def _fire_trigger_sync(telegram_id, trigger: str) -> list[str]:
    apply_quest_trigger, _ = _quest_engine()
    init_db()
    tid = str(telegram_id)
    with db_connection() as conn:
        return apply_quest_trigger(conn, tid, trigger)


def _backfill_sync(telegram_id) -> list[str]:
    _, backfill_quest_triggers = _quest_engine()
    init_db()
    tid = str(telegram_id)
    with db_connection() as conn:
        return backfill_quest_triggers(conn, tid)


async def on_quest_trigger(telegram_id, trigger: str) -> list[str]:
    return await asyncio.to_thread(_fire_trigger_sync, telegram_id, trigger)


async def backfill_quests(telegram_id) -> list[str]:
    return await asyncio.to_thread(_backfill_sync, telegram_id)


async def on_telegram_battle_finished(player_ids) -> dict[str, list[str]]:
    """Complete quest steps for every participant in a finished battle."""
    results: dict[str, list[str]] = {}
    for player_id in player_ids:
        completed = await on_quest_trigger(player_id, "telegram_battle_finished")
        if completed:
            results[str(player_id)] = completed
    return results
