import type { Bounds, Container } from 'pixi.js'

/** Character frame size in game pixels — matches map-builder GEAR_CHAR_FRAME_PX / idle frame. */
export const GEAR_CHAR_FRAME_PX = 48

export type GearAttachRect = {
    x: number
    y: number
    w: number
    h: number
}

export type GearOverlayAttach = {
    rect?: GearAttachRect
    offsetX?: number
    offsetY?: number
    scale?: number
    anchorX?: number
    anchorY?: number
}

export type GearOverlayFrame = {
    w: number
    h: number
}

type GearBodySprite = Container & {
    x: number
    y: number
    scale: { x: number; y: number }
    anchor: { x: number; y: number }
}

/** Crop size in pixels — use frame, not full source sheet dimensions. */
export function gearTexturePixelSize(texture: {
    width: number
    height: number
    frame?: { width: number; height: number }
}): { w: number; h: number } {
    return {
        w: Math.max(1, texture.frame?.width ?? texture.width),
        h: Math.max(1, texture.frame?.height ?? texture.height),
    }
}

/**
 * Top-left of the 48×48 character frame in the body's local space.
 * Prefer PIXI local bounds (matches rendered sprite); fall back to anchor math.
 */
export function characterFrameTopLeft(body: GearBodySprite): { x: number; y: number } {
    if (typeof body.getLocalBounds === 'function') {
        const bounds: Bounds = body.getLocalBounds(true)
        if (bounds.width > 0 && bounds.height > 0) {
            return { x: bounds.x, y: bounds.y }
        }
    }

    const sx = Math.abs(body.scale.x) || 1
    const sy = Math.abs(body.scale.y) || 1
    const frameW = GEAR_CHAR_FRAME_PX * sx
    const frameH = GEAR_CHAR_FRAME_PX * sy
    return {
        x: body.x - frameW * body.anchor.x,
        y: body.y - frameH * body.anchor.y,
    }
}

function gearHandOffset(direction: string, bodyW: number, offsetX: number): number {
    if (direction === 'right') return bodyW * 0.22 + offsetX
    if (direction === 'left') return -bodyW * 0.08 + offsetX
    return bodyW * 0.08 + offsetX
}

/** Build rect from legacy offset/scale/anchor fields. */
export function rectFromLegacyAttach(
    direction: string,
    attach: GearOverlayAttach,
    frame: GearOverlayFrame
): GearAttachRect {
    const bodyW = GEAR_CHAR_FRAME_PX
    const bodyH = GEAR_CHAR_FRAME_PX
    const scale = attach.scale ?? 0.09
    const toolW = frame.w * scale
    const toolH = frame.h * scale
    const anchorX = attach.anchorX ?? 0.5
    const anchorY = attach.anchorY ?? 0.85
    const offsetX = attach.offsetX ?? 0
    const offsetY = attach.offsetY ?? 0
    const handX = gearHandOffset(direction, bodyW, offsetX)
    const handY = -bodyH * 0.05 + offsetY
    return {
        x: handX - toolW * anchorX,
        y: handY - toolH * anchorY,
        w: toolW,
        h: toolH,
    }
}

export function resolveGearAttachRect(
    direction: string,
    attach: GearOverlayAttach | null | undefined,
    frame: GearOverlayFrame
): GearAttachRect {
    const rect = attach?.rect
    if (rect && rect.w > 0 && rect.h > 0) {
        return {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
        }
    }
    return rectFromLegacyAttach(direction, attach || {}, frame)
}

/**
 * Place tool in player parent space — same as map-builder gearToolDrawRect:
 * character frame top-left + rect (x, y, w, h).
 */
export function placeGearToolOnCharacter(
    tool: {
        anchor: { set: (x: number, y: number) => void }
        x: number
        y: number
        scale: { set: (x: number, y: number) => void }
    },
    body: GearBodySprite,
    textureWidth: number,
    textureHeight: number,
    rect: GearAttachRect
) {
    const origin = characterFrameTopLeft(body)
    tool.anchor.set(0, 0)
    tool.x = origin.x + rect.x
    tool.y = origin.y + rect.y
    tool.scale.set(rect.w / Math.max(1, textureWidth), rect.h / Math.max(1, textureHeight))
}

/** @deprecated Use placeGearToolOnCharacter */
export function applyGearToolRect(
    sprite: Parameters<typeof placeGearToolOnCharacter>[0],
    textureWidth: number,
    textureHeight: number,
    rect: GearAttachRect
) {
    sprite.anchor.set(0, 0)
    sprite.x = rect.x
    sprite.y = rect.y
    const tw = Math.max(1, textureWidth)
    const th = Math.max(1, textureHeight)
    sprite.scale.set(rect.w / tw, rect.h / th)
}
