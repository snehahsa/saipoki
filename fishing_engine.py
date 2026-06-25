"""Server-authoritative fishing cast sessions and trial-based rewards."""

from __future__ import annotations

import secrets
import sqlite3
import time
from typing import Any, Optional

from fishing_catalog import FISHING_CAST_DURATION_SEC, get_fishing_quest
from gear_catalog import GEAR_ITEM_IDS, grant_gear_to_slots, normalize_gear_slots
from quest_engine import complete_quest_step, parse_quest_progress


def _default_fishing_state() -> dict[str, Any]:
    return {
        "win_trial": 0,
        "salvage_casts": 0,
        "found": False,
        "session": None,
    }


def parse_fishing_bucket(raw: Any) -> dict[str, Any]:
    state = _default_fishing_state()
    if not isinstance(raw, dict):
        return state
    try:
        win = int(raw.get("win_trial") or 0)
    except (TypeError, ValueError):
        win = 0
    if 1 <= win <= 3:
        state["win_trial"] = win
    try:
        state["salvage_casts"] = max(0, int(raw.get("salvage_casts") or 0))
    except (TypeError, ValueError):
        state["salvage_casts"] = 0
    state["found"] = bool(raw.get("found"))
    session = raw.get("session")
    if isinstance(session, dict) and session.get("id"):
        state["session"] = {
            "id": str(session["id"]),
            "mode": str(session.get("mode") or ""),
            "started_at": int(session.get("started_at") or 0),
            "ends_at": int(session.get("ends_at") or 0),
            "quest_id": str(session.get("quest_id") or ""),
        }
    return state


def parse_fishing_progress(raw: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for key, value in raw.items():
        qid = str(key).strip()
        if qid:
            out[qid] = parse_fishing_bucket(value)
    return out


def merge_quest_progress_fishing(progress: dict, fishing: dict[str, dict[str, Any]]) -> dict:
    merged = dict(progress)
    merged["fishing"] = fishing
    return merged


def _load_row(conn: sqlite3.Connection, telegram_id: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT quest_progress, gear_slots FROM users WHERE telegram_id = ?",
        (telegram_id,),
    ).fetchone()


def _save_progress(conn: sqlite3.Connection, telegram_id: str, progress: dict) -> None:
    import json

    now = int(time.time())
    conn.execute(
        "UPDATE users SET quest_progress = ?, updated_at = ? WHERE telegram_id = ?",
        (json.dumps(progress), now, telegram_id),
    )


def _save_gear_slots(conn: sqlite3.Connection, telegram_id: str, slots: list) -> None:
    import json

    now = int(time.time())
    conn.execute(
        "UPDATE users SET gear_slots = ?, updated_at = ? WHERE telegram_id = ?",
        (json.dumps(slots), now, telegram_id),
    )


def fishing_state_for_user(progress_raw, quest_key: str) -> dict[str, Any]:
    progress = parse_quest_progress(progress_raw)
    fishing = parse_fishing_progress(progress.get("fishing"))
    return fishing.get(quest_key) or _default_fishing_state()


def fishing_progress_public(state: dict[str, Any]) -> dict[str, Any]:
    """Client-safe snapshot — never exposes win_trial."""
    return {
        "found": bool(state.get("found")),
        "casting": bool(state.get("session")),
        "salvage_active": bool(state.get("session")),
    }


def start_fishing_cast(
    conn: sqlite3.Connection,
    telegram_id: str,
    *,
    quest_key: str,
    mode: str,
    gear_id: str,
) -> dict[str, Any]:
    quest = get_fishing_quest(quest_key)
    if not quest:
        return {"ok": False, "error": "Unknown fishing quest"}

    gear_required = str(quest.get("gear_required") or "")
    if gear_id != gear_required or gear_id not in GEAR_ITEM_IDS:
        return {"ok": False, "error": "Wrong gear equipped"}

    row = _load_row(conn, telegram_id)
    if row is None:
        return {"ok": False, "error": "User not found"}

    slots = normalize_gear_slots(row["gear_slots"] if "gear_slots" in row.keys() else None)
    if gear_required not in slots:
        return {"ok": False, "error": "Required gear not owned"}

    reward_gear = str(quest.get("reward_gear") or "")
    if reward_gear in slots:
        return {"ok": False, "error": "Already found the reward"}

    progress = parse_quest_progress(row["quest_progress"])
    fishing = parse_fishing_progress(progress.get("fishing"))
    state = fishing.get(quest_key) or _default_fishing_state()

    if state.get("found") or reward_gear in slots:
        return {"ok": False, "error": "Quest already complete"}

    active = state.get("session")
    if active and int(active.get("ends_at") or 0) > int(time.time()):
        return {"ok": False, "error": "Already casting"}

    mode = str(mode or "").strip()
    win_mode = str(quest.get("win_mode") or "salvage")
    mode_labels = quest.get("mode_status") or {}
    status_label = str(mode_labels.get(mode) or mode_labels.get(win_mode) or "Fishing…")

    duration = int(quest.get("cast_duration_sec") or FISHING_CAST_DURATION_SEC)
    now = int(time.time())
    session_id = secrets.token_hex(12)
    state["session"] = {
        "id": session_id,
        "mode": mode,
        "started_at": now,
        "ends_at": now + duration,
        "quest_id": quest_key,
    }
    fishing[quest_key] = state
    progress = merge_quest_progress_fishing(progress, fishing)
    _save_progress(conn, telegram_id, progress)

    start_step = quest.get("start_quest_step")
    if start_step and mode == win_mode:
        step_result = complete_quest_step(conn, telegram_id, str(start_step))
        if step_result.get("ok"):
            progress = step_result.get("quest_progress") or progress

    return {
        "ok": True,
        "session_id": session_id,
        "duration_ms": duration * 1000,
        "status_label": status_label,
        "wrong_mode": mode != win_mode,
        "quest_key": quest_key,
        "quest_progress": progress,
    }


def complete_fishing_cast(
    conn: sqlite3.Connection,
    telegram_id: str,
    *,
    session_id: str,
) -> dict[str, Any]:
    row = _load_row(conn, telegram_id)
    if row is None:
        return {"ok": False, "error": "User not found"}

    progress = parse_quest_progress(row["quest_progress"])
    fishing = parse_fishing_progress(progress.get("fishing"))
    slots = normalize_gear_slots(row["gear_slots"] if "gear_slots" in row.keys() else None)

    matched_key = None
    state = None
    for key, bucket in fishing.items():
        session = bucket.get("session")
        if session and str(session.get("id")) == str(session_id):
            matched_key = key
            state = bucket
            break

    if not matched_key or not state:
        return {"ok": False, "error": "Invalid or expired session"}

    quest = get_fishing_quest(matched_key)
    if not quest:
        return {"ok": False, "error": "Unknown fishing quest"}

    session = state["session"]
    now = int(time.time())
    ends_at = int(session.get("ends_at") or 0)
    if now + 1 < ends_at:
        return {"ok": False, "error": "Cast still in progress", "wait_ms": (ends_at - now) * 1000}

    mode = str(session.get("mode") or "")
    win_mode = str(quest.get("win_mode") or "salvage")
    reward_gear = str(quest.get("reward_gear") or "")

    state["session"] = None
    caught = False
    newly_granted = False
    message = str(quest.get("empty_wrong_mode") or "Nothing useful this time.")

    if mode == win_mode and not state.get("found") and reward_gear not in slots:
        import random

        if not state.get("win_trial"):
            tmin = int(quest.get("trials_min") or 1)
            tmax = int(quest.get("trials_max") or 3)
            state["win_trial"] = random.randint(tmin, tmax)

        state["salvage_casts"] = int(state.get("salvage_casts") or 0) + 1
        if state["salvage_casts"] == state["win_trial"]:
            slots, newly_granted = grant_gear_to_slots(slots, reward_gear)
            if newly_granted or reward_gear in slots:
                caught = True
                state["found"] = True
                message = str(quest.get("catch_message") or "You found something!")
                _save_gear_slots(conn, telegram_id, slots)
    elif mode == win_mode:
        message = str(quest.get("empty_salvage") or "Keep trying…")

    fishing[matched_key] = state
    progress = merge_quest_progress_fishing(progress, fishing)
    _save_progress(conn, telegram_id, progress)

    quest_steps: list[str] = []
    if caught:
        catch_step = quest.get("catch_quest_step")
        if catch_step:
            result = complete_quest_step(conn, telegram_id, str(catch_step))
            if result.get("ok"):
                progress = result.get("quest_progress") or progress
                if result.get("newly_completed"):
                    quest_steps.append(str(catch_step))

    return {
        "ok": True,
        "caught": caught,
        "reward_gear": reward_gear if caught else None,
        "newly_granted": newly_granted,
        "message": message,
        "catch_title": quest.get("catch_title") if caught else None,
        "gear_slots": slots,
        "quest_progress": progress,
        "quest_steps": quest_steps,
        "quest_key": matched_key,
    }
