import {
    animationByIdFromCatalog,
    defaultCollidersForFrame,
    loadAnimationCatalog,
    resolveAnimPlacementScale,
} from '@/utils/pixi/mapAnimations'
import { Direction, Point, Room, TilePoint } from '@/utils/pixi/types'

type TileLayerValue = string | { id: string; scale?: number }

function parseTileLayerValue(value: TileLayerValue) {
    if (typeof value === 'string') {
        return { id: value, scale: 1 }
    }
    return { id: value.id, scale: value.scale ?? 1 }
}

function animationIdFromTileId(tileId: string): string | null {
    if (!tileId.startsWith('anim-')) return null
    return tileId.slice('anim-'.length)
}

function parseTileKey(key: TilePoint): Point {
    const parts = key.split(',')
    return { x: Number(parts[0].trim()), y: Number(parts[1].trim()) }
}

/** Tiles occupied by an animation placement (anchor bottom-left at tile). */
function animationOccupiedTiles(
    anchorX: number,
    anchorY: number,
    frameWidth: number,
    frameHeight: number,
    displayScale: number,
    placementScale: number
): TilePoint[] {
    const tileSize = 32
    const scale = displayScale * placementScale
    const width = frameWidth * scale
    const height = frameHeight * scale
    const topLeftX = anchorX * tileSize
    const topLeftY = anchorY * tileSize + tileSize - height
    const right = topLeftX + width
    const bottom = topLeftY + height

    const minTx = Math.floor(topLeftX / tileSize)
    const maxTx = Math.floor((right - 0.001) / tileSize)
    const minTy = Math.floor(topLeftY / tileSize)
    const maxTy = Math.floor((bottom - 0.001) / tileSize)

    const tiles: TilePoint[] = []
    for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
            tiles.push(`${tx}, ${ty}` as TilePoint)
        }
    }
    return tiles
}

export type GearUseTarget = {
    animId: string
    tiles: Set<TilePoint>
}

export async function buildGearUseTargets(room: Room): Promise<GearUseTarget[]> {
    await loadAnimationCatalog()
    const targets: GearUseTarget[] = []

    for (const [key, tile] of Object.entries(room.tilemap)) {
        const raw = tile.object || tile.above_floor
        if (!raw) continue
        const { id, scale } = parseTileLayerValue(raw)
        const animId = animationIdFromTileId(id)
        if (!animId) continue

        const entry = animationByIdFromCatalog(animId)
        if (!entry?.gearUseTarget) continue

        const parts = key.split(',')
        const anchorX = Number(parts[0].trim())
        const anchorY = Number(parts[1].trim())
        const frameWidth = entry.frameWidth || 32
        const frameHeight = entry.frameHeight || 32
        const displayScale = entry.displayScale || 32 / Math.max(1, frameWidth)
        const placementScale = resolveAnimPlacementScale(scale)

        const tileSet = new Set<TilePoint>(
            animationOccupiedTiles(
                anchorX,
                anchorY,
                frameWidth,
                frameHeight,
                displayScale,
                placementScale
            )
        )

        for (const collider of defaultCollidersForFrame(frameWidth, frameHeight)) {
            const tx = anchorX + collider.x
            const ty = anchorY + collider.y
            tileSet.add(`${tx}, ${ty}` as TilePoint)
        }

        if (tileSet.size) {
            targets.push({ animId, tiles: tileSet })
        }
    }

    return targets
}

export type GearUseResolution = {
    target: GearUseTarget
    faceTile: Point
    needsFace: boolean
    faceDir: Direction
}

function faceDirTowardTile(playerPos: Point, targetX: number, targetY: number): Direction | null {
    const dx = targetX - playerPos.x
    const dy = targetY - playerPos.y
    if (dx < 0) return 'left'
    if (dx > 0) return 'right'
    if (dy < 0) return 'up'
    if (dy > 0) return 'down'
    return null
}

/** Player must be on a tile adjacent to the animation (not standing on it). */
export function resolveGearUse(
    playerPos: Point,
    direction: Direction,
    targets: GearUseTarget[],
    useFacings: Direction[] = ['left', 'right']
): GearUseResolution | null {
    const { x: px, y: py } = playerPos
    let best: {
        target: GearUseTarget
        ax: number
        ay: number
        faceDir: Direction
    } | null = null

    for (const target of targets) {
        for (const tileKey of target.tiles) {
            const { x: ax, y: ay } = parseTileKey(tileKey)
            const dx = ax - px
            const dy = ay - py
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) continue

            const faceDir = faceDirTowardTile(playerPos, ax, ay)
            if (!faceDir || !useFacings.includes(faceDir)) continue

            if (!best || (faceDir === direction && best.faceDir !== direction)) {
                best = { target, ax, ay, faceDir }
            }
        }
    }

    if (!best) return null

    return {
        target: best.target,
        faceTile: { x: best.ax, y: best.ay },
        faceDir: best.faceDir,
        needsFace: direction !== best.faceDir,
    }
}
