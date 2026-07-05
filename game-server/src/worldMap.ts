import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { RealmData } from './session'

const DEFAULT_ROOM_NAME = 'Pokequest-cards'

function defaultRoomName(index: number) {
    return index === 0 ? DEFAULT_ROOM_NAME : `Map ${index + 1}`
}

function resolveMapPath(): string {
    const candidates = [
        path.join(__dirname, '../data/defaultmap.json'),
        path.join(__dirname, '../../data/defaultmap.json'),
        path.join(__dirname, '../../gather-clone/frontend/utils/defaultmap.json'),
    ]
    for (const mapPath of candidates) {
        if (fs.existsSync(mapPath)) {
            return mapPath
        }
    }
    throw new Error(
        `World map not found. Tried: ${candidates.join(', ')}`
    )
}

export function worldMapFileHash(): string {
    const mapPath = resolveMapPath()
    const raw = fs.readFileSync(mapPath)
    return crypto.createHash('md5').update(raw).digest('hex')
}

export function worldMapFileVersion(): string {
    const mapPath = resolveMapPath()
    return String(Math.floor(fs.statSync(mapPath).mtimeMs / 1000))
}

export function loadWorldMapFromDisk(): RealmData {
    const mapPath = resolveMapPath()
    const raw = fs.readFileSync(mapPath, 'utf8')
    const data = JSON.parse(raw) as RealmData
    data.rooms = data.rooms.map((room, index) => ({
        ...room,
        id: room.id?.trim() || `map-${index}`,
        name: room.name?.trim() || defaultRoomName(index),
    }))
    return data
}
