"""Scan gather-clone animation folders and build manifest for map auto-loop sprites."""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
ANIMATIONS_DIR = ROOT / "gather-clone/frontend/public/sprites/animations"
MANIFEST_PATH = ANIMATIONS_DIR / "manifest.json"
PIXI_MANIFEST_PATH = (
    ROOT / "gather-clone/frontend/utils/pixi/spritesheet/anim.manifest.json"
)

TARGET_FRAME_PX = 48
TILE_SIZE = 32
LOOP_COLS = 3
LOOP_ROWS = 3
LOOP_FRAME_COUNT = 9
DEFAULT_FRAME_MS = 180


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        handle.seek(16)
        w, h = struct.unpack(">II", handle.read(8))
    return w, h


def display_scale_for_frame(frame_width: int) -> float:
    """Scale loop_0 so one frame spans exactly one map tile (32px) wide."""
    frame_width = max(1, int(frame_width))
    return round(TILE_SIZE / frame_width, 6)


def animation_folder(animation_id: str) -> Path:
    return ANIMATIONS_DIR / animation_id


def config_json_path(animation_id: str) -> Path:
    return animation_folder(animation_id) / f"{animation_id}.json"


def animation_sprite_path(animation_id: str, file_name: str) -> str:
    return f"{animation_id}/{file_name}"


def animation_sprite_url(animation_id: str, file_name: str) -> str:
    return f"/sprites/animations/{animation_sprite_path(animation_id, file_name)}"


def find_png_in_folder(folder: Path) -> Optional[Path]:
    if not folder.is_dir():
        return None
    preferred = folder / f"{folder.name}.png"
    if preferred.is_file():
        return preferred
    pngs = sorted(
        path
        for path in folder.glob("*.png")
        if not path.stem.endswith(".frames")
    )
    return pngs[0] if pngs else None


def default_loop_frames(
    width: int,
    height: int,
    columns: int = LOOP_COLS,
    rows: int = LOOP_ROWS,
) -> dict[str, dict]:
    columns = max(1, min(columns, LOOP_COLS))
    rows = max(1, min(rows, LOOP_ROWS))
    frame_width = max(1, width // columns)
    frame_height = max(1, height // rows)
    frames: dict[str, dict] = {}
    slot = 0
    for row in range(rows):
        for col in range(columns):
            if slot >= LOOP_FRAME_COUNT:
                break
            frames[f"loop_{slot}"] = {
                "x": col * frame_width,
                "y": row * frame_height,
                "w": frame_width,
                "h": frame_height,
            }
            slot += 1
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
        if not isinstance(key, str) or not key.startswith("loop_"):
            continue
        rect = normalize_frame_rect(value)
        if rect:
            cleaned[key] = rect
    return cleaned


def _read_config_json(path: Path) -> Optional[dict]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def write_animation_config(animation_id: str, payload: dict) -> Path:
    folder = animation_folder(animation_id)
    folder.mkdir(parents=True, exist_ok=True)
    path = config_json_path(animation_id)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def load_animation_frames(animation_id: str, entry: Optional[dict] = None) -> dict:
    folder = animation_folder(animation_id)
    config_path = config_json_path(animation_id)
    legacy_folder_sidecar = folder / f"{animation_id}.frames.json"
    legacy_root_sidecar = ANIMATIONS_DIR / f"{animation_id}.frames.json"

    for sidecar in (config_path, legacy_folder_sidecar, legacy_root_sidecar):
        data = _read_config_json(sidecar)
        if not data:
            continue
        frames = normalize_frames_payload(data.get("frames", {}))
        if frames:
            return {
                "customFrames": True,
                "displayScale": data.get("displayScale"),
                "frameMs": data.get("frameMs"),
                "frameWidth": data.get("frameWidth"),
                "frameHeight": data.get("frameHeight"),
                "file": data.get("file"),
                "frames": frames,
                "gearUseTarget": bool(data.get("gearUseTarget")),
            }

    png = find_png_in_folder(folder)
    if not png and entry and entry.get("file"):
        candidate = folder / entry["file"]
        if candidate.is_file():
            png = candidate
    if not png and entry is None:
        legacy_png = ANIMATIONS_DIR / f"{animation_id}.png"
        if legacy_png.is_file():
            png = legacy_png

    if png and png.is_file():
        width, height = png_size(png)
        columns = LOOP_COLS if width % LOOP_COLS == 0 else 1
        rows = LOOP_ROWS if height % LOOP_ROWS == 0 else 1
        entry = {
            "width": width,
            "height": height,
            "columns": columns,
            "rows": rows,
            "file": png.name,
        }

    if not entry:
        return {"customFrames": False, "frames": {}, "frameMs": DEFAULT_FRAME_MS}

    width = entry["width"]
    height = entry["height"]
    columns = entry.get("columns", LOOP_COLS)
    rows = entry.get("rows", LOOP_ROWS)
    return {
        "customFrames": False,
        "displayScale": entry.get("displayScale"),
        "frameMs": entry.get("frameMs", DEFAULT_FRAME_MS),
        "file": entry.get("file"),
        "frames": default_loop_frames(width, height, columns, rows),
    }


def ensure_animation_config(animation_id: str, png: Path, entry: dict) -> dict:
    """Create or refresh per-folder JSON for an animation PNG."""
    existing = _read_config_json(config_json_path(animation_id))
    frames = entry.get("frames") if entry.get("customFrames") else None
    if not frames:
        frame_data = load_animation_frames(animation_id, entry)
        frames = frame_data.get("frames") or default_loop_frames(
            entry["width"], entry["height"], entry.get("columns", LOOP_COLS), entry.get("rows", LOOP_ROWS)
        )

    loop0 = frames.get("loop_0") or next(iter(frames.values()))
    fixed_w = int((existing or {}).get("frameWidth") or loop0["w"])
    fixed_h = int((existing or {}).get("frameHeight") or loop0["h"])
    for key in list(frames.keys()):
        rect = frames[key]
        frames[key] = {
            "x": rect["x"],
            "y": rect["y"],
            "w": fixed_w,
            "h": fixed_h,
        }

    payload = {
        "version": 1,
        "id": animation_id,
        "file": png.name,
        "displayScale": entry.get("displayScale") or display_scale_for_frame(fixed_w),
        "frameMs": int(entry.get("frameMs") or DEFAULT_FRAME_MS),
        "frameWidth": fixed_w,
        "frameHeight": fixed_h,
        "frames": frames,
    }
    if existing:
        if existing.get("displayScale"):
            payload["displayScale"] = existing["displayScale"]
        if existing.get("frameMs"):
            payload["frameMs"] = int(existing["frameMs"])
        if existing.get("frameWidth"):
            payload["frameWidth"] = int(existing["frameWidth"])
        if existing.get("frameHeight"):
            payload["frameHeight"] = int(existing["frameHeight"])
        existing_frames = normalize_frames_payload(existing.get("frames", {}))
        if existing_frames:
            payload["frames"] = existing_frames
            payload["frameWidth"] = int(existing.get("frameWidth") or fixed_w)
            payload["frameHeight"] = int(existing.get("frameHeight") or fixed_h)
        if "gearUseTarget" in existing:
            payload["gearUseTarget"] = bool(existing.get("gearUseTarget"))

    write_animation_config(animation_id, payload)
    return payload


def save_animation_frames(
    animation_id: str,
    frames: dict,
    *,
    display_scale: Optional[float] = None,
    frame_ms: Optional[int] = None,
    frame_width: Optional[int] = None,
    frame_height: Optional[int] = None,
    gear_use_target: Optional[bool] = None,
) -> dict:
    folder = animation_folder(animation_id)
    png = find_png_in_folder(folder)
    if not png:
        raise ValueError(f"Unknown animation folder: {animation_id}")

    width, height = png_size(png)
    cleaned = normalize_frames_payload(frames)
    if not cleaned:
        raise ValueError("No valid loop frames provided")

    loop0 = cleaned.get("loop_0") or next(iter(cleaned.values()))
    fixed_w = max(1, int(frame_width or loop0["w"]))
    fixed_h = max(1, int(frame_height or loop0["h"]))
    for key in list(cleaned.keys()):
        rect = cleaned[key]
        cleaned[key] = {
            "x": rect["x"],
            "y": rect["y"],
            "w": fixed_w,
            "h": fixed_h,
        }

    scale = display_scale
    if scale is None or scale <= 0:
        scale = display_scale_for_frame(fixed_w)

    ms = int(frame_ms) if frame_ms is not None else DEFAULT_FRAME_MS
    ms = max(16, min(ms, 2000))

    existing = _read_config_json(config_json_path(animation_id))
    use_target = gear_use_target
    if use_target is None and existing:
        use_target = bool(existing.get("gearUseTarget"))

    payload = {
        "version": 1,
        "id": animation_id,
        "file": png.name,
        "displayScale": scale,
        "frameMs": ms,
        "frameWidth": fixed_w,
        "frameHeight": fixed_h,
        "frames": cleaned,
    }
    if use_target:
        payload["gearUseTarget"] = True
    write_animation_config(animation_id, payload)
    sync_manifest()
    return payload


def scan_animation_folder(animation_id: str, png: Path) -> dict | None:
    width, height = png_size(png)
    if width <= 0 or height <= 0:
        return None

    columns = LOOP_COLS if width % LOOP_COLS == 0 else 1
    rows = LOOP_ROWS if height % LOOP_ROWS == 0 else 1
    base_entry = {
        "width": width,
        "height": height,
        "columns": columns,
        "rows": rows,
        "file": png.name,
    }

    config = ensure_animation_config(animation_id, png, base_entry)
    frame_data = load_animation_frames(animation_id, base_entry)
    frames = frame_data.get("frames") or config.get("frames") or default_loop_frames(
        width, height, columns, rows
    )
    custom_frames = bool(normalize_frames_payload(config.get("frames", {})))

    loop0 = frames.get("loop_0") or next(iter(frames.values()))
    frame_width = int(config.get("frameWidth") or loop0["w"])
    frame_height = int(config.get("frameHeight") or loop0["h"])
    display_scale = float(config.get("displayScale") or display_scale_for_frame(frame_width))
    frame_ms = int(config.get("frameMs") or DEFAULT_FRAME_MS)
    frame_ms = max(16, min(frame_ms, 2000))

    sprite_path = animation_sprite_path(animation_id, png.name)
    entry = {
        "id": animation_id,
        "folder": animation_id,
        "file": png.name,
        "path": sprite_path,
        "url": animation_sprite_url(animation_id, png.name),
        "width": width,
        "height": height,
        "frameWidth": frame_width,
        "frameHeight": frame_height,
        "columns": columns,
        "rows": rows,
        "frameCount": min(len(frames), LOOP_FRAME_COUNT),
        "displayScale": display_scale,
        "frameMs": frame_ms,
        "tileId": f"anim-{animation_id}",
        "customFrames": custom_frames,
    }
    if custom_frames:
        entry["frames"] = frames
    config_path = config_json_path(animation_id)
    config_data = _read_config_json(config_path) or {}
    if config_data.get("gearUseTarget"):
        entry["gearUseTarget"] = True
    return entry


def scan_animations() -> list[dict]:
    if not ANIMATIONS_DIR.is_dir():
        return []

    entries: list[dict] = []
    for folder in sorted(ANIMATIONS_DIR.iterdir()):
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        png = find_png_in_folder(folder)
        if not png:
            continue
        entry = scan_animation_folder(folder.name, png)
        if entry:
            entries.append(entry)

    return entries


def sync_pixi_manifest(animations: list[dict]) -> None:
    max_w = max((a["width"] for a in animations), default=1)
    max_h = max((a["height"] for a in animations), default=1)
    sprites = []
    for entry in animations:
        sprites.append(
            {
                "name": entry["id"],
                "width": entry["width"],
                "height": entry["height"],
                "url": entry.get("url")
                or animation_sprite_url(entry["id"], entry["file"]),
                "layer": "object",
                "animated": True,
                "frameMs": entry.get("frameMs", DEFAULT_FRAME_MS),
                "displayScale": entry.get("displayScale", 1),
                **(
                    {"sortOriginY": entry.get("sortOriginY")}
                    if entry.get("sortOriginY") is not None
                    else {}
                ),
            }
        )
    PIXI_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    PIXI_MANIFEST_PATH.write_text(
        json.dumps({"width": max_w, "height": max_h, "sprites": sprites}, indent=2)
        + "\n",
        encoding="utf-8",
    )


def sync_manifest() -> list[dict]:
    animations = scan_animations()
    ANIMATIONS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps({"animations": animations}, indent=2) + "\n",
        encoding="utf-8",
    )
    sync_pixi_manifest(animations)
    return animations


def load_manifest() -> list[dict]:
    if MANIFEST_PATH.is_file():
        try:
            data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
            animations = data.get("animations")
            if isinstance(animations, list):
                loaded = [a for a in animations if isinstance(a, dict) and a.get("id")]
                if loaded:
                    return loaded
        except (json.JSONDecodeError, OSError):
            pass
    return sync_manifest()


def tile_id_for_animation(animation_id: str) -> str:
    return f"anim-{animation_id}"


if __name__ == "__main__":
    found = sync_manifest()
    print(f"Wrote {MANIFEST_PATH} ({len(found)} animations)")
