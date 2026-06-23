"""Quest definitions — quest_id for removal; step id for per-player completion checks."""

QUEST_CATALOG = [
    {
        "quest_id": "week1_vault_trail",
        "week": 1,
        "title": "The Vault Trail",
        "blurb": (
            "Dr. Ray charted your first week in the realm — meet the professor, "
            "grab your trainer bag, claim your vault, prove your wallet, catch your first Pokémon, "
            "collect your PokéTab, battle, and debut on the market."
        ),
        "prize": "Revenue share slice + Starter Vault badge",
        "unlock_after": None,
        "steps": [
            {
                "id": "meet_dr_ray",
                "name": "Meet Dr. Ray",
                "hint": "Find Dr. Ray on patrol in the park and hear his welcome briefing",
            },
            {
                "id": "collect_trainer_bag",
                "name": "Claim Your Trainer Bag",
                "hint": "Find the box east of the spawn plaza and take your trainer bag",
            },
            {
                "id": "collect_card_vault",
                "name": "Claim Your Card Vault",
                "hint": "Return to Dr. Ray with your bag — he will give you a PokéCard Vault",
            },
            {
                "id": "verify_wallet",
                "name": "Verify Your Wallet",
                "hint": "Link and verify your wallet so the realm knows it's you",
            },
            {
                "id": "collect_first_card",
                "name": "Catch Your First Pokémon",
                "hint": "Draw your first card from the vending machine (1,000 $POKE) into your vault",
            },
            {
                "id": "collect_poketab",
                "name": "Collect Your PokéTab",
                "hint": "Visit the PokéHub Manager and claim your PokéTab",
            },
            {
                "id": "battle_game",
                "name": "Fight Your First Battle",
                "hint": "In the battle group, post /battle 50 and finish the match",
            },
            {
                "id": "list_card_sale",
                "name": "List a Card for Sale",
                "hint": "Pin a PokéCard to the market board and set your price",
            },
        ],
    },
    {
        "quest_id": "week2_storm_den",
        "week": 2,
        "title": "Zaptail's Storm Den",
        "blurb": "Thunder crackles over Route 7. A yellow-tailed spark beast nests in the old windmill…",
        "prize": "Storm Den badge + bonus revenue",
        "unlock_after": "week1_vault_trail",
        "steps": [],
    },
    {
        "quest_id": "week3_tide_cave",
        "week": 3,
        "title": "Bubblefin's Tide Cave",
        "blurb": "Tide pools glow blue at dusk. Something round and finned splashes deeper inside…",
        "prize": "Tide Cave badge + bonus revenue",
        "unlock_after": "week2_storm_den",
        "steps": [],
    },
    {
        "quest_id": "week4_ridge_run",
        "week": 4,
        "title": "Embercrest Ridge Run",
        "blurb": "Smoke curls from the ridge. A flame-tipped runner leaves scorch marks on the trail…",
        "prize": "Ridge Run badge + bonus revenue",
        "unlock_after": "week3_tide_cave",
        "steps": [],
    },
]

QUEST_STEP_IDS = {
    step["id"]
    for quest in QUEST_CATALOG
    for step in quest.get("steps", [])
}

QUEST_IDS = {q["quest_id"] for q in QUEST_CATALOG}

STEP_TO_QUEST = {
    step["id"]: quest["quest_id"]
    for quest in QUEST_CATALOG
    for step in quest.get("steps", [])
}

# External completion triggers (Telegram bot, future webhooks, …) → quest step ids.
QUEST_TRIGGERS: dict[str, list[str]] = {
    "telegram_battle_finished": ["battle_game"],
}
