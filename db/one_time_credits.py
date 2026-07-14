"""Idempotent one-time balance credits applied during schema bootstrap."""

from __future__ import annotations

import time
from typing import Any


def apply_one_time_credits(conn: Any) -> None:
    """Credit named trainers once. Safe to re-run; keyed in app_meta after success."""
    credits = (
        # (meta_key, display_name, delta_chips)
        ("credit_samorage_plus_33000_v1", "samorage", 33000),
    )
    now = int(time.time())
    for meta_key, display_name, delta in credits:
        existing = conn.execute(
            "SELECT value FROM app_meta WHERE key = ?",
            (meta_key,),
        ).fetchone()
        if existing is not None:
            continue

        row = conn.execute(
            """
            SELECT telegram_id, balance FROM users
            WHERE lower(trim(display_name)) = lower(trim(?))
            LIMIT 1
            """,
            (display_name,),
        ).fetchone()
        if row is None:
            # Trainer not in DB yet — try again on next boot/deploy.
            continue

        conn.execute(
            """
            UPDATE users
            SET balance = balance + ?, updated_at = ?
            WHERE lower(trim(display_name)) = lower(trim(?))
            """,
            (int(delta), now, display_name),
        )
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?, ?)",
            (
                meta_key,
                f"telegram_id={row['telegram_id']};delta={delta};at={now}",
            ),
        )
