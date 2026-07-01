"""Quest definitions — quest_id for removal; step id for per-player completion checks."""

QUEST_CATALOG = [
    {
        "quest_id": "week1_vault_trail",
        "week": 1,
        "title": "The Vault Trail",
        "blurb": (
            "Dr. Ray charted your first week in the realm — meet the professor, "
            "gear up, fill your vault, help the PokéHub Manager, and earn your first battle."
        ),
        "prize": "Revenue share slice + Starter Vault badge",
        "unlock_after": None,
        "steps": [
            {
                "id": "meet_dr_ray",
                "name": "Meet Dr. Ray",
                "hint": "Someone in the park has a briefing for new trainers.",
            },
            {
                "id": "collect_trainer_bag",
                "name": "Claim Your Trainer Bag",
                "hint": "You'll need gear before you wander far.",
            },
            {
                "id": "collect_card_vault",
                "name": "Claim Your Card Vault",
                "hint": "The professor may have more once you're equipped.",
            },
            {
                "id": "collect_first_card",
                "name": "Catch Your First Pokémon",
                "hint": "Cards don't collect themselves.",
            },
            {
                "id": "meet_pokehub_manager",
                "name": "Meet the PokéHub Manager",
                "hint": "There's a hub beyond the portal worth visiting.",
            },
            {
                "id": "manager_lost_key",
                "name": "The Manager's Lost Key",
                "hint": "The Manager has a problem — and a proposition.",
            },
            {
                "id": "fish_for_hub_key",
                "name": "Fish for the Lost Key",
                "hint": "Something valuable sank near the water.",
            },
            {
                "id": "collect_hub_key",
                "name": "Hook the PokéHub Key",
                "hint": "Patience and the right spot matter.",
            },
            {
                "id": "collect_poketab",
                "name": "Collect Your PokéTab",
                "hint": "A debt repaid sometimes earns a reward.",
            },
            {
                "id": "battle_game",
                "name": "Fight Your First Battle",
                "hint": "Find a worthy opponent and see it through.",
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
