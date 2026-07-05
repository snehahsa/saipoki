import * as PIXI from 'pixi.js'
import playerSpriteSheetData from '@/utils/pixi/Player/PlayerSpriteSheetData'
import { Point, Coordinate, AnimationState, Direction } from '@/utils/pixi/types'
import { PlayApp } from '@/utils/pixi/PlayApp'
import { bfs } from '@/utils/pixi/pathfinding'
import { server } from '@/utils/backend/server'
import { defaultSkin, skins } from '@/utils/pixi/Player/skins'
import signal from '@/utils/signal'
import { directionToward, shouldTurnToFace } from './npcNotice'
import { getGearAttachForFacing, getGearItem, isGearVisibleForFacing, loadGearCatalog, loadGearTexture } from './gearCatalog'
import { gearTexturePixelSize, placeGearToolOnCharacter, resolveGearAttachRect } from './gearOverlay'
import {
    LABEL_SCALE_LEVEL,
    LABEL_SCALE_NAME,
    LEVEL_LABEL_Y,
    NAME_LABEL_Y,
    truncateDisplayName,
} from './playerLabels'

function formatText(message: string, maxLength: number): string {
    message = message.trim()
    const words = message.split(' ')
    const lines: string[] = []
    let currentLine = ''

    for (const word of words) {
        if (word.length > maxLength) {
            if (currentLine) {
                lines.push(currentLine.trim())
                currentLine = ''
            }
            for (let i = 0; i < word.length; i += maxLength) {
                lines.push(word.substring(i, i + maxLength))
            }
        } else if (currentLine.length + word.length + 1 > maxLength) {
            lines.push(currentLine.trim())
            currentLine = word + ' '
        } else {
            currentLine += word + ' '
        }
    }

    if (currentLine.trim()) {
        lines.push(currentLine.trim())
    }

    return lines.join('\n')
}

export class Player {
    public skin: string = defaultSkin
    public username: string = ''
    public level: number = 1
    public playerId: string = ''
    private levelLabel: PIXI.Text | null = null
    private nameLabel: PIXI.Text | null = null
    public parent: PIXI.Container = new PIXI.Container()
    private textMessage: PIXI.Text = new PIXI.Text({})
    private textTimeout: ReturnType<typeof setTimeout> | null = null
    private animationState: AnimationState = 'idle_down'
    private direction: Direction = 'down'
    private animationSpeed: number = 0.1
    private movementSpeed: number = 3.5
    public currentTilePosition: Point = { x: 0, y: 0 }
    private isLocal: boolean = false
    private playApp: PlayApp
    private targetPosition: { x: number; y: number } | null = null
    private path: Coordinate[] = []
    private pathIndex: number = 0
    private sheet: any = null
    private animatedSprite: PIXI.AnimatedSprite | null = null
    private movementMode: 'keyboard' | 'mouse' = 'mouse'
    public frozen: boolean = false
    private initialized: boolean = false
    private strikes: number = 0
    private currentPrivateArea: string | null = null
    private toolSprite: PIXI.Sprite | null = null
    private equippedGearId: string | null = null

    constructor(
        skin: string,
        playApp: PlayApp,
        username: string,
        isLocal: boolean = false,
        level: number = 1,
        playerId: string = '',
    ) {
        this.skin = skin
        this.playApp = playApp
        this.username = username
        this.level = Math.max(1, Number(level) || 1)
        this.playerId = playerId || username
        this.isLocal = isLocal
    }

    private async loadAnimations() {
        const src = `/sprites/characters/Character_${this.skin}.png`
        await PIXI.Assets.load(src)

        const spriteSheetData = JSON.parse(JSON.stringify(playerSpriteSheetData))
        spriteSheetData.meta.image = src

        this.sheet = new PIXI.Spritesheet(PIXI.Texture.from(src), spriteSheetData)
        await this.sheet.parse()

        if (!this.animatedSprite) {
            this.animatedSprite = new PIXI.AnimatedSprite(this.sheet.animations['idle_down'])
            this.animatedSprite.anchor.set(0.5, 1)
            this.animatedSprite.animationSpeed = this.animationSpeed
            this.animatedSprite.play()
            if (!this.initialized) {
                this.parent.addChild(this.animatedSprite)
            }
            return
        }

        const state = this.sheet.animations[this.animationState]
            ? this.animationState
            : 'idle_down'
        this.animatedSprite.textures = this.sheet.animations[state]
        this.animatedSprite.play()
    }

    public changeSkin = async (skin: string) => {
        if (!skins.includes(skin)) return

        this.skin = skin
        await this.loadAnimations()
        this.changeAnimationState(this.animationState, true)
    }

    private addUsername() {
        const lvl = Math.max(1, Number(this.level) || 1)
        const levelText = new PIXI.Text({
            text: `Lv.${lvl}`,
            style: {
                fontFamily: 'silkscreen',
                fontSize: 128,
                fill: 0xffffff,
            },
        })
        levelText.anchor.set(0.5)
        levelText.scale.set(LABEL_SCALE_LEVEL)
        levelText.y = LEVEL_LABEL_Y

        const nameText = new PIXI.Text({
            text: truncateDisplayName(this.username),
            style: {
                fontFamily: 'silkscreen',
                fontSize: 128,
                fill: 0xffffff,
            },
        })
        nameText.anchor.set(0.5)
        nameText.scale.set(LABEL_SCALE_NAME)
        nameText.y = NAME_LABEL_Y

        this.levelLabel = levelText
        this.nameLabel = nameText
        this.parent.addChild(levelText)
        this.parent.addChild(nameText)
    }

    public setLevel(level: number) {
        this.level = Math.max(1, Number(level) || 1)
        if (this.levelLabel) {
            this.levelLabel.text = `Lv.${this.level}`
        }
    }

    public setUsername(username: string) {
        this.username = username
        if (this.nameLabel) {
            this.nameLabel.text = truncateDisplayName(username)
        }
    }

    public setMessage(message: string) {
        if (this.textTimeout) {
            clearTimeout(this.textTimeout)
        }

        if (this.textMessage) {
            this.parent.removeChild(this.textMessage)
        }

        message = formatText(message, 40)

        const text = new PIXI.Text({
            text: message,
            style: {
                fontFamily: 'silkscreen',
                fontSize: 128,
                fill: 0xffffff,
                align: 'center',
            },
        })
        text.anchor.x = 0.5
        text.anchor.y = 0
        text.scale.set(0.07)
        text.y = -text.height - 42
        this.parent.addChild(text)
        this.textMessage = text

        signal.emit('newMessage', {
            content: message,
            username: this.username,
        })

        this.textTimeout = setTimeout(() => {
            if (this.textMessage) {
                this.parent.removeChild(this.textMessage)
            }
        }, 10000)
    }

    public async init() {
        if (this.initialized) return
        await this.loadAnimations()
        this.addUsername()
        this.initialized = true
        if (this.equippedGearId) {
            await this.updateGearOverlay()
        }
    }

    /** Set tile position before the sprite is on stage (no camera/interaction side effects). */
    public presetTilePosition(x: number, y: number) {
        const pos = this.convertTilePosToPlayerPos(x, y)
        this.parent.x = pos.x
        this.parent.y = pos.y
        this.currentTilePosition = { x, y }
    }

    public setPosition(x: number, y: number) {
        const pos = this.convertTilePosToPlayerPos(x, y)
        this.parent.x = pos.x
        this.parent.y = pos.y
        this.currentTilePosition = { x, y }
        this.emitLocalPositionDebug()
    }

    public getDirection(): Direction {
        return this.direction
    }

    public faceToward(target: Point) {
        const toward = directionToward(this.currentTilePosition, target)
        if (!toward) return
        this.direction = toward
        this.changeAnimationState(`idle_${this.direction}` as AnimationState)
    }

    public haltForNpcEncounter(npcPos: Point) {
        PIXI.Ticker.shared.remove(this.move)
        this.targetPosition = null
        this.path = []
        this.pathIndex = 0
        this.playApp.clearPadInput()

        if (shouldTurnToFace(this.direction, this.currentTilePosition, npcPos)) {
            this.faceToward(npcPos)
        } else {
            this.changeAnimationState(`idle_${this.direction}` as AnimationState)
        }
    }

    private emitLocalPositionDebug = () => {
        if (!this.isLocal) return

        const { x, y } = this.currentTilePosition
        signal.emit('playerPosition', {
            x,
            y,
            room: this.playApp.currentRoomIndex,
        })
        this.playApp.checkNearbyInteractions(this.currentTilePosition)
        this.playApp.checkNpcNotices(this.currentTilePosition)
    }

    private convertTilePosToPlayerPos = (x: number, y: number) => ({
        x: x * 32 + 16,
        y: y * 32 + 24,
    })

    private convertPlayerPosToTilePos = (x: number, y: number) => ({
        x: Math.floor(x / 32),
        y: Math.floor(y / 32),
    })

    public moveToTile = (x: number, y: number) => {
        if (this.strikes > 25) return

        const start: Coordinate = [this.currentTilePosition.x, this.currentTilePosition.y]
        const end: Coordinate = [x, y]
        const path: Coordinate[] | null = bfs(start, end, this.playApp.blocked)

        if (!path || path.length === 0) {
            if (!path && !this.isLocal) {
                this.strikes++
            }
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

        if (this.isLocal) {
            server.socket.emit('movePlayer', { x, y })
        }
    }

    private move = ({ deltaTime }: { deltaTime: number }) => {
        if (!this.targetPosition) return

        const currentPos = this.convertPlayerPosToTilePos(this.parent.x, this.parent.y)
        this.updatePrivateAreaVisuals(currentPos)

        this.currentTilePosition = {
            x: this.path[this.pathIndex][0],
            y: this.path[this.pathIndex][1],
        }

        if (
            this.isLocal &&
            this.playApp.hasTeleport(this.currentTilePosition.x, this.currentTilePosition.y) &&
            this.movementMode === 'keyboard'
        ) {
            this.setFrozen(true)
        }

        const speed = this.movementSpeed * deltaTime
        const dx = this.targetPosition.x - this.parent.x
        const dy = this.targetPosition.y - this.parent.y
        const distance = Math.sqrt(dx * dx + dy * dy)

        if (distance < speed) {
            this.parent.x = this.targetPosition.x
            this.parent.y = this.targetPosition.y
            this.pathIndex++

        if (this.isLocal) {
            this.emitLocalPositionDebug()
        }

            if (this.pathIndex < this.path.length) {
                this.targetPosition = this.convertTilePosToPlayerPos(
                    this.path[this.pathIndex][0],
                    this.path[this.pathIndex][1]
                )
            } else {
                const movementInput = this.getMovementInput()
                const newTilePosition = {
                    x: this.currentTilePosition.x + movementInput.x,
                    y: this.currentTilePosition.y + movementInput.y,
                }

                const teleported = this.teleportIfOnTeleporter(this.movementMode)
                if (teleported) {
                    this.stop()
                    return
                }

                if (
                    (movementInput.x !== 0 || movementInput.y !== 0) &&
                    !this.playApp.blocked.has(`${newTilePosition.x}, ${newTilePosition.y}`)
                ) {
                    this.moveToTile(newTilePosition.x, newTilePosition.y)
                } else {
                    this.stop()
                    this.teleportIfOnTeleporter('mouse')
                }
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

            if (this.isLocal) {
                this.playApp.checkNpcNotices(this.currentTilePosition)
            }
        }

        this.playApp.sortObjectsByY()

        if (this.isLocal) {
            this.playApp.moveCameraToPlayer()
        }
    }

    public checkIfShouldJoinChannel = (newTilePosition: Point) => {
        this.updatePrivateAreaVisuals(newTilePosition)
    }

    private updatePrivateAreaVisuals = (_newTilePosition: Point) => {
        if (!this.isLocal) return
    }

    private stop = () => {
        PIXI.Ticker.shared.remove(this.move)
        this.targetPosition = null
        this.path = []
        this.pathIndex = 0

        if (this.isLocal) {
            this.emitLocalPositionDebug()
            this.changeAnimationState(`idle_${this.direction}` as AnimationState)
        } else {
            setTimeout(() => {
                if (!this.targetPosition) {
                    this.changeAnimationState(`idle_${this.direction}` as AnimationState)
                }
            }, 100)
        }
    }

    private teleportIfOnTeleporter = (movementMode: 'keyboard' | 'mouse') => {
        if (this.isLocal && this.movementMode === movementMode) {
            return this.playApp.teleportIfOnTeleportSquare(
                this.currentTilePosition.x,
                this.currentTilePosition.y
            )
        }
        return false
    }

    public changeAnimationState = (state: AnimationState, force: boolean = false) => {
        if (this.animationState === state && !force) return
        if (!this.animatedSprite || !this.sheet?.animations[state]) return

        this.animationState = state
        this.animatedSprite.textures = this.sheet.animations[state]
        this.animatedSprite.play()

        if (state.includes('left')) this.direction = 'left'
        else if (state.includes('right')) this.direction = 'right'
        else if (state.includes('up')) this.direction = 'up'
        else if (state.includes('down')) this.direction = 'down'

        void this.updateGearOverlay()
    }

    public async setEquippedGear(gearId: string | null) {
        this.equippedGearId = gearId
        if (gearId) {
            await loadGearCatalog(true)
        }
        await this.updateGearOverlay()
    }

    private ensureToolSpriteOnStage() {
        if (!this.toolSprite || !this.animatedSprite) return
        if (this.toolSprite.parent === this.parent) return
        const bodyIndex = this.parent.getChildIndex(this.animatedSprite)
        this.parent.addChildAt(this.toolSprite, bodyIndex + 1)
    }

    private async updateGearOverlay() {
        if (!this.animatedSprite) return

        const item = getGearItem(this.equippedGearId)
        if (!item) {
            if (this.toolSprite) this.toolSprite.visible = false
            return
        }

        if (!isGearVisibleForFacing(item, this.direction)) {
            if (this.toolSprite) this.toolSprite.visible = false
            return
        }

        const spriteMeta = getGearAttachForFacing(item, this.direction)
        if (!spriteMeta) {
            if (this.toolSprite) this.toolSprite.visible = false
            return
        }

        const texture = await loadGearTexture(item.id)
        if (!texture) {
            if (this.toolSprite) this.toolSprite.visible = false
            return
        }

        if (!this.toolSprite) {
            this.toolSprite = new PIXI.Sprite(texture)
        } else {
            this.toolSprite.texture = texture
        }

        // Feet anchor — map-builder idle frame uses top-left (0,0) = (-24,-48) from feet.
        this.animatedSprite.anchor.set(0.5, 1)

        this.ensureToolSpriteOnStage()

        const texSize = gearTexturePixelSize(texture)
        const legacyFrame = {
            w: spriteMeta.w ?? texSize.w,
            h: spriteMeta.h ?? texSize.h,
        }
        const rect = resolveGearAttachRect(this.direction, spriteMeta, legacyFrame)
        placeGearToolOnCharacter(
            this.toolSprite,
            this.animatedSprite,
            texSize.w,
            texSize.h,
            rect
        )
        this.toolSprite.visible = true
    }

    public keydown = (event: KeyboardEvent) => {
        if (this.frozen) return

        this.setMovementMode('keyboard')
        const movementInput = { x: 0, y: 0 }
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

        if (key === 'ArrowUp' || key === 'w') movementInput.y -= 1
        else if (key === 'ArrowDown' || key === 's') movementInput.y += 1
        else if (key === 'ArrowLeft' || key === 'a') movementInput.x -= 1
        else if (key === 'ArrowRight' || key === 'd') movementInput.x += 1
        else return

        this.moveToTile(
            this.currentTilePosition.x + movementInput.x,
            this.currentTilePosition.y + movementInput.y
        )
    }

    public setMovementMode = (mode: 'keyboard' | 'mouse') => {
        this.movementMode = mode
    }

    private getMovementInput = () => {
        const padInput = this.playApp.getPadInput()
        if (padInput.x !== 0 || padInput.y !== 0) {
            return padInput
        }

        const movementInput = { x: 0, y: 0 }
        const latestKey = this.playApp.keysDown[this.playApp.keysDown.length - 1]

        if (latestKey === 'ArrowUp' || latestKey === 'w') movementInput.y -= 1
        else if (latestKey === 'ArrowDown' || latestKey === 's') movementInput.y += 1
        else if (latestKey === 'ArrowLeft' || latestKey === 'a') movementInput.x -= 1
        else if (latestKey === 'ArrowRight' || latestKey === 'd') movementInput.x += 1

        return movementInput
    }

    public isMoving = () => this.targetPosition !== null

    public setFrozen = (frozen: boolean) => {
        this.frozen = frozen
    }

    public destroy() {
        PIXI.Ticker.shared.remove(this.move)
    }
}
