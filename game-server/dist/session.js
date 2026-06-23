"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionManager = exports.Session = exports.SessionManager = exports.WORLD_ID = void 0;
const uuid_1 = require("uuid");
exports.WORLD_ID = 'telegram-world';
class SessionManager {
    constructor() {
        this.sessions = {};
        this.playerIdToRealmId = {};
        this.socketIdToPlayerId = {};
    }
    createSession(id, mapData) {
        this.sessions[id] = new Session(id, mapData);
    }
    getSession(id) {
        return this.sessions[id];
    }
    getPlayerSession(uid) {
        const realmId = this.playerIdToRealmId[uid];
        return realmId ? this.sessions[realmId] : undefined;
    }
    addPlayerToSession(socketId, realmId, uid, username, skin, level = 1) {
        this.sessions[realmId].addPlayer(socketId, uid, username, skin, level);
        this.playerIdToRealmId[uid] = realmId;
        this.socketIdToPlayerId[socketId] = uid;
    }
    logOutPlayer(uid) {
        const realmId = this.playerIdToRealmId[uid];
        if (!realmId)
            return;
        const player = this.sessions[realmId].getPlayer(uid);
        delete this.socketIdToPlayerId[player.socketId];
        delete this.playerIdToRealmId[uid];
        this.sessions[realmId].removePlayer(uid);
    }
    getSocketIdsInRoom(realmId, roomIndex) {
        return this.sessions[realmId].getPlayersInRoom(roomIndex).map((player) => player.socketId);
    }
    logOutBySocketId(socketId) {
        const uid = this.socketIdToPlayerId[socketId];
        if (!uid)
            return false;
        this.logOutPlayer(uid);
        return true;
    }
    getSocketIdForUid(uid) {
        const session = this.getPlayerSession(uid);
        if (!session)
            return undefined;
        const player = session.players[uid];
        return player?.socketId;
    }
    getAllOnlinePlayers() {
        const session = this.getSession(exports.WORLD_ID);
        if (!session)
            return [];
        return Object.values(session.players);
    }
}
exports.SessionManager = SessionManager;
class Session {
    constructor(id, mapData) {
        this.playerRooms = {};
        this.playerPositions = {};
        this.players = {};
        this.id = id;
        this.map_data = mapData;
        for (let i = 0; i < mapData.rooms.length; i++) {
            this.playerRooms[i] = new Set();
            this.playerPositions[i] = {};
        }
    }
    syncMapData(mapData) {
        this.map_data = mapData;
        for (let i = 0; i < mapData.rooms.length; i++) {
            if (!this.playerRooms[i]) {
                this.playerRooms[i] = new Set();
                this.playerPositions[i] = {};
            }
        }
    }
    addPlayer(socketId, uid, username, skin, level = 1) {
        this.removePlayer(uid);
        const spawnIndex = this.map_data.spawnpoint.roomIndex;
        const spawnX = this.map_data.spawnpoint.x;
        const spawnY = this.map_data.spawnpoint.y;
        const player = {
            uid,
            username,
            level: Math.max(1, Number(level) || 1),
            x: spawnX,
            y: spawnY,
            room: spawnIndex,
            socketId,
            skin,
            proximityId: null,
        };
        this.playerRooms[spawnIndex].add(uid);
        const coordKey = `${spawnX}, ${spawnY}`;
        if (!this.playerPositions[spawnIndex][coordKey]) {
            this.playerPositions[spawnIndex][coordKey] = new Set();
        }
        this.playerPositions[spawnIndex][coordKey].add(uid);
        this.players[uid] = player;
    }
    removePlayer(uid) {
        if (!this.players[uid])
            return;
        const player = this.players[uid];
        this.playerRooms[player.room].delete(uid);
        const coordKey = `${player.x}, ${player.y}`;
        const tileSet = this.playerPositions[player.room][coordKey];
        if (tileSet) {
            tileSet.delete(uid);
            if (tileSet.size === 0) {
                delete this.playerPositions[player.room][coordKey];
            }
        }
        delete this.players[uid];
    }
    changeRoom(uid, roomIndex, x, y) {
        if (!this.players[uid])
            return [];
        const player = this.players[uid];
        this.playerRooms[player.room].delete(uid);
        this.playerRooms[roomIndex].add(uid);
        const coordKey = `${player.x}, ${player.y}`;
        if (this.playerPositions[player.room][coordKey]) {
            this.playerPositions[player.room][coordKey].delete(uid);
        }
        player.room = roomIndex;
        return this.movePlayer(uid, x, y);
    }
    getPlayersInRoom(roomIndex) {
        return Array.from(this.playerRooms[roomIndex] || []).map((uid) => this.players[uid]);
    }
    getPlayerCount() {
        return Object.keys(this.players).length;
    }
    getPlayer(uid) {
        return this.players[uid];
    }
    getPlayerRoom(uid) {
        return this.players[uid].room;
    }
    movePlayer(uid, x, y) {
        const oldCoordKey = `${this.players[uid].x}, ${this.players[uid].y}`;
        if (this.playerPositions[this.players[uid].room][oldCoordKey]) {
            this.playerPositions[this.players[uid].room][oldCoordKey].delete(uid);
        }
        this.players[uid].x = x;
        this.players[uid].y = y;
        const coordKey = `${x}, ${y}`;
        if (!this.playerPositions[this.players[uid].room][coordKey]) {
            this.playerPositions[this.players[uid].room][coordKey] = new Set();
        }
        this.playerPositions[this.players[uid].room][coordKey].add(uid);
        return this.setProximityIdsWithPlayer(uid);
    }
    setProximityIdsWithPlayer(uid) {
        const player = this.players[uid];
        const proximityTiles = this.getProximityTiles(player.x, player.y);
        const changedPlayers = new Set();
        const originalProximityId = player.proximityId;
        let otherPlayersExist = false;
        for (const tile of proximityTiles) {
            const playersInTile = this.playerPositions[player.room][tile];
            if (!playersInTile)
                continue;
            for (const otherUid of playersInTile) {
                if (otherUid === uid)
                    continue;
                otherPlayersExist = true;
                const otherPlayer = this.players[otherUid];
                if (otherPlayer.proximityId === null) {
                    if (player.proximityId === null) {
                        player.proximityId = (0, uuid_1.v4)();
                        if (player.proximityId !== originalProximityId) {
                            changedPlayers.add(uid);
                        }
                    }
                    otherPlayer.proximityId = player.proximityId;
                    changedPlayers.add(otherUid);
                }
                else if (player.proximityId !== otherPlayer.proximityId) {
                    player.proximityId = otherPlayer.proximityId;
                    if (player.proximityId !== originalProximityId) {
                        changedPlayers.add(uid);
                    }
                }
            }
        }
        if (!otherPlayersExist) {
            player.proximityId = null;
            if (originalProximityId !== null) {
                changedPlayers.add(uid);
            }
        }
        return Array.from(changedPlayers);
    }
    getProximityTiles(x, y) {
        const proximityTiles = [];
        const range = 3;
        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                proximityTiles.push(`${x + dx}, ${y + dy}`);
            }
        }
        return proximityTiles;
    }
}
exports.Session = Session;
exports.sessionManager = new SessionManager();
