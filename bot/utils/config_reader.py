from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from pydantic import BaseSettings, RedisDsn, SecretStr, validator

_BOT_ROOT = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BOT_ROOT.parent
_WEBP_ROOT = (
    _REPO_ROOT
    if (_REPO_ROOT / "app.py").is_file()
    else _REPO_ROOT / "webp"
)

load_dotenv(_REPO_ROOT / ".env")
load_dotenv(_WEBP_ROOT / ".env", override=False)
load_dotenv(_BOT_ROOT / ".env", override=False)


class Settings(BaseSettings):
    bot_token: SecretStr
    fsm_mode: str
    redis: Optional[RedisDsn]
    available_chat_ids: str
    # Loser is kicked + exclusive leaderboard only in these chats (not the main group).
    exclusive_chat_ids: str = ""
    # Play-money credited on first /start (new or web-only account with 0 balance)
    start_balance: int = 5000
    # When true, skip on-chain wallet instructions in /start copy
    test_mode: bool = True
    # Shared SQLite (webp users.db) + card catalog
    sqlite_db_path: str = str(_WEBP_ROOT / "users.db")
    poke_json_path: str = str(_WEBP_ROOT / "poke.json")
    min_vault_cards: int = 1
    # Telegram WebApp (opened from /start button)
    webapp_url: str = "http://localhost:5000/"
    # Flask / game-server (webp reads same keys from bot/.env)
    game_server_url: str = "http://127.0.0.1:3001"
    allowed_origins: str = "http://localhost:5000"
    # Comma-separated Telegram @usernames for hidden admin commands
    admin_usernames: str = "zaiing,xrosxy"
    # Optional SOCKS/HTTP proxy when api.telegram.org is blocked (requires aiohttp-socks)
    telegram_proxy: str = ""
    # Optional local Bot API server base URL (e.g. http://127.0.0.1:8081)
    telegram_api_base: str = ""

    @validator("fsm_mode")
    def fsm_type_check(cls, v):
        if v not in ("memory", "redis"):
            raise ValueError("Incorrect fsm_mode. Must be one of: memory, redis")
        return v

    @validator("redis")
    def skip_validating_redis(cls, v, values):
        if values["fsm_mode"] == "redis" and v is None:
            raise ValueError("Redis config is missing, though fsm_type is 'redis'")
        return v

    class Config:
        env_file = Path(__file__).parent.parent / ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False


config = Settings()


def _chat_ids(raw: str) -> set[str]:
    return {part.strip() for part in raw.split(",") if part.strip()}


def is_battle_chat_allowed(chat_id: int) -> bool:
    """Main group(s) + optional exclusive arena group(s)."""
    allowed = _chat_ids(config.available_chat_ids) | _chat_ids(config.exclusive_chat_ids)
    return str(chat_id) in allowed


def is_exclusive_battle_chat(chat_id: int) -> bool:
    """Exclusive arena: kick loser and track exclusive wins."""
    return str(chat_id) in _chat_ids(config.exclusive_chat_ids)


def is_admin_user(username: Optional[str]) -> bool:
    allowed = {
        name.strip().lstrip("@").lower()
        for name in config.admin_usernames.split(",")
        if name.strip()
    }
    return (username or "").strip().lstrip("@").lower() in allowed
