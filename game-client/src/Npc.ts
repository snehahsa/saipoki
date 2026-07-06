import * as PIXI from 'pixi.js'
import { Point, Coordinate, AnimationState, Direction } from '@/utils/pixi/types'
import { PlayApp } from '@/utils/pixi/PlayApp'
import { bfs } from '@/utils/pixi/pathfinding'
import { resolveNpcSpriteSpec } from './spriteSheets'
import { directionToward, shouldNpcNoticePlayer, MIN_NPC_SIGHT_DISTANCE, MAX_NPC_SIGHT_DISTANCE, NPC_REINTERACT_COOLDOWN_MS } from './npcNotice'
import { NpcFlow, NpcOnComplete, resolveNpcMessages, messageSetId } from './flows'
import {
    ALERT_BUBBLE_Y,
    LABEL_SCALE_LEVEL,
    LABEL_SCALE_NAME,
    LEVEL_LABEL_Y,
    NAME_LABEL_Y,
    entityLabelTextStyle,
    formatLevelLabel,
    npcNameLabelTextStyle,
    truncateDisplayName,
} from './playerLabels'

export type NpcConfig = {
    id: string
    name: string
    skin: string
    path: Point[]
    loop?: boolean
    waitMs?: number
    noticeRadius?: number
    messages?: string[]
    flows?: NpcFlow[]
    onComplete?: NpcOnComplete
}

export const NPC_PATROL_RESUME_DELAY_MS = 2000

export class Npc {
    public parent: PIXI.Container = new PIXI.Container()
    private labelRoot: PIXI.Container = new PIXI.Container()
    private levelLabel: PIXI.Text | null = null
    private nameLabel: PIXI.Text | null = null
    private config: NpcConfig
    private playApp: PlayApp
    private sheet: any = null
    private animationState: AnimationState = 'idle_down'
    private direction: Direction = 'down'
    private animationSpeed = 0.1
    private movementSpeed = 2.6
    public currentTilePosition: Point = { x: 0, y: 0 }
    private path: Coordinate[] = []
    private pathIndex = 0
    private targetPosition: { x: number; y: number } | null = null
    private waypointIndex = 0
    private waitTimer: ReturnType<typeof setTimeout> | null = null
    private resumeAfterEncounterTimer: ReturnType<typeof setTimeout> | null = null
    private destroyed = false
    private alertBubble: PIXI.Container | null = null
    private alertBounce = 0
    private alertActive = false
    private pausedForNotice = false
    private messageIndex = 0
    private dialogueActive = false
    private interactionCooldownUntil = 0
    private dialogueMessages: string[] = []
    private activeFlow: NpcFlow | null = null
    private usingDefaultMessages = false
    private animatedSprite: PIXI.AnimatedSprite | null = null

    constructor(config: NpcConfig, playApp: PlayApp) {
        this.config = config
        this.playApp = playApp
    }

    public get id() {
        return this.config.id
    }

    public get name() {
        return this.config.name
    }

    public getDirection(): Direction {
        return this.direction
    }

    public isAlertActive() {
        return this.alertActive
    }

    public isDialogueActive() {
        return this.dialogueActive
    }

    public isHeldForEncounter() {
        return this.dialogueActive || this.pausedForNotice || this.alertActive
    }

    private resolveDialogueMessages() {
        const holds = this.playApp.getPlayerHolds()
        const gear = this.playApp.getPlayerGear()
        const resolved = resolveNpcMessages(
            this.config.messages,
            this.config.flows,
            holds,
            this.playApp.getHoldGrantRules(),
            gear
        )
        this.dialogueMessages = resolved.messages
        this.activeFlow = resolved.flow
        this.usingDefaultMessages = !resolved.flow
    }

    public getMessages(): string[] {
        if (this.dialogueMessages.length) {
            return this.dialogueMessages
        }
        return (this.config.messages || []).filter(Boolean)
    }

    public getMessageSetId(): string {
        return messageSetId(this.id, this.getMessages())
    }

    public getActiveFlow(): NpcFlow | null {
        return this.activeFlow
    }

    public isUsingDefaultMessages(): boolean {
        return this.usingDefaultMessages
    }

    public getOnComplete(): NpcOnComplete | undefined {
        return this.config.onComplete
    }

    private async loadAnimations() {
        const spec = await resolveNpcSpriteSpec(this.config.skin)
        await PIXI.Assets.load(spec.src)

        this.sheet = new PIXI.Spritesheet(PIXI.Texture.from(spec.src), spec.sheetData)
        await this.sheet.parse()

        this.animatedSprite = new PIXI.AnimatedSprite(this.sheet.animations['idle_down'])
        this.animatedSprite.animationSpeed = this.animationSpeed
        if (spec.displayScale !== 1) {
            this.animatedSprite.scale.set(spec.displayScale)
        }
        this.animatedSprite.play()
        this.parent.addChild(this.animatedSprite)
    }

    private addEntityLabels() {
        const displayName = truncateDisplayName(
            String(this.config.name || this.config.id || 'NPC').trim() || 'NPC',
        )
        const levelText = new PIXI.Text({
            text: formatLevelLabel(1),
            style: entityLabelTextStyle(0xffffff),
        })
        levelText.anchor.set(0.5)
        levelText.scale.set(LABEL_SCALE_LEVEL)
        levelText.y = LEVEL_LABEL_Y

        const nameText = new PIXI.Text({
            text: displayName,
            style: npcNameLabelTextStyle(),
        })
        nameText.anchor.set(0.5)
        nameText.scale.set(LABEL_SCALE_NAME)
        nameText.y = NAME_LABEL_Y

        this.levelLabel = levelText
        this.nameLabel = nameText
        this.labelRoot.addChild(levelText)
        this.labelRoot.addChild(nameText)
        this.labelRoot.sortableChildren = true
        levelText.zIndex = 1
        nameText.zIndex = 2
        this.labelRoot.visible = true
    }

    private syncLabelPosition() {
        this.labelRoot.position.set(this.parent.x, this.parent.y)
    }

    private attachLabelsToOverlayLayer() {
        if (this.labelRoot.parent) return
        this.playApp.attachEntityLabels(this.labelRoot)
        this.syncLabelPosition()
    }

    private detachLabelsFromOverlayLayer() {
        if (!this.labelRoot.parent) return
        this.playApp.detachEntityLabels(this.labelRoot)
    }

    private createAlertBubble() {
        const bubble = new PIXI.Container()
        bubble.y = ALERT_BUBBLE_Y
        bubble.zIndex = 10
        bubble.visible = false

        const fill = new PIXI.Graphics()
        fill.roundRect(-10, -22, 20, 18, 2)
        fill.fill(0xffffff)
        fill.moveTo(-5, -3)
        fill.lineTo(0, 2)
        fill.lineTo(5, -3)
        fill.lineTo(5, -5)
        fill.lineTo(-5, -5)
        fill.closePath()
        fill.fill(0xffffff)

        const border = new PIXI.Graphics()
        border.moveTo(-5, -3)
        border.lineTo(0, 2)
        border.lineTo(5, -3)
        border.lineTo(8, -3)
        border.lineTo(8, -20)
        border.lineTo(-8, -20)
        border.lineTo(-8, -3)
        border.lineTo(-5, -3)
        border.stroke({ width: 2, color: 0x303030, join: 'round', cap: 'round' })

        const mark = new PIXI.Text({
            text: '!',
            style: {
                fontFamily: 'silkscreen',
                fontSize: 128,
                fill: 0xe83838,
                fontWeight: 'bold',
            },
        })
        mark.anchor.set(0.5)
        mark.scale.set(0.11)
        mark.y = -13

        bubble.addChild(fill, border, mark)
        this.labelRoot.addChild(bubble)
        this.alertBubble = bubble
        PIXI.Ticker.shared.add(this.animateAlertBubble)
    }

    private animateAlertBubble = ({ deltaTime }: { deltaTime: number }) => {
        if (!this.alertBubble?.visible) return
        this.alertBounce += deltaTime * 0.18
        this.alertBubble.y = ALERT_BUBBLE_Y + Math.sin(this.alertBounce) * 2
    }

    private showAlertBubble() {
        if (this.alertBubble) {
            this.alertBubble.visible = true
            this.alertBounce = 0
        }
    }

    private hideAlertBubble() {
        if (this.alertBubble) {
            this.alertBubble.visible = false
        }
    }

    public async init() {
        await this.loadAnimations()
        this.addEntityLabels()
        this.attachLabelsToOverlayLayer()

        this.createAlertBubble()

        const start = this.config.path[0]
        if (start) {
            this.setPosition(start.x, start.y)
            this.waypointIndex = this.config.path.length > 1 ? 1 : 0
            this.syncPatrolFacing()
            this.scheduleNextMove(300)
        }
    }

    private setPosition(x: number, y: number) {
        const pos = this.convertTilePosToPlayerPos(x, y)
        this.parent.x = pos.x
        this.parent.y = pos.y
        this.currentTilePosition = { x, y }
        this.syncLabelPosition()
    }

    private convertTilePosToPlayerPos = (x: number, y: number) => ({
        x: x * 32 + 16,
        y: y * 32 + 24,
    })

    private pauseForNotice() {
        if (this.pausedForNotice) return
        this.pausedForNotice = true
        if (this.waitTimer) clearTimeout(this.waitTimer)
        if (this.resumeAfterEncounterTimer) {
            clearTimeout(this.resumeAfterEncounterTimer)
            this.resumeAfterEncounterTimer = null
        }
        this.stopMoving()
    }

    private clearDialogueState() {
        this.dialogueMessages = []
        this.activeFlow = null
        this.usingDefaultMessages = false
        this.messageIndex = 0
    }

    private resumePatrolMovement() {
        this.pausedForNotice = false
        this.alertActive = false
        this.messageIndex = 0
        this.hideAlertBubble()
        this.syncPatrolFacing()
        this.scheduleNextMove(this.config.waitMs ?? 800)
    }

    private resumePatrol() {
        if (!this.pausedForNotice && !this.alertActive) return
        this.pausedForNotice = false
        this.alertActive = false
        this.dialogueActive = false
        this.clearDialogueState()
        this.hideAlertBubble()
        this.playApp.endNpcEncounter()
        this.scheduleNextMove(this.config.waitMs ?? 800)
    }

    private getSightDistance() {
        return Math.min(
            Math.max(this.config.noticeRadius ?? MAX_NPC_SIGHT_DISTANCE, MIN_NPC_SIGHT_DISTANCE),
            MAX_NPC_SIGHT_DISTANCE
        )
    }

    private isInteractionCooldownActive() {
        return Date.now() < this.interactionCooldownUntil
    }

    private startInteractionCooldown() {
        this.interactionCooldownUntil = Date.now() + NPC_REINTERACT_COOLDOWN_MS
    }

    /** Resume path after an encounter; default waits 2s so the NPC doesn't snap away. */
    public resumePatrolAfterEncounter(delayMs = NPC_PATROL_RESUME_DELAY_MS) {
        if (this.resumeAfterEncounterTimer) {
            clearTimeout(this.resumeAfterEncounterTimer)
            this.resumeAfterEncounterTimer = null
        }

        const wasHeld = this.isHeldForEncounter()

        this.dialogueActive = false
        if (!wasHeld) return

        this.startInteractionCooldown()
        this.alertActive = false
        this.clearDialogueState()
        this.hideAlertBubble()

        if (delayMs <= 0) {
            this.resumePatrolMovement()
            return
        }

        this.pausedForNotice = true
        this.stopMoving()
        this.resumeAfterEncounterTimer = setTimeout(() => {
            this.resumeAfterEncounterTimer = null
            this.resumePatrolMovement()
        }, delayMs)
    }

    public onDialogueClosed() {
        this.resumePatrolAfterEncounter()
    }

    /** @deprecated Use resumePatrolAfterEncounter */
    public resumePatrolIfPaused() {
        this.resumePatrolAfterEncounter()
    }

    private facePosition(target: Point) {
        const toward = directionToward(this.currentTilePosition, target)
        if (!toward) return
        this.direction = toward
        this.changeAnimationState(`idle_${this.direction}` as AnimationState)
    }

    private getNextWaypoint(): Point | null {
        return this.config.path[this.waypointIndex] ?? null
    }

    /** Face the next patrol target so idle sight matches where the NPC is looking. */
    private syncPatrolFacing() {
        if (this.pausedForNotice || this.targetPosition) return

        const next = this.getNextWaypoint()
        if (!next) return

        const toward = directionToward(this.currentTilePosition, next)
        if (!toward || toward === this.direction) return

        this.direction = toward
        this.changeAnimationState(`idle_${this.direction}` as AnimationState)
        this.playApp.checkNpcNotices(this.playApp.player.currentTilePosition)
    }

    public checkPlayerNotice(playerPos: Point, playerWorld: Point): boolean {
        const sightDistance = this.getSightDistance()
        const npcWorld = { x: this.parent.x, y: this.parent.y }
        const noticed = shouldNpcNoticePlayer(
            this.currentTilePosition,
            this.direction,
            playerPos,
            sightDistance,
            npcWorld,
            playerWorld
        )

        if (!noticed) {
            if (this.alertActive && !this.dialogueActive) {
                this.resumePatrol()
            }
            return false
        }

        if (this.isInteractionCooldownActive()) {
            return false
        }

        if (!this.alertActive) {
            this.alertActive = true
            this.messageIndex = 0
            this.resolveDialogueMessages()
            this.pauseForNotice()
            this.facePosition(playerPos)
            this.showAlertBubble()
            const messages = this.getMessages()
            if (messages.length) {
                this.playApp.beginNpcEncounter(this)
                this.dialogueActive = true
                this.playApp.showNpcMessage(this, messages[0], 0, messages.length)
            }
        }

        return true
    }

    public advanceDialogue(): boolean {
        const messages = this.getMessages()
        if (!this.dialogueActive || !messages.length) return false

        const nextIndex = this.messageIndex + 1
        if (nextIndex >= messages.length) {
            return false
        }

        this.messageIndex = nextIndex
        this.playApp.showNpcMessage(this, messages[this.messageIndex], this.messageIndex, messages.length)
        return true
    }

    public cancelDialogue() {
        this.dialogueActive = false
    }

    private scheduleNextMove(delayMs: number) {
        if (this.destroyed || this.pausedForNotice) return
        if (this.waitTimer) clearTimeout(this.waitTimer)
        this.waitTimer = setTimeout(() => this.advanceToNextWaypoint(), delayMs)
    }

    private advanceToNextWaypoint() {
        if (this.destroyed || this.pausedForNotice || this.config.path.length < 2) return

        const target = this.config.path[this.waypointIndex]
        if (!target) return

        this.moveToTile(target.x, target.y)
    }

    private onArrivedAtWaypoint() {
        if (this.pausedForNotice) return

        const pathLen = this.config.path.length
        if (pathLen < 2) return

        this.waypointIndex += 1
        if (this.waypointIndex >= pathLen) {
            if (this.config.loop === false) {
                this.waypointIndex = pathLen - 1
                this.changeAnimationState(`idle_${this.direction}` as AnimationState)
                return
            }
            this.waypointIndex = 0
        }

        this.syncPatrolFacing()
        this.scheduleNextMove(this.config.waitMs ?? 800)
    }

    private moveToTile = (x: number, y: number) => {
        if (this.pausedForNotice) return

        const start: Coordinate = [this.currentTilePosition.x, this.currentTilePosition.y]
        const end: Coordinate = [x, y]
        const path: Coordinate[] | null = bfs(start, end, this.playApp.blocked)

        if (!path || path.length === 0) {
            this.scheduleNextMove(this.config.waitMs ?? 800)
            return
        }

        PIXI.Ticker.shared.remove(this.move)
        this.path = path
        this.pathIndex = 0
        this.targetPosition = this.convertTilePosToPlayerPos(
            this.path[this.pathIndex][0],
            this.path[this.pathIndex][1]
        )
        PIXI.Ticker.shared.add(this.move)
    }

    private move = ({ deltaTime }: { deltaTime: number }) => {
        if (!this.targetPosition || this.pausedForNotice) return

        this.currentTilePosition = {
            x: this.path[this.pathIndex][0],
            y: this.path[this.pathIndex][1],
        }

        const speed = this.movementSpeed * deltaTime
        const dx = this.targetPosition.x - this.parent.x
        const dy = this.targetPosition.y - this.parent.y
        const distance = Math.sqrt(dx * dx + dy * dy)

        if (distance < speed) {
            this.parent.x = this.targetPosition.x
            this.parent.y = this.targetPosition.y
            this.pathIndex++

            if (this.pathIndex < this.path.length) {
                this.targetPosition = this.convertTilePosToPlayerPos(
                    this.path[this.pathIndex][0],
                    this.path[this.pathIndex][1]
                )
            } else {
                this.stopMoving()
                this.onArrivedAtWaypoint()
            }
        } else {
            const angle = Math.atan2(dy, dx)
            this.parent.x += Math.cos(angle) * speed
            this.parent.y += Math.sin(angle) * speed

            if (Math.abs(dx) > Math.abs(dy)) {
                this.direction = dx > 0 ? 'right' : 'left'
            } else {
                this.direction = dy > 0 ? 'down' : 'up'
            }

            this.changeAnimationState(`walk_${this.direction}` as AnimationState)
        }

        this.playApp.sortObjectsByY()
        this.syncLabelPosition()
    }

    private stopMoving() {
        PIXI.Ticker.shared.remove(this.move)
        this.targetPosition = null
        this.path = []
        this.pathIndex = 0
        this.changeAnimationState(`idle_${this.direction}` as AnimationState)
    }

    private changeAnimationState = (state: AnimationState) => {
        if (this.animationState === state) return
        this.animationState = state
        if (this.animatedSprite && this.sheet?.animations[state]) {
            this.animatedSprite.textures = this.sheet.animations[state]
            this.animatedSprite.play()
        }
    }

    public destroy() {
        this.destroyed = true
        if (this.waitTimer) clearTimeout(this.waitTimer)
        if (this.resumeAfterEncounterTimer) clearTimeout(this.resumeAfterEncounterTimer)
        PIXI.Ticker.shared.remove(this.move)
        PIXI.Ticker.shared.remove(this.animateAlertBubble)
        this.detachLabelsFromOverlayLayer()
        this.labelRoot.destroy({ children: true })
        this.levelLabel = null
        this.nameLabel = null
        this.parent.destroy({ children: true })
    }
}
