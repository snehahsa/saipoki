#!/usr/bin/env python3
"""Check treasury $KINS token account status (one-time setup before user deposits)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from kins_payments import (
    KINS_TOKEN_MINT,
    KINS_TREASURY_WALLET,
    TOKEN_2022_PROGRAM_ID,
    treasury_kins_ata_exists,
)


def main() -> int:
    print(f"Treasury wallet: {KINS_TREASURY_WALLET}")
    print(f"KINS mint:       {KINS_TOKEN_MINT}")
    print(f"Token program:   {TOKEN_2022_PROGRAM_ID}")

    if treasury_kins_ata_exists():
        print("\nOK — treasury $KINS account exists.")
        print("User payments send only $KINS (plus the normal Solana network fee).")
        return 0

    print("\nTreasury $KINS account is NOT created yet.")
    print("Create it once from the treasury wallet before accepting deposits:")
    print(
        "\n  spl-token create-account "
        f"{KINS_TOKEN_MINT} "
        f"--owner {KINS_TREASURY_WALLET} "
        f"--program-id {TOKEN_2022_PROGRAM_ID} "
        "--fee-payer <treasury-keypair.json>"
    )
    print(
        "\nOr in Phantom/Solflare: connect the treasury wallet, add $KINS, "
        "and create its token receive account (one-time ~0.002 SOL from treasury)."
    )
    print("\nUntil this exists, deposits are blocked so players are not charged SOL rent.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
