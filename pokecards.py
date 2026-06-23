from bot.models.pokemon_base import PokemonBase
from bot.models.pokemon_types import PokemonType
from bot.models.spell import Spell

DOGEMONS = [
    PokemonBase(
        name='Snorlex',
        hp=130,
        lvl=1,
        url='https://t.me/pokecardssolitems/63',
        type=PokemonType.BASIC,
        spells=[
            Spell('Tight Slam', 13, False, 5),
            Spell('Punch', 11, False, 50),
            Spell('Rest', 0, True, 5),
            Spell('Heavt Imapct', 18, False, 1),
        ]
    ),
    PokemonBase(
        name='Pidgei',
        hp=60,
        url='https://t.me/pokecardssolitems/64',
        lvl=1,
        type=PokemonType.BASIC,
        spells=[
            Spell('Wings cut', 15, False, 5),
            Spell('WindSpin', 0, True, 3),
            Spell('Tackle', 11, False, 50),
            Spell('Gust', 23, False, 2),
        ]
    ),
    PokemonBase(
        name='Pidgiotto',
        hp=120,
        url='https://t.me/pokecardssolitems/65',
        lvl=2,
        type=PokemonType.BASIC,
        spells=[
            Spell('Tackle', 11, False, 50),
            Spell('Gust', 23, False, 3),
            Spell('Peck', 15, False, 3),
            Spell('Wing hit', 13, False, 5),
        ]
    ),
    PokemonBase(
        name='Rattatey',
        hp=50,
        lvl=1,
            url='https://t.me/pokecardssolitems/48',
        type=PokemonType.BASIC,
        spells=[
            Spell('Scratch', 11, False, 50),
            Spell('Quick hit', 15, False, 3),
            Spell('Tackle', 13, False, 3),
            Spell('Focus', 0, True, 3),
        ]
    ),
    PokemonBase(
        name='Raticatta',
        hp=90,
        lvl=2,
        url='https://t.me/pokecardsitems/53',
        type=PokemonType.BASIC,
        spells=[
            Spell('Scratch', 12, False, 50),
            Spell('Poison Bite', 20, False, 1),
            Spell('Tail Hit', 15, False, 3),
            Spell('Tailwhip', 13, False, 3),
        ]
    ),
    PokemonBase(
        name='Jigglimuff',
        hp=50,
        url='https://t.me/pokecardssolitems/53',
        lvl=1,
        type=PokemonType.BASIC,
        spells=[
            Spell('Rollout', 15, False, 3),
            Spell('Pound', 15, False, 3),
            Spell('Slap', 9, False, 50),
            Spell('Sing', 0, True, 5),
        ]
    ),
        PokemonBase(
        name='Miowth',
        hp=70,
        url='https://t.me/pokecardssolitems/55',
        lvl=1,
        type=PokemonType.BASIC,
        spells=[
            Spell('Scratch', 10, False, 50),
            Spell('Scream Out', 15, False, 3),
            Spell('Cat kick', 15, False, 3),
            Spell('Confuse', 0, True, 3),
        ]
    ),
        PokemonBase(
        name='Taures',
        hp=110,
        url='https://t.me/pokecardssolitems/49',
        lvl=1,
        type=PokemonType.BASIC,
        spells=[
            Spell('Combat hit', 18, False, 3),
            Spell('Horn fury', 15, False, 2),
            Spell('TakeDown', 10, False, 50),
            Spell('Rage', 15, False, 5),
        ]
    ),
        PokemonBase(
        name='Scuirtle',
        hp=80,
        lvl=1,
        url='https://t.me/pokecardssolitems/69',
        type=PokemonType.WATER,
        spells=[
            Spell('Tackle', 11, False, 55),
            Spell('Water punch', 21, False, 3),
            Spell('splash', 14, False, 3),
            Spell('Shell hit', 11, False, 5),
        ]
    ),
        PokemonBase(
        name='Blastoicey',
        hp=150,
        url='https://t.me/pokecardssolitems/71',
        lvl=2,
        type=PokemonType.WATER,
        spells=[
            Spell('Tackle', 11, False, 55),
            Spell('Water gun', 23, False, 3),
            Spell('Bubble', 11, False, 3),
            Spell('Shell hit', 11, False, 3),
        ]
    ),
        PokemonBase(
        name='Starey',
        hp=70,
        url='https://t.me/pokecardssolitems/50',
        lvl=1,
        type=PokemonType.WATER,
        spells=[
            Spell('Smack', 11, False, 55),
            Spell('Quick spin', 11, False, 4),
            Spell('Splash', 13, False, 6),
            Spell('Water jet', 15, False, 3),
        ]
    ),
        PokemonBase(
        name='Tenticruel',
        hp=170,
        lvl=2,
        url='https://t.me/pokecardssolitems/51',
        type=PokemonType.WATER,
        spells=[
            Spell('Wrap', 16, False, 5),
            Spell('Tight Sting', 19, False, 3),
            Spell('Splash', 11, False, 60),
            Spell('Supersclosis', 20, False, 2),
        ]
    ),
        PokemonBase(
        name='Crabby',
        hp=80,
        lvl=1,
        url='https://t.me/pokecardssolitems/39',
        type=PokemonType.WATER,
        spells=[
            Spell('Bite', 11, False, 25),
            Spell('Swim Deep', 0, True, 3),
            Spell('Gel Grip', 14, False, 3),
            Spell('Shower', 14, False, 4),
        ]
    ),
        PokemonBase(
        name='Seahorse',
        hp=50,
        url='https://t.me/pokecardssolitems/45',
        lvl=1,
        type=PokemonType.WATER,
        spells=[
            Spell('Bite', 11, False, 25),
            Spell('Water Beam', 10, False, 30),
            Spell('Splash', 13, False, 3),
            Spell('Shower', 14, False, 2),
        ]
    ),
        PokemonBase(
        name='Giodude',
        hp=100,
        lvl=1,
        url='https://t.me/pokecardssolitems/59',
        type=PokemonType.ROCK,
        spells=[
            Spell('Rock throw', 18, False, 5),
            Spell('Tackle', 11, False, 30),
            Spell('Punch', 14, False, 3),
            Spell('Linear hit', 15, False, 4),
        ]
    ),
        PokemonBase(
        name='Golim',
        hp=180,
        lvl=2,
        url='https://t.me/pokecardssolitems/44',
        type=PokemonType.ROCK,
        spells=[
            Spell('Stone Edge', 21, False, 2),
            Spell('Lunge', 16, False, 4),
            Spell('Tumble', 11, False, 30),
            Spell('Mega hit', 19, False, 2),
        ]
    ),
        PokemonBase(
        name='Onix',
        hp=210,
        lvl=1,
        url='https://t.me/pokecardssolitems/70',
        type=PokemonType.ROCK,
        spells=[
            Spell('Rock Shower', 21, False, 5),
            Spell('Stone Impact', 13, False, 4),
            Spell('Deep Dig', 0, True, 3),
            Spell('RockHit', 12, False, 50),
        ]
    ),
        PokemonBase(
        name='Sudowoodo',
        hp=140,
        url='https://t.me/pokecardssolitems/67',
        lvl=1,
        type=PokemonType.ROCK,
        spells=[
            Spell('Double Throw', 14, False, 5),
            Spell('Tackle', 11, False, 40),
            Spell('Dance', 0, True, 3),
            Spell('Chop', 14, False, 5),
        ]
    ),
        PokemonBase(
        name='Rhihorn',
        hp=110,
        lvl=1,
        url='https://t.me/pokecardssolitems/68',
        type=PokemonType.ROCK,
        spells=[
            Spell('Tight Hit', 16, False, 5),
            Spell('Crush', 14, False, 3),
            Spell('Horn smash', 11, False, 5),
            Spell('Chop', 10, False, 50),
        ]
    ),
        PokemonBase(
        name='Aerodactile',
        hp=190,
        url='https://t.me/pokecardssolitems/57',
        lvl=1,
        type=PokemonType.ROCK,
        spells=[
            Spell('Spin Hit', 16, False, 3),
            Spell('Bind Attack', 11, False, 50),
            Spell('Fossil fangs', 13, False, 5),
            Spell('Wing Spin', 15, False, 3),
        ]
    ),
        PokemonBase(
        name='Bulbasor',
        hp=90,
        url='https://t.me/pokecardssolitems/38',
        lvl=1,
        type=PokemonType.GRASS,
        spells=[
            Spell('Quick Hit', 12, False, 30),
            Spell('Leaf Cut', 15, False, 8),
            Spell('Green Razors', 17, False, 3),
            Spell('Sleep seed', 0, True, 3),
        ]
    ),
        PokemonBase(
        name='Venusor',
        hp=150,
        url='https://t.me/pokecardssolitems/60',
        lvl=2,
        type=PokemonType.GRASS,
        spells=[
            Spell('Razor Leaf', 21, False, 4),
            Spell('Sap Bite', 15, False, 9),
            Spell('Leaf Sting', 18, False, 2),
            Spell('Sling Scrach', 11, False, 30),
        ]
    ),
        PokemonBase(
        name='scither',
        hp=100,
        url='https://t.me/pokecardssolitems/62',
        lvl=1,
        type=PokemonType.GRASS,
        spells=[
            Spell('Razor Leaf', 16, False, 3),
            Spell('Drool', 15, False, 3),
            Spell('Sleep spell', 0, True, 3),
            Spell('Scrach', 11, False, 30),
        ]
    ),

        PokemonBase(
        name='Tangila',
        url='https://t.me/pokecardssolitems/61',
        hp=80,
        lvl=1,
        type=PokemonType.GRASS,
        spells=[
            Spell('Vine Tease', 16, False, 5),
            Spell('Gentle Slap', 11, False, 50),
            Spell('Grass Knot',14, False, 5),
            Spell('Run', 0, True, 3),
        ]
    ),
        PokemonBase(
        name='exiggutor',
        hp=150,
        url='https://t.me/pokecardssolitems/52',
        lvl=2,
        type=PokemonType.GRASS,
        spells=[
            Spell('Super Eggsplosion', 16, False, 4),
            Spell('Seed bullets', 12, False, 3),
            Spell('Stomp',16, False, 5),
            Spell('Leaf throw', 13, False, 30),
        ]
    ),
        PokemonBase(
        name='charmandar',
        hp=80,
        url='https://t.me/pokecardssolitems/42',
        lvl=1,
        type=PokemonType.FIRE,
        spells=[
            Spell('Tackle', 12, False, 30),
            Spell('Fire balls', 16, False, 5),
            Spell('Flare',20, False, 2),
            Spell('Heat up', 13, False, 30),
        ]
    ),
        PokemonBase(
        name='Charizard',
        hp=180,
        url='https://t.me/pokecardssolitems/43',
        lvl=2,
        type=PokemonType.FIRE,
        spells=[
            Spell('Ember', 14, False, 40),
            Spell('Fury Blaze', 19, False, 3),
            Spell('flames',14, False, 5),
            Spell('Fire spin', 20, False, 3),
        ]
    ),
        PokemonBase(
        name='Vulpex',
        hp=70,
        url='https://t.me/pokecardssolitems/66',
        lvl=1,
        type=PokemonType.FIRE,
        spells=[
            Spell('Flare', 14, False, 3),
            Spell('Confuse ray', 0, True, 3),
            Spell('Tail Fire',20, False, 2),
            Spell('Scratch', 11, False, 40),
        ]
    ),
        PokemonBase(
        name='Arkanine',
        hp=150,
        url='https://t.me/pokecardssolitems/72',
        lvl=2,
        type=PokemonType.FIRE,
        spells=[
            Spell('Fire maze', 29, False, 3),
            Spell('Sun Burn', 14, False, 3),
            Spell('Flame throw',13, False, 5),
            Spell('Scratch', 11, False, 40),
        ]
    ),
        PokemonBase(
        name='Magmer',
        hp=80,
        lvl=1,
        url='https://t.me/pokecardssolitems/58',
        type=PokemonType.FIRE,
        spells=[
            Spell('Fire kick', 18, False, 3),
            Spell('Flame showers', 14, False, 5),
            Spell('Fire jix',15, False, 3),
            Spell('Scratch', 11, False, 40),
        ]
    ),
        PokemonBase(
        name='Cyndaquil',
        hp=90,
        lvl=1,
        url='https://t.me/pokecardssolitems/2',
        type=PokemonType.FIRE,
        spells=[
            Spell('Tackle', 11, False, 35),
            Spell('Heat Sleep', 0, True, 3),
            Spell('Volvano clouds',18, False, 3),
            Spell('Fireworks', 16, False, 3),
        ]
    ),
        PokemonBase(
        name='Gasly',
        hp=60,
        lvl=1,
        url='https://t.me/pokecardsitems/19',
        type=PokemonType.GHOST,
        spells=[
            Spell('Fade out', 0, True, 3),
            Spell('Soul pin', 18, False, 5),
            Spell('Nightmare',20, False, 3),
            Spell('Gas Attack', 11, False, 50),
        ]
    ),
        PokemonBase(
        name='Haunter',
        hp=50,
        lvl=2,
        url='https://t.me/pokecardssolitems/46',
        type=PokemonType.GHOST,
        spells=[
            Spell('Sponky shot', 14, False, 30),
            Spell('Shadow ball', 18, False, 3),
            Spell('Nightmare',23, False, 3),
            Spell('Dreameater', 21, False, 3),
        ]
    ),
        PokemonBase(
        name='Genger',
        hp=60,
        url='https://t.me/pokecardssolitems/73',
        lvl=3,
        type=PokemonType.GHOST,
        spells=[
            Spell('Pain burst', 25, False, 1),
            Spell('Curse', 18, False, 20),
            Spell('Shadow Skip',22, False, 3),
            Spell('Soul crush', 30, False, 1),
        ]
    ),
        PokemonBase(
        name='Pekachu',
        hp=70,
        lvl=1,
        url='https://t.me/pokecardssolitems/56',
        type=PokemonType.ELECTRIC,
        spells=[
            Spell('Electro ball', 25, False, 1),
            Spell('Charge', 0, True, 3),
            Spell('Tackle',11, False, 50),
            Spell('Pike strike', 17, False, 5),
        ]
    ),
        PokemonBase(
        name='Raechu',
        hp=120,
        url='https://t.me/pokecardsitems/28',
        lvl=2,
        type=PokemonType.ELECTRIC,
        spells=[
            Spell('Electro Spark', 23, False, 3),
            Spell('Shock wave', 17, False, 3),
            Spell('Tail Spark',13, False, 5),
            Spell('Voltage hit', 11, False, 50),
        ]
    ),
        PokemonBase(
        name='Elektrode',
        hp=60,
        lvl=1,
        url='https://t.me/pokecardssolitems/40',
        type=PokemonType.ELECTRIC,
        spells=[
            Spell('Electric dip', 16, False, 1),
            Spell('Shock stess', 13, False, 5),
            Spell('Quick hit',10, False, 50),
            Spell('electro roll', 15, False, 3),
        ]
    ),
        PokemonBase(
        name='mewtu',
        hp=220,
        url='https://t.me/pokecardssolitems/54',
        lvl=10,
        type=PokemonType.LEGENDARY,
        spells=[
            Spell('Psychic', 20, False, 3),
            Spell('Big Bang', 45, False, 1),
            Spell('Meditate',0, True, 5),
            Spell('Burst', 12, False, 50),
        ]
    ),
        PokemonBase(
        name='Moltras',
        hp=190,
        url='https://t.me/pokecardssolitems/47',
        lvl=10,
        type=PokemonType.LEGENDARY,
        spells=[
            Spell('Death Flames', 35, False, 2),
            Spell('Soul Burn', 45, False, 1),
            Spell('Earth Crush',13, True, 2),
            Spell('Fire Spin', 10, False, 50),
        ]
    )
]

DOGEMONS_MAP: dict[str, PokemonBase] = {
    pokemon.name: pokemon
    for pokemon in DOGEMONS
}


def catalog_id(name: str) -> str | None:
    """Stable poke-NNN id from poke.json (single source of truth for catalog ids)."""
    from poke_registry import catalog_id_for_name

    return catalog_id_for_name(name)
