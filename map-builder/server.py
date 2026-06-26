#!/usr/bin/env python3
"""SaiPoke map builder — visual editor on port 9001."""

import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from flask import Flask, jsonify, render_template, request, send_from_directory

from sprite_catalog import (
    SINGLE_DIR,
    build_catalog,
    colliders_from_boundary,
    load_single_meta,
    png_size,
    save_single_meta,
    single_sidecar_path,
    single_sprite_name,
    publish_single_assets,
    sync_single_manifest,
)
from animation_catalog import (
    load_animation_frames,
    load_manifest as load_animation_manifest,
    save_animation_frames,
    sync_manifest as sync_animation_manifest,
)
from animal_catalog import (
    load_animal_frames,
    load_manifest as load_animal_manifest,
    save_animal_frames,
)
from gear_catalog import (
    GEAR_ITEMS,
    gear_catalog_for_client,
    gear_item_client_meta,
    load_saved_item_config,
    resolve_faces,
    save_item_config,
)

WORLD_MAP_PATH = ROOT / "gather-clone/frontend/utils/defaultmap.json"
DEPLOY_MAP_PATHS = (
    ROOT / "data/defaultmap.json",
    ROOT / "game-server/data/defaultmap.json",
)
BACKUP_DIR = ROOT / "map-builder/backups"
SPRITES_ROOT = ROOT / "gather-clone/frontend/public/sprites"

app = Flask(
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/static",
)


@app.route("/")
def index():
    return render_template("index.html")


def write_world_map(payload: dict) -> None:
    serialized = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    WORLD_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
    WORLD_MAP_PATH.write_text(serialized, encoding="utf-8")
    for deploy_path in DEPLOY_MAP_PATHS:
        deploy_path.parent.mkdir(parents=True, exist_ok=True)
        deploy_path.write_text(serialized, encoding="utf-8")


@app.route("/api/sprites")
def api_sprites():
    return jsonify(build_catalog())


@app.route("/api/characters")
def api_characters():
    skins = [f"{i:03d}" for i in range(1, 84)]
    return jsonify({"skins": skins, "defaultSkin": "009"})


@app.route("/api/animations")
def api_animations():
    return jsonify({"animations": load_animation_manifest()})


@app.route("/api/animations/<animation_id>/frames", methods=["GET"])
def api_get_animation_frames(animation_id: str):
    animations = {a["id"]: a for a in load_animation_manifest()}
    entry = animations.get(animation_id)
    if not entry:
        return jsonify({"error": f"Animation not found: {animation_id}"}), 404

    frame_data = load_animation_frames(animation_id, entry)
    return jsonify(
        {
            "animation": entry,
            "customFrames": frame_data.get("customFrames", False),
            "displayScale": frame_data.get("displayScale", entry.get("displayScale")),
            "frameMs": frame_data.get("frameMs", entry.get("frameMs", 120)),
            "frameWidth": frame_data.get("frameWidth", entry.get("frameWidth")),
            "frameHeight": frame_data.get("frameHeight", entry.get("frameHeight")),
            "frames": frame_data.get("frames", {}),
            "gearUseTarget": bool(
                frame_data.get("gearUseTarget") or entry.get("gearUseTarget")
            ),
            "sidecar": f"{animation_id}/{animation_id}.json",
        }
    )


@app.route("/api/animations/<animation_id>/frames", methods=["POST"])
def api_save_animation_frames(animation_id: str):
    payload = request.get_json(silent=True) or {}
    frames = payload.get("frames")
    if not isinstance(frames, dict):
        return jsonify({"error": "frames object required"}), 400

    try:
        saved = save_animation_frames(
            animation_id,
            frames,
            display_scale=payload.get("displayScale"),
            frame_ms=payload.get("frameMs"),
            frame_width=payload.get("frameWidth"),
            frame_height=payload.get("frameHeight"),
            gear_use_target=payload.get("gearUseTarget"),
        )
    except ValueError as err:
        return jsonify({"error": str(err)}), 400

    animations = load_animation_manifest()
    entry = next((a for a in animations if a.get("id") == animation_id), None)
    return jsonify(
        {
            "ok": True,
            "animation": entry,
            "frames": saved.get("frames", {}),
            "frameMs": saved.get("frameMs"),
            "message": "Animation frames saved. Re-enter the realm to see updated sprites.",
        }
    )


@app.route("/api/animals")
def api_animals():
    return jsonify({"animals": load_animal_manifest()})


@app.route("/api/animals/<animal_id>/frames", methods=["GET"])
def api_get_animal_frames(animal_id: str):
    animals = {a["id"]: a for a in load_animal_manifest()}
    entry = animals.get(animal_id)
    if not entry:
        return jsonify({"error": f"Animal not found: {animal_id}"}), 404

    frame_data = load_animal_frames(animal_id, entry)
    return jsonify(
        {
            "animal": entry,
            "customFrames": frame_data.get("customFrames", False),
            "displayScale": frame_data.get("displayScale", entry.get("displayScale")),
            "frames": frame_data.get("frames", {}),
            "sidecar": f"{animal_id}.frames.json",
        }
    )


@app.route("/api/animals/<animal_id>/frames", methods=["POST"])
def api_save_animal_frames(animal_id: str):
    payload = request.get_json(silent=True) or {}
    frames = payload.get("frames")
    if not isinstance(frames, dict):
        return jsonify({"error": "frames object required"}), 400

    try:
        saved = save_animal_frames(
            animal_id,
            frames,
            display_scale=payload.get("displayScale"),
        )
    except ValueError as err:
        return jsonify({"error": str(err)}), 400

    animals = load_animal_manifest()
    entry = next((a for a in animals if a.get("id") == animal_id), None)
    return jsonify(
        {
            "ok": True,
            "animal": entry,
            "frames": saved.get("frames", {}),
            "message": "Animal frames saved. Re-enter the realm to see updated sprites.",
        }
    )


@app.route("/api/gear/items")
def api_gear_items():
    return jsonify({"items": list(gear_catalog_for_client().values())})


@app.route("/api/gear/items/<item_id>", methods=["GET"])
def api_get_gear_item(item_id: str):
    if item_id not in GEAR_ITEMS:
        return jsonify({"error": f"Gear item not found: {item_id}"}), 404
    meta = gear_item_client_meta(item_id)
    meta["faces"] = resolve_faces(item_id, load_saved_item_config(item_id))
    return jsonify(meta)


@app.route("/api/gear/items/<item_id>", methods=["POST"])
def api_save_gear_item(item_id: str):
    if item_id not in GEAR_ITEMS:
        return jsonify({"error": f"Gear item not found: {item_id}"}), 404
    payload = request.get_json(silent=True) or {}
    try:
        save_item_config(item_id, payload)
    except ValueError as err:
        return jsonify({"error": str(err)}), 400
    return jsonify(
        {
            "ok": True,
            "item": gear_item_client_meta(item_id),
            "message": "Gear attach saved. Re-enter the realm to see updated overlay.",
        }
    )


@app.route("/api/map", methods=["GET"])
def api_get_map():
    if not WORLD_MAP_PATH.exists():
        return jsonify({"error": "Map file not found"}), 404
    return jsonify(json.loads(WORLD_MAP_PATH.read_text(encoding="utf-8")))


@app.route("/api/map", methods=["POST"])
def api_save_map():
    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"error": "Invalid JSON body"}), 400

    if "spawnpoint" not in payload or "rooms" not in payload:
        return jsonify({"error": "Map must include spawnpoint and rooms"}), 400

    if not isinstance(payload["rooms"], list) or len(payload["rooms"]) == 0:
        return jsonify({"error": "Map must have at least one room"}), 400

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    if WORLD_MAP_PATH.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = BACKUP_DIR / f"defaultmap-{stamp}.json"
        shutil.copy2(WORLD_MAP_PATH, backup_path)

    WORLD_MAP_PATH.parent.mkdir(parents=True, exist_ok=True)
    write_world_map(payload)
    published = publish_single_assets()

    return jsonify(
        {
            "ok": True,
            "path": str(WORLD_MAP_PATH.relative_to(ROOT)),
            "deployed": [str(p.relative_to(ROOT)) for p in DEPLOY_MAP_PATHS],
            "singleSprites": len(published.get("sprites") or []),
            "message": "Map saved. Single sprites synced to static/ — re-enter the realm to see new tiles.",
        }
    )


@app.route("/api/sprite-meta/<sprite_id>", methods=["GET"])
def api_get_sprite_meta(sprite_id: str):
    name = single_sprite_name(sprite_id)
    if not name:
        return jsonify({"error": "Boundary editing is only available for single sprites"}), 400

    png_path = SINGLE_DIR / f"{name}.png"
    if not png_path.exists():
        return jsonify({"error": f"Sprite not found: {sprite_id}"}), 404

    meta = load_single_meta(name)
    return jsonify({"spriteId": sprite_id, "name": name, "meta": meta})


@app.route("/api/sprite-meta/<sprite_id>", methods=["POST"])
def api_save_sprite_meta(sprite_id: str):
    name = single_sprite_name(sprite_id)
    if not name:
        return jsonify({"error": "Boundary editing is only available for single sprites"}), 400

    png_path = SINGLE_DIR / f"{name}.png"
    if not png_path.exists():
        return jsonify({"error": f"Sprite not found: {sprite_id}"}), 404

    payload = request.get_json(silent=True) or {}
    boundary = payload.get("boundary")
    if not isinstance(boundary, list) or len(boundary) < 3:
        return jsonify({"error": "Boundary needs at least 3 points"}), 400

    cleaned_boundary = []
    for point in boundary:
        if not isinstance(point, dict) or "x" not in point or "y" not in point:
            return jsonify({"error": "Each boundary point needs x and y"}), 400
        cleaned_boundary.append({"x": int(point["x"]), "y": int(point["y"])})

    width, height = png_size(png_path)
    colliders = colliders_from_boundary(cleaned_boundary, width, height)
    if not colliders:
        return jsonify({"error": "Boundary polygon covers no tiles"}), 400

    existing = load_single_meta(name)
    meta = {
        **existing,
        "layer": payload.get("layer", existing.get("layer", "object")),
        "boundary": cleaned_boundary,
        "colliders": colliders,
    }
    if "scale" in payload:
        meta["scale"] = payload["scale"]
    elif "scale" in existing:
        meta["scale"] = existing["scale"]

    save_single_meta(name, meta)
    publish_single_assets()

    return jsonify(
        {
            "ok": True,
            "path": str(single_sidecar_path(sprite_id).relative_to(ROOT)),
            "colliders": colliders,
            "message": "Boundary saved. Re-enter the realm to see updated colliders.",
        }
    )


@app.route("/sprites/<path:filename>")
def serve_sprites(filename):
    return send_from_directory(SPRITES_ROOT, filename)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9001, debug=True)
