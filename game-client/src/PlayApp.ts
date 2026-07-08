import { App } from '@/utils/pixi/App'
import { Player } from '@/utils/pixi/Player/Player'
import { Direction, Point, RealmData, TilePoint } from '@/utils/pixi/types'
import * as PIXI from 'pixi.js'
import { server } from '@/utils/backend/server'
import { defaultSkin } from '@/utils/pixi/Player/skins'
import signal from '@/utils/signal'
import { Npc, NpcConfig, NPC_PATROL_RESUME_DELAY_MS } from './Npc'
import { buildInteractables, findActiveInteraction, InteractableEntry } from './interactions'
import { canGrantFlowHold, NpcFlowRequires } from './flows'
import { buildGearUseTargets, GearUseTarget, resolveGearUse } from './gearTargets'
import { getGearItem } from './gearCatalog'
import { computeMapBoundaryBlockedTiles } from './mapBoundary'

export class PlayApp extends App {
    private static readonly TILE_SIZE = 32
    private static readonly SPECTATOR_ZOOM_PADDING = 0.92
    private static readonly SPECTATOR_MAX_ZOOM_FACTOR = 3

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
    private gearUseTargets: GearUseTarget[] = []
    private equippedGearId: string | null = null
    private playerGear: Set<string> = new Set()
    private fishingMode: string = 'fish'
    private cameraReady = false
    private resizeFrame: number | null = null
    private spectatorMode = false
    private spectatorPivot = { x: 0, y: 0 }
    private spectatorFitScale = 0.35
    private spectatorDragging = false
    private spectatorDragLast = { x: 0, y: 0 }
    private spectatorPointers = new Map<number, { x: number; y: number }>()
    private spectatorPinchDistance = 0
    private spectatorPinchScale = 1
    private spectatorWheelTarget: HTMLElement | null = null
    private spectatorPointerTarget: HTMLCanvasElement | null = null
    private spectatorActivePointerId: number | null = null
    private enterAsSpectator = false

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

    public setEnterAsSpectator(value: boolean) {
        this.enterAsSpectator = value
    }

    public getPlayerHolds(): Set<string> {
        return this.playerHolds
    }

    public setPlayerGear(gearIds: string[]) {
        this.playerGear = new Set(gearIds.filter(Boolean))
    }

    public getPlayerGear(): Set<string> {
        return this.playerGear
    }

    public setFishingMode(mode: string) {
        if (mode) this.fishingMode = mode
    }

    public getFishingMode(): string {
        return this.fishingMode
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
        for (const remote of Object.values(this.players)) {
            if (this.layers.object.children.includes(remote.parent)) {
                this.layers.object.removeChild(remote.parent)
            }
            remote.destroy()
        }
        this.players = {}
        this.destroyNpcs()
        this.activeNpcDialogue = null
        this.activeInteractionKey = null
        signal.emit('hideSignModal')
        await super.loadRoom(index)
        this.setUpBlockedTiles()
        this.rebuildInteractables()
        this.gearUseTargets = await buildGearUseTargets(
            this.realmData.rooms[this.currentRoomIndex]
        )
        await this.spawnNpcs()
        await this.spawnLocalPlayer()
        await this.syncOtherPlayers()
        this.displayInitialChatMessage()
        this.checkNearbyInteractions(this.player.currentTilePosition)
        if (this.spectatorMode) {
            this.fitSpectatorCameraToRoom()
        }
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
            if (flow.takeGear) {
                signal.emit('takeGear', { item: flow.takeGear, source: `npc:${npc.id}` })
            }
            if (flow.grantHold && canGrantFlowHold(flow, holds, this.holdGrantRules)) {
                signal.emit('grantHold', { item: flow.grantHold, source: `npc:${npc.id}` })
            }
            if (flow.grantGear) {
                signal.emit('grantGear', { item: flow.grantGear, source: `npc:${npc.id}` })
            }
            if (flow.questStep && (!flow.grantHold || canGrantFlowHold(flow, holds, this.holdGrantRules))) {
                signal.emit('questStep', {
                    step_id: flow.questStep,
                    quest_id: flow.questId || 'week1_vault_trail',
                })
            }
            if (flow.grantBalanceId && Number(flow.grantBalance) > 0) {
                signal.emit('grantBalance', {
                    grant_id: flow.grantBalanceId,
                    amount: flow.grantBalance,
                    source: `npc:${npc.id}`,
                })
            }
            return
        }

        const onComplete = npc.getOnComplete()
        if (onComplete?.grantHold) {
            signal.emit('grantHold', { item: onComplete.grantHold, source: `npc:${npc.id}` })
        }
        if (onComplete?.grantGear) {
            signal.emit('grantGear', { item: onComplete.grantGear, source: `npc:${npc.id}` })
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
            const remoteGear = player.equippedGear ?? null
            if (remoteGear !== this.players[uid].getEquippedGearId()) {
                await this.players[uid].setEquippedGear(remoteGear)
            }
        } else {
            await this.spawnPlayer(
                player.uid,
                player.skin,
                player.username,
                player.x,
                player.y,
                player.level ?? 1,
                player.equippedGear ?? null,
            )
        }
    }

    public attachEntityLabels(container: PIXI.Container) {
        this.layers.labels.addChild(container)
    }

    public detachEntityLabels(container: PIXI.Container) {
        if (container.parent === this.layers.labels) {
            this.layers.labels.removeChild(container)
        }
    }

    private async spawnPlayer(
        uid: string,
        skin: string,
        username: string,
        x: number,
        y: number,
        level: number = 1,
        equippedGear: string | null = null,
    ) {
        const otherPlayer = new Player(skin, this, username, false, level, uid)
        await otherPlayer.init()
        otherPlayer.setPosition(x, y)
        if (equippedGear) {
            await otherPlayer.setEquippedGear(equippedGear)
        }
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

        if (this.enterAsSpectator) {
            this.enableSpectatorMode()
        }

        await this.waitForStableCamera()
        await this.waitForFirstFrame()
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

    private isTypingTarget(event: KeyboardEvent) {
        const target = event.target
        if (target instanceof HTMLElement) {
            if (target.isContentEditable) return true
            const tag = target.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
            if (target.closest("[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']")) {
                return true
            }
        }

        const active = document.activeElement
        if (active instanceof HTMLElement) {
            if (active.isContentEditable) return true
            const tag = active.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
        }

        return false
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
        if (event.isComposing || this.isTypingTarget(event)) return

        const key = this.normalizeMovementKey(event.key)
        if (!this.isMovementKey(key)) return
        if (this.keysDown.includes(key)) return

        event.preventDefault()
        this.player.keydown(event)
        this.keysDown.push(key)
    }

    private keyup = (event: KeyboardEvent) => {
        if (event.isComposing || this.isTypingTarget(event)) return
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

    public enableSpectatorMode() {
        this.spectatorMode = true
        this.disableInput = true
        this.clearPadInput()
        this.keysDown = []
        this.player.frozen = true
        if (this.player?.parent) {
            this.player.parent.visible = false
        }
        this.fitSpectatorCameraToRoom()
        this.setupSpectatorCameraControls()
    }

    private getRoomWorldBounds() {
        const room = this.realmData.rooms[this.currentRoomIndex]
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity

        for (const key of Object.keys(room?.tilemap || {})) {
            const [x, y] = key.split(',').map((part) => Number(part.trim()))
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
        }

        if (!Number.isFinite(minX)) {
            minX = 0
            minY = 0
            maxX = 24
            maxY = 24
        }

        const tile = PlayApp.TILE_SIZE
        return {
            minX: minX * tile,
            minY: minY * tile,
            maxX: (maxX + 1) * tile,
            maxY: (maxY + 1) * tile,
            width: (maxX - minX + 1) * tile,
            height: (maxY - minY + 1) * tile,
            centerX: ((minX + maxX + 1) * tile) / 2,
            centerY: ((minY + maxY + 1) * tile) / 2,
        }
    }

    private getSpectatorScaleLimits() {
        const minScale = this.spectatorFitScale
        return {
            min: minScale,
            max: minScale * PlayApp.SPECTATOR_MAX_ZOOM_FACTOR,
        }
    }

    private clampSpectatorScale(nextScale: number) {
        const { min, max } = this.getSpectatorScaleLimits()
        return Math.min(max, Math.max(min, nextScale))
    }

    private applySpectatorCamera() {
        this.setScale(this.scale)
        this.app.stage.pivot.set(this.spectatorPivot.x, this.spectatorPivot.y)
    }

    private clampSpectatorPivot() {
        const bounds = this.getRoomWorldBounds()
        const width = this.app.screen.width
        const height = this.app.screen.height
        if (width <= 0 || height <= 0) return

        const visibleW = width / this.scale
        const visibleH = height / this.scale
        const slackX = visibleW * 0.15
        const slackY = visibleH * 0.15

        const minPivotX = bounds.minX - slackX
        const maxPivotX = bounds.maxX + slackX - visibleW
        const minPivotY = bounds.minY - slackY
        const maxPivotY = bounds.maxY + slackY - visibleH

        if (maxPivotX >= minPivotX) {
            this.spectatorPivot.x = Math.min(maxPivotX, Math.max(minPivotX, this.spectatorPivot.x))
        } else {
            this.spectatorPivot.x = (bounds.minX + bounds.maxX - visibleW) / 2
        }

        if (maxPivotY >= minPivotY) {
            this.spectatorPivot.y = Math.min(maxPivotY, Math.max(minPivotY, this.spectatorPivot.y))
        } else {
            this.spectatorPivot.y = (bounds.minY + bounds.maxY - visibleH) / 2
        }
    }

    private fitSpectatorCameraToRoom() {
        const bounds = this.getRoomWorldBounds()
        const width = this.app.screen.width
        const height = this.app.screen.height
        if (width <= 0 || height <= 0) return

        const fitScale = Math.min(
            width / Math.max(bounds.width, PlayApp.TILE_SIZE),
            height / Math.max(bounds.height, PlayApp.TILE_SIZE),
        ) * PlayApp.SPECTATOR_ZOOM_PADDING

        this.spectatorFitScale = fitScale
        this.scale = fitScale
        this.spectatorPivot.x = bounds.centerX - width / 2 / fitScale
        this.spectatorPivot.y = bounds.centerY - height / 2 / fitScale
        this.clampSpectatorPivot()
        this.applySpectatorCamera()
    }

    private zoomSpectatorAt(screenX: number, screenY: number, factor: number) {
        const nextScale = this.clampSpectatorScale(this.scale * factor)
        if (nextScale === this.scale) return

        this.spectatorPivot.x += screenX * (1 / this.scale - 1 / nextScale)
        this.spectatorPivot.y += screenY * (1 / this.scale - 1 / nextScale)
        this.scale = nextScale
        this.clampSpectatorPivot()
        this.applySpectatorCamera()
    }

    private setupSpectatorCameraControls() {
        const canvas = this.getApp().canvas as HTMLCanvasElement
        this.spectatorPointerTarget = canvas
        this.spectatorWheelTarget = canvas
        canvas.style.touchAction = 'none'
        canvas.style.cursor = 'grab'

        canvas.addEventListener('pointerdown', this.onSpectatorDomPointerDown)
        canvas.addEventListener('wheel', this.onSpectatorWheel, { passive: false })
    }

    private bindSpectatorPointerTracking() {
        window.addEventListener('pointermove', this.onSpectatorDomPointerMove)
        window.addEventListener('pointerup', this.onSpectatorDomPointerUp)
        window.addEventListener('pointercancel', this.onSpectatorDomPointerUp)
    }

    private unbindSpectatorPointerTracking() {
        window.removeEventListener('pointermove', this.onSpectatorDomPointerMove)
        window.removeEventListener('pointerup', this.onSpectatorDomPointerUp)
        window.removeEventListener('pointercancel', this.onSpectatorDomPointerUp)
    }

    private setSpectatorDraggingUi(dragging: boolean) {
        document.body.classList.toggle('spectator-dragging', dragging)
        if (this.spectatorPointerTarget) {
            this.spectatorPointerTarget.style.cursor = dragging ? 'grabbing' : 'grab'
        }
    }

    private removeSpectatorCameraControls() {
        this.unbindSpectatorPointerTracking()

        const canvas = this.spectatorPointerTarget
        if (canvas) {
            canvas.removeEventListener('pointerdown', this.onSpectatorDomPointerDown)
            canvas.style.cursor = ''
            canvas.style.touchAction = ''
        }

        this.spectatorPointerTarget = null
        this.spectatorWheelTarget?.removeEventListener('wheel', this.onSpectatorWheel)
        this.spectatorWheelTarget = null
        this.spectatorActivePointerId = null
        this.spectatorDragging = false
        this.spectatorPointers.clear()
        this.spectatorPinchDistance = 0
        this.setSpectatorDraggingUi(false)
    }

    private applySpectatorDragDelta(dx: number, dy: number) {
        if (dx === 0 && dy === 0) return
        this.spectatorPivot.x -= dx / this.scale
        this.spectatorPivot.y -= dy / this.scale
        this.clampSpectatorPivot()
        this.applySpectatorCamera()
    }

    private onSpectatorDomPointerDown = (event: PointerEvent) => {
        if (!this.spectatorMode) return
        if (event.pointerType === 'mouse' && event.button !== 0) return

        const canvas = this.spectatorPointerTarget
        if (!canvas || event.target !== canvas) return

        event.preventDefault()

        if (this.spectatorPointers.size === 0) {
            this.bindSpectatorPointerTracking()
        }

        this.spectatorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

        if (this.spectatorPointers.size === 1) {
            this.spectatorActivePointerId = event.pointerId
            this.spectatorDragging = true
            this.spectatorDragLast = { x: event.clientX, y: event.clientY }
            this.setSpectatorDraggingUi(true)
            try {
                canvas.setPointerCapture(event.pointerId)
            } catch {
                // Pointer capture is optional; window listeners still track drag.
            }
        } else if (this.spectatorPointers.size === 2) {
            this.spectatorDragging = false
            this.setSpectatorDraggingUi(false)
            const points = [...this.spectatorPointers.values()]
            const dx = points[1].x - points[0].x
            const dy = points[1].y - points[0].y
            this.spectatorPinchDistance = Math.hypot(dx, dy)
            this.spectatorPinchScale = this.scale
        }
    }

    private onSpectatorDomPointerMove = (event: PointerEvent) => {
        if (!this.spectatorMode || !this.spectatorPointers.has(event.pointerId)) return

        this.spectatorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

        if (this.spectatorPointers.size >= 2) {
            const points = [...this.spectatorPointers.values()]
            const dx = points[1].x - points[0].x
            const dy = points[1].y - points[0].y
            const distance = Math.hypot(dx, dy)
            const midpointX = (points[0].x + points[1].x) / 2
            const midpointY = (points[0].y + points[1].y) / 2
            const canvas = this.spectatorPointerTarget
            const rect = canvas?.getBoundingClientRect()

            if (this.spectatorPinchDistance > 0 && rect) {
                const factor = distance / this.spectatorPinchDistance
                const targetScale = this.clampSpectatorScale(this.spectatorPinchScale * factor)
                const zoomFactor = targetScale / this.scale
                if (zoomFactor !== 1) {
                    this.zoomSpectatorAt(midpointX - rect.left, midpointY - rect.top, zoomFactor)
                }
            }
            return
        }

        if (!this.spectatorDragging || event.pointerId !== this.spectatorActivePointerId) return

        const dx = event.clientX - this.spectatorDragLast.x
        const dy = event.clientY - this.spectatorDragLast.y
        this.spectatorDragLast = { x: event.clientX, y: event.clientY }
        this.applySpectatorDragDelta(dx, dy)
    }

    private onSpectatorDomPointerUp = (event: PointerEvent) => {
        if (!this.spectatorMode) return

        const canvas = this.spectatorPointerTarget
        try {
            canvas?.releasePointerCapture(event.pointerId)
        } catch {
            // Ignore release failures.
        }

        this.spectatorPointers.delete(event.pointerId)
        if (event.pointerId === this.spectatorActivePointerId) {
            this.spectatorActivePointerId = null
        }

        if (this.spectatorPointers.size < 2) {
            this.spectatorPinchDistance = 0
        }

        if (this.spectatorPointers.size === 0) {
            this.spectatorDragging = false
            this.setSpectatorDraggingUi(false)
            this.unbindSpectatorPointerTracking()
        } else if (this.spectatorPointers.size === 1) {
            const [remainingId, remainingPoint] = [...this.spectatorPointers.entries()][0]
            this.spectatorActivePointerId = remainingId
            this.spectatorDragging = true
            this.spectatorDragLast = { x: remainingPoint.x, y: remainingPoint.y }
            this.setSpectatorDraggingUi(true)
        }
    }

    private onSpectatorWheel = (event: WheelEvent) => {
        if (!this.spectatorMode) return
        event.preventDefault()

        const canvas = this.getApp().canvas
        const rect = canvas.getBoundingClientRect()
        const sx = event.clientX - rect.left
        const sy = event.clientY - rect.top
        const factor = event.deltaY > 0 ? 0.9 : 1.1
        this.zoomSpectatorAt(sx, sy, factor)
    }

    private spawnLocalPlayer = async () => {
        if (this.teleportLocation) {
            this.player.setPosition(this.teleportLocation.x, this.teleportLocation.y)
            this.teleportLocation = null
        } else if (this.currentRoomIndex === this.realmData.spawnpoint.roomIndex) {
            this.player.setPosition(this.realmData.spawnpoint.x, this.realmData.spawnpoint.y)
        }

        await this.player.init()

        if (this.equippedGearId) {
            await this.player.setEquippedGear(this.equippedGearId)
        }

        this.layers.object.addChild(this.player.parent)
        this.sortObjectsByY()
        this.snapCameraToPlayer()
    }

    private setScale = (newScale: number) => {
        this.scale = newScale
        this.app.stage.scale.set(this.scale)
    }

    private snapCameraToPlayer = (): boolean => {
        if (this.spectatorMode) {
            this.applySpectatorCamera()
            return true
        }

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

    private async waitForFirstFrame() {
        this.app.renderer.render(this.app.stage)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
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
            if (this.spectatorMode) {
                this.clampSpectatorPivot()
                this.applySpectatorCamera()
                return
            }
            this.snapCameraToPlayer()
        })
    }

    private setUpBlockedTiles = () => {
        this.blocked = new Set<TilePoint>()
        const room = this.realmData.rooms[this.currentRoomIndex]

        for (const [key, value] of Object.entries(room.tilemap)) {
            if (value.impassable) {
                this.blocked.add(key as TilePoint)
            }
        }

        for (const [key, value] of Object.entries(this.collidersFromSpritesMap)) {
            if (value) {
                this.blocked.add(key as TilePoint)
            }
        }

        const boundaryBlocked = computeMapBoundaryBlockedTiles(
            room.mapBoundary,
            room.tilemap,
            this.realmData.spawnpoint,
        )
        for (const key of boundaryBlocked) {
            this.blocked.add(key as TilePoint)
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

    private onPlayerChangedGear = async (data: any) => {
        const player = this.players[data.uid]
        if (!player) return
        const gearId = data.equippedGear ?? null
        if (gearId !== player.getEquippedGearId()) {
            await player.setEquippedGear(gearId)
            this.sortObjectsByY()
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
        server.socket.on('playerChangedGear', this.onPlayerChangedGear)
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
        server.socket.off('playerChangedGear', this.onPlayerChangedGear)
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

    public setEquippedGear = async (gearId: string | null) => {
        this.equippedGearId = gearId
        await this.player.setEquippedGear(gearId)
        this.sortObjectsByY()
        if (server.socket?.connected) {
            server.socket.emit('changedGear', gearId)
        }
    }

    public tryUseGear = (): { success: boolean; message: string; animId?: string } => {
        const gearId = this.equippedGearId
        if (!gearId) {
            return { success: false, message: 'No gear equipped' }
        }

        const item = getGearItem(gearId)
        if (!item) {
            return { success: false, message: 'Unknown gear' }
        }

        const direction = this.player.getDirection()
        const useFacings: Direction[] = item.useFacings?.length
            ? (item.useFacings as Direction[])
            : [((item.requiresFacing || item.sprite?.direction || 'left') as Direction)]

        if (!this.gearUseTargets.length) {
            return { success: false, message: 'Nothing to use gear on in this area' }
        }

        const resolved = resolveGearUse(
            this.player.currentTilePosition,
            direction,
            this.gearUseTargets,
            useFacings
        )
        if (!resolved) {
            const label = useFacings.join(' or ')
            return {
                success: false,
                message: `Stand next to water and face ${label}`,
            }
        }

        if (resolved.needsFace) {
            this.player.faceToward(resolved.faceTile)
        }

        const mode = this.fishingMode
        const modeLabels: Record<string, string> = {
            fish: 'River Fish',
            pokemon: 'Water Pokémon',
            salvage: 'Salvage',
        }
        const modeLabel = modeLabels[mode] || mode

        signal.emit('gearUsed', {
            item: gearId,
            animId: resolved.target.animId,
            mode,
            x: this.player.currentTilePosition.x,
            y: this.player.currentTilePosition.y,
        })

        return {
            success: true,
            message: `Casting for ${modeLabel}…`,
            animId: resolved.target.animId,
        }
    }

    public destroy() {
        this.cameraReady = false
        this.removeSpectatorCameraControls()
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
