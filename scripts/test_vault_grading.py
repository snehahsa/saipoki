#!/usr/bin/env python3
"""Unit tests for Poké Vault grading."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from poke_registry import add_card_to_vault, parse_vault  # noqa: E402
from vault_grading import (  # noqa: E402
    MAX_GRADE,
    merge_vaults,
    mint_card_into_vault,
    upgrade_card_in_vault,
)


def test_first_mint_creates_stack():
    vault, info = mint_card_into_vault([], "poke-001", source="vending")
    assert len(vault) == 1
    assert vault[0]["grade"] == 1
    assert vault[0]["copies"] == 0
    assert info["is_duplicate"] is False


def test_three_duplicates_auto_silver():
    vault: list = []
    for _ in range(3):
        vault, info = mint_card_into_vault(vault, "poke-001", source="vending")
    assert vault[0]["grade"] == 2
    assert vault[0]["copies"] == 0
    assert info["grade_changed"] is True


def test_manual_upgrade_gold_needs_four_copies():
    vault, _ = mint_card_into_vault([], "poke-002", source="vending")
    for _ in range(2):
        vault, _ = mint_card_into_vault(vault, "poke-002", source="vending")
    assert vault[0]["grade"] == 2

    for _ in range(3):
        vault, _ = mint_card_into_vault(vault, "poke-002", source="vending")
    vault, fail = upgrade_card_in_vault(vault, "poke-002")
    assert fail["success"] is False

    vault, _ = mint_card_into_vault(vault, "poke-002", source="vending")
    vault, ok = upgrade_card_in_vault(vault, "poke-002")
    assert ok["success"] is True
    assert vault[0]["grade"] == 3


def test_legacy_vault_migration_counts_duplicates():
    raw = ["poke-003", "poke-003", "poke-003"]
    vault = parse_vault(raw, frozenset({"poke-003"}))
    assert len(vault) == 1
    assert vault[0]["grade"] == 2
    assert vault[0]["copies"] == 0


def test_add_card_to_vault_api_shape():
    vault, info = add_card_to_vault([], "poke-004", source="quest")
    assert info["added"] is True
    vault, info = add_card_to_vault(vault, "poke-004", source="vending")
    assert info["is_duplicate"] is True


def test_merge_vaults_combines_copies():
    a, _ = mint_card_into_vault([], "poke-005", source="vending")
    for _ in range(2):
        a, _ = mint_card_into_vault(a, "poke-005", source="vending")
    assert a[0]["grade"] == 2
    a, _ = mint_card_into_vault(a, "poke-005", source="vending")
    b, _ = mint_card_into_vault([], "poke-006", source="vending")
    merged = merge_vaults(a, b)
    assert len(merged) == 2
    poke5 = next(s for s in merged if s["card_id"] == "poke-005")
    assert poke5["copies"] == 1


def run():
    tests = [
        test_first_mint_creates_stack,
        test_three_duplicates_auto_silver,
        test_manual_upgrade_gold_needs_four_copies,
        test_legacy_vault_migration_counts_duplicates,
        test_add_card_to_vault_api_shape,
        test_merge_vaults_combines_copies,
    ]
    for fn in tests:
        fn()
        print(f"ok {fn.__name__}")
    print(f"All {len(tests)} vault grading tests passed (max grade {MAX_GRADE}).")


if __name__ == "__main__":
    run()
