"""Avatar shop pricing — costs live on the world map (editable in map builder)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

DEFAULT_SKIN = "009"
SKINS = [f"{i:03d}" for i in range(1, 84)]

STARTING_BALANCE = int(os.getenv("STARTING_BALANCE", os.getenv("START_BALANCE", "5000")))
TEST_STARTING_BALANCE = int(os.getenv("TEST_STARTING_BALANCE", str(STARTING_BALANCE)))
VENDING_SPIN_FIRST_COST = int(os.getenv("VENDING_SPIN_FIRST_COST", "1000"))
VENDING_SPIN_REPEAT_COST = int(os.getenv("VENDING_SPIN_REPEAT_COST", "2000"))


def vending_spin_cost(spin_count: int) -> int:
    return VENDING_SPIN_FIRST_COST if int(spin_count or 0) <= 0 else VENDING_SPIN_REPEAT_COST


def tier_default_cost(skin: str) -> int:
    """Creative default tiers when map builder has not set a price."""
    if skin == DEFAULT_SKIN:
        return 0
    try:
        n = int(skin)
    except ValueError:
        return 100
    if n <= 5:
        return 0
    if n <= 20:
        return 40
    if n <= 40:
        return 80
    if n <= 60:
        return 150
    return 250


def default_avatar_costs() -> dict[str, int]:
    return {skin: tier_default_cost(skin) for skin in SKINS}


def load_avatar_costs_from_map(map_path: Path) -> dict[str, int]:
    costs = default_avatar_costs()
    if not map_path.is_file():
        return costs
    try:
        data = json.loads(map_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return costs
    stored = data.get("avatarCosts")
    if not isinstance(stored, dict):
        return costs
    for skin in SKINS:
        raw = stored.get(skin)
        if raw is None:
            continue
        try:
            costs[skin] = max(0, int(raw))
        except (TypeError, ValueError):
            continue
    return costs


def parse_owned_skins(raw, current_skin: Optional[str] = None) -> list[str]:
    owned: list[str] = []
    if raw:
        if isinstance(raw, list):
            items = raw
        else:
            try:
                items = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                items = []
        if isinstance(items, list):
            owned = [str(s).strip() for s in items if str(s).strip() in SKINS]

    if DEFAULT_SKIN not in owned:
        owned.insert(0, DEFAULT_SKIN)
    if current_skin and current_skin in SKINS and current_skin not in owned:
        owned.append(current_skin)
    return list(dict.fromkeys(owned))


def owned_skins_json(owned: list[str]) -> str:
    return json.dumps(list(dict.fromkeys(s for s in owned if s in SKINS)))


def skin_list_price(skin: str, costs: dict[str, int]) -> int:
    return max(0, int(costs.get(skin, tier_default_cost(skin))))


def purchase_cost(skin: str, owned_skins: list[str], costs: dict[str, int]) -> int:
    if skin not in SKINS:
        return 0
    if skin in owned_skins:
        return 0
    return skin_list_price(skin, costs)
