"""Gunicorn entry point (Railway / production)."""
import sys
from pathlib import Path

_WEBP_ROOT = Path(__file__).resolve().parent
if str(_WEBP_ROOT) not in sys.path:
    sys.path.insert(0, str(_WEBP_ROOT))

from app import app  # noqa: F401  # init_db() runs on import

try:
    from gear_catalog import ensure_gear_item_files

    ensure_gear_item_files()
except Exception as exc:
    import logging

    logging.getLogger("wsgi").warning("ensure_gear_item_files skipped: %s", exc)
