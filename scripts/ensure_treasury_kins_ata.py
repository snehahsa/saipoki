#!/usr/bin/env python3
"""Check treasury $KINS token account status."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from game_wallet_config import KINS_TREASURY_WALLET, POKEQUEST_MINT, treasury_signer_path
from kins_payments import TOKEN_2022_PROGRAM_ID, treasury_kins_ata_exists


def main() -> int:
    print(f"Treasury wallet: {KINS_TREASURY_WALLET}")
    print(f"KINS mint:       {POKEQUEST_MINT}")
    print(f"Signer file:     {treasury_signer_path()}")
    print(f"Token program:   {TOKEN_2022_PROGRAM_ID}")

    if treasury_kins_ata_exists():
        print("\nOK — treasury $KINS account exists.")
        print("User payments send only $KINS (plus the normal Solana network fee).")
        return 0

    print("\nTreasury $KINS account is NOT created yet.")
    print("Deposits still work: the first payer creates it automatically (~0.002 SOL one-time).")
    print("\nOptional — create it yourself from the treasury wallet so players never pay rent:")
    print(
        "\n  spl-token create-account "
        f"{POKEQUEST_MINT} "
        f"--owner {KINS_TREASURY_WALLET} "
        f"--program-id {TOKEN_2022_PROGRAM_ID} "
        f"--fee-payer {treasury_signer_path()}"
    )
    print(
        "\nOr in Phantom/Solflare: connect the treasury wallet, add $KINS, "
        "and create its token receive account (one-time ~0.002 SOL from treasury)."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
