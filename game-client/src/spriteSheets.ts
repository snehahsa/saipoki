import playerSpriteSheetData from '@/utils/pixi/Player/PlayerSpriteSheetData'
import { skins as characterSkins } from '@/utils/pixi/Player/skins'
import bundledAnimalManifest from '../../gather-clone/frontend/public/sprites/animals/manifest.json'

export type WalkSheetLayout = {
    frameWidth: number
    frameHeight: number
    columns: number
    rows: number
    sheetWidth: number
    sheetHeight: number
}

export type NpcSpriteSpec = {
    src: string
    sheetData: typeof playerSpriteSheetData
    displayScale: number
}

export type AnimalFrameRect = {
    x: number
    y: number
    w: number
    h: number
}

export type AnimalManifestEntry = {
    id: string
    file: string
    width: number
    height: number
    frameWidth: number
    frameHeight: number
    columns: number
    rows: number
    displayScale: number
    skin: string
    customFrames?: boolean
    frames?: Record<string, AnimalFrameRect>
}

const ANIMAL_SKIN_PREFIX = 'animal:'
const TARGET_FRAME_PX = 48
const WALK_DIRECTIONS = ['down', 'left', 'right', 'up'] as const

let animalCatalog: AnimalManifestEntry[] = []
let animalById = new Map<string, AnimalManifestEntry>()
let animalSkinSet = new Set<string>()
let catalogPromise: Promise<void> | null = null

function applyAnimalCatalog(animals: AnimalManifestEntry[]) {
    animalCatalog = animals
    animalById = new Map(animals.map((entry) => [entry.id, entry]))
    animalSkinSet = new Set(animals.map((entry) => entry.skin))
}

applyAnimalCatalog(
    Array.isArray(bundledAnimalManifest.animals)
        ? (bundledAnimalManifest.animals as AnimalManifestEntry[])
        : []
)

/** Load latest animal frames from disk (updated by map builder). */
export async function loadAnimalCatalog(force = false): Promise<void> {
    if (catalogPromise && !force) {
        await catalogPromise
        return
    }

    catalogPromise = (async () => {
        try {
            const res = await fetch(`/sprites/animals/manifest.json?t=${Date.now()}`, {
                cache: 'no-store',
            })
            if (!res.ok) return
            const data = await res.json()
            if (Array.isArray(data.animals)) {
                applyAnimalCatalog(data.animals as AnimalManifestEntry[])
            }
        } catch {
            // Keep bundled fallback when fetch fails.
        }
    })()

    await catalogPromise
}

export function isAnimalSkin(skin: string): boolean {
    return skin.startsWith(ANIMAL_SKIN_PREFIX)
}

export function animalIdFromSkin(skin: string): string {
    return skin.slice(ANIMAL_SKIN_PREFIX.length)
}

export function listAnimalSkins(): string[] {
    return animalCatalog.map((entry) => entry.skin)
}

export function buildWalkSheetData(layout: WalkSheetLayout) {
    const frames: Record<string, object> = {}

    for (let row = 0; row < layout.rows; row++) {
        const direction = WALK_DIRECTIONS[row] ?? `row_${row}`
        for (let col = 0; col < layout.columns; col++) {
            frames[`walk_${direction}_${col}`] = frameEntry(
                col * layout.frameWidth,
                row * layout.frameHeight,
                layout.frameWidth,
                layout.frameHeight
            )
        }
    }

    return sheetDataFromFrames(
        frames,
        layout.sheetWidth,
        layout.sheetHeight,
        layout.columns,
        layout.rows
    )
}

function frameEntry(x: number, y: number, w: number, h: number) {
    return {
        frame: { x, y, w, h },
        sourceSize: { w, h },
        spriteSourceSize: { x: 0, y: 0, w, h },
        anchor: { x: 0.5, y: 1 },
    }
}

function sheetDataFromFrames(
    frames: Record<string, object>,
    sheetWidth: number,
    sheetHeight: number,
    columns: number,
    rows: number
) {
    const animations: Record<string, string[]> = {}
    for (const direction of WALK_DIRECTIONS.slice(0, rows)) {
        const walkFrames = Array.from(
            { length: columns },
            (_, col) => `walk_${direction}_${col}`
        ).filter((name) => name in frames)

        if (!walkFrames.length) continue
        animations[`walk_${direction}`] = walkFrames
        animations[`idle_${direction}`] = [walkFrames[1] ?? walkFrames[0]]
    }

    return {
        frames,
        meta: {
            image: '',
            format: 'RGBA8888',
            size: { w: sheetWidth, h: sheetHeight },
            scale: 1,
        },
        animations,
    }
}

export function buildWalkSheetDataFromCustomFrames(
    entry: AnimalManifestEntry,
    customFrames: Record<string, AnimalFrameRect>
) {
    const frames: Record<string, object> = {}

    for (const [name, rect] of Object.entries(customFrames)) {
        if (!name.startsWith('walk_')) continue
        frames[name] = frameEntry(rect.x, rect.y, rect.w, rect.h)
    }

    return sheetDataFromFrames(frames, entry.width, entry.height, entry.columns, entry.rows)
}

function characterSpriteSpec(skin: string): NpcSpriteSpec {
    const resolved = characterSkins.includes(skin) ? skin : '009'
    const src = `/sprites/characters/Character_${resolved}.png`
    const sheetData = JSON.parse(JSON.stringify(playerSpriteSheetData))
    sheetData.meta.image = src
    return { src, sheetData, displayScale: 1 }
}

function animalSpriteSpec(skin: string): NpcSpriteSpec | null {
    const animalId = animalIdFromSkin(skin)
    const entry = animalById.get(animalId)
    if (!entry) return null

    const src = `/sprites/animals/${entry.file}`
    const sheetData = entry.customFrames && entry.frames
        ? buildWalkSheetDataFromCustomFrames(entry, entry.frames)
        : buildWalkSheetData({
              frameWidth: entry.frameWidth,
              frameHeight: entry.frameHeight,
              columns: entry.columns,
              rows: entry.rows,
              sheetWidth: entry.width,
              sheetHeight: entry.height,
          })
    sheetData.meta.image = src

    const frameWidth = entry.customFrames && entry.frames
        ? (Object.values(entry.frames)[0]?.w ?? entry.frameWidth)
        : entry.frameWidth

    const displayScale =
        entry.displayScale > 0 ? entry.displayScale : TARGET_FRAME_PX / frameWidth

    return { src, sheetData, displayScale }
}

export async function resolveNpcSpriteSpec(skin: string): Promise<NpcSpriteSpec> {
    if (isAnimalSkin(skin) || animalSkinSet.has(skin)) {
        await loadAnimalCatalog()
        const animal = animalSpriteSpec(skin)
        if (animal) return animal
    }

    return characterSpriteSpec(skin)
}
