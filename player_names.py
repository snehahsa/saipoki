"""Username uniqueness helpers and one-time duplicate cleanup."""

from __future__ import annotations

import time
from typing import Any, Optional


def _name_key(raw: Any) -> str:
    return " ".join(str(raw or "").strip().split()).lower()


def dedupe_duplicate_display_names(conn: Any) -> int:
    """Keep one row per case-insensitive username; clear the rest.

    Preference order: has skin, higher balance, newer updated_at.
    Returns number of rows cleared.
    """
    rows = conn.execute(
        """
        SELECT telegram_id, display_name, updated_at, balance, skin
        FROM users
        WHERE display_name IS NOT NULL
          AND TRIM(display_name) != ''
        """
    ).fetchall()

    groups: dict[str, list] = {}
    for row in rows:
        key = _name_key(row["display_name"])
        if not key:
            continue
        groups.setdefault(key, []).append(row)

    cleared = 0
    now = int(time.time())
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(
            key=lambda r: (
                1 if (r["skin"] if "skin" in r.keys() else None) else 0,
                int(r["balance"] or 0) if "balance" in r.keys() else 0,
                int(r["updated_at"] or 0) if "updated_at" in r.keys() else 0,
            ),
            reverse=True,
        )
        for loser in members[1:]:
            conn.execute(
                """
                UPDATE users
                SET display_name = '', updated_at = ?
                WHERE telegram_id = ?
                """,
                (now, loser["telegram_id"]),
            )
            cleared += 1
    return cleared


def ensure_display_name_unique_index(conn: Any) -> None:
    """Partial unique index on non-empty display names (case-insensitive)."""
    dedupe_duplicate_display_names(conn)
    try:
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_name_ci
            ON users (LOWER(TRIM(display_name)))
            WHERE TRIM(COALESCE(display_name, '')) != ''
            """
        )
    except Exception:
        # If an engine rejects the expression index, uniqueness still enforced in app.
        pass
