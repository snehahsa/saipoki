import random
from dataclasses import dataclass

from bot.data.catalog import get_pokemon_base, resolve_card_id
from bot.models.pokemon_base import PokemonBase
from bot.models.spell import Spell


@dataclass
class Pokemon:
    base_pokemon: PokemonBase
    spells: [Spell]
    hp: int
    shield: bool = False
    increase_dmg_by_card: bool = False  # increase_dmg_by_card for special card

    @property
    def card_id(self):
        return self.base_pokemon.card_id

    @property
    def name(self):
        return self.base_pokemon.name

    @property
    def max_hp(self):
        return self.base_pokemon.hp

    @property
    def lvl(self):
        return self.base_pokemon.lvl

    @property
    def type(self):
        return self.base_pokemon.type

    @property
    def url(self):
        return self.base_pokemon.url

    def set_shield(self):
        if self.shield:
            raise Exception("Already have shield")
        self.shield = True

    def attack_shield(self) -> bool:
        assert self.shield, "No shield"
        self.shield = False
        return random.choice((True, False))  # is attack cancelled

    def get_spell_by_name(self, spell_name: str) -> Spell:
        return next(spell for spell in self.spells if spell.name == spell_name)

    @classmethod
    def new(cls, card_id: str):
        resolved_id = resolve_card_id(card_id)
        base_pokemon = get_pokemon_base(resolved_id)
        return cls(
            base_pokemon=base_pokemon,
            hp=base_pokemon.hp,
            spells=_spells_from_remaining_count(base_pokemon)
        )

    @classmethod
    def from_mongo(cls, mongo_data):
        if not mongo_data:
            return None

        card_id = mongo_data.get("card_id") or mongo_data.get("name")
        base_pokemon = get_pokemon_base(resolve_card_id(card_id))
        return cls(
            base_pokemon=base_pokemon,
            hp=mongo_data["hp"],
            spells=_spells_from_remaining_count(base_pokemon, mongo_data["spells_remaining_count"]),
            shield=mongo_data["shield"],
            increase_dmg_by_card=mongo_data["increase_dmg_by_card"],
        )

    def to_mongo(self):
        return {
            "card_id": self.card_id,
            "name": self.name,
            "hp": self.hp,
            "spells_remaining_count": _spells_to_remaining_count(self.spells),
            "shield": self.shield,
            "increase_dmg_by_card": self.increase_dmg_by_card,
        }


def _spells_from_remaining_count(base_pokemon: PokemonBase, remaining_count: [int] = None) -> [Spell]:
    return [
        spell.with_count(remaining_count[i] if remaining_count else None)
        for i, spell in enumerate(base_pokemon.spells)
    ]


def _spells_to_remaining_count(spells: [Spell]) -> [int]:
    return [i.count for i in spells]
