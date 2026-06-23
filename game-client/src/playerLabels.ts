/** Stable per-player name color + label layout helpers. */

const NAME_COLORS = [
    0xff6b6b, 0x4ecdc4, 0xffe66d, 0x95e1d3, 0xf38181,
    0xaa96da, 0xfcbad3, 0xa8d8ea, 0xf9ed69, 0xb4f8c8,
    0xff9a8b, 0x88d8b0, 0xffd93d, 0x6bcb77, 0x4d96ff,
    0xff85a2, 0x7bed9f, 0x70a1ff, 0xffa502, 0xced6e0,
]

export function truncateDisplayName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return 'Trainer'

    const word = trimmed.split(/\s+/).filter(Boolean)[0] || trimmed
    return word.length > 8 ? `${word.slice(0, 8)}..` : word
}

export function nameColorFromId(id: string): number {
    let hash = 0
    for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
    }
    return NAME_COLORS[Math.abs(hash) % NAME_COLORS.length]
}

export const LEVEL_LABEL_Y = -42
export const NAME_LABEL_Y = 10
export const LABEL_SCALE_LEVEL = 0.068
export const LABEL_SCALE_NAME = 0.09
