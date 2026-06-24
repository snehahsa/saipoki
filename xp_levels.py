"""Trainer level table — loaded from data/xp_levels.json."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from quests_catalog import QUEST_CATALOG

_ROOT = Path(__file__).resolve().parent
_XP_LEVELS_PATH = _ROOT / "data/xp_levels.json"


@lru_cache(maxsize=1)
def load_xp_config() -> dict[str, Any]:
    with open(_XP_LEVELS_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def xp_rewards() -> dict[str, int]:
    rewards = load_xp_config().get("xp_rewards") or {}
    return {
        "quest_step": int(rewards.get("quest_step", 5)),
        "battle_win": int(rewards.get("battle_win", 20)),
    }


def level_table() -> list[dict[str, Any]]:
    levels = load_xp_config().get("levels") or []
    return sorted(levels, key=lambda entry: int(entry.get("level", 0)))


def quest_step_ids(quest_id: str) -> set[str]:
    for quest in QUEST_CATALOG:
        if quest.get("quest_id") == quest_id:
            steps = quest.get("steps") or []
            return {str(step["id"]) for step in steps if step.get("id")}
    return set()


def is_quest_complete(quest_id: str, quest_progress: dict[str, Any]) -> bool:
    required = quest_step_ids(quest_id)
    if not required:
        return False
    completed = set(quest_progress.get("completed_steps") or [])
    return required <= completed


def _meets_level_requirements(
    entry: dict[str, Any],
    wins: int,
    quest_progress: dict[str, Any],
) -> bool:
    if wins < int(entry.get("required_wins", 0)):
        return False
    for quest_id in entry.get("required_quests") or []:
        if not is_quest_complete(str(quest_id), quest_progress):
            return False
    return True


def compute_level(wins: int, quest_progress: dict[str, Any]) -> int:
    achieved = 0
    for entry in level_table():
        if _meets_level_requirements(entry, wins, quest_progress):
            achieved = int(entry["level"])
        else:
            break
    return achieved


def level_entry(level: int) -> dict[str, Any] | None:
    for entry in level_table():
        if int(entry.get("level", -1)) == level:
            return entry
    return None


def next_level_entry(level: int) -> dict[str, Any] | None:
    for entry in level_table():
        if int(entry.get("level", -1)) > level:
            return entry
    return None


def level_progress(
    wins: int,
    xp: int,
    quest_progress: dict[str, Any],
) -> dict[str, Any]:
    wins = max(0, int(wins))
    xp = max(0, int(xp))
    level = compute_level(wins, quest_progress)
    current = level_entry(level) or level_table()[0]
    nxt = next_level_entry(level)

    floor_xp = int(current.get("xp_milestone", 0))
    if nxt:
        ceiling_xp = int(nxt.get("xp_milestone", floor_xp + 1))
        xp_into = max(0, xp - floor_xp)
        xp_span = max(1, ceiling_xp - floor_xp)
        xp_to_next = max(0, ceiling_xp - xp)
    else:
        xp_into = max(0, xp - floor_xp)
        xp_span = max(1, xp_into or 1)
        xp_to_next = 0

    blocking_quests: list[str] = []
    wins_to_next = 0
    if nxt:
        wins_to_next = max(0, int(nxt.get("required_wins", 0)) - wins)
        for quest_id in nxt.get("required_quests") or []:
            if not is_quest_complete(str(quest_id), quest_progress):
                blocking_quests.append(str(quest_id))

    return {
        "level": level,
        "level_title": str(current.get("title") or f"Level {level}"),
        "level_description": str(current.get("description") or ""),
        "stats_xp": xp,
        "xp_milestone": floor_xp,
        "xp_into_level": min(xp_into, xp_span),
        "xp_span": xp_span,
        "xp_to_next_level": xp_to_next,
        "next_level": int(nxt["level"]) if nxt else None,
        "next_level_title": str(nxt.get("title") or "") if nxt else None,
        "wins_to_next_level": wins_to_next,
        "blocking_quests": blocking_quests,
    }


def xp_config_for_client() -> dict[str, Any]:
    return {
        "xp_rewards": xp_rewards(),
        "levels": [
            {
                "level": int(entry.get("level", 0)),
                "title": entry.get("title", ""),
                "required_wins": int(entry.get("required_wins", 0)),
                "required_quests": list(entry.get("required_quests") or []),
                "xp_milestone": int(entry.get("xp_milestone", 0)),
                "description": entry.get("description", ""),
            }
            for entry in level_table()
        ],
    }
