"""Shared quest progress helpers — used by Flask and the Telegram bot."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from quests_catalog import QUEST_IDS, QUEST_STEP_IDS, QUEST_TRIGGERS, STEP_TO_QUEST


def parse_quest_progress(raw) -> dict[str, Any]:
    default: dict[str, Any] = {"completed_steps": [], "removed_quests": [], "fishing": {}}
    if not raw:
        return default
    if isinstance(raw, dict):
        data = raw
    else:
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return default
    if not isinstance(data, dict):
        return default
    completed = data.get("completed_steps") or []
    removed = data.get("removed_quests") or []
    if not isinstance(completed, list):
        completed = []
    if not isinstance(removed, list):
        removed = []
    return {
        "completed_steps": [
            s for s in (str(x).strip() for x in completed) if s in QUEST_STEP_IDS
        ],
        "removed_quests": [
            q for q in (str(x).strip() for x in removed) if q in QUEST_IDS
        ],
        "fishing": data.get("fishing") if isinstance(data.get("fishing"), dict) else {},
    }


def _load_progress(conn: sqlite3.Connection, telegram_id: str) -> dict[str, list[str]] | None:
    row = conn.execute(
        "SELECT quest_progress FROM users WHERE telegram_id = ?",
        (telegram_id,),
    ).fetchone()
    if row is None:
        return None
    return parse_quest_progress(row["quest_progress"])


def _save_progress(
    conn: sqlite3.Connection,
    telegram_id: str,
    progress: dict[str, list[str]],
) -> None:
    now = int(time.time())
    conn.execute(
        "UPDATE users SET quest_progress = ?, updated_at = ? WHERE telegram_id = ?",
        (json.dumps(progress), now, telegram_id),
    )


def complete_quest_step(
    conn: sqlite3.Connection,
    telegram_id: str,
    step_id: str,
) -> dict[str, Any]:
    """Mark one quest step complete. Idempotent."""
    step_id = str(step_id).strip()
    if step_id not in QUEST_STEP_IDS:
        return {"ok": False, "error": "unknown_step", "newly_completed": False}

    quest_id = STEP_TO_QUEST.get(step_id, "")
    progress = _load_progress(conn, telegram_id)
    if progress is None:
        return {"ok": False, "error": "user_not_found", "newly_completed": False}
    if quest_id in progress["removed_quests"]:
        return {"ok": False, "error": "quest_removed", "newly_completed": False}

    if step_id in progress["completed_steps"]:
        return {
            "ok": True,
            "step_id": step_id,
            "quest_id": quest_id,
            "newly_completed": False,
            "quest_progress": progress,
        }

    progress["completed_steps"].append(step_id)
    _save_progress(conn, telegram_id, progress)

    xp_payload: dict[str, Any] = {}
    from trainer_stats import XP_PER_QUEST_STEP, award_xp_on_conn

    xp_payload = award_xp_on_conn(conn, telegram_id, XP_PER_QUEST_STEP)

    return {
        "ok": True,
        "step_id": step_id,
        "quest_id": quest_id,
        "newly_completed": True,
        "quest_progress": progress,
        **xp_payload,
    }


def apply_quest_trigger(
    conn: sqlite3.Connection,
    telegram_id: str,
    trigger: str,
) -> list[str]:
    """Complete every quest step registered to an external trigger."""
    trigger = str(trigger).strip()
    step_ids = QUEST_TRIGGERS.get(trigger) or []
    newly_completed: list[str] = []
    for step_id in step_ids:
        result = complete_quest_step(conn, telegram_id, step_id)
        if result.get("ok") and result.get("newly_completed"):
            newly_completed.append(step_id)
    return newly_completed


def _has_finished_telegram_battle(conn: sqlite3.Connection, telegram_id: str) -> bool:
    tid = str(telegram_id)
    row = conn.execute(
        """
        SELECT 1 FROM battle_games
        WHERE winner IS NOT NULL
          AND (CAST(player1_id AS TEXT) = ? OR CAST(player2_id AS TEXT) = ?)
        LIMIT 1
        """,
        (tid, tid),
    ).fetchone()
    return row is not None


def backfill_quest_triggers(conn: sqlite3.Connection, telegram_id: str) -> list[str]:
    """Apply triggers retroactively when historical data already satisfies them."""
    newly_completed: list[str] = []
    progress = _load_progress(conn, telegram_id)
    if progress is None:
        return newly_completed

    if "battle_game" not in progress["completed_steps"]:
        if _has_finished_telegram_battle(conn, telegram_id):
            newly_completed.extend(
                apply_quest_trigger(conn, telegram_id, "telegram_battle_finished")
            )
    return newly_completed
