"""Game treasury wallet — loaded from data/game_wallet.json (no .env required)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from db.paths import webp_root

CONFIG_REL_PATH = Path("data") / "game_wallet.json"
SIGNER_REL_PATH = Path("data") / "treasury_signer.json"

DEFAULT_TOKEN_MINT = "JDvEzW35wibMa11QcDSPGZYXdWp7FCaCKa11peVppoke"


def config_path() -> Path:
    return webp_root() / CONFIG_REL_PATH


@lru_cache(maxsize=1)
def load_game_wallet_config() -> dict[str, Any]:
    path = config_path()
    if not path.is_file():
        raise FileNotFoundError(
            f"Missing {CONFIG_REL_PATH}. Run: python3 scripts/init_game_wallet.py"
        )
    with path.open(encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{CONFIG_REL_PATH} must be a JSON object.")

    game_wallet = str(data.get("gameWallet") or "").strip()
    token_mint = str(data.get("tokenMint") or DEFAULT_TOKEN_MINT).strip()
    keypair = data.get("keypair")
    if not game_wallet:
        raise ValueError(f"{CONFIG_REL_PATH} missing gameWallet.")
    if not isinstance(keypair, list) or len(keypair) != 64:
        raise ValueError(f"{CONFIG_REL_PATH} missing 64-byte keypair array.")

    return {
        "gameWallet": game_wallet,
        "tokenMint": token_mint,
        "keypair": [int(b) for b in keypair],
        "minDeposit": int(data.get("minDeposit", 1)),
        "minWithdraw": int(data.get("minWithdraw", 5000)),
        "maxWithdraw": int(data.get("maxWithdraw", 1000000)),
        "withdrawPollSec": int(data.get("withdrawPollSec", 15)),
        "broadcastStaleSec": int(data.get("broadcastStaleSec", 1800)),
    }


def reload_game_wallet_config() -> dict[str, Any]:
    load_game_wallet_config.cache_clear()
    treasury_signer_path.cache_clear()
    return load_game_wallet_config()


_cfg = load_game_wallet_config()

GAME_WALLET = _cfg["gameWallet"]
POKEQUEST_MINT = _cfg["tokenMint"]
KINS_TREASURY_WALLET = GAME_WALLET  # legacy alias used across the app

MIN_DEPOSIT_CHIPS = _cfg["minDeposit"]
MIN_WITHDRAW_CHIPS = _cfg["minWithdraw"]
MAX_WITHDRAW_CHIPS = _cfg["maxWithdraw"]
WITHDRAW_POLL_SEC = _cfg["withdrawPollSec"]
BROADCAST_STALE_SEC = _cfg["broadcastStaleSec"]


@lru_cache(maxsize=1)
def treasury_signer_path() -> Path:
    """Solana CLI keypair file derived from game_wallet.json."""
    cfg = load_game_wallet_config()
    path = webp_root() / SIGNER_REL_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(cfg["keypair"])
    if not path.exists() or path.read_text(encoding="utf-8") != content:
        path.write_text(content, encoding="utf-8")
    return path
