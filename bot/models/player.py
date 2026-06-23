import random
import time
from dataclasses import dataclass
from typing import Optional, Union

from aiogram.types import Chat, User
from aiogram.utils import markdown
from aiogram.utils.link import create_tg_link

from bot.data import const
from bot.data.catalog import migrate_pool_keys, resolve_card_id
from bot.data.const import REVIVE_HP, SLEEPING_COUNTER
from bot.data.special_cards import SPECIAL_CARDS
from bot.models.pokemon import Pokemon


@dataclass
class Player:
    id: int  # telegram user id
    name: str  # user first name

    pokemons_pool: dict  # card_id => is_alive; vault cards available in battle
    last_move_time: float  # unix time of last meaningful move (successful attack)
    pokemon: Optional[Pokemon] = None   # active pokemon

    special_card: Optional[str] = None  # special card name
    sleeping_pills_counter: [int] = None  # sleeping_pills_counter for sleeping pills
    revived_pokemon: Optional[str] = None  # card_id revived by special card

    def select_pokemon(self, card_id: str):
        assert self.pokemon is None, "pokemon already selected"
        resolved_id = resolve_card_id(card_id)
        if resolved_id not in self.pokemons_pool or not self.pokemons_pool[resolved_id]:
            raise ValueError(f"PokéCard not in vault: {resolved_id}")
        self.pokemon = Pokemon.new(resolved_id)

        # revived pokemon will have 30% more hp
        if self.revived_pokemon and resolve_card_id(self.revived_pokemon) == resolved_id:
            self.pokemon.hp = self.pokemon.max_hp * REVIVE_HP

    def attack_pokemon(self, dmg):
        self.pokemon.hp -= dmg
        if self.pokemon.hp > 0:
            return None

        # pokemon dead
        pokemon = self.pokemon
        self.pokemons_pool[pokemon.card_id] = False  # mark pokemon as dead
        self.pokemon = None
        return pokemon

    def revive_pokemon(self, card_id: str):
        resolved_id = resolve_card_id(card_id)
        self.pokemons_pool[resolved_id] = True
        self.revived_pokemon = resolved_id

    def set_sleeping_pills(self):
        self.sleeping_pills_counter = SLEEPING_COUNTER

    def decrease_sleeping_pills(self):
        self.sleeping_pills_counter -= 1
        if self.sleeping_pills_counter == 0:
            self.sleeping_pills_counter = None

    def get_pokemons_to_revive(self) -> [str]:
        return [card_id for card_id, is_alive in self.pokemons_pool.items() if not is_alive]

    def is_lose(self):
        return not any(is_alive for is_alive in self.pokemons_pool.values() if is_alive is True)

    @property
    def mention(self):
        return markdown.hlink(self.name, create_tg_link("user", id=self.id))

    @classmethod
    def new(cls, user: Union[Chat, User], vault_card_ids: list[str]):
        return cls(
            id=user.id,
            name=user.first_name,
            pokemons_pool=get_pokemons_pool_from_vault(vault_card_ids),
            last_move_time=time.time(),
            special_card=get_special_card(),
            sleeping_pills_counter=None,
            revived_pokemon=None,
        )

    def to_mongo(self):
        return {
            "id": self.id,
            "name": self.name,
            "pokemon": self.pokemon.to_mongo() if self.pokemon else None,
            "pokemons_pool": self.pokemons_pool,
            "last_move_time": self.last_move_time,
            "special_card": self.special_card,
            "sleeping_pills_counter": self.sleeping_pills_counter if self.sleeping_pills_counter else None,
            "revived_pokemon": self.revived_pokemon if self.revived_pokemon else None,
        }

    @classmethod
    def from_mongo(cls, mongo_data):
        revived = mongo_data.get("revived_pokemon")
        if revived:
            try:
                revived = resolve_card_id(revived)
            except KeyError:
                revived = None

        return cls(
            id=mongo_data["id"],
            name=mongo_data["name"],
            pokemon=Pokemon.from_mongo(mongo_data["pokemon"]),
            pokemons_pool=migrate_pool_keys(mongo_data["pokemons_pool"]),
            last_move_time=mongo_data["last_move_time"],
            special_card=mongo_data["special_card"],
            sleeping_pills_counter=mongo_data["sleeping_pills_counter"],
            revived_pokemon=revived,
        )

    def use_poison(self):
        heal_amount = self.pokemon.max_hp * const.POTION_REGEN
        new_hp = self.pokemon.hp + heal_amount
        self.pokemon.hp += heal_amount
        if new_hp > self.pokemon.max_hp:
            self.pokemon.hp = self.pokemon.max_hp
        return heal_amount


def get_pokemons_pool_from_vault(vault_card_ids: list[str]) -> dict:
    pool = {}
    for card_id in sorted(vault_card_ids):
        try:
            resolved_id = resolve_card_id(card_id)
        except KeyError:
            continue
        pool[resolved_id] = True
    return pool


def get_special_card():
    special_cards = SPECIAL_CARDS
    random.shuffle(special_cards)
    return special_cards[0]
