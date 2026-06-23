import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qsl

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, send_from_directory

from flow_catalog import (
    HOLD_ITEMS,
    HOLD_ITEM_IDS,
    hold_catalog_for_client,
    hold_grant_allowed,
    hold_item_client_meta,
    ui_unlocks_for_client,
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
from avatar_economy import (
    DEFAULT_SKIN as AVATAR_DEFAULT_SKIN,
    STARTING_BALANCE,
    VENDING_SPIN_FIRST_COST,
    VENDING_SPIN_REPEAT_COST,
    load_avatar_costs_from_map,
    owned_skins_json,
    parse_owned_skins,
    purchase_cost,
    skin_list_price,
    vending_spin_cost,
)
from leaderboard import build_leaderboard_payload
from trainer_stats import ensure_trainer_stats_schema, trainer_stats_row, xp_progress
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
    ensure_schema as ensure_poketab_battle_schema,
    get_status as poketab_battle_status,
    perform_action as poketab_battle_action,
    respond_invite,
    send_challenge,
    set_team,
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
TEST_PLAYER_HOLDS = ["bag", "card_vault", "poketab"]
TEST_QUERY_RESERVED = frozenset({"tgWebAppStartParam", "v", "_"})
GAME_SERVER_INTERNAL = os.getenv(
    "GAME_SERVER_INTERNAL",
    os.getenv("GAME_SERVER_URL", "http://127.0.0.1:3001"),
).rstrip("/")
PUBLIC_WEBAPP_URL = (os.getenv("WEBAPP_URL") or os.getenv("RAILWAY_PUBLIC_DOMAIN") or "").strip()
if PUBLIC_WEBAPP_URL and not PUBLIC_WEBAPP_URL.startswith("http"):
    PUBLIC_WEBAPP_URL = f"https://{PUBLIC_WEBAPP_URL}"
if PUBLIC_WEBAPP_URL and not PUBLIC_WEBAPP_URL.endswith("/"):
    PUBLIC_WEBAPP_URL = f"{PUBLIC_WEBAPP_URL}/"
WORLD_MAP_PATH = Path(__file__).resolve().parent / "gather-clone/frontend/utils/defaultmap.json"

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


def valid_card_ids() -> frozenset[str]:
    from poke_registry import valid_card_ids as catalog_ids
    return catalog_ids(Path(app.root_path) / "poke.json")


def vault_for_user(raw) -> list[dict]:
    return parse_vault(raw, valid_card_ids())


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


def landing_gif_url() -> Optional[str]:
    """Resolve /static/giffiles/2 — any supported extension."""
    gif_dir = Path(app.root_path) / "static/giffiles"
    for ext in GIF_EXTENSIONS:
        path = gif_dir / f"2{ext}"
        if path.is_file():
            return f"/static/giffiles/2{ext}?v={int(path.stat().st_mtime)}"
    return None


def landing_pool_cards() -> list:
    return [
        {"id": item["id"], "name": item["name"], "src": item["src"]}
        for item in pool_items()
    ]


def landing_play_steps() -> list:
    """Quick-start steps for the landing page how-to-play panel."""
    return [
        {
            "title": "1 · Open the bot",
            "text": "Tap Play Now and send /start in DM.",
            "icon": "bot",
        },
        {
            "title": "2 · Build your trainer",
            "text": "Set a PIN, pick an avatar, name your hero.",
            "icon": "trainer",
        },
        {
            "title": "3 · Roam the realm",
            "text": "Use the D-pad, talk to NPCs, read signs & boards.",
            "icon": "roam",
        },
        {
            "title": "4 · Battle in group",
            "text": "Run /battle 50 to wager $POKECARD tokens.",
            "icon": "battle",
        },
        {
            "title": "5 · Rank up",
            "text": "Complete quests, grow your vault, climb the live leaderboard.",
            "icon": "rank",
        },
    ]


def landing_hold_items() -> list:
    """Gear rows for the landing page hidden-items panel."""
    specs = [
        (
            "bag",
            "Trainer Bag",
            "Hidden near the Nova City plaza — your first quest pickup.",
        ),
        (
            "card_vault",
            "Poké Vault",
            "Gift from Dr. Ray once you have your bag; stores every PokéCard you mint.",
        ),
        (
            "poketab",
            "PokéTab",
            "Claim it from the PokéHub Manager to chat and battle trainers worldwide.",
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


@app.route("/landing")
def landing_page():
    return render_template(
        "landing.html",
        play_url=telegram_play_url(),
        bot_username=telegram_bot_username(),
        starting_balance=STARTING_BALANCE,
        pool_cards=landing_pool_cards(),
        showcase_cards=landing_pool_cards()[:3],
        hold_items=landing_hold_items(),
        play_steps=landing_play_steps(),
        gif_url=landing_gif_url(),
        asset_v={
            "landing_css": asset_version("static/css/landing.css"),
            "landing_js": asset_version("static/js/landing.js"),
            "retro_audio_js": asset_version("static/js/retro-audio.js"),
            "titles": asset_version("static/imgs/titles.png"),
        },
    )


@app.route("/")
def home():
    test_slug = parse_test_slug_from_query_args(request.args)
    test_mode = test_slug is not None
    return render_template(
        "index.html",
        game_server_url="",
        test_mode=test_mode,
        test_player_slug=test_slug if test_slug is not None else "",
        skins=SKINS,
        default_skin=DEFAULT_SKIN,
        asset_v={
            "css": asset_version("static/css/app.css"),
            "app_js": asset_version("static/js/app.js"),
            "retro_audio_js": asset_version("static/js/retro-audio.js"),
            "game_js": asset_version("static/game/game.js"),
            "world": world_map_version(),
            "titles": asset_version("static/imgs/titles.png"),
            "bag_icon": asset_version("static/menuitems/bag.png"),
            "dex_icon": asset_version("static/menuitems/dex.png"),
            "phone_icon": asset_version("static/menuitems/phone.png"),
        },
        bag_items=bag_items(),
        pool_items=pool_items(),
        card_catalog=card_catalog_for_client(),
        bag_slot_count=BAG_SLOT_COUNT,
        quests=QUEST_CATALOG,
        hold_catalog=hold_catalog_for_client(),
        ui_unlocks=ui_unlocks_for_client(),
        avatar_costs=load_avatar_costs_from_map(WORLD_MAP_PATH),
        starting_balance=STARTING_BALANCE,
        vending_spin_first_cost=VENDING_SPIN_FIRST_COST,
        vending_spin_repeat_cost=VENDING_SPIN_REPEAT_COST,
    )


@app.route("/api/world")
def world_map():
    if not WORLD_MAP_PATH.exists():
        return jsonify({"error": "World map not found"}), 404

    response = send_from_directory(
        WORLD_MAP_PATH.parent,
        WORLD_MAP_PATH.name,
        mimetype="application/json",
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["X-World-Version"] = world_map_version()
    return response


@app.route("/api/auth", methods=["POST"])
def auth():
    data = request.get_json(silent=True) or {}

    if request_is_test_mode(data):
        validated = {"user": resolve_test_user(data) or build_test_user("")}
    else:
        init_data = data.get("initData", "")
        validated = validate_init_data(init_data)
        if not validated or "user" not in validated:
            return jsonify({"success": False, "error": (
                    "Invalid Telegram session. Open this app from the PokéCards bot "
                    "(send /start in DM, then tap Open Web App)."
                )}), 401

    user = validated["user"]
    telegram_id = str(user["id"])
    display_name = display_name_from_user(user)
    username = user.get("username") or ""
    now = int(time.time())

    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()

        if row is None:
            is_test = request_is_test_mode(data)
            starting_balance = STARTING_BALANCE
            conn.execute(
                """
                INSERT INTO users (
                    telegram_id, username, display_name, skin, badges, quest_progress,
                    holds, vault, balance, owned_skins, pin, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, '[]', '{"completed_steps":[],"removed_quests":[]}', ?, '[]', ?, ?, ?, ?, ?)
                """,
                (
                    telegram_id,
                    username,
                    display_name,
                    AVATAR_DEFAULT_SKIN if is_test else None,
                    json.dumps(TEST_PLAYER_HOLDS) if is_test else "[]",
                    starting_balance,
                    owned_skins_json([AVATAR_DEFAULT_SKIN]),
                    "123" if is_test else None,
                    now,
                    now,
                ),
            )
            skin = AVATAR_DEFAULT_SKIN if is_test else None
            badges = []
            holds = TEST_PLAYER_HOLDS if is_test else []
            vault = []
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
            vault = vault_for_user(row["vault"] if "vault" in row.keys() else None)
            balance = int(row["balance"] if "balance" in row.keys() else 0)
            vending_spins = int(row["vending_spins"] if "vending_spins" in row.keys() else 0)
            owned_skins = parse_owned_skins(
                row["owned_skins"] if "owned_skins" in row.keys() else None,
                row["skin"],
            )
            if balance == 0 and row["skin"] is None:
                conn.execute(
                    """
                    UPDATE users SET balance = ?, updated_at = ?
                    WHERE telegram_id = ? AND balance = 0
                    """,
                    (STARTING_BALANCE, now, telegram_id),
                )
                balance = STARTING_BALANCE
            user_pin = row["pin"] if "pin" in row.keys() else None
            backfill_quest_triggers(conn, telegram_id)
            row_after = conn.execute(
                "SELECT quest_progress FROM users WHERE telegram_id = ?",
                (telegram_id,),
            ).fetchone()
            if row_after:
                quest_progress = parse_quest_progress(row_after["quest_progress"])

    avatar_costs = load_avatar_costs_from_map(WORLD_MAP_PATH)

    trainer_stats = None
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp, vault, balance
            FROM users WHERE telegram_id = ?
            """,
            (telegram_id,),
        ).fetchone()
        if row:
            trainer_stats = trainer_stats_row(row)
            trainer_stats["vault_count"] = len(vault_card_ids(vault))
            trainer_stats["balance"] = balance

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
            "level": trainer_stats["level"] if trainer_stats else 1,
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
    init_data = data.get("initData", "")
    skin = data.get("skin")
    display_name_raw = data.get("displayName")

    validated = validate_init_data(init_data)
    if not validated or "user" not in validated:
        return jsonify({"success": False, "error": (
                "Invalid Telegram session. Open this app from the PokéCards bot "
                "(send /start in DM, then tap Open Web App)."
            )}), 401

    if skin not in SKINS:
        return jsonify({"success": False, "error": "Invalid skin"}), 400

    display_name = None
    if display_name_raw is not None and str(display_name_raw).strip():
        display_name = normalize_player_name(display_name_raw)
        if display_name is None:
            return jsonify({"success": False, "error": "Enter a name (1–24 characters)"}), 400

    telegram_id = str(validated["user"]["id"])
    now = int(time.time())
    avatar_costs = load_avatar_costs_from_map(WORLD_MAP_PATH)

    with get_db() as conn:
        row = conn.execute(
            "SELECT display_name, skin, balance, owned_skins FROM users WHERE telegram_id = ?",
            (telegram_id,),
        ).fetchone()
        if row is None:
            return jsonify({"success": False, "error": "User not found"}), 404

        balance = int(row["balance"] or 0)
        owned_skins = parse_owned_skins(row["owned_skins"], row["skin"])
        cost = purchase_cost(skin, owned_skins, avatar_costs)

        if cost > balance:
            price = skin_list_price(skin, avatar_costs)
            return jsonify(
                {
                    "success": False,
                    "error": f"Need {price:,} coins — you have {balance:,}",
                    "balance": balance,
                    "cost": cost,
                    "price": price,
                }
            ), 402

        if cost > 0:
            balance -= cost

        if skin not in owned_skins:
            owned_skins = list(dict.fromkeys([*owned_skins, skin]))

        if display_name is not None:
            conn.execute(
                """
                UPDATE users
                SET skin = ?, display_name = ?, balance = ?, owned_skins = ?, updated_at = ?
                WHERE telegram_id = ?
                """,
                (skin, display_name, balance, owned_skins_json(owned_skins), now, telegram_id),
            )
        else:
            conn.execute(
                """
                UPDATE users
                SET skin = ?, balance = ?, owned_skins = ?, updated_at = ?
                WHERE telegram_id = ?
                """,
                (skin, balance, owned_skins_json(owned_skins), now, telegram_id),
            )
            display_name = row["display_name"] or display_name_from_user(validated["user"])

    return jsonify(
        {
            "success": True,
            "skin": skin,
            "display_name": display_name,
            "balance": balance,
            "owned_skins": owned_skins,
            "cost_paid": cost,
        }
    )


def _auth_user_from_request():
    data = request.get_json(silent=True) or {}
    if request_is_test_mode(data):
        user = resolve_test_user(data) or build_test_user("")
        return str(user["id"]), None

    init_data = data.get("initData", "")
    validated = validate_init_data(init_data)
    if not validated or "user" not in validated:
        return None, (jsonify({"success": False, "error": (
                "Invalid Telegram session. Open this app from the PokéCards bot "
                "(send /start in DM, then tap Open Web App)."
            )}), 401)
    return str(validated["user"]["id"]), None


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
        return jsonify({"success": True, "opponents": opponents, "balance": my_balance})
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
        )
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Could not respond")}), 400
    if row:
        _notify_poketab_player(
            row["challenger_id"],
            "battle_update",
            {"invite_id": invite_id, "accepted": result.get("accepted")},
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
    with get_db() as conn:
        payload = poketab_battle_status(conn, telegram_id, catalog)
    return jsonify({"success": True, **payload})


@app.route("/api/poketab/battle/action", methods=["POST"])
def poketab_battle_action_api():
    telegram_id, err = _auth_user_from_request()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    catalog = card_catalog_for_client()
    with get_db() as conn:
        result = poketab_battle_action(conn, telegram_id, catalog, data)
        other_id = None
        if result.get("ok") and result.get("battle"):
            other_id = str(result["battle"].get("opponent", {}).get("id", ""))
    if not result.get("ok"):
        return jsonify({"success": False, "error": result.get("error", "Action failed")}), 400
    if other_id and other_id != telegram_id:
        _notify_poketab_player(
            other_id,
            "battle_update",
            {"game_id": data.get("game_id"), "ended": result.get("ended")},
        )
    return jsonify({"success": True, **result})


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

    return jsonify({"success": True, "step_id": step_id, "quest_progress": progress})


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


@app.route("/api/vending/spin", methods=["POST"])
def vending_spin():
    """Charge coins and return a random pool card for the vending shuffle."""
    import random

    telegram_id, err = _auth_user_from_request()
    if err:
        return err

    now = int(time.time())
    with get_db() as conn:
        row = conn.execute(
            "SELECT balance, vending_spins FROM users WHERE telegram_id = ?",
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
                    "error": f"Need {cost:,} coins — you have {balance:,}",
                    "balance": balance,
                    "spin_cost": cost,
                }
            ), 400

        pool = pool_items()
        if not pool:
            return jsonify({"success": False, "error": "Vending machine is empty."}), 503

        winner = random.choice(pool)
        card_id = str(winner.get("id") or "").strip()
        if not card_id:
            return jsonify({"success": False, "error": "Draw failed."}), 500

        new_balance = balance - cost
        new_spins = spins + 1
        conn.execute(
            """
            UPDATE users SET balance = ?, vending_spins = ?, updated_at = ?
            WHERE telegram_id = ?
            """,
            (new_balance, new_spins, now, telegram_id),
        )

    return jsonify(
        {
            "success": True,
            "card_id": card_id,
            "card": winner,
            "balance": new_balance,
            "vending_spins": new_spins,
            "spin_cost": cost,
            "next_spin_cost": vending_spin_cost(new_spins),
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
                   stats_wagered, stats_battles, stats_wins, stats_losses, stats_xp
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


SKIP_REQUEST_HEADERS = {"host", "content-length", "transfer-encoding", "connection"}
SKIP_RESPONSE_HEADERS = {"transfer-encoding", "connection", "content-encoding", "content-length"}


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
            response_headers = [
                (key, value)
                for key, value in upstream.headers.items()
                if key.lower() not in SKIP_RESPONSE_HEADERS
            ]
            return Response(upstream.read(), upstream.status, response_headers)
    except urllib.error.HTTPError as err:
        response_headers = [
            (key, value)
            for key, value in err.headers.items()
            if key.lower() not in SKIP_RESPONSE_HEADERS
        ]
        return Response(err.read(), err.code, response_headers)
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


@app.route("/health")
def proxy_health():
    return proxy_to_game_server("/health")


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
