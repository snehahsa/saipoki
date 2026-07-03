"""Solana wallet challenge + signature verification for web play."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

import base58
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from db.connection import db_connection

KINS_TOKEN_MINT = os.getenv(
    "KINS_TOKEN_MINT",
    "JDvEzW35wibMa11QcDSPGZYXdWp7FCaCKa11peVppoke",
).strip()

SOLANA_RPC_URL = os.getenv(
    "SOLANA_RPC_URL",
    "https://solana-rpc.publicnode.com",
).strip()

SOLANA_RPC_FALLBACKS = (
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com",
)


def solana_rpc_urls() -> list[str]:
    primary = SOLANA_RPC_URL
    extra = os.getenv("SOLANA_RPC_FALLBACKS", "")
    ordered: list[str] = []
    for candidate in [primary, *extra.split(","), *SOLANA_RPC_FALLBACKS]:
        url = (candidate or "").strip()
        if url and url not in ordered:
            ordered.append(url)
    return ordered

CHALLENGE_TTL_SEC = int(os.getenv("WALLET_CHALLENGE_TTL_SEC", "600"))
SESSION_TTL_SEC = int(os.getenv("WALLET_SESSION_TTL_SEC", str(24 * 3600)))
MIN_TOKEN_UI_AMOUNT = float(os.getenv("WALLET_MIN_TOKEN_UI_AMOUNT", "1000"))

# 0 = no wallet connect / token gating (guest play with free Chips); 1 = require wallet
WALLET_CHECK = int(os.getenv("WALLET_CHECK", "0"))
GUEST_STARTING_BALANCE = int(os.getenv("GUEST_STARTING_BALANCE", "50000"))

_GUEST_ID_RE = re.compile(r"^guest:[a-f0-9\-]{8,}$", re.IGNORECASE)

_lock = threading.Lock()
_sessions: dict[str, dict[str, Any]] = {}

_SESSION_SECRET = (
    os.getenv("WALLET_SESSION_SECRET")
    or os.getenv("BOT_TOKEN")
    or "pokequest-wallet-dev-secret"
)


def _utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def ensure_wallet_auth_schema(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS wallet_challenges (
            challenge_id TEXT PRIMARY KEY,
            message TEXT NOT NULL,
            expires_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_wallet_challenges_expires
        ON wallet_challenges (expires_at)
        """
    )


def _purge_expired_challenges(conn) -> None:
    conn.execute(
        "DELETE FROM wallet_challenges WHERE expires_at <= ?",
        (time.time(),),
    )


def _purge_expired_sessions() -> None:
    now = time.time()
    expired = [key for key, row in _sessions.items() if row.get("expires_at", 0) <= now]
    for key in expired:
        _sessions.pop(key, None)


def wallet_telegram_id(wallet_address: str) -> str:
    return f"wallet:{wallet_address}"


def wallet_payments_enabled() -> bool:
    return WALLET_CHECK != 0


def is_guest_user_id(telegram_id: str) -> bool:
    return bool(_GUEST_ID_RE.match(str(telegram_id or "")))


def resolve_guest_user(data: Optional[dict] = None) -> Optional[dict[str, Any]]:
    if WALLET_CHECK:
        return None
    payload = data or {}
    guest_id = str(payload.get("guestId") or "").strip()
    if not _GUEST_ID_RE.match(guest_id):
        return None
    short = f"{guest_id[6:10]}…{guest_id[-4:]}"
    return {
        "id": guest_id,
        "username": "",
        "first_name": short,
        "last_name": "",
    }


def create_wallet_challenge() -> dict[str, Any]:
    challenge_id = secrets.token_hex(16)
    issued = _utc_iso()
    message = (
        "Sign in to pokequest\n"
        f"Challenge: {challenge_id}\n"
        f"Issued: {issued}"
    )
    expires_at = time.time() + CHALLENGE_TTL_SEC
    with db_connection() as conn:
        ensure_wallet_auth_schema(conn)
        _purge_expired_challenges(conn)
        conn.execute(
            """
            INSERT INTO wallet_challenges (challenge_id, message, expires_at)
            VALUES (?, ?, ?)
            """,
            (challenge_id, message, expires_at),
        )
    return {
        "ok": True,
        "challengeId": challenge_id,
        "message": message,
    }


def _challenge_row(challenge_id: str) -> Optional[dict[str, Any]]:
    with db_connection() as conn:
        ensure_wallet_auth_schema(conn)
        _purge_expired_challenges(conn)
        row = conn.execute(
            """
            SELECT message, expires_at
            FROM wallet_challenges
            WHERE challenge_id = ?
            """,
            (challenge_id,),
        ).fetchone()
        if not row:
            return None
        if float(row["expires_at"]) <= time.time():
            conn.execute(
                "DELETE FROM wallet_challenges WHERE challenge_id = ?",
                (challenge_id,),
            )
            return None
        return {"message": row["message"], "expires_at": float(row["expires_at"])}


def _consume_challenge(challenge_id: str) -> Optional[dict[str, Any]]:
    row = _challenge_row(challenge_id)
    if not row:
        return None
    with db_connection() as conn:
        conn.execute(
            "DELETE FROM wallet_challenges WHERE challenge_id = ?",
            (challenge_id,),
        )
    return row


def _solana_offchain_payload(message: str) -> bytes:
    message_bytes = message.encode("utf-8")
    prefix = b"\xffsolana offchain"
    length = len(message_bytes).to_bytes(4, "little")
    return prefix + length + message_bytes


def verify_solana_signature(wallet_address: str, message: str, signature_b64: str) -> bool:
    try:
        public_key = base58.b58decode(wallet_address)
        signature = base64.b64decode(signature_b64)
        if len(public_key) != 32:
            return False
        verify_key = VerifyKey(public_key)
        payloads = (
            message.encode("utf-8"),
            _solana_offchain_payload(message),
        )
        for payload in payloads:
            try:
                verify_key.verify(payload, signature)
                return True
            except BadSignatureError:
                continue
        return False
    except (ValueError, TypeError):
        return False


def wallet_kins_balance(wallet_address: str) -> tuple[float, str]:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTokenAccountsByOwner",
        "params": [
            wallet_address,
            {"mint": KINS_TOKEN_MINT},
            {"encoding": "jsonParsed"},
        ],
    }
    req = urllib.request.Request(
        SOLANA_RPC_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        return 0.0, f"Could not verify $POKEQUEST balance ({exc}). Try again."

    accounts = body.get("result", {}).get("value") or []
    total = 0.0
    for entry in accounts:
        try:
            amount = (
                entry["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmount"]
            )
            total += float(amount or 0)
        except (KeyError, TypeError, ValueError):
            continue
    return total, ""


def wallet_holds_kins_token(wallet_address: str) -> tuple[bool, str]:
    total, err = wallet_kins_balance(wallet_address)
    if err:
        return False, err
    if total >= MIN_TOKEN_UI_AMOUNT:
        return True, ""
    min_display = int(MIN_TOKEN_UI_AMOUNT) if MIN_TOKEN_UI_AMOUNT == int(MIN_TOKEN_UI_AMOUNT) else MIN_TOKEN_UI_AMOUNT
    return False, f"Wallet must hold at least {min_display:,} $POKEQUEST to enter the realm."


def issue_wallet_session(wallet_address: str) -> str:
    issued_at = int(time.time())
    nonce = secrets.token_hex(8)
    payload = f"{wallet_address}:{issued_at}:{nonce}"
    sig = hmac.new(
        _SESSION_SECRET.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    token = base64.urlsafe_b64encode(f"{payload}:{sig}".encode("utf-8")).decode("ascii")
    with _lock:
        _purge_expired_sessions()
        _sessions[token] = {
            "wallet": wallet_address,
            "issued_at": issued_at,
            "expires_at": issued_at + SESSION_TTL_SEC,
        }
    return token


def verify_wallet_session(token: str) -> Optional[str]:
    if not token:
        return None

    with _lock:
        _purge_expired_sessions()
        row = _sessions.get(token)
        if row and row.get("expires_at", 0) > time.time():
            return row.get("wallet")

    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
        payload, sig = raw.rsplit(":", 1)
        wallet_address, issued_at_raw, _nonce = payload.split(":", 2)
        expected = hmac.new(
            _SESSION_SECRET.encode("utf-8"),
            payload.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None
        issued_at = int(issued_at_raw)
        if issued_at + SESSION_TTL_SEC < time.time():
            return None
        return wallet_address
    except (ValueError, TypeError):
        return None


def verify_wallet_login(
    wallet_address: str,
    challenge_id: str,
    signature_b64: str,
    *,
    require_token: bool = True,
) -> tuple[bool, str, Optional[str]]:
    wallet_address = (wallet_address or "").strip()
    challenge_id = (challenge_id or "").strip()
    if not wallet_address or not challenge_id or not signature_b64:
        return False, "Missing wallet proof.", None

    row = _challenge_row(challenge_id)
    if not row:
        return False, "Challenge expired. Connect wallet again.", None

    message = row.get("message") or ""
    if not verify_solana_signature(wallet_address, message, signature_b64):
        return False, "Signature verification failed. Try connecting again.", None

    # Token gate (min $POKEQUEST hold) — disabled for now; uncomment to re-enable at launch.
    # if require_token:
    #     ok, err = wallet_holds_kins_token(wallet_address)
    #     if not ok:
    #         return False, err, None

    _consume_challenge(challenge_id)
    return True, "", issue_wallet_session(wallet_address)


def clear_wallet_sessions() -> None:
    with _lock:
        _sessions.clear()
    with db_connection() as conn:
        ensure_wallet_auth_schema(conn)
        conn.execute("DELETE FROM wallet_challenges")
