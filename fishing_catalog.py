"""Extensible fishing quest definitions — referenced by map NPC flows and the cast API."""

from __future__ import annotations

from typing import Any, Optional

FISHING_CAST_DURATION_SEC = 60

# Map-builder / NPC flows may reference these ids via fishingQuest on a flow or gear default.
FISHING_QUESTS: dict[str, dict[str, Any]] = {
    "pokehub_key": {
        "id": "pokehub_key",
        "label": "Manager's Lost Key",
        "gear_required": "fishing_rod",
        "reward_gear": "hub_key",
        "win_mode": "salvage",
        "trials_min": 1,
        "trials_max": 3,
        "cast_duration_sec": FISHING_CAST_DURATION_SEC,
        "mode_status": {
            "fish": "Scanning for river fish…",
            "pokemon": "Luring water Pokémon…",
            "salvage": "Searching for metals & scrap…",
        },
        "empty_salvage": "Nothing metal hooked this time — keep trying Salvage by the water.",
        "empty_wrong_mode": "That catch type won't turn up a key — try Salvage near the canal.",
        "catch_title": "You found it!",
        "catch_message": (
            "Your line snags something heavy — a rusty PokéHub key glints in the shallows! "
            "It's back in your GEAR bar. Return it to the Manager."
        ),
        "start_quest_step": "fish_for_hub_key",
        "catch_quest_step": "collect_hub_key",
        "quest_id": "week1_vault_trail",
    },
}

FISHING_QUEST_IDS = frozenset(FISHING_QUESTS.keys())


def fishing_quest_for_client(quest_id: str) -> dict:
    quest = FISHING_QUESTS.get(quest_id)
    if not quest:
        return {}
    return {
        "id": quest["id"],
        "label": quest.get("label", quest_id),
        "gear_required": quest.get("gear_required"),
        "reward_gear": quest.get("reward_gear"),
        "win_mode": quest.get("win_mode", "salvage"),
        "cast_duration_sec": int(quest.get("cast_duration_sec", FISHING_CAST_DURATION_SEC)),
        "mode_status": dict(quest.get("mode_status") or {}),
        "start_quest_step": quest.get("start_quest_step"),
        "catch_quest_step": quest.get("catch_quest_step"),
        "quest_id": quest.get("quest_id"),
        "catch_title": quest.get("catch_title"),
        "catch_message": quest.get("catch_message"),
    }


def fishing_catalog_for_client() -> dict:
    return {qid: fishing_quest_for_client(qid) for qid in FISHING_QUESTS}


def get_fishing_quest(quest_id: str) -> Optional[dict]:
    return FISHING_QUESTS.get(str(quest_id or "").strip())
