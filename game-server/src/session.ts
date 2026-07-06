import { kickPlayer } from './helpers'
import { v4 as uuidv4 } from 'uuid'

export type RealmData = {
    spawnpoint: {
        roomIndex: number
        x: number
        y: number
    }
    rooms: Room[]
}

export interface Room {
    id?: string
    name: string
    tilemap: {
        [key: `${number}, ${number}`]: {
            floor?: string
            above_floor?: string
            object?: string
            impassable?: boolean
            teleporter?: {
                roomIndex: number
                x: number
                y: number
            }
            privateAreaId?: string
            interaction?: {
                title?: string
                message?: string
                radius?: number
                options?: { label: string; code: string }[]
                showExit?: boolean
                portal?: {
                    mapId: string
                    x: number
                    y: number
                }
            }
        }
    }
    channelId?: string
    npcs?: {
        id: string
        name: string
        skin: string
        path: { x: number; y: number }[]
        loop?: boolean
        waitMs?: number
        noticeRadius?: number
        messages?: string[]
    }[]
}

export interface Player {
    uid: string
    username: string
    level: number
    x: number
    y: number
    room: number
    socketId: string
    skin: string
    proximityId: string | null
    equippedGear: string | null
}

export const WORLD_ID = 'telegram-world'

export class SessionManager {
    private sessions: { [key: string]: Session } = {}
    private playerIdToRealmId: { [key: string]: string } = {}
    private socketIdToPlayerId: { [key: string]: string } = {}

    public createSession(id: string, mapData: RealmData): void {
        this.sessions[id] = new Session(id, mapData)
    }

    public getSession(id: string): Session | undefined {
        return this.sessions[id]
    }

    public getPlayerSession(uid: string): Session | undefined {
        const realmId = this.playerIdToRealmId[uid]
        return realmId ? this.sessions[realmId] : undefined
    }

    public addPlayerToSession(
        socketId: string,
        realmId: string,
        uid: string,
        username: string,
        skin: string,
        level: number = 1,
        equippedGear: string | null = null,
    ) {
        this.sessions[realmId].addPlayer(socketId, uid, username, skin, level, equippedGear)
        this.playerIdToRealmId[uid] = realmId
        this.socketIdToPlayerId[socketId] = uid
    }

    public logOutPlayer(uid: string) {
        const realmId = this.playerIdToRealmId[uid]
        if (!realmId) return

        const player = this.sessions[realmId].getPlayer(uid)
        delete this.socketIdToPlayerId[player.socketId]
        delete this.playerIdToRealmId[uid]
        this.sessions[realmId].removePlayer(uid)
    }

    public getSocketIdsInRoom(realmId: string, roomIndex: number): string[] {
        return this.sessions[realmId].getPlayersInRoom(roomIndex).map((player) => player.socketId)
    }

    public logOutBySocketId(socketId: string) {
        const uid = this.socketIdToPlayerId[socketId]
        if (!uid) return false

        this.logOutPlayer(uid)
        return true
    }

    public getSocketIdForUid(uid: string): string | undefined {
        const session = this.getPlayerSession(uid)
        if (!session) return undefined
        const player = session.players[uid]
        return player?.socketId
    }

    public getAllOnlinePlayers(): Player[] {
        const session = this.getSession(WORLD_ID)
        if (!session) return []
        return Object.values(session.players)
    }
}

export class Session {
    private playerRooms: { [key: number]: Set<string> } = {}
    private playerPositions: { [key: number]: { [key: string]: Set<string> } } = {}

    public players: { [key: string]: Player } = {}
    public id: string
    public map_data: RealmData

    constructor(id: string, mapData: RealmData) {
        this.id = id
        this.map_data = mapData

        for (let i = 0; i < mapData.rooms.length; i++) {
            this.playerRooms[i] = new Set<string>()
            this.playerPositions[i] = {}
        }
    }

    public syncMapData(mapData: RealmData) {
        this.map_data = mapData
        for (let i = 0; i < mapData.rooms.length; i++) {
            if (!this.playerRooms[i]) {
                this.playerRooms[i] = new Set<string>()
                this.playerPositions[i] = {}
            }
        }
    }

    public addPlayer(
        socketId: string,
        uid: string,
        username: string,
        skin: string,
        level: number = 1,
        equippedGear: string | null = null,
    ) {
        this.removePlayer(uid)
        const spawnIndex = this.map_data.spawnpoint.roomIndex
        const spawnX = this.map_data.spawnpoint.x
        const spawnY = this.map_data.spawnpoint.y

        const gear = typeof equippedGear === 'string' && equippedGear.trim() ? equippedGear.trim() : null

        const player: Player = {
            uid,
            username,
            level: Math.max(1, Number(level) || 1),
            x: spawnX,
            y: spawnY,
            room: spawnIndex,
            socketId,
            skin,
            proximityId: null,
            equippedGear: gear,
        }

        this.playerRooms[spawnIndex].add(uid)
        const coordKey = `${spawnX}, ${spawnY}`
        if (!this.playerPositions[spawnIndex][coordKey]) {
            this.playerPositions[spawnIndex][coordKey] = new Set<string>()
        }
        this.playerPositions[spawnIndex][coordKey].add(uid)
        this.players[uid] = player
    }

    public removePlayer(uid: string): void {
        if (!this.players[uid]) return

        const player = this.players[uid]
        this.playerRooms[player.room].delete(uid)

        const coordKey = `${player.x}, ${player.y}`
        const tileSet = this.playerPositions[player.room][coordKey]
        if (tileSet) {
            tileSet.delete(uid)
            if (tileSet.size === 0) {
                delete this.playerPositions[player.room][coordKey]
            }
        }

        delete this.players[uid]
    }

    public changeRoom(uid: string, roomIndex: number, x: number, y: number): string[] {
        if (!this.players[uid]) return []

        const player = this.players[uid]
        this.playerRooms[player.room].delete(uid)
        this.playerRooms[roomIndex].add(uid)

        const coordKey = `${player.x}, ${player.y}`
        if (this.playerPositions[player.room][coordKey]) {
            this.playerPositions[player.room][coordKey].delete(uid)
        }

        player.room = roomIndex
        return this.movePlayer(uid, x, y)
    }

    public getPlayersInRoom(roomIndex: number): Player[] {
        return Array.from(this.playerRooms[roomIndex] || []).map((uid) => this.players[uid])
    }

    public getPlayerCount() {
        return Object.keys(this.players).length
    }

    public getPlayer(uid: string): Player {
        return this.players[uid]
    }

    public getPlayerRoom(uid: string): number {
        return this.players[uid].room
    }

    public movePlayer(uid: string, x: number, y: number): string[] {
        const oldCoordKey = `${this.players[uid].x}, ${this.players[uid].y}`
        if (this.playerPositions[this.players[uid].room][oldCoordKey]) {
            this.playerPositions[this.players[uid].room][oldCoordKey].delete(uid)
        }

        this.players[uid].x = x
        this.players[uid].y = y

        const coordKey = `${x}, ${y}`
        if (!this.playerPositions[this.players[uid].room][coordKey]) {
            this.playerPositions[this.players[uid].room][coordKey] = new Set<string>()
        }

        this.playerPositions[this.players[uid].room][coordKey].add(uid)

        return this.setProximityIdsWithPlayer(uid)
    }

    public setProximityIdsWithPlayer(uid: string): string[] {
        const player = this.players[uid]
        const proximityTiles = this.getProximityTiles(player.x, player.y)
        const changedPlayers: Set<string> = new Set<string>()
        const originalProximityId = player.proximityId
        let otherPlayersExist = false

        for (const tile of proximityTiles) {
            const playersInTile = this.playerPositions[player.room][tile]
            if (!playersInTile) continue

            for (const otherUid of playersInTile) {
                if (otherUid === uid) continue
                otherPlayersExist = true

                const otherPlayer = this.players[otherUid]
                if (otherPlayer.proximityId === null) {
                    if (player.proximityId === null) {
                        player.proximityId = uuidv4()
                        if (player.proximityId !== originalProximityId) {
                            changedPlayers.add(uid)
                        }
                    }

                    otherPlayer.proximityId = player.proximityId
                    changedPlayers.add(otherUid)
                } else if (player.proximityId !== otherPlayer.proximityId) {
                    player.proximityId = otherPlayer.proximityId
                    if (player.proximityId !== originalProximityId) {
                        changedPlayers.add(uid)
                    }
                }
            }
        }

        if (!otherPlayersExist) {
            player.proximityId = null
            if (originalProximityId !== null) {
                changedPlayers.add(uid)
            }
        }

        return Array.from(changedPlayers)
    }

    private getProximityTiles(x: number, y: number): string[] {
        const proximityTiles: string[] = []
        const range = 3

        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                proximityTiles.push(`${x + dx}, ${y + dy}`)
            }
        }

        return proximityTiles
    }
}

export const sessionManager = new SessionManager()
