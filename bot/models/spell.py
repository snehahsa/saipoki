from copy import copy


class Spell:
    name: str
    attack: int
    is_defence: bool
    count: int
    max_count: int
    emoji: str

    def __init__(self, name, attack, is_defence, max_count, emoji='🤷🏿‍♀️'):
        self.name = name
        self.attack = attack
        self.is_defence = is_defence
        self.count = max_count
        self.max_count = max_count
        self.emoji = emoji

    def with_count(self, count: int = None):
        spell = copy(self)
        if count is not None:  # if None => don't change (count = max_count by default)
            spell.count = count
        return spell

    def decrease_count(self):
        assert self.count > 0, "No more spells"
        self.count -= 1
