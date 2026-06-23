#!/usr/bin/env python3
"""Generate SaiPoke world — compact multi-biome map for gather-clone."""

import json
import math
import random
import uuid
from pathlib import Path
from typing import Optional

random.seed(2026)

# 40% smaller area than 81×96 → scale factor √0.6 ≈ 0.775
MAIN_W, MAIN_H = 63, 74
GROVE_W, GROVE_H = 25, 20
CX, CY = MAIN_W // 2, MAIN_H // 2
GRASS = "ground-normal_detailed_grass"
FLOWER_SHARE = 0.10
FLOWER_PATCH = int(math.sqrt(FLOWER_SHARE * MAIN_W * MAIN_H))

OUT = Path(__file__).resolve().parent.parent / "gather-clone/frontend/utils/defaultmap.json"

FLOORS = {
    "plaza": "ground-detailed_dirt",
    "grassland": GRASS,
    "forest": GRASS,
    "meadow": GRASS,
    "beach": "ground-detailed_sand",
    "city": "city-light_concrete",
    "highlands": "ground-solid_dirt",
    "lake": "ground-detailed_sand",
    "grove": GRASS,
}

FLOWER_CORNERS = {
    "nw": "grasslands-dark_green_flower_2",
    "ne": "grasslands-blue_flower_1",
    "sw": "grasslands-vibrant_green_flower_3",
}

SMALL_PROPS = [
    "grasslands-sign_2",
    "grasslands-sign_3",
    "grasslands-arrow_sign_right",
    "grasslands-arrow_sign_left",
    "village-mailbox",
    "city-down_sign",
    "grasslands-big_rock_1",
    "grasslands-big_rock_5",
]

MEDIUM_PROPS = [
    "grasslands-short_light_basic_tree_bundle",
    "grasslands-light_basic_tree",
    "village-lamp_post_left_off",
    "village-well_no_top_filled",
    "village-small_fountain",
    "village-sign_1",
    "city-red_car",
]

BOX_ITEM = "village-three_boxes"
LAMP_ROW_X, LAMP_ROW_Y = 25, 38


def tile_key(x: int, y: int) -> str:
    return f"{x}, {y}"


class WorldBuilder:
    def __init__(self, width: int, height: int):
        self.w = width
        self.h = height
        self.tiles: dict[str, dict] = {}
        self.occupied: set[tuple[int, int]] = set()

    def in_bounds(self, x: int, y: int) -> bool:
        return 0 <= x < self.w and 0 <= y < self.h

    def set(self, x: int, y: int, **props) -> None:
        if not self.in_bounds(x, y):
            return
        k = tile_key(x, y)
        if k not in self.tiles:
            self.tiles[k] = {}
        self.tiles[k].update(props)

    def mark_occupied(self, x: int, y: int, w: int, h: int) -> None:
        for dx in range(w):
            for dy in range(h):
                self.occupied.add((x + dx, y + dy))

    def can_place(self, x: int, y: int, w: int, h: int) -> bool:
        for dx in range(w):
            for dy in range(h):
                px, py = x + dx, y + dy
                if not self.in_bounds(px, py) or (px, py) in self.occupied:
                    return False
        return True

    def place_object(self, x: int, y: int, w: int, h: int, obj: str) -> bool:
        if not self.can_place(x, y, w, h):
            return False
        self.set(x, y, object=obj)
        self.mark_occupied(x, y, w, h)
        return True


def flower_corner_bounds(corner: str) -> tuple[int, int, int, int]:
    margin = 1
    if corner == "nw":
        return margin, margin, margin + FLOWER_PATCH - 1, margin + FLOWER_PATCH - 1
    if corner == "ne":
        return MAIN_W - margin - FLOWER_PATCH, margin, MAIN_W - margin - 1, margin + FLOWER_PATCH - 1
    if corner == "sw":
        return margin, MAIN_H - margin - FLOWER_PATCH, margin + FLOWER_PATCH - 1, MAIN_H - margin - 1
    if corner == "se":
        return (
            MAIN_W - margin - FLOWER_PATCH,
            MAIN_H - margin - FLOWER_PATCH,
            MAIN_W - margin - 1,
            MAIN_H - margin - 1,
        )
    raise ValueError(corner)


def in_flower_patch(x: int, y: int) -> Optional[str]:
    for corner in FLOWER_CORNERS:
        x0, y0, x1, y1 = flower_corner_bounds(corner)
        if x0 <= x <= x1 and y0 <= y <= y1:
            return corner
    return None


def biome(x: int, y: int) -> str:
    if in_flower_patch(x, y):
        return "grassland"

    dx, dy = x - CX, y - CY
    lake_x, lake_y = CX * 0.38, CY * 0.52
    if ((x - lake_x) ** 2) / 124 + ((y - lake_y) ** 2) / 54 < 1 and x < CX + 3:
        return "lake"
    if x > CX + 12 and y > CY + 7:
        return "beach"
    if x > CX + 9 and abs(y - CY) < 15:
        return "city"
    if x < CX - 11 and y < CY + 3:
        return "forest"
    if x < CX - 5 and y > CY + 8:
        return "meadow"
    if abs(dx) < 8 and abs(dy) < 6:
        return "plaza"
    if y < CY - 8:
        return "highlands"
    return "grassland"


def floor_for_tile(x: int, y: int) -> str:
    return FLOORS[biome(x, y)]


def fill_flower_meadow(builder: WorldBuilder, corner: str, flower: str) -> None:
    x0, y0, x1, y1 = flower_corner_bounds(corner)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            builder.set(x, y, floor=GRASS, object=flower)
            builder.mark_occupied(x, y, 1, 1)


def carve_path(builder: WorldBuilder, x0: int, y0: int, x1: int, y1: int) -> None:
    x, y = x0, y0
    while x != x1:
        builder.set(x, y, floor="ground-detailed_dirt")
        x += 1 if x1 > x else -1
    while y != y1:
        builder.set(x, y, floor="ground-detailed_dirt")
        y += 1 if y1 > y else -1
    builder.set(x1, y1, floor="ground-detailed_dirt")


def scatter(
    builder: WorldBuilder,
    count: int,
    pool: list[str],
    w: int,
    h: int,
    pred,
    spacing: int = 2,
) -> None:
    placed = 0
    attempts = 0
    while placed < count and attempts < count * 120:
        attempts += 1
        x = random.randint(2, builder.w - w - 3)
        y = random.randint(2, builder.h - h - 3)
        if not pred(x, y):
            continue
        too_close = False
        for ox, oy in builder.occupied:
            if abs(ox - x) + abs(oy - y) < spacing:
                too_close = True
                break
        if too_close:
            continue
        if builder.place_object(x, y, w, h, random.choice(pool)):
            placed += 1


def place_lamp_row(builder: WorldBuilder) -> None:
    offsets = [(0, 0), (3, 1), (6, -1), (9, 0), (12, 1), (-3, 0), (-6, -1)]
    for dx, dy in offsets:
        builder.place_object(LAMP_ROW_X + dx, LAMP_ROW_Y + dy, 2, 2, "village-lamp_post_right_on")


def place_boxes(builder: WorldBuilder) -> None:
    builder.place_object(5, 3, 2, 2, BOX_ITEM)
    scatter(
        builder,
        9,
        [BOX_ITEM],
        2,
        2,
        lambda x, y: in_flower_patch(x, y) is None and biome(x, y) != "plaza",
        spacing=4,
    )


def build_main_world() -> WorldBuilder:
    b = WorldBuilder(MAIN_W, MAIN_H)

    for x in range(MAIN_W):
        for y in range(MAIN_H):
            b.set(x, y, floor=floor_for_tile(x, y))

    for corner, flower in FLOWER_CORNERS.items():
        fill_flower_meadow(b, corner, flower)

    carve_path(b, CX, 2, CX, MAIN_H - 3)
    carve_path(b, 2, CY, MAIN_W - 3, CY)
    carve_path(b, CX - 5, CY - 5, CX + 5, CY - 5)
    carve_path(b, CX - 5, CY + 5, CX + 5, CY + 5)

    plaza_id = str(uuid.uuid4())
    for x in range(CX - 5, CX + 6):
        for y in range(CY - 4, CY + 5):
            b.set(x, y, floor="ground-detailed_dirt", privateAreaId=plaza_id)
            if "object" in b.tiles.get(tile_key(x, y), {}):
                del b.tiles[tile_key(x, y)]["object"]

    b.place_object(CX - 1, CY - 2, 2, 2, "village-small_fountain")
    b.place_object(CX - 7, CY - 1, 2, 2, "village-lamp_post_right_on")
    b.place_object(CX + 6, CY - 1, 2, 2, "village-lamp_post_left_off")
    b.place_object(CX - 1, CY + 5, 2, 2, "village-well_no_top_filled")
    b.place_object(CX + 5, CY + 3, 2, 2, "village-mailbox")
    b.place_object(CX + 3, CY - 4, 1, 1, "grasslands-sign_2")

    place_lamp_row(b)
    place_boxes(b)

    scatter(
        b,
        12,
        ["grasslands-short_light_basic_tree_bundle", "grasslands-light_basic_tree"],
        3,
        3,
        lambda x, y: biome(x, y) == "forest" and in_flower_patch(x, y) is None,
        spacing=3,
    )
    scatter(
        b,
        12,
        SMALL_PROPS,
        1,
        1,
        lambda x, y: biome(x, y) in ("meadow", "grassland", "highlands")
        and in_flower_patch(x, y) is None,
        spacing=2,
    )
    scatter(
        b,
        6,
        MEDIUM_PROPS,
        2,
        2,
        lambda x, y: biome(x, y) in ("city", "beach") and in_flower_patch(x, y) is None,
        spacing=3,
    )

    b.place_object(CX + 15, CY - 2, 3, 2, "city-red_car")

    portal_x, portal_y = CX + 9, CY
    b.set(portal_x, portal_y, floor="ground-detailed_dirt")
    b.set(
        portal_x,
        portal_y,
        teleporter={"roomIndex": 1, "x": 3, "y": 10},
        object="grasslands-arrow_sign_right",
    )

    for x in range(MAIN_W):
        b.set(x, 0, object="grasslands-stone_wall_top")
        b.set(x, MAIN_H - 1, object="grasslands-stone_wall_bottom")
    for y in range(MAIN_H):
        b.set(0, y, object="grasslands-stone_wall_left")
        b.set(MAIN_W - 1, y, object="grasslands-stone_wall_right")

    return b


def build_grove() -> WorldBuilder:
    b = WorldBuilder(GROVE_W, GROVE_H)
    grove_id = str(uuid.uuid4())

    for x in range(GROVE_W):
        for y in range(GROVE_H):
            b.set(x, y, floor=GRASS, privateAreaId=grove_id)

    scatter(
        b,
        5,
        ["grasslands-short_light_basic_tree_bundle", "grasslands-light_basic_tree"],
        3,
        3,
        lambda x, y: True,
        spacing=3,
    )

    b.place_object(11, 5, 2, 2, "village-well_no_top_filled")
    b.place_object(6, 8, 2, 2, "village-lamp_post_right_on")

    b.set(
        3,
        10,
        floor="ground-detailed_dirt",
        teleporter={"roomIndex": 0, "x": CX + 9, "y": CY},
        object="grasslands-arrow_sign_left",
    )

    for x in range(GROVE_W):
        b.set(x, 0, object="grasslands-fence_top")
        b.set(x, GROVE_H - 1, object="grasslands-fence_bottom")
    for y in range(GROVE_H):
        b.set(0, y, object="grasslands-fence_left")
        b.set(GROVE_W - 1, y, object="grasslands-fence_right")

    return b


def main() -> None:
    main_world = build_main_world()
    grove = build_grove()
    total = MAIN_W * MAIN_H
    patch_tiles = FLOWER_PATCH * FLOWER_PATCH

    world = {
        "spawnpoint": {"roomIndex": 0, "x": CX, "y": CY + 2},
        "rooms": [
            {"name": "SaiPoke Realm", "tilemap": main_world.tiles},
            {"name": "Moonlit Grove", "tilemap": grove.tiles},
        ],
    }

    OUT.write_text(json.dumps(world, separators=(",", ":")))
    print(f"Wrote {OUT}")
    print(f"  Room 0: {len(main_world.tiles)} tiles ({MAIN_W}x{MAIN_H})")
    print(f"  Flower patch: {FLOWER_PATCH}x{FLOWER_PATCH} = {patch_tiles} tiles ({100*patch_tiles/total:.1f}% each)")
    print(f"  Room 1: {len(grove.tiles)} tiles ({GROVE_W}x{GROVE_H})")
    print(f"  Spawn: ({CX}, {CY + 2})")


if __name__ == "__main__":
    main()
