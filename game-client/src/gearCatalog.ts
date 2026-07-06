import * as PIXI from 'pixi.js'
import bundledGearManifest from '../../static/sprites/spritesheets/items/manifest.json'

export type GearSpriteAttach = {
    file: string
    x: number
    y: number
    w: number
    h: number
    direction?: string
    offsetX?: number
    offsetY?: number
    scale?: number
    anchorX?: number
    anchorY?: number
}

export type GearFaceAttach = {
    rect?: GearAttachRect
    eligible?: boolean
    offsetX?: number
    offsetY?: number
    scale?: number
    anchorX?: number
    anchorY?: number
}

export type GearAttachRect = {
    x: number
    y: number
    w: number
    h: number
}

export type GearItemDef = {
    id: string
    label?: string
    icon?: string
    sprite?: GearSpriteAttach
    faces?: Record<string, GearFaceAttach>
    useFacings?: string[]
    requiresFacing?: string
    slot_type?: string
    quest_step?: string
    quest_id?: string
    fishing_modes?: { id: string; label: string; hint?: string }[]
}

export function getGearAttachForFacing(
    item: GearItemDef | null | undefined,
    direction: string
): (GearFaceAttach & Pick<GearSpriteAttach, 'file' | 'x' | 'y' | 'w' | 'h'>) | null {
    if (!item?.sprite) return null
    const base = item.sprite
    const face = item.faces?.[direction]
    return face ? { ...base, ...face } : base
}

/** True when map builder marked this facing as use-eligible (rod visible in-game). */
export function isGearVisibleForFacing(
    item: GearItemDef | null | undefined,
    direction: string
): boolean {
    if (!item) return false
    const face = item.faces?.[direction]
    if (face && typeof face.eligible === 'boolean') {
        return face.eligible
    }
    const allowed: string[] = item.useFacings?.length
        ? item.useFacings
        : item.requiresFacing
          ? [item.requiresFacing]
          : item.sprite?.direction
            ? [item.sprite.direction]
            : []
    return allowed.includes(direction)
}

const catalog = new Map<string, GearItemDef>()

function num(value: unknown, fallback: number): number {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
}

/** Accept current manifest shape and legacy flat item entries from static/sprites. */
export function normalizeGearItem(raw: unknown): GearItemDef | null {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!id) return null

    let sprite = entry.sprite as GearSpriteAttach | undefined
    if (!sprite?.file && typeof entry.file === 'string') {
        const frame =
            entry.frame && typeof entry.frame === 'object'
                ? (entry.frame as Record<string, unknown>)
                : entry
        sprite = {
            file: entry.file,
            x: num(frame.x, 0),
            y: num(frame.y, 0),
            w: num(frame.w, 1),
            h: num(frame.h, 1),
            direction: typeof entry.direction === 'string' ? entry.direction : undefined,
            offsetX: entry.offsetX != null ? num(entry.offsetX, 0) : undefined,
            offsetY: entry.offsetY != null ? num(entry.offsetY, 0) : undefined,
            scale: entry.scale != null ? num(entry.scale, 0.09) : undefined,
            anchorX: entry.anchorX != null ? num(entry.anchorX, 0.5) : undefined,
            anchorY: entry.anchorY != null ? num(entry.anchorY, 0.85) : undefined,
        }
    }

    if (!sprite?.file) return null

    return {
        id,
        label: typeof entry.label === 'string' ? entry.label : undefined,
        icon: typeof entry.icon === 'string' ? entry.icon : undefined,
        sprite,
        faces: entry.faces as Record<string, GearFaceAttach> | undefined,
        useFacings: Array.isArray(entry.useFacings)
            ? entry.useFacings.filter((f): f is string => typeof f === 'string')
            : undefined,
        requiresFacing:
            typeof entry.requiresFacing === 'string' ? entry.requiresFacing : undefined,
        slot_type: typeof entry.slot_type === 'string' ? entry.slot_type : undefined,
        quest_step: typeof entry.quest_step === 'string' ? entry.quest_step : undefined,
        quest_id: typeof entry.quest_id === 'string' ? entry.quest_id : undefined,
        fishing_modes: Array.isArray(entry.fishing_modes)
            ? (entry.fishing_modes as GearItemDef['fishing_modes'])
            : undefined,
    }
}

/** Server manifest rebuilt without per-item JSON uses legacy formula rects (wrong y). */
function looksLikeLegacyGearAttach(
    incoming: GearItemDef,
    existing?: GearItemDef
): boolean {
    if (incoming.id !== 'fishing_rod' || !existing?.faces?.left?.rect) return false
    const leftY = incoming.faces?.left?.rect?.y
    const goodY = existing.faces.left.rect.y
    if (typeof leftY !== 'number' || typeof goodY !== 'number') return false
    return leftY < 0 && goodY > 0
}

function mergeGearItem(existing: GearItemDef | undefined, incoming: GearItemDef): GearItemDef {
    if (!existing) return incoming
    if (looksLikeLegacyGearAttach(incoming, existing)) {
        return existing
    }
    return {
        ...existing,
        ...incoming,
        sprite: { ...existing.sprite, ...incoming.sprite },
        faces: incoming.faces ?? existing.faces,
        useFacings: incoming.useFacings ?? existing.useFacings,
    }
}

function applyCatalog(items: unknown[], replace = false) {
    if (replace) catalog.clear()
    for (const raw of items) {
        const item = normalizeGearItem(raw)
        if (!item) continue
        catalog.set(item.id, mergeGearItem(catalog.get(item.id), item))
    }
}

const bundledItems = Array.isArray(bundledGearManifest.items) ? bundledGearManifest.items : []
applyCatalog(bundledItems, true)

let catalogPromise: Promise<void> | null = null

/** Load latest gear attach config from disk (updated by map builder). */
export async function loadGearCatalog(force = false): Promise<void> {
    if (catalogPromise && !force) {
        await catalogPromise
        return
    }

    catalogPromise = (async () => {
        try {
            const res = await fetch(`/sprites/spritesheets/items/manifest.json?t=${Date.now()}`, {
                cache: 'no-store',
            })
            if (!res.ok) return
            const data = await res.json()
            if (Array.isArray(data.items)) {
                applyCatalog(data.items, false)
            }
        } catch {
            // Keep bundled fallback when fetch fails.
        }
    })()

    await catalogPromise
}

export function getGearItem(id: string | null | undefined): GearItemDef | null {
    if (!id) return null
    return catalog.get(id) || null
}

export function gearSpriteUrl(file: string): string {
    return `/sprites/spritesheets/items/${file}`
}

export async function loadGearTexture(itemId: string): Promise<PIXI.Texture | null> {
    const item = getGearItem(itemId)
    const sprite = item?.sprite
    if (!sprite?.file) return null

    const src = gearSpriteUrl(sprite.file)
    const base = await PIXI.Assets.load(src)
    const source = base instanceof PIXI.Texture ? base.source : base
    return new PIXI.Texture({
        source,
        frame: new PIXI.Rectangle(sprite.x, sprite.y, sprite.w, sprite.h),
    })
}
