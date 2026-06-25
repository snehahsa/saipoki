"""PostgreSQL schema bootstrap (Railway)."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

from db.paths import webp_root

_WEBP = webp_root()
if str(_WEBP) not in sys.path:
    sys.path.insert(0, str(_WEBP))


def init_postgres_schema(conn: Any) -> None:
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
            owned_skins TEXT NOT NULL DEFAULT '["009"]',
            pin TEXT,
            stats_wagered INTEGER NOT NULL DEFAULT 0,
            stats_battles INTEGER NOT NULL DEFAULT 0,
            stats_wins INTEGER NOT NULL DEFAULT 0,
            stats_losses INTEGER NOT NULL DEFAULT 0,
            stats_xp INTEGER NOT NULL DEFAULT 0,
            vending_spins INTEGER NOT NULL DEFAULT 0,
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
            creation_time DOUBLE PRECISION NOT NULL,
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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS poketab_battle_invites (
            id SERIAL PRIMARY KEY,
            challenger_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            bet INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            challenger_team TEXT,
            target_team TEXT,
            game_id TEXT,
            created_at INTEGER NOT NULL,
            responded_at INTEGER,
            expires_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_poketab_battle_target
        ON poketab_battle_invites(target_id, status)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_poketab_battle_challenger
        ON poketab_battle_invites(challenger_id, status)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_requests (
            id SERIAL PRIMARY KEY,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            responded_at INTEGER,
            UNIQUE(from_id, to_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friendships (
            user_low TEXT NOT NULL,
            user_high TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (user_low, user_high)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS poketab_messages (
            id SERIAL PRIMARY KEY,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            read_at INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_poketab_messages_pair
        ON poketab_messages(from_id, to_id, created_at)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_friend_requests_to
        ON friend_requests(to_id, status)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS poketab_user_state (
            user_id TEXT PRIMARY KEY,
            friends_seen_at INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS battle_outcome_log (
            id SERIAL PRIMARY KEY,
            game_id TEXT,
            winner_id TEXT NOT NULL,
            loser_id TEXT NOT NULL,
            bet INTEGER,
            source TEXT NOT NULL DEFAULT 'unknown',
            created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_battle_outcome_log_winner
        ON battle_outcome_log(winner_id, created_at DESC)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
            id SERIAL PRIMARY KEY,
            telegram_id TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_user
        ON leaderboard_snapshots(telegram_id, created_at DESC)
        """
    )

    if conn.execute(
        "SELECT value FROM app_meta WHERE key = ?", ("schema_v1",)
    ).fetchone() is None:
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?, ?)",
            ("schema_v1", str(now)),
        )

    # Run backfills / idempotent data migrations (safe on empty DB)
    from leaderboard import backfill_stats_from_battles, ensure_stats_schema
    from poketab_battle import ensure_schema as ensure_poketab_battle_schema
    from poketab_social import ensure_schema as ensure_poketab_schema
    from trainer_stats import ensure_trainer_stats_schema

    ensure_trainer_stats_schema(conn)
    ensure_stats_schema(conn)
    backfill_stats_from_battles(conn)
    from trainer_stats import backfill_xp_rewards

    backfill_xp_rewards(conn)
    ensure_poketab_schema(conn)
    ensure_poketab_battle_schema(conn)

    from kins_payments import ensure_kins_payments_schema

    ensure_kins_payments_schema(conn)
