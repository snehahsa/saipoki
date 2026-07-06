"""Parse gather-clone spritesheet metadata for the map builder."""

import json
import re
import shutil
import struct
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
SHEET_DIR = ROOT / "gather-clone/frontend/utils/pixi/spritesheet"
SINGLE_DIR = ROOT / "gather-clone/frontend/public/sprites/spritesheets/single"
STATIC_SINGLE_DIR = ROOT / "static/sprites/spritesheets/single"
SCIFI_DIR = ROOT / "gather-clone/frontend/public/sprites/scifi"
MANIFEST_PATH = SHEET_DIR / "single.manifest.json"
STATIC_SINGLE_MANIFEST_PATH = STATIC_SINGLE_DIR / "manifest.json"
SCIFI_MANIFEST_PATH = SHEET_DIR / "scifi.manifest.json"
SHEET_NAMES = ("ground", "grasslands", "village", "city", "single", "scifi", "anim")
FOLDER_SHEETS: dict[str, dict] = {
    "scifi": {"dir": SCIFI_DIR, "default_layer": "floor"},
}

SPRITE_RE = re.compile(
    r"\{\s*name:\s*'([^']+)',\s*x:\s*(\d+),\s*y:\s*(\d+),\s*width:\s*(\d+),\s*height:\s*(\d+)"
    r"(?:,\s*layer:\s*'([^']+)')?"
)


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        handle.seek(16)
        return struct.unpack(">II", handle.read(8))


def default_colliders(width: int, height: int, tile: int = 32) -> list[dict]:
    cols = max(1, (width + tile - 1) // tile)
    rows = max(1, (height + tile - 1) // tile)
    bottom = rows - 1
    return [{"x": col, "y": bottom} for col in range(cols)]


def point_in_polygon(x: float, y: float, polygon: list[dict]) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi = polygon[i]["x"] + 0.5
        yi = polygon[i]["y"] + 0.5
        xj = polygon[j]["x"] + 0.5
        yj = polygon[j]["y"] + 0.5
        intersect = ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi
        )
        if intersect:
            inside = not inside
        j = i
    return inside


def colliders_from_boundary(
    boundary: list[dict], width: int, height: int, tile: int = 32
) -> list[dict]:
    cols = max(1, (width + tile - 1) // tile)
    rows = max(1, (height + tile - 1) // tile)
    colliders: list[dict] = []
    for ty in range(rows):
        for tx in range(cols):
            if point_in_polygon(tx + 0.5, ty + 0.5, boundary):
                colliders.append({"x": tx, "y": ty})
    return colliders


def single_sprite_name(sprite_id: str) -> Optional[str]:
    if not sprite_id.startswith("single-"):
        return None
    return sprite_id[len("single-") :]


def single_sidecar_path(sprite_id: str) -> Optional[Path]:
    name = single_sprite_name(sprite_id)
    if not name:
        return None
    return SINGLE_DIR / f"{name}.json"


def load_single_meta(name: str) -> dict:
    sidecar = SINGLE_DIR / f"{name}.json"
    if sidecar.exists():
        return json.loads(sidecar.read_text(encoding="utf-8"))
    return {}


def save_single_meta(name: str, meta: dict) -> Path:
    SINGLE_DIR.mkdir(parents=True, exist_ok=True)
    sidecar = SINGLE_DIR / f"{name}.json"
    sidecar.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return sidecar


def parse_sheet(sheet_name: str) -> dict:
    path = SHEET_DIR / f"{sheet_name}.ts"
    content = path.read_text(encoding="utf-8")

    width = int(re.search(r"const width = (\d+)", content).group(1))
    height = int(re.search(r"const height = (\d+)", content).group(1))
    png_path = ROOT / "gather-clone/frontend/public/sprites/spritesheets" / f"{sheet_name}.png"
    version = int(png_path.stat().st_mtime) if png_path.exists() else 0
    url = f"/sprites/spritesheets/{sheet_name}.png?v={version}"

    sprites = []
    seen = {}
    for match in SPRITE_RE.finditer(content):
        name, x, y, w, h, layer = match.groups()
        if name == "empty" or int(w) == 0 or int(h) == 0:
            continue
        entry = {
            "name": name,
            "id": f"{sheet_name}-{name}",
            "sheet": sheet_name,
            "x": int(x),
            "y": int(y),
            "width": int(w),
            "height": int(h),
            "layer": layer or "floor",
            "anchorX": 0,
            "anchorY": round(1 - (32 / int(h)), 6),
        }
        if name in seen:
            sprites[seen[name]] = entry
        else:
            seen[name] = len(sprites)
            sprites.append(entry)

    return {
        "name": sheet_name,
        "url": url,
        "width": width,
        "height": height,
        "sprites": sprites,
    }


def parse_image_folder(sheet_name: str, folder: Path, *, default_layer: str = "floor") -> dict:
    """Individual PNGs in a folder (e.g. sprites/scifi/tile001.png)."""
    sprites: list[dict] = []
    max_w = 0
    max_h = 0

    if folder.is_dir():
        for png_path in sorted(folder.glob("*.png")):
            name = png_path.stem
            width, height = png_size(png_path)
            max_w = max(max_w, width)
            max_h = max(max_h, height)

            version = int(png_path.stat().st_mtime)
            url = f"/sprites/{sheet_name}/{png_path.name}?v={version}"
            height = max(height, 1)

            sprites.append(
                {
                    "name": name,
                    "id": f"{sheet_name}-{name}",
                    "sheet": sheet_name,
                    "x": 0,
                    "y": 0,
                    "width": width,
                    "height": height,
                    "layer": default_layer,
                    "url": url,
                    "colliders": [],
                    "boundary": [],
                    "anchorX": 0,
                    "anchorY": round(1 - (32 / height), 6),
                    "defaultScale": 1,
                }
            )

    return {
        "name": sheet_name,
        "type": "folder",
        "url": None,
        "width": max_w,
        "height": max_h,
        "sprites": sprites,
    }


def sync_folder_manifest(sheet: dict, manifest_path: Path) -> dict:
    manifest = {
        "width": sheet["width"],
        "height": sheet["height"],
        "sprites": [
            {
                "name": sprite["name"],
                "width": sprite["width"],
                "height": sprite["height"],
                "url": sprite["url"].split("?")[0],
                "layer": sprite["layer"],
            }
            for sprite in sheet["sprites"]
        ],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return sheet


def _single_source_dir() -> Path:
    """Prefer gather-clone singles when present; otherwise use committed static/ copy."""
    if SINGLE_DIR.is_dir() and any(SINGLE_DIR.glob("*.png")):
        return SINGLE_DIR
    if STATIC_SINGLE_DIR.is_dir() and any(STATIC_SINGLE_DIR.glob("*.png")):
        return STATIC_SINGLE_DIR
    return SINGLE_DIR if SINGLE_DIR.is_dir() else STATIC_SINGLE_DIR


def parse_single() -> dict:
    sprites = []
    max_w = 0
    max_h = 0

    source_dir = _single_source_dir()
    source_dir.mkdir(parents=True, exist_ok=True)

    for png_path in sorted(source_dir.glob("*.png")):
        name = png_path.stem
        width, height = png_size(png_path)
        max_w = max(max_w, width)
        max_h = max(max_h, height)

        meta: dict = {}
        sidecar = source_dir / f"{name}.json"
        if sidecar.exists():
            meta = json.loads(sidecar.read_text(encoding="utf-8"))

        layer = meta.get("layer", "object")
        colliders = meta.get("colliders")
        boundary = meta.get("boundary")
        default_scale = meta.get("scale", 1)
        sort_origin_y = meta.get("sortOriginY")
        if colliders is None and boundary:
            colliders = colliders_from_boundary(boundary, width, height)
        if colliders is None and layer == "object":
            colliders = default_colliders(width, height)
        if sort_origin_y is None and colliders:
            sort_origin_y = max(c["y"] for c in colliders) + 1

        version = int(png_path.stat().st_mtime)
        url = f"/sprites/spritesheets/single/{png_path.name}?v={version}"

        sprites.append(
            {
                "name": name,
                "id": f"single-{name}",
                "sheet": "single",
                "x": 0,
                "y": 0,
                "width": width,
                "height": height,
                "layer": layer,
                "url": url,
                "colliders": colliders or [],
                "boundary": boundary or [],
                "anchorX": 0,
                "anchorY": round(
                    (sort_origin_y * 32 / height) if sort_origin_y else (1 - (32 / height)), 6
                ),
                "sortOriginY": sort_origin_y,
                "defaultScale": default_scale,
            }
        )

    return {
        "name": "single",
        "type": "single",
        "url": None,
        "width": max_w,
        "height": max_h,
        "sprites": sprites,
    }


def _single_manifest_payload(single: dict) -> dict:
    return {
        "width": single["width"],
        "height": single["height"],
        "sprites": [
            {
                "name": sprite["name"],
                "width": sprite["width"],
                "height": sprite["height"],
                "url": sprite["url"].split("?")[0],
                "layer": sprite["layer"],
                "colliders": sprite.get("colliders") or [],
                **({"sortOriginY": sprite["sortOriginY"]} if sprite.get("sortOriginY") is not None else {}),
            }
            for sprite in single["sprites"]
        ],
    }


def sync_single_manifest() -> dict:
    single = parse_single()
    manifest = _single_manifest_payload(single)
    # gather-clone is optional on Railway — only write back when submodule is checked out.
    if (ROOT / "gather-clone/frontend").is_dir():
        MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return single


def publish_single_assets() -> dict:
    """Sync manifest from PNGs and copy sprites + manifest into static/ for the live game."""
    single = sync_single_manifest()
    if not single.get("sprites") and STATIC_SINGLE_MANIFEST_PATH.is_file():
        print("publish_single_assets: using existing static/sprites/spritesheets/single/manifest.json")
        return single

    manifest = _single_manifest_payload(single)

    STATIC_SINGLE_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_SINGLE_MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    source_dir = _single_source_dir()
    if source_dir.is_dir() and source_dir != STATIC_SINGLE_DIR:
        for path in source_dir.iterdir():
            if path.suffix.lower() in {".png", ".json"}:
                shutil.copy2(path, STATIC_SINGLE_DIR / path.name)

    return single


def parse_anim_sheet() -> dict:
    from animation_catalog import (
        load_animation_frames,
        load_manifest as load_animation_manifest,
    )

    animations = load_animation_manifest()
    sprites = []
    max_w = 1
    max_h = 1
    for entry in animations:
        frame_data = load_animation_frames(entry["id"], entry)
        frames = frame_data.get("frames") or entry.get("frames") or {}
        loop0 = frames.get("loop_0")
        if not loop0:
            fw = entry.get("frameWidth") or max(1, entry.get("width", 1) // 3)
            fh = entry.get("frameHeight") or entry.get("height", 1)
            loop0 = {"x": 0, "y": 0, "w": fw, "h": fh}

        sheet_w = entry.get("width", loop0["w"])
        sheet_h = entry.get("height", loop0["h"])
        max_w = max(max_w, loop0["w"])
        max_h = max(max_h, loop0["h"])
        sprite_path = entry.get("path") or f"{entry['id']}/{entry['file']}"
        colliders = default_colliders(loop0["w"], loop0["h"])
        sprites.append(
            {
                "id": f"anim-{entry['id']}",
                "name": entry["id"],
                "sheet": "anim",
                "x": loop0["x"],
                "y": loop0["y"],
                "srcX": loop0["x"],
                "srcY": loop0["y"],
                "width": loop0["w"],
                "height": loop0["h"],
                "imageWidth": sheet_w,
                "imageHeight": sheet_h,
                "layer": "object",
                "url": entry.get("url") or f"/sprites/animations/{sprite_path}",
                "animated": True,
                "frameMs": entry.get("frameMs", 120),
                "defaultScale": entry.get("displayScale", 1),
                "colliders": colliders,
            }
        )
    return {
        "name": "anim",
        "type": "anim",
        "url": None,
        "width": max_w,
        "height": max_h,
        "sprites": sprites,
    }


def build_catalog() -> dict:
    from animation_catalog import sync_manifest as sync_animation_manifest

    sync_animation_manifest()
    single = sync_single_manifest()
    anim = parse_anim_sheet()
    atlas_sheets = [parse_sheet(name) for name in SHEET_NAMES if name not in ("single", "scifi", "anim")]
    folder_sheets = []
    for sheet_name, cfg in FOLDER_SHEETS.items():
        sheet = parse_image_folder(
            sheet_name,
            cfg["dir"],
            default_layer=cfg.get("default_layer", "floor"),
        )
        manifest_path = SHEET_DIR / f"{sheet_name}.manifest.json"
        sync_folder_manifest(sheet, manifest_path)
        folder_sheets.append(sheet)

    sheets = atlas_sheets + [single] + folder_sheets + [anim]

    all_sprites = []
    for sheet in sheets:
        all_sprites.extend(sheet["sprites"])

    return {
        "sheets": sheets,
        "sprites": all_sprites,
        "tileSize": 32,
    }


if __name__ == "__main__":
    print(json.dumps(build_catalog(), indent=2)[:1200])
