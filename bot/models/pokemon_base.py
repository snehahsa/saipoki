from dataclasses import dataclass

from bot.models.pokemon_types import PokemonType
from bot.models.spell import Spell


@dataclass
class PokemonBase:
    name: str
    url: str
    hp: int
    lvl: int
    type: PokemonType
    spells: list[Spell]
    card_id: str = ""
