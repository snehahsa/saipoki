import { z } from 'zod'
import { Session } from './session'

export const JoinGame = z.object({
    username: z.string().min(1).max(64),
    skin: z.string().min(1).max(64),
    level: z.number().int().min(1).max(9999).optional(),
    equippedGear: z.string().min(1).max(64).nullable().optional(),
})

export const Disconnect = z.any()

export const MovePlayer = z.object({
    x: z.number(),
    y: z.number(),
})

export const Teleport = z.object({
    x: z.number(),
    y: z.number(),
    roomIndex: z.number(),
})

export const ChangedSkin = z.string()

export const ChangedGear = z.string().min(1).max(64).nullable()

export const NewMessage = z.string()

export type OnEventCallback = (args: { session: Session; data?: any }) => void
