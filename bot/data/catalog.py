"""Load PokéCard stats from poke.json (replaces dogemons.py for battles)."""

from __future__ import annotations

from functools import lru_cache
from typing import Dict, Optional

from bot.data.poke_registry import (
    catalog_id_for_name,
    is_catalog_id,
    load_card_catalog,
    pokemon_slug,
)
from bot.models.pokemon_base import PokemonBase
from bot.models.pokemon_types import PokemonType
from bot.models.spell import Spell


def _type_from_string(raw: str) -> PokemonType:
    value = (raw or "Basic").strip()
    for pokemon_type in PokemonType:
        if pokemon_type.value.lower() == value.lower():
            return pokemon_type
    return PokemonType.BASIC


def _spells_from_json(spells_data: list) -> list[Spell]:
    spells = []
    for spell in spells_data or []:
        spells.append(
            Spell(
                name=spell["name"],
                attack=int(spell.get("attack") or 0),
                is_defence=bool(spell.get("is_defence")),
                max_count=int(spell.get("max_count") or 1),
            )
        )
    return spells


def card_to_pokemon_base(card: dict) -> PokemonBase:
    card_id = str(card.get("id") or "").strip()
    return PokemonBase(
        card_id=card_id,
        name=card.get("name") or card_id,
        url=card.get("url") or "",
        hp=int(card.get("hp") or 0),
        lvl=int(card.get("lvl") or 1),
        type=_type_from_string(card.get("type") or "Basic"),
        spells=_spells_from_json(card.get("spells") or []),
    )


@lru_cache(maxsize=1)
def get_card_catalog_map() -> Dict[str, PokemonBase]:
    return {
        card_id: card_to_pokemon_base(card)
        for card_id, card in load_card_catalog().items()
    }


def get_pokemon_base(card_id: str) -> PokemonBase:
    base = get_card_catalog_map().get(card_id)
    if base is None:
        raise KeyError(f"Unknown card id: {card_id}")
    return base


def card_display_name(card_id: str) -> str:
    base = get_card_catalog_map().get(card_id)
    return base.name if base else card_id


def resolve_card_id(key_or_name: str) -> str:
    """Resolve catalog id from poke-NNN id or legacy display name."""
    value = str(key_or_name or "").strip()
    if not value:
        raise KeyError("Empty card id")

    if is_catalog_id(value) and value in get_card_catalog_map():
        return value

    by_name = catalog_id_for_name(value)
    if by_name and by_name in get_card_catalog_map():
        return by_name

    by_slug = catalog_id_for_name(pokemon_slug(value))
    if by_slug and by_slug in get_card_catalog_map():
        return by_slug

    raise KeyError(f"Cannot resolve card id for: {value}")


def migrate_pool_keys(pool: dict) -> dict:
    """Convert legacy name-keyed pools to card_id keys."""
    migrated = {}
    for key, is_alive in (pool or {}).items():
        try:
            migrated[resolve_card_id(key)] = is_alive
        except KeyError:
            continue
    return migrated
