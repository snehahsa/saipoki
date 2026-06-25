"""PokéTab wager battles — invites, team select, shared TG battle engine."""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_REPO = Path(__file__).resolve().parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from bot.data import const
from bot.data.catalog import card_display_name, resolve_card_id
from bot.db import methods as bot_db
from bot.db import quests as quest_db
from bot.db import stats as stats_db
from bot.db.methods import _get_game_by_id_sync
from bot.models.game import Game
from bot.models.player import Player, get_pokemons_pool_from_vault, get_special_card
from bot.utils.config_reader import config

from poke_registry import parse_vault, vault_card_ids
from trainer_stats import record_battle_outcome_on_conn

log = logging.getLogger(__name__)

MAX_TEAM_SIZE = 1
BATTLE_ROULETTE_POOL_SIZE = 3
INVITE_TTL_SEC = 300
MIN_BET = 1
MAX_DAILY_BATTLES_PER_CARD = 3


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS poketab_battle_invites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        CREATE TABLE IF NOT EXISTS poketab_card_daily_usage (
            telegram_id TEXT NOT NULL,
            card_id TEXT NOT NULL,
            usage_date TEXT NOT NULL,
            battle_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (telegram_id, card_id, usage_date)
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
        "CREATE INDEX IF NOT EXISTS idx_battle_games_p1 "
        "ON battle_games(player1_id, winner, creation_time)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_battle_games_p2 "
        "ON battle_games(player2_id, winner, creation_time)"
    )


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "")


def _run_async(coro):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def notify_battle_quests(player_ids: list[int]) -> None:
    """Fire quest hooks after the battle transaction commits (avoids nested DB locks)."""
    if not player_ids:
        return
    try:
        _run_async(quest_db.on_telegram_battle_finished(player_ids))
    except Exception:
        log.exception("battle quest notify failed")


def _user_balance(conn: sqlite3.Connection, user_id: str) -> int:
    row = conn.execute(
        "SELECT balance FROM users WHERE telegram_id = ?", (user_id,)
    ).fetchone()
    if not row:
        return 0
    return int(row["balance"] or 0)


def _user_vault_ids(conn: sqlite3.Connection, user_id: str, valid_ids: set[str]) -> list[str]:
    row = conn.execute(
        "SELECT vault FROM users WHERE telegram_id = ?", (user_id,)
    ).fetchone()
    raw = row["vault"] if row and "vault" in row.keys() else None
    vault = parse_vault(raw, valid_ids)
    return vault_card_ids(vault)


def _usage_date_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def card_battles_today(conn: sqlite3.Connection, user_id: str, card_id: str) -> int:
    row = conn.execute(
        """
        SELECT battle_count FROM poketab_card_daily_usage
        WHERE telegram_id = ? AND card_id = ? AND usage_date = ?
        """,
        (str(user_id), str(card_id), _usage_date_utc()),
    ).fetchone()
    return int(row["battle_count"] or 0) if row else 0


def eligible_battle_cards(
    conn: sqlite3.Connection,
    user_id: str,
    valid_ids: set[str],
) -> list[str]:
    vault_ids = _user_vault_ids(conn, user_id, valid_ids)
    return [
        card_id
        for card_id in vault_ids
        if card_battles_today(conn, user_id, card_id) < MAX_DAILY_BATTLES_PER_CARD
    ]


def _pick_random_team(
    conn: sqlite3.Connection,
    user_id: str,
    valid_ids: set[str],
) -> Optional[list[str]]:
    """Pick exactly one battle card from up to 3 eligible vault cards (daily cap respected)."""
    eligible = eligible_battle_cards(conn, user_id, valid_ids)
    if not eligible:
        return None
    if len(eligible) > BATTLE_ROULETTE_POOL_SIZE:
        candidates = random.sample(eligible, BATTLE_ROULETTE_POOL_SIZE)
    else:
        candidates = list(eligible)
    return [random.choice(candidates)]


def _record_card_battle_usage(
    conn: sqlite3.Connection,
    user_id: str,
    card_id: str,
) -> None:
    today = _usage_date_utc()
    conn.execute(
        """
        INSERT INTO poketab_card_daily_usage (telegram_id, card_id, usage_date, battle_count)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(telegram_id, card_id, usage_date) DO UPDATE SET
            battle_count = battle_count + 1
        """,
        (str(user_id), str(card_id), today),
    )


def _user_display_name(conn: sqlite3.Connection, user_id: str) -> str:
    row = conn.execute(
        "SELECT display_name, username FROM users WHERE telegram_id = ?",
        (user_id,),
    ).fetchone()
    if not row:
        return f"Trainer_{user_id[-4:]}"
    name = (row["display_name"] or row["username"] or "Trainer").strip()
    return name[:24]


def _active_game_for_user(conn: sqlite3.Connection, user_id: str) -> Optional[dict]:
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        uid = user_id
    row = conn.execute(
        """
        SELECT * FROM battle_games
        WHERE winner IS NULL
          AND (player1_id = ? OR player2_id = ?)
        ORDER BY creation_time DESC
        LIMIT 1
        """,
        (uid, uid),
    ).fetchone()
    if not row:
        return None
    state = json.loads(row["state_json"])
    state["_id"] = row["id"]
    state["bet"] = row["bet"]
    state["winner"] = row["winner"]
    state["creation_time"] = row["creation_time"]
    return state


def _game_last_activity_ts(row: sqlite3.Row) -> float:
    try:
        state = json.loads(row["state_json"])
        p1 = state.get("player1") or {}
        p2 = state.get("player2") or {}
        return max(
            float(p1.get("last_move_time") or row["creation_time"]),
            float(p2.get("last_move_time") or row["creation_time"]),
            float(row["creation_time"]),
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return float(row["creation_time"])


def _settled_game_for_status(
    conn: sqlite3.Connection,
    user_id: str,
    *,
    max_age_seconds: int = 180,
) -> Optional[dict]:
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None
    row = conn.execute(
        """
        SELECT * FROM battle_games
        WHERE winner IS NOT NULL
          AND (player1_id = ? OR player2_id = ?)
        ORDER BY creation_time DESC
        LIMIT 1
        """,
        (uid, uid),
    ).fetchone()
    if not row:
        return None
    if (time.time() - _game_last_activity_ts(row)) > max_age_seconds:
        return None
    state = json.loads(row["state_json"])
    state["_id"] = row["id"]
    state["bet"] = row["bet"]
    state["winner"] = row["winner"]
    state["creation_time"] = row["creation_time"]
    return state


def _opponent_battle_view(
    game: Game,
    user_id: str,
    catalog: dict,
    log: list[str],
) -> dict[str, Any]:
    other_uid = str(
        game.player2.id if int(user_id) == game.player1.id else game.player1.id
    )
    return {
        "notify_uid": other_uid,
        "notify_battle": _serialize_game(game, other_uid, catalog, log),
    }


def forfeit_active_battle_for_offline(
    conn: sqlite3.Connection,
    user_id: str,
    catalog: dict,
) -> dict[str, Any]:
    active_doc = _active_game_for_user(conn, user_id)
    if not active_doc:
        return {"ok": True, "forfeited": False}
    game = Game.from_mongo(active_doc)
    if game.winner is not None:
        return {"ok": True, "forfeited": False}
    offline_int = int(user_id)
    winner, loser = game.game_over_coz_flee(offline_int)
    game.winner = winner.id
    log = [f"📴 {loser.name} left — {winner.name} wins!"]
    result = _settle_battle(conn, game, winner, loser, log, win_type="flee")
    return {
        "ok": True,
        "forfeited": True,
        "quest_player_ids": result.get("quest_player_ids") or [],
        **_opponent_battle_view(game, user_id, catalog, result["log"]),
    }


def _pending_invite_for_user(
    conn: sqlite3.Connection,
    user_id: str,
    exclude_invite_id: Optional[int] = None,
) -> Optional[sqlite3.Row]:
    now = int(time.time())
    params: list = [now, user_id, user_id]
    exclude_sql = ""
    if exclude_invite_id:
        exclude_sql = " AND id != ?"
        params.append(int(exclude_invite_id))
    return conn.execute(
        f"""
        SELECT * FROM poketab_battle_invites
        WHERE status IN ('pending', 'team_select')
          AND expires_at > ?
          AND (challenger_id = ? OR target_id = ?){exclude_sql}
        ORDER BY created_at DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def count_battle_alerts(conn: sqlite3.Connection, user_id: str) -> int:
    now = int(time.time())
    incoming = conn.execute(
        """
        SELECT COUNT(*) AS c FROM poketab_battle_invites
        WHERE target_id = ? AND status = 'pending' AND expires_at > ?
        """,
        (user_id, now),
    ).fetchone()["c"]
    return int(incoming)


def _expire_stale_invites(conn: sqlite3.Connection) -> None:
    now = int(time.time())
    conn.execute(
        """
        UPDATE poketab_battle_invites
        SET status = 'expired'
        WHERE status IN ('pending', 'team_select') AND expires_at <= ?
        """,
        (now,),
    )


def _invite_brief(row: sqlite3.Row, conn: sqlite3.Connection, viewer_id: str) -> dict:
    challenger_id = row["challenger_id"]
    target_id = row["target_id"]
    is_challenger = viewer_id == challenger_id
    opponent_id = target_id if is_challenger else challenger_id
    my_team = json.loads(row["challenger_team"] or "null") if is_challenger else json.loads(row["target_team"] or "null")
    opp_team = json.loads(row["target_team"] or "null") if is_challenger else json.loads(row["challenger_team"] or "null")
    return {
        "id": row["id"],
        "status": row["status"],
        "bet": int(row["bet"]),
        "game_id": row["game_id"],
        "is_challenger": is_challenger,
        "opponent": {
            "telegram_id": opponent_id,
            "display_name": _user_display_name(conn, opponent_id),
        },
        "my_team": my_team,
        "opponent_team_ready": opp_team is not None,
        "my_team_ready": my_team is not None,
        "created_at": row["created_at"],
        "expires_at": row["expires_at"],
    }


def list_outgoing_invites(conn: sqlite3.Connection, user_id: str) -> list[dict]:
    _expire_stale_invites(conn)
    now = int(time.time())
    rows = conn.execute(
        """
        SELECT * FROM poketab_battle_invites
        WHERE challenger_id = ? AND status = 'pending' AND expires_at > ?
        ORDER BY created_at DESC
        """,
        (user_id, now),
    ).fetchall()
    return [_invite_brief(row, conn, user_id) for row in rows]


def _pending_challenge_between(
    conn: sqlite3.Connection,
    challenger_id: str,
    target_id: str,
) -> Optional[sqlite3.Row]:
    now = int(time.time())
    return conn.execute(
        """
        SELECT * FROM poketab_battle_invites
        WHERE challenger_id = ? AND target_id = ?
          AND status = 'pending' AND expires_at > ?
        LIMIT 1
        """,
        (challenger_id, target_id, now),
    ).fetchone()


def _user_in_team_select(
    conn: sqlite3.Connection,
    user_id: str,
    exclude_invite_id: Optional[int] = None,
) -> bool:
    now = int(time.time())
    params: list = [now, user_id, user_id]
    exclude_sql = ""
    if exclude_invite_id:
        exclude_sql = " AND id != ?"
        params.append(int(exclude_invite_id))
    row = conn.execute(
        f"""
        SELECT 1 FROM poketab_battle_invites
        WHERE status = 'team_select' AND expires_at > ?
          AND (challenger_id = ? OR target_id = ?){exclude_sql}
        LIMIT 1
        """,
        params,
    ).fetchone()
    return row is not None


def _cancel_other_invites_for_battle(
    conn: sqlite3.Connection,
    player_ids: tuple[str, str],
    active_invite_id: int,
) -> None:
    """Drop other pending/team_select invites once a battle actually starts."""
    now = int(time.time())
    conn.execute(
        """
        UPDATE poketab_battle_invites
        SET status = 'cancelled'
        WHERE id != ? AND status IN ('pending', 'team_select')
          AND expires_at > ?
          AND (challenger_id IN (?, ?) OR target_id IN (?, ?))
        """,
        (active_invite_id, now, player_ids[0], player_ids[1], player_ids[0], player_ids[1]),
    )


def list_incoming_invites(conn: sqlite3.Connection, user_id: str) -> list[dict]:
    _expire_stale_invites(conn)
    now = int(time.time())
    rows = conn.execute(
        """
        SELECT * FROM poketab_battle_invites
        WHERE target_id = ? AND status = 'pending' AND expires_at > ?
        ORDER BY created_at DESC
        """,
        (user_id, now),
    ).fetchall()
    out = []
    for row in rows:
        brief = _invite_brief(row, conn, user_id)
        brief["challenger"] = {
            "telegram_id": row["challenger_id"],
            "display_name": _user_display_name(conn, row["challenger_id"]),
        }
        out.append(brief)
    return out


def battleable_opponents(
    conn: sqlite3.Connection,
    viewer_id: str,
    online_players: list[dict],
    valid_ids: set[str],
) -> list[dict]:
    _expire_stale_invites(conn)
    friend_rows = conn.execute(
        """
        SELECT user_low, user_high FROM friendships
        WHERE user_low = ? OR user_high = ?
        """,
        (viewer_id, viewer_id),
    ).fetchall()
    friend_ids = {
        row["user_high"] if row["user_low"] == viewer_id else row["user_low"]
        for row in friend_rows
    }
    out = []
    seen: set[str] = set()
    for player in online_players:
        uid = str(player.get("uid") or "")
        if not uid or uid == viewer_id or uid in seen:
            continue
        vault_ids = _user_vault_ids(conn, uid, valid_ids)
        if len(vault_ids) < config.min_vault_cards:
            continue
        eligible = eligible_battle_cards(conn, uid, valid_ids)
        if not eligible:
            continue
        seen.add(uid)
        opp_balance = _user_balance(conn, uid)
        name = (player.get("username") or _user_display_name(conn, uid))[:24]
        out.append(
            {
                "telegram_id": uid,
                "display_name": name,
                "skin": player.get("skin") or "009",
                "online": True,
                "vault_cards": len(vault_ids),
                "eligible_cards": len(eligible),
                "balance": opp_balance,
                "can_afford_min_bet": opp_balance >= MIN_BET,
                "is_friend": uid in friend_ids,
            }
        )
    out.sort(key=lambda item: (not item["is_friend"], item["display_name"].lower()))
    return out


def _pre_battle_check(
    conn: sqlite3.Connection,
    user_id: str,
    bet: int,
    valid_ids: set[str],
    exclude_invite_id: Optional[int] = None,
    *,
    allow_pending_invites: bool = False,
) -> Optional[str]:
    if _active_game_for_user(conn, user_id):
        return "You are already in a battle."
    if _user_in_team_select(conn, user_id, exclude_invite_id=exclude_invite_id):
        return "You are already setting up a battle."
    if not allow_pending_invites:
        pending = _pending_invite_for_user(conn, user_id, exclude_invite_id=exclude_invite_id)
        if pending:
            return "You already have an active battle invite."
    vault_ids = _user_vault_ids(conn, user_id, valid_ids)
    if len(vault_ids) < config.min_vault_cards:
        return f"You need at least {config.min_vault_cards} PokéCard(s) in your vault."
    eligible = eligible_battle_cards(conn, user_id, valid_ids)
    if not eligible:
        return (
            f"No battle-ready cards today — each card can fight "
            f"{MAX_DAILY_BATTLES_PER_CARD} times per day."
        )
    if bet < MIN_BET:
        return f"Minimum wager is {MIN_BET} $POKECARD."
    if _user_balance(conn, user_id) < bet:
        return "Insufficient balance for this wager."
    return None


def send_challenge(
    conn: sqlite3.Connection,
    challenger_id: str,
    target_id: str,
    bet: int,
    valid_ids: set[str],
) -> dict:
    _expire_stale_invites(conn)
    if challenger_id == target_id:
        return {"ok": False, "error": "You cannot battle yourself."}
    try:
        bet = int(bet)
    except (TypeError, ValueError):
        return {"ok": False, "error": "Invalid wager amount."}

    err = _pre_battle_check(
        conn, challenger_id, bet, valid_ids, allow_pending_invites=True
    )
    if err:
        return {"ok": False, "error": err}

    target_vault = _user_vault_ids(conn, target_id, valid_ids)
    if len(target_vault) < config.min_vault_cards:
        return {"ok": False, "error": "That trainer has no battle-ready cards."}
    if _user_balance(conn, target_id) < bet:
        return {"ok": False, "error": "Opponent cannot afford this wager."}
    if _active_game_for_user(conn, target_id):
        return {"ok": False, "error": "That trainer is already battling."}
    if _user_in_team_select(conn, target_id):
        return {"ok": False, "error": "That trainer is setting up a battle."}
    if _pending_challenge_between(conn, challenger_id, target_id):
        return {"ok": False, "error": "You already challenged this trainer."}

    now = int(time.time())
    cur = conn.execute(
        """
        INSERT INTO poketab_battle_invites (
            challenger_id, target_id, bet, status, created_at, expires_at
        ) VALUES (?, ?, ?, 'pending', ?, ?)
        """,
        (challenger_id, target_id, bet, now, now + INVITE_TTL_SEC),
    )
    invite_id = cur.lastrowid
    return {"ok": True, "invite_id": invite_id}


def respond_invite(
    conn: sqlite3.Connection,
    user_id: str,
    invite_id: int,
    accept: bool,
    valid_ids: set[str],
    catalog: Optional[dict] = None,
) -> dict:
    _expire_stale_invites(conn)
    row = conn.execute(
        "SELECT * FROM poketab_battle_invites WHERE id = ?", (invite_id,)
    ).fetchone()
    if not row:
        return {"ok": False, "error": "Invite not found."}
    if row["target_id"] != user_id:
        return {"ok": False, "error": "Not your invite."}
    if row["status"] != "pending":
        return {"ok": False, "error": "Invite is no longer pending."}
    if int(row["expires_at"]) <= int(time.time()):
        conn.execute(
            "UPDATE poketab_battle_invites SET status = 'expired' WHERE id = ?",
            (invite_id,),
        )
        return {"ok": False, "error": "Invite expired."}

    now = int(time.time())
    if not accept:
        conn.execute(
            """
            UPDATE poketab_battle_invites
            SET status = 'declined', responded_at = ?
            WHERE id = ?
            """,
            (now, invite_id),
        )
        return {"ok": True, "accepted": False}

    bet = int(row["bet"])
    err = _pre_battle_check(
        conn,
        user_id,
        bet,
        valid_ids,
        exclude_invite_id=invite_id,
        allow_pending_invites=True,
    )
    if err:
        return {"ok": False, "error": err}
    challenger_err = _pre_battle_check(
        conn,
        row["challenger_id"],
        bet,
        valid_ids,
        exclude_invite_id=invite_id,
        allow_pending_invites=True,
    )
    if challenger_err:
        return {"ok": False, "error": f"Challenger unavailable: {challenger_err}"}

    start = _assign_random_teams_and_start(
        conn,
        invite_id,
        valid_ids,
        catalog=catalog,
        viewer_id=user_id,
    )
    if not start.get("ok"):
        return start

    return {
        "ok": True,
        "accepted": True,
        "invite_id": invite_id,
        "started": True,
        "game_id": start.get("game_id"),
        "battle": start.get("battle"),
        "my_card": start.get("target_card") if user_id == row["target_id"] else start.get("challenger_card"),
        "opponent_card": start.get("challenger_card") if user_id == row["target_id"] else start.get("target_card"),
    }


def _assign_random_teams_and_start(
    conn: sqlite3.Connection,
    invite_id: int,
    valid_ids: set[str],
    *,
    catalog: Optional[dict] = None,
    viewer_id: Optional[str] = None,
) -> dict:
    row = conn.execute(
        "SELECT * FROM poketab_battle_invites WHERE id = ?", (invite_id,)
    ).fetchone()
    if not row:
        return {"ok": False, "error": "Invite not found."}
    if row["status"] not in ("pending", "team_select"):
        return {"ok": False, "error": "Invite is not ready to start."}

    p1 = str(row["challenger_id"])
    p2 = str(row["target_id"])
    team1 = _pick_random_team(conn, p1, valid_ids)
    if not team1:
        return {
            "ok": False,
            "error": (
                "Challenger has no cards left today "
                f"(max {MAX_DAILY_BATTLES_PER_CARD} battles per card per day)."
            ),
        }
    team2 = _pick_random_team(conn, p2, valid_ids)
    if not team2:
        return {
            "ok": False,
            "error": (
                "You have no cards left today "
                f"(max {MAX_DAILY_BATTLES_PER_CARD} battles per card per day)."
            ),
        }

    now = int(time.time())
    conn.execute(
        """
        UPDATE poketab_battle_invites
        SET status = 'team_select',
            responded_at = ?,
            expires_at = ?,
            challenger_team = ?,
            target_team = ?
        WHERE id = ?
        """,
        (now, now + INVITE_TTL_SEC, json.dumps(team1), json.dumps(team2), invite_id),
    )

    started = _try_start_battle(conn, invite_id, valid_ids)
    if not started:
        conn.execute(
            "UPDATE poketab_battle_invites SET status = 'cancelled' WHERE id = ?",
            (invite_id,),
        )
        return {"ok": False, "error": "Could not start battle."}

    invite_row = conn.execute(
        "SELECT game_id FROM poketab_battle_invites WHERE id = ?",
        (invite_id,),
    ).fetchone()
    game_id = invite_row["game_id"] if invite_row else None
    out: dict[str, Any] = {
        "ok": True,
        "started": True,
        "game_id": game_id,
        "challenger_card": team1[0],
        "target_card": team2[0],
    }
    if catalog and viewer_id and game_id:
        game = _load_game_from_conn(conn, game_id)
        if game:
            out["battle"] = _serialize_game(
                game,
                viewer_id,
                catalog,
                [
                    "A random PokéCard enters the arena!",
                    f"{_user_display_name(conn, p1)} vs {_user_display_name(conn, p2)}",
                ],
            )
    return out


def _resolve_stale_team_select(
    conn: sqlite3.Connection,
    invite_id: int,
    valid_ids: set[str],
) -> bool:
    """Finish legacy team_select invites by auto-picking random cards."""
    row = conn.execute(
        "SELECT * FROM poketab_battle_invites WHERE id = ?", (invite_id,)
    ).fetchone()
    if not row or row["status"] != "team_select":
        return False
    if row["game_id"]:
        return True

    p1 = str(row["challenger_id"])
    p2 = str(row["target_id"])
    team1 = (
        json.loads(row["challenger_team"])
        if row["challenger_team"]
        else _pick_random_team(conn, p1, valid_ids)
    )
    team2 = (
        json.loads(row["target_team"])
        if row["target_team"]
        else _pick_random_team(conn, p2, valid_ids)
    )
    if not team1 or not team2:
        conn.execute(
            "UPDATE poketab_battle_invites SET status = 'cancelled' WHERE id = ?",
            (invite_id,),
        )
        return False

    conn.execute(
        """
        UPDATE poketab_battle_invites
        SET challenger_team = ?, target_team = ?
        WHERE id = ?
        """,
        (json.dumps(team1), json.dumps(team2), invite_id),
    )
    return _try_start_battle(conn, invite_id, valid_ids)


def cancel_invite(conn: sqlite3.Connection, user_id: str, invite_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM poketab_battle_invites WHERE id = ?", (invite_id,)
    ).fetchone()
    if not row:
        return {"ok": False, "error": "Invite not found."}
    if row["challenger_id"] != user_id:
        return {"ok": False, "error": "Only the challenger can cancel."}
    if row["status"] not in ("pending", "team_select"):
        return {"ok": False, "error": "Cannot cancel this invite."}
    conn.execute(
        "UPDATE poketab_battle_invites SET status = 'cancelled' WHERE id = ?",
        (invite_id,),
    )
    return {"ok": True}


def set_team(
    conn: sqlite3.Connection,
    user_id: str,
    invite_id: int,
    card_ids: list[str],
    valid_ids: set[str],
    catalog: Optional[dict] = None,
) -> dict:
    """Legacy endpoint — battles now auto-pick a random eligible vault card."""
    _expire_stale_invites(conn)
    row = conn.execute(
        "SELECT * FROM poketab_battle_invites WHERE id = ?", (invite_id,)
    ).fetchone()
    if not row:
        return {"ok": False, "error": "Invite not found."}
    if user_id not in (row["challenger_id"], row["target_id"]):
        return {"ok": False, "error": "Not part of this battle."}

    if row["status"] == "pending":
        return _assign_random_teams_and_start(
            conn, invite_id, valid_ids, catalog=catalog, viewer_id=user_id
        )

    if row["status"] == "team_select":
        if _resolve_stale_team_select(conn, invite_id, valid_ids):
            invite_row = conn.execute(
                "SELECT game_id FROM poketab_battle_invites WHERE id = ?",
                (invite_id,),
            ).fetchone()
            game_id = invite_row["game_id"] if invite_row else None
            out: dict[str, Any] = {"ok": True, "started": True, "game_id": game_id}
            if catalog and game_id:
                game = _load_game_from_conn(conn, game_id)
                if game:
                    out["battle"] = _serialize_game(
                        game,
                        user_id,
                        catalog,
                        ["A random PokéCard enters the arena!"],
                    )
            return out
        return {"ok": False, "error": "Could not start battle."}

    return {"ok": False, "error": "Battle already started or invite closed."}


def _adjust_balance_on_conn(conn: sqlite3.Connection, user_id: str, delta: int) -> None:
    conn.execute(
        """
        UPDATE users SET balance = balance + ?, updated_at = ?
        WHERE telegram_id = ?
        """,
        (int(delta), int(time.time()), str(user_id)),
    )


def _inc_stat_on_conn(conn: sqlite3.Connection, user_id: str, column: str, delta: int) -> None:
    if column not in stats_db.STAT_COLUMNS:
        raise ValueError(f"Invalid stat column: {column}")
    stats_db._ensure_stats_columns_sync(conn)
    conn.execute(
        f"""
        UPDATE users SET {column} = {column} + ?, updated_at = ?
        WHERE telegram_id = ?
        """,
        (int(delta), int(time.time()), str(user_id)),
    )


def _deposit_burn_on_conn(conn: sqlite3.Connection, amount: float) -> None:
    row = conn.execute(
        "SELECT value FROM app_meta WHERE key = ?", ("prize_pool_burn",)
    ).fetchone()
    current = float(row["value"]) if row else 0.0
    conn.execute(
        """
        INSERT INTO app_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        ("prize_pool_burn", str(current + float(amount))),
    )


def _create_game_on_conn(conn: sqlite3.Connection, game_info: dict) -> str:
    game_id = uuid.uuid4().hex[:12]
    conn.execute(
        """
        INSERT INTO battle_games (
            id, player1_id, player2_id, bet, winner, creation_time, state_json
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)
        """,
        (
            game_id,
            game_info["player1"]["id"],
            game_info["player2"]["id"],
            game_info.get("bet"),
            game_info.get("creation_time", time.time()),
            json.dumps(game_info),
        ),
    )
    return game_id


def _update_game_on_conn(conn: sqlite3.Connection, game_id: str, game_info: dict) -> None:
    game_id = str(game_id)
    row = conn.execute(
        "SELECT * FROM battle_games WHERE id = ?", (game_id,)
    ).fetchone()
    if not row:
        return
    state = json.loads(row["state_json"])
    state.update(game_info)
    winner = state.get("winner", row["winner"])
    bet = state.get("bet", row["bet"])
    conn.execute(
        """
        UPDATE battle_games
        SET state_json = ?, bet = ?, winner = ?
        WHERE id = ?
        """,
        (json.dumps(state), bet, winner, game_id),
    )


def _player_from_team(user_id: str, name: str, team: list[str]) -> Player:
    return Player(
        id=int(user_id),
        name=name,
        pokemons_pool=get_pokemons_pool_from_vault(team),
        last_move_time=time.time(),
        special_card=get_special_card(),
        sleeping_pills_counter=None,
        revived_pokemon=None,
        pokemon=None,
    )


def _end_game(conn: sqlite3.Connection, winner_id: int, game: Game) -> bool:
    """Pay wager + record outcome once. Returns True if this call settled the battle."""
    row = conn.execute(
        "SELECT winner, bet FROM battle_games WHERE id = ?",
        (str(game.game_id),),
    ).fetchone()
    if not row:
        return False
    if row["winner"] is not None:
        game.winner = int(row["winner"])
        return False

    winner_id = int(winner_id)
    updated = conn.execute(
        "UPDATE battle_games SET winner = ? WHERE id = ? AND winner IS NULL",
        (winner_id, str(game.game_id)),
    ).rowcount
    if not updated:
        settled = conn.execute(
            "SELECT winner FROM battle_games WHERE id = ?",
            (str(game.game_id),),
        ).fetchone()
        if settled and settled["winner"] is not None:
            game.winner = int(settled["winner"])
        return False

    game.winner = winner_id
    _update_game_on_conn(conn, game.game_id, game.to_mongo())

    loser_id = game.player2.id if winner_id == game.player1.id else game.player1.id
    record_battle_outcome_on_conn(
        conn,
        winner_id,
        loser_id,
        game_id=game.game_id,
        bet=game.bet,
        source="poketab",
    )

    bet = int(row["bet"] or game.bet or 0)
    if bet > 0:
        for_winner = int(bet * 2 * 0.95)
        prize_pool = bet * 2 * 0.05
        _adjust_balance_on_conn(conn, str(winner_id), for_winner)
        _deposit_burn_on_conn(conn, prize_pool)

    conn.execute(
        """
        UPDATE poketab_battle_invites
        SET status = 'finished'
        WHERE game_id = ? AND status IN ('active', 'team_select')
        """,
        (str(game.game_id),),
    )
    return True


def _settle_battle(
    conn: sqlite3.Connection,
    game: Game,
    winner: Player,
    loser: Player,
    log: list[str],
    *,
    win_type: str,
) -> dict[str, Any]:
    """Resolve timeout / flee / KO — idempotent payout for the winner."""
    _save_game(conn, game)
    settled = _end_game(conn, winner.id, game)
    if win_type == "timeout":
        log.append(f"⌛ {loser.name} ran out of time — {winner.name} wins!")
    elif win_type == "flee":
        log.append(f"🏃 {loser.name} fled — {winner.name} wins!")
    elif win_type == "clear":
        log.append(f"🏆 {winner.name} wins!")
    return {
        "settled": settled,
        "winner_id": winner.id,
        "log": log,
        "quest_player_ids": [game.player1.id, game.player2.id] if settled else [],
    }


def _resolve_timeout_if_due(conn: sqlite3.Connection, game: Game) -> Optional[dict[str, Any]]:
    if game.winner is not None:
        return None
    outcome = _maybe_timeout(game)
    if not outcome:
        return None
    winner, loser = outcome
    game.winner = winner.id
    return _settle_battle(conn, game, winner, loser, [], win_type="timeout")


def _try_start_battle(conn: sqlite3.Connection, invite_id: int, valid_ids: set[str]) -> bool:
    row = conn.execute(
        "SELECT * FROM poketab_battle_invites WHERE id = ?", (invite_id,)
    ).fetchone()
    if not row or row["status"] != "team_select":
        return False
    if not row["challenger_team"] or not row["target_team"]:
        return False

    bet = int(row["bet"])
    p1 = row["challenger_id"]
    p2 = row["target_id"]
    if _user_balance(conn, p1) < bet or _user_balance(conn, p2) < bet:
        conn.execute(
            "UPDATE poketab_battle_invites SET status = 'cancelled' WHERE id = ?",
            (invite_id,),
        )
        return False

    team1 = json.loads(row["challenger_team"])
    team2 = json.loads(row["target_team"])
    _adjust_balance_on_conn(conn, p1, -bet)
    _adjust_balance_on_conn(conn, p2, -bet)
    _inc_stat_on_conn(conn, p1, "stats_wagered", bet)
    _inc_stat_on_conn(conn, p2, "stats_wagered", bet)

    try:
        game = Game.new(
            _player_from_team(p1, _user_display_name(conn, p1), team1),
            _player_from_team(p2, _user_display_name(conn, p2), team2),
            bet=bet,
        )
        game_id = _create_game_on_conn(conn, game.to_mongo())
        game.game_id = game_id
    except Exception:
        _adjust_balance_on_conn(conn, p1, bet)
        _adjust_balance_on_conn(conn, p2, bet)
        _inc_stat_on_conn(conn, p1, "stats_wagered", -bet)
        _inc_stat_on_conn(conn, p2, "stats_wagered", -bet)
        conn.execute(
            "UPDATE poketab_battle_invites SET status = 'cancelled' WHERE id = ?",
            (invite_id,),
        )
        return False

    conn.execute(
        """
        UPDATE poketab_battle_invites
        SET status = 'active', game_id = ?
        WHERE id = ?
        """,
        (game_id, invite_id),
    )
    _record_card_battle_usage(conn, p1, team1[0])
    _record_card_battle_usage(conn, p2, team2[0])
    _cancel_other_invites_for_battle(conn, (p1, p2), invite_id)
    return True


def _load_game_from_conn(conn: sqlite3.Connection, game_id: str) -> Optional[Game]:
    row = conn.execute(
        "SELECT * FROM battle_games WHERE id = ?", (str(game_id),)
    ).fetchone()
    if not row:
        return None
    state = json.loads(row["state_json"])
    state["_id"] = row["id"]
    state["bet"] = row["bet"]
    state["winner"] = row["winner"]
    state["creation_time"] = row["creation_time"]
    return Game.from_mongo(state)


def _load_game(game_id: str) -> Optional[Game]:
    doc = _get_game_by_id_sync(game_id)
    if not doc:
        return None
    return Game.from_mongo(doc)


def _save_game(conn: sqlite3.Connection, game: Game) -> None:
    _update_game_on_conn(conn, game.game_id, game.to_mongo())


def _serialize_pokemon(pokemon, catalog: dict) -> Optional[dict]:
    if not pokemon:
        return None
    card = catalog.get(pokemon.card_id, {})
    hp = max(0, int(pokemon.hp))
    max_hp = int(pokemon.max_hp)
    return {
        "card_id": pokemon.card_id,
        "name": pokemon.name,
        "type": pokemon.type.value if hasattr(pokemon.type, "value") else str(pokemon.type),
        "hp": hp,
        "max_hp": max_hp,
        "shield": bool(pokemon.shield),
        "image": card.get("src") or card.get("image"),
        "spells": [
            {
                "name": s.name,
                "attack": s.attack,
                "is_defence": s.is_defence,
                "remaining": s.count,
            }
            for s in pokemon.spells
        ],
    }


def _serialize_pool(pool: dict, catalog: dict) -> list[dict]:
    out = []
    for card_id, alive in sorted(pool.items()):
        card = catalog.get(card_id, {})
        out.append(
            {
                "card_id": card_id,
                "name": card.get("name") or card_display_name(card_id),
                "alive": bool(alive),
                "type": card.get("type"),
                "image": card.get("src") or card.get("image"),
            }
        )
    return out


def _turn_seconds_left(game: Game) -> int:
    attacker = game.get_attacker()
    if not attacker:
        return const.TIMEOUT
    elapsed = time.time() - attacker.last_move_time
    return max(0, int(const.TIMEOUT - elapsed))


def _maybe_timeout(game: Game) -> Optional[tuple[Player, Player]]:
    winner, loser = game.is_game_over_coz_timeout()
    if winner:
        return winner, loser
    return None


def _serialize_game(game: Game, viewer_id: str, catalog: dict, log: list[str]) -> dict:
    viewer_int = int(viewer_id)
    me = game.player1 if game.player1.id == viewer_int else game.player2
    opp = game.player2 if me is game.player1 else game.player1
    phase = "battle"
    if game.winner is not None:
        phase = "ended"
    elif not game.is_all_pokemons_selected():
        phase = "select_active"

    return {
        "game_id": game.game_id,
        "bet": game.bet,
        "phase": phase,
        "is_my_turn": game.is_player_attacks_now(viewer_int),
        "turn_seconds_left": _turn_seconds_left(game),
        "me": {
            "id": me.id,
            "name": me.name,
            "pokemon": _serialize_pokemon(me.pokemon, catalog),
            "pool": _serialize_pool(me.pokemons_pool, catalog),
            "special_card": me.special_card,
            "sleeping_pills_counter": me.sleeping_pills_counter,
        },
        "opponent": {
            "id": opp.id,
            "name": opp.name,
            "pokemon": _serialize_pokemon(opp.pokemon, catalog),
            "pool": _serialize_pool(opp.pokemons_pool, catalog),
        },
        "winner_id": game.winner,
        "log": log[-12:],
        "payout_note": f"Winner receives {int(game.bet * 2 * 0.95):,} $POKECARD (5% burn)" if game.bet else None,
    }


def get_status(
    conn: sqlite3.Connection,
    user_id: str,
    catalog: dict,
) -> dict:
    _expire_stale_invites(conn)
    balance = _user_balance(conn, user_id)
    alerts = count_battle_alerts(conn, user_id)
    incoming = list_incoming_invites(conn, user_id)
    outgoing = list_outgoing_invites(conn, user_id)

    pending = _pending_invite_for_user(conn, user_id)
    invite = None
    if pending:
        if pending["status"] == "team_select":
            _resolve_stale_team_select(conn, int(pending["id"]), set(catalog.keys()))
            pending = _pending_invite_for_user(conn, user_id)
        if pending and pending["status"] in ("pending", "team_select", "active"):
            invite = _invite_brief(pending, conn, user_id)

    active_doc = _active_game_for_user(conn, user_id)
    battle = None
    quest_player_ids: list[int] = []
    if active_doc and active_doc.get("winner") is None:
        game = Game.from_mongo(active_doc)
        timeout_result = _resolve_timeout_if_due(conn, game)
        if timeout_result:
            quest_player_ids = timeout_result.get("quest_player_ids") or []
            battle = _serialize_game(
                game,
                user_id,
                catalog,
                timeout_result["log"],
            )
        else:
            battle = _serialize_game(game, user_id, catalog, [])
    elif not battle:
        settled_doc = _settled_game_for_status(conn, user_id)
        if settled_doc:
            game = Game.from_mongo(settled_doc)
            battle = _serialize_game(game, user_id, catalog, [])

    balance = _user_balance(conn, user_id)
    return {
        "balance": balance,
        "battle_alerts": alerts,
        "incoming_invites": incoming,
        "outgoing_invites": outgoing,
        "invite": invite,
        "battle": battle,
        "quest_player_ids": quest_player_ids,
        "eligible_cards": len(eligible_battle_cards(conn, user_id, set(catalog.keys()))),
        "daily_battles_per_card": MAX_DAILY_BATTLES_PER_CARD,
    }


def perform_action(
    conn: sqlite3.Connection,
    user_id: str,
    catalog: dict,
    payload: dict,
) -> dict:
    action = str(payload.get("action") or "").strip().lower()
    game_id = str(payload.get("game_id") or "").strip()

    active_doc = _active_game_for_user(conn, user_id)
    if not active_doc:
        return {"ok": False, "error": "No active battle."}
    if game_id and str(active_doc.get("_id")) != game_id:
        return {"ok": False, "error": "Battle mismatch."}

    game = Game.from_mongo(active_doc)
    if game.winner is not None:
        return {
            "ok": True,
            "ended": True,
            "battle": _serialize_game(game, user_id, catalog, ["Battle already finished."]),
        }

    timeout_result = _resolve_timeout_if_due(conn, game)
    if timeout_result:
        log = timeout_result["log"]
        return {
            "ok": True,
            "ended": True,
            "win_type": "timeout",
            "quest_player_ids": timeout_result.get("quest_player_ids") or [],
            "battle": _serialize_game(game, user_id, catalog, log),
            **_opponent_battle_view(game, user_id, catalog, log),
        }

    viewer_int = int(user_id)
    log: list[str] = []

    if action == "select_pokemon":
        if not game.is_player_attacks_now(viewer_int):
            return {"ok": False, "error": "Wait for your opponent."}
        card_id = payload.get("card_id")
        if card_id and str(card_id).lower() != "none":
            try:
                game.select_pokemon(str(card_id))
                log.append(f"🎴 {game.get_attacker().name} sent out {card_display_name(resolve_card_id(card_id))}!")
            except ValueError as ex:
                return {"ok": False, "error": str(ex)}
        if not game.is_all_pokemons_selected():
            game.end_move()
            _save_game(conn, game)
            return {"ok": True, "battle": _serialize_game(game, user_id, catalog, log)}
        if card_id and str(card_id).lower() != "none":
            game.end_move()
        _save_game(conn, game)
        return {"ok": True, "battle": _serialize_game(game, user_id, catalog, log)}

    if not game.is_player_attacks_now(viewer_int):
        return {"ok": False, "error": "Not your turn."}

    if action == "flee":
        winner, loser = game.game_over_coz_flee(viewer_int)
        game.winner = winner.id
        result = _settle_battle(conn, game, winner, loser, [], win_type="flee")
        log = result["log"]
        return {
            "ok": True,
            "ended": True,
            "win_type": "flee",
            "quest_player_ids": result.get("quest_player_ids") or [],
            "battle": _serialize_game(game, user_id, catalog, log),
            **_opponent_battle_view(game, user_id, catalog, log),
        }

    if action == "attack":
        spell_name = str(payload.get("spell_name") or "").strip()
        if not spell_name:
            return {"ok": False, "error": "Pick a move."}
        try:
            actions = game.cast_spell(spell_name)
            log.extend(_strip_html(a) for a in actions)
            game.end_move()
        except Exception as ex:
            return {"ok": False, "error": str(ex)}

    elif action == "bag":
        item = str(payload.get("item") or "").strip()
        revive_id = payload.get("revive_card_id")
        if not game.get_attacker().special_card:
            return {"ok": False, "error": "PokéBag is empty."}
        special = game.get_attacker().special_card
        if special == const.REVIVE:
            if not revive_id:
                dead = game.get_attacker().get_pokemons_to_revive()
                return {"ok": True, "need_revive_target": True, "revive_options": dead}
            try:
                actions = game.use_special_card(str(revive_id))
            except Exception as ex:
                return {"ok": False, "error": str(ex)}
        else:
            try:
                actions = game.use_special_card(item if item else None)
            except Exception as ex:
                return {"ok": False, "error": str(ex)}
        log.extend(_strip_html(a) for a in actions)

    else:
        return {"ok": False, "error": "Unknown action."}

    _save_game(conn, game)

    if not game.is_all_pokemons_selected():
        outcome = game.is_game_over()
        if outcome:
            winner, loser = outcome
            game.winner = winner.id
            result = _settle_battle(conn, game, winner, loser, log, win_type="clear")
            log = result["log"]
            log.append(f"☠️ {loser.name} is out of cards!")
            return {
                "ok": True,
                "ended": True,
                "win_type": "clear",
                "quest_player_ids": result.get("quest_player_ids") or [],
                "battle": _serialize_game(game, user_id, catalog, log),
                **_opponent_battle_view(game, user_id, catalog, log),
            }
        _save_game(conn, game)
        return {"ok": True, "battle": _serialize_game(game, user_id, catalog, log)}

    outcome = game.is_game_over()
    if outcome:
        winner, loser = outcome
        game.winner = winner.id
        result = _settle_battle(conn, game, winner, loser, log, win_type="clear")
        end_log = result["log"]
        return {
            "ok": True,
            "ended": True,
            "win_type": "clear",
            "quest_player_ids": result.get("quest_player_ids") or [],
            "battle": _serialize_game(game, user_id, catalog, end_log),
            **_opponent_battle_view(game, user_id, catalog, end_log),
        }

    return {"ok": True, "battle": _serialize_game(game, user_id, catalog, log)}
