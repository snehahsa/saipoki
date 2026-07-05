import { PlayApp } from '@/utils/pixi/PlayApp'
import { loadAnimalCatalog } from './spriteSheets'
import { loadGearCatalog } from './gearCatalog'
import { preloadRealmTileAssets } from '@/utils/pixi/realmPreload'
import { RealmData, Room } from '@/utils/pixi/types'
import { server } from '@/utils/backend/server'
import signal from '@/utils/signal'

export type GameSession = {
    uid: string
    username: string
    skin: string
    level?: number
    backendUrl: string
    socketUrl?: string
    holds?: string[]
    holdGrantRules?: Record<string, { holds?: string[]; notHolds?: string[] }>
    onProgress?: (message: string) => void
    spectator?: boolean
}

let activeApp: PlayApp | null = null
let pendingEquippedGear: string | null = null

function normalizeRealmData(data: RealmData): RealmData {
    const DEFAULT_ROOM_NAME = 'Pokequest-cards'
    const defaultRoomName = (index: number) => (index === 0 ? DEFAULT_ROOM_NAME : `Map ${index + 1}`)

    return {
        ...data,
        rooms: data.rooms.map((room: Room, index: number) => ({
            ...room,
            id: room.id?.trim() || `map-${index}`,
            name: room.name?.trim() || defaultRoomName(index),
        })),
    }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
    const text = await response.text()
    try {
        return JSON.parse(text) as T
    } catch {
        throw new SyntaxError(`Invalid JSON from ${response.url}`)
    }
}

async function waitForPaintReady(app: PlayApp) {
    const pixiApp = app.getApp()
    pixiApp.renderer.render(pixiApp.stage)
    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
}

async function loadWorldMap(backendUrl: string): Promise<RealmData> {
    const response = await fetch(`${backendUrl}/api/world?t=${Date.now()}`, {
        cache: 'no-store',
    })

    if (!response.ok) {
        throw new Error('Failed to load world map')
    }

    const data = await parseJsonResponse<RealmData>(response)
    return normalizeRealmData(data)
}

export async function startGame(session: GameSession): Promise<{ success: boolean; error?: string }> {
    if (activeApp) {
        activeApp.destroy()
        activeApp = null
    }

    const container = document.getElementById('app-container')
    if (!container) {
        return { success: false, error: 'Game container not found' }
    }

    container.innerHTML = ''

    server.configure(session.backendUrl, session.uid, session.socketUrl || '')

    let realmData: RealmData
    try {
        session.onProgress?.('Loading map')
        realmData = await loadWorldMap(session.backendUrl)
    } catch {
        return { success: false, error: 'Could not load world map. Refresh and try again.' }
    }

    const app = new PlayApp(
        session.uid,
        'telegram-world',
        realmData,
        session.username,
        session.skin,
        session.holds || [],
        session.holdGrantRules || {},
        Number(session.level) || 1,
    )

    activeApp = app

    session.onProgress?.('Joining room')
    const { success, errorMessage } = await server.connect(
        session.username,
        session.skin,
        Number(session.level) || 1,
    )
    if (!success) {
        activeApp.destroy()
        activeApp = null
        return { success: false, error: errorMessage }
    }

    if (session.spectator) {
        app.setEnterAsSpectator(true)
    }

    try {
        session.onProgress?.('Loading sprites')
        await loadAnimalCatalog()
        await loadGearCatalog()
        await preloadRealmTileAssets(realmData, session.onProgress)
        session.onProgress?.('Building world')
        await app.init()
        if (pendingEquippedGear) {
            await app.setEquippedGear(pendingEquippedGear)
        }
        await waitForPaintReady(app)
    } catch (error) {
        console.error('Failed to initialize game world:', error)
        activeApp.destroy()
        activeApp = null
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to load world.',
        }
    }

    return { success: true }
}

export function stopGame() {
    if (activeApp) {
        activeApp.destroy()
        activeApp = null
    }

    const container = document.getElementById('app-container')
    if (container) {
        container.innerHTML = ''
    }
}

export function switchGameSkin(skin: string) {
    signal.emit('switchSkin', skin)
}

export function onGameEvent(event: string, callback: (data?: unknown) => void) {
    signal.on(event, callback)
}

export function offGameEvent(event: string, callback: (data?: unknown) => void) {
    signal.off(event, callback)
}

export function onPlayerPosition(
    callback: (data: { x: number; y: number; room: number }) => void
) {
    signal.on('playerPosition', callback)
}

export function offPlayerPosition(
    callback: (data: { x: number; y: number; room: number }) => void
) {
    signal.off('playerPosition', callback)
}

export function setPadDirection(direction: 'up' | 'down' | 'left' | 'right', active: boolean) {
    activeApp?.setPadDirection(direction, active)
}

export function clearPadInput() {
    activeApp?.clearPadInput()
}

export function finishNpcDialogue(options?: { patrolDelayMs?: number }): boolean {
    return activeApp?.finishNpcDialogue(options) ?? false
}

export function onSignModalClosed(): void {
    activeApp?.onSignModalClosed()
}

export function advanceNpcDialogue(): boolean {
    return activeApp?.advanceNpcDialogue() ?? false
}

export function setPlayerHolds(holds: string[]) {
    activeApp?.setPlayerHolds(holds)
}

export function setPlayerGear(gearIds: string[]) {
    activeApp?.setPlayerGear(gearIds.filter(Boolean))
}

export function setFishingMode(mode: string) {
    activeApp?.setFishingMode(mode)
}

export async function setEquippedGear(gearId: string | null) {
    pendingEquippedGear = gearId
    if (activeApp) {
        await activeApp.setEquippedGear(gearId)
    }
}

export function tryUseGear() {
    return activeApp?.tryUseGear() ?? { success: false, message: 'Game not running' }
}

export async function teleportToMapId(mapId: string, x: number, y: number) {
    return (await activeApp?.teleportToMapId(mapId, x, y)) ?? false
}

declare global {
    interface Window {
        TelegramGame: {
            startGame: typeof startGame
            stopGame: typeof stopGame
            switchGameSkin: typeof switchGameSkin
            onGameEvent: typeof onGameEvent
            offGameEvent: typeof offGameEvent
            onPlayerPosition: typeof onPlayerPosition
            offPlayerPosition: typeof offPlayerPosition
            setPadDirection: typeof setPadDirection
            clearPadInput: typeof clearPadInput
            advanceNpcDialogue: typeof advanceNpcDialogue
            finishNpcDialogue: typeof finishNpcDialogue
            onSignModalClosed: typeof onSignModalClosed
            setPlayerHolds: typeof setPlayerHolds
            setPlayerGear: typeof setPlayerGear
            setFishingMode: typeof setFishingMode
            setEquippedGear: typeof setEquippedGear
            tryUseGear: typeof tryUseGear
            teleportToMapId: typeof teleportToMapId
        }
    }
}

window.TelegramGame = {
    startGame,
    stopGame,
    switchGameSkin,
    onGameEvent,
    offGameEvent,
    onPlayerPosition,
    offPlayerPosition,
    setPadDirection,
    clearPadInput,
    advanceNpcDialogue,
    finishNpcDialogue,
    onSignModalClosed,
    setPlayerHolds,
    setPlayerGear,
    setFishingMode,
    setEquippedGear,
    tryUseGear,
    teleportToMapId,
}
