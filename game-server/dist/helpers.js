"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.kickPlayer = kickPlayer;
const session_1 = require("./session");
const index_1 = require("./index");
function kickPlayer(uid, reason) {
    const session = session_1.sessionManager.getPlayerSession(uid);
    if (!session)
        return;
    const room = session.getPlayerRoom(uid);
    const players = session.getPlayersInRoom(room);
    for (const player of players) {
        if (player.uid === uid) {
            index_1.io.to(player.socketId).emit('kicked', reason);
        }
        else {
            index_1.io.to(player.socketId).emit('playerLeftRoom', uid);
        }
    }
    const player = session.getPlayer(uid);
    index_1.io.sockets.sockets.get(player.socketId)?.leave(session.id);
    session_1.sessionManager.logOutPlayer(uid);
}
