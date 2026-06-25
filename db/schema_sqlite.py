"""SQLite schema bootstrap (local dev)."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

from db.paths import webp_root

_WEBP = webp_root()
if str(_WEBP) not in sys.path:
    sys.path.insert(0, str(_WEBP))

from avatar_economy import DEFAULT_SKIN as AVATAR_DEFAULT_SKIN
from db.connection import table_columns
from leaderboard import backfill_stats_from_battles, ensure_stats_schema
from poketab_battle import ensure_schema as ensure_poketab_battle_schema
from poketab_social import ensure_schema as ensure_poketab_schema
from trainer_stats import ensure_trainer_stats_schema


def init_sqlite_schema(conn: Any) -> None:
    now = int(time.time())

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            telegram_id TEXT PRIMARY KEY,
            username TEXT,
            display_name TEXT NOT NULL,
            skin TEXT,
            badges TEXT NOT NULL DEFAULT '[]',
            quest_progress TEXT NOT NULL DEFAULT '{"completed_steps":[],"removed_quests":[]}',
            holds TEXT NOT NULL DEFAULT '[]',
            vault TEXT NOT NULL DEFAULT '[]',
            balance INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS battle_games (
            id TEXT PRIMARY KEY,
            player1_id INTEGER NOT NULL,
            player2_id INTEGER NOT NULL,
            bet INTEGER,
            winner INTEGER,
            creation_time REAL NOT NULL,
            state_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS exclusive_winners (
            telegram_id TEXT PRIMARY KEY,
            wins INTEGER NOT NULL DEFAULT 0,
            name TEXT,
            username TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_battle_games_p1 "
        "ON battle_games(player1_id, winner, creation_time)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_battle_games_p2 "
        "ON battle_games(player2_id, winner, creation_time)"
    )

    user_cols = table_columns(conn, "users")
    migrations = {
        "badges": "ALTER TABLE users ADD COLUMN badges TEXT NOT NULL DEFAULT '[]'",
        "quest_progress": (
            "ALTER TABLE users ADD COLUMN quest_progress TEXT NOT NULL DEFAULT "
            "'{\"completed_steps\":[],\"removed_quests\":[]}'"
        ),
        "holds": "ALTER TABLE users ADD COLUMN holds TEXT NOT NULL DEFAULT '[]'",
        "vault": "ALTER TABLE users ADD COLUMN vault TEXT NOT NULL DEFAULT '[]'",
        "balance": "ALTER TABLE users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0",
        "owned_skins": (
            f"ALTER TABLE users ADD COLUMN owned_skins TEXT NOT NULL DEFAULT "
            f"'[\"{AVATAR_DEFAULT_SKIN}\"]'"
        ),
        "pin": "ALTER TABLE users ADD COLUMN pin TEXT",
        "stats_wagered": "ALTER TABLE users ADD COLUMN stats_wagered INTEGER NOT NULL DEFAULT 0",
        "stats_battles": "ALTER TABLE users ADD COLUMN stats_battles INTEGER NOT NULL DEFAULT 0",
        "stats_wins": "ALTER TABLE users ADD COLUMN stats_wins INTEGER NOT NULL DEFAULT 0",
        "stats_losses": "ALTER TABLE users ADD COLUMN stats_losses INTEGER NOT NULL DEFAULT 0",
        "stats_xp": "ALTER TABLE users ADD COLUMN stats_xp INTEGER NOT NULL DEFAULT 0",
        "vending_spins": "ALTER TABLE users ADD COLUMN vending_spins INTEGER NOT NULL DEFAULT 0",
        "gear_slots": (
            "ALTER TABLE users ADD COLUMN gear_slots TEXT NOT NULL DEFAULT "
            "'[null,null,null]'"
        ),
    }
    for col, ddl in migrations.items():
        if col not in user_cols:
            conn.execute(ddl)

    reset_key = "skins_reset_v1"
    if conn.execute(
        "SELECT value FROM app_meta WHERE key = ?", (reset_key,)
    ).fetchone() is None:
        conn.execute("UPDATE users SET skin = NULL")
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?, ?)",
            (reset_key, "1"),
        )

    if conn.execute(
        "SELECT value FROM app_meta WHERE key = ?", ("schema_v1",)
    ).fetchone() is None:
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?, ?)",
            ("schema_v1", str(now)),
        )

    ensure_trainer_stats_schema(conn)
    ensure_stats_schema(conn)
    backfill_stats_from_battles(conn)
    from trainer_stats import backfill_xp_rewards

    backfill_xp_rewards(conn)

    vault_reset_key = "vault_reset_v1"
    if conn.execute(
        "SELECT value FROM app_meta WHERE key = ?", (vault_reset_key,)
    ).fetchone() is None:
        conn.execute("UPDATE users SET vault = '[]'")
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?, ?)",
            (vault_reset_key, "1"),
        )

    ensure_poketab_schema(conn)
    ensure_poketab_battle_schema(conn)
