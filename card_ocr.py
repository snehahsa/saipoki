"""Read Pokécard names from pool images using OCR (optional tesseract)."""

from __future__ import annotations

import json
import re
import shutil
from difflib import get_close_matches
from pathlib import Path

OCR_CACHE_PATH = Path(__file__).resolve().parent / "data" / "pool_ocr_cache.json"

POOL_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

NAME_CROP = {"top": 0.05, "bottom": 0.15, "left": 0.16, "right": 0.84}
HP_CROP = {"top": 0.05, "bottom": 0.14, "left": 0.68, "right": 0.96}
UPSCALE = 3


def _load_cache() -> dict:
    if not OCR_CACHE_PATH.exists():
        return {}
    try:
        return json.loads(OCR_CACHE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_cache(cache: dict) -> None:
    OCR_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    OCR_CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8")


def _tesseract_available() -> bool:
    if shutil.which("tesseract"):
        return True
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def _open_image(path: Path):
    from PIL import Image

    img = Image.open(path).convert("RGB")
    if UPSCALE > 1:
        w, h = img.size
        img = img.resize((w * UPSCALE, h * UPSCALE), Image.Resampling.NEAREST)
    return img


def _crop_region(img, region: dict):
    w, h = img.size
    box = (
        int(w * region["left"]),
        int(h * region["top"]),
        int(w * region["right"]),
        int(h * region["bottom"]),
    )
    return img.crop(box)


def _preprocess_for_ocr(img, *, dark_on_light=False):
    from PIL import ImageEnhance, ImageFilter, ImageOps

    gray = ImageOps.grayscale(img)
    gray = ImageEnhance.Contrast(gray).enhance(2.6 if not dark_on_light else 2.0)
    gray = ImageEnhance.Sharpness(gray).enhance(1.8)
    if dark_on_light:
        # Dark pixel text on silver/white banner (e.g. Crabby).
        bw = gray.point(lambda p: 255 if p < 150 else 0)
    else:
        bw = gray.point(lambda p: 255 if p > 140 else 0)
    return bw.filter(ImageFilter.MedianFilter(size=3))


def _banner_is_light(img) -> bool:
    from PIL import ImageOps, ImageStat

    crop = _crop_region(img, NAME_CROP)
    return ImageStat.Stat(ImageOps.grayscale(crop)).mean[0] > 128


def _ocr_name_banner(img) -> str:
    crop = _crop_region(img, NAME_CROP)
    light_banner = _banner_is_light(img)
    passes = [
        _preprocess_for_ocr(crop, dark_on_light=light_banner),
        _preprocess_for_ocr(crop, dark_on_light=not light_banner),
    ]
    best = ""
    for processed in passes:
        raw = _run_tesseract(processed)
        if len(raw.strip()) > len(best.strip()):
            best = raw
    return best.strip()


def _run_tesseract(img) -> str:
    import pytesseract

    return pytesseract.image_to_string(img, config="--psm 7").strip()


def _filename_name(path: Path) -> str:
    return path.stem.replace("-", " ").replace("_", " ").title()


def _normalize_stem(path: Path) -> str:
    return re.sub(r"[^a-z0-9]", "", path.stem.lower())


def _name_tokens(raw: str) -> list[str]:
    return re.findall(r"[A-Za-z]{3,}", raw)


def _resolve_name(raw: str, path: Path) -> tuple[str, str]:
    """Pick best display name from OCR text, using filename as a fuzzy anchor."""
    fallback = _filename_name(path)
    stem = _normalize_stem(path)
    raw_lower = raw.lower()

    if stem and stem in re.sub(r"[^a-z0-9]", "", raw_lower):
        return fallback, "ocr"

    tokens = _name_tokens(raw)
    if not tokens:
        return fallback, "filename"

    token_keys = [re.sub(r"[^a-z0-9]", "", t.lower()) for t in tokens]
    if stem and get_close_matches(stem, token_keys, n=1, cutoff=0.72):
        return fallback, "ocr"

    noise = {"basic", "stage", "hp", "ue", "sl", "bl", "ve", "fire", "water", "pokemon", "ene"}
    filtered = [t for t in tokens if t.lower() not in noise and len(t) >= 5]
    if filtered:
        best_key = re.sub(r"[^a-z0-9]", "", filtered[0].lower())
        if stem and get_close_matches(stem, [best_key], n=1, cutoff=0.62):
            return filtered[0].title(), "ocr"

    return fallback, "filename"


def _extract_hp(img) -> int | None:
    try:
        hp_crop = _crop_region(img, HP_CROP)
        processed = _preprocess_for_ocr(hp_crop)
        raw = _run_tesseract(processed)
        match = re.search(r"(\d{2,3})", raw)
        if match:
            value = int(match.group(1))
            if 10 <= value <= 999:
                return value
    except Exception:
        pass
    return None


def read_card_from_image(path: Path, *, use_cache: bool = True) -> dict:
    """
    Open a pool card image and OCR-read the name from the top banner.
    Returns { name, name_source, ocr_raw, hp } — falls back to filename if OCR unavailable.
    """
    path = path.resolve()
    fallback = _filename_name(path)
    cache_key = str(path)
    mtime = int(path.stat().st_mtime) if path.exists() else 0

    cache = _load_cache() if use_cache else {}
    cached = cache.get(cache_key)
    if cached and cached.get("mtime") == mtime:
        return cached

    result = {
        "name": fallback,
        "name_source": "filename",
        "ocr_raw": "",
        "hp": None,
        "mtime": mtime,
    }

    if not path.is_file() or not _tesseract_available():
        if use_cache:
            cache[cache_key] = result
            _save_cache(cache)
        return result

    try:
        img = _open_image(path)
        raw_name = _ocr_name_banner(img)
        result["ocr_raw"] = raw_name
        if raw_name:
            name, source = _resolve_name(raw_name, path)
            result["name"] = name
            result["name_source"] = source
            hp_inline = re.search(r"\b(\d{2,3})\b", raw_name)
            if hp_inline:
                value = int(hp_inline.group(1))
                if 10 <= value <= 999:
                    result["hp"] = value

        if result["hp"] is None:
            hp = _extract_hp(img)
            if hp is not None:
                result["hp"] = hp
    except Exception:
        pass

    if use_cache:
        cache[cache_key] = result
        _save_cache(cache)
    return result
