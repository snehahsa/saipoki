import { Server } from 'socket.io'
import {
    JoinGame,
    Disconnect,
    OnEventCallback,
    MovePlayer,
    Teleport,
    ChangedSkin,
    NewMessage,
} from './socket-types'
import { z } from 'zod'
import { sessionManager, WORLD_ID } from './session'
import { loadWorldMapFromDisk } from './worldMap'
import { kickPlayer } from './helpers'

const joiningInProgress = new Set<string>()
const POKETAB_NOTIFY_SECRET = process.env.POKETAB_NOTIFY_SECRET || 'poketab-local-dev'
const FLASK_INTERNAL_URL = (
    process.env.FLASK_INTERNAL_URL
    || process.env.GAME_FLASK_INTERNAL
    || 'http://127.0.0.1:5000'
).replace(/\/$/, '')

function notifyBattlePlayerOffline(uid: string) {
    fetch(`${FLASK_INTERNAL_URL}/internal/battle-player-offline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: POKETAB_NOTIFY_SECRET, uid }),
    }).catch(() => {})
}

function removeExtraSpaces(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

export function sockets(io: Server) {
    io.on('connection', (socket) => {
        const rawUid = socket.handshake.query.uid
        const parsedUid = Array.isArray(rawUid) ? rawUid[0] : rawUid

        if (!parsedUid || typeof parsedUid !== 'string') {
            socket.disconnect(true)
            return
        }

        const uid: string = parsedUid

        function on(eventName: string, schema: z.ZodTypeAny, callback: OnEventCallback) {
            socket.on(eventName, (data: unknown) => {
                if (!schema.safeParse(data).success) return

                const session = sessionManager.getPlayerSession(uid)
                if (!session) return

                callback({ session, data })
            })
        }

        function emit(eventName: string, data: unknown) {
            const session = sessionManager.getPlayerSession(uid)
            if (!session) return

            const room = session.getPlayerRoom(uid)
            const players = session.getPlayersInRoom(room)

            for (const player of players) {
                if (player.socketId === socket.id) continue
                io.to(player.socketId).emit(eventName, data)
            }
        }

        function emitToSocketIds(socketIds: string[], eventName: string, data: unknown) {
            for (const socketId of socketIds) {
                io.to(socketId).emit(eventName, data)
            }
        }

        socket.on('joinGame', (joinData: z.infer<typeof JoinGame>) => {
            const rejectJoin = (reason: string) => {
                socket.emit('failedToJoinRoom', reason)
                joiningInProgress.delete(uid)
            }

            if (!JoinGame.safeParse(joinData).success) {
                return rejectJoin('Invalid request data.')
            }

            if (joiningInProgress.has(uid)) {
                return rejectJoin('Already joining the game.')
            }

            joiningInProgress.add(uid)

            try {
                const session = sessionManager.getSession(WORLD_ID)
                if (session) {
                    session.syncMapData(loadWorldMapFromDisk())
                }
                if (session && session.getPlayerCount() >= 50) {
                    return rejectJoin('World is full. Try again later.')
                }

                const currentSession = sessionManager.getPlayerSession(uid)
                if (currentSession) {
                    kickPlayer(uid, 'You connected from another device.')
                }

                if (!sessionManager.getSession(WORLD_ID)) {
                    return rejectJoin('World is not ready.')
                }

                sessionManager.addPlayerToSession(
                    socket.id,
                    WORLD_ID,
                    uid,
                    joinData.username,
                    joinData.skin,
                    joinData.level ?? 1,
                )

                const newSession = sessionManager.getPlayerSession(uid)!
                const player = newSession.getPlayer(uid)

                socket.join(WORLD_ID)
                socket.emit('joinedRealm')
                emit('playerJoinedRoom', player)
            } catch (error) {
                console.error('joinGame failed:', error)
                rejectJoin('Could not join the world. Try again.')
            } finally {
                joiningInProgress.delete(uid)
            }
        })

        on('disconnect', Disconnect, ({ session }) => {
            const socketIds = sessionManager.getSocketIdsInRoom(
                session.id,
                session.getPlayerRoom(uid)
            )
            const success = sessionManager.logOutBySocketId(socket.id)
            if (success) {
                emitToSocketIds(socketIds, 'playerLeftRoom', uid)
                notifyBattlePlayerOffline(uid)
            }
        })

        on('movePlayer', MovePlayer, ({ session, data }) => {
            const player = session.getPlayer(uid)
            session.movePlayer(player.uid, data.x, data.y)

            emit('playerMoved', {
                uid: player.uid,
                x: player.x,
                y: player.y,
            })
        })

        on('teleport', Teleport, ({ session, data }) => {
            const player = session.getPlayer(uid)
            if (player.room !== data.roomIndex) {
                emit('playerLeftRoom', uid)
                session.changeRoom(uid, data.roomIndex, data.x, data.y)
                emit('playerJoinedRoom', player)
            } else {
                session.movePlayer(player.uid, data.x, data.y)
                emit('playerTeleported', { uid, x: player.x, y: player.y })
            }
        })

        on('changedSkin', ChangedSkin, ({ session, data }) => {
            const player = session.getPlayer(uid)
            player.skin = data
            emit('playerChangedSkin', { uid, skin: player.skin })
        })

        on('sendMessage', NewMessage, ({ data }) => {
            if (data.length > 300 || data.trim() === '') return
            emit('receiveMessage', { uid, message: removeExtraSpaces(data) })
        })
    })
}
