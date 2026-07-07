"""Registry of hold items, UI unlock rules, and pickup presentation.

To add a new bag item an NPC can grant:
1. Add an entry to HOLD_ITEMS (label, pickup_popup.icon, optional quest_step / quest_id).
2. If it should appear as a bag drawer tab, set unlocks_ui to ["drawer:<id>"] and add
   a matching UI_UNLOCKS rule plus tab + pane in templates/index.html.
3. On the NPC in the map builder, add a flow with grantHold set to the hold id
   (and questStep / questId when it completes a quest step). Set flow requires.holds
   for any prerequisites (e.g. bag before poketab).
4. Optional grant_requires on the hold enforces prerequisites server-side even if the
   map flow is misconfigured.
"""

from typing import Optional


HOLD_ITEMS = {
    "bag": {
        "label": "Trainer Bag",
        "description": "Opens the in-game bag drawer.",
        "unlocks_ui": ["bag_button"],
        "quest_step": "collect_trainer_bag",
        "quest_id": "week1_vault_trail",
        "pickup_popup": {
            "headline": "YOU GOT!",
            "title": "Trainer Bag",
            "message": "Tap the bag icon anytime to open your gear drawer.",
            "icon": "/static/menuitems/bag.png",
            "theme": "bag",
            "tag": "GEAR OBTAINED",
        },
    },
    "card_vault": {
        "label": "PokéCard Vault",
        "description": "Storage vault for discovered PokéCards.",
        "unlocks_ui": ["drawer:vault", "pokedex_button"],
        "content": "vault_cards",
        "quest_step": "collect_card_vault",
        "quest_id": "week1_vault_trail",
        "pickup_popup": {
            "headline": "YOU GOT!",
            "title": "PokéCard Vault",
            "message": "Your vault tab is live — store every card you find.",
            "icon": "/static/menuitems/dex.png",
            "theme": "vault",
            "tag": "VAULT UNLOCKED",
        },
    },
    "poketab": {
        "label": "PokéTab",
        "description": "Connect with trainers worldwide.",
        "unlocks_ui": ["drawer:poketab"],
        "grant_requires": {"holds": ["bag"]},
        "quest_step": "collect_poketab",
        "quest_id": "week1_vault_trail",
        "pickup_popup": {
            "headline": "YOU GOT!",
            "title": "PokéTab",
            "message": "Your PokéTab is in your bag — find trainers, send friend requests, and message friends.",
            "icon": "/static/menuitems/phone.png",
            "theme": "gear",
            "tag": "GEAR OBTAINED",
        },
    },
}

HOLD_ITEM_IDS = frozenset(HOLD_ITEMS.keys())

# UI elements gated by holds — add entries when new buttons/tabs need unlock rules.
UI_UNLOCKS = {
    "bag_button": {
        "requires_hold": "bag",
        "selector": "#game-bag-btn",
        "title_unlocked": "Open bag",
        "title_locked": "Find your trainer bag on the map first",
    },
    "pokedex_button": {
        "requires_hold": "card_vault",
        "selector": "#game-pokedex-btn",
        "title_unlocked": "Open Pokédex",
        "title_locked": "Find the PokéCard Vault on the map first",
    },
    "drawer:vault": {
        "requires_hold": "card_vault",
        "selector": '[data-hold-ui="drawer:vault"]',
        "lock_mode": "hide",
    },
    "drawer:poketab": {
        "requires_hold": "poketab",
        "selector": '[data-hold-ui="drawer:poketab"]',
        "lock_mode": "hide",
    },
    "poketab_button": {
        "requires_hold": "poketab",
        "selector": "#game-poketab-btn",
        "title_unlocked": "Open PokéTab",
        "title_locked": "Obtain a PokéTab from the PokéHub first",
    },
}

# Hold content panes — maps content id to client render handler name.
HOLD_CONTENT = {
    "vault_cards": {
        "drawer_pane": "vault",
        "menu_screen": "bag",
    },
}


def _requirements_met(requires: Optional[dict], holds: set) -> bool:
    if not requires:
        return True
    for item in requires.get("holds") or []:
        if item not in holds:
            return False
    for item in requires.get("notHolds") or []:
        if item in holds:
            return False
    return True


def hold_grant_allowed(item_id: str, holds: list) -> tuple:
    """Return whether a hold may be granted given the player's current holds."""
    item = HOLD_ITEMS.get(item_id)
    if not item:
        return False, "Unknown hold item"
    hold_set = set(holds)
    grant_req = item.get("grant_requires")
    if not _requirements_met(grant_req, hold_set):
        missing = [h for h in (grant_req or {}).get("holds") or [] if h not in hold_set]
        if missing:
            label = HOLD_ITEMS.get(missing[0], {}).get("label", missing[0])
            return False, f"Requires {label}"
        return False, "Grant requirements not met"
    return True, None


def hold_item_client_meta(item_id: str) -> dict:
    item = HOLD_ITEMS.get(item_id)
    if not item:
        return {}
    meta = {
        "id": item_id,
        "label": item.get("label", item_id),
        "description": item.get("description", ""),
        "unlocks_ui": list(item.get("unlocks_ui") or []),
        "quest_step": item.get("quest_step"),
        "quest_id": item.get("quest_id"),
        "content": item.get("content"),
        "pickup_popup": dict(item.get("pickup_popup") or {}),
    }
    grant_requires = item.get("grant_requires")
    if grant_requires:
        meta["grant_requires"] = dict(grant_requires)
    return meta


def hold_catalog_for_client() -> dict:
    return {item_id: hold_item_client_meta(item_id) for item_id in HOLD_ITEMS}


def ui_unlocks_for_client() -> dict:
    return UI_UNLOCKS
