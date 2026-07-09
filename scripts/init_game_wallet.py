#!/usr/bin/env python3
"""Create data/game_wallet.json with a fresh Solana treasury keypair."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import base58
from nacl.signing import SigningKey

from db.paths import webp_root


def main() -> None:
    path = webp_root() / "data" / "game_wallet.json"
    if path.is_file():
        print(f"Already exists: {path}")
        with path.open(encoding="utf-8") as fh:
            existing = json.load(fh)
        print(f"gameWallet: {existing.get('gameWallet')}")
        return

    sk = SigningKey.generate()
    pk_bytes = bytes(sk.verify_key)
    pubkey = base58.b58encode(pk_bytes).decode()
    keypair = list(bytes(sk) + pk_bytes)

    config = {
        "gameWallet": pubkey,
        "tokenMint": "JDvEzW35wibMa11QcDSPGZYXdWp7FCaCKa11peVppoke",
        "keypair": keypair,
        "minDeposit": 1,
        "minWithdraw": 5000,
        "maxWithdraw": 1000000,
        "withdrawPollSec": 15,
        "broadcastStaleSec": 1800,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(f"Created {path}")
    print(f"gameWallet: {pubkey}")


if __name__ == "__main__":
    main()
