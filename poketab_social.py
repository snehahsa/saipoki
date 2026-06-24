"""PokéTab friends, requests, and direct messages."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Optional

MAX_MESSAGE_LEN = 500
MAX_DISPLAY_NAME_LEN = 24


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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


def _pair_ids(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def _user_brief(row: sqlite3.Row | None) -> Optional[dict]:
    if not row:
        return None
    name = (row["display_name"] or row["username"] or "Trainer").strip()
    if len(name) > MAX_DISPLAY_NAME_LEN:
        name = f"{name[: MAX_DISPLAY_NAME_LEN - 2]}.."
    from quest_engine import parse_quest_progress
    from trainer_stats import trainer_stats_row

    stats = trainer_stats_row(row, parse_quest_progress(row["quest_progress"]))
    return {
        "telegram_id": row["telegram_id"],
        "display_name": name,
        "skin": row["skin"] or "009",
        "level": stats["level"],
        "level_title": stats["level_title"],
        "stats_xp": stats["stats_xp"],
    }


def _fetch_user(conn: sqlite3.Connection, telegram_id: str) -> Optional[dict]:
    row = conn.execute(
        """
        SELECT telegram_id, display_name, username, skin,
               stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp,
               quest_progress
        FROM users WHERE telegram_id = ?
        """,
        (telegram_id,),
    ).fetchone()
    return _user_brief(row)


def are_friends(conn: sqlite3.Connection, a: str, b: str) -> bool:
    low, high = _pair_ids(a, b)
    row = conn.execute(
        "SELECT 1 FROM friendships WHERE user_low = ? AND user_high = ?",
        (low, high),
    ).fetchone()
    return row is not None


def relation_status(conn: sqlite3.Connection, viewer_id: str, other_id: str) -> str:
    if viewer_id == other_id:
        return "self"
    if are_friends(conn, viewer_id, other_id):
        return "friend"
    row = conn.execute(
        """
        SELECT from_id, to_id, status FROM friend_requests
        WHERE (
            (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
        ) AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
        """,
        (viewer_id, other_id, other_id, viewer_id),
    ).fetchone()
    if not row:
        return "none"
    if row["from_id"] == viewer_id:
        return "request_sent"
    return "request_received"


def _ensure_friends_seen_initialized(conn: sqlite3.Connection, viewer_id: str) -> None:
    row = conn.execute(
        "SELECT 1 FROM poketab_user_state WHERE user_id = ?",
        (viewer_id,),
    ).fetchone()
    if row:
        return
    conn.execute(
        "INSERT INTO poketab_user_state (user_id, friends_seen_at) VALUES (?, ?)",
        (viewer_id, int(time.time())),
    )


def _friends_seen_at(conn: sqlite3.Connection, viewer_id: str) -> int:
    row = conn.execute(
        "SELECT friends_seen_at FROM poketab_user_state WHERE user_id = ?",
        (viewer_id,),
    ).fetchone()
    return int(row["friends_seen_at"]) if row else 0


def mark_friends_seen(conn: sqlite3.Connection, viewer_id: str) -> None:
    now = int(time.time())
    conn.execute(
        """
        INSERT INTO poketab_user_state (user_id, friends_seen_at)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET friends_seen_at = excluded.friends_seen_at
        """,
        (viewer_id, now),
    )


def count_new_friends(conn: sqlite3.Connection, viewer_id: str) -> int:
    seen = _friends_seen_at(conn, viewer_id)
    row = conn.execute(
        """
        SELECT COUNT(*) AS c FROM friendships
        WHERE (user_low = ? OR user_high = ?) AND created_at > ?
        """,
        (viewer_id, viewer_id, seen),
    ).fetchone()
    return int(row["c"])


def summary(conn: sqlite3.Connection, viewer_id: str) -> dict:
    _ensure_friends_seen_initialized(conn, viewer_id)
    pending = conn.execute(
        """
        SELECT COUNT(*) AS c FROM friend_requests
        WHERE to_id = ? AND status = 'pending'
        """,
        (viewer_id,),
    ).fetchone()["c"]
    friends = conn.execute(
        """
        SELECT COUNT(*) AS c FROM friendships
        WHERE user_low = ? OR user_high = ?
        """,
        (viewer_id, viewer_id),
    ).fetchone()["c"]
    unread = conn.execute(
        """
        SELECT COUNT(*) AS c FROM poketab_messages
        WHERE to_id = ? AND read_at IS NULL
        """,
        (viewer_id,),
    ).fetchone()["c"]
    new_friends = count_new_friends(conn, viewer_id)
    pending_i = int(pending)
    unread_i = int(unread)
    return {
        "pending_requests": pending_i,
        "friends_count": int(friends),
        "unread_messages": unread_i,
        "new_friends": new_friends,
        "notification_count": pending_i + unread_i + new_friends,
    }


def list_friends(conn: sqlite3.Connection, viewer_id: str, online_ids: set[str]) -> list[dict]:
    rows = conn.execute(
        """
        SELECT user_low, user_high, created_at FROM friendships
        WHERE user_low = ? OR user_high = ?
        ORDER BY created_at DESC
        """,
        (viewer_id, viewer_id),
    ).fetchall()
    friends: list[dict] = []
    for row in rows:
        peer_id = row["user_high"] if row["user_low"] == viewer_id else row["user_low"]
        user = _fetch_user(conn, peer_id)
        if not user:
            continue
        user["online"] = peer_id in online_ids
        user["friends_since"] = row["created_at"]
        friends.append(user)
    mark_friends_seen(conn, viewer_id)
    return friends


def list_incoming_requests(conn: sqlite3.Connection, viewer_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, from_id, created_at FROM friend_requests
        WHERE to_id = ? AND status = 'pending'
        ORDER BY created_at DESC
        """,
        (viewer_id,),
    ).fetchall()
    out = []
    for row in rows:
        user = _fetch_user(conn, row["from_id"])
        if not user:
            continue
        out.append(
            {
                "id": row["id"],
                "from": user,
                "created_at": row["created_at"],
            }
        )
    return out


def online_players_with_status(
    conn: sqlite3.Connection,
    viewer_id: str,
    online_players: list[dict],
) -> list[dict]:
    out = []
    for player in online_players:
        uid = str(player.get("uid") or "")
        if not uid or uid == viewer_id:
            continue
        user = _fetch_user(conn, uid)
        if not user:
            user = {
                "telegram_id": uid,
                "display_name": (player.get("username") or "Trainer")[:MAX_DISPLAY_NAME_LEN],
                "skin": player.get("skin") or "009",
            }
        status = relation_status(conn, viewer_id, uid)
        out.append(
            {
                **user,
                "online": True,
                "room": player.get("room"),
                "relation": status,
            }
        )
    out.sort(key=lambda item: item["display_name"].lower())
    return out


def send_friend_request(conn: sqlite3.Connection, from_id: str, to_id: str) -> dict:
    if from_id == to_id:
        return {"ok": False, "error": "You cannot add yourself."}
    if not _fetch_user(conn, to_id):
        return {"ok": False, "error": "Trainer not found."}
    if are_friends(conn, from_id, to_id):
        return {"ok": False, "error": "Already friends."}

    existing = conn.execute(
        """
        SELECT id, from_id, to_id, status FROM friend_requests
        WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
        ORDER BY created_at DESC LIMIT 1
        """,
        (from_id, to_id, to_id, from_id),
    ).fetchone()
    if existing and existing["status"] == "pending":
        if existing["from_id"] == from_id:
            return {"ok": False, "error": "Friend request already sent."}
        return {"ok": False, "error": "They already sent you a request — check Requests."}

    now = int(time.time())
    conn.execute(
        """
        INSERT INTO friend_requests (from_id, to_id, status, created_at)
        VALUES (?, ?, 'pending', ?)
        ON CONFLICT(from_id, to_id) DO UPDATE SET
            status = 'pending',
            created_at = excluded.created_at,
            responded_at = NULL
        """,
        (from_id, to_id, now),
    )
    row = conn.execute(
        "SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ?",
        (from_id, to_id),
    ).fetchone()
    return {"ok": True, "request_id": row["id"], "to_id": to_id}


def respond_friend_request(
    conn: sqlite3.Connection,
    viewer_id: str,
    request_id: int,
    accept: bool,
) -> dict:
    row = conn.execute(
        "SELECT * FROM friend_requests WHERE id = ?",
        (request_id,),
    ).fetchone()
    if not row:
        return {"ok": False, "error": "Request not found."}
    if row["to_id"] != viewer_id:
        return {"ok": False, "error": "Not your request."}
    if row["status"] != "pending":
        return {"ok": False, "error": "Request already handled."}

    now = int(time.time())
    status = "accepted" if accept else "declined"
    conn.execute(
        """
        UPDATE friend_requests
        SET status = ?, responded_at = ?
        WHERE id = ?
        """,
        (status, now, request_id),
    )
    if accept:
        low, high = _pair_ids(row["from_id"], row["to_id"])
        conn.execute(
            """
            INSERT OR IGNORE INTO friendships (user_low, user_high, created_at)
            VALUES (?, ?, ?)
            """,
            (low, high, now),
        )
        return {"ok": True, "accepted": True, "friend_id": row["from_id"]}
    return {"ok": True, "accepted": False}


def list_conversations(conn: sqlite3.Connection, viewer_id: str, online_ids: set[str]) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            CASE WHEN from_id = ? THEN to_id ELSE from_id END AS peer_id,
            MAX(created_at) AS last_at,
            SUM(CASE WHEN to_id = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
        FROM poketab_messages
        WHERE from_id = ? OR to_id = ?
        GROUP BY peer_id
        ORDER BY last_at DESC
        """,
        (viewer_id, viewer_id, viewer_id, viewer_id),
    ).fetchall()

    conversations = []
    for row in rows:
        peer_id = row["peer_id"]
        if not are_friends(conn, viewer_id, peer_id):
            continue
        user = _fetch_user(conn, peer_id)
        if not user:
            continue
        last = conn.execute(
            """
            SELECT body, from_id, created_at FROM poketab_messages
            WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
            ORDER BY created_at DESC LIMIT 1
            """,
            (viewer_id, peer_id, peer_id, viewer_id),
        ).fetchone()
        conversations.append(
            {
                "peer": user,
                "peer_id": peer_id,
                "online": peer_id in online_ids,
                "unread": int(row["unread"] or 0),
                "last_message": last["body"] if last else "",
                "last_at": row["last_at"],
                "last_from_self": bool(last and last["from_id"] == viewer_id),
            }
        )
    return conversations


def get_thread(conn: sqlite3.Connection, viewer_id: str, peer_id: str) -> dict:
    if not are_friends(conn, viewer_id, peer_id):
        return {"ok": False, "error": "You can only message friends."}
    peer = _fetch_user(conn, peer_id)
    if not peer:
        return {"ok": False, "error": "Trainer not found."}

    rows = conn.execute(
        """
        SELECT id, from_id, to_id, body, created_at, read_at
        FROM poketab_messages
        WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
        ORDER BY created_at ASC
        LIMIT 200
        """,
        (viewer_id, peer_id, peer_id, viewer_id),
    ).fetchall()

    now = int(time.time())
    conn.execute(
        """
        UPDATE poketab_messages SET read_at = ?
        WHERE from_id = ? AND to_id = ? AND read_at IS NULL
        """,
        (now, peer_id, viewer_id),
    )

    messages = [
        {
            "id": row["id"],
            "from_id": row["from_id"],
            "to_id": row["to_id"],
            "body": row["body"],
            "created_at": row["created_at"],
            "mine": row["from_id"] == viewer_id,
        }
        for row in rows
    ]
    return {"ok": True, "peer": peer, "messages": messages}


def send_message(conn: sqlite3.Connection, from_id: str, to_id: str, body: str) -> dict:
    text = " ".join(str(body or "").split())
    if not text:
        return {"ok": False, "error": "Message cannot be empty."}
    if len(text) > MAX_MESSAGE_LEN:
        return {"ok": False, "error": f"Message too long (max {MAX_MESSAGE_LEN})."}
    if not are_friends(conn, from_id, to_id):
        return {"ok": False, "error": "You can only message friends."}
    if not _fetch_user(conn, to_id):
        return {"ok": False, "error": "Trainer not found."}

    now = int(time.time())
    cur = conn.execute(
        """
        INSERT INTO poketab_messages (from_id, to_id, body, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (from_id, to_id, text, now),
    )
    return {
        "ok": True,
        "message": {
            "id": cur.lastrowid,
            "from_id": from_id,
            "to_id": to_id,
            "body": text,
            "created_at": now,
            "mine": True,
        },
    }
