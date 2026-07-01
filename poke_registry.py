"""PokéCard catalog IDs, client payloads, and vault storage — extend here for new cards/sources."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
POKE_JSON_PATH = ROOT / "poke.json"
CARD_ID_PREFIX = "poke"
CARD_ID_RE = re.compile(rf"^{CARD_ID_PREFIX}-\d{{3,}}$")


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


def load_poke_json(path: Path | None = None) -> dict:
    path = path or POKE_JSON_PATH
    if not path.is_file():
        return {"version": 1, "cards": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"version": 1, "cards": []}


def load_card_catalog(path: Path | None = None) -> dict[str, dict]:
    """Map catalog id → card record from poke.json."""
    cards = load_poke_json(path).get("cards") or []
    catalog: dict[str, dict] = {}
    for card in cards:
        card_id = str(card.get("id") or "").strip()
        if card_id:
            catalog[card_id] = card
    return catalog


def valid_card_ids(path: Path | None = None) -> frozenset[str]:
    return frozenset(load_card_catalog(path).keys())


def catalog_id_for_slug(slug: str, path: Path | None = None) -> str | None:
    slug = pokemon_slug(slug)
    for card in load_poke_json(path).get("cards") or []:
        card_slug = card.get("slug") or pokemon_slug(card.get("name", ""))
        if card_slug == slug:
            card_id = str(card.get("id") or "").strip()
            if is_catalog_id(card_id):
                return card_id
    return None


def catalog_id_for_name(name: str, path: Path | None = None) -> str | None:
    return catalog_id_for_slug(pokemon_slug(name), path)


def assign_catalog_ids(
    cards: list[dict],
    *,
    poke_json_path: Path | None = None,
    seed_ids: dict[str, str] | None = None,
) -> list[dict]:
    """
    Attach stable poke-NNN ids to cards.
    Reuses ids by pool image filename first, then species slug / seed_ids.
    """
    poke_json_path = poke_json_path or POKE_JSON_PATH
    slug_to_id: dict[str, str] = dict(seed_ids or {})
    image_to_id: dict[str, str] = {}
    max_num = 0

    for card in load_poke_json(poke_json_path).get("cards") or []:
        slug = card.get("slug") or pokemon_slug(card.get("name", ""))
        image = str(card.get("image") or "").strip()
        card_id = str(card.get("id") or "").strip()
        if not is_catalog_id(card_id):
            continue
        if image:
            image_to_id[image] = card_id
        if slug:
            slug_to_id.setdefault(slug, card_id)
        max_num = max(max_num, parse_catalog_number(card_id))

    next_num = max_num + 1 if max_num else 1
    assigned: list[dict] = []

    for card in sorted(
        cards,
        key=lambda c: (
            c.get("slug") or pokemon_slug(c.get("name", "")),
            c.get("image") or "",
        ),
    ):
        slug = card.get("slug") or pokemon_slug(card.get("name", ""))
        image = str(card.get("image") or "").strip()
        card_id = image_to_id.get(image) or slug_to_id.get(slug)
        if not card_id:
            card_id = format_catalog_id(next_num)
            next_num += 1
        if image:
            image_to_id[image] = card_id
        slug_to_id.setdefault(slug, card_id)
        row = {k: v for k, v in card.items() if not str(k).startswith("_")}
        row["slug"] = slug
        row["id"] = card_id
        assigned.append(row)

    return assigned


# ── Vault (per-player collected cards) ───────────────────────────────────────

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


def normalize_vault_source(source: str | None) -> str:
    value = (source or "unknown").strip().lower()[:64]
    return value if value in VAULT_SOURCES else "unknown"


def resolve_stored_card_id(
    card_id: str,
    valid: set[str],
    path: Path | None = None,
) -> str | None:
    """Map poke-NNN ids, legacy slugs, or display names to a catalog id."""
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
    valid_card_ids: frozenset[str] | set[str] | None = None,
    *,
    poke_json_path: Path | None = None,
) -> list[dict]:
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

    valid = set(valid_card_ids or ())
    vault: list[dict] = []
    seen: set[str] = set()

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


def vault_card_ids(vault: list[dict]) -> list[str]:
    return [entry["card_id"] for entry in vault if entry.get("card_id")]


def add_card_to_vault(
    vault: list[dict],
    card_id: str,
    *,
    source: str = "unknown",
    allow_duplicate: bool = False,
) -> tuple[list[dict], bool]:
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


def card_client_item(card: dict, *, src: str, pickup_message: str | None = None) -> dict:
    """Shape a catalog card for the game client."""
    card_id = str(card.get("id") or "").strip()
    display_name = card.get("name") or card_id
    shuffle = card.get("shuffle", True)
    if shuffle is None:
        shuffle = True
    item = {
        "id": card_id,
        "slug": card.get("slug") or pokemon_slug(display_name),
        "src": src,
        "name": display_name,
        "hp": card.get("hp"),
        "lvl": card.get("lvl"),
        "type": card.get("type"),
        "url": card.get("url", ""),
        "spells": card.get("spells") or [],
        "shuffle": bool(shuffle),
        "pickup_popup": {
            "headline": "YOU GOT!",
            "title": display_name,
            "message": pickup_message or "A new PokéCard was added to your vault.",
            "icon": src,
            "theme": "card",
            "tag": "NEW CARD",
        },
    }
    return item
