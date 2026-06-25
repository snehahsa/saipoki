"""Solana wallet challenge + signature verification for web play."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
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

KINS_TOKEN_MINT = os.getenv(
    "KINS_TOKEN_MINT",
    "Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump",
).strip()

SOLANA_RPC_URL = os.getenv(
    "SOLANA_RPC_URL",
    "https://api.mainnet-beta.solana.com",
).strip()

CHALLENGE_TTL_SEC = int(os.getenv("WALLET_CHALLENGE_TTL_SEC", "300"))
SESSION_TTL_SEC = int(os.getenv("WALLET_SESSION_TTL_SEC", str(24 * 3600)))
MIN_TOKEN_UI_AMOUNT = float(os.getenv("WALLET_MIN_TOKEN_UI_AMOUNT", "0"))

_lock = threading.Lock()
_challenges: dict[str, dict[str, Any]] = {}
_sessions: dict[str, dict[str, Any]] = {}

_SESSION_SECRET = (
    os.getenv("WALLET_SESSION_SECRET")
    or os.getenv("BOT_TOKEN")
    or "pokequest-wallet-dev-secret"
)


def _utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _purge_expired() -> None:
    now = time.time()
    for store in (_challenges, _sessions):
        expired = [key for key, row in store.items() if row.get("expires_at", 0) <= now]
        for key in expired:
            store.pop(key, None)


def wallet_telegram_id(wallet_address: str) -> str:
    return f"wallet:{wallet_address}"


def create_wallet_challenge() -> dict[str, Any]:
    with _lock:
        _purge_expired()
        challenge_id = secrets.token_hex(16)
        issued = _utc_iso()
        message = (
            "Sign in to pokequest\n"
            f"Challenge: {challenge_id}\n"
            f"Issued: {issued}"
        )
        _challenges[challenge_id] = {
            "message": message,
            "issued": issued,
            "expires_at": time.time() + CHALLENGE_TTL_SEC,
        }
        return {
            "ok": True,
            "challengeId": challenge_id,
            "message": message,
        }


def _challenge_row(challenge_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        _purge_expired()
        return _challenges.get(challenge_id)


def _consume_challenge(challenge_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        _purge_expired()
        return _challenges.pop(challenge_id, None)


def verify_solana_signature(wallet_address: str, message: str, signature_b64: str) -> bool:
    try:
        public_key = base58.b58decode(wallet_address)
        signature = base64.b64decode(signature_b64)
        if len(public_key) != 32:
            return False
        verify_key = VerifyKey(public_key)
        verify_key.verify(message.encode("utf-8"), signature)
        return True
    except (BadSignatureError, ValueError, TypeError):
        return False


def wallet_holds_kins_token(wallet_address: str) -> tuple[bool, str]:
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
        return False, f"Could not verify $KINS balance ({exc}). Try again."

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

    if total > MIN_TOKEN_UI_AMOUNT:
        return True, ""
    return False, "Wallet must hold $KINS to enter the realm."


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
        _purge_expired()
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
        _purge_expired()
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
        return False, "Signature verification failed.", None

    if require_token:
        ok, err = wallet_holds_kins_token(wallet_address)
        if not ok:
            return False, err, None

    _consume_challenge(challenge_id)
    return True, "", issue_wallet_session(wallet_address)
