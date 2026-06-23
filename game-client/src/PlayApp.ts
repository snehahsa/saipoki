import { App } from '@/utils/pixi/App'
import { Player } from '@/utils/pixi/Player/Player'
import { Point, RealmData, TilePoint } from '@/utils/pixi/types'
import * as PIXI from 'pixi.js'
import { server } from '@/utils/backend/server'
import { defaultSkin } from '@/utils/pixi/Player/skins'
import signal from '@/utils/signal'
import { Npc, NpcConfig, NPC_PATROL_RESUME_DELAY_MS } from './Npc'
import { buildInteractables, findActiveInteraction, InteractableEntry } from './interactions'
import { canGrantFlowHold, NpcFlowRequires } from './flows'

export class PlayApp extends App {
    private scale: number = 1.5
    public player: Player
    public blocked: Set<TilePoint> = new Set()
    public keysDown: string[] = []
    public padState = { up: false, down: false, left: false, right: false }
    private teleportLocation: Point | null = null
    public uid: string = ''
    public realmId: string = ''
    public players: { [key: string]: Player } = {}
    private npcs: Npc[] = []
    private activeNpcDialogue: Npc | null = null
    private interactables: InteractableEntry[] = []
    private activeInteractionKey: TilePoint | null = null
    private disableInput: boolean = false
    private kicked: boolean = false
    private playerHolds: Set<string> = new Set()
    private holdGrantRules: Record<string, NpcFlowRequires> = {}
    private cameraReady = false
    private resizeFrame: number | null = null

    constructor(
        uid: string,
        realmId: string,
        realmData: RealmData,
        username: string,
        skin: string = defaultSkin,
        holds: string[] = [],
        holdGrantRules: Record<string, NpcFlowRequires> = {},
        level: number = 1,
    ) {
        super(realmData)
        this.uid = uid
        this.realmId = realmId
        this.player = new Player(skin, this, username, true, level, uid)
        this.holdGrantRules = holdGrantRules
        const spawn = realmData.spawnpoint
        this.currentRoomIndex = spawn.roomIndex
        this.player.presetTilePosition(spawn.x, spawn.y)
        this.setPlayerHolds(holds)
    }

    public getPlayerHolds(): Set<string> {
        return this.playerHolds
    }

    public getHoldGrantRules(): Record<string, NpcFlowRequires> {
        return this.holdGrantRules
    }

    public setPlayerHolds(holds: string[]) {
        this.playerHolds = new Set(holds.filter(Boolean))
        this.rebuildInteractables()
        this.checkNearbyInteractions(this.player.currentTilePosition)
    }

    private rebuildInteractables() {
        this.interactables = buildInteractables(
            this.realmData.rooms[this.currentRoomIndex],
            this.playerHolds
        )
    }

    override async loadRoom(index: number) {
        this.currentRoomIndex = index
        this.players = {}
        this.destroyNpcs()
        this.activeNpcDialogue = null
        this.activeInteractionKey = null
        signal.emit('hideSignModal')
        await super.loadRoom(index)
        this.setUpBlockedTiles()
        this.rebuildInteractables()
        await this.spawnNpcs()
        await this.spawnLocalPlayer()
        await this.syncOtherPlayers()
        this.displayInitialChatMessage()
        this.checkNearbyInteractions(this.player.currentTilePosition)
    }

    private destroyNpcs = () => {
        for (const npc of this.npcs) {
            this.layers.object.removeChild(npc.parent)
            npc.destroy()
        }
        this.npcs = []
    }

    private async spawnNpcs() {
        const room = this.realmData.rooms[this.currentRoomIndex]
        const configs = (room.npcs || []) as NpcConfig[]

        for (const config of configs) {
            if (!config.path?.length) continue
            const npc = new Npc(config, this)
            await npc.init()
            this.layers.object.addChild(npc.parent)
            this.npcs.push(npc)
        }

        this.sortObjectsByY()
    }

    public checkNearbyInteractions = (playerPos: Point) => {
        if (!this.interactables.length) return

        const match = findActiveInteraction(this.interactables, playerPos)

        if (match && match.tileKey !== this.activeInteractionKey) {
            if (this.activeNpcDialogue?.isDialogueActive()) return
            this.activeInteractionKey = match.tileKey
            signal.emit('showSignModal', {
                title: match.title,
                message: match.message,
                source: 'item',
                options: match.options,
                showExit: match.showExit,
                tileKey: match.tileKey,
                portal: match.portal,
            })
        } else if (!match && this.activeInteractionKey) {
            this.activeInteractionKey = null
            if (!this.activeNpcDialogue?.isDialogueActive()) {
                signal.emit('hideSignModal')
            }
        }
    }

    public checkNpcNotices = (playerPos: Point) => {
        const playerWorld = { x: this.player.parent.x, y: this.player.parent.y }
        for (const npc of this.npcs) {
            npc.checkPlayerNotice(playerPos, playerWorld)
        }
    }

    public beginNpcEncounter = (npc: Npc) => {
        this.player.setFrozen(true)
        this.clearPadInput()
        this.player.haltForNpcEncounter(npc.currentTilePosition)
    }

    public endNpcEncounter = () => {
        this.player.setFrozen(false)
    }

    private resumeAllNpcPatrols = (activeNpc: Npc | null = null, delayMs = NPC_PATROL_RESUME_DELAY_MS) => {
        for (const npc of this.npcs) {
            if (npc === activeNpc) {
                npc.resumePatrolAfterEncounter(delayMs)
            } else if (npc.isHeldForEncounter()) {
                npc.resumePatrolAfterEncounter(0)
            }
        }
    }

    public showNpcMessage = (npc: Npc, message: string, index: number, total: number) => {
        for (const other of this.npcs) {
            if (other !== npc) {
                other.resumePatrolAfterEncounter(0)
            }
        }

        this.activeNpcDialogue = npc
        this.activeInteractionKey = null
        if (index === 0) {
            signal.emit('npcEncounterAlert')
        }
        signal.emit('showSignModal', {
            title: npc.name,
            message,
            source: 'npc',
            messageIndex: index,
            messageTotal: total,
            hasMore: index < total - 1,
            npcId: npc.id,
            messageSetId: npc.getMessageSetId(),
        })
    }

    private resolveNpcDialogueRewards(npc: Npc) {
        const flow = npc.getActiveFlow()
        const holds = this.getPlayerHolds()
        if (flow) {
            if (flow.grantHold && canGrantFlowHold(flow, holds, this.holdGrantRules)) {
                signal.emit('grantHold', { item: flow.grantHold, source: `npc:${npc.id}` })
            }
            if (flow.questStep && (!flow.grantHold || canGrantFlowHold(flow, holds, this.holdGrantRules))) {
                signal.emit('questStep', {
                    step_id: flow.questStep,
                    quest_id: flow.questId || 'week1_vault_trail',
                })
            }
            return
        }

        const onComplete = npc.getOnComplete()
        if (onComplete?.grantHold) {
            signal.emit('grantHold', { item: onComplete.grantHold, source: `npc:${npc.id}` })
        }
        if (onComplete?.questStep) {
            signal.emit('questStep', {
                step_id: onComplete.questStep,
                quest_id: onComplete.questId || 'week1_vault_trail',
            })
        }
    }

    private endNpcDialogueSession(npc: Npc, patrolDelayMs = NPC_PATROL_RESUME_DELAY_MS) {
        this.resolveNpcDialogueRewards(npc)
        this.activeNpcDialogue = null
        this.endNpcEncounter()
        this.resumeAllNpcPatrols(npc, patrolDelayMs)
    }

    public finishNpcDialogue = (options?: { patrolDelayMs?: number }): boolean => {
        const npc = this.activeNpcDialogue
        if (!npc) return false

        const patrolDelayMs = options?.patrolDelayMs ?? NPC_PATROL_RESUME_DELAY_MS
        this.endNpcDialogueSession(npc, patrolDelayMs)
        signal.emit('hideSignModal', { fromNpcFinish: true })
        return true
    }

    public advanceNpcDialogue = (): boolean => {
        const npc = this.activeNpcDialogue
        if (!npc) return false

        const advanced = npc.advanceDialogue()
        if (!advanced) {
            this.endNpcDialogueSession(npc)
            signal.emit('hideSignModal', { fromNpcFinish: true })
        }
        return advanced
    }

    /** Safety net when the UI closes without going through finishNpcDialogue. */
    public onSignModalClosed = () => {
        if (this.activeNpcDialogue) {
            this.finishNpcDialogue()
            return
        }

        for (const npc of this.npcs) {
            if (npc.isHeldForEncounter()) {
                npc.resumePatrolAfterEncounter(0)
            }
        }
    }

    private async loadAssets() {
        await Promise.all([
            PIXI.Assets.load('/fonts/silkscreen.ttf'),
            PIXI.Assets.load('/fonts/nunito.ttf'),
        ])
    }

    private async syncOtherPlayers() {
        const { data, error } = await server.getPlayersInRoom(this.currentRoomIndex)
        if (error || !data) {
            console.error('Failed to get player positions in room:', error)
            return
        }

        for (const player of data.players) {
            if (player.uid === this.uid) continue
            this.updatePlayer(player.uid, player)
        }

        this.sortObjectsByY()
    }

    private async updatePlayer(uid: string, player: any) {
        if (uid in this.players) {
            if (player.username) {
                this.players[uid].setUsername(player.username)
            }
            if (player.level != null) {
                this.players[uid].setLevel(player.level)
            }
            if (this.players[uid].skin !== player.skin) {
                await this.players[uid].changeSkin(player.skin)
            }
            if (
                this.players[uid].currentTilePosition.x !== player.x ||
                this.players[uid].currentTilePosition.y !== player.y
            ) {
                this.players[uid].setPosition(player.x, player.y)
            }
        } else {
            await this.spawnPlayer(
                player.uid,
                player.skin,
                player.username,
                player.x,
                player.y,
                player.level ?? 1,
            )
        }
    }

    private async spawnPlayer(
        uid: string,
        skin: string,
        username: string,
        x: number,
        y: number,
        level: number = 1,
    ) {
        const otherPlayer = new Player(skin, this, username, false, level, uid)
        await otherPlayer.init()
        otherPlayer.setPosition(x, y)
        this.layers.object.addChild(otherPlayer.parent)
        this.players[uid] = otherPlayer
        this.sortObjectsByY()
    }

    public async init() {
        await super.init()

        const container = document.getElementById('app-container')
        const canvas = this.getApp().canvas
        if (container && !container.contains(canvas)) {
            container.appendChild(canvas)
        }

        canvas.style.visibility = 'hidden'

        this.app.stage.eventMode = 'static'
        this.setScale(this.scale)
        this.snapCameraToPlayer()

        await this.loadAssets()
        await this.loadRoom(this.realmData.spawnpoint.roomIndex)

        await this.waitForStableCamera()
        this.cameraReady = true
        canvas.style.visibility = 'visible'

        this.app.renderer.on('resize', this.resizeEvent)

        this.setUpSignalListeners()
        this.setUpSocketEvents()
        this.setUpKeyboardEvents()
    }

    private normalizeMovementKey(key: string) {
        return key.length === 1 ? key.toLowerCase() : key
    }

    private isMovementKey(key: string) {
        return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
            || key === 'w' || key === 'a' || key === 's' || key === 'd'
    }

    private setUpKeyboardEvents = () => {
        document.addEventListener('keydown', this.keydown)
        document.addEventListener('keyup', this.keyup)
    }

    private removeKeyboardEvents = () => {
        document.removeEventListener('keydown', this.keydown)
        document.removeEventListener('keyup', this.keyup)
    }

    private keydown = (event: KeyboardEvent) => {
        if (this.disableInput || this.player.frozen) return

        const key = this.normalizeMovementKey(event.key)
        if (!this.isMovementKey(key)) return
        if (this.keysDown.includes(key)) return

        event.preventDefault()
        this.player.keydown(event)
        this.keysDown.push(key)
    }

    private keyup = (event: KeyboardEvent) => {
        const key = this.normalizeMovementKey(event.key)
        this.keysDown = this.keysDown.filter((k) => k !== key)
    }

    public getPadInput = (): Point => {
        const { up, down, left, right } = this.padState
        if (up && !down) return { x: 0, y: -1 }
        if (down && !up) return { x: 0, y: 1 }
        if (left && !right) return { x: -1, y: 0 }
        if (right && !left) return { x: 1, y: 0 }
        return { x: 0, y: 0 }
    }

    public setPadDirection = (direction: 'up' | 'down' | 'left' | 'right', active: boolean) => {
        if (this.disableInput || this.player.frozen) return

        this.padState[direction] = active
        const input = this.getPadInput()

        if (input.x === 0 && input.y === 0) return

        this.player.setMovementMode('keyboard')

        if (!this.player.isMoving()) {
            const { x, y } = this.player.currentTilePosition
            this.player.moveToTile(x + input.x, y + input.y)
        }
    }

    public clearPadInput = () => {
        this.padState = { up: false, down: false, left: false, right: false }
    }

    private spawnLocalPlayer = async () => {
        if (this.teleportLocation) {
            this.player.setPosition(this.teleportLocation.x, this.teleportLocation.y)
            this.teleportLocation = null
        } else if (this.currentRoomIndex === this.realmData.spawnpoint.roomIndex) {
            this.player.setPosition(this.realmData.spawnpoint.x, this.realmData.spawnpoint.y)
        }

        await this.player.init()

        this.layers.object.addChild(this.player.parent)
        this.sortObjectsByY()
        this.snapCameraToPlayer()
    }

    private setScale = (newScale: number) => {
        this.scale = newScale
        this.app.stage.scale.set(this.scale)
    }

    private snapCameraToPlayer = (): boolean => {
        const width = this.app.screen.width
        const height = this.app.screen.height
        if (width <= 0 || height <= 0) return false

        const x = this.player.parent.x - width / 2 / this.scale
        const y = this.player.parent.y - height / 2 / this.scale
        this.app.stage.pivot.set(x, y)
        return true
    }

    private async waitForStableCamera() {
        this.app.renderer.resize()
        for (let i = 0; i < 8; i++) {
            if (this.snapCameraToPlayer()) return
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        this.snapCameraToPlayer()
    }

    public moveCameraToPlayer = () => {
        this.snapCameraToPlayer()
    }

    private resizeEvent = () => {
        if (!this.cameraReady) return
        if (this.resizeFrame !== null) {
            cancelAnimationFrame(this.resizeFrame)
        }
        this.resizeFrame = requestAnimationFrame(() => {
            this.resizeFrame = null
            this.snapCameraToPlayer()
        })
    }

    private setUpBlockedTiles = () => {
        this.blocked = new Set<TilePoint>()

        for (const [key, value] of Object.entries(this.realmData.rooms[this.currentRoomIndex].tilemap)) {
            if (value.impassable) {
                this.blocked.add(key as TilePoint)
            }
        }

        for (const [key, value] of Object.entries(this.collidersFromSpritesMap)) {
            if (value) {
                this.blocked.add(key as TilePoint)
            }
        }
    }

    public teleportIfOnTeleportSquare = (x: number, y: number) => {
        const tile = `${x}, ${y}` as TilePoint
        const teleport = this.realmData.rooms[this.currentRoomIndex].tilemap[tile]?.teleporter
        if (teleport) {
            this.teleport(teleport.roomIndex, teleport.x, teleport.y)
            return true
        }
        return false
    }

    public teleportToMapId = async (mapId: string, x: number, y: number) => {
        const trimmed = mapId.trim()
        let roomIndex = this.realmData.rooms.findIndex(
            (room) => (room.id || '').trim() === trimmed
        )
        if (roomIndex < 0) {
            const numeric = trimmed.match(/^map-(\d+)$/i)
            if (numeric) roomIndex = Number(numeric[1])
        }
        if (roomIndex < 0 || !this.realmData.rooms[roomIndex]) {
            console.error(`Portal target map "${trimmed}" not found`)
            return false
        }
        this.activeInteractionKey = null
        signal.emit('hideSignModal')
        await this.teleport(roomIndex, x, y)
        this.checkNearbyInteractions(this.player.currentTilePosition)
        return true
    }

    private teleport = async (roomIndex: number, x: number, y: number) => {
        if (!this.realmData.rooms[roomIndex]) {
            console.error(`Teleport blocked: room ${roomIndex} does not exist`)
            return
        }

        this.player.setFrozen(true)

        if (this.currentRoomIndex === roomIndex) {
            this.player.setPosition(x, y)
            this.moveCameraToPlayer()
        } else {
            this.teleportLocation = { x, y }
            this.currentRoomIndex = roomIndex
            this.player.changeAnimationState('idle_down')
            await this.loadRoom(roomIndex)
        }

        server.socket.emit('teleport', { x, y, roomIndex })
        this.player.setFrozen(false)
    }

    public hasTeleport = (x: number, y: number) => {
        const tile = `${x}, ${y}` as TilePoint
        return this.realmData.rooms[this.currentRoomIndex].tilemap[tile]?.teleporter
    }

    private destroyPlayers = () => {
        for (const player of Object.values(this.players)) {
            player.destroy()
        }
        this.player.destroy()
        this.destroyNpcs()
    }

    private onPlayerLeftRoom = (uid: string) => {
        if (this.players[uid]) {
            this.players[uid].destroy()
            this.layers.object.removeChild(this.players[uid].parent)
            delete this.players[uid]
        }
    }

    private onPlayerJoinedRoom = (playerData: any) => {
        const isNew = !(playerData.uid in this.players) && playerData.uid !== this.uid
        this.updatePlayer(playerData.uid, playerData)
        if (isNew) {
            signal.emit('playerJoined', { username: playerData.username })
        }
    }

    private onPlayerMoved = (data: any) => {
        if (this.blocked.has(`${data.x}, ${data.y}`)) return

        const player = this.players[data.uid]
        if (player) {
            player.moveToTile(data.x, data.y)
        }
    }

    private onPlayerTeleported = (data: any) => {
        const player = this.players[data.uid]
        if (player) {
            player.setPosition(data.x, data.y)
        }
    }

    private onPlayerChangedSkin = (data: any) => {
        const player = this.players[data.uid]
        if (player) {
            player.changeSkin(data.skin)
        }
    }

    private setUpSignalListeners = () => {
        signal.on('requestSkin', this.onRequestSkin)
        signal.on('switchSkin', this.onSwitchSkin)
        signal.on('disableInput', this.onDisableInput)
        signal.on('message', this.onMessage)
    }

    private removeSignalListeners = () => {
        signal.off('requestSkin', this.onRequestSkin)
        signal.off('switchSkin', this.onSwitchSkin)
        signal.off('disableInput', this.onDisableInput)
        signal.off('message', this.onMessage)
    }

    private onRequestSkin = () => {
        signal.emit('skin', this.player.skin)
    }

    private onSwitchSkin = (skin: string) => {
        this.player.changeSkin(skin)
        server.socket.emit('changedSkin', skin)
    }

    private onDisableInput = (disable: boolean) => {
        this.disableInput = disable
        this.keysDown = []
        this.clearPadInput()
    }

    private onKicked = (message: string) => {
        this.kicked = true
        this.removeEvents()
        signal.emit('showKickedModal', message)
    }

    private onDisconnect = () => {
        this.removeEvents()
        if (!this.kicked) {
            signal.emit('showDisconnectModal')
        }
    }

    private onMessage = (message: string) => {
        this.player.setMessage(message)
        server.socket.emit('sendMessage', message)
    }

    private onReceiveMessage = (data: any) => {
        const player = this.players[data.uid]
        if (player) {
            player.setMessage(data.message)
        }
    }

    private displayInitialChatMessage = () => {
        signal.emit('newRoomChat', {
            name: this.realmData.rooms[this.currentRoomIndex].name,
        })
    }

    private setUpSocketEvents = () => {
        server.socket.on('playerLeftRoom', this.onPlayerLeftRoom)
        server.socket.on('playerJoinedRoom', this.onPlayerJoinedRoom)
        server.socket.on('playerMoved', this.onPlayerMoved)
        server.socket.on('playerTeleported', this.onPlayerTeleported)
        server.socket.on('playerChangedSkin', this.onPlayerChangedSkin)
        server.socket.on('receiveMessage', this.onReceiveMessage)
        server.socket.on('disconnect', this.onDisconnect)
        server.socket.on('kicked', this.onKicked)
    }

    private removeSocketEvents = () => {
        server.socket.off('playerLeftRoom', this.onPlayerLeftRoom)
        server.socket.off('playerJoinedRoom', this.onPlayerJoinedRoom)
        server.socket.off('playerMoved', this.onPlayerMoved)
        server.socket.off('playerTeleported', this.onPlayerTeleported)
        server.socket.off('playerChangedSkin', this.onPlayerChangedSkin)
        server.socket.off('receiveMessage', this.onReceiveMessage)
        server.socket.off('disconnect', this.onDisconnect)
        server.socket.off('kicked', this.onKicked)
    }

    private removeEvents = () => {
        this.removeKeyboardEvents()
        this.removeSocketEvents()
        this.destroyPlayers()
        server.disconnect()
        this.removeSignalListeners()
    }

    public destroy() {
        this.cameraReady = false
        if (this.resizeFrame !== null) {
            cancelAnimationFrame(this.resizeFrame)
            this.resizeFrame = null
        }
        if (this.initialized) {
            this.app.renderer.off('resize', this.resizeEvent)
        }
        this.clearPadInput()
        this.removeEvents()
        super.destroy()
    }
}
