"""Secure $POKEQUEST deposit verification and withdrawal ledger.

CHIPS remain in users.balance — this module only records on-chain movements
in deposits / withdrawals and credits or debits users.balance atomically.
"""

from __future__ import annotations

import logging
import math
import re
import time
from typing import Any, Optional
from urllib.parse import urlparse

import base58

from game_wallet_config import (
    BROADCAST_STALE_SEC,
    GAME_WALLET,
    MAX_WITHDRAW_CHIPS,
    MIN_DEPOSIT_CHIPS,
    MIN_WITHDRAW_CHIPS,
    POKEQUEST_MINT,
    WITHDRAW_POLL_SEC,
)
from kins_payments import (
    _rpc,
    _token_delta_for_owner,
    get_mint_decimals,
)

logger = logging.getLogger(__name__)

VERIFY_RATE_LIMIT = 12  # per window
VERIFY_RATE_WINDOW_SEC = 60
WITHDRAW_COOLDOWN_SEC = 30
WITHDRAW_RATE_LIMIT = 6

DEPOSIT_STATUS_CONFIRMED = "confirmed"
WITHDRAWAL_PENDING = "pending"
WITHDRAWAL_BROADCASTING = "broadcasting"
WITHDRAWAL_CONFIRMED = "confirmed"
WITHDRAWAL_FAILED = "failed"
WITHDRAWAL_CANCELLED = "cancelled"

_SOLSCAN_TX_RE = re.compile(
    r"(?:https?://)?(?:www\.)?solscan\.io/tx/([1-9A-HJ-NP-Za-km-z]{32,88})",
    re.IGNORECASE,
)
_SIG_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,88}$")

_verify_buckets: dict[str, list[float]] = {}
_withdraw_buckets: dict[str, list[float]] = {}


def ensure_wallet_ledger_schema(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            tx_signature TEXT NOT NULL UNIQUE,
            sender_wallet TEXT NOT NULL,
            receiver_wallet TEXT NOT NULL,
            amount_tokens INTEGER NOT NULL,
            amount_chips INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'confirmed',
            verified_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx_signature
        ON deposits(tx_signature)
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_deposits_user "
        "ON deposits(user_id, created_at DESC)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            destination_wallet TEXT NOT NULL,
            amount_tokens INTEGER NOT NULL,
            amount_chips INTEGER NOT NULL,
            tx_signature TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            error_message TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_withdrawals_user "
        "ON withdrawals(user_id, created_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_withdrawals_status "
        "ON withdrawals(status, created_at)"
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_one_active_per_user
        ON withdrawals(user_id)
        WHERE status IN ('pending', 'broadcasting')
        """
    )


def wallet_config_for_client() -> dict[str, Any]:
    return {
        "gameWallet": GAME_WALLET,
        "tokenMint": POKEQUEST_MINT,
        "chipRatio": 1,
        "minDeposit": MIN_DEPOSIT_CHIPS,
        "minWithdraw": MIN_WITHDRAW_CHIPS,
        "maxWithdraw": MAX_WITHDRAW_CHIPS,
        "mintDecimals": get_mint_decimals(POKEQUEST_MINT),
    }


def normalize_tx_signature(raw: str) -> tuple[Optional[str], Optional[str]]:
    text = str(raw or "").strip()
    if not text:
        return None, "Transaction signature or Solscan link required."

    match = _SOLSCAN_TX_RE.search(text)
    if match:
        return match.group(1), None

    if text.startswith("http"):
        path = urlparse(text).path.rstrip("/")
        candidate = path.split("/")[-1] if path else ""
        if _SIG_RE.match(candidate):
            return candidate, None
        return None, "Could not read a transaction signature from that link."

    if _SIG_RE.match(text):
        return text, None

    return None, "Invalid transaction signature format."


def is_valid_solana_address(address: str) -> bool:
    address = str(address or "").strip()
    if not address or len(address) < 32 or len(address) > 44:
        return False
    try:
        decoded = base58.b58decode(address)
        return len(decoded) == 32
    except (ValueError, TypeError):
        return False


def _rate_limit(bucket: dict[str, list[float]], key: str, limit: int, window: int) -> bool:
    now = time.time()
    entries = [t for t in bucket.get(key, []) if now - t < window]
    if len(entries) >= limit:
        bucket[key] = entries
        return False
    entries.append(now)
    bucket[key] = entries
    return True


def _deposit_exists(conn: Any, tx_signature: str) -> bool:
    ensure_wallet_ledger_schema(conn)
    row = conn.execute(
        "SELECT id FROM deposits WHERE tx_signature = ?",
        (tx_signature,),
    ).fetchone()
    return row is not None


def _find_sender_wallet(meta: dict, mint: str) -> str:
    deltas: dict[str, float] = {}

    def _accum(bucket: list, sign: int) -> None:
        for entry in bucket or []:
            if entry.get("mint") != mint:
                continue
            owner = str(entry.get("owner") or "")
            if not owner:
                continue
            ui = entry.get("uiTokenAmount") or {}
            amount = float(ui.get("uiAmount") or 0)
            deltas[owner] = deltas.get(owner, 0.0) + sign * amount

    _accum(meta.get("preTokenBalances") or [], -1)
    _accum(meta.get("postTokenBalances") or [], 1)

    best_owner = ""
    best_sent = 0.0
    for owner, delta in deltas.items():
        if delta < -1e-9 and abs(delta) > best_sent:
            best_sent = abs(delta)
            best_owner = owner
    return best_owner


def _signature_finalized(tx_signature: str) -> tuple[bool, str]:
    try:
        statuses = _rpc(
            "getSignatureStatuses",
            [[tx_signature], {"searchTransactionHistory": True}],
        )
    except (RuntimeError, OSError, ValueError, TypeError) as exc:
        return False, f"Could not check transaction status ({exc})."

    value = (statuses or {}).get("value") or []
    entry = value[0] if value else None
    if not entry:
        return False, "Transaction not found yet. Wait for finalization and retry."

    if entry.get("err"):
        return False, "Transaction failed on-chain."

    status = str(entry.get("confirmationStatus") or "")
    if status not in ("confirmed", "finalized"):
        return False, "Transaction is not finalized yet. Try again shortly."

    return True, ""


def _load_transaction(tx_signature: str) -> tuple[Optional[dict], str]:
    try:
        result = _rpc(
            "getTransaction",
            [
                tx_signature,
                {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0},
            ],
        )
    except (RuntimeError, OSError, ValueError, TypeError) as exc:
        return None, f"Could not load transaction ({exc}). Try again shortly."

    if not result:
        return None, "Transaction not found yet. Wait a few seconds and retry."

    meta = result.get("meta") or {}
    if meta.get("err"):
        return None, "Transaction failed on-chain."

    ok, err = _signature_finalized(tx_signature)
    if not ok:
        return None, err

    return result, ""


def _verify_on_chain_transfer(tx_signature: str) -> tuple[bool, str, dict[str, Any]]:
    result, err = _load_transaction(tx_signature)
    if not result:
        return False, err, {}

    meta = result.get("meta") or {}
    received_ui = _token_delta_for_owner(meta, GAME_WALLET, POKEQUEST_MINT)
    if received_ui + 1e-9 < MIN_DEPOSIT_CHIPS:
        return (
            False,
            f"Treasury did not receive at least {MIN_DEPOSIT_CHIPS:,} $POKEQUEST.",
            {},
        )

    sender_wallet = _find_sender_wallet(meta, POKEQUEST_MINT)
    if not sender_wallet:
        return False, "Could not determine sender wallet from transaction.", {}

    decimals = get_mint_decimals(POKEQUEST_MINT)
    amount_chips = int(math.floor(received_ui + 1e-9))
    if amount_chips < MIN_DEPOSIT_CHIPS:
        return False, f"Deposit below minimum ({MIN_DEPOSIT_CHIPS:,} CHIPS).", {}

    amount_tokens = amount_chips * (10**decimals)

    return True, "", {
        "sender_wallet": sender_wallet,
        "receiver_wallet": GAME_WALLET,
        "amount_chips": amount_chips,
        "amount_tokens": amount_tokens,
        "amount_ui": received_ui,
    }


def _is_unique_violation(exc: Exception) -> bool:
    text = str(exc).lower()
    return "unique" in text or "duplicate" in text


def _lock_user_balance(conn: Any, user_id: str) -> Optional[dict]:
    from db.connection import is_postgres

    suffix = " FOR UPDATE" if is_postgres() else ""
    row = conn.execute(
        f"SELECT balance FROM users WHERE telegram_id = ?{suffix}",
        (user_id,),
    ).fetchone()
    return dict(row) if row else None


def verify_and_credit_deposit(
    conn: Any,
    *,
    user_id: str,
    signature_input: str,
) -> dict[str, Any]:
    ensure_wallet_ledger_schema(conn)

    if not _rate_limit(_verify_buckets, user_id, VERIFY_RATE_LIMIT, VERIFY_RATE_WINDOW_SEC):
        return {"ok": False, "error": "Too many verification attempts. Wait a moment."}

    tx_signature, norm_err = normalize_tx_signature(signature_input)
    if not tx_signature:
        return {"ok": False, "error": norm_err or "Invalid signature."}

    if _deposit_exists(conn, tx_signature):
        return {"ok": False, "error": "Deposit already claimed.", "code": "duplicate"}

    ok, err, details = _verify_on_chain_transfer(tx_signature)
    if not ok:
        return {"ok": False, "error": err}

    now = int(time.time())
    amount_chips = int(details["amount_chips"])

    row = conn.execute(
        "SELECT balance FROM users WHERE telegram_id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        return {"ok": False, "error": "User not found."}

    prior_balance = int(row["balance"] or 0)

    try:
        conn.execute(
            """
            INSERT INTO deposits (
                user_id, tx_signature, sender_wallet, receiver_wallet,
                amount_tokens, amount_chips, status, verified_at, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                tx_signature,
                details["sender_wallet"],
                details["receiver_wallet"],
                int(details["amount_tokens"]),
                amount_chips,
                DEPOSIT_STATUS_CONFIRMED,
                now,
                now,
            ),
        )
        conn.execute(
            """
            UPDATE users
            SET balance = balance + ?, updated_at = ?
            WHERE telegram_id = ?
            """,
            (amount_chips, now, user_id),
        )
    except Exception as exc:
        if _is_unique_violation(exc):
            return {"ok": False, "error": "Deposit already claimed.", "code": "duplicate"}
        raise

    new_balance = prior_balance + amount_chips
    logger.info(
        "deposit_credited user=%s sig=%s chips=%s sender=%s",
        user_id,
        tx_signature,
        amount_chips,
        details["sender_wallet"],
    )
    return {
        "ok": True,
        "credited_amount": amount_chips,
        "new_balance": new_balance,
        "tx_signature": tx_signature,
        "sender_wallet": details["sender_wallet"],
    }


def _active_withdrawal(conn: Any, user_id: str) -> bool:
    ensure_wallet_ledger_schema(conn)
    row = conn.execute(
        """
        SELECT id FROM withdrawals
        WHERE user_id = ?
          AND status IN (?, ?)
        LIMIT 1
        """,
        (user_id, WITHDRAWAL_PENDING, WITHDRAWAL_BROADCASTING),
    ).fetchone()
    return row is not None


def _last_withdrawal_ts(conn: Any, user_id: str) -> int:
    ensure_wallet_ledger_schema(conn)
    row = conn.execute(
        """
        SELECT created_at FROM withdrawals
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (user_id,),
    ).fetchone()
    if not row:
        return 0
    return int(row["created_at"] or 0)


def create_withdrawal_request(
    conn: Any,
    *,
    user_id: str,
    destination_wallet: str,
    amount_chips: int,
) -> dict[str, Any]:
    ensure_wallet_ledger_schema(conn)

    from db.connection import is_postgres

    if not is_postgres():
        conn.execute("BEGIN IMMEDIATE")

    destination_wallet = str(destination_wallet or "").strip()
    if not is_valid_solana_address(destination_wallet):
        return {"ok": False, "error": "Enter a valid Solana wallet address."}

    try:
        amount_chips = int(amount_chips)
    except (TypeError, ValueError):
        amount_chips = 0

    if amount_chips <= 0:
        return {"ok": False, "error": "Enter a positive amount."}
    if amount_chips < MIN_WITHDRAW_CHIPS:
        return {
            "ok": False,
            "error": f"Minimum withdrawal is {MIN_WITHDRAW_CHIPS:,} CHIPS.",
        }
    if amount_chips > MAX_WITHDRAW_CHIPS:
        return {
            "ok": False,
            "error": f"Maximum withdrawal is {MAX_WITHDRAW_CHIPS:,} CHIPS.",
        }

    if not _rate_limit(_withdraw_buckets, user_id, WITHDRAW_RATE_LIMIT, VERIFY_RATE_WINDOW_SEC):
        return {"ok": False, "error": "Too many withdrawal requests. Wait a moment."}

    last_ts = _last_withdrawal_ts(conn, user_id)
    now = int(time.time())
    if last_ts and now - last_ts < WITHDRAW_COOLDOWN_SEC:
        wait = WITHDRAW_COOLDOWN_SEC - (now - last_ts)
        return {"ok": False, "error": f"Please wait {wait}s before another withdrawal."}

    row = _lock_user_balance(conn, user_id)
    if row is None:
        return {"ok": False, "error": "User not found."}

    if _active_withdrawal(conn, user_id):
        return {"ok": False, "error": "You already have a withdrawal in progress."}

    balance = int(row["balance"] or 0)
    if amount_chips > balance:
        return {
            "ok": False,
            "error": f"Not enough CHIPS — you have {balance:,}.",
            "balance": balance,
        }

    decimals = get_mint_decimals(POKEQUEST_MINT)
    amount_tokens = amount_chips * (10**decimals)

    conn.execute(
        """
        UPDATE users
        SET balance = balance - ?, updated_at = ?
        WHERE telegram_id = ? AND balance >= ?
        """,
        (amount_chips, now, user_id, amount_chips),
    )
    row_after = conn.execute(
        "SELECT balance FROM users WHERE telegram_id = ?",
        (user_id,),
    ).fetchone()
    if row_after is None:
        return {"ok": False, "error": "User not found."}
    new_balance = int(row_after["balance"] or 0)
    if new_balance != balance - amount_chips:
        return {"ok": False, "error": "Could not debit balance. Try again."}

    try:
        cur = conn.execute(
            """
            INSERT INTO withdrawals (
                user_id, destination_wallet, amount_tokens, amount_chips,
                status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                destination_wallet,
                amount_tokens,
                amount_chips,
                WITHDRAWAL_PENDING,
                now,
            ),
        )
    except Exception as exc:
        if _is_unique_violation(exc):
            raise RuntimeError("concurrent_withdrawal") from exc
        raise
    wid = cur.lastrowid
    if not wid:
        row_id = conn.execute(
            "SELECT id FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
            (user_id,),
        ).fetchone()
        wid = int(row_id["id"]) if row_id else None

    logger.info(
        "withdrawal_requested user=%s id=%s chips=%s dest=%s",
        user_id,
        wid,
        amount_chips,
        destination_wallet,
    )
    return {
        "ok": True,
        "withdrawal_id": wid,
        "status": WITHDRAWAL_PENDING,
        "amount_chips": amount_chips,
        "new_balance": new_balance,
        "destination_wallet": destination_wallet,
    }


def refund_failed_withdrawal(
    conn: Any,
    withdrawal_id: int,
    *,
    error_message: str,
) -> bool:
    ensure_wallet_ledger_schema(conn)
    row = conn.execute(
        "SELECT * FROM withdrawals WHERE id = ?",
        (int(withdrawal_id),),
    ).fetchone()
    if not row or row["status"] not in (WITHDRAWAL_PENDING, WITHDRAWAL_BROADCASTING):
        return False

    user_id = row["user_id"]
    amount_chips = int(row["amount_chips"] or 0)
    now = int(time.time())

    conn.execute(
        """
        UPDATE users
        SET balance = balance + ?, updated_at = ?
        WHERE telegram_id = ?
        """,
        (amount_chips, now, user_id),
    )
    conn.execute(
        """
        UPDATE withdrawals
        SET status = ?, error_message = ?, completed_at = ?
        WHERE id = ?
        """,
        (WITHDRAWAL_FAILED, error_message[:500], now, int(withdrawal_id)),
    )
    logger.warning(
        "withdrawal_refunded id=%s user=%s chips=%s err=%s",
        withdrawal_id,
        user_id,
        amount_chips,
        error_message,
    )
    return True


def mark_withdrawal_confirmed(
    conn: Any,
    withdrawal_id: int,
    tx_signature: str,
) -> None:
    ensure_wallet_ledger_schema(conn)
    now = int(time.time())
    conn.execute(
        """
        UPDATE withdrawals
        SET status = ?, tx_signature = ?, completed_at = ?, error_message = NULL
        WHERE id = ?
        """,
        (WITHDRAWAL_CONFIRMED, tx_signature, now, int(withdrawal_id)),
    )


def mark_withdrawal_broadcasting(conn: Any, withdrawal_id: int) -> bool:
    ensure_wallet_ledger_schema(conn)
    row = conn.execute(
        "SELECT status FROM withdrawals WHERE id = ?",
        (int(withdrawal_id),),
    ).fetchone()
    if not row or row["status"] != WITHDRAWAL_PENDING:
        return False
    conn.execute(
        "UPDATE withdrawals SET status = ? WHERE id = ? AND status = ?",
        (WITHDRAWAL_BROADCASTING, int(withdrawal_id), WITHDRAWAL_PENDING),
    )
    return True


def list_pending_withdrawals(conn: Any, limit: int = 20) -> list[dict[str, Any]]:
    ensure_wallet_ledger_schema(conn)
    rows = conn.execute(
        """
        SELECT * FROM withdrawals
        WHERE status = ?
        ORDER BY created_at ASC
        LIMIT ?
        """,
        (WITHDRAWAL_PENDING, int(limit)),
    ).fetchall()
    return [dict(r) for r in rows]


def list_stale_broadcasting_withdrawals(conn: Any, *, stale_sec: int = 1800) -> list[dict[str, Any]]:
    """Broadcasting rows with no signature after stale_sec — safe to refund (no resend)."""
    ensure_wallet_ledger_schema(conn)
    cutoff = int(time.time()) - max(300, int(stale_sec))
    rows = conn.execute(
        """
        SELECT * FROM withdrawals
        WHERE status = ?
          AND (tx_signature IS NULL OR tx_signature = '')
          AND created_at < ?
        ORDER BY created_at ASC
        LIMIT 20
        """,
        (WITHDRAWAL_BROADCASTING, cutoff),
    ).fetchall()
    return [dict(r) for r in rows]


def wallet_history(conn: Any, user_id: str, *, limit: int = 30) -> dict[str, Any]:
    ensure_wallet_ledger_schema(conn)
    limit = max(1, min(int(limit), 100))

    deposits = conn.execute(
        """
        SELECT id, tx_signature, sender_wallet, amount_chips, status,
               verified_at, created_at
        FROM deposits
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (user_id, limit),
    ).fetchall()

    withdrawals = conn.execute(
        """
        SELECT id, destination_wallet, amount_chips, tx_signature, status,
               error_message, created_at, completed_at
        FROM withdrawals
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (user_id, limit),
    ).fetchall()

    return {
        "deposits": [dict(r) for r in deposits],
        "withdrawals": [dict(r) for r in withdrawals],
    }
