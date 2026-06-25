"""Usable in-game gear (quickbar slots) — separate from bag/hold unlocks."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
ITEMS_DIR = ROOT / "gather-clone/frontend/public/sprites/spritesheets/items"
ITEMS_MANIFEST_PATH = ITEMS_DIR / "manifest.json"
# Flask serves static/sprites before gather-clone — keep both manifests in sync.
STATIC_ITEMS_MANIFEST_PATH = ROOT / "static/sprites/spritesheets/items/manifest.json"

GEAR_SLOT_COUNT = 3
GEAR_FACINGS = ("down", "left", "right", "up")
GEAR_CHAR_FRAME_PX = 48


def _frame_size(item_id: str, saved: Optional[dict] = None) -> tuple[int, int]:
    saved = saved or {}
    base = dict(GEAR_ITEMS[item_id].get("sprite") or {})
    frame = saved.get("frame") if isinstance(saved.get("frame"), dict) else {}
    w = int(frame.get("w") or base.get("w") or 1)
    h = int(frame.get("h") or base.get("h") or 1)
    return max(1, w), max(1, h)


def _gear_hand_offset(direction: str, body_w: float, offset_x: float) -> float:
    if direction == "right":
        return body_w * 0.22 + offset_x
    if direction == "left":
        return -body_w * 0.08 + offset_x
    return body_w * 0.08 + offset_x


def rect_from_legacy(direction: str, attach: dict, frame_w: int, frame_h: int) -> dict:
    """Tool bounding box on the 48px character, top-left origin (matches map builder)."""
    body_w = float(GEAR_CHAR_FRAME_PX)
    body_h = float(GEAR_CHAR_FRAME_PX)
    scale = float(attach.get("scale", 0.09))
    tool_w = frame_w * scale
    tool_h = frame_h * scale
    anchor_x = float(attach.get("anchorX", 0.5))
    anchor_y = float(attach.get("anchorY", 0.85))
    offset_x = float(attach.get("offsetX", 0))
    offset_y = float(attach.get("offsetY", 0))
    hand_x = _gear_hand_offset(direction, body_w, offset_x)
    hand_y = -body_h * 0.05 + offset_y
    return {
        "x": round(hand_x - tool_w * anchor_x, 3),
        "y": round(hand_y - tool_h * anchor_y, 3),
        "w": round(tool_w, 3),
        "h": round(tool_h, 3),
    }


def _normalize_rect(raw: dict) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    try:
        w = float(raw.get("w", 0))
        h = float(raw.get("h", 0))
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    return {
        "x": round(float(raw.get("x", 0)), 3),
        "y": round(float(raw.get("y", 0)), 3),
        "w": round(w, 3),
        "h": round(h, 3),
    }

GEAR_ITEMS = {
    "fishing_rod": {
        "label": "Pro Fishing Rod",
        "description": "Manager's pro rod — equip from the GEAR bar. Choose Salvage by canal water, then cast.",
        "slot_type": "quickbar",
        "icon": "/sprites/spritesheets/items/fish.png",
        "default_fishing_quest": "pokehub_key",
        "quest_step": "manager_lost_key",
        "quest_id": "week1_vault_trail",
        "fishing_modes": [
            {
                "id": "fish",
                "label": "River Fish",
                "hint": "Common freshwater catches — free haul",
            },
            {
                "id": "pokemon",
                "label": "Water Pokémon",
                "hint": "Lure aquatic Pokémon from the shallows",
            },
            {
                "id": "salvage",
                "label": "Salvage",
                "hint": "Hook scrap metal and hidden junk",
            },
        ],
        "sprite": {
            "file": "fish.png",
            "x": 313,
            "y": 383,
            "w": 669,
            "h": 470,
            "direction": "left",
            "offsetX": -2,
            "offsetY": -6,
            "scale": 0.09,
            "anchorX": 0.5,
            "anchorY": 0.85,
        },
        "useFacings": ["left", "right"],
        "pickup_popup": {
            "headline": "GEAR SLOT!",
            "title": "Pro Fishing Rod",
            "message": "Equip it from the GEAR bar, pick Salvage, and fish the canal outside the PokéHub.",
            "icon": "/sprites/spritesheets/items/fish.png",
            "theme": "gear",
            "tag": "GEAR EQUIPPED",
        },
    },
    "hub_key": {
        "label": "Master Key",
        "description": "The Manager's lost master key — return it to him at the PokéHub for your PokéTab.",
        "slot_type": "quickbar",
        "grant_slot": 2,
        "icon": "/sprites/spritesheets/items/key.png",
        "quest_step": "collect_hub_key",
        "quest_id": "week1_vault_trail",
        "sprite": {
            "file": "key.png",
            "x": 0,
            "y": 0,
            "w": 48,
            "h": 48,
            "direction": "left",
            "offsetX": 0,
            "offsetY": 0,
            "scale": 0.35,
            "anchorX": 0.5,
            "anchorY": 0.5,
        },
        "useFacings": [],
        "pickup_popup": {
            "headline": "KEY FOUND!",
            "title": "Master Key",
            "message": "A rusty master key from the canal — bring it back to the Manager.",
            "icon": "/sprites/spritesheets/items/key.png",
            "theme": "gear",
            "tag": "QUEST ITEM",
        },
    },
}

GEAR_ITEM_IDS = frozenset(GEAR_ITEMS.keys())


def item_config_path(item_id: str) -> Path:
    return ITEMS_DIR / f"{item_id}.json"


def _read_json(path: Path) -> Optional[dict]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def load_saved_item_config(item_id: str) -> dict:
    return _read_json(item_config_path(item_id)) or {}


def default_face_attach(item_id: str) -> dict:
    base = dict(GEAR_ITEMS[item_id].get("sprite") or {})
    return {
        "offsetX": float(base.get("offsetX", 0)),
        "offsetY": float(base.get("offsetY", 0)),
        "scale": float(base.get("scale", 0.09)),
        "anchorX": float(base.get("anchorX", 0.5)),
        "anchorY": float(base.get("anchorY", 0.85)),
    }


def resolve_faces(item_id: str, saved: Optional[dict] = None) -> dict[str, dict]:
    """Per-direction attach + eligible flag, with legacy attach/frame fallbacks."""
    saved = saved or {}
    base_attach = default_face_attach(item_id)
    legacy_attach = saved.get("attach") if isinstance(saved.get("attach"), dict) else {}
    for key in ("offsetX", "offsetY", "scale", "anchorX", "anchorY"):
        if key in legacy_attach:
            base_attach[key] = legacy_attach[key]
        elif key in saved:
            base_attach[key] = saved[key]

    item_defaults = list(GEAR_ITEMS[item_id].get("useFacings") or [])
    saved_use = saved.get("useFacings")
    if isinstance(saved_use, list):
        default_eligible = [str(f).strip() for f in saved_use if str(f).strip() in GEAR_FACINGS]
    else:
        default_eligible = item_defaults

    frame_w, frame_h = _frame_size(item_id, saved)
    faces_in = saved.get("faces") if isinstance(saved.get("faces"), dict) else {}
    faces: dict[str, dict] = {}
    for facing in GEAR_FACINGS:
        raw = faces_in.get(facing) if isinstance(faces_in.get(facing), dict) else {}
        merged = {**base_attach, **raw}
        eligible = raw.get("eligible")
        if eligible is None:
            eligible = facing in default_eligible
        rect = _normalize_rect(raw.get("rect")) or rect_from_legacy(
            facing, merged, frame_w, frame_h
        )
        faces[facing] = {
            "eligible": bool(eligible),
            "rect": rect,
        }
    return faces


def use_facings_from_faces(faces: dict[str, dict]) -> list[str]:
    return [facing for facing in GEAR_FACINGS if faces.get(facing, {}).get("eligible")]


def save_item_config(item_id: str, payload: dict) -> dict:
    if item_id not in GEAR_ITEM_IDS:
        raise ValueError(f"Unknown gear item: {item_id}")

    existing = load_saved_item_config(item_id)
    base_sprite = dict(GEAR_ITEMS[item_id].get("sprite") or {})
    existing_frame = existing.get("frame") if isinstance(existing.get("frame"), dict) else {}

    frame_in = payload.get("frame") if isinstance(payload.get("frame"), dict) else {}

    def pick_int(key: str, default: int) -> int:
        for source in (frame_in, existing_frame, base_sprite):
            if key in source and source[key] is not None:
                return int(source[key])
        return int(default)

    faces = resolve_faces(item_id, existing)
    frame_w, frame_h = _frame_size(item_id, existing)
    faces_in = payload.get("faces") if isinstance(payload.get("faces"), dict) else {}
    for facing in GEAR_FACINGS:
        raw = faces_in.get(facing)
        if not isinstance(raw, dict):
            continue
        if "eligible" in raw:
            faces[facing]["eligible"] = bool(raw["eligible"])
        rect = _normalize_rect(raw.get("rect"))
        if rect:
            faces[facing]["rect"] = rect
        else:
            legacy = {**default_face_attach(item_id), **raw}
            faces[facing]["rect"] = rect_from_legacy(facing, legacy, frame_w, frame_h)

    use_facings_in = payload.get("useFacings")
    if isinstance(use_facings_in, list):
        eligible_set = {str(f).strip() for f in use_facings_in if str(f).strip() in GEAR_FACINGS}
        for facing in GEAR_FACINGS:
            faces[facing]["eligible"] = facing in eligible_set
    use_facings = use_facings_from_faces(faces)

    out = {
        "id": item_id,
        "file": str(
            payload.get("file")
            or existing.get("file")
            or base_sprite.get("file", "fish.png")
        ),
        "frame": {
            "x": pick_int("x", 0),
            "y": pick_int("y", 0),
            "w": pick_int("w", 1),
            "h": pick_int("h", 1),
        },
        "useFacings": use_facings,
        "faces": faces,
    }

    ITEMS_DIR.mkdir(parents=True, exist_ok=True)
    item_config_path(item_id).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    sync_items_manifest()
    return out


def sync_items_manifest() -> None:
    ITEMS_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {"items": [gear_item_client_meta(item_id) for item_id in GEAR_ITEMS]}
    payload = json.dumps(manifest, indent=2) + "\n"
    ITEMS_MANIFEST_PATH.write_text(payload, encoding="utf-8")
    STATIC_ITEMS_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATIC_ITEMS_MANIFEST_PATH.write_text(payload, encoding="utf-8")


def empty_gear_slots() -> list[Optional[str]]:
    return [None] * GEAR_SLOT_COUNT


def normalize_gear_slots(raw) -> list[Optional[str]]:
    slots = empty_gear_slots()
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return slots
    if not isinstance(raw, list):
        return slots
    for i in range(min(GEAR_SLOT_COUNT, len(raw))):
        item = raw[i]
        if isinstance(item, str) and item in GEAR_ITEM_IDS:
            slots[i] = item
    return slots


def gear_item_client_meta(item_id: str) -> dict:
    item = GEAR_ITEMS.get(item_id)
    if not item:
        return {}

    saved = load_saved_item_config(item_id)
    base_sprite = dict(item.get("sprite") or {})
    frame = saved.get("frame") if isinstance(saved.get("frame"), dict) else {}
    if frame:
        base_sprite["x"] = frame.get("x", base_sprite.get("x", 0))
        base_sprite["y"] = frame.get("y", base_sprite.get("y", 0))
        base_sprite["w"] = frame.get("w", base_sprite.get("w", 1))
        base_sprite["h"] = frame.get("h", base_sprite.get("h", 1))

    faces = resolve_faces(item_id, saved)
    use_facings = use_facings_from_faces(faces)
    if not use_facings:
        use_facings = list(item.get("useFacings") or [])

    primary_rect = (faces.get("left") or faces.get("right") or {}).get("rect") or rect_from_legacy(
        "left", default_face_attach(item_id), *_frame_size(item_id, saved)
    )
    sprite = {**base_sprite}

    client_faces = {
        facing: {
            "rect": dict(cfg["rect"]),
            "eligible": bool(cfg["eligible"]),
        }
        for facing, cfg in faces.items()
    }

    meta = {
        "id": item_id,
        "label": item.get("label", item_id),
        "description": item.get("description", ""),
        "icon": item.get("icon", ""),
        "slot_type": item.get("slot_type", "quickbar"),
        "sprite": sprite,
        "faces": client_faces,
        "useFacings": use_facings,
        "requiresFacing": item.get("requiresFacing"),
        "pickup_popup": dict(item.get("pickup_popup") or {}),
        "charFramePx": GEAR_CHAR_FRAME_PX,
        "primaryRect": primary_rect,
        "quest_step": item.get("quest_step"),
        "quest_id": item.get("quest_id"),
        "fishing_modes": list(item.get("fishing_modes") or []),
        "default_fishing_quest": item.get("default_fishing_quest"),
    }
    if not meta["useFacings"] and meta["requiresFacing"]:
        meta["useFacings"] = [meta["requiresFacing"]]
    return meta


def gear_catalog_for_client() -> dict:
    sync_items_manifest()
    return {item_id: gear_item_client_meta(item_id) for item_id in GEAR_ITEMS}


def grant_gear_to_slots(slots: list[Optional[str]], item_id: str) -> tuple[list[Optional[str]], bool]:
    """Place item in preferred or first empty slot. Returns (slots, newly_granted)."""
    if item_id not in GEAR_ITEM_IDS:
        return slots, False
    normalized = normalize_gear_slots(slots)
    if item_id in normalized:
        return normalized, False

    item = GEAR_ITEMS.get(item_id) or {}
    preferred = item.get("grant_slot")
    if preferred is not None:
        try:
            idx = int(preferred)
        except (TypeError, ValueError):
            idx = -1
        if 0 <= idx < GEAR_SLOT_COUNT and normalized[idx] is None:
            normalized[idx] = item_id
            return normalized, True

    for i in range(GEAR_SLOT_COUNT):
        if normalized[i] is None:
            normalized[i] = item_id
            return normalized, True
    return normalized, False
