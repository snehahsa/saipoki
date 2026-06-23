import { Point, Room, TilePoint } from '@/utils/pixi/types'
import { sprites, Collider, SheetName } from '@/utils/pixi/spritesheet/spritesheet'
import { filterInteractionForHolds } from '@/utils/pixi/flows'

export type InteractionOption = {
    label: string
    code: string
    hold?: string
}

export type PortalTarget = {
    mapId: string
    x: number
    y: number
}

export type InteractableEntry = {
    tileKey: TilePoint
    title: string
    message: string
    triggerTiles: Set<TilePoint>
    options: InteractionOption[]
    showExit: boolean
    pickupHold?: string
    portal?: PortalTarget
}

function withPortalOptions(
    options: InteractionOption[],
    portal?: PortalTarget
): InteractionOption[] {
    const mapId = portal?.mapId?.trim()
    if (!mapId) return options
    if (options.some((option) => option.code === 'enter_portal')) return options
    return [{ label: 'Enter', code: 'enter_portal' }, ...options]
}

type TileLayerValue = string | { id: string; scale?: number }

function parseTileLayerValue(value: TileLayerValue) {
    if (typeof value === 'string') {
        return { id: value, scale: 1 }
    }
    return { id: value.id, scale: value.scale ?? 1 }
}

function splitTileName(tilename: string): [SheetName, string] {
    const dash = tilename.indexOf('-')
    if (dash === -1) {
        throw new Error(`Invalid tile name: ${tilename}`)
    }
    return [tilename.slice(0, dash) as SheetName, tilename.slice(dash + 1)]
}

function spriteAnchorY(data: { height: number; sortOriginY?: number }): number {
    if (data.sortOriginY != null) {
        return Math.min(1, (data.sortOriginY * 32) / data.height)
    }
    return 1 - 32 / data.height
}

/** World tile keys for sprite colliders, matching PlayApp scaled placement math. */
function scaledColliderWorldTiles(
    anchorX: number,
    anchorY: number,
    data: { width: number; height: number; sortOriginY?: number; colliders?: Collider[] },
    scale: number
): TilePoint[] {
    if (!data.colliders?.length) return []

    const tileSize = 32
    const anchorYFrac = spriteAnchorY(data)
    const screenX = anchorX * tileSize
    const screenY = anchorY * tileSize
    const scaledWidth = data.width * scale
    const scaledHeight = data.height * scale
    const topLeftX = screenX - scaledWidth * 0
    const topLeftY = screenY - scaledHeight * anchorYFrac

    const seen = new Set<string>()
    const tiles: TilePoint[] = []
    for (const collider of data.colliders) {
        const wx = Math.floor((topLeftX + collider.x * tileSize * scale) / tileSize)
        const wy = Math.floor((topLeftY + collider.y * tileSize * scale) / tileSize)
        const key = `${wx}, ${wy}`
        if (seen.has(key)) continue
        seen.add(key)
        tiles.push(key as TilePoint)
    }
    return tiles
}

function addChebyshevDisk(triggers: Set<TilePoint>, cx: number, cy: number, radius: number) {
    const bound = Math.ceil(radius)
    for (let dy = -bound; dy <= bound; dy++) {
        for (let dx = -bound; dx <= bound; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) <= radius) {
                triggers.add(`${cx + dx}, ${cy + dy}` as TilePoint)
            }
        }
    }
}

function getPlacement(tile: Room['tilemap'][TilePoint]) {
    const raw = tile.object || tile.above_floor || tile.floor
    if (!raw) return null
    return parseTileLayerValue(raw)
}

export function buildInteractables(room: Room, holds: Set<string> = new Set()): InteractableEntry[] {
    const entries: InteractableEntry[] = []

    for (const [key, tile] of Object.entries(room.tilemap)) {
        const interaction = tile.interaction
        if (!interaction) continue

        const { skip, options } = filterInteractionForHolds(interaction, holds)
        const portal = interaction.portal?.mapId?.trim()
            ? {
                  mapId: interaction.portal.mapId.trim(),
                  x: interaction.portal.x,
                  y: interaction.portal.y,
              }
            : undefined
        const mergedOptions = withPortalOptions(options, portal)
        const hasContent =
            interaction.title?.trim() ||
            interaction.message?.trim() ||
            mergedOptions.length > 0 ||
            !!portal
        if (skip || !hasContent) continue

        const [anchorX, anchorY] = key.split(',').map(Number)
        const radius = interaction.radius ?? 2
        const triggerTiles = new Set<TilePoint>()

        const placement = getPlacement(tile)
        let usedColliderTriggers = false
        if (placement) {
            try {
                const [sheetName, spriteName] = splitTileName(placement.id)
                const data = sprites.getSpriteData(sheetName, spriteName)
                const colliderTiles = scaledColliderWorldTiles(
                    anchorX,
                    anchorY,
                    data,
                    placement.scale
                )
                if (colliderTiles.length) {
                    usedColliderTriggers = true
                    for (const colliderKey of colliderTiles) {
                        const [cx, cy] = colliderKey.split(',').map(Number)
                        addChebyshevDisk(triggerTiles, cx, cy, radius)
                    }
                }
            } catch {
                // Unknown sprite — fall back to anchor radius
            }
        }

        if (!usedColliderTriggers) {
            addChebyshevDisk(triggerTiles, anchorX, anchorY, radius)
        }

        entries.push({
            tileKey: key as TilePoint,
            title: interaction.title || (portal ? 'Portal' : 'Notice'),
            message: interaction.message || '',
            triggerTiles,
            options: mergedOptions,
            showExit: interaction.showExit !== false || mergedOptions.length > 0,
            pickupHold: interaction.pickupHold?.trim() || undefined,
            portal,
        })
    }

    return entries
}

export function findActiveInteraction(
    entries: InteractableEntry[],
    playerPos: Point
): InteractableEntry | null {
    const playerKey = `${playerPos.x}, ${playerPos.y}` as TilePoint

    for (const entry of entries) {
        if (entry.triggerTiles.has(playerKey)) {
            return entry
        }
    }

    return null
}
