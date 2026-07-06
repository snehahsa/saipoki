"""Poké Vault grading — duplicate mints bank copies toward grade upgrades."""

from __future__ import annotations

import time
from typing import Any

MAX_GRADE = 5

# Copies required to advance FROM grade N → N+1 (escalating commitment).
GRADE_UPGRADE_COST: dict[int, int] = {1: 3, 2: 4, 3: 5, 4: 6}

GRADE_MULTIPLIER: dict[int, float] = {
    1: 1.0,
    2: 1.22,
    3: 1.48,
    4: 1.78,
    5: 2.15,
}

GRADE_LABELS: dict[int, str] = {
    1: "Standard",
    2: "Silver",
    3: "Gold",
    4: "Platinum",
    5: "Mythic",
}


def grading_config_for_client() -> dict[str, Any]:
    return {
        "max_grade": MAX_GRADE,
        "upgrade_costs": dict(GRADE_UPGRADE_COST),
        "multipliers": dict(GRADE_MULTIPLIER),
        "labels": dict(GRADE_LABELS),
    }


def grade_multiplier(grade: int) -> float:
    grade = max(1, min(int(grade or 1), MAX_GRADE))
    return GRADE_MULTIPLIER.get(grade, 1.0)


def upgrade_cost_for_grade(grade: int) -> int | None:
    grade = int(grade or 1)
    if grade >= MAX_GRADE:
        return None
    return GRADE_UPGRADE_COST.get(grade, 3)


def _clamp_grade(grade: int) -> int:
    return max(1, min(int(grade or 1), MAX_GRADE))


def empty_stack(
    card_id: str,
    *,
    source: str = "unknown",
    acquired_at: int | None = None,
) -> dict[str, Any]:
    now = int(time.time())
    return {
        "card_id": card_id,
        "grade": 1,
        "copies": 0,
        "total_minted": 0,
        "acquired_at": int(acquired_at or now),
        "source": source,
        "upgraded_at": 0,
    }


def normalize_stack(entry: dict[str, Any], *, card_id: str | None = None) -> dict[str, Any]:
    cid = str(card_id or entry.get("card_id") or entry.get("id") or "").strip()
    stack = empty_stack(
        cid,
        source=str(entry.get("source") or "unknown"),
        acquired_at=int(entry.get("acquired_at") or 0) or None,
    )
    stack["grade"] = _clamp_grade(entry.get("grade") or 1)
    stack["copies"] = max(0, int(entry.get("copies") or 0))
    stack["total_minted"] = max(
        int(entry.get("total_minted") or 0),
        stack["copies"] + (1 if stack["grade"] >= 1 else 0),
        1 if stack["grade"] > 1 or stack["copies"] > 0 else 0,
    )
    stack["upgraded_at"] = int(entry.get("upgraded_at") or 0)
    return stack


def stack_progress(stack: dict[str, Any]) -> dict[str, Any]:
    grade = _clamp_grade(stack.get("grade") or 1)
    copies = max(0, int(stack.get("copies") or 0))
    total_minted = max(0, int(stack.get("total_minted") or 0))
    cost = upgrade_cost_for_grade(grade)
    at_max = grade >= MAX_GRADE

    if at_max or cost is None:
        progress = 1.0
        can_upgrade = False
    elif grade == 1:
        progress = min(1.0, total_minted / cost) if cost > 0 else 0.0
        can_upgrade = False
    else:
        progress = min(1.0, copies / cost) if cost > 0 else 0.0
        can_upgrade = copies >= cost

    return {
        "grade": grade,
        "copies": copies,
        "total_minted": total_minted,
        "next_cost": cost,
        "progress": round(progress, 4),
        "can_upgrade": can_upgrade,
        "multiplier": grade_multiplier(grade),
        "grade_label": GRADE_LABELS.get(grade, "Standard"),
        "at_max_grade": at_max,
        "auto_promote_ready": grade == 1 and total_minted >= (cost or 3),
    }


def enrich_stack(stack: dict[str, Any]) -> dict[str, Any]:
    merged = dict(stack)
    merged.update(stack_progress(stack))
    return merged


def try_auto_promote_grade_two(stack: dict[str, Any]) -> bool:
    """First tier: three total mints of the same species forge Silver (grade 2)."""
    if _clamp_grade(stack.get("grade") or 1) != 1:
        return False
    cost = GRADE_UPGRADE_COST[1]
    total_minted = int(stack.get("total_minted") or 0)
    if total_minted < cost:
        return False
    stack["grade"] = 2
    stack["upgraded_at"] = int(time.time())
    return True


def upgrade_stack_manual(stack: dict[str, Any]) -> tuple[bool, str]:
    grade = _clamp_grade(stack.get("grade") or 1)
    if grade >= MAX_GRADE:
        return False, "max_grade"

    if grade == 1:
        if try_auto_promote_grade_two(stack):
            return True, "auto_promoted"
        return False, "insufficient_copies"

    cost = upgrade_cost_for_grade(grade)
    if cost is None:
        return False, "max_grade"
    copies = int(stack.get("copies") or 0)
    if copies < cost:
        return False, "insufficient_copies"

    stack["copies"] = copies - cost
    stack["grade"] = grade + 1
    stack["upgraded_at"] = int(time.time())
    return True, "upgraded"


def _find_stack_index(vault: list[dict[str, Any]], card_id: str) -> int:
    for idx, entry in enumerate(vault):
        if str(entry.get("card_id") or "").strip() == card_id:
            return idx
    return -1


def mint_result_payload(
    stack: dict[str, Any],
    *,
    is_duplicate: bool,
    grade_changed: bool,
    previous_grade: int,
    reason: str = "minted",
) -> dict[str, Any]:
    prog = stack_progress(stack)
    return {
        "added": True,
        "is_duplicate": is_duplicate,
        "card_id": stack.get("card_id"),
        "grade": prog["grade"],
        "previous_grade": previous_grade,
        "grade_changed": grade_changed,
        "copies": prog["copies"],
        "total_minted": prog["total_minted"],
        "multiplier": prog["multiplier"],
        "grade_label": prog["grade_label"],
        "next_cost": prog["next_cost"],
        "progress": prog["progress"],
        "can_upgrade": prog["can_upgrade"],
        "auto_promote_ready": prog["auto_promote_ready"],
        "reason": reason,
    }


def mint_card_into_vault(
    vault: list[dict[str, Any]],
    card_id: str,
    *,
    source: str = "unknown",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    card_id = str(card_id or "").strip()
    if not card_id:
        return vault, {"added": False, "error": "invalid_card"}

    updated = [dict(entry) for entry in vault]
    idx = _find_stack_index(updated, card_id)
    now = int(time.time())

    if idx < 0:
        stack = empty_stack(card_id, source=source, acquired_at=now)
        stack["total_minted"] = 1
        updated.append(stack)
        return updated, mint_result_payload(
            stack,
            is_duplicate=False,
            grade_changed=False,
            previous_grade=1,
        )

    stack = updated[idx]
    previous_grade = _clamp_grade(stack.get("grade") or 1)
    stack["total_minted"] = int(stack.get("total_minted") or 0) + 1
    if _clamp_grade(stack.get("grade") or 1) >= 2:
        stack["copies"] = int(stack.get("copies") or 0) + 1
    grade_changed = try_auto_promote_grade_two(stack)
    updated[idx] = stack

    return updated, mint_result_payload(
        stack,
        is_duplicate=True,
        grade_changed=grade_changed,
        previous_grade=previous_grade,
    )


def upgrade_card_in_vault(
    vault: list[dict[str, Any]],
    card_id: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    card_id = str(card_id or "").strip()
    updated = [dict(entry) for entry in vault]
    idx = _find_stack_index(updated, card_id)
    if idx < 0:
        return vault, {"success": False, "error": "card_not_in_vault"}

    stack = updated[idx]
    previous_grade = _clamp_grade(stack.get("grade") or 1)
    ok, reason = upgrade_stack_manual(stack)
    if not ok:
        prog = stack_progress(stack)
        return vault, {
            "success": False,
            "error": reason,
            "card_id": card_id,
            "grade": prog["grade"],
            "copies": prog["copies"],
            "next_cost": prog["next_cost"],
            "progress": prog["progress"],
            "can_upgrade": prog["can_upgrade"],
        }

    updated[idx] = stack
    prog = stack_progress(stack)
    return updated, {
        "success": True,
        "reason": reason,
        "card_id": card_id,
        "grade": prog["grade"],
        "previous_grade": previous_grade,
        "grade_changed": prog["grade"] != previous_grade,
        "copies": prog["copies"],
        "total_minted": prog["total_minted"],
        "multiplier": prog["multiplier"],
        "grade_label": prog["grade_label"],
        "next_cost": prog["next_cost"],
        "progress": prog["progress"],
        "can_upgrade": prog["can_upgrade"],
        "at_max_grade": prog["at_max_grade"],
    }


def merge_stacks(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    left = normalize_stack(a)
    right = normalize_stack(b)
    card_id = left["card_id"] or right["card_id"]
    merged = empty_stack(
        card_id,
        source=left.get("source") or right.get("source") or "unknown",
        acquired_at=min(
            int(left.get("acquired_at") or 0) or int(time.time()),
            int(right.get("acquired_at") or 0) or int(time.time()),
        ),
    )
    merged["grade"] = max(_clamp_grade(left.get("grade")), _clamp_grade(right.get("grade")))
    merged["copies"] = int(left.get("copies") or 0) + int(right.get("copies") or 0)
    merged["total_minted"] = int(left.get("total_minted") or 0) + int(right.get("total_minted") or 0)
    merged["upgraded_at"] = max(int(left.get("upgraded_at") or 0), int(right.get("upgraded_at") or 0))
    try_auto_promote_grade_two(merged)
    return merged


def merge_vaults(*vaults: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for vault in vaults:
        for entry in vault or []:
            cid = str(entry.get("card_id") or "").strip()
            if not cid:
                continue
            if cid in by_id:
                by_id[cid] = merge_stacks(by_id[cid], entry)
            else:
                by_id[cid] = normalize_stack(entry, card_id=cid)
    result = list(by_id.values())
    result.sort(key=lambda e: (e.get("acquired_at") or 0, e.get("card_id") or ""))
    return result


def vault_detail_for_client(vault: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [enrich_stack(entry) for entry in vault]
