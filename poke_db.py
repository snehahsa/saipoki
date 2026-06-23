"""Build and load poke.json — card DB from pool images + OCR."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from difflib import get_close_matches
from pathlib import Path

from card_ocr import OCR_CACHE_PATH, POOL_IMAGE_EXTS, read_card_from_image
from poke_registry import assign_catalog_ids, is_catalog_id, load_poke_json, pokemon_slug

ROOT = Path(__file__).resolve().parent
POKE_JSON_PATH = ROOT / "poke.json"
POKECARDS_PATH = ROOT / "pokecards.py"
POOL_DIR = ROOT / "static" / "pool"
DUPES_DIR_NAME = "_duplicates"

TYPE_MAP = {
    "BASIC": "Basic",
    "FIRE": "Fire",
    "WATER": "Water",
    "GRASS": "Grass",
    "ROCK": "Rock",
    "GHOST": "Ghost",
    "ELECTRIC": "Electric",
    "LEGENDARY": "Legendary",
}

MOVES_CROP = {"top": 0.48, "bottom": 0.88, "left": 0.04, "right": 0.96}
INFO_CROP = {"top": 0.43, "bottom": 0.51, "left": 0.04, "right": 0.96}


def pokemon_file_stem(name: str) -> str:
    return pokemon_slug(name)


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _clear_ocr_cache() -> None:
    if OCR_CACHE_PATH.exists():
        OCR_CACHE_PATH.unlink()


def _clear_ocr_cache_entry(path: Path) -> None:
    from card_ocr import _load_cache, _save_cache

    cache = _load_cache()
    key = str(path.resolve())
    if key in cache:
        del cache[key]
        _save_cache(cache)


def _safe_move_to_duplicates(path: Path, dup_dir: Path) -> Path:
    """Move a file into _duplicates without overwriting."""
    dup_dir.mkdir(parents=True, exist_ok=True)
    target = dup_dir / path.name
    if target.exists():
        stem, ext = path.stem, path.suffix
        n = 2
        while True:
            candidate = dup_dir / f"{stem}-{n}{ext}"
            if not candidate.exists():
                target = candidate
                break
            n += 1
    shutil.move(str(path), str(target))
    _clear_ocr_cache_entry(path)
    return target


def parse_pokecards_seed(path: Path | None = None) -> dict[str, dict]:
    path = path or POKECARDS_PATH
    if not path.is_file():
        return {}

    text = path.read_text(encoding="utf-8")
    entries: dict[str, dict] = {}
    blocks = re.split(r"PokemonBase\s*\(", text)[1:]

    for block in blocks:
        name_m = re.search(r"name='([^']+)'", block)
        if not name_m:
            continue
        name = name_m.group(1)

        hp_m = re.search(r"hp=(\d+)", block)
        lvl_m = re.search(r"lvl=(\d+)", block)
        url_m = re.search(r"url='([^']+)'", block)
        type_m = re.search(r"type=PokemonType\.(\w+)", block)

        spells = []
        for sm in re.finditer(
            r"Spell\('([^']+)',\s*(\d+),\s*(True|False),\s*(\d+)",
            block,
        ):
            spells.append(
                {
                    "name": sm.group(1),
                    "attack": int(sm.group(2)),
                    "is_defence": sm.group(3) == "True",
                    "max_count": int(sm.group(4)),
                }
            )

        card_id_m = re.search(r"card_id='([^']+)'", block)
        shuffle_m = re.search(r"shuffle=(True|False)", block)

        type_key = type_m.group(1) if type_m else "BASIC"
        entry = {
            "name": name,
            "hp": int(hp_m.group(1)) if hp_m else 50,
            "lvl": int(lvl_m.group(1)) if lvl_m else 1,
            "url": url_m.group(1) if url_m else "",
            "type": TYPE_MAP.get(type_key, "Basic"),
            "spells": spells,
        }
        if card_id_m and is_catalog_id(card_id_m.group(1)):
            entry["card_id"] = card_id_m.group(1)
        if shuffle_m:
            entry["shuffle"] = shuffle_m.group(1) == "True"
        entries[name.lower()] = entry

    return entries


def _normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _find_seed_by_spell_text(moves_raw: str, seed: dict[str, dict]) -> dict | None:
    """Match pokecards entry by spell names / species name found in OCR text."""
    if not moves_raw or not seed:
        return None
    raw_key = _normalize_key(moves_raw)
    best_entry = None
    best_score = 0

    for entry in seed.values():
        score = 0
        name_key = _normalize_key(entry.get("name", ""))
        if len(name_key) >= 5 and name_key in raw_key:
            score += 12
        for spell in entry.get("spells", []):
            spell_name = spell.get("name", "")
            spell_key = _spell_key(spell)
            if len(spell_key) >= 4 and spell_key in raw_key:
                score += 3
                continue
            for token in re.findall(r"[a-z]{4,}", spell_name.lower()):
                if token in raw_key:
                    score += 1
        if score > best_score:
            best_score = score
            best_entry = entry

    if not best_entry:
        return None
    name_key = _normalize_key(best_entry.get("name", ""))
    if len(name_key) >= 5 and name_key in raw_key:
        return best_entry
    spell_score = 0
    for spell in best_entry.get("spells", []):
        spell_key = _spell_key(spell)
        if len(spell_key) >= 4 and spell_key in raw_key:
            spell_score += 3
    return best_entry if spell_score >= 6 else None


def _find_seed_by_type_hint(
    ocr_type: str,
    info_raw: str,
    seed: dict[str, dict],
) -> dict | None:
    """Last-resort match when banner OCR names a single plausible type hint."""
    banner_type = ocr_type
    match = re.search(
        r"\b(FIRE|WATER|GRASS|ROCK|GHOST|ELECTRIC|LEGENDARY|BASIC)\b",
        info_raw or "",
        re.I,
    )
    if match:
        banner_type = TYPE_MAP.get(match.group(1).upper(), banner_type)

    norm = _normalize_key(info_raw or "")
    candidates: list[tuple[int, dict]] = []
    for entry in seed.values():
        if entry.get("type") != banner_type:
            continue
        score = 2
        name_key = _normalize_key(entry.get("name", ""))
        if len(name_key) >= 5 and name_key in norm:
            score += 20
        if "legendary" in norm and entry.get("type") == "Legendary":
            score += 8
        if re.search(r"\bno\.?\s*96\b", info_raw or "", re.I) and name_key == "genger":
            score += 20
        candidates.append((score, entry))

    if not candidates:
        return None
    candidates.sort(key=lambda row: row[0], reverse=True)
    if candidates[0][0] >= 20:
        return candidates[0][1]
    return None


def _looks_like_garbage_name(name: str, stem: str) -> bool:
    combined = f"{name} {stem}".lower()
    if re.search(r"\d{4}[-\s]?\d{2}[-\s]?\d{2}", combined):
        return True
    if re.match(r"^\d{6,}$", pokemon_file_stem(name)):
        return True
    return False


def _is_non_pokemon_filename(stem: str) -> bool:
    """Screenshots / timestamps — not already named like `charizard.jpg`."""
    if _looks_like_garbage_name(stem, stem):
        return True
    if re.match(r"^IMG[_\-\s]", stem, re.I):
        return True
    if re.match(r"^Screenshot", stem, re.I):
        return True
    if re.match(r"^\d{4}[\s.\-]\d{2}", stem):
        return True
    return False


def _find_seed(seed: dict[str, dict], *candidates: str) -> dict | None:
    if not seed:
        return None
    keys = list(seed.keys())
    for raw in candidates:
        if not raw:
            continue
        key = _normalize_key(raw)
        if key in seed:
            return seed[key]
        match = get_close_matches(key, keys, n=1, cutoff=0.72)
        if match:
            return seed[match[0]]
    return None


def _ocr_moves_and_type(path: Path) -> tuple[list[dict], str | None, str, str]:
    from card_ocr import _crop_region, _open_image, _preprocess_for_ocr
    import pytesseract

    img = _open_image(path)
    moves_raw = pytesseract.image_to_string(
        _preprocess_for_ocr(_crop_region(img, MOVES_CROP)),
        config="--psm 6",
    )
    info_raw = pytesseract.image_to_string(
        _preprocess_for_ocr(_crop_region(img, INFO_CROP)),
        config="--psm 6",
    )
    combined = f"{info_raw}\n{moves_raw}"
    type_match = re.search(
        r"\b(FIRE|WATER|GRASS|ROCK|GHOST|ELECTRIC|LEGENDARY|BASIC)\s+Pok[eé]mon\b",
        combined,
        re.I,
    )
    card_type = TYPE_MAP.get(type_match.group(1).upper(), None) if type_match else None
    spells = _parse_spells_from_ocr(moves_raw)
    return spells, card_type, moves_raw.strip(), info_raw.strip()


def _parse_spells_from_ocr(text: str) -> list[dict]:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    spells: list[dict] = []
    pp_re = re.compile(r"PP\s*:?\s*(\d+)", re.I)

    for i, line in enumerate(lines):
        pp_m = pp_re.search(line)
        if not pp_m:
            continue
        pp = int(pp_m.group(1))
        prev = lines[i - 1] if i > 0 else line
        if pp_re.search(prev):
            continue

        attack = 0
        chunk = prev if pp_m.start() == 0 or line is not prev else prev[: pp_m.start()]

        dmg_m = re.search(r"(\d{1,3})\s*[x&*]?\s*$", chunk)
        if dmg_m:
            attack = int(dmg_m.group(1))
            name_part = chunk[: dmg_m.start()].strip(" :|([]")
        else:
            dmg_m2 = re.search(r"\s(\d{1,3})\s*$", chunk)
            if dmg_m2:
                attack = int(dmg_m2.group(1))
                name_part = chunk[: dmg_m2.start()].strip(" :|([]")
            else:
                name_part = chunk

        name_part = re.sub(r"^[^A-Za-z]+", "", name_part)
        name_part = re.sub(r"[^A-Za-z' ]+$", "", name_part).strip()
        tokens = re.findall(r"[A-Za-z][A-Za-z' ]*", name_part)
        if not tokens:
            continue
        name = max(tokens, key=len).strip()
        if len(name) < 2:
            continue

        spells.append(
            {
                "name": name.title() if name.islower() else name,
                "attack": attack,
                "is_defence": attack == 0,
                "max_count": pp,
            }
        )

    return spells[:4]


def _spell_key(spell: dict) -> str:
    return _normalize_key(spell.get("name", ""))


def _merge_spells(ocr_spells: list[dict], seed_spells: list[dict]) -> list[dict]:
    if not seed_spells:
        return ocr_spells[:4]
    if not ocr_spells:
        return seed_spells[:4]

    merged: list[dict] = []
    used = set()
    for seed in seed_spells[:4]:
        seed_key = _spell_key(seed)
        best = seed
        for ocr in ocr_spells:
            ocr_key = _spell_key(ocr)
            if ocr_key == seed_key or get_close_matches(ocr_key, [seed_key], n=1, cutoff=0.75):
                ocr_attack = ocr.get("attack", 0)
                attack = ocr_attack
                if ocr_attack == 0 and not seed.get("is_defence") and seed.get("attack", 0) > 0:
                    attack = seed["attack"]
                best = {
                    "name": seed["name"],
                    "attack": attack,
                    "is_defence": seed["is_defence"],
                    "max_count": seed["max_count"],
                }
                used.add(_spell_key(ocr))
                break
        merged.append(best)

    for ocr in ocr_spells:
        if _spell_key(ocr) in used:
            continue
        if len(merged) >= 4:
            break
        merged.append(ocr)
    return merged[:4]


def build_card_record(path: Path, seed: dict[str, dict], *, use_cache: bool = True) -> dict:
    ocr_basic = read_card_from_image(path, use_cache=use_cache)
    stem = path.stem

    try:
        ocr_spells, ocr_type, moves_raw, info_raw = _ocr_moves_and_type(path)
    except Exception:
        ocr_spells, ocr_type, moves_raw, info_raw = [], None, "", ""

    ocr_blob = "\n".join(
        part
        for part in (
            ocr_basic.get("ocr_raw", ""),
            ocr_basic.get("name", ""),
            info_raw,
            moves_raw,
        )
        if part
    )
    seed_entry = _find_seed(seed, ocr_basic.get("name", ""), stem)
    seed_match_via = None
    if seed_entry:
        seed_match_via = "name"
    elif not _is_non_pokemon_filename(stem):
        seed_entry = _find_seed(seed, stem)
        if seed_entry:
            seed_match_via = "stem"
    if not seed_entry:
        seed_entry = _find_seed_by_spell_text(ocr_blob, seed)
        if seed_entry:
            seed_match_via = "spells"
    if not seed_entry and ocr_type:
        seed_entry = _find_seed_by_type_hint(ocr_type, info_raw, seed)
        if seed_entry:
            seed_match_via = "type"

    if seed_entry:
        name = seed_entry["name"]
        hp = seed_entry["hp"]
        lvl = seed_entry["lvl"]
        url = seed_entry["url"]
        card_type = ocr_type or seed_entry["type"]
    else:
        name = ocr_basic.get("name") or stem.replace("-", " ").replace("_", " ").title()
        hp = ocr_basic.get("hp") or 50
        lvl = 1
        url = ""
        card_type = ocr_type or "Basic"

    spells = _merge_spells(ocr_spells, seed_entry["spells"] if seed_entry else [])
    slug = pokemon_slug(seed_entry["name"] if seed_entry else name)

    record = {
        "slug": slug,
        "image": path.name,
        "name": name,
        "hp": hp,
        "lvl": lvl,
        "url": url,
        "type": card_type,
        "spells": spells,
        "meta": {
            "name_source": ocr_basic.get("name_source", "filename"),
            "ocr_name_raw": ocr_basic.get("ocr_raw", ""),
            "ocr_moves_raw": moves_raw,
            "seed_match": seed_entry["name"] if seed_entry else None,
            "seed_match_via": seed_match_via,
            "mtime": int(path.stat().st_mtime),
            "source_file": path.name,
        },
    }
    if seed_entry and "shuffle" in seed_entry:
        record["shuffle"] = seed_entry["shuffle"]
    return record


def _is_publishable_card(card: dict) -> bool:
    """Skip scans we couldn't tie to a real Pokémon."""
    meta = card.get("meta") or {}
    if meta.get("seed_match"):
        return True
    stem = Path(meta.get("source_file", "")).stem
    if not _is_non_pokemon_filename(stem):
        return True
    if _looks_like_garbage_name(card.get("name", ""), stem):
        return False
    return len(card.get("spells") or []) >= 2


def _is_pool_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in POOL_IMAGE_EXTS and not path.name.startswith(".")


def _list_pool_images(pool_dir: Path) -> list[Path]:
    if not pool_dir.is_dir():
        return []
    files = [
        p for p in sorted(pool_dir.iterdir())
        if _is_pool_image(p)
    ]
    return files


def _pool_file_hashes(pool_dir: Path) -> dict[str, Path]:
    """Byte hashes for images already sitting in pool root."""
    hashes: dict[str, Path] = {}
    for path in _list_pool_images(pool_dir):
        hashes[_file_hash(path)] = path
    return hashes


def restore_unique_pool_files(pool_dir: Path | None = None) -> list[str]:
    """Move non-identical files from _duplicates back into pool root."""
    pool_dir = pool_dir or POOL_DIR
    dup_dir = pool_dir / DUPES_DIR_NAME
    if not dup_dir.is_dir():
        return []

    pool_hashes = _pool_file_hashes(pool_dir)
    restored: list[str] = []

    for path in sorted(dup_dir.iterdir()):
        if not _is_pool_image(path):
            continue
        digest = _file_hash(path)
        if digest in pool_hashes:
            continue

        target = pool_dir / path.name
        if target.exists():
            stem, ext = path.stem, path.suffix
            n = 2
            while (pool_dir / f"{stem}-{n}{ext}").exists():
                n += 1
            target = pool_dir / f"{stem}-{n}{ext}"

        shutil.move(str(path), str(target))
        pool_hashes[digest] = target
        restored.append(target.name)

    return restored


def _dedupe_identical_files(
    cards: list[dict],
    dup_dir: Path,
    *,
    known_hashes: dict[str, Path] | None = None,
) -> tuple[list[dict], list[dict]]:
    """Drop byte-identical copies; move extras to _duplicates (pool files only)."""
    seen_hash: dict[str, dict | Path] = dict(known_hashes or {})
    kept: list[dict] = []
    dupes: list[dict] = []

    for card in cards:
        path = Path(card["_path"])
        digest = card["_hash"]
        if digest in seen_hash:
            prior = seen_hash[digest]
            duplicate_of = prior["slug"] if isinstance(prior, dict) else prior.name
            if path.exists():
                moved = _safe_move_to_duplicates(path, dup_dir)
                dupes.append(
                    {
                        "reason": "identical_file",
                        "duplicate_of": duplicate_of,
                        "moved_to": moved.name,
                        "source": card["meta"].get("source_file"),
                    }
                )
            continue
        seen_hash[digest] = card
        kept.append(card)

    return kept, dupes


def _finalize_filename(path: Path, card_id: str, pool_dir: Path, dup_dir: Path) -> Path:
    """Rename to `{slug}.ext` when free; never displace a different card file."""
    ext = path.suffix.lower()
    target = pool_dir / f"{card_id}{ext}"

    if path.resolve() == target.resolve():
        return target

    if target.exists():
        if _file_hash(target) == _file_hash(path):
            _safe_move_to_duplicates(path, dup_dir)
            return target
        return path

    old_resolved = path.resolve()
    path.rename(target)
    _clear_ocr_cache_entry(old_resolved)
    return target


def _seed_catalog_ids(seed: dict[str, dict]) -> dict[str, str]:
    """Optional poke-NNN ids declared in pokecards.py (card_id='poke-001')."""
    mapping: dict[str, str] = {}
    for entry in seed.values():
        card_id = entry.get("card_id")
        if not card_id or not is_catalog_id(card_id):
            continue
        mapping[pokemon_slug(entry["name"])] = card_id
    return mapping


def _preserve_catalog_flags(cards: list[dict], poke_json_path: Path) -> list[dict]:
    """Keep manual poke.json flags (e.g. shuffle: false) across rebuilds."""
    prior: dict[str, dict] = {}
    for card in load_poke_json(poke_json_path).get("cards") or []:
        slug = card.get("slug") or pokemon_slug(card.get("name", ""))
        prior[slug] = card

    merged: list[dict] = []
    for card in cards:
        row = dict(card)
        prev = prior.get(row.get("slug", ""), {})
        if "shuffle" in prev and "shuffle" not in row:
            row["shuffle"] = prev["shuffle"]
        merged.append(row)
    return merged


def build_poke_json(
    pool_dir: Path | None = None,
    output_path: Path | None = None,
    *,
    seed_path: Path | None = None,
    redo: bool = False,
) -> dict:
    pool_dir = pool_dir or POOL_DIR
    output_path = output_path or POKE_JSON_PATH
    dup_dir = pool_dir / DUPES_DIR_NAME
    seed = parse_pokecards_seed(seed_path)

    if redo:
        _clear_ocr_cache()

    restored = restore_unique_pool_files(pool_dir)

    # Phase 1 — OCR every image in pool root (not _duplicates).
    scanned: list[dict] = []
    for path in _list_pool_images(pool_dir):
        card = build_card_record(path, seed, use_cache=not redo)
        card["_path"] = str(path.resolve())
        card["_hash"] = _file_hash(path)
        scanned.append(card)

    # Phase 2 — drop byte-identical files (compare pool files only).
    after_hash, hash_dupes = _dedupe_identical_files(scanned, dup_dir)

    # Drop unidentified junk scans.
    publishable: list[dict] = []
    rejected: list[dict] = []
    for card in after_hash:
        if _is_publishable_card(card):
            publishable.append(card)
        else:
            rejected.append(card)
            path = Path(card["_path"])
            if path.exists():
                _safe_move_to_duplicates(path, dup_dir)

    winners = publishable

    # Phase 3 — rename winners to canonical filenames (species slug).
    renames: list[dict] = []
    staged: list[dict] = []
    for card in sorted(winners, key=lambda c: c["slug"]):
        path = Path(card["_path"])
        if not path.exists():
            continue
        old_name = path.name
        new_path = _finalize_filename(path, card["slug"], pool_dir, dup_dir)
        card["image"] = new_path.name
        card["meta"]["mtime"] = int(new_path.stat().st_mtime)
        if old_name != new_path.name:
            card["meta"]["renamed_from"] = old_name
            renames.append({"from": old_name, "to": new_path.name, "slug": card["slug"]})
        staged.append({k: v for k, v in card.items() if not k.startswith("_")})

    final_cards = assign_catalog_ids(
        staged,
        poke_json_path=output_path,
        seed_ids=_seed_catalog_ids(seed),
    )
    final_cards = _preserve_catalog_flags(final_cards, output_path)

    payload = {
        "version": 1,
        "updated_at": int(time.time()),
        "cards": final_cards,
        "stats": {
            "scanned": len(scanned),
            "kept": len(final_cards),
            "rejected": len(rejected),
            "restored_from_duplicates": len(restored),
            "duplicates_file": len(hash_dupes),
        },
    }
    if restored:
        payload["restored"] = restored
    if renames:
        payload["renames"] = renames
    if hash_dupes:
        payload["duplicates"] = hash_dupes

    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return payload


def ingest_new_pool_images(
    pool_dir: Path | None = None,
    output_path: Path | None = None,
    *,
    seed_path: Path | None = None,
) -> dict:
    """
    OCR only new pool files with non-Pokémon filenames (timestamps, screenshots).
    Merges results into existing poke.json without re-scanning named species files.
    """
    pool_dir = pool_dir or POOL_DIR
    output_path = output_path or POKE_JSON_PATH
    dup_dir = pool_dir / DUPES_DIR_NAME
    seed = parse_pokecards_seed(seed_path)

    restore_unique_pool_files(pool_dir)

    existing_data = load_poke_json(output_path)
    existing_cards = list(existing_data.get("cards") or [])
    existing_images = {c.get("image") for c in existing_cards if c.get("image")}
    pool_hashes = _pool_file_hashes(pool_dir)

    candidates = [
        path
        for path in _list_pool_images(pool_dir)
        if path.name not in existing_images
    ]

    if not candidates:
        return {
            **existing_data,
            "updated_at": int(time.time()),
            "stats": {
                "ingested": 0,
                "candidates": 0,
                "total_cards": len(existing_cards),
            },
        }

    scanned: list[dict] = []
    for path in candidates:
        card = build_card_record(path, seed, use_cache=True)
        card["_path"] = str(path.resolve())
        card["_hash"] = _file_hash(path)
        scanned.append(card)

    after_hash, hash_dupes = _dedupe_identical_files(
        scanned,
        dup_dir,
        known_hashes=pool_hashes,
    )

    publishable: list[dict] = []
    rejected: list[dict] = []

    for card in after_hash:
        if not _is_publishable_card(card):
            rejected.append(card)
            path = Path(card["_path"])
            if path.exists():
                _safe_move_to_duplicates(path, dup_dir)
            continue
        publishable.append(card)

    renames: list[dict] = []
    staged_new: list[dict] = []
    for card in sorted(publishable, key=lambda c: c["slug"]):
        path = Path(card["_path"])
        if not path.exists():
            continue
        old_name = path.name
        new_path = _finalize_filename(path, card["slug"], pool_dir, dup_dir)
        card["image"] = new_path.name
        card["meta"]["mtime"] = int(new_path.stat().st_mtime)
        if old_name != new_path.name:
            card["meta"]["renamed_from"] = old_name
            renames.append({"from": old_name, "to": new_path.name, "slug": card["slug"]})
        staged_new.append({k: v for k, v in card.items() if not k.startswith("_")})

    merged = existing_cards + staged_new
    final_cards = assign_catalog_ids(
        merged,
        poke_json_path=output_path,
        seed_ids=_seed_catalog_ids(seed),
    )
    final_cards = _preserve_catalog_flags(final_cards, output_path)

    payload = {
        "version": 1,
        "updated_at": int(time.time()),
        "cards": final_cards,
        "stats": {
            "ingested": len(staged_new),
            "candidates": len(candidates),
            "scanned": len(scanned),
            "rejected": len(rejected),
            "duplicates_file": len(hash_dupes),
            "total_cards": len(final_cards),
        },
    }
    if renames:
        payload["renames"] = renames
    if hash_dupes:
        payload["duplicates"] = hash_dupes

    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return payload


def load_poke_json(path: Path | None = None) -> dict:
    path = path or POKE_JSON_PATH
    if not path.is_file():
        return {"version": 1, "cards": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"version": 1, "cards": []}


def poke_json_cards(path: Path | None = None) -> list[dict]:
    return load_poke_json(path).get("cards") or []


if __name__ == "__main__":
    import sys

    new_only = "--new-only" in sys.argv or "-n" in sys.argv
    if new_only:
        data = ingest_new_pool_images()
    else:
        data = build_poke_json(redo=True)
    stats = data.get("stats") or {}
    if new_only:
        print(
            f"Ingested {stats.get('ingested', 0)} new card(s) "
            f"from {stats.get('candidates', 0)} file(s) → {len(data.get('cards') or [])} total in {POKE_JSON_PATH}"
        )
    else:
        print(f"Scanned {stats.get('scanned', 0)} → kept {stats.get('kept', 0)} cards in {POKE_JSON_PATH}")
    if stats.get("restored_from_duplicates"):
        print(f"Restored {stats['restored_from_duplicates']} file(s) from {POOL_DIR / DUPES_DIR_NAME}/")
    print(
        f"Duplicates: {stats.get('duplicates_file', 0)} byte-identical files → {POOL_DIR / DUPES_DIR_NAME}/"
    )
    for card in data["cards"]:
        spells = len(card.get("spells") or [])
        print(f"  • {card['id']:10} {card['image']:22} {card['name']:14} {card['type']:10} HP{card['hp']}  ({spells} moves)")
    for entry in data.get("renames") or []:
        print(f"  renamed: {entry['from']} → {entry['to']}")
    if data.get("duplicates"):
        print(f"  ({len(data['duplicates'])} duplicate files moved to _duplicates/)")
