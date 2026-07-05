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

type GearBodySprite = {
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

/** Character frame size — fixed 48×48 cell (matches map-builder GEAR_CHAR_FRAME_PX). */
export function characterFrameSize(body: GearBodySprite): { w: number; h: number } {
    const sx = Math.abs(body.scale.x) || 1
    const sy = Math.abs(body.scale.y) || 1
    return { w: GEAR_CHAR_FRAME_PX * sx, h: GEAR_CHAR_FRAME_PX * sy }
}

/** Frame top-left in body local space (feet anchor at body origin). */
export function characterFrameOriginLocal(body: GearBodySprite): { x: number; y: number } {
    const { w: frameW, h: frameH } = characterFrameSize(body)
    return {
        x: -frameW * body.anchor.x,
        y: -frameH * body.anchor.y,
    }
}

/**
 * Top-left of the character frame in parent space.
 * Matches map-builder: idle frame drawn at (0,0), feet anchor (0.5, 1) at sprite position.
 */
export function characterFrameTopLeft(body: GearBodySprite): { x: number; y: number } {
    const local = characterFrameOriginLocal(body)
    return {
        x: body.x + local.x,
        y: body.y + local.y,
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
 * Place tool relative to character frame — same as map-builder gearToolDrawRect:
 * frame top-left + rect (x, y, w, h). Tool is a sibling of the body in parent space.
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
