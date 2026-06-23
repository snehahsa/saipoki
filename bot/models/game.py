import random
import time
from dataclasses import dataclass
from typing import Literal, Optional

from bot.data import const
from bot.data.catalog import card_display_name, resolve_card_id
from bot.data.special_cards import SPECIAL_CARDS
from bot.models.player import Player
from bot.models.pokemon_types import PokemonType, WEAKNESS
from bot.models.spell import Spell


@dataclass
class Game:
    player1: Player
    player2: Player
    bet: int
    game_id: Optional[str] = None
    is_player1_move: bool = True

    creation_time: float = time.time()
    winner: Optional[int] = None

    def select_pokemon(self, card_id):
        self.get_attacker().select_pokemon(card_id)

    def use_special_card(self, card_id=None):
        attacker, defender = self.get_attacker_defencer()
        card_name = attacker.special_card

        actions = []
        x = [card for card in SPECIAL_CARDS if card.endswith("-turbo")]

        if card_name == const.REVIVE:
            self.get_attacker().revive_pokemon(card_id)
            display_name = card_display_name(resolve_card_id(card_id))
            actions.append(f"🚑 {self.get_attacker().mention} revived <b>{display_name}</b>!")

        elif card_name == const.POISON:
            heal_amount = attacker.use_poison()
            actions.append(f"❤️‍🔥 {attacker.mention} drank a Potion (+{int(heal_amount)} HP)")

        elif card_name == const.SLEEPING_PILLS:
            defender.set_sleeping_pills()
            actions.append(
                f"💊 {attacker.mention} used Sleeping Pills — "
                f"{defender.mention}'s next <b>{const.SLEEPING_COUNTER}</b> attack(s) fizzle"
            )

        elif card_name.endswith("-turbo"):
            turbo_type = card_name[2:].removesuffix("-turbo")
            if attacker.pokemon.type.value == turbo_type:
                attacker.pokemon.increase_dmg_by_card = True
                actions.append(f"{attacker.mention} use turbo {card_name} card! "
                               f"Attack dmg will be increased by {const.ADDITION_DMG_BY_CARD} until pokemon is alive")
            else:
                actions.append(f"{attacker.mention} use turbo {card_name} card! "
                               f"But his pokemon is {attacker.pokemon.type.value} type. So nothing happens")

        else:
            raise Exception("Unknown special card")

        self.get_attacker().special_card = None
        return actions

    # returns list of actions
    def cast_spell(self, spell_name: str) -> [str]:
        attacker, defencer = self.get_attacker_defencer()
        spell = attacker.pokemon.get_spell_by_name(spell_name)

        actions = []

        # "use" spell. crash if no spells left
        spell.decrease_count()

        # just set shield if spell is defence
        if spell.is_defence:
            attacker.pokemon.set_shield()
            actions.append(f"🛡️ {attacker.mention} raised a shield!")
            return actions

        # if has sleeping pills effect - cancel attack
        if attacker.sleeping_pills_counter is not None:
            attacker.decrease_sleeping_pills()
            left = attacker.sleeping_pills_counter or 0
            actions.append(f"💤 {attacker.mention} is drowsy — attack fizzled ({left} turn(s) left)")
            return actions

        # calculate dmg based on spell and pokemons types
        dmg = _calc_dmg(spell, attacker, defencer)

        # check if defencer has shield and try to attack
        if defencer.pokemon.shield:
            is_attack_canceled = defencer.pokemon.attack_shield()
            if is_attack_canceled:
                actions.append(f"🛡️ Shield blocked {attacker.mention}'s hit ({dmg} dmg absorbed)")
                return actions
            actions.append(f"💥 {defencer.mention}'s shield shattered!")

        # do dmg and check if pokemon dead after it
        is_pokemon_dead = defencer.attack_pokemon(dmg)
        actions.append(f"⚔️ {attacker.mention} hit with <b>{spell.name}</b> for <b>{dmg}</b> dmg")
        if is_pokemon_dead:
            actions.append(f"☠️ <b>{is_pokemon_dead.name}</b> was knocked out!")

        return actions

    def end_move(self):
        self.is_player1_move = not self.is_player1_move
        self.update_last_move_time()  # start his move, reset move time

    def update_last_move_time(self):
        self.get_attacker().last_move_time = time.time()

    def is_game_over(self):
        # return (winner, loser) or None
        if self.player1.is_lose():
            return self.player2, self.player1
        if self.player2.is_lose():
            return self.player1, self.player2

    def game_over_coz_flee(self, looser_id):
        # return (winner, loser)
        if looser_id == self.player1.id:
            return self.player2, self.player1
        return self.player1, self.player2

    def is_game_over_coz_timeout(self):
        # return winner or None
        attacker, defencer = self.get_attacker_defencer()
        delta_time = time.time() - attacker.last_move_time
        if delta_time > const.TIMEOUT:
            return defencer, attacker
        return None, None

    def get_attacker_defencer(self):
        if self.get_attacker_index() == 1:
            return self.player1, self.player2
        return self.player2, self.player1

    def get_attacker_index(self) -> Literal[1, 2]:
        return 1 if self.is_player1_move else 2

    def get_attacker(self) -> Optional[Player]:
        return self.player1 if self.is_player1_move else self.player2

    def is_player_attacks_now(self, player_id: int):
        who_must_move = self.player1.id if self.is_player1_move else self.player2.id
        return player_id == who_must_move

    def is_all_pokemons_selected(self) -> bool:
        return bool(self.player1.pokemon and self.player2.pokemon)

    @classmethod
    def new(cls, player1: Player, player2: Player, bet: Optional[int]):
        return cls(
            player1=player1,
            player2=player2,
            bet=bet,
            is_player1_move=random.choice((True, False)),
            winner=None,
            creation_time=time.time()
        )

    @classmethod
    def from_mongo(cls, mongo_data):
        return cls(
            game_id=str(mongo_data['_id']),
            player1=Player.from_mongo(mongo_data['player1']),
            player2=Player.from_mongo(mongo_data['player2']),
            is_player1_move=mongo_data['is_player1_move'],
            winner=mongo_data['winner'],
            creation_time=mongo_data['creation_time'],
            bet=mongo_data['bet']
        )

    def to_mongo(self):
        return {
            "player1": self.player1.to_mongo(),
            "player2": self.player2.to_mongo(),
            "is_player1_move": self.is_player1_move,
            "winner": self.winner,
            "creation_time": self.creation_time,
            "bet": self.bet
        }


def _calc_dmg(spell: Spell, attack: Player, defence: Player):
    dmg = spell.attack

    if attack.pokemon.increase_dmg_by_card:
        dmg += const.ADDITION_DMG_BY_CARD

    if attack.pokemon.type in WEAKNESS[defence.pokemon.type]:
        dmg += random.randint(*const.ADDITION_DMG_BY_POKEMON_TYPE)
    # if defence.pokemon.type in WEAKNESS[attack.pokemon.type]:
    #     dmg -= random.randint(3, 8)

    return dmg
