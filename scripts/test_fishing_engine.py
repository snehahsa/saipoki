#!/usr/bin/env python3
"""Smoke test for server-side fishing quest trials."""

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db.schema_sqlite import init_sqlite_schema
from fishing_engine import complete_fishing_cast, start_fishing_cast


def main() -> None:
    db = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    db.close()
    conn = sqlite3.connect(db.name)
    conn.row_factory = sqlite3.Row
    init_sqlite_schema(conn)
    conn.execute(
        """
        INSERT INTO users (
            telegram_id, display_name, holds, gear_slots, quest_progress,
            balance, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 5000, 1, 1)
        """,
        (
            "test1",
            "T",
            '["bag"]',
            json.dumps(["fishing_rod", None, None]),
            json.dumps({"completed_steps": [], "removed_quests": [], "fishing": {}}),
        ),
    )
    conn.commit()

    started = start_fishing_cast(
        conn, "test1", quest_key="pokehub_key", mode="fish", gear_id="fishing_rod"
    )
    assert started["ok"], started
    _expire_session(conn, "test1", started["session_id"])
    done = complete_fishing_cast(conn, "test1", session_id=started["session_id"])
    assert not done.get("caught"), done
    print("wrong mode: ok")

    for attempt in range(5):
        started = start_fishing_cast(
            conn, "test1", quest_key="pokehub_key", mode="salvage", gear_id="fishing_rod"
        )
        if not started.get("ok"):
            break
        _expire_session(conn, "test1", started["session_id"])
        done = complete_fishing_cast(conn, "test1", session_id=started["session_id"])
        if done.get("caught"):
            print(f"caught on salvage attempt {attempt + 1}")
            break
    else:
        raise SystemExit("never caught")

    slots = json.loads(
        conn.execute(
            "SELECT gear_slots FROM users WHERE telegram_id=?", ("test1",)
        ).fetchone()["gear_slots"]
    )
    assert slots[2] == "hub_key", slots
    conn.close()
    os.unlink(db.name)
    print("all fishing tests passed")


def _expire_session(conn: sqlite3.Connection, telegram_id: str, session_id: str) -> None:
    row = conn.execute(
        "SELECT quest_progress FROM users WHERE telegram_id=?", (telegram_id,)
    ).fetchone()
    prog = json.loads(row["quest_progress"])
    for bucket in prog.get("fishing", {}).values():
        session = bucket.get("session")
        if session and session.get("id") == session_id:
            session["ends_at"] = 1
    conn.execute(
        "UPDATE users SET quest_progress=? WHERE telegram_id=?",
        (json.dumps(prog), telegram_id),
    )
    conn.commit()


if __name__ == "__main__":
    main()
