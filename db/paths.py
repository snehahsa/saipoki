"""Resolve webp vs monorepo layout (local saipoke/ vs Railway webp-only repo)."""

from __future__ import annotations

from pathlib import Path


def webp_root() -> Path:
  db_pkg = Path(__file__).resolve().parent
  parent = db_pkg.parent
  if (parent / "app.py").is_file():
    return parent
  if (parent / "webp" / "app.py").is_file():
    return parent / "webp"
  return parent


def monorepo_root() -> Path:
  root = webp_root()
  if root.name == "webp":
    return root.parent
  return root
