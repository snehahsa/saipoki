export type MapBoundaryPoint = { x: number; y: number }

export function pointInPolygon(x: number, y: number, polygon: MapBoundaryPoint[]): boolean {
    if (polygon.length < 3) return false
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x + 0.5
        const yi = polygon[i].y + 0.5
        const xj = polygon[j].x + 0.5
        const yj = polygon[j].y + 0.5
        const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi
        if (intersect) inside = !inside
    }
    return inside
}

export function tilesAlongSegment(a: MapBoundaryPoint, b: MapBoundaryPoint): string[] {
    const keys: string[] = []
    let x0 = a.x
    let y0 = a.y
    const x1 = b.x
    const y1 = b.y
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy

    while (true) {
        keys.push(`${x0}, ${y0}`)
        if (x0 === x1 && y0 === y1) break
        const e2 = 2 * err
        if (e2 > -dy) {
            err -= dy
            x0 += sx
        }
        if (e2 < dx) {
            err += dx
            y0 += sy
        }
    }
    return keys
}

function growBounds(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    x: number,
    y: number,
) {
    return {
        minX: Math.min(minX, x),
        minY: Math.min(minY, y),
        maxX: Math.max(maxX, x),
        maxY: Math.max(maxY, y),
    }
}

/** Tiles players cannot enter — invisible in game, editor-only lines on the map. */
export function computeMapBoundaryBlockedTiles(
    boundary: MapBoundaryPoint[] | undefined,
    tilemap: Record<string, unknown>,
    spawn: { x: number; y: number },
): Set<string> {
    const blocked = new Set<string>()
    if (!boundary?.length) return blocked

    for (let i = 0; i < boundary.length - 1; i++) {
        for (const key of tilesAlongSegment(boundary[i], boundary[i + 1])) {
            blocked.add(key)
        }
    }

    if (boundary.length >= 3) {
        for (const key of tilesAlongSegment(boundary[boundary.length - 1], boundary[0])) {
            blocked.add(key)
        }

        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const p of boundary) {
            ;({ minX, minY, maxX, maxY } = growBounds(minX, minY, maxX, maxY, p.x, p.y))
        }
        for (const key of Object.keys(tilemap)) {
            const [xs, ys] = key.split(', ')
            const tx = Number(xs)
            const ty = Number(ys)
            if (Number.isFinite(tx) && Number.isFinite(ty)) {
                ;({ minX, minY, maxX, maxY } = growBounds(minX, minY, maxX, maxY, tx, ty))
            }
        }
        ;({ minX, minY, maxX, maxY } = growBounds(minX, minY, maxX, maxY, spawn.x, spawn.y))

        const margin = 60
        minX -= margin
        minY -= margin
        maxX += margin
        maxY += margin

        for (let tx = minX; tx <= maxX; tx++) {
            for (let ty = minY; ty <= maxY; ty++) {
                if (!pointInPolygon(tx + 0.5, ty + 0.5, boundary)) {
                    blocked.add(`${tx}, ${ty}`)
                }
            }
        }
    }

    return blocked
}
