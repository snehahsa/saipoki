"""On-chain $POKEQUEST payment intents and Solana transaction verification."""

from __future__ import annotations

import json
import os
import secrets
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from wallet_auth import KINS_TOKEN_MINT, SOLANA_RPC_URL, solana_rpc_urls
from game_wallet_config import KINS_TREASURY_WALLET

# $POKEQUEST is a pump.fun Token-2022 mint — not the legacy SPL Token program.
TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

PAYMENT_INTENT_TTL_SEC = int(os.getenv("KINS_PAYMENT_INTENT_TTL_SEC", "600"))
MIN_DEPOSIT_KINS = int(os.getenv("KINS_MIN_DEPOSIT", "1"))
MIN_WITHDRAW_KINS = int(os.getenv("KINS_MIN_WITHDRAW", "5000"))
MAX_DEPOSIT_KINS = int(os.getenv("KINS_MAX_DEPOSIT", "1000000"))


def _rpc(method: str, params: list) -> Any:
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    errors: list[str] = []
    for rpc_url in solana_rpc_urls():
        req = urllib.request.Request(
            rpc_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            errors.append(f"{rpc_url}: {exc}")
            continue
        if body.get("error"):
            errors.append(
                f"{rpc_url}: {body['error'].get('message', 'Solana RPC error')}"
            )
            continue
        return body.get("result")
    detail = errors[0] if errors else "No Solana RPC endpoints configured."
    raise RuntimeError(f"Solana RPC failed ({detail})")


def get_latest_blockhash(commitment: str = "confirmed") -> dict[str, Any]:
    result = _rpc("getLatestBlockhash", [{"commitment": commitment}])
    value = result.get("value") if isinstance(result, dict) else None
    if not value or not value.get("blockhash"):
        raise RuntimeError("Solana RPC did not return a recent blockhash.")
    return {
        "blockhash": str(value["blockhash"]),
        "lastValidBlockHeight": int(value.get("lastValidBlockHeight") or 0),
    }


def get_mint_decimals(mint: str = KINS_TOKEN_MINT) -> int:
    try:
        info = _rpc("getAccountInfo", [mint, {"encoding": "jsonParsed"}])
        value = info.get("value") or {}
        parsed = value.get("data", {})
        if isinstance(parsed, dict):
            return int(parsed.get("parsed", {}).get("info", {}).get("decimals", 6))
    except (RuntimeError, urllib.error.URLError, TimeoutError, ValueError, TypeError):
        pass
    return 6


def kins_to_raw(amount_kins: int, decimals: Optional[int] = None) -> int:
    dec = decimals if decimals is not None else get_mint_decimals()
    return int(amount_kins) * (10**dec)


def treasury_kins_ata_exists() -> bool:
    try:
        result = _rpc(
            "getTokenAccountsByOwner",
            [
                KINS_TREASURY_WALLET,
                {"mint": KINS_TOKEN_MINT},
                {"encoding": "jsonParsed"},
            ],
        )
        return bool((result or {}).get("value"))
    except (RuntimeError, urllib.error.URLError, TimeoutError, ValueError, TypeError):
        return False


TREASURY_NOT_READY_ERROR = (
    "Treasury $POKEQUEST account is not set up yet. "
    "The first deposit will create it automatically (small one-time SOL fee)."
)


def assert_treasury_payment_ready() -> None:
    """Legacy helper — deposits no longer require pre-created treasury ATA."""
    return


def build_transfer_plan(amount_kins: int) -> dict[str, Any]:
    amount_kins = int(amount_kins)
    decimals = get_mint_decimals()
    treasury_ready = treasury_kins_ata_exists()
    return {
        "amountKins": amount_kins,
        "rawAmount": str(kins_to_raw(amount_kins, decimals)),
        "decimals": decimals,
        "tokenProgram": TOKEN_2022_PROGRAM_ID,
        "mint": KINS_TOKEN_MINT,
        "treasuryWallet": KINS_TREASURY_WALLET,
        "treasuryReady": treasury_ready,
        "createTreasuryAtaIfNeeded": not treasury_ready,
    }


def ensure_kins_payments_schema(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kins_payments (
            payment_id TEXT PRIMARY KEY,
            telegram_id TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            purpose TEXT NOT NULL,
            amount_kins INTEGER NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending',
            tx_signature TEXT,
            created_at INTEGER NOT NULL,
            confirmed_at INTEGER,
            expires_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_kins_payments_tx
        ON kins_payments(tx_signature)
        WHERE tx_signature IS NOT NULL
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kins_payments_user "
        "ON kins_payments(telegram_id, created_at)"
    )


def ensure_kins_withdrawals_schema(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kins_withdrawals (
            withdrawal_id TEXT PRIMARY KEY,
            telegram_id TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            amount_kins INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kins_withdrawals_user "
        "ON kins_withdrawals(telegram_id, created_at)"
    )


def create_withdrawal(
    conn: Any,
    *,
    telegram_id: str,
    wallet_address: str,
    amount_kins: int,
) -> tuple[bool, str, dict[str, Any]]:
    ensure_kins_withdrawals_schema(conn)
    amount_kins = int(amount_kins)
    if amount_kins < MIN_WITHDRAW_KINS or amount_kins > MAX_DEPOSIT_KINS:
        return (
            False,
            f"Enter between {MIN_WITHDRAW_KINS:,} and {MAX_DEPOSIT_KINS:,} CHIPS.",
            {},
        )

    row = conn.execute(
        "SELECT balance FROM users WHERE telegram_id = ?",
        (telegram_id,),
    ).fetchone()
    if row is None:
        return False, "User not found.", {}

    balance = int(row["balance"] or 0)
    if amount_kins > balance:
        return False, f"Not enough CHIPS — you have {balance:,}.", {}

    now = int(time.time())
    withdrawal_id = secrets.token_hex(16)
    conn.execute(
        """
        UPDATE users
        SET balance = balance - ?, updated_at = ?
        WHERE telegram_id = ?
        """,
        (amount_kins, now, telegram_id),
    )
    conn.execute(
        """
        INSERT INTO kins_withdrawals (
            withdrawal_id, telegram_id, wallet_address, amount_kins, status, created_at
        )
        VALUES (?, ?, ?, ?, 'pending', ?)
        """,
        (withdrawal_id, telegram_id, wallet_address, amount_kins, now),
    )
    return (
        True,
        "",
        {
            "withdrawalId": withdrawal_id,
            "amountKins": amount_kins,
            "balance": balance - amount_kins,
            "walletAddress": wallet_address,
        },
    )


def is_wallet_user_id(telegram_id: str) -> bool:
    return str(telegram_id or "").startswith("wallet:")


def create_payment_intent(
    conn: Any,
    *,
    telegram_id: str,
    wallet_address: str,
    purpose: str,
    amount_kins: int,
    payload: Optional[dict] = None,
) -> dict[str, Any]:
    ensure_kins_payments_schema(conn)
    amount_kins = int(amount_kins)
    if amount_kins <= 0:
        raise ValueError("Payment amount must be positive.")

    now = int(time.time())
    payment_id = secrets.token_hex(16)
    conn.execute(
        """
        INSERT INTO kins_payments (
            payment_id, telegram_id, wallet_address, purpose, amount_kins,
            payload_json, status, created_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        """,
        (
            payment_id,
            telegram_id,
            wallet_address,
            purpose,
            amount_kins,
            json.dumps(payload or {}),
            now,
            now + PAYMENT_INTENT_TTL_SEC,
        ),
    )
    return {
        "paymentId": payment_id,
        "purpose": purpose,
        "amountKins": amount_kins,
        "treasuryWallet": KINS_TREASURY_WALLET,
        "mint": KINS_TOKEN_MINT,
        "expiresAt": now + PAYMENT_INTENT_TTL_SEC,
        "transfer": build_transfer_plan(amount_kins),
    }


def _payment_row(conn: Any, payment_id: str) -> Optional[Any]:
    ensure_kins_payments_schema(conn)
    return conn.execute(
        "SELECT * FROM kins_payments WHERE payment_id = ?",
        (payment_id,),
    ).fetchone()


def _tx_already_used(conn: Any, tx_signature: str) -> bool:
    row = conn.execute(
        "SELECT payment_id FROM kins_payments WHERE tx_signature = ?",
        (tx_signature,),
    ).fetchone()
    return row is not None


def _token_delta_for_owner(
    meta: dict,
    owner_wallet: str,
    mint: str,
) -> float:
    pre_map: dict[tuple[str, str], float] = {}
    post_map: dict[tuple[str, str], float] = {}

    for bucket, target in ((meta.get("preTokenBalances") or [], pre_map), (meta.get("postTokenBalances") or [], post_map)):
        for entry in bucket:
            owner = entry.get("owner")
            entry_mint = entry.get("mint")
            if owner != owner_wallet or entry_mint != mint:
                continue
            ui = entry.get("uiTokenAmount") or {}
            target[(owner, entry_mint)] = float(ui.get("uiAmount") or 0)

    return post_map.get((owner_wallet, mint), 0.0) - pre_map.get((owner_wallet, mint), 0.0)


def verify_kins_transfer(
    tx_signature: str,
    *,
    sender_wallet: str,
    treasury_wallet: str,
    mint: str,
    min_amount_kins: int,
) -> tuple[bool, str, float]:
    tx_signature = (tx_signature or "").strip()
    if not tx_signature:
        return False, "Missing transaction signature.", 0.0

    try:
        result = _rpc(
            "getTransaction",
            [
                tx_signature,
                {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0},
            ],
        )
    except (RuntimeError, urllib.error.URLError, TimeoutError) as exc:
        return False, f"Could not load transaction ({exc}). Try again shortly.", 0.0

    if not result:
        return False, "Transaction not found yet. Wait a few seconds and retry.", 0.0

    meta = result.get("meta") or {}
    if meta.get("err"):
        return False, "Transaction failed on-chain.", 0.0

    received = _token_delta_for_owner(meta, treasury_wallet, mint)
    sent = -_token_delta_for_owner(meta, sender_wallet, mint)

    if received + 1e-9 < min_amount_kins:
        return False, f"Treasury received {received:.4f} $POKEQUEST — expected at least {min_amount_kins}.", 0.0

    if sent + 1e-9 < min_amount_kins:
        return False, "Sender wallet did not transfer the required $POKEQUEST.", 0.0

    return True, "", min(received, sent)


def confirm_payment(
    conn: Any,
    *,
    payment_id: str,
    tx_signature: str,
    expected_wallet: str,
) -> tuple[bool, str, Optional[dict]]:
    row = _payment_row(conn, payment_id)
    if not row:
        return False, "Payment intent not found.", None

    status = row["status"]
    if status == "confirmed":
        if row["tx_signature"] == tx_signature:
            return True, "", json.loads(row["payload_json"] or "{}")
        return False, "Payment already confirmed with a different transaction.", None

    now = int(time.time())
    if status != "pending":
        return False, "Payment intent is no longer valid.", None
    if now > int(row["expires_at"]):
        conn.execute(
            "UPDATE kins_payments SET status = 'expired' WHERE payment_id = ?",
            (payment_id,),
        )
        return False, "Payment intent expired. Start again.", None

    wallet_address = row["wallet_address"]
    if wallet_address != expected_wallet:
        return False, "Wallet does not match this payment.", None

    tx_signature = tx_signature.strip()
    if _tx_already_used(conn, tx_signature):
        return False, "Transaction already used.", None

    ok, err, _amount = verify_kins_transfer(
        tx_signature,
        sender_wallet=wallet_address,
        treasury_wallet=KINS_TREASURY_WALLET,
        mint=KINS_TOKEN_MINT,
        min_amount_kins=int(row["amount_kins"]),
    )
    if not ok:
        return False, err, None

    conn.execute(
        """
        UPDATE kins_payments
        SET status = 'confirmed', tx_signature = ?, confirmed_at = ?
        WHERE payment_id = ?
        """,
        (tx_signature, now, payment_id),
    )
    payload = json.loads(row["payload_json"] or "{}")
    return True, "", {
        "purpose": row["purpose"],
        "amount_kins": int(row["amount_kins"]),
        "telegram_id": row["telegram_id"],
        "payload": payload,
        "tx_signature": tx_signature,
    }
