import express from 'express'
import cors from 'cors'
import http from 'http'
import path from 'path'
import { Server as SocketIOServer } from 'socket.io'
import dotenv from 'dotenv'
import { sockets } from './sockets'
import { sessionManager, WORLD_ID } from './session'
import { loadWorldMapFromDisk, worldMapFileHash, worldMapFileVersion } from './worldMap'

for (const envPath of [
    path.join(__dirname, '../../../.env'),
    path.join(__dirname, '../../.env'),
]) {
    dotenv.config({ path: envPath })
}

const app = express()
const server = http.createServer(app)

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

app.use(
    cors({
        origin: allowedOrigins,
        credentials: true,
    })
)
app.use(express.json())

const POKETAB_NOTIFY_SECRET = process.env.POKETAB_NOTIFY_SECRET || 'poketab-local-dev'

const io = new SocketIOServer(server, {
    cors: {
        origin: allowedOrigins,
        credentials: true,
    },
})

app.get('/health', (_req, res) => {
    const session = sessionManager.getSession(WORLD_ID)
    const players = session?.getPlayerCount() ?? 0
    let mapHash = ''
    let mapVersion = ''
    try {
        mapHash = worldMapFileHash()
        mapVersion = worldMapFileVersion()
    } catch {
        mapHash = 'missing'
    }
    res.json({
        ok: true,
        players,
        maxPlayers: 50,
        world: 'SaiPoke Realm',
        worldId: WORLD_ID,
        rooms: session?.map_data?.rooms?.length ?? 1,
        worldMapHash: mapHash,
        worldMapVersion: mapVersion,
    })
})

app.get('/getPlayersInRoom', (req, res) => {
    const uid = req.query.uid as string | undefined
    const roomIndex = Number(req.query.roomIndex)

    if (!uid) {
        return res.status(400).json({ message: 'Missing uid' })
    }

    if (Number.isNaN(roomIndex)) {
        return res.status(400).json({ message: 'Invalid room index' })
    }

    const session = sessionManager.getPlayerSession(uid)
    if (!session) {
        return res.status(400).json({ message: 'User not in game.' })
    }

    return res.json({ players: session.getPlayersInRoom(roomIndex) })
})

app.get('/getOnlinePlayers', (_req, res) => {
    const players = sessionManager.getAllOnlinePlayers().map((player) => ({
        uid: player.uid,
        username: player.username,
        skin: player.skin,
        room: player.room,
        x: player.x,
        y: player.y,
    }))
    return res.json({ players })
})

app.post('/internal/poketab-notify', (req, res) => {
    const { secret, targetUid, event, data } = req.body || {}
    if (secret !== POKETAB_NOTIFY_SECRET) {
        return res.status(403).json({ ok: false, error: 'Forbidden' })
    }
    if (!targetUid || !event) {
        return res.status(400).json({ ok: false, error: 'Missing targetUid or event' })
    }

    const socketId = sessionManager.getSocketIdForUid(String(targetUid))
    if (socketId) {
        io.to(socketId).emit('poketab', { event, data: data || {} })
    }
    return res.json({ ok: true, delivered: Boolean(socketId) })
})

const mapData = loadWorldMapFromDisk()
sessionManager.createSession(WORLD_ID, mapData)

sockets(io)

const PORT = process.env.PORT || 3001
server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Game server running on 0.0.0.0:${PORT}`)
})

export { io }
