"""Leaderboard queries and category definitions — shared by Flask API."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from poke_registry import parse_vault, valid_card_ids, vault_card_ids
from trainer_stats import (
    backfill_xp_from_wins,
    backfill_xp_rewards,
    ensure_trainer_stats_schema,
    save_leaderboard_snapshot,
    trainer_stats_row,
)

STAT_COLUMNS = (
    "stats_wagered",
    "stats_battles",
    "stats_wins",
    "stats_losses",
    "stats_xp",
)

LEADERBOARD_LIMIT = 10

CATEGORIES = (
    {
        "id": "whales",
        "title": "High Rollers",
        "emoji": "💰",
        "tagline": "Total CHIPS wagered — the whales move markets.",
        "fomo": "Every bet fuels the arena pot.",
        "value_label": "wagered",
        "sort_key": "stats_wagered",
    },
    {
        "id": "warriors",
        "title": "Battle Fiends",
        "emoji": "⚔️",
        "tagline": "Most PvP battles — the trainers everyone keeps running into.",
        "fomo": "Every fight writes your name in the ledger.",
        "value_label": "battles",
        "sort_key": "stats_battles",
    },
    {
        "id": "champions",
        "title": "Arena Kings",
        "emoji": "🏆",
        "tagline": "Most wins — crowns aren't given, they're taken.",
        "fomo": "Your name could be next.",
        "value_label": "wins",
        "sort_key": "stats_wins",
    },
    {
        "id": "levels",
        "title": "Battle Levels",
        "emoji": "⭐",
        "tagline": "Trainer level — quest milestones + battle wins. Earn XP every step.",
        "fomo": "Every victory earns XP.",
        "value_label": "level",
        "computed": "level",
    },
    {
        "id": "vault_lords",
        "title": "Vault Titans",
        "emoji": "🗃️",
        "tagline": "Largest PokéCard vaults — collectors run this realm.",
        "fomo": "Rare cards disappear fast.",
        "value_label": "cards",
        "computed": "vault_count",
    },
    {
        "id": "tycoons",
        "title": "Richest Now",
        "emoji": "💎",
        "tagline": "Current balance — liquid power.",
        "fomo": "Stack CHIPS before the next drop.",
        "value_label": "balance",
        "sort_key": "balance",
    },
    {
        "id": "untouchable",
        "title": "Untouchable",
        "emoji": "🔥",
        "tagline": "Win rate (min 3 battles) — efficiency is terror.",
        "fomo": "Can anyone dethrone them?",
        "value_label": "win_rate",
        "computed": "win_rate",
    },
)


def ensure_stats_schema(conn: sqlite3.Connection) -> None:
    ensure_trainer_stats_schema(conn)
    backfill_xp_from_wins(conn)
    backfill_xp_rewards(conn)


def _vault_count(raw_vault: str) -> int:
    vault = parse_vault(raw_vault or "[]", valid_card_ids())
    return len(vault_card_ids(vault))


def backfill_stats_from_battles(conn: sqlite3.Connection) -> None:
    if conn.execute(
        "SELECT 1 FROM app_meta WHERE key = ?", ("stats_backfill_v1",)
    ).fetchone():
        return

    ensure_stats_schema(conn)
    conn.execute(
        """
        UPDATE users SET
            stats_wagered = 0,
            stats_battles = 0,
            stats_wins = 0,
            stats_losses = 0,
            stats_xp = 0
        """
    )

    rows = conn.execute(
        """
        SELECT player1_id, player2_id, bet, winner
        FROM battle_games
        WHERE winner IS NOT NULL
        """
    ).fetchall()

    wager_deltas: dict[str, int] = {}
    battle_deltas: dict[str, int] = {}
    win_deltas: dict[str, int] = {}
    loss_deltas: dict[str, int] = {}

    for row in rows:
        p1 = str(row["player1_id"])
        p2 = str(row["player2_id"])
        bet = int(row["bet"] or 0)
        winner = str(row["winner"]) if row["winner"] is not None else None

        for pid in (p1, p2):
            battle_deltas[pid] = battle_deltas.get(pid, 0) + 1
            if bet > 0:
                wager_deltas[pid] = wager_deltas.get(pid, 0) + bet

        if winner in (p1, p2):
            loser = p2 if winner == p1 else p1
            win_deltas[winner] = win_deltas.get(winner, 0) + 1
            loss_deltas[loser] = loss_deltas.get(loser, 0) + 1

    all_ids = set(wager_deltas) | set(battle_deltas) | set(win_deltas) | set(loss_deltas)
    for pid in all_ids:
        conn.execute(
            """
            UPDATE users SET
                stats_wagered = ?,
                stats_battles = ?,
                stats_wins = ?,
                stats_losses = ?,
                stats_xp = ?
            WHERE telegram_id = ?
            """,
            (
                wager_deltas.get(pid, 0),
                battle_deltas.get(pid, 0),
                win_deltas.get(pid, 0),
                loss_deltas.get(pid, 0),
                win_deltas.get(pid, 0),
                pid,
            ),
        )

    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?, ?)",
        ("stats_backfill_v1", "1"),
    )


def _format_entry(row: sqlite3.Row, rank: int, value: int | float, value_display: str) -> dict:
    stats = trainer_stats_row(row)
    return {
        "rank": rank,
        "telegram_id": row["telegram_id"],
        "display_name": row["display_name"],
        "username": row["username"] or "",
        "skin": row["skin"],
        "value": value,
        "value_display": value_display,
        "level": stats["level"],
        "level_title": stats["level_title"],
        "stats_xp": stats["stats_xp"],
        "stats_wins": int(row["stats_wins"] or 0),
        "stats_battles": int(row["stats_battles"] or 0),
    }


def _fetch_sorted_users(conn: sqlite3.Connection, order_sql: str, limit: int) -> list[sqlite3.Row]:
    return conn.execute(
        f"""
        SELECT telegram_id, display_name, username, skin, vault,
               balance, stats_wagered, stats_battles, stats_wins, stats_losses,
               stats_xp, quest_progress
        FROM users
        ORDER BY {order_sql}
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def _global_pulse(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT
            COUNT(*) AS trainers,
            COALESCE(SUM(stats_wagered), 0) AS tokens_wagered,
            COALESCE(SUM(stats_battles), 0) AS battles_fought,
            COALESCE(SUM(stats_wins), 0) AS total_wins,
            COALESCE(SUM(balance), 0) AS tokens_circulating
        FROM users
        """
    ).fetchone()

    vault_rows = conn.execute("SELECT vault FROM users").fetchall()
    cards_in_vaults = sum(_vault_count(r["vault"]) for r in vault_rows)

    return {
        "trainers": int(row["trainers"] or 0),
        "tokens_wagered": int(row["tokens_wagered"] or 0),
        "battles_fought": int(row["battles_fought"] or 0),
        "total_wins": int(row["total_wins"] or 0),
        "tokens_circulating": int(row["tokens_circulating"] or 0),
        "cards_in_vaults": cards_in_vaults,
    }


def _entries_for_category(conn: sqlite3.Connection, cat: dict) -> list[dict]:
    computed = cat.get("computed")
    entries: list[dict] = []

    if computed == "vault_count":
        rows = conn.execute(
            """
            SELECT telegram_id, display_name, username, skin, vault,
                   balance, stats_wagered, stats_battles, stats_wins, stats_losses,
                   stats_xp, quest_progress
            FROM users
            """
        ).fetchall()
        ranked = sorted(
            [(r, _vault_count(r["vault"])) for r in rows],
            key=lambda item: item[1],
            reverse=True,
        )
        for rank, (row, count) in enumerate(ranked[:LEADERBOARD_LIMIT], start=1):
            if count <= 0:
                continue
            entries.append(_format_entry(row, rank, count, f"{count} card{'s' if count != 1 else ''}"))
        return entries

    if computed == "level":
        rows = conn.execute(
            """
            SELECT telegram_id, display_name, username, skin, vault,
                   balance, stats_wagered, stats_battles, stats_wins, stats_losses,
                   stats_xp, quest_progress
            FROM users
            WHERE stats_xp > 0 OR stats_wins > 0
            """
        ).fetchall()
        ranked = sorted(
            rows,
            key=lambda r: (
                trainer_stats_row(r)["level"],
                int(r["stats_xp"] or 0),
                int(r["stats_wins"] or 0),
            ),
            reverse=True,
        )
        for rank, row in enumerate(ranked[:LEADERBOARD_LIMIT], start=1):
            stats = trainer_stats_row(row)
            lvl = stats["level"]
            xp = stats["stats_xp"]
            entries.append(_format_entry(row, rank, lvl, f"Lv.{lvl} · {xp} XP"))
        return entries

    if computed == "win_rate":
        rows = conn.execute(
            """
            SELECT telegram_id, display_name, username, skin, vault,
                   balance, stats_wagered, stats_battles, stats_wins, stats_losses,
                   stats_xp, quest_progress
            FROM users
            WHERE stats_battles >= 3
            """
        ).fetchall()
        ranked = sorted(
            rows,
            key=lambda r: (r["stats_wins"] / r["stats_battles"], r["stats_wins"]),
            reverse=True,
        )
        for rank, row in enumerate(ranked[:LEADERBOARD_LIMIT], start=1):
            rate = round(100 * row["stats_wins"] / row["stats_battles"])
            entries.append(_format_entry(row, rank, rate, f"{rate}% ({row['stats_wins']}/{row['stats_battles']})"))
        return entries

    sort_key = cat["sort_key"]
    rows = _fetch_sorted_users(conn, f"{sort_key} DESC, display_name ASC", LEADERBOARD_LIMIT)
    for rank, row in enumerate(rows, start=1):
        value = int(row[sort_key] or 0)
        if value <= 0:
            continue
        if sort_key == "balance":
            display = f"{value:,} CHIPS"
        elif sort_key == "stats_wagered":
            display = f"{value:,} wagered"
        else:
            display = str(value)
        entries.append(_format_entry(row, rank, value, display))
    return entries


def _rank_for_user(conn: sqlite3.Connection, telegram_id: str, cat: dict) -> Optional[int]:
    entries = _entries_for_category(conn, cat)
    for entry in entries:
        if entry["telegram_id"] == telegram_id:
            return entry["rank"]
    return None


def build_leaderboard_payload(
    conn: sqlite3.Connection,
    viewer_id: Optional[str] = None,
) -> dict[str, Any]:
    ensure_stats_schema(conn)
    backfill_stats_from_battles(conn)

    global_pulse = _global_pulse(conn)
    categories_out = []
    your_ranks: dict[str, Optional[int]] = {}

    for cat in CATEGORIES:
        entries = _entries_for_category(conn, cat)
        categories_out.append(
            {
                "id": cat["id"],
                "title": cat["title"],
                "emoji": cat["emoji"],
                "tagline": cat["tagline"],
                "fomo": cat["fomo"],
                "entries": [
                    {**e, "is_you": viewer_id is not None and e["telegram_id"] == viewer_id}
                    for e in entries
                ],
            }
        )
        if viewer_id:
            your_ranks[cat["id"]] = _rank_for_user(conn, viewer_id, cat)

    viewer_stats = None
    if viewer_id:
        row = conn.execute(
            """
            SELECT telegram_id, display_name, username, skin, vault, balance,
                   stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp
            FROM users WHERE telegram_id = ?
            """,
            (viewer_id,),
        ).fetchone()
        if row:
            base = trainer_stats_row(row)
            viewer_stats = {
                "display_name": row["display_name"],
                "vault_count": _vault_count(row["vault"]),
                "balance": int(row["balance"] or 0),
                **base,
            }

    payload = {
        "success": True,
        "global": global_pulse,
        "categories": categories_out,
        "your_ranks": your_ranks,
        "your_stats": viewer_stats,
    }
    if viewer_id:
        save_leaderboard_snapshot(conn, viewer_id, payload)
    return payload
