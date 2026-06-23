"""Gunicorn entry point (Railway / production)."""
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from app import app  # noqa: F401  # init_db() runs on import
