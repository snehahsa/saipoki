#!/usr/bin/env python3
"""Process pending $POKEQUEST withdrawals (run via cron or Railway worker).

Reads treasury keypair from data/game_wallet.json — no .env required.
Requires spl-token CLI on the host.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.connection import db_connection, init_db
from game_wallet_config import (
    BROADCAST_STALE_SEC,
    POKEQUEST_MINT,
    WITHDRAW_POLL_SEC,
    treasury_signer_path,
)
from wallet_ledger import (
    list_pending_withdrawals,
    list_stale_broadcasting_withdrawals,
    mark_withdrawal_broadcasting,
    mark_withdrawal_confirmed,
    refund_failed_withdrawal,
)
from wallet_auth import SOLANA_RPC_URL


def _send_via_spl_token(destination: str, amount_chips: int) -> str:
    keypair = treasury_signer_path()
    cmd = [
        "spl-token",
        "transfer",
        POKEQUEST_MINT,
        str(int(amount_chips)),
        destination,
        "--owner",
        str(keypair),
        "--fee-payer",
        str(keypair),
        "-u",
        SOLANA_RPC_URL,
        "--allow-unfunded-recipient",
        "--fund-recipient",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=120)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "spl-token failed").strip()
        raise RuntimeError(err[:500])

    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if len(line) >= 32 and " " not in line:
            return line
    raise RuntimeError("spl-token did not return a transaction signature.")


def _refund_stale_broadcasting() -> int:
    refunded = 0
    with db_connection() as conn:
        stale = list_stale_broadcasting_withdrawals(conn, stale_sec=BROADCAST_STALE_SEC)
        for item in stale:
            wid = int(item["id"])
            if refund_failed_withdrawal(
                conn,
                wid,
                error_message=(
                    "Broadcast timed out without confirmation. "
                    "CHIPS refunded — contact support if tokens were sent."
                ),
            ):
                print(f"withdrawal {wid} stale broadcast refunded", file=sys.stderr)
                refunded += 1
    return refunded


def process_once() -> int:
    init_db()
    _refund_stale_broadcasting()

    with db_connection() as conn:
        pending = list_pending_withdrawals(conn, limit=10)

    processed = 0
    for item in pending:
        wid = int(item["id"])
        dest = str(item["destination_wallet"])
        chips = int(item["amount_chips"] or 0)

        with db_connection() as conn:
            if not mark_withdrawal_broadcasting(conn, wid):
                continue

        try:
            sig = _send_via_spl_token(dest, chips)
        except Exception as exc:
            with db_connection() as conn:
                refund_failed_withdrawal(conn, wid, error_message=str(exc))
            print(f"withdrawal {wid} failed: {exc}", file=sys.stderr)
            continue

        with db_connection() as conn:
            mark_withdrawal_confirmed(conn, wid, sig)
        print(f"withdrawal {wid} confirmed sig={sig}")
        processed += 1
    return processed


def main() -> None:
    once = "--once" in sys.argv
    interval = max(5, WITHDRAW_POLL_SEC)
    if once:
        n = process_once()
        print(f"processed {n} withdrawal(s)")
        return
    while True:
        try:
            process_once()
        except Exception as exc:
            print(f"worker error: {exc}", file=sys.stderr)
        time.sleep(interval)


if __name__ == "__main__":
    main()
