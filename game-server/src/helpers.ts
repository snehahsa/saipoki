import { sessionManager } from './session'
import { io } from './index'

export function kickPlayer(uid: string, reason: string) {
    const session = sessionManager.getPlayerSession(uid)
    if (!session) return

    const room = session.getPlayerRoom(uid)
    const players = session.getPlayersInRoom(room)

    for (const player of players) {
        if (player.uid === uid) {
            io.to(player.socketId).emit('kicked', reason)
        } else {
            io.to(player.socketId).emit('playerLeftRoom', uid)
        }
    }

    const player = session.getPlayer(uid)
    io.sockets.sockets.get(player.socketId)?.leave(session.id)
    sessionManager.logOutPlayer(uid)
}
