"""In-game PokéCard Marketplace — players list, buy, and cancel cards for CHIPS.

This is a fully off-chain, database-backed marketplace. Ownership lives in the
existing per-player ``users.vault`` JSON stacks (one stack per catalog card id),
so a "listing" references ``(seller_id, card_id)`` at the card's current grade.

Key model decisions (documented so behaviour is unambiguous):
  * A card is "locked" while it has an ``active`` listing — no vault mutation
    happens on listing, we simply refuse fuse/upgrade/relist for locked cards.
  * A buyer may not purchase a ``card_id`` they already own. Stacks are keyed by
    card id, so this keeps grade/copies math clean and avoids silent merges.
  * Buying transfers the *whole* stack (grade + banked copies) to the buyer and
    removes it from the seller, matching "remove from seller, add to buyer".
  * Purchases run inside a single DB transaction and claim the listing with an
    atomic ``UPDATE ... WHERE status='active'`` guard so two buyers can never
    win the same card.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Optional

from poke_registry import (
    POKE_JSON_PATH,
    load_card_catalog,
    parse_vault,
    valid_card_ids,
    vault_card_ids,
)
from vault_grading import (
    GRADE_LABELS,
    grade_multiplier,
    normalize_stack,
    vault_detail_for_client,
)

# --- Economy config -------------------------------------------------------

# Fraction of the sale price taken as a marketplace fee (burned / treasury).
MARKET_FEE_PCT = 0.05
MARKET_MIN_PRICE = 1
MARKET_MAX_PRICE = 100_000_000
BROWSE_LIMIT = 120
HISTORY_LIMIT = 30

VALID_STATUSES = ("active", "sold", "cancelled")


def market_config() -> dict[str, Any]:
    return {
        "fee_pct": MARKET_FEE_PCT,
        "fee_percent_label": f"{round(MARKET_FEE_PCT * 100)}%",
        "seller_percent_label": f"{round((1 - MARKET_FEE_PCT) * 100)}%",
        "min_price": MARKET_MIN_PRICE,
        "max_price": MARKET_MAX_PRICE,
    }


def compute_fee(price: int) -> tuple[int, int]:
    """Return (market_fee, seller_received) for a sale price."""
    price = int(price)
    fee = int(price * MARKET_FEE_PCT)
    seller_received = price - fee
    return fee, seller_received


# --- Schema ---------------------------------------------------------------

def ensure_market_schema(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS market_listings (
            listing_id INTEGER PRIMARY KEY AUTOINCREMENT,
            seller_id TEXT NOT NULL,
            seller_name TEXT,
            card_id TEXT NOT NULL,
            grade INTEGER NOT NULL DEFAULT 1,
            price_chips INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            sold_at INTEGER,
            buyer_id TEXT,
            buyer_name TEXT,
            seller_received INTEGER,
            market_fee INTEGER,
            stack_json TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_market_active "
        "ON market_listings(status, created_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_market_seller "
        "ON market_listings(seller_id, status)"
    )
    # One active listing per (seller, card). Enforced at the DB level too.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_market_one_active "
        "ON market_listings(seller_id, card_id) WHERE status = 'active'"
    )


# --- Card / catalog helpers ----------------------------------------------

def _catalog(path: Optional[Path] = None) -> dict[str, dict]:
    return load_card_catalog(path or POKE_JSON_PATH)


def card_base_power(card: dict[str, Any]) -> int:
    """Sum of attack moves + HP — a simple, honest 'power' number."""
    power = int(card.get("hp") or 0)
    for spell in card.get("spells") or []:
        if not spell.get("is_defence"):
            power += int(spell.get("attack") or 0)
    return power


def card_total_power(card: dict[str, Any], grade: int) -> int:
    return int(round(card_base_power(card) * grade_multiplier(grade)))


def _card_image_src(card: dict[str, Any]) -> str:
    image = str(card.get("image") or "").strip()
    return f"/static/pool/{image}" if image else ""


def _grade_label(grade: int) -> str:
    return GRADE_LABELS.get(int(grade or 1), "Standard")


def _row_get(row: Any, key: str, default: Any = None) -> Any:
    try:
        val = row[key]
        return default if val is None else val
    except (KeyError, IndexError, TypeError):
        return default


def listing_public(row: Any, catalog: dict[str, dict], *, viewer_id: str = "") -> dict[str, Any]:
    card_id = str(_row_get(row, "card_id", ""))
    card = catalog.get(card_id, {})
    grade = int(_row_get(row, "grade", 1) or 1)
    price = int(_row_get(row, "price_chips", 0) or 0)
    fee, seller_received = compute_fee(price)
    seller_id = str(_row_get(row, "seller_id", ""))
    return {
        "listing_id": int(_row_get(row, "listing_id", 0) or 0),
        "seller_id": seller_id,
        "seller_name": str(_row_get(row, "seller_name", "") or "Trainer"),
        "is_own": bool(viewer_id) and seller_id == viewer_id,
        "card_id": card_id,
        "name": str(card.get("name") or card_id),
        "image": _card_image_src(card),
        "type": str(card.get("type") or ""),
        "hp": int(card.get("hp") or 0),
        "level": int(card.get("lvl") or 0),
        "grade": grade,
        "grade_label": _grade_label(grade),
        "multiplier": grade_multiplier(grade),
        "base_power": card_base_power(card),
        "total_power": card_total_power(card, grade),
        "price_chips": price,
        "market_fee": int(_row_get(row, "market_fee", fee) or fee),
        "seller_received": int(_row_get(row, "seller_received", seller_received) or seller_received),
        "status": str(_row_get(row, "status", "active")),
        "created_at": int(_row_get(row, "created_at", 0) or 0),
        "sold_at": int(_row_get(row, "sold_at", 0) or 0) or None,
        "buyer_id": _row_get(row, "buyer_id", None),
        "buyer_name": _row_get(row, "buyer_name", None),
    }


# --- Vault (users table) helpers -----------------------------------------

def _load_user(conn: Any, uid: str) -> Optional[Any]:
    return conn.execute(
        "SELECT telegram_id, display_name, balance, vault FROM users WHERE telegram_id = ?",
        (uid,),
    ).fetchone()


def _parse_vault(raw: Any) -> list[dict[str, Any]]:
    return parse_vault(raw, valid_card_ids(), poke_json_path=POKE_JSON_PATH)


def _find_stack(vault: list[dict[str, Any]], card_id: str) -> Optional[dict[str, Any]]:
    for entry in vault:
        if str(entry.get("card_id") or "").strip() == card_id:
            return entry
    return None


def active_listing_card_ids(conn: Any, seller_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT card_id FROM market_listings WHERE seller_id = ? AND status = 'active'",
        (seller_id,),
    ).fetchall()
    return [str(_row_get(r, "card_id", "")) for r in rows if _row_get(r, "card_id")]


# --- Public operations ----------------------------------------------------

def create_listing(
    conn: Any,
    seller_id: str,
    *,
    card_id: str,
    price: int,
) -> dict[str, Any]:
    card_id = str(card_id or "").strip()
    catalog = _catalog()
    if card_id not in catalog:
        return {"ok": False, "error": "unknown_card"}

    try:
        price = int(price)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid_price"}
    if price < MARKET_MIN_PRICE:
        return {"ok": False, "error": "price_too_low"}
    if price > MARKET_MAX_PRICE:
        return {"ok": False, "error": "price_too_high"}

    seller = _load_user(conn, seller_id)
    if seller is None:
        return {"ok": False, "error": "user_not_found"}

    vault = _parse_vault(_row_get(seller, "vault"))
    stack = _find_stack(vault, card_id)
    if not stack:
        return {"ok": False, "error": "card_not_owned"}

    existing = conn.execute(
        "SELECT listing_id FROM market_listings "
        "WHERE seller_id = ? AND card_id = ? AND status = 'active'",
        (seller_id, card_id),
    ).fetchone()
    if existing:
        return {"ok": False, "error": "already_listed"}

    grade = int(stack.get("grade") or 1)
    seller_name = str(_row_get(seller, "display_name", "") or "Trainer")
    now = int(time.time())

    conn.execute(
        """
        INSERT INTO market_listings
            (seller_id, seller_name, card_id, grade, price_chips, status,
             created_at, stack_json)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        """,
        (seller_id, seller_name, card_id, grade, price, now, json.dumps(normalize_stack(stack))),
    )

    row = conn.execute(
        "SELECT * FROM market_listings "
        "WHERE seller_id = ? AND card_id = ? AND status = 'active'",
        (seller_id, card_id),
    ).fetchone()
    return {
        "ok": True,
        "listing": listing_public(row, catalog, viewer_id=seller_id),
        "locked_card_ids": active_listing_card_ids(conn, seller_id),
    }


def cancel_listing(conn: Any, seller_id: str, *, listing_id: int) -> dict[str, Any]:
    try:
        listing_id = int(listing_id)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid_listing"}

    now = int(time.time())
    cur = conn.execute(
        "UPDATE market_listings SET status = 'cancelled', sold_at = ? "
        "WHERE listing_id = ? AND seller_id = ? AND status = 'active'",
        (now, listing_id, seller_id),
    )
    if int(getattr(cur, "rowcount", 0) or 0) < 1:
        return {"ok": False, "error": "listing_not_active"}

    # No vault change: the card was never removed while listed. It simply unlocks.
    return {
        "ok": True,
        "listing_id": listing_id,
        "locked_card_ids": active_listing_card_ids(conn, seller_id),
    }


def buy_listing(conn: Any, buyer_id: str, *, listing_id: int) -> dict[str, Any]:
    try:
        listing_id = int(listing_id)
    except (TypeError, ValueError):
        return {"ok": False, "error": "invalid_listing"}

    catalog = _catalog()
    listing = conn.execute(
        "SELECT * FROM market_listings WHERE listing_id = ?",
        (listing_id,),
    ).fetchone()
    if listing is None:
        return {"ok": False, "error": "listing_not_found"}
    if str(_row_get(listing, "status", "")) != "active":
        return {"ok": False, "error": "listing_not_active"}

    seller_id = str(_row_get(listing, "seller_id", ""))
    card_id = str(_row_get(listing, "card_id", ""))
    price = int(_row_get(listing, "price_chips", 0) or 0)

    if seller_id == buyer_id:
        return {"ok": False, "error": "cannot_buy_own"}

    buyer = _load_user(conn, buyer_id)
    if buyer is None:
        return {"ok": False, "error": "user_not_found"}
    seller = _load_user(conn, seller_id)
    if seller is None:
        return {"ok": False, "error": "seller_not_found"}

    buyer_balance = int(_row_get(buyer, "balance", 0) or 0)
    if buyer_balance < price:
        return {"ok": False, "error": "insufficient_balance", "balance": buyer_balance, "price": price}

    buyer_vault = _parse_vault(_row_get(buyer, "vault"))
    if _find_stack(buyer_vault, card_id):
        return {"ok": False, "error": "already_owned"}

    seller_vault = _parse_vault(_row_get(seller, "vault"))
    seller_stack = _find_stack(seller_vault, card_id)
    if not seller_stack:
        # Seller no longer owns the card — retire the stale listing.
        conn.execute(
            "UPDATE market_listings SET status = 'cancelled' "
            "WHERE listing_id = ? AND status = 'active'",
            (listing_id,),
        )
        return {"ok": False, "error": "seller_no_longer_owns"}

    fee, seller_received = compute_fee(price)
    now = int(time.time())
    buyer_name = str(_row_get(buyer, "display_name", "") or "Trainer")

    # Atomic claim: only one concurrent buyer can flip active -> sold.
    cur = conn.execute(
        """
        UPDATE market_listings
        SET status = 'sold', sold_at = ?, buyer_id = ?, buyer_name = ?,
            seller_received = ?, market_fee = ?
        WHERE listing_id = ? AND status = 'active'
        """,
        (now, buyer_id, buyer_name, seller_received, fee, listing_id),
    )
    if int(getattr(cur, "rowcount", 0) or 0) < 1:
        return {"ok": False, "error": "listing_not_active"}

    # Transfer the whole stack: remove from seller, add to buyer.
    transferred = normalize_stack(seller_stack)
    transferred["source"] = "marketplace"
    transferred["acquired_at"] = now
    new_seller_vault = [
        entry for entry in seller_vault
        if str(entry.get("card_id") or "").strip() != card_id
    ]
    new_buyer_vault = list(buyer_vault) + [transferred]

    new_buyer_balance = buyer_balance - price
    new_seller_balance = int(_row_get(seller, "balance", 0) or 0) + seller_received

    conn.execute(
        "UPDATE users SET vault = ?, balance = ?, updated_at = ? WHERE telegram_id = ?",
        (json.dumps(new_buyer_vault), new_buyer_balance, now, buyer_id),
    )
    conn.execute(
        "UPDATE users SET vault = ?, balance = ?, updated_at = ? WHERE telegram_id = ?",
        (json.dumps(new_seller_vault), new_seller_balance, now, seller_id),
    )

    card = catalog.get(card_id, {})
    return {
        "ok": True,
        "listing_id": listing_id,
        "card_id": card_id,
        "card_name": str(card.get("name") or card_id),
        "grade": int(_row_get(listing, "grade", 1) or 1),
        "price_chips": price,
        "market_fee": fee,
        "seller_received": seller_received,
        "buyer_balance": new_buyer_balance,
        "buyer_vault": vault_card_ids(new_buyer_vault),
        "buyer_vault_detail": vault_detail_for_client(new_buyer_vault),
    }


def browse_listings(
    conn: Any,
    *,
    viewer_id: str = "",
    query: str = "",
    card_type: str = "",
    grade: Optional[int] = None,
    sort: str = "newest",
    limit: int = BROWSE_LIMIT,
) -> list[dict[str, Any]]:
    catalog = _catalog()
    rows = conn.execute(
        "SELECT * FROM market_listings WHERE status = 'active' ORDER BY created_at DESC LIMIT ?",
        (max(1, min(int(limit or BROWSE_LIMIT), 500)),),
    ).fetchall()

    items = [listing_public(r, catalog, viewer_id=viewer_id) for r in rows]

    q = str(query or "").strip().lower()
    if q:
        items = [it for it in items if q in it["name"].lower()]
    ctype = str(card_type or "").strip().lower()
    if ctype and ctype != "all":
        items = [it for it in items if it["type"].lower() == ctype]
    if grade:
        try:
            g = int(grade)
            items = [it for it in items if it["grade"] == g]
        except (TypeError, ValueError):
            pass

    sort = str(sort or "newest").strip()
    if sort == "price_asc":
        items.sort(key=lambda it: (it["price_chips"], -it["created_at"]))
    elif sort == "price_desc":
        items.sort(key=lambda it: (-it["price_chips"], -it["created_at"]))
    elif sort == "power_desc":
        items.sort(key=lambda it: (-it["total_power"], -it["created_at"]))
    else:  # newest
        items.sort(key=lambda it: -it["created_at"])

    return items


def my_listings(conn: Any, seller_id: str, *, limit: int = 60) -> list[dict[str, Any]]:
    catalog = _catalog()
    rows = conn.execute(
        "SELECT * FROM market_listings WHERE seller_id = ? "
        "ORDER BY (status = 'active') DESC, created_at DESC LIMIT ?",
        (seller_id, max(1, min(int(limit or 60), 200))),
    ).fetchall()
    return [listing_public(r, catalog, viewer_id=seller_id) for r in rows]


def market_history(conn: Any, *, limit: int = HISTORY_LIMIT) -> list[dict[str, Any]]:
    catalog = _catalog()
    rows = conn.execute(
        "SELECT * FROM market_listings WHERE status = 'sold' "
        "ORDER BY sold_at DESC LIMIT ?",
        (max(1, min(int(limit or HISTORY_LIMIT), 100)),),
    ).fetchall()
    return [listing_public(r, catalog) for r in rows]
