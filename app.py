import gzip
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qsl

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, redirect, render_template, request, send_from_directory

from flow_catalog import (
    HOLD_ITEMS,
    HOLD_ITEM_IDS,
    hold_catalog_for_client,
    hold_grant_allowed,
    hold_item_client_meta,
    ui_unlocks_for_client,
)
from fishing_catalog import fishing_catalog_for_client
from fishing_engine import complete_fishing_cast, fishing_progress_public, fishing_state_for_user, start_fishing_cast
from gear_catalog import (
    GEAR_ITEM_IDS,
    GEAR_SLOT_COUNT,
    gear_catalog_for_client,
    gear_item_client_meta,
    grant_gear_to_slots,
    normalize_gear_slots,
    remove_gear_from_slots,
)
from poke_registry import (
    add_card_to_vault,
    card_client_item,
    load_card_catalog,
    parse_vault,
    vault_card_ids,
)
from quests_catalog import QUEST_CATALOG, QUEST_IDS, QUEST_STEP_IDS, STEP_TO_QUEST
from quest_engine import (
    backfill_quest_triggers,
    complete_quest_step as engine_complete_quest_step,
    parse_quest_progress,
)
from wallet_auth import (
    KINS_TOKEN_MINT,
    MIN_TOKEN_UI_AMOUNT,
    SOLANA_RPC_URL,
    create_wallet_challenge,
    issue_wallet_session,
    verify_wallet_login,
    verify_wallet_session,
    wallet_telegram_id,
    clear_wallet_sessions,
)
from kins_payments import (
    KINS_TREASURY_WALLET,
    MAX_DEPOSIT_KINS,
    MIN_DEPOSIT_KINS,
    MIN_WITHDRAW_KINS,
    TOKEN_2022_PROGRAM_ID,
    confirm_payment,
    create_payment_intent,
    create_withdrawal,
    get_latest_blockhash,
    get_mint_decimals,
    is_wallet_user_id,
    treasury_kins_ata_exists,
)
from avatar_economy import (
    DEFAULT_SKIN as AVATAR_DEFAULT_SKIN,
    STARTING_BALANCE,
    TEST_STARTING_BALANCE,
    VENDING_SPIN_FIRST_COST,
    VENDING_SPIN_REPEAT_COST,
    load_avatar_costs_from_map,
    owned_skins_json,
    parse_owned_skins,
    purchase_cost,
    skin_list_price,
    vending_spin_cost,
)
from npc_economy import grant_npc_balance
from leaderboard import build_leaderboard_payload
from trainer_stats import ensure_trainer_stats_schema, trainer_stats_row
from xp_levels import xp_config_for_client
from poketab_social import (
    ensure_schema as ensure_poketab_schema,
    get_thread,
    list_conversations,
    list_friends,
    list_incoming_requests,
    online_players_with_status,
    respond_friend_request,
    send_friend_request,
    send_message,
    summary as poketab_summary,
)
from poketab_battle import (
    battleable_opponents,
    cancel_invite,
    count_battle_alerts,
    eligible_battle_cards,
    ensure_schema as ensure_poketab_battle_schema,
    forfeit_active_battle_for_offline,
    get_status as poketab_battle_status,
    MAX_DAILY_BATTLES_PER_CARD,
    notify_battle_quests,
    perform_action as poketab_battle_action,
    respond_invite,
    send_challenge,
    set_team,
    _user_vault_ids,
)

_ROOT = Path(__file__).resolve().parent.parent
_ENV_ROOT = _ROOT / ".env"
_BOT_ENV = _ROOT / "bot" / ".env"
_WEBP_ENV = Path(__file__).resolve().parent / ".env"

load_dotenv(_ENV_ROOT)
load_dotenv(_BOT_ENV)
load_dotenv(_WEBP_ENV)  # optional local overrides

app = Flask(__name__)

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
TEST_PLAYER_TELEGRAM_ID = "999999001"
TEST_PLAYER_USER = {
    "id": int(TEST_PLAYER_TELEGRAM_ID),
    "first_name": "Test",
    "last_name": "Trainer",
    "username": "test_trainer",
}
TEST_PLAYER_HOLDS = ["bag", "card_vault"]
TEST_PLAYER_GEAR_SLOTS = [None, None, None]
TEST_QUERY_RESERVED = frozenset({"tgWebAppStartParam", "v", "_"})
def resolve_game_server_internal() -> str:
    """Game server URL for Flask → game proxy (Railway private or public)."""
    for key in ("GAME_SERVER_INTERNAL", "GAME_SERVER_URL", "GAME_PUBLIC_URL"):
        val = (os.getenv(key) or "").strip().rstrip("/")
        if val and "127.0.0.1" not in val and "localhost" not in val:
            return val
    host = (
        os.getenv("GAME_PRIVATE_DOMAIN")
        or os.getenv("GAME_RAILWAY_PRIVATE_DOMAIN")
        or ""
    ).strip()
    port = (os.getenv("GAME_PORT") or os.getenv("GAME_SERVICE_PORT") or "").strip()
    if host and port:
        return f"http://{host}:{port}"
    return "http://127.0.0.1:3001"


GAME_SERVER_INTERNAL = resolve_game_server_internal()


def resolve_game_socket_url() -> str:
    """Browser-facing socket.io URL. Must be reachable from clients (HTTPS public), not private Railway DNS."""
    for key in ("GAME_SOCKET_URL", "GAME_PUBLIC_URL"):
        val = (os.getenv(key) or "").strip().rstrip("/")
        if val:
            return val

    internal = GAME_SERVER_INTERNAL
    if internal.startswith("https://"):
        return internal
    # Local dev: browser connects to game server directly (avoids broken socket.io proxy).
    if internal.startswith("http://127.0.0.1:") or internal.startswith("http://localhost:"):
        return internal

    return ""


GAME_SOCKET_URL = resolve_game_socket_url()
if os.getenv("RAILWAY_ENVIRONMENT") and not GAME_SOCKET_URL:
    print(
        "WARNING: GAME_SOCKET_URL is not set. Multiplayer sockets will proxy through Flask and break.\n"
        "  Set GAME_SOCKET_URL=https://<your-game-service>.up.railway.app\n"
        "  or use GAME_SERVER_INTERNAL=https://... (public HTTPS) so it can be reused for sockets.",
        flush=True,
    )
if os.getenv("RAILWAY_ENVIRONMENT") and (
    "127.0.0.1" in GAME_SERVER_INTERNAL or "localhost" in GAME_SERVER_INTERNAL
):
    print(
        "WARNING: Game server URL is localhost on Railway. "
        "On web service set either:\n"
        "  GAME_SERVER_INTERNAL=http://${{game.RAILWAY_PRIVATE_DOMAIN}}:${{game.PORT}}\n"
        "  or GAME_PRIVATE_DOMAIN=${{game.RAILWAY_PRIVATE_DOMAIN}} and GAME_PORT=${{game.PORT}}",
        flush=True,
    )
PUBLIC_WEBAPP_URL = (os.getenv("WEBAPP_URL") or os.getenv("RAILWAY_PUBLIC_DOMAIN") or "").strip()
if PUBLIC_WEBAPP_URL and not PUBLIC_WEBAPP_URL.startswith("http"):
    PUBLIC_WEBAPP_URL = f"https://{PUBLIC_WEBAPP_URL}"
if PUBLIC_WEBAPP_URL and not PUBLIC_WEBAPP_URL.endswith("/"):
    PUBLIC_WEBAPP_URL = f"{PUBLIC_WEBAPP_URL}/"


def resolve_world_map_path() -> Path:
    root = Path(__file__).resolve().parent
    for candidate in (
        root / "data/defaultmap.json",
        root / "gather-clone/frontend/utils/defaultmap.json",
    ):
        if candidate.is_file():
            return candidate
    return root / "data/defaultmap.json"


WORLD_MAP_PATH = resolve_world_map_path()

SKINS = [f"{i:03d}" for i in range(1, 84)]
DEFAULT_SKIN = "009"
BAG_SLOT_COUNT = 8


def bag_items() -> list:
    bag_dir = Path(app.root_path) / "static/bag"
    items = []
    for filename in sorted(bag_dir.glob("card-*.*")):
        version = int(filename.stat().st_mtime)
        item_id = filename.stem
        display_name = item_id.replace("-", " ").title()
        src = f"/static/bag/{filename.name}?v={version}"
        items.append(
            {
                "id": item_id,
                "src": src,
                "name": display_name,
                "pickup_popup": {
                    "headline": "YOU GOT!",
                    "title": display_name,
                    "message": "A new PokéCard was added to your vault.",
                    "icon": f"/static/bag/{filename.name}",
                    "theme": "card",
                    "tag": "NEW CARD",
                },
            }
        )
    return items


POOL_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def pool_items() -> list:
    """Draw pool for vending machine — cards from poke.json (built via OCR on static/pool/)."""
    pool_dir = Path(app.root_path) / "static/pool"
    cards = load_card_catalog(Path(app.root_path) / "poke.json")
    items = []

    for card_id in sorted(cards.keys()):
        card = cards[card_id]
        image_name = card.get("image") or f"{card.get('slug', 'card')}.jpg"
        file_path = pool_dir / image_name
        if not file_path.is_file():
            continue
        version = int(file_path.stat().st_mtime)
        src = f"/static/pool/{image_name}?v={version}"
        items.append(
            card_client_item(
                card,
                src=src,
                pickup_message="A new PokéCard was dispensed from the machine.",
            )
        )
    return items


def card_catalog_for_client() -> dict:
    """Full catalog keyed by poke-NNN id — used to resolve vault entries on the client."""
    return {item["id"]: item for item in pool_items()}


def asset_version(relative_path: str) -> str:
    path = Path(app.root_path) / relative_path
    if path.exists():
        return str(int(path.stat().st_mtime))
    return "0"


def world_map_version() -> str:
    if WORLD_MAP_PATH.exists():
        return str(int(WORLD_MAP_PATH.stat().st_mtime))
    return "0"


def world_map_hash() -> str:
    if not WORLD_MAP_PATH.exists():
        return ""
    return hashlib.md5(WORLD_MAP_PATH.read_bytes()).hexdigest()


def get_db():
    from db.connection import get_db_connection

    return get_db_connection()


def init_db():
    from db.connection import init_db as _init_db

    _init_db()


def webapp_test_allowed() -> bool:
    flag = os.getenv("WEBAPP_ALLOW_TEST", os.getenv("TEST_MODE", "true"))
    return str(flag).lower() in ("1", "true", "yes", "on")


def normalize_test_slug(raw) -> str:
    if raw is None:
        return ""
    slug = str(raw).strip().lower()
    slug = "".join(ch for ch in slug if ch.isalnum() or ch in ("_", "-"))
    return slug[:24]


def test_display_name(slug: str) -> str:
    slug = normalize_test_slug(slug)
    if not slug:
        return "Test Trainer"
    if len(slug) == 1:
        return slug.upper()
    return slug[0].upper() + slug[1:]


def test_telegram_id_for_slug(slug: str) -> str:
    slug = normalize_test_slug(slug)
    if not slug:
        return TEST_PLAYER_TELEGRAM_ID
    digest = hashlib.sha256(slug.encode()).hexdigest()
    offset = int(digest[:8], 16) % 8998
    return str(999990002 + offset)


def ensure_test_player_profile(conn, telegram_id: str) -> None:
    """Persist holds, gear, and a starter vault card for URL test trainers."""
    row = conn.execute(
        "SELECT holds, gear_slots, vault FROM users WHERE telegram_id = ?",
        (telegram_id,),
    ).fetchone()
    if not row:
        return

    now = int(time.time())
    holds = list(TEST_PLAYER_HOLDS)
    holds_changed = parse_holds(row["holds"] if "holds" in row.keys() else None) != holds

    slots = parse_gear_slots(row["gear_slots"] if "gear_slots" in row.keys() else None)
    gear_changed = slots != normalize_gear_slots(TEST_PLAYER_GEAR_SLOTS)
    if gear_changed:
        slots = normalize_gear_slots(TEST_PLAYER_GEAR_SLOTS)

    vault = vault_for_user(row["vault"] if "vault" in row.keys() else None)
    vault_changed = False
    if len(vault_card_ids(vault)) < 1:
        starter_entries = test_starter_vault_entries()
        if starter_entries:
            vault = starter_entries
            vault_changed = True

    if not holds_changed and not gear_changed and not vault_changed:
        return

    conn.execute(
        """
        UPDATE users SET holds = ?, gear_slots = ?, vault = ?, updated_at = ?
        WHERE telegram_id = ?
        """,
        (json.dumps(holds), json.dumps(slots), json.dumps(vault), now, telegram_id),
    )


def ensure_starter_gear(conn, telegram_id: str, slots: list) -> list:
    """Give fishing rod in slot 1 when a player has no gear yet (dev starter)."""
    normalized = normalize_gear_slots(slots)
    if any(normalized):
        return normalized
    updated, granted = grant_gear_to_slots(normalized, "fishing_rod")
    if not granted:
        return normalized
    now = int(time.time())
    conn.execute(
        """
        UPDATE users SET gear_slots = ?, updated_at = ?
        WHERE telegram_id = ?
        """,
        (json.dumps(updated), now, telegram_id),
    )
    return updated


def build_test_user(slug: Optional[str] = None) -> dict:
    normalized = normalize_test_slug(slug)
    display = test_display_name(normalized)
    username = f"test_{normalized}" if normalized else "test_trainer"
    return {
        "id": int(test_telegram_id_for_slug(normalized)),
        "first_name": display,
        "last_name": "",
        "username": username[:32],
    }


def parse_test_slug_from_query_args(args) -> Optional[str]:
    if not webapp_test_allowed():
        return None

    start_param = (args.get("tgWebAppStartParam") or "").strip().lower()
    if start_param == "test":
        return ""

    if "test" in args:
        explicit = normalize_test_slug(args.get("test"))
        if explicit:
            return explicit
        for key in args:
            if key not in TEST_QUERY_RESERVED and key != "test":
                return normalize_test_slug(key)
        return ""

    aliases = [key for key in args if key not in TEST_QUERY_RESERVED]
    if len(aliases) == 1:
        return normalize_test_slug(aliases[0])
    return None


def resolve_test_user(data: Optional[dict] = None) -> Optional[dict]:
    if not request_is_test_mode(data):
        return None
    payload = data or {}
    slug = payload.get("testPlayer")
    if slug is None:
        slug = ""
    return build_test_user(str(slug))


def resolve_wallet_user(data: Optional[dict] = None) -> Optional[dict]:
    payload = data or {}
    token = (payload.get("walletSession") or "").strip()
    if not token:
        return None
    wallet = verify_wallet_session(token)
    if not wallet:
        return None
    short = f"{wallet[:4]}…{wallet[-4:]}"
    return {
        "id": wallet_telegram_id(wallet),
        "username": "",
        "first_name": short,
        "last_name": "",
        "wallet": wallet,
    }


def resolve_spectator_user() -> dict:
    uid = f"spectator:{secrets.token_hex(8)}"
    return {
        "id": uid,
        "username": "",
        "first_name": "Spectator",
        "last_name": "",
    }


def resolve_auth_user(data: Optional[dict] = None) -> Optional[dict]:
    payload = data or {}
    wallet_user = resolve_wallet_user(payload)
    if wallet_user:
        return wallet_user
    if payload.get("spectator"):
        return resolve_spectator_user()
    if request_is_test_mode(payload):
        return resolve_test_user(payload) or build_test_user("")
    init_data = payload.get("initData", "")
    validated = validate_init_data(init_data)
    if validated and "user" in validated:
        return validated["user"]
    return None


def request_is_test_mode(data: Optional[dict] = None) -> bool:
    if not webapp_test_allowed():
        return False
    if parse_test_slug_from_query_args(request.args) is not None:
        return True
    payload = data or {}
    if payload.get("testMode"):
        return True
    return False


def validate_init_data(init_data: str) -> Optional[dict]:
    if not init_data or not BOT_TOKEN:
        return None

    parsed = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    calculated_hash = hmac.new(
        secret_key, data_check_string.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        return None

    if "user" in parsed:
        parsed["user"] = json.loads(parsed["user"])

    return parsed


def display_name_from_user(user: dict) -> str:
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    username = (user.get("username") or "").strip()

    if first and last:
        return f"{first} {last}"
    if first:
        return first
    if username:
        return f"@{username}"
    return f"Player {user.get('id')}"


def normalize_player_name(raw) -> Optional[str]:
    if raw is None:
        return None
    name = " ".join(str(raw).strip().split())
    if not name or len(name) > 24:
        return None
    return name


def normalize_pin(raw) -> Optional[str]:
    if raw is None:
        return None
    pin = str(raw).strip()
    if len(pin) != 3 or not pin.isdigit():
        return None
    return pin


def profile_setup_needs_pin(row) -> bool:
    """First-time profile save requires a PIN (blocks API bypass of onboarding)."""
    if row is None:
        return False
    skin = row["skin"] if "skin" in row.keys() else None
    pin = row["pin"] if "pin" in row.keys() else None
    return skin is None and not pin


def parse_badges(raw) -> list:
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(b).strip() for b in raw if str(b).strip()]
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(b).strip() for b in parsed if str(b).strip()]


def quest_progress_for_user(completed_steps: list, removed_quests: list) -> dict:
    return parse_quest_progress(
        {"completed_steps": completed_steps, "removed_quests": removed_quests}
    )


def parse_holds(raw) -> list:
    if not raw:
        return []
    if isinstance(raw, list):
        items = raw
    else:
        try:
            items = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
    if not isinstance(items, list):
        return []
    return [item for item in dict.fromkeys(str(x).strip() for x in items) if item in HOLD_ITEM_IDS]


def holds_for_user(holds: list) -> list:
    return parse_holds(holds)


def parse_gear_slots(raw) -> list:
    return normalize_gear_slots(raw)


def gear_slots_for_user(raw) -> list:
    return parse_gear_slots(raw)


def valid_card_ids() -> frozenset[str]:
    from poke_registry import valid_card_ids as catalog_ids
    return catalog_ids(Path(app.root_path) / "poke.json")


def vault_for_user(raw) -> list[dict]:
    path = Path(app.root_path) / "poke.json"
    return parse_vault(raw, valid_card_ids(), poke_json_path=path)


def persist_user_vault(conn, telegram_id: str, raw, now: Optional[int] = None) -> list[dict]:
    """Parse vault, migrate legacy ids, and persist when storage changed."""
    vault = vault_for_user(raw)
    serialized = json.dumps(vault)
    stored = raw if isinstance(raw, str) else json.dumps(raw or [])
    if serialized != stored:
        conn.execute(
            "UPDATE users SET vault = ?, updated_at = ? WHERE telegram_id = ?",
            (serialized, now or int(time.time()), telegram_id),
        )
    return vault


def test_starter_card_id() -> Optional[str]:
    ids = sorted(valid_card_ids())
    return ids[0] if ids else None


def test_starter_vault_entries() -> list[dict]:
    card_id = test_starter_card_id()
    if not card_id:
        return []
    vault, _ = add_card_to_vault([], card_id, source="test_starter")
    return vault


def is_quest_complete(quest_id: str, completed_steps: list) -> bool:
    quest = next((q for q in QUEST_CATALOG if q["quest_id"] == quest_id), None)
    if not quest or not quest.get("steps"):
        return False
    needed = {s["id"] for s in quest["steps"]}
    return needed.issubset(set(completed_steps))


def quest_is_unlocked(quest: dict, completed_steps: list) -> bool:
    unlock = quest.get("unlock_after")
    if not unlock:
        return True
    return is_quest_complete(unlock, completed_steps)


init_db()


def telegram_bot_username() -> str:
    return (os.getenv("TELEGRAM_BOT_USERNAME") or "FortifyAltCTRLFarmbot").lstrip("@")


def telegram_play_url() -> str:
    """Opens the bot chat; user taps Start to send /start."""
    return f"https://t.me/{telegram_bot_username()}"


GIF_EXTENSIONS = (".gif", ".webp", ".png", ".jpg", ".jpeg", ".mp4")
VIDEO_EXTENSIONS = (".mp4", ".webm", ".mov")


def _static_media_url(path: Path) -> str:
    rel = path.relative_to(Path(app.root_path))
    return f"/{rel.as_posix()}?v={int(path.stat().st_mtime)}"


def landing_gif_url(slot: str = "2") -> Optional[str]:
    """Resolve /static/giffiles/{slot} — any supported extension."""
    gif_dir = Path(app.root_path) / "static/giffiles"
    for ext in GIF_EXTENSIONS:
        path = gif_dir / f"{slot}{ext}"
        if path.is_file():
            return _static_media_url(path)
    return None


def landing_video_url() -> Optional[str]:
    """Hero demo video from /static/video/ (demo.* preferred)."""
    video_dir = Path(app.root_path) / "static" / "video"
    if not video_dir.is_dir():
        return None
    for stem in ("demo", "hero", "1"):
        for ext in VIDEO_EXTENSIONS:
            path = video_dir / f"{stem}{ext}"
            if path.is_file():
                return _static_media_url(path)
    for path in sorted(video_dir.iterdir()):
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
            return _static_media_url(path)
    return None


def landing_hero_media() -> tuple[Optional[str], str]:
    """Return (url, media_type) where media_type is 'video' or 'image'."""
    video = landing_video_url()
    if video:
        return video, "video"
    url = landing_gif_url("1") or landing_gif_url("2")
    if not url:
        return None, "image"
    ext = Path(url.split("?")[0]).suffix.lower()
    if ext in VIDEO_EXTENSIONS:
        return url, "video"
    return url, "image"


def landing_hero_media_url() -> Optional[str]:
    """Hero media — /static/video/* preferred, then /static/giffiles/1.* or 2.*."""
    url, _ = landing_hero_media()
    return url


def landing_pool_cards() -> list:
    return [
        {"id": item["id"], "name": item["name"], "src": item["src"]}
        for item in pool_items()
    ]


def landing_play_lead() -> str:
    """Quick-start intro blurb for the landing how-to-play panel."""
    return (
        "Connect at pokecards.quest, walk the live map with other trainers, "
        "chain the Vault Trail quests, and wager PokéCards through Poké tab."
    )


def landing_play_steps() -> list:
    """Quick-start steps for the landing page how-to-play panel."""
    return [
        {
            "title": "Connect & enter",
            "text": "Open pokecards.quest, tap Play Now, and sign in with Phantom or Solflare.",
            "icon": "wallet",
        },
        {
            "title": "Build your trainer",
            "text": "Set a PIN, pick an avatar skin, and name your hero.",
            "icon": "trainer",
        },
        {
            "title": "Roam the realm",
            "text": "Use the D-pad, meet Live Trainers, and follow quest hints on signs and boards.",
            "icon": "roam",
        },
        {
            "title": "Loot & spin",
            "text": "Find hidden gear across the map and pull cards from vending machines.",
            "icon": "loot",
        },
        {
            "title": "Battle & rank up",
            "text": "Challenge trainers on Poké tab, wager vault cards, and climb the live leaderboard.",
            "icon": "rank",
        },
    ]


def landing_skin_price_tier(price: int) -> str:
    """Match in-game profile shop tier bands (see skinPriceTier in app.js)."""
    value = max(0, int(price))
    if value >= 5000:
        return "gold"
    if value >= 3000:
        return "bronze"
    if value >= 1500:
        return "silver"
    return "green"


def landing_skin_thumb_style(skin: str) -> str:
    """Inline CSS for a compact profile-style skin sprite thumb on the landing page."""
    zoom = 1.5
    sheet = 192
    frame_x, frame_y, frame_w, frame_h = 48, 0, 48, 48
    url = f"/sprites/characters/Character_{skin}.png"
    return (
        f"background-image:url({url});"
        f"background-size:{sheet * zoom}px {sheet * zoom}px;"
        f"background-position:-{frame_x * zoom}px -{frame_y * zoom}px;"
        f"width:{frame_w * zoom}px;height:{frame_h * zoom}px;"
    )


def landing_exclusive_skins() -> list:
    """Top three costliest avatar skins for the landing showcase."""
    costs = load_avatar_costs_from_map(WORLD_MAP_PATH)
    ranked = sorted(
        (skin for skin in SKINS if skin != AVATAR_DEFAULT_SKIN),
        key=lambda skin: (skin_list_price(skin, costs), skin),
        reverse=True,
    )
    showcase = []
    for skin in ranked[:3]:
        price = skin_list_price(skin, costs)
        showcase.append(
            {
                "skin": skin,
                "price": price,
                "tier": landing_skin_price_tier(price),
                "thumb_style": landing_skin_thumb_style(skin),
                "sprite_url": f"/sprites/characters/Character_{skin}.png",
            }
        )
    return showcase


def landing_hold_items() -> list:
    """Gear rows for the landing page hidden-items panel."""
    specs = [
        (
            "bag",
            "Trainer Bag",
            "Unlocks the bag icon on your HUD — open it anywhere to reach your Poké Vault, "
            "Poké tab, and any extra tabs you earn as you collect quest gear.",
        ),
        (
            "card_vault",
            "Poké Vault",
            "Permanent home for every PokéCard you spin, win, or discover. Browse your full "
            "collection and pull cards from here into Poké tab battles and wagers.",
        ),
        (
            "poketab",
            "Poké tab",
            "Your handheld link device — scan online trainers, send friend requests, DM allies, "
            "and challenge rivals to wager battles using cards from your vault.",
        ),
    ]
    paths = {
        "bag": "static/menuitems/bag.png",
        "card_vault": "static/menuitems/dex.png",
        "poketab": "static/menuitems/phone.png",
    }
    items = []
    for hold_id, label, text in specs:
        rel = paths[hold_id]
        items.append(
            {
                "id": hold_id,
                "label": label,
                "text": text,
                "src": f"/{rel}?v={asset_version(rel)}",
            }
        )
    return items


def _render_game_app(play_mode: bool = False, test_mode: bool = False, test_player_slug: str = ""):
    asset_v = {
        "css": asset_version("static/css/app.css"),
        "app_js": asset_version("static/js/app.js"),
        "retro_audio_js": asset_version("static/js/retro-audio.js"),
        "game_js": asset_version("static/game/game.js"),
        "world": world_map_version(),
        "titles": asset_version("static/imgs/titles.png"),
        "favicon": asset_version("static/imgs/favicon.png"),
        "bag_icon": asset_version("static/menuitems/bag.png"),
        "dex_icon": asset_version("static/menuitems/dex.png"),
        "phone_icon": asset_version("static/menuitems/phone.png"),
        "kins_wallet_js": asset_version("static/js/kins-wallet.js"),
    }
    if play_mode:
        asset_v.update({
            "play_css": asset_version("static/css/play.css"),
            "play_js": asset_version("static/js/play.js"),
            "bg": asset_version("static/background/bg.png"),
            "phantom_logo": asset_version("static/logos/ph.svg"),
            "solflare_logo": asset_version("static/logos/sol.svg"),
        })
    return render_template(
        "index.html",
        play_mode=play_mode,
        kins_token_mint=KINS_TOKEN_MINT if play_mode else "",
        kins_treasury=KINS_TREASURY_WALLET,
        kins_min_hold=int(MIN_TOKEN_UI_AMOUNT),
        game_server_url="",
        game_socket_url=GAME_SOCKET_URL,
        test_mode=test_mode,
        test_player_slug=test_player_slug,
        skins=SKINS,
        default_skin=DEFAULT_SKIN,
        asset_v=asset_v,
        bag_items=bag_items(),
        pool_items=pool_items(),
        card_catalog=card_catalog_for_client(),
        bag_slot_count=BAG_SLOT_COUNT,
        quests=QUEST_CATALOG,
        hold_catalog=hold_catalog_for_client(),
        gear_catalog=gear_catalog_for_client(),
        fishing_catalog=fishing_catalog_for_client(),
        gear_slot_count=GEAR_SLOT_COUNT,
        ui_unlocks=ui_unlocks_for_client(),
        avatar_costs=load_avatar_costs_from_map(WORLD_MAP_PATH),
        starting_balance=STARTING_BALANCE,
        min_withdraw_kins=MIN_WITHDRAW_KINS,
        vending_spin_first_cost=VENDING_SPIN_FIRST_COST,
        vending_spin_repeat_cost=VENDING_SPIN_REPEAT_COST,
        xp_levels=xp_config_for_client(),
    )


@app.route("/play")
def play_page():
    test_slug = parse_test_slug_from_query_args(request.args)
    if test_slug is not None:
        return _render_game_app(
            play_mode=False,
            test_mode=True,
            test_player_slug=test_slug,
        )
    return _render_game_app(play_mode=True)


def _render_landing_page():
    hero_media_url, hero_media_type = landing_hero_media()
    return render_template(
        "landing.html",
        starting_balance=STARTING_BALANCE,
        pool_cards=landing_pool_cards(),
        showcase_cards=landing_pool_cards()[:3],
        hold_items=landing_hold_items(),
        exclusive_skins=landing_exclusive_skins(),
        play_steps=landing_play_steps(),
        play_lead=landing_play_lead(),
        hero_media_url=hero_media_url,
        hero_media_type=hero_media_type,
        token_ca=KINS_TOKEN_MINT,
        asset_v={
            "landing_css": asset_version("static/css/landing.css"),
            "landing_js": asset_version("static/js/landing.js"),
            "titles": asset_version("static/imgs/titles.png"),
            "favicon": asset_version("static/imgs/favicon.png"),
        },
    )


@app.route("/")
def home():
    if parse_test_slug_from_query_args(request.args) is not None:
        qs = request.query_string.decode()
        return redirect(f"/play?{qs}" if qs else "/play", code=302)
    return _render_landing_page()


@app.route("/landing")
def landing_page():
    return redirect("/", code=301)


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(
        Path(app.root_path) / "static" / "imgs",
        "favicon.png",
        mimetype="image/png",
    )


@app.route("/api/wallet/challenge", methods=["GET", "POST"])
def wallet_challenge_api():
    return jsonify(create_wallet_challenge())


@app.route("/api/wallet/verify", methods=["POST"])
def wallet_verify_api():
    data = request.get_json(silent=True) or {}
    ok, error, session_token = verify_wallet_login(
        str(data.get("walletAddress") or ""),
        str(data.get("challengeId") or ""),
        str(data.get("signature") or ""),
        require_token=True,
    )
    if not ok:
        return jsonify({"success": False, "error": error}), 400
    wallet = verify_wallet_session(session_token or "")
    return jsonify(
        {
            "success": True,
            "walletSession": session_token,
            "walletAddress": wallet,
        }
    )


def _auth_wallet_context(data: Optional[dict] = None):
    payload = data if data is not None else (request.get_json(silent=True) or {})
    user = resolve_auth_user(payload)
    if not user or not is_wallet_user_id(str(user["id"])):
        return None, None, (
            jsonify({"success": False, "error": "Wallet session required."}),
            403,
        )
    wallet = user.get("wallet") or verify_wallet_session(
        str(payload.get("walletSession") or "").strip()
    )
    if not wallet:
        return None, None, (
            jsonify({"success": False, "error": "Wallet session expired. Reconnect."}),
            401,
        )
    return str(user["id"]), wallet, None


def _apply_skin_to_user(
    conn,
    telegram_id: str,
    skin: str,
    display_name: Optional[str],
    avatar_costs: dict,
) -> tuple[Optional[dict], Optional[tuple]]:
    row = conn.execute(
        "SELECT display_name, skin, balance, owned_skins, pin FROM users WHERE telegram_id = ?",
        (telegram_id,),
    ).fetchone()
    if row is None:
        return None, (jsonify({"success": False, "error": "User not found"}), 404)

    if profile_setup_needs_pin(row):
        return None, (
            jsonify({"success": False, "error": "Set a trainer PIN first."}),
            403,
        )

    owned_skins = parse_owned_skins(row["owned_skins"], row["skin"])
    cost = purchase_cost(skin, owned_skins, avatar_costs)
    balance = int(row["balance"] or 0)

    if cost > 0 and not is_wallet_user_id(telegram_id):
        if cost > balance:
            price = skin_list_price(skin, avatar_costs)
            return None, (
                jsonify(
                    {
                        "success": False,
                        "error": f"Need {price:,} Chips — you have {balance:,}",
                        "balance": balance,
                        "cost": cost,
                        "price": price,
                    }
                ),
                402,
            )
        balance -= cost

    if skin not in owned_skins:
        owned_skins = list(dict.fromkeys([*owned_skins, skin]))

    now = int(time.time())
    final_name = display_name if display_name is not None else row["display_name"]
    conn.execute(
        """
        UPDATE users
        SET skin = ?, display_name = ?, balance = ?, owned_skins = ?, updated_at = ?
        WHERE telegram_id = ?
        """,
        (skin, final_name, balance, owned_skins_json(owned_skins), now, telegram_id),
    )
    return {
        "skin": skin,
        "display_name": final_name,
        "balance": balance,
        "owned_skins": owned_skins,
        "cost_paid": cost,
    }, None


@app.route("/api/kins/config", methods=["GET"])
def kins_config_api():
    try:
        decimals = get_mint_decimals()
    except (RuntimeError, OSError, ValueError, TypeError):
        decimals = 6
    return jsonify(
        {
            "success": True,
            "mint": KINS_TOKEN_MINT,
            "treasuryWallet": KINS_TREASURY_WALLET,
            "minHold": int(MIN_TOKEN_UI_AMOUNT),
            "minDeposit": MIN_DEPOSIT_KINS,
            "minWithdraw": MIN_WITHDRAW_KINS,
            "maxDeposit": MAX_DEPOSIT_KINS,
            "rpcUrl": SOLANA_RPC_URL,
            "mintDecimals": decimals,
            "tokenProgram": TOKEN_2022_PROGRAM_ID,
            "treasuryReady": treasury_kins_ata_exists(),
            "createTreasuryAtaIfNeeded": not treasury_kins_ata_exists(),
        }
    )


@app.route("/api/kins/blockhash", methods=["GET"])
def kins_blockhash_api():
    try:
        block = get_latest_blockhash()
    except (RuntimeError, OSError, TimeoutError, ValueError, TypeError) as exc:
        return jsonify({"success": False, "error": str(exc)}), 502
    return jsonify({"success": True, **block})


CLEAR_DB_PASSWORD = os.getenv("CLEAR_DB_PASSWORD", "9999")


@app.route("/clear", methods=["GET", "POST"])
def clear_saved_data():
    """Dev reset: snapshot report + wipe all saved DB rows when password matches."""
    from db.clear_report import (
        build_clear_snapshot,
        render_clear_password_form,
        render_clear_report_html,
    )
    from db.clear_service import clear_all_saved_data

    payload = request.get_json(silent=True) or {}
    password = (
        request.args.get("password")
        or request.form.get("password")
        or payload.get("password")
        or ""
    )
    wants_json = (
        request.args.get("format") == "json"
        or request.is_json
        or (
            request.accept_mimetypes.best_match(["application/json", "text/html"])
            == "application/json"
            and "text/html" not in (request.headers.get("Accept") or "")
        )
    )

    if str(password) != str(CLEAR_DB_PASSWORD):
        if wants_json and password:
            return jsonify({"success": False, "error": "Invalid password."}), 403
        return render_clear_password_form(
            error="Invalid password." if password else ""
        ), (403 if password else 401)

    with get_db() as conn:
        snapshot = build_clear_snapshot(conn)
        cleared = clear_all_saved_data(conn)
    clear_wallet_sessions()

    if wants_json:
        return jsonify(
            {
                "success": True,
                "snapshot": snapshot,
                "cleared": cleared,
                "wallet_sessions_cleared": True,
            }
        )

    return render_clear_report_html(
        snapshot,
        cleared,
        wallet_sessions_cleared=True,
    )


@app.route("/api/kins/deposit-intent", methods=["POST"])
def kins_deposit_intent_api():
    telegram_id, wallet, err = _auth_wallet_context()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    try:
        amount_kins = int(data.get("amountKins"))
    except (TypeError, ValueError):
        amount_kins = 0
    if amount_kins < MIN_DEPOSIT_KINS or amount_kins > MAX_DEPOSIT_KINS:
        return jsonify(
            {
                "success": False,
                "error": f"Enter between {MIN_DEPOSIT_KINS:,} and {MAX_DEPOSIT_KINS:,} $POKEQUEST.",
            }
        ), 400

    with get_db() as conn:
        intent = create_payment_intent(
            conn,
            telegram_id=telegram_id,
            wallet_address=wallet,
            purpose="deposit",
            amount_kins=amount_kins,
            payload={"amount_kins": amount_kins},
        )
    return jsonify({"success": True, **intent})


@app.route("/api/kins/withdraw", methods=["POST"])
def kins_withdraw_api():
    telegram_id, wallet, err = _auth_wallet_context()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    try:
        amount_kins = int(data.get("amountKins"))
    except (TypeError, ValueError):
        amount_kins = 0

    with get_db() as conn:
        ok, error, result = create_withdrawal(
            conn,
            telegram_id=telegram_id,
            wallet_address=wallet,
            amount_kins=amount_kins,
        )
    if not ok:
        return jsonify({"success": False, "error": error}), 400
    return jsonify({"success": True, **result})


@app.route("/api/economy/npc-grant", methods=["POST"])
def npc_balance_grant_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    grant_id = str(data.get("grantId") or data.get("grant_id") or "").strip()
    if not grant_id:
        return jsonify({"success": False, "error": "Missing grant id."}), 400

    with get_db() as conn:
        ok, error, result = grant_npc_balance(
            conn,
            telegram_id=telegram_id,
            grant_id=grant_id,
        )
    if not ok:
        return jsonify({"success": False, "error": error}), 400
    return jsonify({"success": True, **result})


@app.route("/api/kins/skin-intent", methods=["POST"])
def kins_skin_intent_api():
    telegram_id, wallet, err = _auth_wallet_context()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    skin = data.get("skin")
    if skin not in SKINS:
        return jsonify({"success": False, "error": "Invalid skin"}), 400

    display_name = None
    if data.get("displayName") is not None and str(data.get("displayName")).strip():
        display_name = normalize_player_name(data.get("displayName"))
        if display_name is None:
            return jsonify({"success": False, "error": "Enter a name (1–24 characters)"}), 400

    avatar_costs = load_avatar_costs_from_map(WORLD_MAP_PATH)
    with get_db() as conn:
        row = conn.execute(
            "SELECT owned_skins, skin, pin FROM users WHERE telegram_id = ?",
            (telegram_id,),
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404
        if profile_setup_needs_pin(row):
            return jsonify({"success": False, "error": "Set a trainer PIN first."}), 403
        owned_skins = parse_owned_skins(row["owned_skins"], row["skin"])
        cost = purchase_cost(skin, owned_skins, avatar_costs)
        if cost <= 0:
            return jsonify(
                {
                    "success": False,
                    "error": "No $POKEQUEST payment required for this avatar.",
                    "requires_payment": False,
                }
            ), 400

        intent = create_payment_intent(
            conn,
            telegram_id=telegram_id,
            wallet_address=wallet,
            purpose="skin_purchase",
            amount_kins=cost,
            payload={"skin": skin, "display_name": display_name},
        )
    return jsonify({"success": True, **intent, "requiresPayment": True})


@app.route("/api/kins/confirm", methods=["POST"])
def kins_confirm_api():
    telegram_id, wallet, err = _auth_wallet_context()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    payment_id = str(data.get("paymentId") or "").strip()
    tx_signature = str(data.get("signature") or "").strip()
    if not payment_id or not tx_signature:
        return jsonify({"success": False, "error": "Missing payment proof."}), 400

    avatar_costs = load_avatar_costs_from_map(WORLD_MAP_PATH)
    with get_db() as conn:
        ok, error, confirmed = confirm_payment(
            conn,
            payment_id=payment_id,
            tx_signature=tx_signature,
            expected_wallet=wallet,
        )
        if not ok or not confirmed:
            return jsonify({"success": False, "error": error or "Payment not verified."}), 400

        if confirmed["telegram_id"] != telegram_id:
            return jsonify({"success": False, "error": "Payment does not match your account."}), 403

        purpose = confirmed["purpose"]
        amount_kins = int(confirmed["amount_kins"])
        payload = confirmed.get("payload") or {}

        if purpose == "deposit":
            conn.execute(
                """
                UPDATE users
                SET balance = balance + ?, updated_at = ?
                WHERE telegram_id = ?
                """,
                (amount_kins, int(time.time()), telegram_id),
            )
            row = conn.execute(
                "SELECT balance FROM users WHERE telegram_id = ?",
                (telegram_id,),
            ).fetchone()
            balance = int(row["balance"] or 0) if row else amount_kins
            return jsonify(
                {
                    "success": True,
                    "purpose": purpose,
                    "amountKins": amount_kins,
                    "balance": balance,
                    "txSignature": confirmed["tx_signature"],
                }
            )

        if purpose == "skin_purchase":
            skin = payload.get("skin")
            if skin not in SKINS:
                return jsonify({"success": False, "error": "Invalid skin in payment."}), 400
            display_name = payload.get("display_name")
            result, apply_err = _apply_skin_to_user(
                conn, telegram_id, skin, display_name, avatar_costs
            )
            if apply_err:
                return apply_err
            return jsonify(
                {
                    "success": True,
                    "purpose": purpose,
                    "txSignature": confirmed["tx_signature"],
                    **result,
                }
            )

        return jsonify({"success": False, "error": "Unknown payment purpose."}), 400


@app.route("/api/world")
def world_map():
    if not WORLD_MAP_PATH.exists():
        return jsonify({"error": "World map not found"}), 404

    try:
        with open(WORLD_MAP_PATH, "rb") as map_file:
            payload = json.loads(map_file.read())
    except (OSError, json.JSONDecodeError):
        return jsonify({"error": "World map corrupt"}), 500

    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, no-transform"
    response.headers["X-World-Version"] = world_map_version()
    response.headers["X-World-Hash"] = world_map_hash()
    return response


@app.route("/api/auth", methods=["POST"])
def auth():
    data = request.get_json(silent=True) or {}
    user = resolve_auth_user(data)
    if not user:
        return jsonify({"success": False, "error": (
                "Invalid session. Connect your wallet on /play or open from the PokéCards bot."
            )}), 401
    telegram_id = str(user["id"])
    is_wallet = is_wallet_user_id(telegram_id)
    display_name = "" if is_wallet else display_name_from_user(user)
    username = user.get("username") or ""
    now = int(time.time())

    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()

        if row is None:
            is_test = request_is_test_mode(data)
            is_spectator = telegram_id.startswith("spectator:")
            is_wallet = is_wallet_user_id(telegram_id)
            auto_profile = is_test or is_spectator
            starting_balance = TEST_STARTING_BALANCE if is_test else 0
            starter_vault = json.dumps(test_starter_vault_entries()) if is_test else "[]"
            conn.execute(
                """
                INSERT INTO users (
                    telegram_id, username, display_name, skin, badges, quest_progress,
                    holds, gear_slots, vault, balance, owned_skins, pin, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, '[]', '{"completed_steps":[],"removed_quests":[]}', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    telegram_id,
                    username,
                    display_name,
                    AVATAR_DEFAULT_SKIN if auto_profile else None,
                    json.dumps(TEST_PLAYER_HOLDS) if is_test else "[]",
                    json.dumps(TEST_PLAYER_GEAR_SLOTS if is_test else [None, None, None]),
                    starter_vault,
                    starting_balance,
                    owned_skins_json([AVATAR_DEFAULT_SKIN] if auto_profile else []),
                    "123" if is_test else None,
                    now,
                    now,
                ),
            )
            skin = AVATAR_DEFAULT_SKIN if auto_profile else None
            badges = []
            holds = TEST_PLAYER_HOLDS if is_test else []
            gear_slots = list(TEST_PLAYER_GEAR_SLOTS if is_test else [None, None, None])
            vault = test_starter_vault_entries() if is_test else []
            balance = starting_balance
            vending_spins = 0
            owned_skins = parse_owned_skins([AVATAR_DEFAULT_SKIN])
            user_pin = "123" if is_test else None
            quest_progress = quest_progress_for_user([], [])
            backfill_quest_triggers(conn, telegram_id)
            row_after = conn.execute(
                "SELECT quest_progress FROM users WHERE telegram_id = ?",
                (telegram_id,),
            ).fetchone()
            if row_after:
                quest_progress = parse_quest_progress(row_after["quest_progress"])
        else:
            is_test = request_is_test_mode(data)
            if is_test:
                display_name = display_name_from_user(user)
                conn.execute(
                    """
                    UPDATE users
                    SET username = ?, display_name = ?, updated_at = ?
                    WHERE telegram_id = ?
                    """,
                    (username, display_name, now, telegram_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE users
                    SET username = ?, updated_at = ?
                    WHERE telegram_id = ?
                    """,
                    (username, now, telegram_id),
                )
                display_name = row["display_name"]
            skin = row["skin"]
            badges = parse_badges(row["badges"] if "badges" in row.keys() else "[]")
            quest_progress = parse_quest_progress(
                row["quest_progress"] if "quest_progress" in row.keys() else None
            )
            holds = parse_holds(row["holds"] if "holds" in row.keys() else None)
            gear_slots = parse_gear_slots(
                row["gear_slots"] if "gear_slots" in row.keys() else None
            )
            vault = persist_user_vault(conn, telegram_id, row["vault"] if "vault" in row.keys() else None, now)
            balance = int(row["balance"] if "balance" in row.keys() else 0)
            vending_spins = int(row["vending_spins"] if "vending_spins" in row.keys() else 0)
            owned_skins = parse_owned_skins(
                row["owned_skins"] if "owned_skins" in row.keys() else None,
                row["skin"],
            )
            user_pin = row["pin"] if "pin" in row.keys() else None
            backfill_quest_triggers(conn, telegram_id)
            row_after = conn.execute(
                "SELECT quest_progress FROM users WHERE telegram_id = ?",
                (telegram_id,),
            ).fetchone()
            if row_after:
                quest_progress = parse_quest_progress(row_after["quest_progress"])

        if request_is_test_mode(data):
            ensure_test_player_profile(conn, telegram_id)
            row_test = conn.execute(
                "SELECT vault, holds, gear_slots FROM users WHERE telegram_id = ?",
                (telegram_id,),
            ).fetchone()
            if row_test:
                vault = vault_for_user(row_test["vault"] if "vault" in row_test.keys() else None)
                holds = parse_holds(row_test["holds"] if "holds" in row_test.keys() else None)
                gear_slots = parse_gear_slots(
                    row_test["gear_slots"] if "gear_slots" in row_test.keys() else None
                )

    avatar_costs = load_avatar_costs_from_map(WORLD_MAP_PATH)

    trainer_stats = None
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp, quest_progress
            FROM users WHERE telegram_id = ?
            """,
            (telegram_id,),
        ).fetchone()
        if row:
            try:
                trainer_stats = trainer_stats_row(row)
                trainer_stats["vault_count"] = len(vault_card_ids(vault))
                trainer_stats["balance"] = balance
            except Exception as err:
                app.logger.exception("trainer_stats_row failed for %s: %s", telegram_id, err)

    wallet_address = user.get("wallet") if is_wallet_user_id(telegram_id) else None

    return jsonify(
        {
            "success": True,
            "telegram_id": telegram_id,
            "display_name": display_name,
            "username": username,
            "skin": skin,
            "has_skin": skin is not None,
            "badges": badges,
            "holds": holds,
            "gear_slots": gear_slots,
            "vault": vault_card_ids(vault),
            "vault_detail": vault,
            "quest_progress": quest_progress,
            "balance": balance,
            "owned_skins": owned_skins,
            "avatar_costs": avatar_costs,
            "starting_balance": STARTING_BALANCE,
            "vending_spins": vending_spins,
            "next_vending_spin_cost": vending_spin_cost(vending_spins),
            "vending_spin_first_cost": VENDING_SPIN_FIRST_COST,
            "vending_spin_repeat_cost": VENDING_SPIN_REPEAT_COST,
            "has_pin": bool(user_pin),
            "trainer_stats": trainer_stats,
            "level": trainer_stats["level"] if trainer_stats else 0,
            "wallet_address": wallet_address,
            "requires_kins_payments": bool(wallet_address),
            "kins_treasury": KINS_TREASURY_WALLET if wallet_address else None,
            "kins_min_hold": int(MIN_TOKEN_UI_AMOUNT),
        }
    )


@app.route("/api/pin/set", methods=["POST"])
def set_pin():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    pin = normalize_pin(data.get("pin"))
    if pin is None:
        return jsonify({"success": False, "error": "Enter a 3-digit PIN"}), 400

    now = int(time.time())
    with get_db() as conn:
        updated = conn.execute(
            "UPDATE users SET pin = ?, updated_at = ? WHERE telegram_id = ?",
            (pin, now, telegram_id),
        ).rowcount
        if updated == 0:
            return jsonify({"success": False, "error": "User not found"}), 404

    return jsonify({"success": True, "has_pin": True})


@app.route("/api/pin/verify", methods=["POST"])
def verify_pin():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    pin = normalize_pin(data.get("pin"))
    if pin is None:
        return jsonify({"success": False, "error": "Enter a 3-digit PIN"}), 400

    with get_db() as conn:
        row = conn.execute(
            "SELECT pin FROM users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404
        stored = row["pin"] if "pin" in row.keys() else None
        if not stored:
            return jsonify({"success": False, "error": "PIN not set yet"}), 400
        if stored != pin:
            return jsonify({"success": False, "error": "Wrong PIN"}), 401

    return jsonify({"success": True})


@app.route("/api/skin", methods=["POST"])
def save_skin():
    data = request.get_json(silent=True) or {}
    user = resolve_auth_user(data)
    if not user:
        return jsonify({"success": False, "error": (
                "Invalid session. Connect your wallet on /play or open from the PokéCards bot."
            )}), 401

    skin = data.get("skin")
    display_name_raw = data.get("displayName")

    if skin not in SKINS:
        return jsonify({"success": False, "error": "Invalid skin"}), 400

    display_name = None
    if display_name_raw is not None and str(display_name_raw).strip():
        display_name = normalize_player_name(display_name_raw)
        if display_name is None:
            return jsonify({"success": False, "error": "Enter a name (1–24 characters)"}), 400

    telegram_id = str(user["id"])
    avatar_costs = load_avatar_costs_from_map(WORLD_MAP_PATH)

    with get_db() as conn:
        row = conn.execute(
            "SELECT display_name, skin, balance, owned_skins FROM users WHERE telegram_id = ?",
            (telegram_id,),
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404

        owned_skins = parse_owned_skins(row["owned_skins"], row["skin"])
        cost = purchase_cost(skin, owned_skins, avatar_costs)

        if is_wallet_user_id(telegram_id) and cost > 0:
            return jsonify(
                {
                    "success": False,
                    "error": f"Send {cost:,} $POKEQUEST from your wallet to unlock this avatar.",
                    "requires_kins_payment": True,
                    "cost": cost,
                }
            ), 402

        result, apply_err = _apply_skin_to_user(
            conn, telegram_id, skin, display_name, avatar_costs
        )
        if apply_err:
            return apply_err

    return jsonify({"success": True, **result})


def _auth_user_from_request():
    data = request.get_json(silent=True) or {}
    user = resolve_auth_user(data)
    if not user:
        return None, (jsonify({"success": False, "error": (
                "Invalid session. Connect your wallet on /play or open from the PokéCards bot."
            )}), 401)
    return str(user["id"]), None


POKETAB_NOTIFY_SECRET = os.getenv("POKETAB_NOTIFY_SECRET", "poketab-local-dev")


def _fetch_online_players() -> list[dict]:
    try:
        req = urllib.request.Request(
            f"{GAME_SERVER_INTERNAL.rstrip('/')}/getOnlinePlayers",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            payload = json.loads(resp.read().decode())
            players = payload.get("players")
            return players if isinstance(players, list) else []
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return []


def _online_id_set(players: list[dict]) -> set[str]:
    return {str(p.get("uid")) for p in players if p.get("uid")}


def _notify_poketab_player(target_uid: str, event: str, data: Optional[dict] = None) -> bool:
    body = json.dumps(
        {
            "secret": POKETAB_NOTIFY_SECRET,
            "targetUid": str(target_uid),
            "event": event,
            "data": data or {},
        }
    ).encode()
    try:
        req = urllib.request.Request(
            f"{GAME_SERVER_INTERNAL.rstrip('/')}/internal/poketab-notify",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            payload = json.loads(resp.read().decode())
            return bool(payload.get("delivered"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError):
        return False


def _notify_battle_peer(result: dict) -> None:
    notify_uid = str(result.get("notify_uid") or "")
    notify_battle = result.get("notify_battle")
    if not notify_uid and result.get("battle"):
        notify_uid = str(result["battle"].get("opponent", {}).get("id", ""))
    if not notify_uid:
        return
    payload: dict = {
        "game_id": (notify_battle or result.get("battle") or {}).get("game_id"),
        "ended": bool(result.get("ended")),
    }
    if notify_battle:
        payload["battle"] = notify_battle
    _notify_poketab_player(notify_uid, "battle_update", payload)


@app.route("/internal/battle-player-offline", methods=["POST"])
def internal_battle_player_offline():
    data = request.get_json(silent=True) or {}
    if data.get("secret") != POKETAB_NOTIFY_SECRET:
        return jsonify({"ok": False, "error": "Forbidden"}), 403
    uid = str(data.get("uid") or "").strip()
    if not uid:
        return jsonify({"ok": False, "error": "Missing uid"}), 400
    catalog = card_catalog_for_client()
    quest_player_ids: list[int] = []
    with get_db() as conn:
        result = forfeit_active_battle_for_offline(conn, uid, catalog)
        quest_player_ids = result.pop("quest_player_ids", []) or []
    notify_battle = result.pop("notify_battle", None)
    notify_uid = str(result.pop("notify_uid", "") or "")
    if result.get("forfeited") and notify_uid and notify_battle:
        _notify_poketab_player(
            notify_uid,
            "battle_update",
            {
                "game_id": notify_battle.get("game_id"),
                "ended": True,
                "battle": notify_battle,
            },
        )
    notify_battle_quests(quest_player_ids)
    return jsonify({"ok": True, **result})


@app.route("/api/poketab/summary", methods=["POST"])
def poketab_summary_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    with get_db() as conn:
        payload = poketab_summary(conn, telegram_id)
        battle_alerts = count_battle_alerts(conn, telegram_id)
        payload["battle_alerts"] = battle_alerts
        payload["notification_count"] = int(payload.get("notification_count") or 0) + battle_alerts
    return jsonify({"success": True, **payload})


@app.route("/api/poketab/online", methods=["POST"])
def poketab_online_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    online = _fetch_online_players()
    with get_db() as conn:
        players = online_players_with_status(conn, telegram_id, online)
    return jsonify({"success": True, "players": players})


@app.route("/api/poketab/friend-requests", methods=["POST"])
def poketab_friend_requests_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    with get_db() as conn:
        requests_list = list_incoming_requests(conn, telegram_id)
    return jsonify({"success": True, "requests": requests_list})


@app.route("/api/poketab/friend-request/send", methods=["POST"])
def poketab_friend_request_send_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    target_id = str(data.get("target_id", "")).strip()
    if not target_id:
        return jsonify({"success": False, "error": "target_id required"}), 400
    with get_db() as conn:
        result = send_friend_request(conn, telegram_id, target_id)
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not send request")}), 400
    _notify_poketab_player(
        target_id,
        "friend_request",
        {"from_id": telegram_id, "request_id": result.get("request_id")},
    )
    return jsonify({"success": True, "request_id": result.get("request_id")})


@app.route("/api/poketab/friend-request/respond", methods=["POST"])
def poketab_friend_request_respond_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    request_id = data.get("request_id")
    action = str(data.get("action", "")).strip().lower()
    if not request_id or action not in ("accept", "decline"):
        return jsonify({"success": False, "error": "request_id and action required"}), 400
    with get_db() as conn:
        result = respond_friend_request(
            conn,
            telegram_id,
            int(request_id),
            accept=action == "accept",
        )
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not respond")}), 400
    if result.get("accepted") and result.get("friend_id"):
        _notify_poketab_player(
            result["friend_id"],
            "friend_accepted",
            {"friend_id": telegram_id},
        )
    return jsonify({"success": True, "accepted": bool(result.get("accepted"))})


@app.route("/api/poketab/friends", methods=["POST"])
def poketab_friends_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    online = _fetch_online_players()
    online_ids = _online_id_set(online)
    with get_db() as conn:
        friends = list_friends(conn, telegram_id, online_ids)
    return jsonify({"success": True, "friends": friends})


@app.route("/api/poketab/messages/conversations", methods=["POST"])
def poketab_conversations_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    online = _fetch_online_players()
    online_ids = _online_id_set(online)
    with get_db() as conn:
        conversations = list_conversations(conn, telegram_id, online_ids)
    return jsonify({"success": True, "conversations": conversations})


@app.route("/api/poketab/messages/thread", methods=["POST"])
def poketab_thread_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    peer_id = str(data.get("peer_id", "")).strip()
    if not peer_id:
        return jsonify({"success": False, "error": "peer_id required"}), 400
    with get_db() as conn:
        result = get_thread(conn, telegram_id, peer_id)
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not load thread")}), 400
    return jsonify({"success": True, "peer": result["peer"], "messages": result["messages"]})


@app.route("/api/poketab/messages/send", methods=["POST"])
def poketab_send_message_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    peer_id = str(data.get("peer_id", "")).strip()
    body = data.get("body", "")
    if not peer_id:
        return jsonify({"success": False, "error": "peer_id required"}), 400
    with get_db() as conn:
        result = send_message(conn, telegram_id, peer_id, body)
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not send message")}), 400
    _notify_poketab_player(
        peer_id,
        "message",
        {"from_id": telegram_id, "message": result.get("message")},
    )
    return jsonify({"success": True, "message": result.get("message")})


@app.route("/api/poketab/battle/opponents", methods=["POST"])
def poketab_battle_opponents_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    try:
        online = _fetch_online_players()
        catalog = card_catalog_for_client()
        with get_db() as conn:
            opponents = battleable_opponents(conn, telegram_id, online, set(catalog.keys()))
            balance = conn.execute(
                "SELECT balance FROM users WHERE telegram_id = ?", (telegram_id,)
            ).fetchone()
            my_balance = int(balance["balance"] or 0) if balance else 0
            my_eligible = len(eligible_battle_cards(conn, telegram_id, set(catalog.keys())))
            my_vault = len(_user_vault_ids(conn, telegram_id, set(catalog.keys())))
        return jsonify({
            "success": True,
            "opponents": opponents,
            "balance": my_balance,
            "eligible_cards": my_eligible,
            "vault_cards": my_vault,
            "daily_battles_per_card": MAX_DAILY_BATTLES_PER_CARD,
        })
    except Exception:
        app.logger.exception("poketab battle opponents failed")
        return jsonify({"success": False, "error": "Could not scan online trainers. Try again."}), 500


@app.route("/api/poketab/battle/challenge", methods=["POST"])
def poketab_battle_challenge_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    target_id = str(data.get("target_id", "")).strip()
    bet = data.get("bet")
    if not target_id:
        return jsonify({"success": False, "error": "target_id required"}), 400
    catalog = card_catalog_for_client()
    with get_db() as conn:
        result = send_challenge(conn, telegram_id, target_id, bet, set(catalog.keys()))
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not challenge")}), 400
    delivered = _notify_poketab_player(
        target_id,
        "battle_invite",
        {"invite_id": result.get("invite_id"), "from_id": telegram_id, "bet": bet},
    )
    return jsonify({
        "success": True,
        "invite_id": result.get("invite_id"),
        "notify_delivered": delivered,
    })


@app.route("/api/poketab/battle/respond", methods=["POST"])
def poketab_battle_respond_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    invite_id = data.get("invite_id")
    action = str(data.get("action", "")).strip().lower()
    if not invite_id or action not in ("accept", "decline"):
        return jsonify({"success": False, "error": "invite_id and action required"}), 400
    catalog = card_catalog_for_client()
    with get_db() as conn:
        row = conn.execute(
            "SELECT challenger_id FROM poketab_battle_invites WHERE id = ?",
            (int(invite_id),),
        ).fetchone()
        result = respond_invite(
            conn,
            telegram_id,
            int(invite_id),
            accept=action == "accept",
            valid_ids=set(catalog.keys()),
            catalog=catalog,
        )
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not respond")}), 400
    if row and result.get("started"):
        challenger_id = str(row["challenger_id"])
        accepter_id = telegram_id
        game_id = result.get("game_id")
        for uid in (challenger_id, accepter_id):
            with get_db() as conn:
                status = poketab_battle_status(conn, uid, catalog)
            battle = status.get("battle")
            if uid == accepter_id and battle and not result.get("battle"):
                result["battle"] = battle
            _notify_poketab_player(
                uid,
                "battle_start",
                {
                    "invite_id": invite_id,
                    "game_id": game_id,
                    "battle": battle,
                },
            )
    elif row and result.get("accepted") is False:
        _notify_poketab_player(
            row["challenger_id"],
            "battle_update",
            {"invite_id": invite_id, "accepted": False},
        )
    return jsonify({"success": True, **result})


@app.route("/api/poketab/battle/cancel", methods=["POST"])
def poketab_battle_cancel_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    invite_id = data.get("invite_id")
    if not invite_id:
        return jsonify({"success": False, "error": "invite_id required"}), 400
    with get_db() as conn:
        row = conn.execute(
            "SELECT target_id FROM poketab_battle_invites WHERE id = ?",
            (int(invite_id),),
        ).fetchone()
        result = cancel_invite(conn, telegram_id, int(invite_id))
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not cancel")}), 400
    if row:
        _notify_poketab_player(row["target_id"], "battle_update", {"invite_id": invite_id, "cancelled": True})
    return jsonify({"success": True})


@app.route("/api/poketab/battle/team", methods=["POST"])
def poketab_battle_team_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    invite_id = data.get("invite_id")
    card_ids = data.get("card_ids") or []
    if not invite_id:
        return jsonify({"success": False, "error": "invite_id required"}), 400
    catalog = card_catalog_for_client()
    with get_db() as conn:
        row = conn.execute(
            "SELECT challenger_id, target_id FROM poketab_battle_invites WHERE id = ?",
            (int(invite_id),),
        ).fetchone()
        result = set_team(
            conn,
            telegram_id,
            int(invite_id),
            card_ids,
            set(catalog.keys()),
            catalog,
        )
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not set team")}), 400
    if row:
        other = row["target_id"] if telegram_id == row["challenger_id"] else row["challenger_id"]
        _notify_poketab_player(
            other,
            "battle_update",
            {"invite_id": invite_id, "started": result.get("started")},
        )
        if result.get("started"):
            for uid in (row["challenger_id"], row["target_id"]):
                _notify_poketab_player(uid, "battle_start", {"invite_id": invite_id})
    return jsonify({"success": True, **result})


@app.route("/api/poketab/battle/status", methods=["POST"])
def poketab_battle_status_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    catalog = card_catalog_for_client()
    quest_player_ids: list[int] = []
    with get_db() as conn:
        payload = poketab_battle_status(conn, telegram_id, catalog)
        quest_player_ids = payload.pop("quest_player_ids", []) or []
        battle = payload.get("battle") or {}
        if battle.get("phase") == "ended":
            row = conn.execute(
                """
                SELECT stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp, quest_progress
                FROM users WHERE telegram_id = ?
                """,
                (telegram_id,),
            ).fetchone()
            if row:
                stats = trainer_stats_row(row)
                payload["trainer_stats"] = stats
                payload["level"] = stats["level"]
    notify_battle_quests(quest_player_ids)
    return jsonify({"success": True, **payload})


@app.route("/api/poketab/battle/action", methods=["POST"])
def poketab_battle_action_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    catalog = card_catalog_for_client()
    quest_player_ids: list[int] = []
    with get_db() as conn:
        result = poketab_battle_action(conn, telegram_id, catalog, data)
        quest_player_ids = result.pop("quest_player_ids", []) or []
        if result.get("ok") and result.get("battle"):
            _notify_battle_peer(result)
        if result.get("ok") and result.get("ended"):
            row = conn.execute(
                """
                SELECT stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp, quest_progress, balance
                FROM users WHERE telegram_id = ?
                """,
                (telegram_id,),
            ).fetchone()
            if row:
                stats = trainer_stats_row(row)
                result["trainer_stats"] = stats
                result["level"] = stats["level"]
                result["balance"] = int(row["balance"] or 0)
    notify_battle_quests(quest_player_ids)
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Action failed")}), 400
    return jsonify({"success": True, **result})


@app.route("/api/xp/levels")
def xp_levels_api():
    return jsonify({"success": True, **xp_config_for_client()})


@app.route("/api/quests/complete", methods=["POST"])
def complete_quest_step():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    step_id = str(data.get("step_id", "")).strip()
    quest_id = str(data.get("quest_id", "")).strip() or STEP_TO_QUEST.get(step_id, "")

    if step_id not in QUEST_STEP_IDS:
        return jsonify({"success": False, "error": "Unknown quest step"}), 400
    if quest_id and quest_id != STEP_TO_QUEST.get(step_id):
        return jsonify({"success": False, "error": "Step does not belong to quest"}), 400

    with get_db() as conn:
        result = engine_complete_quest_step(conn, telegram_id, step_id)
        if not result.get("ok"):
            err = result.get("error")
            if err == "user_not_found":
                return jsonify({"success": False, "error": "User not found"}), 404
            if err == "quest_removed":
                return jsonify({"success": False, "error": "Quest removed for this player"}), 400
            return jsonify({"success": False, "error": "Unknown quest step"}), 400
        progress = result["quest_progress"]
        trainer_stats = result.get("trainer_stats")
        if not trainer_stats:
            row = conn.execute(
                """
                SELECT stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp, quest_progress
                FROM users WHERE telegram_id = ?
                """,
                (telegram_id,),
            ).fetchone()
            if row:
                trainer_stats = trainer_stats_row(row)

    payload = {
        "success": True,
        "step_id": step_id,
        "quest_progress": progress,
        "xp_gained": result.get("xp_gained", 0),
        "leveled_up": bool(result.get("leveled_up")),
        "old_level": result.get("old_level"),
        "new_level": result.get("new_level"),
    }
    if trainer_stats:
        payload["trainer_stats"] = trainer_stats
        payload["level"] = trainer_stats["level"]
    return jsonify(payload)


@app.route("/api/quests/remove", methods=["POST"])
def remove_quest():
    """Hide a quest for this player (quest_id) — e.g. after season ends."""
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    quest_id = str(data.get("quest_id", "")).strip()
    if quest_id not in QUEST_IDS:
        return jsonify({"success": False, "error": "Unknown quest"}), 400

    now = int(time.time())
    with get_db() as conn:
        row = conn.execute(
            "SELECT quest_progress FROM users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404

        progress = parse_quest_progress(row["quest_progress"])
        if quest_id not in progress["removed_quests"]:
            progress["removed_quests"].append(quest_id)

        conn.execute(
            "UPDATE users SET quest_progress = ?, updated_at = ? WHERE telegram_id = ?",
            (json.dumps(progress), now, telegram_id),
        )

    return jsonify({"success": True, "quest_id": quest_id, "quest_progress": progress})


@app.route("/api/hold-items")
def hold_items_catalog():
    return jsonify({
        "items": hold_catalog_for_client(),
        "ui_unlocks": ui_unlocks_for_client(),
    })


@app.route("/api/holds/grant", methods=["POST"])
def grant_hold():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    item = str(data.get("item", "")).strip()
    if item not in HOLD_ITEM_IDS:
        return jsonify({"success": False, "error": "Unknown hold item"}), 400

    now = int(time.time())
    with get_db() as conn:
        row = conn.execute(
            "SELECT holds FROM users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404

        holds = parse_holds(row["holds"] if "holds" in row.keys() else None)
        newly_granted = item not in holds
        if newly_granted:
            allowed, reason = hold_grant_allowed(item, holds)
            if not allowed:
                return jsonify({"success": False, "error": reason or "Grant requirements not met"}), 403
            holds.append(item)

        conn.execute(
            "UPDATE users SET holds = ?, updated_at = ? WHERE telegram_id = ?",
            (json.dumps(holds), now, telegram_id),
        )

    return jsonify(
        {
            "success": True,
            "item": item,
            "holds": holds,
            "newly_granted": newly_granted,
            "meta": hold_item_client_meta(item),
        }
    )


@app.route("/api/gear/grant", methods=["POST"])
def grant_gear():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    item = str(data.get("item", "")).strip()
    if item not in GEAR_ITEM_IDS:
        return jsonify({"success": False, "error": "Unknown gear item"}), 400

    now = int(time.time())
    with get_db() as conn:
        row = conn.execute(
            "SELECT gear_slots FROM users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404

        slots = parse_gear_slots(row["gear_slots"] if "gear_slots" in row.keys() else None)
        slots, newly_granted = grant_gear_to_slots(slots, item)
        if not newly_granted and item not in slots:
            return jsonify({"success": False, "error": "Gear bar full"}), 409

        conn.execute(
            "UPDATE users SET gear_slots = ?, updated_at = ? WHERE telegram_id = ?",
            (json.dumps(slots), now, telegram_id),
        )

    return jsonify(
        {
            "success": True,
            "item": item,
            "gear_slots": slots,
            "newly_granted": newly_granted,
            "meta": gear_item_client_meta(item),
        }
    )


@app.route("/api/gear/remove", methods=["POST"])
def remove_gear():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    item = str(data.get("item", "")).strip()
    if item not in GEAR_ITEM_IDS:
        return jsonify({"success": False, "error": "Unknown gear item"}), 400

    now = int(time.time())
    with get_db() as conn:
        row = conn.execute(
            "SELECT gear_slots FROM users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404

        slots = parse_gear_slots(row["gear_slots"] if "gear_slots" in row.keys() else None)
        slots, removed = remove_gear_from_slots(slots, item)
        if not removed:
            return jsonify({"success": False, "error": "Item not in gear bar"}), 404

        conn.execute(
            "UPDATE users SET gear_slots = ?, updated_at = ? WHERE telegram_id = ?",
            (json.dumps(slots), now, telegram_id),
        )

    return jsonify(
        {
            "success": True,
            "item": item,
            "gear_slots": slots,
            "removed": True,
        }
    )


@app.route("/api/fishing/cast/start", methods=["POST"])
def fishing_cast_start():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    quest_key = str(data.get("quest_key") or data.get("fishing_quest_id") or "").strip()
    mode = str(data.get("mode") or "").strip()
    gear_id = str(data.get("gear_id") or "fishing_rod").strip()

    if not quest_key:
        return jsonify({"success": False, "error": "quest_key required"}), 400

    with get_db() as conn:
        result = start_fishing_cast(
            conn,
            telegram_id,
            quest_key=quest_key,
            mode=mode,
            gear_id=gear_id,
        )

    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Cast failed")}), 400

    return jsonify(
        {
            "success": True,
            "session_id": result["session_id"],
            "duration_ms": result["duration_ms"],
            "resolve_at_ms": result.get("resolve_at_ms", result["duration_ms"]),
            "status_label": result["status_label"],
            "wrong_mode": bool(result.get("wrong_mode")),
            "quest_key": result.get("quest_key"),
            "quest_progress": result.get("quest_progress"),
        }
    )


@app.route("/api/fishing/cast/complete", methods=["POST"])
def fishing_cast_complete():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    session_id = str(data.get("session_id") or "").strip()
    if not session_id:
        return jsonify({"success": False, "error": "session_id required"}), 400

    with get_db() as conn:
        result = complete_fishing_cast(conn, telegram_id, session_id=session_id)

    if not result.get("ok"):
        status = 400
        if result.get("error") == "Cast still in progress":
            status = 425
        return jsonify({"success": False, **result}), status

    payload = {
        "success": True,
        "caught": bool(result.get("caught")),
        "message": result.get("message"),
        "catch_title": result.get("catch_title"),
        "reward_gear": result.get("reward_gear"),
        "newly_granted": bool(result.get("newly_granted")),
        "gear_slots": result.get("gear_slots"),
        "quest_progress": result.get("quest_progress"),
        "quest_steps": result.get("quest_steps") or [],
        "quest_key": result.get("quest_key"),
        "show_retry_prompt": bool(result.get("show_retry_prompt")),
        "salvage_casts": result.get("salvage_casts"),
        "retry_prompt_title": result.get("retry_prompt_title"),
        "retry_prompt_message": result.get("retry_prompt_message"),
    }
    if result.get("reward_gear"):
        payload["meta"] = gear_item_client_meta(result["reward_gear"])
    return jsonify(payload)


@app.route("/api/vending/spin", methods=["POST"])
def vending_spin():
    """Charge Chips and return a random pool card for the vending shuffle."""
    import random

    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    now = int(time.time())
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT balance, vending_spins, vault FROM users WHERE telegram_id = ?
            """,
            (telegram_id,),
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404

        spins = int(row["vending_spins"] or 0)
        cost = vending_spin_cost(spins)
        balance = int(row["balance"] or 0)
        if balance < cost:
            return jsonify(
                {
                    "success": False,
                    "error": f"Need {cost:,} Chips — you have {balance:,}",
                    "balance": balance,
                    "spin_cost": cost,
                }
            ), 400

        pool = pool_items()
        if not pool:
            return jsonify({"success": False, "error": "Vending machine is empty."}), 503

        random.shuffle(pool)
        winner = random.choice(pool)
        card_id = str(winner.get("id") or "").strip()
        if not card_id:
            return jsonify({"success": False, "error": "Draw failed."}), 500

        vault = vault_for_user(row["vault"] if "vault" in row.keys() else None)
        vault, added = add_card_to_vault(vault, card_id, source="vending")

        new_balance = balance - cost
        new_spins = spins + 1
        conn.execute(
            """
            UPDATE users SET balance = ?, vending_spins = ?, vault = ?, updated_at = ?
            WHERE telegram_id = ?
            """,
            (new_balance, new_spins, json.dumps(vault), now, telegram_id),
        )

    return jsonify(
        {
            "success": True,
            "card_id": card_id,
            "card": winner,
            "added": added,
            "balance": new_balance,
            "vending_spins": new_spins,
            "spin_cost": cost,
            "next_spin_cost": vending_spin_cost(new_spins),
            "vault": vault_card_ids(vault),
            "vault_detail": vault,
        }
    )


@app.route("/api/vault/add", methods=["POST"])
def vault_add_card():
    """Add a catalog card to the player's vault (vending, quests, trades, …)."""
    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    data = request.get_json(silent=True) or {}
    card_id = str(data.get("card_id", "")).strip()
    source = str(data.get("source", "unknown")).strip()

    catalog = load_card_catalog(Path(app.root_path) / "poke.json")
    if card_id not in catalog:
        return jsonify({"success": False, "error": "Unknown card"}), 400

    now = int(time.time())
    with get_db() as conn:
        row = conn.execute(
            "SELECT vault FROM users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404

        vault = vault_for_user(row["vault"] if "vault" in row.keys() else None)
        vault, added = add_card_to_vault(vault, card_id, source=source)

        conn.execute(
            "UPDATE users SET vault = ?, updated_at = ? WHERE telegram_id = ?",
            (json.dumps(vault), now, telegram_id),
        )

    card = catalog[card_id]
    return jsonify(
        {
            "success": True,
            "added": added,
            "card_id": card_id,
            "card_name": card.get("name"),
            "vault": vault_card_ids(vault),
            "vault_detail": vault,
        }
    )


@app.route("/api/revenue-share")
def revenue_share_api():
    """Placeholder revenue-share stats — wire to on-chain / DB when ready."""
    return jsonify(
        {
            "success": True,
            "reward_pool": 0,
            "distributed": 0,
            "eligible_holders": 0,
            "entries": [],
        }
    )


@app.route("/api/trainer/stats", methods=["POST"])
def trainer_stats_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT telegram_id, display_name, username, skin, vault, balance,
                   stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp, quest_progress
            FROM users WHERE telegram_id = ?
            """,
            (telegram_id,),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "User not found"}), 404
        from poke_registry import parse_vault, valid_card_ids, vault_card_ids

        stats = trainer_stats_row(row)
        stats["display_name"] = row["display_name"]
        stats["vault_count"] = len(vault_card_ids(parse_vault(row["vault"] or "[]", valid_card_ids())))
        stats["balance"] = int(row["balance"] or 0)
        recent = conn.execute(
            """
            SELECT game_id, winner_id, loser_id, bet, source, created_at
            FROM battle_outcome_log
            WHERE winner_id = ? OR loser_id = ?
            ORDER BY created_at DESC
            LIMIT 12
            """,
            (telegram_id, telegram_id),
        ).fetchall()
        history = [
            {
                "game_id": r["game_id"],
                "won": r["winner_id"] == telegram_id,
                "bet": r["bet"],
                "source": r["source"],
                "at": r["created_at"],
            }
            for r in recent
        ]
    return jsonify({"success": True, "stats": stats, "recent_battles": history})


@app.route("/api/leaderboard", methods=["GET", "POST"])
def leaderboard_api():
    viewer_id = None
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        if request_is_test_mode(data):
            viewer_id = str((resolve_test_user(data) or build_test_user(""))["id"])
        else:
            validated = validate_init_data(data.get("initData", ""))
            if validated and "user" in validated:
                viewer_id = str(validated["user"]["id"])

    with get_db() as conn:
        payload = build_leaderboard_payload(conn, viewer_id)
    return jsonify(payload)


@app.route("/sprites/animations/manifest.json")
def animation_manifest():
    from animation_catalog import load_manifest

    return jsonify({"animations": load_manifest()})


@app.route("/sprites/<path:filename>")
def sprites(filename):
    bases = (
        Path(app.root_path) / "static/sprites",
        Path(app.root_path) / "gather-clone/frontend/public/sprites",
    )
    for base in bases:
        if (base / filename).is_file():
            return send_from_directory(base, filename)
    return jsonify({"error": "sprite not found", "path": filename}), 404


@app.route("/fonts/<path:filename>")
def fonts(filename):
    bases = (
        Path(app.root_path) / "static/fonts",
        Path(app.root_path) / "gather-clone/frontend/public/fonts",
    )
    for base in bases:
        if (base / filename).is_file():
            return send_from_directory(base, filename)
    return jsonify({"error": "font not found", "path": filename}), 404


SKIP_REQUEST_HEADERS = {
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "accept-encoding",
}
SKIP_RESPONSE_HEADERS = {"transfer-encoding", "connection", "content-encoding", "content-length"}


@app.after_request
def prevent_json_compression_mismatch(response: Response) -> Response:
    """Stop intermediaries from gzip-encoding JSON without a matching Content-Encoding."""
    if response.content_type and "json" in response.content_type:
        cache_control = response.headers.get("Cache-Control", "")
        if "no-transform" not in cache_control:
            response.headers["Cache-Control"] = f"{cache_control}, no-transform".strip(", ")
    return response


def proxy_to_game_server(path: str) -> Response:
    query = request.query_string.decode()
    url = f"{GAME_SERVER_INTERNAL.rstrip('/')}{path}"
    if query:
        url += "?" + query

    headers = {
        key: value
        for key, value in request.headers
        if key.lower() not in SKIP_REQUEST_HEADERS
    }

    body = request.get_data()
    proxy_request = urllib.request.Request(
        url, data=body or None, headers=headers, method=request.method
    )

    try:
        with urllib.request.urlopen(proxy_request, timeout=90) as upstream:
            body = upstream.read()
            encoding = upstream.headers.get("Content-Encoding", "").lower()
            if encoding == "gzip":
                body = gzip.decompress(body)

            response_headers = [
                (key, value)
                for key, value in upstream.headers.items()
                if key.lower() not in SKIP_RESPONSE_HEADERS
            ]
            return Response(body, upstream.status, response_headers)
    except urllib.error.HTTPError as err:
        body = err.read()
        encoding = err.headers.get("Content-Encoding", "").lower()
        if encoding == "gzip":
            body = gzip.decompress(body)

        response_headers = [
            (key, value)
            for key, value in err.headers.items()
            if key.lower() not in SKIP_RESPONSE_HEADERS
        ]
        return Response(body, err.code, response_headers)
    except urllib.error.URLError as err:
        return jsonify(
            {
                "message": "Game server unavailable. Run: cd game-server && npm run dev",
                "detail": str(err.reason),
            }
        ), 502


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True, "service": "web"})


@app.route("/api/status")
def api_status():
    """Debug: web + game-server connectivity (safe to hit in browser)."""
    game_ok = False
    game_detail = None
    game_body = None
    try:
        with urllib.request.urlopen(
            f"{GAME_SERVER_INTERNAL.rstrip('/')}/health", timeout=5
        ) as upstream:
            game_ok = upstream.status == 200
            game_body = json.loads(upstream.read().decode())
    except Exception as err:
        game_detail = str(err)
    web_map_hash = world_map_hash()
    game_map_hash = (game_body or {}).get("worldMapHash") if game_body else None
    maps_in_sync = bool(
        web_map_hash
        and game_map_hash
        and web_map_hash == game_map_hash
    )
    return jsonify(
        {
            "web": "ok",
            "gameServerInternal": GAME_SERVER_INTERNAL,
            "gameSocketUrl": GAME_SOCKET_URL or None,
            "gamePublicUrl": GAME_SOCKET_URL or None,
            "gameServerReachable": game_ok,
            "gameServerError": game_detail,
            "gameServerHealth": game_body,
            "worldMapPresent": WORLD_MAP_PATH.is_file(),
            "worldMapHash": web_map_hash or None,
            "worldMapVersion": world_map_version(),
            "worldMapsInSync": maps_in_sync,
            "multiplayerReady": bool(
                game_ok and GAME_SOCKET_URL and maps_in_sync
            ),
        }
    )


@app.route("/health")
def proxy_health():
    url = f"{GAME_SERVER_INTERNAL.rstrip('/')}/health"
    try:
        with urllib.request.urlopen(url, timeout=5) as upstream:
            response_headers = [
                (key, value)
                for key, value in upstream.headers.items()
                if key.lower() not in SKIP_RESPONSE_HEADERS
            ]
            return Response(upstream.read(), upstream.status, response_headers)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return jsonify(
            {
                "ok": False,
                "players": 0,
                "maxPlayers": 50,
                "world": "SaiPoke Realm",
                "rooms": 0,
                "gameServer": "unavailable",
            }
        )


@app.route("/getPlayersInRoom")
def proxy_players():
    return proxy_to_game_server("/getPlayersInRoom")


@app.route("/getOnlinePlayers")
def proxy_online_players():
    return proxy_to_game_server("/getOnlinePlayers")


@app.route("/socket.io/", defaults={"subpath": ""}, methods=["GET", "POST", "OPTIONS"])
@app.route("/socket.io/<path:subpath>", methods=["GET", "POST", "OPTIONS"])
def proxy_socketio(subpath=""):
    return proxy_to_game_server(f"/socket.io/{subpath}")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "true").lower() in ("1", "true", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug, use_reloader=debug)
