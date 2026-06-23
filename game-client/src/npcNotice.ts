import { Direction, Point } from '@/utils/pixi/types'

export const MIN_NPC_SIGHT_DISTANCE = 0.5
export const MAX_NPC_SIGHT_DISTANCE = 2
export const NPC_REINTERACT_COOLDOWN_MS = 5000
const TILE_SIZE = 32

/** Integer tile steps in front of the NPC (Pokemon-style line of sight). */
export function tileDistanceInFront(
    npcDir: Direction,
    npcTile: Point,
    playerTile: Point
): number | null {
    switch (npcDir) {
        case 'right':
            if (npcTile.y !== playerTile.y || playerTile.x <= npcTile.x) return null
            return playerTile.x - npcTile.x
        case 'left':
            if (npcTile.y !== playerTile.y || playerTile.x >= npcTile.x) return null
            return npcTile.x - playerTile.x
        case 'down':
            if (npcTile.x !== playerTile.x || playerTile.y <= npcTile.y) return null
            return playerTile.y - npcTile.y
        case 'up':
            if (npcTile.x !== playerTile.x || playerTile.y >= npcTile.y) return null
            return npcTile.y - playerTile.y
        default:
            return null
    }
}

/** Tile offsets from the NPC's current tile for each cell in their forward view. */
export function getNpcSightTileOffsets(
    direction: Direction,
    maxDistance: number
): Array<{ dx: number; dy: number }> {
    const max = Math.min(Math.max(maxDistance, MIN_NPC_SIGHT_DISTANCE), MAX_NPC_SIGHT_DISTANCE)
    const steps = Math.ceil(max)
    const tiles: Array<{ dx: number; dy: number }> = []

    for (let step = 1; step <= steps; step++) {
        switch (direction) {
            case 'down':
                tiles.push({ dx: 0, dy: step })
                break
            case 'up':
                tiles.push({ dx: 0, dy: -step })
                break
            case 'right':
                tiles.push({ dx: step, dy: 0 })
                break
            case 'left':
                tiles.push({ dx: -step, dy: 0 })
                break
        }
    }

    return tiles
}

/** Distance in tiles along the NPC's facing axis (world positions). */
export function axisDistanceTiles(
    npcDir: Direction,
    npcWorld: Point,
    playerWorld: Point,
    npcTile: Point,
    playerTile: Point
): number | null {
    switch (npcDir) {
        case 'right':
            if (npcTile.y !== playerTile.y || playerTile.x < npcTile.x) return null
            return (playerWorld.x - npcWorld.x) / TILE_SIZE
        case 'left':
            if (npcTile.y !== playerTile.y || playerTile.x > npcTile.x) return null
            return (npcWorld.x - playerWorld.x) / TILE_SIZE
        case 'down':
            if (npcTile.x !== playerTile.x || playerTile.y < npcTile.y) return null
            return (playerWorld.y - npcWorld.y) / TILE_SIZE
        case 'up':
            if (npcTile.x !== playerTile.x || playerTile.y > npcTile.y) return null
            return (npcWorld.y - playerWorld.y) / TILE_SIZE
        default:
            return null
    }
}

export function isPlayerInNpcFrontView(
    npcTile: Point,
    npcDir: Direction,
    playerTile: Point,
    maxDistance: number,
    npcWorld: Point,
    playerWorld: Point
): boolean {
    const tileDist = tileDistanceInFront(npcDir, npcTile, playerTile)
    if (tileDist === null) return false

    const max = Math.min(Math.max(maxDistance, MIN_NPC_SIGHT_DISTANCE), MAX_NPC_SIGHT_DISTANCE)
    const maxTiles = Math.ceil(max)
    if (tileDist < 1 || tileDist > maxTiles) return false

    const axisDist = axisDistanceTiles(npcDir, npcWorld, playerWorld, npcTile, playerTile)
    if (axisDist === null) return false
    return axisDist >= MIN_NPC_SIGHT_DISTANCE && axisDist <= max
}

export function directionToward(from: Point, to: Point): Direction | null {
    const dx = to.x - from.x
    const dy = to.y - from.y

    if (dx === 0 && dy === 0) return null

    if (Math.abs(dx) > Math.abs(dy)) {
        return dx > 0 ? 'right' : 'left'
    }
    return dy > 0 ? 'down' : 'up'
}

export function shouldNpcNoticePlayer(
    npcTile: Point,
    npcDir: Direction,
    playerTile: Point,
    maxDistance: number,
    npcWorld: Point,
    playerWorld: Point
): boolean {
    return isPlayerInNpcFrontView(npcTile, npcDir, playerTile, maxDistance, npcWorld, playerWorld)
}

export function shouldTurnToFace(fromDir: Direction, fromPos: Point, targetPos: Point): boolean {
    const toward = directionToward(fromPos, targetPos)
    return toward !== null && fromDir !== toward
}
