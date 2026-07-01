"""Env-based settings — no pydantic (works with system Python 3.9+ and Railway)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

_BOT_ROOT = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BOT_ROOT.parent
_WEBP_ROOT = (
    _REPO_ROOT
    if (_REPO_ROOT / "app.py").is_file()
    else _REPO_ROOT / "webp"
)

# Monorepo root .env (saipoke/.env) then webp/.env then bot/.env
load_dotenv(_REPO_ROOT.parent / ".env")
load_dotenv(_REPO_ROOT / ".env", override=False)
load_dotenv(_WEBP_ROOT / ".env", override=False)
load_dotenv(_BOT_ROOT / ".env", override=False)


class SecretStr:
    def __init__(self, value: str):
        self._value = value

    def get_secret_value(self) -> str:
        return self._value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    return int(raw)


class Settings:
    def __init__(self) -> None:
        token = os.getenv("BOT_TOKEN", "").strip()
        if not token:
            raise RuntimeError("BOT_TOKEN is not set (check .env or environment)")
        self.bot_token = SecretStr(token)
        self.fsm_mode = os.getenv("FSM_MODE", "memory").strip()
        if self.fsm_mode not in ("memory", "redis"):
            raise ValueError("FSM_MODE must be 'memory' or 'redis'")
        self.redis = os.getenv("REDIS") or None
        if self.fsm_mode == "redis" and not self.redis:
            raise ValueError("REDIS is required when FSM_MODE=redis")
        self.available_chat_ids = os.getenv("AVAILABLE_CHAT_IDS", "").strip()
        self.exclusive_chat_ids = os.getenv("EXCLUSIVE_CHAT_IDS", "").strip()
        self.start_balance = _env_int("START_BALANCE", 0)
        self.test_mode = _env_bool("TEST_MODE", True)
        self.sqlite_db_path = os.getenv(
            "SQLITE_DB_PATH", str(_WEBP_ROOT / "users.db")
        )
        self.poke_json_path = os.getenv(
            "POKE_JSON_PATH", str(_WEBP_ROOT / "poke.json")
        )
        self.min_vault_cards = _env_int("MIN_VAULT_CARDS", 1)
        self.webapp_url = os.getenv("WEBAPP_URL", "http://localhost:5000/")
        self.game_server_url = os.getenv("GAME_SERVER_URL", "http://127.0.0.1:3001")
        self.allowed_origins = os.getenv(
            "ALLOWED_ORIGINS", "http://localhost:5000"
        )
        self.admin_usernames = os.getenv("ADMIN_USERNAMES", "zaiing,xrosxy")
        self.telegram_proxy = os.getenv("TELEGRAM_PROXY", "").strip()
        self.telegram_api_base = os.getenv("TELEGRAM_API_BASE", "").strip()


config = Settings()


def _chat_ids(raw: str) -> set[str]:
    return {part.strip() for part in raw.split(",") if part.strip()}


def is_battle_chat_allowed(chat_id: int) -> bool:
    allowed = _chat_ids(config.available_chat_ids) | _chat_ids(
        config.exclusive_chat_ids
    )
    return str(chat_id) in allowed


def is_exclusive_battle_chat(chat_id: int) -> bool:
    return str(chat_id) in _chat_ids(config.exclusive_chat_ids)


def is_admin_user(username: Optional[str]) -> bool:
    allowed = {
        name.strip().lstrip("@").lower()
        for name in config.admin_usernames.split(",")
        if name.strip()
    }
    return (username or "").strip().lstrip("@").lower() in allowed
