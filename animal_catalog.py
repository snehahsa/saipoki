"""Scan gather-clone animal PNGs and build manifest for NPC sprites."""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
ANIMALS_DIR = ROOT / "gather-clone/frontend/public/sprites/animals"
MANIFEST_PATH = ANIMALS_DIR / "manifest.json"

# Match in-game character footprint on the 32px tile grid.
TARGET_FRAME_PX = 48
WALK_COLS = 4
WALK_ROWS = 4
WALK_DIRECTIONS = ("down", "left", "right", "up")


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        handle.seek(16)
        w, h = struct.unpack(">II", handle.read(8))
    return w, h


def frames_sidecar_path(animal_id: str) -> Path:
    return ANIMALS_DIR / f"{animal_id}.frames.json"


def default_walk_frames(
    width: int,
    height: int,
    columns: int = WALK_COLS,
    rows: int = WALK_ROWS,
) -> dict[str, dict]:
    frame_width = width // columns
    frame_height = height // rows
    frames: dict[str, dict] = {}

    for row in range(rows):
        direction = WALK_DIRECTIONS[row] if row < len(WALK_DIRECTIONS) else f"row_{row}"
        for col in range(columns):
            frames[f"walk_{direction}_{col}"] = {
                "x": col * frame_width,
                "y": row * frame_height,
                "w": frame_width,
                "h": frame_height,
            }

    return frames


def normalize_frame_rect(raw: dict) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    try:
        x = int(raw["x"])
        y = int(raw["y"])
        w = int(raw["w"])
        h = int(raw["h"])
    except (KeyError, TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None
    return {"x": x, "y": y, "w": w, "h": h}


def normalize_frames_payload(frames: dict) -> dict[str, dict]:
    cleaned: dict[str, dict] = {}
    if not isinstance(frames, dict):
        return cleaned
    for key, value in frames.items():
        if not isinstance(key, str) or not key.startswith("walk_"):
            continue
        rect = normalize_frame_rect(value)
        if rect:
            cleaned[key] = rect
    return cleaned


def load_animal_frames(animal_id: str, entry: Optional[dict] = None) -> dict:
    sidecar = frames_sidecar_path(animal_id)
    if sidecar.is_file():
        try:
            data = json.loads(sidecar.read_text(encoding="utf-8"))
            frames = normalize_frames_payload(data.get("frames", {}))
            if frames:
                return {
                    "customFrames": True,
                    "displayScale": data.get("displayScale"),
                    "frames": frames,
                }
        except (json.JSONDecodeError, OSError):
            pass

    if entry is None:
        png = ANIMALS_DIR / f"{animal_id}.png"
        if png.is_file():
            width, height = png_size(png)
            columns = WALK_COLS if width % WALK_COLS == 0 else 1
            rows = WALK_ROWS if height % WALK_ROWS == 0 else len(WALK_DIRECTIONS)
            entry = {
                "width": width,
                "height": height,
                "columns": columns,
                "rows": rows,
            }

    if not entry:
        return {"customFrames": False, "frames": {}}

    return {
        "customFrames": False,
        "displayScale": entry.get("displayScale"),
        "frames": default_walk_frames(
            entry["width"],
            entry["height"],
            entry.get("columns", WALK_COLS),
            entry.get("rows", WALK_ROWS),
        ),
    }


def save_animal_frames(animal_id: str, frames: dict, display_scale: Optional[float] = None) -> dict:
    png = ANIMALS_DIR / f"{animal_id}.png"
    if not png.is_file():
        raise ValueError(f"Unknown animal: {animal_id}")

    width, height = png_size(png)
    base_entry = {
        "width": width,
        "height": height,
        "columns": WALK_COLS if width % WALK_COLS == 0 else 1,
        "rows": WALK_ROWS if height % WALK_ROWS == 0 else len(WALK_DIRECTIONS),
    }

    cleaned = normalize_frames_payload(frames)
    if not cleaned:
        raise ValueError("No valid walk frames provided")

    scale = display_scale
    if scale is None:
        scale = base_entry.get("displayScale")
    if not scale or scale <= 0:
        frame_width = next(iter(cleaned.values()))["w"]
        scale = round(TARGET_FRAME_PX / frame_width, 6)

    payload = {
        "version": 1,
        "id": animal_id,
        "displayScale": scale,
        "frames": cleaned,
    }
    ANIMALS_DIR.mkdir(parents=True, exist_ok=True)
    frames_sidecar_path(animal_id).write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )
    sync_manifest()
    return payload


def scan_animal_png(path: Path) -> dict | None:
    if path.suffix.lower() != ".png":
        return None
    if path.stem.endswith(".frames"):
        return None

    width, height = png_size(path)
    if width <= 0 or height <= 0:
        return None

    animal_id = path.stem
    columns = WALK_COLS
    rows = WALK_ROWS

    if width == height and width % WALK_COLS == 0 and height % WALK_ROWS == 0:
        frame_width = width // columns
        frame_height = height // rows
    else:
        # Non-grid sheets still appear in the editor; default to single-frame rows.
        columns = 1
        rows = min(len(WALK_DIRECTIONS), max(1, height // max(1, width)))
        frame_width = width
        frame_height = max(1, height // rows)

    frame_data = load_animal_frames(animal_id, None)
    frames = frame_data.get("frames") or default_walk_frames(width, height, columns, rows)
    custom_frames = bool(frame_data.get("customFrames"))
    if frames:
        sample = next(iter(frames.values()))
        frame_width = sample["w"]
        frame_height = sample["h"]

    display_scale = frame_data.get("displayScale")
    if not display_scale or display_scale <= 0:
        display_scale = round(TARGET_FRAME_PX / frame_width, 6)

    entry = {
        "id": animal_id,
        "file": path.name,
        "width": width,
        "height": height,
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "columns": columns,
        "rows": rows,
        "displayScale": display_scale,
        "skin": f"animal:{animal_id}",
        "customFrames": custom_frames,
    }
    if custom_frames:
        entry["frames"] = frames
    return entry


def scan_animals() -> list[dict]:
    if not ANIMALS_DIR.is_dir():
        return []

    entries: list[dict] = []
    for path in sorted(ANIMALS_DIR.glob("*.png")):
        entry = scan_animal_png(path)
        if entry:
            entries.append(entry)
    return entries


def sync_manifest() -> list[dict]:
    animals = scan_animals()
    ANIMALS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps({"animals": animals}, indent=2) + "\n",
        encoding="utf-8",
    )
    return animals


def load_manifest() -> list[dict]:
    if MANIFEST_PATH.is_file():
        try:
            data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
            animals = data.get("animals")
            if isinstance(animals, list):
                return [a for a in animals if isinstance(a, dict) and a.get("id")]
        except (json.JSONDecodeError, OSError):
            pass
    return sync_manifest()


def npc_skin_for_animal(animal_id: str) -> str:
    return f"animal:{animal_id}"


def is_animal_skin(skin: str) -> bool:
    return str(skin or "").startswith("animal:")


def animal_id_from_skin(skin: str) -> str:
    return str(skin or "")[len("animal:") :]


if __name__ == "__main__":
    found = sync_manifest()
    print(f"Wrote {MANIFEST_PATH} ({len(found)} animals)")
    for item in found:
        custom = "custom" if item.get("customFrames") else "grid"
        print(
            f"  {item['id']}: {item['width']}x{item['height']}, "
            f"frame {item['frameWidth']}px, scale {item['displayScale']} ({custom})"
        )
