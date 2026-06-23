"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sockets = sockets;
const socket_types_1 = require("./socket-types");
const session_1 = require("./session");
const worldMap_1 = require("./worldMap");
const helpers_1 = require("./helpers");
const joiningInProgress = new Set();
function removeExtraSpaces(text) {
    return text.replace(/\s+/g, ' ').trim();
}
function sockets(io) {
    io.on('connection', (socket) => {
        const rawUid = socket.handshake.query.uid;
        const parsedUid = Array.isArray(rawUid) ? rawUid[0] : rawUid;
        if (!parsedUid || typeof parsedUid !== 'string') {
            socket.disconnect(true);
            return;
        }
        const uid = parsedUid;
        function on(eventName, schema, callback) {
            socket.on(eventName, (data) => {
                if (!schema.safeParse(data).success)
                    return;
                const session = session_1.sessionManager.getPlayerSession(uid);
                if (!session)
                    return;
                callback({ session, data });
            });
        }
        function emit(eventName, data) {
            const session = session_1.sessionManager.getPlayerSession(uid);
            if (!session)
                return;
            const room = session.getPlayerRoom(uid);
            const players = session.getPlayersInRoom(room);
            for (const player of players) {
                if (player.socketId === socket.id)
                    continue;
                io.to(player.socketId).emit(eventName, data);
            }
        }
        function emitToSocketIds(socketIds, eventName, data) {
            for (const socketId of socketIds) {
                io.to(socketId).emit(eventName, data);
            }
        }
        socket.on('joinGame', (joinData) => {
            const rejectJoin = (reason) => {
                socket.emit('failedToJoinRoom', reason);
                joiningInProgress.delete(uid);
            };
            if (!socket_types_1.JoinGame.safeParse(joinData).success) {
                return rejectJoin('Invalid request data.');
            }
            if (joiningInProgress.has(uid)) {
                return rejectJoin('Already joining the game.');
            }
            joiningInProgress.add(uid);
            try {
                const session = session_1.sessionManager.getSession(session_1.WORLD_ID);
                if (session) {
                    session.syncMapData((0, worldMap_1.loadWorldMapFromDisk)());
                }
                if (session && session.getPlayerCount() >= 50) {
                    return rejectJoin('World is full. Try again later.');
                }
                const currentSession = session_1.sessionManager.getPlayerSession(uid);
                if (currentSession) {
                    (0, helpers_1.kickPlayer)(uid, 'You connected from another device.');
                }
                if (!session_1.sessionManager.getSession(session_1.WORLD_ID)) {
                    return rejectJoin('World is not ready.');
                }
                session_1.sessionManager.addPlayerToSession(socket.id, session_1.WORLD_ID, uid, joinData.username, joinData.skin, joinData.level ?? 1);
                const newSession = session_1.sessionManager.getPlayerSession(uid);
                const player = newSession.getPlayer(uid);
                socket.join(session_1.WORLD_ID);
                socket.emit('joinedRealm');
                emit('playerJoinedRoom', player);
            }
            catch (error) {
                console.error('joinGame failed:', error);
                rejectJoin('Could not join the world. Try again.');
            }
            finally {
                joiningInProgress.delete(uid);
            }
        });
        on('disconnect', socket_types_1.Disconnect, ({ session }) => {
            const socketIds = session_1.sessionManager.getSocketIdsInRoom(session.id, session.getPlayerRoom(uid));
            const success = session_1.sessionManager.logOutBySocketId(socket.id);
            if (success) {
                emitToSocketIds(socketIds, 'playerLeftRoom', uid);
            }
        });
        on('movePlayer', socket_types_1.MovePlayer, ({ session, data }) => {
            const player = session.getPlayer(uid);
            session.movePlayer(player.uid, data.x, data.y);
            emit('playerMoved', {
                uid: player.uid,
                x: player.x,
                y: player.y,
            });
        });
        on('teleport', socket_types_1.Teleport, ({ session, data }) => {
            const player = session.getPlayer(uid);
            if (player.room !== data.roomIndex) {
                emit('playerLeftRoom', uid);
                session.changeRoom(uid, data.roomIndex, data.x, data.y);
                emit('playerJoinedRoom', player);
            }
            else {
                session.movePlayer(player.uid, data.x, data.y);
                emit('playerTeleported', { uid, x: player.x, y: player.y });
            }
        });
        on('changedSkin', socket_types_1.ChangedSkin, ({ session, data }) => {
            const player = session.getPlayer(uid);
            player.skin = data;
            emit('playerChangedSkin', { uid, skin: player.skin });
        });
        on('sendMessage', socket_types_1.NewMessage, ({ data }) => {
            if (data.length > 300 || data.trim() === '')
                return;
            emit('receiveMessage', { uid, message: removeExtraSpaces(data) });
        });
    });
}
