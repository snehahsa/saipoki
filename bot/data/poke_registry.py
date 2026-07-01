"""PokéCard catalog IDs and vault parsing — shared with webp/poke_registry.py."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Dict, FrozenSet, List, Optional, Set, Tuple, Union

from bot.utils.config_reader import _WEBP_ROOT, config

CARD_ID_PREFIX = "poke"
CARD_ID_RE = re.compile(rf"^{CARD_ID_PREFIX}-\d{{3,}}$")


def poke_json_path() -> Path:
    path = Path(config.poke_json_path)
    if not path.is_absolute():
        path = _WEBP_ROOT / path
    return path.resolve()


def pokemon_slug(name: str) -> str:
    stem = re.sub(r"[^a-z0-9]", "", (name or "").lower())
    return stem or "card"


def is_catalog_id(value: str) -> bool:
    return bool(CARD_ID_RE.match(str(value or "").strip()))


def format_catalog_id(number: int) -> str:
    return f"{CARD_ID_PREFIX}-{number:03d}"


def parse_catalog_number(card_id: str) -> int:
    if not is_catalog_id(card_id):
        return 0
    return int(card_id.rsplit("-", 1)[-1])


def load_poke_json(path: Optional[Path] = None) -> dict:
    path = path or poke_json_path()
    if not path.is_file():
        return {"version": 1, "cards": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"version": 1, "cards": []}


def load_card_catalog(path: Optional[Path] = None) -> Dict[str, dict]:
    """Map catalog id → card record from poke.json."""
    cards = load_poke_json(path).get("cards") or []
    catalog: Dict[str, dict] = {}
    for card in cards:
        card_id = str(card.get("id") or "").strip()
        if card_id:
            catalog[card_id] = card
    return catalog


def valid_card_ids(path: Optional[Path] = None) -> FrozenSet[str]:
    return frozenset(load_card_catalog(path).keys())


def catalog_id_for_slug(slug: str, path: Optional[Path] = None) -> Optional[str]:
    slug = pokemon_slug(slug)
    for card in load_poke_json(path).get("cards") or []:
        card_slug = card.get("slug") or pokemon_slug(card.get("name", ""))
        if card_slug == slug:
            card_id = str(card.get("id") or "").strip()
            if is_catalog_id(card_id):
                return card_id
    return None


def catalog_id_for_name(name: str, path: Optional[Path] = None) -> Optional[str]:
    return catalog_id_for_slug(pokemon_slug(name), path)


VAULT_SOURCES = frozenset(
    {
        "vending",
        "quest",
        "trade",
        "gift",
        "admin",
        "test_starter",
        "unknown",
    }
)


def normalize_vault_source(source: Optional[str]) -> str:
    value = (source or "unknown").strip().lower()[:64]
    return value if value in VAULT_SOURCES else "unknown"


def resolve_stored_card_id(
    card_id: str,
    valid: Set[str],
    path: Optional[Path] = None,
) -> Optional[str]:
    card_id = str(card_id or "").strip()
    if not card_id:
        return None
    if not valid or card_id in valid:
        return card_id
    for candidate in (
        catalog_id_for_name(card_id, path),
        catalog_id_for_slug(card_id, path),
    ):
        if candidate and candidate in valid:
            return candidate
    return None


def parse_vault(
    raw,
    valid_ids: Optional[Union[FrozenSet[str], Set[str]]] = None,
    *,
    poke_json_path: Optional[Path] = None,
) -> List[dict]:
    """Parse stored vault JSON; migrate legacy ids to catalog poke-NNN ids."""
    if not raw:
        items: list = []
    elif isinstance(raw, list):
        items = raw
    else:
        try:
            items = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            items = []
    if not isinstance(items, list):
        return []

    valid = set(valid_ids or ())
    vault: List[dict] = []
    seen: Set[str] = set()

    for entry in items:
        if isinstance(entry, str):
            card_id = entry.strip()
            source = "unknown"
            acquired_at = 0
        elif isinstance(entry, dict):
            card_id = str(entry.get("card_id") or entry.get("id") or "").strip()
            source = normalize_vault_source(entry.get("source"))
            acquired_at = int(entry.get("acquired_at") or 0)
        else:
            continue

        resolved = resolve_stored_card_id(card_id, valid, poke_json_path)
        if not resolved or resolved in seen:
            continue

        seen.add(resolved)
        vault.append(
            {
                "card_id": resolved,
                "acquired_at": acquired_at,
                "source": source,
            }
        )

    vault.sort(key=lambda e: (e.get("acquired_at") or 0, e.get("card_id") or ""))
    return vault


def vault_card_ids(vault: List[dict]) -> List[str]:
    return [entry["card_id"] for entry in vault if entry.get("card_id")]


def add_card_to_vault(
    vault: List[dict],
    card_id: str,
    *,
    source: str = "unknown",
    allow_duplicate: bool = False,
) -> Tuple[List[dict], bool]:
    """Return (updated_vault, added). By default one copy per catalog id."""
    card_id = str(card_id or "").strip()
    if not card_id:
        return vault, False

    if not allow_duplicate and any(entry.get("card_id") == card_id for entry in vault):
        return vault, False

    updated = list(vault)
    updated.append(
        {
            "card_id": card_id,
            "acquired_at": int(time.time()),
            "source": normalize_vault_source(source),
        }
    )
    updated.sort(key=lambda e: (e.get("acquired_at") or 0, e.get("card_id") or ""))
    return updated, True
