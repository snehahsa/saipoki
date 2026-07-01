"""One-time NPC balance grants (e.g. Cristy's vending trial Chips)."""

from __future__ import annotations

import json
import time
from typing import Any

CRISTY_VENDING_TRIAL_AMOUNT = 1000

NPC_BALANCE_GRANTS: dict[str, dict[str, Any]] = {
    "cristy_vending_trial": {
        "amount": CRISTY_VENDING_TRIAL_AMOUNT,
        "npc_id": "npc-3",
    },
}


def parse_npc_grants(raw) -> set[str]:
    if not raw:
        return set()
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return set()
    if not isinstance(raw, list):
        return set()
    return {str(item).strip() for item in raw if str(item).strip()}


def npc_grants_json(grants: set[str]) -> str:
    return json.dumps(sorted(grants))


def grant_npc_balance(
    conn: Any,
    *,
    telegram_id: str,
    grant_id: str,
) -> tuple[bool, str, dict[str, Any]]:
    spec = NPC_BALANCE_GRANTS.get(grant_id)
    if not spec:
        return False, "Unknown reward.", {}

    row = conn.execute(
        "SELECT balance, npc_grants FROM users WHERE telegram_id = ?",
        (telegram_id,),
    ).fetchone()
    if row is None:
        return False, "User not found.", {}

    balance = int(row["balance"] if "balance" in row.keys() else 0)
    grants = parse_npc_grants(row["npc_grants"] if "npc_grants" in row.keys() else None)
    if grant_id in grants:
        return True, "", {
            "balance": balance,
            "amount": 0,
            "already_granted": True,
            "grant_id": grant_id,
        }

    amount = int(spec["amount"])
    grants.add(grant_id)
    now = int(time.time())
    new_balance = balance + amount
    conn.execute(
        """
        UPDATE users
        SET balance = ?, npc_grants = ?, updated_at = ?
        WHERE telegram_id = ?
        """,
        (new_balance, npc_grants_json(grants), now, telegram_id),
    )
    return True, "", {
        "balance": new_balance,
        "amount": amount,
        "already_granted": False,
        "grant_id": grant_id,
    }
