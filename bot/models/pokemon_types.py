from enum import Enum


class PokemonType(Enum):
    BASIC = 'Basic'
    WATER = 'Water'
    ROCK = 'Rock'
    GRASS = 'Grass'
    FIRE = 'Fire'
    GHOST = 'Ghost'
    ELECTRIC = 'Electric'
    LEGENDARY = 'Legendary'


TYPES_STR = {
    PokemonType.BASIC: '🐶',
    PokemonType.WATER: '💧',
    PokemonType.ROCK: '🪨',
    PokemonType.GRASS: '🌿',
    PokemonType.FIRE: '🔥',
    PokemonType.GHOST: '👻',
    PokemonType.ELECTRIC: '⚡️',
    PokemonType.LEGENDARY: '🌟',
}

WEAKNESS = {
    PokemonType.BASIC: [pokemon_type for pokemon_type in PokemonType],
    PokemonType.FIRE: [PokemonType.WATER, PokemonType.ROCK, PokemonType.GHOST, PokemonType.LEGENDARY],
    PokemonType.ELECTRIC: [PokemonType.GRASS, PokemonType.ROCK, PokemonType.GHOST, PokemonType.LEGENDARY],
    PokemonType.GRASS: [PokemonType.GHOST, PokemonType.LEGENDARY, PokemonType.FIRE],
    PokemonType.ROCK: [PokemonType.WATER, PokemonType.GRASS, PokemonType.GHOST, PokemonType.LEGENDARY],
    PokemonType.WATER: [PokemonType.ELECTRIC, PokemonType.GRASS, PokemonType.GHOST, PokemonType.LEGENDARY],
    PokemonType.LEGENDARY: [],
    PokemonType.GHOST: [PokemonType.LEGENDARY],
}
