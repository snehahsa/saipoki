/**
 * Shared gear attach math — keep in sync with game-client/src/gearOverlay.ts
 * and map-builder/static/builder.js (GEAR_CHAR_FRAME_PX / GEAR_CHAR_IDLE).
 */
;(function (root) {
    const GEAR_CHAR_FRAME_PX = 48

    /** Idle frame per direction (walk_*_1) — matches PlayerSpriteSheetData.ts */
    const GEAR_CHAR_IDLE = {
        down: { x: 48, y: 0, w: 48, h: 48 },
        left: { x: 48, y: 48, w: 48, h: 48 },
        right: { x: 48, y: 96, w: 48, h: 48 },
        up: { x: 48, y: 144, w: 48, h: 48 },
    }

    function characterFrameSize(body) {
        const sx = Math.abs(body.scaleX ?? 1) || 1
        const sy = Math.abs(body.scaleY ?? 1) || 1
        return { w: GEAR_CHAR_FRAME_PX * sx, h: GEAR_CHAR_FRAME_PX * sy }
    }

    function characterFrameOriginLocal(body) {
        const ax = body.anchorX ?? 0.5
        const ay = body.anchorY ?? 1
        const { w: frameW, h: frameH } = characterFrameSize(body)
        return {
            x: -frameW * ax,
            y: -frameH * ay,
        }
    }

    /** Top-left of character frame in parent space. */
    function characterFrameTopLeft(body) {
        const local = characterFrameOriginLocal(body)
        const px = body.x ?? 0
        const py = body.y ?? 0
        return {
            x: px + local.x,
            y: py + local.y,
        }
    }

    function gearToolDrawRect(layout, rect) {
        const z = layout.zoom
        return {
            x: layout.cx + rect.x * z,
            y: layout.cy + rect.y * z,
            w: rect.w * z,
            h: rect.h * z,
            rect,
        }
    }

    root.GearOverlayMath = {
        GEAR_CHAR_FRAME_PX,
        GEAR_CHAR_IDLE,
        characterFrameSize,
        characterFrameOriginLocal,
        characterFrameTopLeft,
        gearToolDrawRect,
    }
})(typeof globalThis !== "undefined" ? globalThis : window)
