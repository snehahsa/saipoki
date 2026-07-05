const TILE = 32
const DEFAULT_ROOM_NAME = "Pokequest-cards"
const ROOM_NAME_MAX_LENGTH = 32

function roomIdForIndex(index) {
    return `map-${index}`
}

function getRoomId(room, index = 0) {
    const id = String(room?.id ?? "").trim()
    return id || roomIdForIndex(index)
}

function defaultRoomNameForIndex(index) {
    return index === 0 ? DEFAULT_ROOM_NAME : `Map ${index + 1}`
}

function getRoomDisplayName(room, index = 0) {
    const name = String(room?.name ?? "").trim()
    return name || defaultRoomNameForIndex(index)
}

function readRoomNameFromEditor() {
    const input = document.getElementById("room-name")
    const val = input?.value.trim() || state.roomName?.trim() || ""
    return val.slice(0, ROOM_NAME_MAX_LENGTH) || DEFAULT_ROOM_NAME
}

function readRoomMapIdFromEditor() {
    const input = document.getElementById("room-map-id")
    const val = input?.value.trim()
    if (val) return val
    return getRoomId(state.rooms[state.roomIndex], state.roomIndex)
}

function getActiveRoomMapId() {
    if (state.portalPreview) return state.portalPreview.targetMapId
    return readRoomMapIdFromEditor()
}

function getActiveRoomDisplayName() {
    if (state.portalPreview) {
        const idx = findRoomIndexByMapId(state.portalPreview.targetMapId)
        const room = idx >= 0 ? state.rooms[idx] : findRoomByMapId(state.portalPreview.targetMapId)
        return getRoomDisplayName(room, idx >= 0 ? idx : 0)
    }
    return readRoomNameFromEditor()
}

function syncRoomNameFromEditor(name) {
    const trimmed = String(name || "").trim().slice(0, ROOM_NAME_MAX_LENGTH) || DEFAULT_ROOM_NAME
    state.roomName = trimmed
    const sidebar = document.getElementById("room-name")
    const overlay = document.getElementById("map-name-overlay-input")
    if (sidebar && sidebar.value !== trimmed) sidebar.value = trimmed
    if (overlay && document.activeElement !== overlay && overlay.value !== trimmed) overlay.value = trimmed
}

const state = {
    catalog: null,
    sheetImages: {},
    spriteImages: {},
    tilemap: {},
    spawnpoint: { roomIndex: 0, x: 31, y: 39 },
    roomName: DEFAULT_ROOM_NAME,
    roomIndex: 0,
    selectedSheet: "ground",
    selectedLayer: "floor",
    selectedSprite: null,
    tool: "paint",
    zoom: 1.5,
    panX: 40,
    panY: 40,
    painting: false,
    panning: false,
    lastTile: null,
    history: [],
    historyIndex: -1,
    search: "",
    paintScale: 1,
    selectedPlacement: null,
    boundaryPoints: [],
    boundaryColliders: [],
    mapBoundary: [],
    npcs: [],
    selectedNpcIndex: 0,
    selectedMessageTile: null,
    roomMeta: {},
    characterSkins: [],
    animalSkins: [],
    animationSkins: [],
    gearItems: [],
    gearAttachEditor: {
        open: false,
        itemId: null,
        item: null,
        direction: "left",
        faces: {},
        charImage: null,
        itemImage: null,
        charSkin: "009",
        drag: null,
        canvasLayout: null,
    },
    avatarCosts: {},
    rooms: [],
    portalPreview: null,
    portalPreviewReturn: 0,
    portalPick: null,
    selectedPortalConnectionId: null,
    portalListShowAll: false,
    animalFrameEditor: {
        open: false,
        editorKind: "animal",
        animal: null,
        frames: {},
        direction: "down",
        slot: 0,
        displayScale: 1,
        frameMs: 180,
        fixedFrameW: 48,
        fixedFrameH: 48,
        customFrames: false,
        image: null,
        drag: null,
    },
}

let panStart = null

const canvas = document.getElementById("map-canvas")
const ctx = canvas.getContext("2d")
const wrap = document.getElementById("canvas-wrap")
const boundaryWrap = document.getElementById("boundary-wrap")
const boundaryCanvas = document.getElementById("boundary-canvas")
const boundaryCtx = boundaryCanvas.getContext("2d")

function tileKey(x, y) {
    return `${x}, ${y}`
}

function parseKey(key) {
    const [x, y] = key.split(", ")
    return { x: Number(x), y: Number(y) }
}

function normalizePlacement(val) {
    if (!val) return null
    if (typeof val === "string") return { id: val, scale: 1 }
    if (typeof val === "object" && val.id) {
        return { id: val.id, scale: val.scale ?? 1 }
    }
    return null
}

function compactPlacement(placement) {
    if (!placement) return null
    if (placement.scale === 1) return placement.id
    return { id: placement.id, scale: placement.scale }
}

function placementId(val) {
    return normalizePlacement(val)?.id || null
}

function cloneTilemap(map) {
    return JSON.parse(JSON.stringify(map))
}

function cloneNpcs(list) {
    return JSON.parse(JSON.stringify(list || []))
}

function cloneMapBoundary(points) {
    if (!Array.isArray(points)) return []
    return points.map((p) => ({ x: Number(p.x), y: Number(p.y) }))
}

function ensureRoomIds(rooms) {
    return (rooms || []).map((room, index) => ({
        ...room,
        id: getRoomId(room, index),
    }))
}

function findRoomIndexByMapId(mapId) {
    const trimmed = String(mapId || "").trim()
    if (!trimmed) return -1
    return state.rooms.findIndex((room) => room.id === trimmed)
}

function findRoomByMapId(mapId) {
    const index = findRoomIndexByMapId(mapId)
    return index >= 0 ? state.rooms[index] : null
}

function getActiveTilemap() {
    if (state.portalPreview) {
        const room = findRoomByMapId(state.portalPreview.targetMapId)
        return room?.tilemap || {}
    }
    return state.tilemap
}

function getMessageSourceTile() {
    if (state.selectedMessageTile && tileHasPlacement(state.selectedMessageTile)) {
        return state.selectedMessageTile
    }
    return null
}

function syncMessageSelectionFromPlacement() {
    if (getMessageSourceTile()) return
    const key = state.selectedPlacement?.key
    if (key && tileHasPlacement(key)) {
        state.selectedMessageTile = key
    }
}

function cancelPortalPick() {
    state.portalPick = null
    wrap?.classList.remove("portal-pick-enter", "portal-pick-exit")
}

function resolveExitForEnter(enter) {
    const targetIndex = findRoomIndexByMapId(enter.targetMapId)
    if (targetIndex < 0) return null
    const room = state.rooms[targetIndex]
    const autoTag = `${enter.sourceMapId}@${enter.sourceX},${enter.sourceY}`

    for (const [key, cell] of Object.entries(room.tilemap || {})) {
        const interaction = cell?.interaction
        if (!interaction?.portal?.mapId) continue
        if (
            interaction.portalAutoReturn === autoTag ||
            (interaction.portal.mapId === enter.sourceMapId &&
                interaction.portal.x === enter.sourceX &&
                interaction.portal.y === enter.sourceY)
        ) {
            const { x, y } = parseKey(key)
            return {
                roomIndex: targetIndex,
                key,
                mapId: enter.targetMapId,
                mapName: enter.targetMapName,
                x,
                y,
                title: interaction.title || "Exit",
            }
        }
    }

    const fallbackKey = tileKey(enter.targetX, enter.targetY)
    const fallbackCell = room.tilemap?.[fallbackKey]
    return {
        roomIndex: targetIndex,
        key: fallbackKey,
        mapId: enter.targetMapId,
        mapName: enter.targetMapName,
        x: enter.targetX,
        y: enter.targetY,
        title: fallbackCell?.interaction?.title || "Exit",
        missing: !fallbackCell?.interaction?.portal,
    }
}

function buildEnterPortalRecord(roomIndex, key, cell) {
    const portal = cell.interaction.portal
    const { x, y } = parseKey(key)
    return {
        sourceRoomIndex: roomIndex,
        sourceMapId: getRoomId(state.rooms[roomIndex], roomIndex),
        sourceMapName: getRoomDisplayName(state.rooms[roomIndex], roomIndex),
        sourceKey: key,
        sourceX: x,
        sourceY: y,
        targetMapId: portal.mapId,
        targetMapName: getRoomDisplayName(
            findRoomByMapId(portal.mapId),
            findRoomIndexByMapId(portal.mapId)
        ),
        targetX: portal.x,
        targetY: portal.y,
        title: cell.interaction?.title || "Portal",
    }
}

function portalConnectionId(enter) {
    return `${enter.sourceMapId}@${enter.sourceX},${enter.sourceY}`
}

function resolveEnterFromAnyPortalTile(roomIndex, key, cell) {
    const interaction = cell?.interaction
    if (!interaction?.portal?.mapId) return null

    const autoReturn = interaction.portalAutoReturn
    if (autoReturn) {
        const match = String(autoReturn).match(/^(.+)@(-?\d+),(-?\d+)$/)
        if (match) {
            const [, refMapId, rx, ry] = match
            const refRoomIdx = findRoomIndexByMapId(refMapId)
            if (refRoomIdx >= 0) {
                const refKey = tileKey(Number(rx), Number(ry))
                const refCell = state.rooms[refRoomIdx]?.tilemap?.[refKey]
                if (refCell?.interaction?.portal) {
                    const { x, y } = parseKey(key)
                    const myMapId = getRoomId(state.rooms[roomIndex], roomIndex)
                    const myTag = `${myMapId}@${x},${y}`
                    if (refCell.interaction.portalAutoReturn === myTag) {
                        return buildEnterPortalRecord(roomIndex, key, cell)
                    }
                    if (!refCell.interaction.portalAutoReturn) {
                        return buildEnterPortalRecord(refRoomIdx, refKey, refCell)
                    }
                    return resolveEnterFromAnyPortalTile(refRoomIdx, refKey, refCell)
                }
            }
        }
    }

    return buildEnterPortalRecord(roomIndex, key, cell)
}

function collectPortalConnections() {
    const seen = new Set()
    const connections = []
    state.rooms.forEach((room, roomIndex) => {
        for (const [key, cell] of Object.entries(room.tilemap || {})) {
            if (!cell?.interaction?.portal?.mapId) continue
            const enter = resolveEnterFromAnyPortalTile(roomIndex, key, cell)
            if (!enter) continue
            const id = portalConnectionId(enter)
            if (seen.has(id)) continue
            seen.add(id)
            connections.push({
                id,
                enter,
                exit: resolveExitForEnter(enter),
            })
        }
    })
    return connections
}

function connectionTouchesRoom(connection, roomIndex) {
    const { enter, exit } = connection
    if (enter.sourceRoomIndex === roomIndex) return true
    if (exit?.roomIndex === roomIndex) return true
    return false
}

function getPortalConnectionsForDisplay() {
    const all = collectPortalConnections()
    if (state.portalListShowAll) return all
    return all.filter((c) => connectionTouchesRoom(c, state.roomIndex))
}

function getSelectedPortalConnection() {
    if (!state.selectedPortalConnectionId) return null
    return collectPortalConnections().find((c) => c.id === state.selectedPortalConnectionId) || null
}

function focusPortalConnection(connection) {
    if (!connection) return
    state.selectedPortalConnectionId = connection.id
    state.tool = "portals"
    syncTools()
    updatePortalConnectionEditor()
    renderPortalList()
    draw()
}

function focusPortalConnectionAt(roomIndex, key) {
    const cell = state.rooms[roomIndex]?.tilemap?.[key]
    if (!cell?.interaction?.portal?.mapId) return false
    const enter = resolveEnterFromAnyPortalTile(roomIndex, key, cell)
    if (!enter) return false
    const id = portalConnectionId(enter)
    const connection = collectPortalConnections().find((c) => c.id === id)
    if (!connection) return false
    const { x, y } = parseKey(key)
    pickTile(x, y)
    focusPortalConnection(connection)
    return true
}

function upsertPortalConnection({
    sourceRoomIndex,
    sourceKey,
    targetRoomIndex,
    exitX,
    exitY,
}) {
    persistCurrentRoom()
    const sourceRoom = state.rooms[sourceRoomIndex]
    const targetRoom = state.rooms[targetRoomIndex]
    const sourceMapId = getRoomId(sourceRoom, sourceRoomIndex)
    const targetMapId = getRoomId(targetRoom, targetRoomIndex)
    const { x: sx, y: sy } = parseKey(sourceKey)
    const exitKey = tileKey(exitX, exitY)
    const autoTag = `${sourceMapId}@${sx},${sy}`

    for (const [k, cell] of Object.entries(targetRoom.tilemap || {})) {
        if (k === exitKey) continue
        if (cell?.interaction?.portalAutoReturn === autoTag) {
            delete cell.interaction
            if (!Object.keys(cell).length) delete targetRoom.tilemap[k]
        }
    }

    if (!sourceRoom.tilemap[sourceKey]) sourceRoom.tilemap[sourceKey] = {}
    const enterInteraction = sourceRoom.tilemap[sourceKey].interaction || {}
    sourceRoom.tilemap[sourceKey].interaction = {
        ...enterInteraction,
        title: enterInteraction.title || "Portal",
        message: enterInteraction.message || "Step through to continue.",
        showExit: enterInteraction.showExit !== false,
        portal: { mapId: targetMapId, x: exitX, y: exitY },
    }
    delete sourceRoom.tilemap[sourceKey].interaction.portalAutoReturn

    if (!targetRoom.tilemap[exitKey]) targetRoom.tilemap[exitKey] = {}
    const exitInteraction = targetRoom.tilemap[exitKey].interaction || {}
    targetRoom.tilemap[exitKey].interaction = {
        ...exitInteraction,
        title:
            exitInteraction.title ||
            `Return to ${getRoomDisplayName(sourceRoom, sourceRoomIndex)}`,
        message: exitInteraction.message || "Step through to go back.",
        showExit: exitInteraction.showExit !== false,
        portal: { mapId: sourceMapId, x: sx, y: sy },
        portalAutoReturn: autoTag,
    }

    if (state.roomIndex === sourceRoomIndex) {
        state.tilemap = cloneTilemap(sourceRoom.tilemap)
    } else if (state.roomIndex === targetRoomIndex) {
        state.tilemap = cloneTilemap(targetRoom.tilemap)
    }
}

function isDefaultPortalCopy(title, message) {
    title = String(title || "").trim()
    message = String(message || "").trim()
    if (title === "Portal" && (!message || message === "Step through to continue.")) return true
    if (title.startsWith("Return to ") && (!message || message === "Step through to go back.")) return true
    return !title && !message
}

function stripPortalFromInteraction(interaction) {
    if (!interaction || typeof interaction !== "object") return null
    const copy = { ...interaction }
    delete copy.portal
    delete copy.portalAutoReturn
    if (Array.isArray(copy.options)) {
        const opts = copy.options.filter((o) => String(o?.code || "").trim().toLowerCase() !== "enter_portal")
        if (opts.length) copy.options = opts
        else delete copy.options
    }
    const title = String(copy.title || "").trim()
    const message = String(copy.message || "").trim()
    const hasOpts = (copy.options || []).length > 0
    const hasPickup = !!String(copy.pickupHold || "").trim()
    if (isDefaultPortalCopy(title, message) && !hasOpts && !hasPickup) return null
    if (!title && !message && !hasOpts && !hasPickup) return null
    return copy
}

function cleanCellAfterPortalRemove(cell) {
    if (!cell?.interaction) return false
    const hadPortal = !!(cell.interaction.portal || cell.interaction.portalAutoReturn)
    const cleaned = stripPortalFromInteraction(cell.interaction)
    if (cleaned) cell.interaction = cleaned
    else delete cell.interaction
    return hadPortal
}

function removeAllPortals() {
    if (!confirm("Remove every portal connection from all maps?")) return
    persistCurrentRoom()
    let count = 0
    for (const room of state.rooms) {
        const tilemap = room.tilemap || {}
        for (const key of Object.keys(tilemap)) {
            const cell = tilemap[key]
            if (cleanCellAfterPortalRemove(cell)) count++
            if (cell && !Object.keys(cell).length) delete tilemap[key]
        }
    }
    state.tilemap = cloneTilemap(state.rooms[state.roomIndex]?.tilemap || {})
    cancelPortalPick()
    state.selectedMessageTile = null
    renderPortalList()
    updatePortalSpotDisplay()
    updateMessageEditor()
    pushHistory()
    draw()
    showToast(count ? `Removed ${count} portal spot${count === 1 ? "" : "s"}` : "No portals found")
}

function deletePortalConnection(connection) {
    persistCurrentRoom()
    const { enter, exit } = connection
    const sourceRoom = state.rooms[enter.sourceRoomIndex]
    const sourceCell = sourceRoom.tilemap?.[enter.sourceKey]
    if (sourceCell) {
        cleanCellAfterPortalRemove(sourceCell)
        if (!Object.keys(sourceCell).length) delete sourceRoom.tilemap[enter.sourceKey]
    }
    if (exit) {
        const targetRoom = state.rooms[exit.roomIndex]
        const exitCell = targetRoom.tilemap?.[exit.key]
        if (exitCell) {
            cleanCellAfterPortalRemove(exitCell)
            if (!Object.keys(exitCell).length) delete targetRoom.tilemap[exit.key]
        }
    }
    if (state.roomIndex === enter.sourceRoomIndex) {
        state.tilemap = cloneTilemap(sourceRoom.tilemap)
    } else if (exit && state.roomIndex === exit.roomIndex) {
        state.tilemap = cloneTilemap(state.rooms[exit.roomIndex].tilemap)
    }
    if (state.selectedMessageTile === enter.sourceKey) {
        updateMessageEditor()
        updatePortalSpotDisplay()
    }
    if (state.selectedPortalConnectionId === portalConnectionId(enter)) {
        state.selectedPortalConnectionId = null
    }
    renderPortalList()
    pushHistory()
    draw()
}

function startPortalPick(role, draft = {}) {
    cancelPortalPick()
    state.portalPick = { role, draft: { ...draft } }

    if (role === "enter") {
        const sourceRoomIndex = draft.sourceRoomIndex ?? state.roomIndex
        if (sourceRoomIndex !== state.roomIndex) {
            persistCurrentRoom()
            loadRoomIntoEditor(sourceRoomIndex, { skipHistory: true, keepPortalPick: true })
        }
        if (state.tool !== "message" && state.tool !== "portals") {
            state.tool = "portals"
            syncTools()
        }
        wrap?.classList.add("portal-pick-enter")
        showToast("Click the ENTER portal item on the map")
        return
    }

    const targetMapId =
        draft.targetMapId || document.getElementById("portal-map-id")?.value.trim()
    if (!targetMapId) {
        cancelPortalPick()
        showToast("Choose an exit map first", true)
        return
    }
    const targetIndex = findRoomIndexByMapId(targetMapId)
    if (targetIndex < 0) {
        cancelPortalPick()
        showToast(`Map "${targetMapId}" not found`, true)
        return
    }

    state.portalPick.draft.targetMapId = targetMapId
    state.portalPick.draft.targetRoomIndex = targetIndex

    if (targetIndex !== state.roomIndex) {
        persistCurrentRoom()
        loadRoomIntoEditor(targetIndex, { skipHistory: true, keepPortalPick: true })
    }
    wrap?.classList.add("portal-pick-exit")
    showToast("Click the EXIT portal spot on the destination map")
}

function applyPortalPick(x, y) {
    const pick = state.portalPick
    if (!pick) return false

    const key = tileKey(x, y)
    if (pick.role === "enter") {
        if (!tileHasPlacement(key)) {
            showToast("Click a tile with a placed item for the ENTER portal", true)
            return true
        }
        const draft = pick.draft
        if (draft.sourceKey && draft.sourceKey !== key) {
            const oldRoom = state.rooms[draft.sourceRoomIndex ?? state.roomIndex]
            const oldCell = oldRoom?.tilemap?.[draft.sourceKey]
            if (oldCell?.interaction) {
                delete oldCell.interaction.portal
                if (
                    !oldCell.interaction.title &&
                    !oldCell.interaction.message &&
                    !(oldCell.interaction.options || []).length
                ) {
                    delete oldCell.interaction
                }
            }
        }
        draft.sourceRoomIndex = state.roomIndex
        draft.sourceKey = key
        draft.sourceMapId = readRoomMapIdFromEditor()
        draft.sourceX = x
        draft.sourceY = y
        cancelPortalPick()
        state.selectedMessageTile = key
        pickTile(x, y)

        if (
            draft.targetMapId &&
            Number.isFinite(draft.exitX) &&
            Number.isFinite(draft.exitY)
        ) {
            const targetIndex = findRoomIndexByMapId(draft.targetMapId)
            if (targetIndex >= 0) {
                upsertPortalConnection({
                    sourceRoomIndex: draft.sourceRoomIndex,
                    sourceKey: key,
                    targetRoomIndex: targetIndex,
                    exitX: draft.exitX,
                    exitY: draft.exitY,
                })
                pushHistory()
                showToast("Enter portal updated")
            }
        } else {
            showToast("Enter set — now pick the EXIT spot")
        }
        updateMessageEditor()
        updatePortalSpotDisplay()
        const enterCell = state.rooms[draft.sourceRoomIndex]?.tilemap?.[key]
        if (enterCell?.interaction?.portal) {
            const enter = buildEnterPortalRecord(draft.sourceRoomIndex, key, enterCell)
            state.selectedPortalConnectionId = portalConnectionId(enter)
            updatePortalConnectionEditor()
        }
        renderPortalList()
        draw()
        return true
    }

    const draft = pick.draft
    let sourceRoomIndex = draft.sourceRoomIndex
    let sourceKey = draft.sourceKey
    let sourceMapId = draft.sourceMapId
    let sourceX = draft.sourceX
    let sourceY = draft.sourceY

    if (!sourceKey) {
        syncMessageSelectionFromPlacement()
        sourceKey = getMessageSourceTile()
        if (!sourceKey) {
            showToast("Set the ENTER portal first, then pick EXIT", true)
            return true
        }
        sourceRoomIndex = state.roomIndex
        sourceMapId = readRoomMapIdFromEditor()
        const parsed = parseKey(sourceKey)
        sourceX = parsed.x
        sourceY = parsed.y
    }

    const targetRoomIndex = draft.targetRoomIndex ?? state.roomIndex
    upsertPortalConnection({
        sourceRoomIndex,
        sourceKey,
        targetRoomIndex,
        exitX: x,
        exitY: y,
    })
    cancelPortalPick()

    document.getElementById("portal-map-id").value = getRoomId(
        state.rooms[targetRoomIndex],
        targetRoomIndex
    )
    document.getElementById("portal-x").value = String(x)
    document.getElementById("portal-y").value = String(y)

    const keepPortalsTool = state.tool === "portals"

    if (sourceRoomIndex !== state.roomIndex) {
        loadRoomIntoEditor(sourceRoomIndex, { skipHistory: true, keepPortalPick: keepPortalsTool })
        state.selectedMessageTile = sourceKey
        if (!keepPortalsTool) {
            state.tool = "message"
            syncTools()
        }
    } else {
        state.selectedMessageTile = sourceKey
        if (!keepPortalsTool) {
            setInteraction(sourceKey, readMessageFieldsFromDom(), { refreshOptionsUI: false })
        }
    }

    const enterCell = state.rooms[sourceRoomIndex]?.tilemap?.[sourceKey]
    if (enterCell?.interaction?.portal) {
        state.selectedPortalConnectionId = portalConnectionId(
            buildEnterPortalRecord(sourceRoomIndex, sourceKey, enterCell)
        )
    }
    if (keepPortalsTool) {
        state.tool = "portals"
        syncTools()
    } else {
        updateMessageEditor()
    }
    pushHistory()
    updatePortalSpotDisplay()
    renderPortalList()
    showToast(`Exit portal set at ${x}, ${y}`)
    draw()
    return true
}

function updatePortalSpotDisplay() {
    const enterEl = document.getElementById("portal-enter-spot")
    const exitEl = document.getElementById("portal-exit-spot")
    if (!enterEl || !exitEl) return

    const sourceKey = getMessageSourceTile()
    if (!sourceKey) {
        enterEl.textContent = "Click a map item or use Pick Enter"
        exitEl.textContent = "Not set"
        return
    }

    const { x, y } = parseKey(sourceKey)
    const roomName = readRoomNameFromEditor()
    const mapId = readRoomMapIdFromEditor()
    enterEl.textContent = `${roomName} (${mapId}) @ ${x}, ${y}`

    const interaction = getInteraction(sourceKey)
    const portal = interaction?.portal
    if (!portal?.mapId || !Number.isFinite(portal.x) || !Number.isFinite(portal.y)) {
        exitEl.textContent = "Not set — choose exit map and pick spot"
        return
    }

    const targetIndex = findRoomIndexByMapId(portal.mapId)
    const targetRoom = targetIndex >= 0 ? state.rooms[targetIndex] : null
    const targetName = getRoomDisplayName(targetRoom, targetIndex >= 0 ? targetIndex : 0)
    exitEl.textContent = `${targetName} (${portal.mapId}) @ ${portal.x}, ${portal.y}`
}

function flushMessageEditor() {
    const key = getMessageSourceTile()
    if (!key) return
    setInteraction(key, readMessageFieldsFromDom(), { refreshOptionsUI: false })
}

function syncPortalReturnLinks() {
    for (let roomIndex = 0; roomIndex < state.rooms.length; roomIndex++) {
        const room = state.rooms[roomIndex]
        const sourceMapId = getRoomId(room, roomIndex)
        for (const [sourceKey, cell] of Object.entries(room.tilemap || {})) {
            const portal = cell.interaction?.portal
            if (!portal?.mapId || !Number.isFinite(portal.x) || !Number.isFinite(portal.y)) continue

            const targetIndex = findRoomIndexByMapId(portal.mapId)
            if (targetIndex < 0) continue

            const { x: sx, y: sy } = parseKey(sourceKey)
            const destKey = tileKey(portal.x, portal.y)
            const targetRoom = state.rooms[targetIndex]
            if (!targetRoom.tilemap[destKey]) targetRoom.tilemap[destKey] = {}

            const existing = targetRoom.tilemap[destKey].interaction
            const autoTag = `${sourceMapId}@${sx},${sy}`
            if (existing?.portalAutoReturn === autoTag) continue

            if (existing?.title && existing?.message && !existing?.portal) {
                existing.portal = { mapId: sourceMapId, x: sx, y: sy }
                existing.portalAutoReturn = autoTag
                if (existing.showExit === undefined) existing.showExit = true
                continue
            }

            targetRoom.tilemap[destKey].interaction = {
                title: `Return to ${getRoomDisplayName(room, roomIndex)}`,
                message: "Step through to go back.",
                portal: { mapId: sourceMapId, x: sx, y: sy },
                showExit: true,
                portalAutoReturn: autoTag,
            }
        }
    }
}

function persistCurrentRoom() {
    flushMessageEditor()
    if (!state.rooms.length) {
        state.rooms = [{
            id: roomIdForIndex(0),
            name: DEFAULT_ROOM_NAME,
            tilemap: {},
            npcs: [],
        }]
    }
    const mapId = readRoomMapIdFromEditor()
    state.rooms[state.roomIndex] = {
        id: mapId,
        name: readRoomNameFromEditor(),
        tilemap: cloneTilemap(state.tilemap),
        npcs: cloneNpcs(state.npcs),
        ...(state.roomMeta?.channelId ? { channelId: state.roomMeta.channelId } : {}),
        ...(state.mapBoundary?.length ? { mapBoundary: cloneMapBoundary(state.mapBoundary) } : {}),
    }
}

function loadRoomIntoEditor(index, { skipPersist = false, skipHistory = false, keepPortalPick = false } = {}) {
    if (!skipPersist) persistCurrentRoom()
    state.roomIndex = index
    state.portalPreview = null
    if (!keepPortalPick) {
        cancelPortalPick()
        wrap?.classList.remove("portal-preview-mode")
    }
    document.getElementById("portal-preview-banner")?.classList.add("hidden")

    const room = state.rooms[index] || {
        id: roomIdForIndex(index),
        name: defaultRoomNameForIndex(index),
        tilemap: {},
        npcs: [],
    }
    state.roomName = getRoomDisplayName(room, index)
    state.tilemap = cloneTilemap(room.tilemap || {})
    state.npcs = cloneNpcs(room.npcs || [])
    state.mapBoundary = cloneMapBoundary(room.mapBoundary || [])
    state.roomMeta = { channelId: room.channelId }
    state.selectedNpcIndex = Math.min(state.selectedNpcIndex, Math.max(0, state.npcs.length - 1))
    state.selectedMessageTile = null
    state.selectedPlacement = null

    if (Object.keys(state.tilemap).length === 0 && !keepPortalPick) {
        if (state.tool === "message" || state.tool === "portals" || state.portalPick) {
            cancelPortalPick()
            state.tool = "paint"
            syncTools()
        }
    }

    document.getElementById("room-name").value = state.roomName
    document.getElementById("room-map-id").value = getRoomId(room, index)

    updateNpcEditor()
    updateMessageEditor()
    updateMapBoundaryEditor()
    updatePortalMapIdSelect()
    renderRoomTabs()
    renderPortalList()
    updateStats()
    updatePlacementEditor()
    updateMapNameOverlay()
    if (!skipHistory) pushHistory()
    draw()
}

function addRoom() {
    persistCurrentRoom()
    const newIndex = state.rooms.length
    state.rooms.push({
        id: roomIdForIndex(newIndex),
        name: defaultRoomNameForIndex(newIndex),
        tilemap: {},
        npcs: [],
    })
    cancelPortalPick()
    state.tool = "paint"
    loadRoomIntoEditor(newIndex)
    syncTools()
    showToast(`Added ${defaultRoomNameForIndex(newIndex)} — pick a sprite, then paint`)
}

function collectAllPortals() {
    const portals = []
    state.rooms.forEach((room, roomIndex) => {
        for (const [key, cell] of Object.entries(room.tilemap || {})) {
            const portal = cell.interaction?.portal
            if (!portal?.mapId) continue
            const { x, y } = parseKey(key)
            portals.push({
                sourceRoomIndex: roomIndex,
                sourceMapId: getRoomId(room, roomIndex),
                sourceMapName: getRoomDisplayName(room, roomIndex),
                sourceKey: key,
                sourceX: x,
                sourceY: y,
                targetMapId: portal.mapId,
                targetMapName: getRoomDisplayName(findRoomByMapId(portal.mapId), findRoomIndexByMapId(portal.mapId)),
                targetX: portal.x,
                targetY: portal.y,
                title: cell.interaction?.title || "Portal",
            })
        }
    })
    return portals
}

function renderRoomTabs() {
    const container = document.getElementById("room-tabs")
    if (!container) return
    container.innerHTML = ""
    state.rooms.forEach((room, index) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "room-tab"
        if (index === state.roomIndex && !state.portalPreview) btn.classList.add("active")

        const nameEl = document.createElement("span")
        nameEl.className = "room-tab-name"
        nameEl.textContent = getRoomDisplayName(room, index)

        const idEl = document.createElement("span")
        idEl.className = "room-tab-id"
        idEl.textContent = getRoomId(room, index)

        btn.append(nameEl, idEl)
        btn.title = `${getRoomDisplayName(room, index)} (${getRoomId(room, index)})`
        btn.addEventListener("click", () => {
            closePortalPreview()
            loadRoomIntoEditor(index)
        })
        container.appendChild(btn)
    })
}

function updatePortalMapIdSelect() {
    const selects = [
        document.getElementById("portal-map-id"),
        document.getElementById("portal-conn-map-id"),
    ].filter(Boolean)
    if (!selects.length) return

    selects.forEach((select) => {
        const current = select.value
        select.innerHTML = ""
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.textContent = "Select target map…"
        select.appendChild(placeholder)
        state.rooms.forEach((room, index) => {
            const option = document.createElement("option")
            const mapId = getRoomId(room, index)
            option.value = mapId
            option.textContent = `${mapId} — ${getRoomDisplayName(room, index)}`
            select.appendChild(option)
        })
        if (current && [...select.options].some((opt) => opt.value === current)) {
            select.value = current
        }
    })
}

function updatePortalConnectionEditor() {
    const panel = document.getElementById("portal-connection-detail")
    if (!panel) return
    const connection = getSelectedPortalConnection()
    panel.classList.toggle("hidden", !connection)
    if (!connection) return

    updatePortalMapIdSelect()
    const { enter } = connection
    const sourceRoom = state.rooms[enter.sourceRoomIndex]
    const interaction = sourceRoom?.tilemap?.[enter.sourceKey]?.interaction || {}
    const portal = interaction.portal || {}

    const label = document.getElementById("portal-conn-label")
    if (label) {
        label.textContent = `${enter.sourceMapName} (${enter.sourceMapId}) @ ${enter.sourceX}, ${enter.sourceY}`
    }
    const titleInput = document.getElementById("portal-conn-title")
    const messageInput = document.getElementById("portal-conn-message")
    const mapIdInput = document.getElementById("portal-conn-map-id")
    const xInput = document.getElementById("portal-conn-x")
    const yInput = document.getElementById("portal-conn-y")
    if (titleInput) titleInput.value = interaction.title || ""
    if (messageInput) messageInput.value = interaction.message || ""
    if (mapIdInput) mapIdInput.value = portal.mapId || ""
    if (xInput) xInput.value = Number.isFinite(portal.x) ? String(portal.x) : ""
    if (yInput) yInput.value = Number.isFinite(portal.y) ? String(portal.y) : ""
}

function applyPortalConnectionFields() {
    const connection = getSelectedPortalConnection()
    if (!connection) return
    const { enter } = connection
    persistCurrentRoom()

    const title = document.getElementById("portal-conn-title")?.value.trim() || "Portal"
    const message = document.getElementById("portal-conn-message")?.value.trim() || ""
    const portalMapId = document.getElementById("portal-conn-map-id")?.value.trim() || ""
    const portalX = Number(document.getElementById("portal-conn-x")?.value)
    const portalY = Number(document.getElementById("portal-conn-y")?.value)

    const sourceRoom = state.rooms[enter.sourceRoomIndex]
    if (!sourceRoom.tilemap[enter.sourceKey]) sourceRoom.tilemap[enter.sourceKey] = {}
    const interaction = sourceRoom.tilemap[enter.sourceKey].interaction || {}
    sourceRoom.tilemap[enter.sourceKey].interaction = {
        ...interaction,
        title,
        message: message || interaction.message || "Step through to continue.",
        showExit: interaction.showExit !== false,
    }
    delete sourceRoom.tilemap[enter.sourceKey].interaction.portalAutoReturn

    if (portalMapId && Number.isFinite(portalX) && Number.isFinite(portalY)) {
        sourceRoom.tilemap[enter.sourceKey].interaction.portal = {
            mapId: portalMapId,
            x: portalX,
            y: portalY,
        }
        const targetIndex = findRoomIndexByMapId(portalMapId)
        if (targetIndex >= 0) {
            upsertPortalConnection({
                sourceRoomIndex: enter.sourceRoomIndex,
                sourceKey: enter.sourceKey,
                targetRoomIndex: targetIndex,
                exitX: portalX,
                exitY: portalY,
            })
        }
    }

    if (state.roomIndex === enter.sourceRoomIndex) {
        state.tilemap = cloneTilemap(sourceRoom.tilemap)
    }
    renderPortalList()
    pushHistory()
    draw()
}

function renderPortalList() {
    const list = document.getElementById("portal-list")
    if (!list) return
    const connections = getPortalConnectionsForDisplay()
    const allCount = collectPortalConnections().length
    list.innerHTML = ""

    const filterRow = document.getElementById("portal-list-filter")
    if (filterRow) {
        const roomName = getRoomDisplayName(state.rooms[state.roomIndex], state.roomIndex)
        filterRow.textContent = state.portalListShowAll
            ? `All maps (${allCount} connection${allCount === 1 ? "" : "s"})`
            : `${roomName} (${connections.length} of ${allCount})`
    }

    if (!connections.length) {
        list.innerHTML = state.portalListShowAll
            ? '<p class="prop-meta interaction-options-empty">No portal connections yet. Use + New connection below.</p>'
            : `<p class="prop-meta interaction-options-empty">No portals on this map. Toggle “All maps” or add a connection.</p>`
        updatePortalConnectionEditor()
        return
    }

    connections.forEach((connection) => {
        const { enter, exit, id } = connection
        const card = document.createElement("div")
        card.className = "portal-card"
        if (id === state.selectedPortalConnectionId) card.classList.add("selected")
        const exitLabel = exit
            ? `${exit.mapName || exit.mapId} @ ${exit.x}, ${exit.y}${exit.missing ? " (needs exit item)" : ""}`
            : `${enter.targetMapName || enter.targetMapId} @ ${enter.targetX}, ${enter.targetY}`
        card.innerHTML = `
            <div class="portal-card-head">
                <span class="portal-card-title">${escapeAttr(enter.title)}</span>
            </div>
            <div class="portal-spot-row">
                <span class="portal-spot-badge portal-spot-badge-enter">Enter</span>
                <span class="portal-spot-text">${escapeAttr(enter.sourceMapName)} @ ${enter.sourceX}, ${enter.sourceY}</span>
            </div>
            <div class="portal-spot-row">
                <span class="portal-spot-badge portal-spot-badge-exit">Exit</span>
                <span class="portal-spot-text">${escapeAttr(exitLabel)}</span>
            </div>
            <div class="portal-card-actions">
                <button type="button" class="btn btn-ghost btn-sm portal-pick-enter-btn">Edit Enter</button>
                <button type="button" class="btn btn-ghost btn-sm portal-pick-exit-btn">Edit Exit</button>
                <button type="button" class="btn btn-ghost btn-sm portal-view-btn">View</button>
                <button type="button" class="btn btn-ghost btn-sm portal-remove-btn">Remove</button>
            </div>
        `
        card.addEventListener("click", (e) => {
            if (e.target.closest("button")) return
            focusPortalConnection(connection)
        })
        card.querySelector(".portal-pick-enter-btn").addEventListener("click", () => {
            closePortalPreview()
            startPortalPick("enter", {
                sourceRoomIndex: enter.sourceRoomIndex,
                sourceKey: enter.sourceKey,
                sourceMapId: enter.sourceMapId,
                sourceX: enter.sourceX,
                sourceY: enter.sourceY,
                targetMapId: enter.targetMapId,
                exitX: enter.targetX,
                exitY: enter.targetY,
            })
        })
        card.querySelector(".portal-pick-exit-btn").addEventListener("click", () => {
            closePortalPreview()
            startPortalPick("exit", {
                sourceRoomIndex: enter.sourceRoomIndex,
                sourceKey: enter.sourceKey,
                sourceMapId: enter.sourceMapId,
                sourceX: enter.sourceX,
                sourceY: enter.sourceY,
                targetMapId: enter.targetMapId,
                targetRoomIndex: exit?.roomIndex ?? findRoomIndexByMapId(enter.targetMapId),
                exitX: enter.targetX,
                exitY: enter.targetY,
            })
        })
        card.querySelector(".portal-view-btn").addEventListener("click", () => openPortalPreview(enter))
        card.querySelector(".portal-remove-btn").addEventListener("click", () => {
            if (confirm("Remove this portal connection?")) deletePortalConnection(connection)
        })
        list.appendChild(card)
    })
    updatePortalConnectionEditor()
}

function openPortalPreview(portal) {
    if (!findRoomByMapId(portal.targetMapId)) {
        showToast(`Target map "${portal.targetMapId}" not found`, true)
        return
    }
    state.portalPreviewReturn = state.roomIndex
    state.portalPreview = { ...portal }
    cancelPortalPick()
    wrap?.classList.add("portal-preview-mode")

    const banner = document.getElementById("portal-preview-banner")
    const label = document.getElementById("portal-preview-label")
    if (banner) banner.classList.remove("hidden")
    if (label) {
        const targetIdx = findRoomIndexByMapId(portal.targetMapId)
        const targetRoom = targetIdx >= 0 ? state.rooms[targetIdx] : null
        const targetName = getRoomDisplayName(targetRoom, targetIdx >= 0 ? targetIdx : 0)
        label.textContent = `${portal.sourceMapName || portal.sourceMapId} → ${targetName} (${portal.targetMapId}) spawn ${portal.targetX}, ${portal.targetY}`
    }
    updateMapNameOverlay()
    draw()
}

function closePortalPreview() {
    state.portalPreview = null
    cancelPortalPick()
    wrap?.classList.remove("portal-preview-mode")
    document.getElementById("portal-preview-banner")?.classList.add("hidden")
    renderRoomTabs()
    updateMapNameOverlay()
    draw()
}

function drawPortalPreviewOverlay(targetCtx) {
    const preview = state.portalPreview
    if (!preview) return

    const sx = preview.targetX * TILE + TILE / 2
    const sy = preview.targetY * TILE + TILE / 2
    const bounds = getBounds()
    const fromX = ((bounds.minX + bounds.maxX + 1) / 2) * TILE
    const fromY = bounds.minY * TILE - TILE * 0.5

    targetCtx.save()
    targetCtx.strokeStyle = "#a78bfa"
    targetCtx.fillStyle = "#a78bfa"
    targetCtx.lineWidth = 2 / state.zoom
    targetCtx.setLineDash([8 / state.zoom, 6 / state.zoom])
    targetCtx.beginPath()
    targetCtx.moveTo(fromX, fromY)
    const midY = (fromY + sy) / 2
    targetCtx.bezierCurveTo(fromX, midY, sx, midY, sx, sy - TILE / 2)
    targetCtx.stroke()
    targetCtx.setLineDash([])

    targetCtx.beginPath()
    targetCtx.moveTo(sx, sy - TILE / 2)
    targetCtx.lineTo(sx - 6 / state.zoom, sy - TILE / 2 - 8 / state.zoom)
    targetCtx.lineTo(sx + 6 / state.zoom, sy - TILE / 2 - 8 / state.zoom)
    targetCtx.closePath()
    targetCtx.fill()

    targetCtx.fillStyle = "rgba(74, 222, 128, 0.35)"
    targetCtx.strokeStyle = "#4ade80"
    targetCtx.lineWidth = 2 / state.zoom
    targetCtx.fillRect(preview.targetX * TILE, preview.targetY * TILE, TILE, TILE)
    targetCtx.strokeRect(preview.targetX * TILE + 1, preview.targetY * TILE + 1, TILE - 2, TILE - 2)
    targetCtx.fillStyle = "#4ade80"
    targetCtx.font = `${10 / state.zoom}px sans-serif`
    targetCtx.textAlign = "center"
    targetCtx.fillText("spawn", sx, sy + 4 / state.zoom)
    targetCtx.textAlign = "left"

    targetCtx.fillStyle = "rgba(167, 139, 250, 0.9)"
    targetCtx.font = `${11 / state.zoom}px sans-serif`
    targetCtx.fillText(
        `← ${preview.sourceMapName || preview.sourceMapId} @ ${preview.sourceX}, ${preview.sourceY}`,
        fromX - 80 / state.zoom,
        fromY - 6 / state.zoom
    )
    targetCtx.restore()
}

function drawMapNameBanner(targetCtx) {
    const name = getActiveRoomDisplayName()
    const mapId = getActiveRoomMapId()
    const bounds = getBounds()
    const pad = 4
    const cx = ((bounds.minX + bounds.maxX + 1) / 2) * TILE
    const topY = (bounds.minY - pad) * TILE
    const fontSize = 12 / state.zoom
    const subSize = 9 / state.zoom
    const paddingX = 10 / state.zoom
    const paddingY = 6 / state.zoom

    targetCtx.save()
    targetCtx.font = `600 ${fontSize}px sans-serif`
    const nameWidth = targetCtx.measureText(name).width
    targetCtx.font = `${subSize}px sans-serif`
    const idWidth = targetCtx.measureText(mapId).width
    const boxW = Math.max(nameWidth, idWidth) + paddingX * 2
    const boxH = fontSize + subSize + paddingY * 2 + 2 / state.zoom
    const x = cx - boxW / 2
    const y = topY - boxH - 4 / state.zoom

    targetCtx.fillStyle = "rgba(15, 23, 42, 0.88)"
    targetCtx.strokeStyle = "rgba(96, 165, 250, 0.55)"
    targetCtx.lineWidth = 1 / state.zoom
    targetCtx.beginPath()
    if (typeof targetCtx.roundRect === "function") {
        targetCtx.roundRect(x, y, boxW, boxH, 6 / state.zoom)
    } else {
        targetCtx.rect(x, y, boxW, boxH)
    }
    targetCtx.fill()
    targetCtx.stroke()

    targetCtx.textAlign = "center"
    targetCtx.fillStyle = "#f8fafc"
    targetCtx.font = `600 ${fontSize}px sans-serif`
    targetCtx.fillText(name, cx, y + paddingY + fontSize * 0.85)
    targetCtx.fillStyle = "#94a3b8"
    targetCtx.font = `${subSize}px sans-serif`
    targetCtx.fillText(mapId, cx, y + paddingY + fontSize + subSize * 0.95)
    targetCtx.textAlign = "left"
    targetCtx.restore()
}

function updateMapNameOverlay() {
    const overlay = document.getElementById("map-name-overlay")
    const input = document.getElementById("map-name-overlay-input")
    const idEl = document.getElementById("map-name-overlay-id")
    if (!overlay || !input) return

    const bounds = getBounds()
    const pad = 4
    const centerTileX = (bounds.minX + bounds.maxX + 1) / 2
    const topTileY = bounds.minY - pad
    const screenX = state.panX + centerTileX * TILE * state.zoom
    const screenY = state.panY + topTileY * TILE * state.zoom - 8

    overlay.style.left = `${screenX}px`
    overlay.style.top = `${Math.max(8, screenY)}px`

    const inPreview = !!state.portalPreview
    const name = getActiveRoomDisplayName()
    const mapId = getActiveRoomMapId()

    if (document.activeElement !== input) input.value = name
    if (idEl) idEl.textContent = mapId
    input.readOnly = inPreview
    overlay.classList.toggle("is-preview", inPreview)
    overlay.classList.toggle("hidden", state.tool === "boundaries")
}

function pushHistory() {
    state.history = state.history.slice(0, state.historyIndex + 1)
    state.history.push({
        tilemap: cloneTilemap(state.tilemap),
        spawnpoint: { ...state.spawnpoint },
        npcs: cloneNpcs(state.npcs),
        mapBoundary: cloneMapBoundary(state.mapBoundary),
    })
    if (state.history.length > 80) state.history.shift()
    state.historyIndex = state.history.length - 1
}

function undo() {
    if (state.historyIndex <= 0) return
    state.historyIndex -= 1
    applySnapshot(state.history[state.historyIndex])
}

function redo() {
    if (state.historyIndex >= state.history.length - 1) return
    state.historyIndex += 1
    applySnapshot(state.history[state.historyIndex])
}

function applySnapshot(snap) {
    state.tilemap = cloneTilemap(snap.tilemap)
    state.spawnpoint = { ...snap.spawnpoint }
    state.npcs = cloneNpcs(snap.npcs || [])
    state.mapBoundary = cloneMapBoundary(snap.mapBoundary || [])
    state.selectedPlacement = null
    state.selectedMessageTile = null
    updateStats()
    updatePlacementEditor()
    updateNpcEditor()
    updateMessageEditor()
    updateMapBoundaryEditor()
    draw()
}

function getSpriteById(id) {
    return state.catalog?.sprites.find((s) => s.id === id) || null
}

function getSheetImage(sheetName) {
    return state.sheetImages[sheetName]
}

function isAnimSprite(sprite) {
    return Boolean(sprite?.animated || sprite?.id?.startsWith("anim-"))
}

function animIntrinsicScale(sprite) {
    return isAnimSprite(sprite) ? (sprite.defaultScale ?? 1) : 1
}

function spriteAnchor(sprite) {
    if (isAnimSprite(sprite)) {
        return { x: 0, y: 1 }
    }
    return {
        x: sprite.anchorX ?? 0,
        y: sprite.anchorY ?? (1 - TILE / sprite.height),
    }
}

function tileCoordinatesOfCollider(anchorX, anchorY, sprite, collider, scale) {
    const anchor = spriteAnchor(sprite)
    const screenX = anchorX * TILE
    const screenY = anchorY * TILE
    const dw = sprite.width * scale
    const dh = sprite.height * scale
    const topLeftX = screenX - dw * anchor.x
    const topLeftY = screenY - dh * anchor.y
    return {
        x: Math.floor((topLeftX + collider.x * TILE * scale) / TILE),
        y: Math.floor((topLeftY + collider.y * TILE * scale) / TILE),
    }
}

function scaledColliderWorldTiles(anchorX, anchorY, sprite, scale) {
    if (!sprite?.colliders?.length) return []
    const seen = new Set()
    const tiles = []
    for (const collider of sprite.colliders) {
        const { x, y } = tileCoordinatesOfCollider(anchorX, anchorY, sprite, collider, scale)
        const key = `${x},${y}`
        if (seen.has(key)) continue
        seen.add(key)
        tiles.push({ x, y })
    }
    return tiles
}

function spriteSourceRect(sprite) {
    if (!sprite) {
        return { sx: 0, sy: 0, sw: TILE, sh: TILE }
    }
    if (sprite.url) {
        return {
            sx: sprite.srcX ?? sprite.x ?? 0,
            sy: sprite.srcY ?? sprite.y ?? 0,
            sw: sprite.width,
            sh: sprite.height,
        }
    }
    return {
        sx: sprite.x,
        sy: sprite.y,
        sw: sprite.width,
        sh: sprite.height,
    }
}

function drawSpriteOnCtx(targetCtx, sprite, tx, ty, placementVal) {
    const img = sprite.url ? state.spriteImages[sprite.id] : getSheetImage(sprite.sheet)
    if (!img) return
    const placement = normalizePlacement(placementVal)
    const placeScale = placement?.scale ?? 1
    const drawScale = placeScale * animIntrinsicScale(sprite)
    const px = tx * TILE
    const py = ty * TILE
    const { sx, sy, sw, sh } = spriteSourceRect(sprite)
    const dw = sw * drawScale
    const dh = sh * drawScale
    const anchor = spriteAnchor(sprite)

    let dx
    let dy
    if (isAnimSprite(sprite)) {
        dx = px
        dy = py + TILE - dh
    } else {
        dx = px - dw * anchor.x
        dy = py - dh * anchor.y
    }

    targetCtx.drawImage(
        img,
        sx, sy, sw, sh,
        dx, dy, dw, dh
    )
}

function drawMissingTile(targetCtx, tx, ty, id) {
    const px = tx * TILE
    const py = ty * TILE
    targetCtx.fillStyle = "rgba(248, 113, 113, 0.45)"
    targetCtx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4)
    targetCtx.strokeStyle = "#f87171"
    targetCtx.lineWidth = 1
    targetCtx.strokeRect(px + 2, py + 2, TILE - 4, TILE - 4)
    targetCtx.fillStyle = "#fecaca"
    targetCtx.font = "8px monospace"
    targetCtx.fillText("?", px + 12, py + 20)
}

function collectLayerDraws(layer) {
    const draws = []
    const tilemap = getActiveTilemap()
    for (const [key, cell] of Object.entries(tilemap)) {
        const raw = cell[layer]
        if (!raw) continue
        const id = placementId(raw)
        if (!id) continue
        const { x, y } = parseKey(key)
        const sprite = getSpriteById(id)
        const placement = normalizePlacement(raw)
        const scale = placement?.scale ?? 1
        const px = x * TILE
        const py = y * TILE
        let sortKey
        if (layer === "object") {
            sortKey = py + TILE
        } else {
            sortKey = y * 100000 + x
        }
        draws.push({ x, y, id, sprite, sortKey, placement: raw, scale })
    }
    draws.sort((a, b) => a.sortKey - b.sortKey || a.x - b.x)
    return draws
}

function getBounds() {
    let minX = 0, minY = 0, maxX = 63, maxY = 74
    const tilemap = getActiveTilemap()
    for (const [key, cell] of Object.entries(tilemap)) {
        const { x, y } = parseKey(key)
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        for (const layer of ["floor", "above_floor", "object"]) {
            const raw = cell[layer]
            if (!raw) continue
            const id = placementId(raw)
            if (!id) continue
            const sprite = getSpriteById(id)
            if (!sprite) continue
            const scale = normalizePlacement(raw)?.scale ?? 1
            const drawScale = scale * animIntrinsicScale(sprite)
            const anchor = spriteAnchor(sprite)
            const topRows = Math.ceil((sprite.height * drawScale * anchor.y) / TILE)
            const rightCols = Math.ceil((sprite.width * drawScale * (1 - anchor.x)) / TILE)
            minY = Math.min(minY, y - topRows)
            maxX = Math.max(maxX, x + rightCols - 1)
        }
    }
    if (state.portalPreview) {
        minX = Math.min(minX, state.portalPreview.targetX - 2)
        minY = Math.min(minY, state.portalPreview.targetY - 2)
        maxX = Math.max(maxX, state.portalPreview.targetX + 2)
        maxY = Math.max(maxY, state.portalPreview.targetY + 2)
    } else {
        minX = Math.min(minX, state.spawnpoint.x - 2)
        minY = Math.min(minY, state.spawnpoint.y - 2)
        maxX = Math.max(maxX, state.spawnpoint.x + 2)
        maxY = Math.max(maxY, state.spawnpoint.y + 2)
    }
    return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function resizeCanvas() {
    canvas.width = wrap.clientWidth
    canvas.height = wrap.clientHeight
    draw()
}

function screenToTile(sx, sy) {
    const x = Math.floor((sx - state.panX) / (TILE * state.zoom))
    const y = Math.floor((sy - state.panY) / (TILE * state.zoom))
    return { x, y }
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.translate(state.panX, state.panY)
    ctx.scale(state.zoom, state.zoom)

    const bounds = getBounds()
    const pad = 4
    const startX = bounds.minX - pad
    const startY = bounds.minY - pad
    const endX = bounds.maxX + pad
    const endY = bounds.maxY + pad

    ctx.fillStyle = "#2d3748"
    ctx.fillRect(startX * TILE, startY * TILE, (endX - startX + 1) * TILE, (endY - startY + 1) * TILE)

    ctx.strokeStyle = "rgba(255,255,255,0.06)"
    ctx.lineWidth = 1 / state.zoom
    for (let x = startX; x <= endX + 1; x++) {
        ctx.beginPath()
        ctx.moveTo(x * TILE, startY * TILE)
        ctx.lineTo(x * TILE, (endY + 1) * TILE)
        ctx.stroke()
    }
    for (let y = startY; y <= endY + 1; y++) {
        ctx.beginPath()
        ctx.moveTo(startX * TILE, y * TILE)
        ctx.lineTo((endX + 1) * TILE, y * TILE)
        ctx.stroke()
    }

    // Draw in separate passes like the game: floor → above_floor → object (Y-sorted)
    for (const layer of ["floor", "above_floor", "object"]) {
        for (const item of collectLayerDraws(layer)) {
            if (item.sprite) {
                drawSpriteOnCtx(ctx, item.sprite, item.x, item.y, item.placement)
            } else {
                drawMissingTile(ctx, item.x, item.y, item.id)
            }
        }
    }

    if (state.selectedPlacement) {
        const { key, layer } = state.selectedPlacement
        const cell = state.tilemap[key]
        const raw = cell?.[layer]
        const id = placementId(raw)
        if (id) {
            const { x, y } = parseKey(key)
            const sprite = getSpriteById(id)
            const scale = normalizePlacement(raw)?.scale ?? 1
            const drawScale = scale * animIntrinsicScale(sprite)
            const anchor = spriteAnchor(sprite)
            const dw = (sprite?.width || TILE) * drawScale
            const dh = (sprite?.height || TILE) * drawScale
            let dx
            let dy
            if (isAnimSprite(sprite)) {
                dx = x * TILE
                dy = y * TILE + TILE - dh
            } else {
                dx = x * TILE - dw * anchor.x
                dy = y * TILE - dh * anchor.y
            }
            ctx.strokeStyle = "#5b9cff"
            ctx.lineWidth = 2 / state.zoom
            ctx.setLineDash([4 / state.zoom, 3 / state.zoom])
            ctx.strokeRect(dx, dy, dw, dh)
            ctx.setLineDash([])

            if (sprite.colliders?.length) {
                ctx.fillStyle = "rgba(248, 113, 113, 0.35)"
                ctx.strokeStyle = "rgba(248, 113, 113, 0.7)"
                ctx.lineWidth = 1 / state.zoom
                for (const tile of scaledColliderWorldTiles(x, y, sprite, scale)) {
                    ctx.fillRect(tile.x * TILE, tile.y * TILE, TILE, TILE)
                    ctx.strokeRect(tile.x * TILE + 0.5, tile.y * TILE + 0.5, TILE - 1, TILE - 1)
                }
            }
        }
    }

    if (!state.portalPreview) {
        const sx = state.spawnpoint.x
        const sy = state.spawnpoint.y
        ctx.fillStyle = "rgba(250, 204, 21, 0.35)"
        ctx.fillRect(sx * TILE, sy * TILE, TILE, TILE)
        ctx.strokeStyle = "#facc15"
        ctx.lineWidth = 2 / state.zoom
        ctx.strokeRect(sx * TILE + 1, sy * TILE + 1, TILE - 2, TILE - 2)
        ctx.fillStyle = "#facc15"
        ctx.font = `${10 / state.zoom}px sans-serif`
        ctx.fillText("★", sx * TILE + 10, sy * TILE + 20)
    }

    if (!state.portalPreview) drawInteractionMarkers(ctx)
    if (!state.portalPreview) drawNpcPaths(ctx)
    if (!state.portalPreview) drawMapBoundary(ctx)
    drawPortalPreviewOverlay(ctx)
    if (state.tool === "boundaries") drawMapNameBanner(ctx)

    ctx.restore()
    updateMapNameOverlay()
}

function drawInteractionMarkers(targetCtx) {
    const selected = state.tool === "portals" ? getSelectedPortalConnection() : null
    const selectedKeys = new Set()
    if (selected) {
        const { enter, exit } = selected
        if (enter.sourceRoomIndex === state.roomIndex) selectedKeys.add(enter.sourceKey)
        if (exit?.roomIndex === state.roomIndex && exit.key) selectedKeys.add(exit.key)
    }

    for (const [key, cell] of Object.entries(state.tilemap)) {
        const interaction = cell.interaction
        const hasPortal = !!interaction?.portal?.mapId
        if (!interaction?.title && !interaction?.message && !hasPortal) continue
        const { x, y } = parseKey(key)
        const px = x * TILE + TILE / 2
        const py = y * TILE + 6 / state.zoom
        const isSelected = selectedKeys.has(key)
        if (isSelected) {
            targetCtx.strokeStyle = "#facc15"
            targetCtx.lineWidth = 2 / state.zoom
            targetCtx.beginPath()
            targetCtx.arc(px, py, 9 / state.zoom, 0, Math.PI * 2)
            targetCtx.stroke()
        }
        targetCtx.fillStyle = hasPortal ? "rgba(167, 139, 250, 0.9)" : "rgba(96, 165, 250, 0.85)"
        targetCtx.beginPath()
        targetCtx.arc(px, py, 5 / state.zoom, 0, Math.PI * 2)
        targetCtx.fill()
        targetCtx.fillStyle = hasPortal ? "#ede9fe" : "#dbeafe"
        targetCtx.font = `${9 / state.zoom}px sans-serif`
        targetCtx.textAlign = "center"
        targetCtx.fillText(hasPortal ? "🌀" : "💬", px, py + 3 / state.zoom)
        targetCtx.textAlign = "left"
    }
}

function drawNpcPaths(targetCtx) {
    state.npcs.forEach((npc, idx) => {
        const color = idx === state.selectedNpcIndex ? "#facc15" : "#a78bfa"
        const path = npc.path || []
        if (path.length > 1) {
            targetCtx.strokeStyle = color
            targetCtx.lineWidth = 2 / state.zoom
            targetCtx.setLineDash([5 / state.zoom, 4 / state.zoom])
            targetCtx.beginPath()
            path.forEach((pt, i) => {
                const px = pt.x * TILE + TILE / 2
                const py = pt.y * TILE + TILE / 2
                if (i === 0) targetCtx.moveTo(px, py)
                else targetCtx.lineTo(px, py)
            })
            if (npc.loop !== false && path.length > 2) {
                const first = path[0]
                targetCtx.lineTo(first.x * TILE + TILE / 2, first.y * TILE + TILE / 2)
            }
            targetCtx.stroke()
            targetCtx.setLineDash([])
        }
        path.forEach((pt, i) => {
            const px = pt.x * TILE + TILE / 2
            const py = pt.y * TILE + TILE / 2
            targetCtx.fillStyle = i === 0 ? "#22c55e" : color
            targetCtx.beginPath()
            targetCtx.arc(px, py, (i === 0 ? 6 : 4) / state.zoom, 0, Math.PI * 2)
            targetCtx.fill()
        })
        if (path[0]) {
            targetCtx.fillStyle = "#f8fafc"
            targetCtx.font = `${9 / state.zoom}px sans-serif`
            targetCtx.fillText(npc.name || npc.id, path[0].x * TILE + 2, path[0].y * TILE - 4 / state.zoom)
        }
    })
}

function placeTile(x, y, layer, spriteId, scale = state.paintScale) {
    const key = tileKey(x, y)
    if (!state.tilemap[key]) state.tilemap[key] = {}
    const sprite = getSpriteById(spriteId)
    const placementScale = isAnimSprite(sprite) ? 1 : (scale ?? 1)
    state.tilemap[key][layer] = compactPlacement({ id: spriteId, scale: placementScale })
    state.selectedPlacement = { key, layer }
    updatePlacementEditor()
}

function eraseTile(x, y, layer) {
    const key = tileKey(x, y)
    const cell = state.tilemap[key]
    if (!cell) return
    delete cell[layer]
    if (Object.keys(cell).length === 0) delete state.tilemap[key]
    if (state.selectedPlacement?.key === key && state.selectedPlacement?.layer === layer) {
        state.selectedPlacement = null
        updatePlacementEditor()
    }
}

function pickTile(x, y) {
    const key = tileKey(x, y)
    const cell = state.tilemap[key]
    if (!cell) {
        state.selectedPlacement = null
        updatePlacementEditor()
        return
    }
    for (const layer of ["object", "above_floor", "floor"]) {
        const raw = cell[layer]
        const id = placementId(raw)
        if (id) {
            const sprite = getSpriteById(id)
            if (sprite) {
                const sheetChanged = sprite.sheet !== state.selectedSheet
                state.selectedLayer = layer
                state.selectedSheet = sprite.sheet
                state.selectedSprite = sprite
                state.selectedPlacement = { key, layer }
                state.paintScale = normalizePlacement(raw)?.scale ?? (isAnimSprite(sprite) ? 1 : sprite.defaultScale ?? 1)
                syncLayerTabs()
                renderSheetTabs()
                if (sheetChanged) {
                    renderSpriteGrid({ scrollToSelected: true })
                } else {
                    updateSpriteSelection()
                }
                updateSelectedPreview()
                updatePlacementEditor()
                if (state.tool === "message") {
                    state.selectedMessageTile = key
                    updateMessageEditor()
                }
                return
            }
        }
    }
}

function applyTool(x, y) {
    if (state.portalPreview) return

    if (applyPortalPick(x, y)) return

    if (state.tool === "spawn") {
        state.spawnpoint.x = x
        state.spawnpoint.y = y
        updateStats()
        draw()
        return
    }

    if (state.tool === "map-boundary") {
        addMapBoundaryPoint(x, y)
        draw()
        return
    }

    if (state.tool === "message") {
        selectMessageTile(x, y)
        draw()
        return
    }

    if (state.tool === "portals") {
        const key = tileKey(x, y)
        if (!tileHasPlacement(key)) {
            showToast("No sprite here — place a tile first", true)
            return
        }
        if (!getInteraction(key)?.portal?.mapId) {
            showToast("Click a portal marker (🌀) on the map", true)
            return
        }
        focusPortalConnectionAt(state.roomIndex, key)
        draw()
        return
    }

    if (state.tool === "npc") {
        addNpcWaypoint(x, y)
        draw()
        return
    }

    if (state.tool === "pick") {
        pickTile(x, y)
        draw()
        return
    }

    if (state.tool === "erase") {
        eraseTile(x, y, state.selectedLayer)
        updateStats()
        draw()
        return
    }

    if (state.tool === "paint") {
        if (!state.selectedSprite) {
            showToast("Select a sprite from the palette first", true)
            return
        }
        placeTile(x, y, state.selectedLayer, state.selectedSprite.id)
        updateStats()
        draw()
    }
}

function handlePaint(x, y) {
    const key = `${x},${y},${state.tool}`
    if (state.lastTile === key) return
    state.lastTile = key
    applyTool(x, y)
}

function showToast(msg, isError = false) {
    const el = document.getElementById("toast")
    el.textContent = msg
    el.classList.remove("hidden", "error")
    if (isError) el.classList.add("error")
    clearTimeout(showToast._t)
    showToast._t = setTimeout(() => el.classList.add("hidden"), 4000)
}

function updateStats() {
    document.getElementById("stat-tiles").textContent = Object.keys(state.tilemap).length
    document.getElementById("stat-spawn").textContent = `${state.spawnpoint.x}, ${state.spawnpoint.y}`
}

function getSheetMeta(sheetName) {
    return state.catalog?.sheets.find((s) => s.name === sheetName) || null
}

function spritePreviewScale(sprite, maxSize) {
    return maxSize / Math.max(sprite.width, sprite.height, 1)
}

function createSpritePreviewEl(sprite, maxSize = 52) {
    const el = document.createElement("div")
    el.className = "sprite-preview"

    if (sprite.url) {
        const { sx, sy, sw, sh } = spriteSourceRect(sprite)
        const intrinsic = animIntrinsicScale(sprite)
        const displayW = sw * intrinsic
        const displayH = sh * intrinsic
        const scale = spritePreviewScale({ width: displayW, height: displayH }, maxSize)
        const w = Math.max(1, Math.round(displayW * scale))
        const h = Math.max(1, Math.round(displayH * scale))
        const imgW = sprite.imageWidth ?? sw
        const imgH = sprite.imageHeight ?? sh
        el.style.width = `${w}px`
        el.style.height = `${h}px`
        el.style.backgroundImage = `url(${sprite.url})`
        el.style.backgroundSize = `${imgW * scale * intrinsic}px ${imgH * scale * intrinsic}px`
        el.style.backgroundPosition = `-${sx * scale * intrinsic}px -${sy * scale * intrinsic}px`
        el.style.backgroundRepeat = "no-repeat"
        el.style.imageRendering = "pixelated"
        return el
    }

    const sheet = getSheetMeta(sprite.sheet)
    if (!sheet || !getSheetImage(sprite.sheet)) return el

    const scale = spritePreviewScale(sprite, maxSize)
    const w = Math.max(1, Math.round(sprite.width * scale))
    const h = Math.max(1, Math.round(sprite.height * scale))

    el.style.width = `${w}px`
    el.style.height = `${h}px`
    el.style.backgroundImage = `url(${sheet.url})`
    el.style.backgroundPosition = `-${sprite.x * scale}px -${sprite.y * scale}px`
    el.style.backgroundSize = `${sheet.width * scale}px ${sheet.height * scale}px`
    return el
}

function updateSelectedPreview() {
    const el = document.getElementById("selected-preview")
    if (!state.selectedSprite) {
        el.innerHTML = '<div class="preview-empty">Select a sprite</div>'
        return
    }
    const s = state.selectedSprite
    const preview = createSpritePreviewEl(s, 88)
    const wrap = document.createElement("div")
    wrap.className = "preview-content"
    wrap.appendChild(preview)
    const name = document.createElement("div")
    name.className = "name"
    name.textContent = s.id
    wrap.appendChild(name)
    el.replaceChildren(wrap)
}

function layerBadgeLabel(layer) {
    if (layer === "floor") return "F"
    if (layer === "above_floor") return "A"
    if (layer === "object") return "O"
    return "?"
}

function syncLayerTabs() {
    document.querySelectorAll(".layer-tab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.layer === state.selectedLayer)
    })
}

function updateSpriteSelection() {
    document.querySelectorAll(".sprite-item").forEach((item) => {
        item.classList.toggle("selected", item.dataset.spriteId === state.selectedSprite?.id)
    })
}

function selectSprite(sprite) {
    state.selectedSprite = sprite
    state.selectedLayer = sprite.layer || "floor"
    state.selectedPlacement = null
    state.paintScale = isAnimSprite(sprite) ? 1 : (sprite.defaultScale ?? 1)
    const keepTool = new Set(["boundaries", "npc", "avatars", "animals", "animations", "gear-items", "map-boundary"])
    if (!keepTool.has(state.tool)) {
        state.tool = "paint"
    }
    syncLayerTabs()
    syncTools()
    updateSpriteSelection()
    updateSelectedPreview()
    updatePlacementEditor()
    if (state.tool === "boundaries") {
        loadBoundaryEditor(sprite)
    }
}

function updatePlacementEditor() {
    const paintProps = document.getElementById("paint-props")
    const placementProps = document.getElementById("placement-props")
    const paintScaleInput = document.getElementById("paint-scale")

    paintScaleInput.value = String(state.paintScale)

    if (state.tool === "boundaries" || state.tool === "message" || state.tool === "npc" || state.tool === "avatars") {
        paintProps.classList.add("hidden")
        placementProps.classList.add("hidden")
        if (state.tool === "message") updateMessageEditor()
        if (state.tool === "npc") updateNpcEditor()
        if (state.tool === "avatars") renderAvatarCostGrid()
        return
    }

    if (!state.selectedPlacement) {
        placementProps.classList.add("hidden")
        paintProps.classList.toggle("hidden", !state.selectedSprite)
        return
    }

    const { key, layer } = state.selectedPlacement
    const raw = state.tilemap[key]?.[layer]
    const placement = normalizePlacement(raw)
    if (!placement) {
        state.selectedPlacement = null
        placementProps.classList.add("hidden")
        paintProps.classList.toggle("hidden", !state.selectedSprite)
        return
    }

    const { x, y } = parseKey(key)
    paintProps.classList.add("hidden")
    placementProps.classList.remove("hidden")
    document.getElementById("prop-tile-x").value = String(x)
    document.getElementById("prop-tile-y").value = String(y)
    document.getElementById("prop-scale").value = String(placement.scale)
    document.getElementById("prop-sprite-id").textContent = `${placement.id} · ${layer}`
}

function applyPlacementCoordinates(newX, newY) {
    if (!state.selectedPlacement) return
    const { key, layer } = state.selectedPlacement
    const { x, y } = parseKey(key)
    if (x === newX && y === newY) return

    const cell = state.tilemap[key]
    const raw = cell?.[layer]
    if (!raw) return

    const newKey = tileKey(newX, newY)
    if (!state.tilemap[newKey]) state.tilemap[newKey] = {}
    state.tilemap[newKey][layer] = raw

    delete cell[layer]
    if (Object.keys(cell).length === 0) delete state.tilemap[key]

    state.selectedPlacement = { key: newKey, layer }
    updateStats()
    updatePlacementEditor()
    draw()
}

function applyPlacementScale(scale) {
    if (!state.selectedPlacement) return
    const safeScale = Math.min(Math.max(scale, 0.05), 10)
    const { key, layer } = state.selectedPlacement
    const cell = state.tilemap[key]
    const placement = normalizePlacement(cell?.[layer])
    if (!placement) return

    cell[layer] = compactPlacement({ id: placement.id, scale: safeScale })
    state.paintScale = safeScale
    draw()
}

function renderSheetTabs() {
    const el = document.getElementById("sheet-tabs")
    el.innerHTML = state.catalog.sheets.map((sheet) => `
        <button type="button" class="sheet-tab ${sheet.name === state.selectedSheet ? "active" : ""}" data-sheet="${sheet.name}">
            ${sheet.name}
        </button>
    `).join("")
    el.querySelectorAll(".sheet-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
            state.selectedSheet = btn.dataset.sheet
            renderSheetTabs()
            renderSpriteGrid({ preserveScroll: false })
        })
    })
}

function renderThumb(sprite) {
    return createSpritePreviewEl(sprite, 52)
}

function renderSpriteGrid(options = {}) {
    const grid = document.getElementById("sprite-grid")
    const savedScroll = options.preserveScroll !== false ? grid.scrollTop : 0
    const q = state.search.toLowerCase()
    const sprites = state.catalog.sprites.filter((s) => {
        if (s.sheet !== state.selectedSheet) return false
        if (q && !s.name.includes(q) && !s.id.includes(q)) return false
        return true
    })

    document.getElementById("sprite-count").textContent = sprites.length
    grid.innerHTML = ""

    if (sprites.length === 0) {
        grid.innerHTML = '<div class="sprite-grid-empty">No sprites found</div>'
        return
    }

    for (const sprite of sprites) {
        const item = document.createElement("button")
        item.type = "button"
        item.className = "sprite-item" + (state.selectedSprite?.id === sprite.id ? " selected" : "")
        item.dataset.spriteId = sprite.id
        item.title = `${sprite.id} (${sprite.layer})`
        item.draggable = true
        item.appendChild(renderThumb(sprite))
        const badge = document.createElement("span")
        badge.className = `layer-badge layer-${sprite.layer}`
        badge.textContent = layerBadgeLabel(sprite.layer)
        item.appendChild(badge)
        const label = document.createElement("span")
        label.className = "label"
        label.textContent = sprite.name.replace(/_/g, " ")
        item.appendChild(label)

        item.addEventListener("click", () => selectSprite(sprite))

        item.addEventListener("dragstart", (e) => {
            selectSprite(sprite)
            e.dataTransfer.setData("text/plain", sprite.id)
            e.dataTransfer.effectAllowed = "copy"
        })

        grid.appendChild(item)
    }

    if (options.scrollToSelected && state.selectedSprite) {
        const selected = grid.querySelector(`[data-sprite-id="${state.selectedSprite.id}"]`)
        if (selected) {
            selected.scrollIntoView({ block: "nearest" })
            return
        }
    }

    grid.scrollTop = savedScroll
}

const CHAR_SHEET = 192
const CHAR_FRAME = { x: 48, y: 0, w: 48, h: 48 }
const CHAR_THUMB_ZOOM = 1.05

function characterThumbStyle(skin) {
    const z = CHAR_THUMB_ZOOM
    return [
        `background-image:url(/sprites/characters/Character_${skin}.png)`,
        `background-size:${CHAR_SHEET * z}px ${CHAR_SHEET * z}px`,
        `background-position:-${CHAR_FRAME.x * z}px -${CHAR_FRAME.y * z}px`,
        `width:${Math.round(CHAR_FRAME.w * z)}px`,
        `height:${Math.round(CHAR_FRAME.h * z)}px`,
    ].join(";")
}

function animalThumbStyle(entry) {
    const z = (CHAR_FRAME.w * CHAR_THUMB_ZOOM) / entry.frameWidth
    const fx = entry.frameWidth
    const fy = 0
    return [
        `background-image:url(/sprites/animals/${entry.file})`,
        `background-size:${entry.width * z}px ${entry.height * z}px`,
        `background-position:-${fx * z}px -${fy * z}px`,
        `width:${Math.round(entry.frameWidth * z)}px`,
        `height:${Math.round(entry.frameHeight * z)}px`,
    ].join(";")
}

function npcSpriteThumbStyle(skin) {
    if (skin.startsWith("animal:")) {
        const id = skin.slice("animal:".length)
        const entry = state.animalSkins.find((animal) => animal.id === id)
        if (entry) return animalThumbStyle(entry)
    }
    return characterThumbStyle(skin)
}

function renderNpcSkinGrid(selectedSkin = "009") {
    const grid = document.getElementById("npc-skin-grid")
    if (!grid) return

    const charSkins = state.characterSkins.length ? state.characterSkins : ["009"]
    const animalSkins = state.animalSkins.map((entry) => entry.skin)
    const skins = [...charSkins, ...animalSkins]
    grid.innerHTML = skins.map((skin) => `
        <button type="button" class="npc-skin-item ${skin === selectedSkin ? "selected" : ""}" data-skin="${skin}" title="${skin}">
            <span class="npc-skin-thumb" style="${npcSpriteThumbStyle(skin)}"></span>
        </button>
    `).join("")

    document.getElementById("npc-skin").value = selectedSkin
}

async function loadCharacters() {
    try {
        const res = await fetch("/api/characters")
        const data = await res.json()
        state.characterSkins = data.skins || []
    } catch {
        state.characterSkins = ["009"]
    }
}

async function loadAnimals() {
    try {
        const res = await fetch("/api/animals")
        const data = await res.json()
        state.animalSkins = data.animals || []
        renderAnimalList()
    } catch {
        state.animalSkins = []
    }
}

async function loadAnimations() {
    try {
        const res = await fetch("/api/animations")
        const data = await res.json()
        state.animationSkins = data.animations || []
        if (state.tool === "animations") renderAnimationList()
    } catch {
        state.animationSkins = []
    }
}

function selectNpcSkin(skin) {
    const npc = getSelectedNpc()
    if (!npc) return
    pushHistory()
    npc.skin = skin
    document.getElementById("npc-skin").value = skin
    renderNpcSkinGrid(skin)
    draw()
}

async function loadAnimations() {
    try {
        const res = await fetch("/api/animations")
        const data = await res.json()
        state.animationSkins = data.animations || []
        if (state.tool === "animations") renderAnimationList()
    } catch {
        state.animationSkins = []
    }
}

async function loadGearItems() {
    try {
        const res = await fetch("/api/gear/items")
        const data = await res.json()
        state.gearItems = data.items || []
        if (state.tool === "gear-items") renderGearItemList()
    } catch {
        state.gearItems = []
    }
}

const GEAR_FACINGS = ["down", "left", "right", "up"]
/** Idle frame per direction (walk_*_1) — matches PlayerSpriteSheetData.ts */
const GEAR_CHAR_IDLE = {
    down: { x: 48, y: 0, w: 48, h: 48 },
    left: { x: 48, y: 48, w: 48, h: 48 },
    right: { x: 48, y: 96, w: 48, h: 48 },
    up: { x: 48, y: 144, w: 48, h: 48 },
}
const GEAR_ATTACH_ZOOM = 5
const GEAR_VIEW_THUMB_ZOOM = 2.2
/** Character frame size in game pixels — keep in sync with game-client/src/gearOverlay.ts */
const GEAR_CHAR_FRAME_PX = 48

function gearHandOffset(direction, bodyW, offsetX) {
    if (direction === "right") return bodyW * 0.22 + offsetX
    if (direction === "left") return -bodyW * 0.08 + offsetX
    return bodyW * 0.08 + offsetX
}

/** Layout in character-local pixels (matches in-game tool overlay). */
function computeGearOverlayLayout(direction, attach, frame) {
    const bodyW = GEAR_CHAR_FRAME_PX
    const bodyH = GEAR_CHAR_FRAME_PX
    const scale = attach.scale ?? 0.09
    const toolW = frame.w * scale
    const toolH = frame.h * scale
    const anchorX = attach.anchorX ?? 0.5
    const anchorY = attach.anchorY ?? 0.85
    const offsetX = attach.offsetX ?? 0
    const offsetY = attach.offsetY ?? 0
    const handX = gearHandOffset(direction, bodyW, offsetX)
    const handY = -bodyH * 0.05 + offsetY
    return {
        bodyW,
        bodyH,
        toolW,
        toolH,
        handX,
        handY,
        x: handX - toolW * anchorX,
        y: handY - toolH * anchorY,
    }
}

function gearItemThumbStyle(item) {
    const icon = item?.icon || ""
    if (!icon) return ""
    return [
        "background-image:url(" + icon + ")",
        "background-size:contain",
        "background-position:center",
        "background-repeat:no-repeat",
        "width:40px",
        "height:40px",
    ].join(";")
}

function defaultGearFacesFromItem(item) {
    const frame = gearItemFrame(item)
    const useFacings = item?.useFacings || ["left", "right"]
    const faces = {}
    for (const facing of GEAR_FACINGS) {
        const saved = item?.faces?.[facing] || {}
        const legacy = {
            offsetX: saved.offsetX ?? item?.sprite?.offsetX ?? 0,
            offsetY: saved.offsetY ?? item?.sprite?.offsetY ?? 0,
            scale: saved.scale ?? item?.sprite?.scale ?? 0.09,
            anchorX: saved.anchorX ?? item?.sprite?.anchorX ?? 0.5,
            anchorY: saved.anchorY ?? item?.sprite?.anchorY ?? 0.85,
        }
        const rect = normalizeGearRect(saved.rect) || rectFromLegacyAttach(facing, legacy, frame)
        faces[facing] = {
            eligible: saved.eligible !== undefined ? Boolean(saved.eligible) : useFacings.includes(facing),
            rect,
        }
    }
    return faces
}

function normalizeGearRect(raw) {
    if (!raw || !raw.w || !raw.h) return null
    return {
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        w: Math.max(0.5, Number(raw.w) || 1),
        h: Math.max(0.5, Number(raw.h) || 1),
    }
}

function rectFromLegacyAttach(direction, attach, frame) {
    const overlay = computeGearOverlayLayout(direction, attach, frame)
    return {
        x: overlay.x,
        y: overlay.y,
        w: overlay.toolW,
        h: overlay.toolH,
    }
}

function renderGearItemList() {
    const list = document.getElementById("gear-item-list")
    if (!list) return

    if (!state.gearItems.length) {
        list.innerHTML = `<p class="prop-meta">No gear items defined yet.</p>`
        return
    }

    const selected = state.gearAttachEditor.itemId
    list.innerHTML = state.gearItems.map((item) => `
        <div class="animal-list-item ${item.id === selected ? "selected" : ""}">
            <div class="animal-list-thumb" style="${gearItemThumbStyle(item)}"></div>
            <div class="animal-list-meta">
                <strong>${escapeHtml(item.label || item.id)}</strong>
                <span class="prop-meta">${escapeHtml(item.id)} · ${(item.useFacings || []).join(", ") || "no facings"}</span>
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-edit-gear-item="${escapeAttr(item.id)}">Edit attach</button>
        </div>
    `).join("")
}

function currentGearFace() {
    const editor = state.gearAttachEditor
    const face = editor.faces[editor.direction]
    if (face?.rect) return face
    return {
        eligible: false,
        rect: { x: 0, y: 0, w: 20, h: 14 },
    }
}

function syncGearFaceInputsFromState() {
    const editor = state.gearAttachEditor
    const face = currentGearFace()
    const rect = face.rect
    document.getElementById("gear-attach-active-view").textContent = `Editing: ${editor.direction}`
    document.getElementById("gear-face-eligible").checked = Boolean(face.eligible)
    document.getElementById("gear-rect-x").value = rect.x
    document.getElementById("gear-rect-y").value = rect.y
    document.getElementById("gear-rect-w").value = rect.w
    document.getElementById("gear-rect-h").value = rect.h
}

function readGearFaceInputsToState() {
    const editor = state.gearAttachEditor
    const face = currentGearFace()
    face.eligible = document.getElementById("gear-face-eligible").checked
    face.rect = {
        x: Number(document.getElementById("gear-rect-x").value || 0),
        y: Number(document.getElementById("gear-rect-y").value || 0),
        w: Math.max(0.5, Number(document.getElementById("gear-rect-w").value || 1)),
        h: Math.max(0.5, Number(document.getElementById("gear-rect-h").value || 1)),
    }
    editor.faces[editor.direction] = face
}

function renderGearAttachCharSkinSelect() {
    const select = document.getElementById("gear-attach-char-skin")
    if (!select) return
    const skins = state.characterSkins.length ? state.characterSkins : ["009"]
    const current = state.gearAttachEditor.charSkin || skins[0]
    select.innerHTML = skins.map((skin) => `
        <option value="${escapeAttr(skin)}" ${skin === current ? "selected" : ""}>${escapeHtml(skin)}</option>
    `).join("")
}

function renderGearAttachSidebar() {
    renderGearAttachCharSkinSelect()
    syncGearFaceInputsFromState()
}

function gearViewThumbStyle(direction) {
    const rect = GEAR_CHAR_IDLE[direction]
    if (!rect) return ""
    const z = GEAR_VIEW_THUMB_ZOOM
    return [
        `background-image:url(/sprites/characters/Character_${state.gearAttachEditor.charSkin || "009"}.png)`,
        `background-size:${192 * z}px ${192 * z}px`,
        `background-position:-${rect.x * z}px -${rect.y * z}px`,
        `width:${Math.round(rect.w * z)}px`,
        `height:${Math.round(rect.h * z)}px`,
    ].join(";")
}

function renderGearAttachViewsGrid() {
    const grid = document.getElementById("gear-attach-views-grid")
    const editor = state.gearAttachEditor
    if (!grid) return

    grid.innerHTML = GEAR_FACINGS.map((direction) => {
        const face = editor.faces[direction] || {}
        const selected = direction === editor.direction
        return `
            <div class="gear-view-card ${selected ? "selected" : ""} ${face.eligible ? "eligible" : ""}" data-gear-view="${direction}">
                <button type="button" class="gear-view-thumb-btn" data-gear-direction="${direction}" title="Edit ${direction} attach">
                    <span class="gear-view-thumb" style="${gearViewThumbStyle(direction)}"></span>
                    <span class="gear-view-label">${direction}</span>
                </button>
                <label class="gear-view-eligible">
                    <input type="checkbox" data-gear-eligible="${direction}" ${face.eligible ? "checked" : ""}>
                    Use eligible
                </label>
            </div>
        `
    }).join("")
}

async function loadGearAttachImages(item) {
    const sprite = item?.sprite || {}
    const file = sprite.file || "fish.png"
    const charSkin = state.gearAttachEditor.charSkin || state.characterSkins[0] || "009"

    const itemImg = new Image()
    itemImg.crossOrigin = "anonymous"
    itemImg.src = `/sprites/spritesheets/items/${file}?v=${Date.now()}`

    const charImg = new Image()
    charImg.crossOrigin = "anonymous"
    charImg.src = `/sprites/characters/Character_${charSkin}.png?v=${Date.now()}`

    await Promise.all([
        new Promise((resolve, reject) => {
            itemImg.onload = () => resolve()
            itemImg.onerror = () => reject(new Error("Could not load item sprite"))
        }),
        new Promise((resolve, reject) => {
            charImg.onload = () => resolve()
            charImg.onerror = () => reject(new Error("Could not load character sprite"))
        }),
    ])

    state.gearAttachEditor.itemImage = itemImg
    state.gearAttachEditor.charImage = charImg
}

function computeGearAttachCanvasLayout() {
    const canvas = document.getElementById("gear-attach-canvas")
    const wrap = canvas?.parentElement
    if (!canvas || !wrap) {
        return { zoom: GEAR_ATTACH_ZOOM, cx: 0, cy: 0, bodyW: 0, bodyH: 0, canvasW: 0, canvasH: 0 }
    }

    const canvasW = wrap.clientWidth
    const canvasH = wrap.clientHeight
    if (canvas.width !== canvasW || canvas.height !== canvasH) {
        canvas.width = canvasW
        canvas.height = canvasH
    }

    const zoom = GEAR_ATTACH_ZOOM
    const bodyW = GEAR_CHAR_FRAME_PX * zoom
    const bodyH = GEAR_CHAR_FRAME_PX * zoom
    const cx = canvasW / 2 - bodyW / 2
    const cy = canvasH / 2 - bodyH / 2

    return { zoom, cx, cy, bodyW, bodyH, canvasW, canvasH }
}

function gearItemFrame(item) {
    const sprite = item?.sprite || {}
    return {
        x: sprite.x || 0,
        y: sprite.y || 0,
        w: sprite.w || 1,
        h: sprite.h || 1,
    }
}

function gearToolDrawRect(layout, rect) {
    const z = layout.zoom
    return {
        x: layout.cx + rect.x * z,
        y: layout.cy + rect.y * z,
        w: rect.w * z,
        h: rect.h * z,
        rect,
    }
}

function drawGearAttachCanvas() {
    const editor = state.gearAttachEditor
    const canvas = document.getElementById("gear-attach-canvas")
    if (!canvas || !editor.open || !editor.item || !editor.charImage || !editor.itemImage) return

    const ctx = canvas.getContext("2d")
    const layout = computeGearAttachCanvasLayout()
    editor.canvasLayout = layout
    const direction = editor.direction
    const attach = currentGearFace()
    const rect = attach.rect
    const charFrame = GEAR_CHAR_IDLE[direction] || GEAR_CHAR_IDLE.left
    const sprite = editor.item.sprite || {}
    const frame = {
        x: sprite.x || 0,
        y: sprite.y || 0,
        w: sprite.w || 1,
        h: sprite.h || 1,
    }

    ctx.clearRect(0, 0, layout.canvasW, layout.canvasH)
    ctx.fillStyle = "#12151a"
    ctx.fillRect(0, 0, layout.canvasW, layout.canvasH)

    ctx.imageSmoothingEnabled = false
    ctx.drawImage(
        editor.charImage,
        charFrame.x, charFrame.y, charFrame.w, charFrame.h,
        layout.cx, layout.cy, layout.bodyW, layout.bodyH
    )

    const toolBox = gearToolDrawRect(layout, rect)
    if (!toolBox) return

    ctx.drawImage(
        editor.itemImage,
        frame.x, frame.y, frame.w, frame.h,
        toolBox.x, toolBox.y, toolBox.w, toolBox.h
    )

    ctx.strokeStyle = attach.eligible ? "#4ade80" : "#f87171"
    ctx.lineWidth = 2
    ctx.setLineDash([5, 4])
    ctx.strokeRect(toolBox.x + 0.5, toolBox.y + 0.5, toolBox.w - 1, toolBox.h - 1)
    ctx.setLineDash([])

    const hs = FRAME_HANDLE_SIZE
    const hx = toolBox.x + toolBox.w - hs / 2
    const hy = toolBox.y + toolBox.h - hs / 2
    ctx.fillStyle = "#facc15"
    ctx.strokeStyle = "#1a1d24"
    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs)
    ctx.strokeRect(hx - hs / 2 + 0.5, hy - hs / 2 + 0.5, hs - 1, hs - 1)
}

function resizeGearAttachCanvas() {
    state.gearAttachEditor.canvasLayout = null
    drawGearAttachCanvas()
}

function pointInRect(point, rect) {
    return (
        point.x >= rect.x &&
        point.x <= rect.x + rect.w &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.h
    )
}

function gearScaleHandlePoint(toolBox) {
    const hs = FRAME_HANDLE_SIZE
    return { x: toolBox.x + toolBox.w, y: toolBox.y + toolBox.h, r: hs / 2 }
}

function hitGearScaleHandle(point, toolBox) {
    const handle = gearScaleHandlePoint(toolBox)
    const dx = point.x - handle.x
    const dy = point.y - handle.y
    return Math.hypot(dx, dy) <= handle.r + 2
}

async function openGearAttachEditor(itemId) {
    const res = await fetch(`/api/gear/items/${encodeURIComponent(itemId)}`)
    const data = await res.json()
    if (!res.ok) {
        showToast(data.error || "Could not load gear item", true)
        return
    }

    const item = data
    state.gearAttachEditor = {
        open: true,
        itemId,
        item,
        direction: (item.useFacings && item.useFacings[0]) || "left",
        faces: defaultGearFacesFromItem(item),
        charImage: null,
        itemImage: null,
        charSkin: state.characterSkins[0] || "009",
        drag: null,
        canvasLayout: null,
    }

    const modal = document.getElementById("gear-attach-modal")
    modal?.classList.remove("hidden")
    modal?.setAttribute("aria-hidden", "false")
    document.getElementById("gear-attach-title").textContent = `${item.label || itemId} attach`

    try {
        await loadGearAttachImages(item)
        renderGearAttachSidebar()
        renderGearAttachViewsGrid()
        resizeGearAttachCanvas()
        renderGearItemList()
    } catch (err) {
        showToast(err.message || "Could not load preview images", true)
    }
}

function closeGearAttachEditor() {
    state.gearAttachEditor.open = false
    state.gearAttachEditor.drag = null
    const modal = document.getElementById("gear-attach-modal")
    modal?.classList.add("hidden")
    modal?.setAttribute("aria-hidden", "true")
}

async function saveGearAttachEditor() {
    const editor = state.gearAttachEditor
    if (!editor.itemId) return

    readGearFaceInputsToState()
    const useFacings = GEAR_FACINGS.filter((facing) => editor.faces[facing]?.eligible)
    const faces = {}
    for (const facing of GEAR_FACINGS) {
        const face = editor.faces[facing] || {}
        faces[facing] = {
            eligible: Boolean(face.eligible),
            rect: {
                x: face.rect?.x ?? 0,
                y: face.rect?.y ?? 0,
                w: face.rect?.w ?? 1,
                h: face.rect?.h ?? 1,
            },
        }
    }

    const res = await fetch(`/api/gear/items/${encodeURIComponent(editor.itemId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useFacings, faces }),
    })
    const data = await res.json()
    if (!res.ok) {
        showToast(data.error || "Could not save gear attach", true)
        return
    }

    const idx = state.gearItems.findIndex((entry) => entry.id === editor.itemId)
    if (idx >= 0) state.gearItems[idx] = data.item
    editor.item = data.item
    editor.faces = defaultGearFacesFromItem(data.item)
    renderGearAttachSidebar()
    renderGearAttachViewsGrid()
    drawGearAttachCanvas()
    renderGearItemList()
    showToast(data.message || "Gear attach saved")
}

function bindGearAttachEditor() {
    document.getElementById("gear-item-list")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-edit-gear-item]")
        if (!btn) return
        openGearAttachEditor(btn.dataset.editGearItem)
    })

    document.getElementById("gear-attach-char-skin")?.addEventListener("change", async (e) => {
        const skin = e.target.value
        if (!skin || !state.gearAttachEditor.open) return
        state.gearAttachEditor.charSkin = skin
        try {
            await loadGearAttachImages(state.gearAttachEditor.item)
            renderGearAttachViewsGrid()
            drawGearAttachCanvas()
        } catch (err) {
            showToast(err.message || "Could not load character skin", true)
        }
    })

    document.getElementById("btn-gear-attach-close")?.addEventListener("click", closeGearAttachEditor)
    document.getElementById("btn-gear-attach-save")?.addEventListener("click", () => {
        saveGearAttachEditor()
    })

    document.getElementById("gear-attach-views-grid")?.addEventListener("click", (e) => {
        const dirBtn = e.target.closest("[data-gear-direction]")
        if (dirBtn) {
            readGearFaceInputsToState()
            state.gearAttachEditor.direction = dirBtn.dataset.gearDirection
            renderGearAttachViewsGrid()
            syncGearFaceInputsFromState()
            drawGearAttachCanvas()
            return
        }
    })

    document.getElementById("gear-attach-views-grid")?.addEventListener("change", (e) => {
        const eligibleBox = e.target.closest("[data-gear-eligible]")
        if (!eligibleBox) return
        const direction = eligibleBox.dataset.gearEligible
        const face = state.gearAttachEditor.faces[direction]
        if (!face) return
        face.eligible = eligibleBox.checked
        renderGearAttachViewsGrid()
        if (direction === state.gearAttachEditor.direction) {
            syncGearFaceInputsFromState()
        }
        drawGearAttachCanvas()
    })

    document.getElementById("gear-face-eligible")?.addEventListener("change", () => {
        readGearFaceInputsToState()
        renderGearAttachViewsGrid()
        drawGearAttachCanvas()
    })

    for (const id of [
        "gear-rect-x",
        "gear-rect-y",
        "gear-rect-w",
        "gear-rect-h",
    ]) {
        document.getElementById(id)?.addEventListener("input", () => {
            readGearFaceInputsToState()
            drawGearAttachCanvas()
        })
    }

    const canvas = document.getElementById("gear-attach-canvas")
    canvas?.addEventListener("pointerdown", (e) => {
        const editor = state.gearAttachEditor
        if (!editor.open) return

        readGearFaceInputsToState()
        const layout = editor.canvasLayout || computeGearAttachCanvasLayout()
        const point = gearAttachCanvasPointFromEvent(e)
        const attach = currentGearFace()
        const rect = attach.rect
        const toolBox = gearToolDrawRect(layout, rect)
        if (!toolBox) return

        if (hitGearScaleHandle(point, toolBox)) {
            editor.drag = {
                pointerId: e.pointerId,
                mode: "scale",
                start: point,
                originW: rect.w,
                originH: rect.h,
                aspect: rect.h / Math.max(0.001, rect.w),
            }
            canvas.setPointerCapture(e.pointerId)
            return
        }

        if (pointInRect(point, toolBox)) {
            editor.drag = {
                pointerId: e.pointerId,
                mode: "move",
                start: point,
                originX: rect.x,
                originY: rect.y,
            }
            canvas.setPointerCapture(e.pointerId)
            canvas.style.cursor = "grabbing"
        }
    })

    canvas?.addEventListener("pointermove", (e) => {
        const editor = state.gearAttachEditor
        if (!editor.open) return

        const layout = editor.canvasLayout || computeGearAttachCanvasLayout()
        const point = gearAttachCanvasPointFromEvent(e)
        const attach = currentGearFace()
        const rect = attach.rect
        const toolBox = gearToolDrawRect(layout, rect)

        if (!editor.drag || editor.drag.pointerId !== e.pointerId) {
            if (toolBox && hitGearScaleHandle(point, toolBox)) {
                canvas.style.cursor = "nwse-resize"
            } else if (toolBox && pointInRect(point, toolBox)) {
                canvas.style.cursor = "grab"
            } else {
                canvas.style.cursor = "default"
            }
            return
        }

        if (editor.drag.mode === "move") {
            const dx = (point.x - editor.drag.start.x) / layout.zoom
            const dy = (point.y - editor.drag.start.y) / layout.zoom
            rect.x = editor.drag.originX + dx
            rect.y = editor.drag.originY + dy
            attach.rect = rect
            editor.faces[editor.direction] = attach
            syncGearFaceInputsFromState()
            drawGearAttachCanvas()
            return
        }

        if (editor.drag.mode === "scale") {
            const dxLogical = (point.x - editor.drag.start.x) / layout.zoom
            rect.w = Math.max(1, editor.drag.originW + dxLogical)
            rect.h = Math.max(1, rect.w * editor.drag.aspect)
            attach.rect = rect
            editor.faces[editor.direction] = attach
            syncGearFaceInputsFromState()
            drawGearAttachCanvas()
        }
    })

    const endGearDrag = (e) => {
        const editor = state.gearAttachEditor
        if (!editor.drag || editor.drag.pointerId !== e.pointerId) return
        editor.drag = null
        canvas?.releasePointerCapture(e.pointerId)
        if (canvas) canvas.style.cursor = "default"
    }
    canvas?.addEventListener("pointerup", endGearDrag)
    canvas?.addEventListener("pointercancel", endGearDrag)

    window.addEventListener("resize", () => {
        if (state.gearAttachEditor.open) resizeGearAttachCanvas()
    })
}

async function loadCatalog() {
    document.getElementById("loading-text").textContent = "Loading sprite catalog…"
    const res = await fetch("/api/sprites")
    state.catalog = await res.json()

    document.getElementById("loading-text").textContent = "Loading spritesheets…"
    const failed = []
    const sheetLoads = state.catalog.sheets
        .filter((sheet) => sheet.url)
        .map((sheet) => new Promise((resolve) => {
            const img = new Image()
            img.onload = () => {
                state.sheetImages[sheet.name] = img
                resolve()
            }
            img.onerror = () => {
                failed.push(sheet.name)
                resolve()
            }
            img.src = sheet.url
        }))

    const singleLoads = state.catalog.sprites
        .filter((sprite) => sprite.url)
        .map((sprite) => new Promise((resolve) => {
            const img = new Image()
            img.onload = () => {
                state.spriteImages[sprite.id] = img
                resolve()
            }
            img.onerror = () => {
                failed.push(sprite.id)
                resolve()
            }
            img.src = sprite.url
        }))

    await Promise.all([...sheetLoads, ...singleLoads])

    if (failed.length) {
        showToast(`Spritesheet failed to load: ${failed.join(", ")}`, true)
    }
}

function tierDefaultAvatarCost(skin) {
    if (skin === "009") return 0
    const n = Number(skin)
    if (n <= 5) return 0
    if (n <= 20) return 40
    if (n <= 40) return 80
    if (n <= 60) return 150
    return 250
}

function buildDefaultAvatarCosts(skins) {
    const costs = {}
    for (const skin of skins) {
        costs[skin] = tierDefaultAvatarCost(skin)
    }
    return costs
}

function mergeAvatarCosts(stored, skins) {
    const costs = buildDefaultAvatarCosts(skins.length ? skins : ["009"])
    if (stored && typeof stored === "object") {
        for (const skin of Object.keys(stored)) {
            const val = Number(stored[skin])
            if (Number.isFinite(val) && val >= 0) costs[skin] = Math.floor(val)
        }
    }
    return costs
}

function renderAvatarCostGrid() {
    const grid = document.getElementById("avatar-cost-grid")
    if (!grid) return
    const query = (document.getElementById("avatar-cost-search")?.value || "").trim().toLowerCase()
    const skins = state.characterSkins.length ? state.characterSkins : Object.keys(state.avatarCosts)
    const filtered = skins
        .filter((skin) => !query || skin.includes(query))
        .sort((a, b) => {
            const costA = state.avatarCosts[a] ?? tierDefaultAvatarCost(a)
            const costB = state.avatarCosts[b] ?? tierDefaultAvatarCost(b)
            if (costA !== costB) return costA - costB
            return a.localeCompare(b, undefined, { numeric: true })
        })

    grid.innerHTML = filtered.map((skin) => {
        const cost = state.avatarCosts[skin] ?? tierDefaultAvatarCost(skin)
        return `
            <label class="avatar-cost-item" data-skin="${skin}">
                <span class="avatar-cost-thumb" style="${characterThumbStyle(skin)}"></span>
                <span class="avatar-cost-id">${skin}</span>
                <input type="number" class="avatar-cost-input" data-skin="${skin}" min="0" max="99999" step="1" value="${cost}">
            </label>
        `
    }).join("")
}

function setAvatarCosts(costs) {
    state.avatarCosts = { ...costs }
    renderAvatarCostGrid()
}

async function loadMap() {
    document.getElementById("loading-text").textContent = "Loading current world map…"
    const res = await fetch("/api/map")
    if (!res.ok) return
    const data = await res.json()
    state.rooms = ensureRoomIds(data.rooms || [])
    if (!state.rooms.length) {
        state.rooms = [{ id: roomIdForIndex(0), name: DEFAULT_ROOM_NAME, tilemap: {}, npcs: [] }]
    }
    state.roomIndex = Math.min(data.spawnpoint?.roomIndex || 0, state.rooms.length - 1)
    state.spawnpoint = { ...data.spawnpoint }
    state.avatarCosts = mergeAvatarCosts(data.avatarCosts, state.characterSkins)
    loadRoomIntoEditor(state.roomIndex, { skipPersist: true, skipHistory: true })
    renderAvatarCostGrid()
}

async function saveMap() {
    persistCurrentRoom()
    syncPortalReturnLinks()
    const rooms = state.rooms.map((room, index) => {
        const payload = {
            id: getRoomId(room, index),
            name: getRoomDisplayName(room, index),
            tilemap: cloneTilemap(room.tilemap || {}),
        }
        if (room.channelId) payload.channelId = room.channelId
        if (room.npcs?.length) payload.npcs = cloneNpcs(room.npcs)
        if (room.mapBoundary?.length) payload.mapBoundary = cloneMapBoundary(room.mapBoundary)
        return payload
    })

    const avatarCosts = { ...state.avatarCosts }
    for (const input of document.querySelectorAll(".avatar-cost-input")) {
        const skin = input.dataset.skin
        if (!skin) continue
        const val = Math.max(0, Math.floor(Number(input.value) || 0))
        avatarCosts[skin] = val
    }
    state.avatarCosts = avatarCosts

    const payload = {
        spawnpoint: state.spawnpoint,
        rooms,
        avatarCosts,
    }
    const res = await fetch("/api/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!res.ok) {
        showToast(data.error || "Save failed", true)
        return
    }
    showToast(data.message || "Map saved! Re-enter the realm to load portal changes.")
}

function pointInPolygon(x, y, polygon) {
    if (polygon.length < 3) return false
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x + 0.5
        const yi = polygon[i].y + 0.5
        const xj = polygon[j].x + 0.5
        const yj = polygon[j].y + 0.5
        const intersect = ((yi > y) !== (yj > y))
            && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi)
        if (intersect) inside = !inside
    }
    return inside
}

function tilesAlongSegment(a, b) {
    const keys = []
    let x0 = a.x
    let y0 = a.y
    const x1 = b.x
    const y1 = b.y
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    while (true) {
        keys.push(tileKey(x0, y0))
        if (x0 === x1 && y0 === y1) break
        const e2 = 2 * err
        if (e2 > -dy) {
            err -= dy
            x0 += sx
        }
        if (e2 < dx) {
            err += dx
            y0 += sy
        }
    }
    return keys
}

function computeMapBoundaryBlockedPreview(points) {
    const blocked = new Set()
    if (!points?.length) return blocked

    for (let i = 0; i < points.length - 1; i++) {
        for (const key of tilesAlongSegment(points[i], points[i + 1])) {
            blocked.add(key)
        }
    }

    if (points.length >= 3) {
        for (const key of tilesAlongSegment(points[points.length - 1], points[0])) {
            blocked.add(key)
        }

        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        const grow = (x, y) => {
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
        }
        for (const p of points) grow(p.x, p.y)
        for (const key of Object.keys(state.tilemap)) {
            const { x, y } = parseKey(key)
            grow(x, y)
        }
        grow(state.spawnpoint.x, state.spawnpoint.y)
        const margin = 60
        minX -= margin
        minY -= margin
        maxX += margin
        maxY += margin

        for (let tx = minX; tx <= maxX; tx++) {
            for (let ty = minY; ty <= maxY; ty++) {
                if (!pointInPolygon(tx + 0.5, ty + 0.5, points)) {
                    blocked.add(tileKey(tx, ty))
                }
            }
        }
    }

    return blocked
}

function addMapBoundaryPoint(x, y) {
    const last = state.mapBoundary[state.mapBoundary.length - 1]
    if (last && last.x === x && last.y === y) return
    state.mapBoundary.push({ x, y })
    updateMapBoundaryEditor()
}

function undoMapBoundaryPoint() {
    state.mapBoundary.pop()
    updateMapBoundaryEditor()
    draw()
}

function clearMapBoundary() {
    state.mapBoundary = []
    updateMapBoundaryEditor()
    draw()
}

function updateMapBoundaryEditor() {
    const countEl = document.getElementById("map-boundary-point-count")
    const tileEl = document.getElementById("map-boundary-tile-count")
    const points = state.mapBoundary || []
    const blocked = computeMapBoundaryBlockedPreview(points)
    if (countEl) countEl.textContent = String(points.length)
    if (tileEl) tileEl.textContent = String(blocked.size)
}

function drawMapBoundary(targetCtx) {
    const points = state.mapBoundary || []
    if (!points.length) return

    const blocked = computeMapBoundaryBlockedPreview(points)
    if (blocked.size && points.length >= 3) {
        targetCtx.fillStyle = "rgba(248, 113, 113, 0.12)"
        for (const key of blocked) {
            const { x, y } = parseKey(key)
            if (pointInPolygon(x + 0.5, y + 0.5, points)) continue
            targetCtx.fillRect(x * TILE, y * TILE, TILE, TILE)
        }
    }

    if (points.length >= 2) {
        targetCtx.strokeStyle = "rgba(251, 146, 60, 0.95)"
        targetCtx.lineWidth = 3 / state.zoom
        targetCtx.setLineDash([8 / state.zoom, 5 / state.zoom])
        targetCtx.beginPath()
        points.forEach((pt, i) => {
            const px = pt.x * TILE + TILE / 2
            const py = pt.y * TILE + TILE / 2
            if (i === 0) targetCtx.moveTo(px, py)
            else targetCtx.lineTo(px, py)
        })
        if (points.length >= 3) {
            const first = points[0]
            targetCtx.lineTo(first.x * TILE + TILE / 2, first.y * TILE + TILE / 2)
        }
        targetCtx.stroke()
        targetCtx.setLineDash([])
    }

    for (const pt of points) {
        const px = pt.x * TILE + TILE / 2
        const py = pt.y * TILE + TILE / 2
        targetCtx.fillStyle = "#fb923c"
        targetCtx.beginPath()
        targetCtx.arc(px, py, 5 / state.zoom, 0, Math.PI * 2)
        targetCtx.fill()
        targetCtx.strokeStyle = "#1a1d24"
        targetCtx.lineWidth = 2 / state.zoom
        targetCtx.stroke()
    }
}

function collidersFromBoundary(boundary, width, height) {
    const cols = Math.max(1, Math.ceil(width / TILE))
    const rows = Math.max(1, Math.ceil(height / TILE))
    const colliders = []
    for (let ty = 0; ty < rows; ty++) {
        for (let tx = 0; tx < cols; tx++) {
            if (pointInPolygon(tx + 0.5, ty + 0.5, boundary)) {
                colliders.push({ x: tx, y: ty })
            }
        }
    }
    return colliders
}

function convexHullFromColliders(colliders) {
    if (!colliders?.length) return []
    const points = colliders.map((c) => ({ x: c.x, y: c.y }))
    points.sort((a, b) => a.x - b.x || a.y - b.y)

    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
    const lower = []
    for (const p of points) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop()
        }
        lower.push(p)
    }
    const upper = []
    for (let i = points.length - 1; i >= 0; i--) {
        const p = points[i]
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop()
        }
        upper.push(p)
    }
    lower.pop()
    upper.pop()
    return lower.concat(upper)
}

function refreshBoundaryPreview() {
    const sprite = state.selectedSprite
    if (!sprite) {
        state.boundaryColliders = []
        return
    }
    state.boundaryColliders = state.boundaryPoints.length >= 3
        ? collidersFromBoundary(state.boundaryPoints, sprite.width, sprite.height)
        : []
    document.getElementById("boundary-point-count").textContent = state.boundaryPoints.length
    document.getElementById("boundary-tile-count").textContent = state.boundaryColliders.length
}

function boundaryLayout(sprite) {
    const maxW = Math.max(120, boundaryWrap.clientWidth - 32)
    const maxH = Math.max(120, boundaryWrap.clientHeight - 96)
    const scale = Math.min(1, maxW / sprite.width, maxH / sprite.height)
    return {
        scale,
        drawW: sprite.width * scale,
        drawH: sprite.height * scale,
        offsetX: (boundaryCanvas.width - sprite.width * scale) / 2,
        offsetY: (boundaryCanvas.height - sprite.height * scale) / 2,
    }
}

function resizeBoundaryCanvas() {
    if (state.tool !== "boundaries") return
    boundaryCanvas.width = boundaryWrap.clientWidth - 24
    boundaryCanvas.height = Math.max(200, boundaryWrap.clientHeight - 88)
    drawBoundaryEditor()
}

function drawBoundaryEditor() {
    if (state.tool !== "boundaries") return
    const sprite = state.selectedSprite
    boundaryCtx.clearRect(0, 0, boundaryCanvas.width, boundaryCanvas.height)
    boundaryCtx.fillStyle = "#1e222a"
    boundaryCtx.fillRect(0, 0, boundaryCanvas.width, boundaryCanvas.height)

    if (!sprite?.url) {
        boundaryCtx.fillStyle = "#9aa3b5"
        boundaryCtx.font = "14px sans-serif"
        boundaryCtx.textAlign = "center"
        boundaryCtx.fillText(
            sprite ? "Boundary editing works on single sprites only" : "Select a single sprite from the palette",
            boundaryCanvas.width / 2,
            boundaryCanvas.height / 2
        )
        return
    }

    const img = state.spriteImages[sprite.id]
    if (!img) return

    const layout = boundaryLayout(sprite)
    boundaryCtx.imageSmoothingEnabled = false
    boundaryCtx.drawImage(img, layout.offsetX, layout.offsetY, layout.drawW, layout.drawH)

    const gridStep = TILE * layout.scale
    boundaryCtx.strokeStyle = "rgba(255,255,255,0.08)"
    boundaryCtx.lineWidth = 1
    for (let x = layout.offsetX; x <= layout.offsetX + layout.drawW; x += gridStep) {
        boundaryCtx.beginPath()
        boundaryCtx.moveTo(x, layout.offsetY)
        boundaryCtx.lineTo(x, layout.offsetY + layout.drawH)
        boundaryCtx.stroke()
    }
    for (let y = layout.offsetY; y <= layout.offsetY + layout.drawH; y += gridStep) {
        boundaryCtx.beginPath()
        boundaryCtx.moveTo(layout.offsetX, y)
        boundaryCtx.lineTo(layout.offsetX + layout.drawW, y)
        boundaryCtx.stroke()
    }

    for (const tile of state.boundaryColliders) {
        boundaryCtx.fillStyle = "rgba(248, 113, 113, 0.35)"
        boundaryCtx.fillRect(
            layout.offsetX + tile.x * gridStep,
            layout.offsetY + tile.y * gridStep,
            gridStep,
            gridStep
        )
    }

    if (state.boundaryPoints.length >= 3) {
        boundaryCtx.fillStyle = "rgba(91, 156, 255, 0.18)"
        boundaryCtx.beginPath()
        for (let i = 0; i < state.boundaryPoints.length; i++) {
            const p = state.boundaryPoints[i]
            const px = layout.offsetX + (p.x + 0.5) * gridStep
            const py = layout.offsetY + (p.y + 0.5) * gridStep
            if (i === 0) boundaryCtx.moveTo(px, py)
            else boundaryCtx.lineTo(px, py)
        }
        boundaryCtx.closePath()
        boundaryCtx.fill()
    }

    if (state.boundaryPoints.length >= 2) {
        boundaryCtx.strokeStyle = "#5b9cff"
        boundaryCtx.lineWidth = 2
        boundaryCtx.beginPath()
        for (let i = 0; i < state.boundaryPoints.length; i++) {
            const p = state.boundaryPoints[i]
            const px = layout.offsetX + (p.x + 0.5) * gridStep
            const py = layout.offsetY + (p.y + 0.5) * gridStep
            if (i === 0) boundaryCtx.moveTo(px, py)
            else boundaryCtx.lineTo(px, py)
        }
        if (state.boundaryPoints.length >= 3) {
            const first = state.boundaryPoints[0]
            boundaryCtx.lineTo(
                layout.offsetX + (first.x + 0.5) * gridStep,
                layout.offsetY + (first.y + 0.5) * gridStep
            )
        }
        boundaryCtx.stroke()
    }

    for (const p of state.boundaryPoints) {
        const px = layout.offsetX + (p.x + 0.5) * gridStep
        const py = layout.offsetY + (p.y + 0.5) * gridStep
        boundaryCtx.fillStyle = "#facc15"
        boundaryCtx.beginPath()
        boundaryCtx.arc(px, py, 5, 0, Math.PI * 2)
        boundaryCtx.fill()
        boundaryCtx.strokeStyle = "#1a1d24"
        boundaryCtx.lineWidth = 2
        boundaryCtx.stroke()
    }
}

async function loadBoundaryEditor(sprite = state.selectedSprite) {
    if (!sprite) {
        state.boundaryPoints = []
        state.boundaryColliders = []
        document.getElementById("boundary-sprite-label").textContent = "Select a single sprite"
        refreshBoundaryPreview()
        resizeBoundaryCanvas()
        return
    }

    document.getElementById("boundary-sprite-label").textContent = sprite.id
    document.getElementById("boundary-save-path").textContent = `${sprite.name}.json`

    if (!sprite.url) {
        state.boundaryPoints = []
        state.boundaryColliders = []
        refreshBoundaryPreview()
        resizeBoundaryCanvas()
        return
    }

    try {
        const res = await fetch(`/api/sprite-meta/${sprite.id}`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || "Failed to load sprite meta")
        const meta = data.meta || {}
        let points = Array.isArray(meta.boundary) ? meta.boundary.map((p) => ({ x: p.x, y: p.y })) : []
        if (!points.length && meta.colliders?.length) {
            points = convexHullFromColliders(meta.colliders)
        }
        state.boundaryPoints = points
        sprite.colliders = meta.colliders || sprite.colliders || []
        sprite.boundary = points
        refreshBoundaryPreview()
        resizeBoundaryCanvas()
    } catch (err) {
        showToast(err.message, true)
    }
}

function boundaryPointerToTile(e) {
    const sprite = state.selectedSprite
    if (!sprite?.url) return null
    const rect = boundaryCanvas.getBoundingClientRect()
    const layout = boundaryLayout(sprite)
    const px = (e.clientX - rect.left - layout.offsetX) / layout.scale
    const py = (e.clientY - rect.top - layout.offsetY) / layout.scale
    if (px < 0 || py < 0 || px > sprite.width || py > sprite.height) return null
    return { x: Math.floor(px / TILE), y: Math.floor(py / TILE) }
}

function addBoundaryPoint(tile) {
    const last = state.boundaryPoints[state.boundaryPoints.length - 1]
    if (last && last.x === tile.x && last.y === tile.y) return
    state.boundaryPoints.push(tile)
    refreshBoundaryPreview()
    drawBoundaryEditor()
}

function undoBoundaryPoint() {
    state.boundaryPoints.pop()
    refreshBoundaryPreview()
    drawBoundaryEditor()
}

function clearBoundaryPoints() {
    state.boundaryPoints = []
    refreshBoundaryPreview()
    drawBoundaryEditor()
}

async function saveBoundary() {
    const sprite = state.selectedSprite
    if (!sprite?.url) {
        showToast("Select a single sprite first", true)
        return
    }
    if (state.boundaryPoints.length < 3) {
        showToast("Add at least 3 points to form a boundary", true)
        return
    }

    const res = await fetch(`/api/sprite-meta/${sprite.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            boundary: state.boundaryPoints,
            layer: sprite.layer,
            scale: sprite.defaultScale ?? 1,
        }),
    })
    const data = await res.json()
    if (!res.ok) {
        showToast(data.error || "Save failed", true)
        return
    }

    sprite.colliders = data.colliders
    sprite.boundary = [...state.boundaryPoints]
    state.boundaryColliders = data.colliders
    refreshBoundaryPreview()
    drawBoundaryEditor()
    showToast(data.message || "Boundary saved!")
}

function tileHasPlacement(key) {
    const cell = state.tilemap[key]
    if (!cell) return false
    return !!(cell.floor || cell.above_floor || cell.object)
}

function selectMessageTile(x, y) {
    const key = tileKey(x, y)
    if (!tileHasPlacement(key)) {
        showToast("No sprite here — use Paint tool to place tiles first", true)
        return
    }
    state.selectedMessageTile = key
    pickTile(x, y)
    updateMessageEditor()
    updatePortalSpotDisplay()
    if (state.portalPick?.role === "enter") {
        applyPortalPick(x, y)
    }
}

function getInteraction(key) {
    return state.tilemap[key]?.interaction || null
}

function normalizeOptionCode(raw) {
    return String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "")
}

function normalizeInteractionOptions(raw) {
    if (!Array.isArray(raw)) return []
    return raw
        .map((o) => {
            const hold = String(o?.hold || "").trim()
            return {
                label: String(o?.label || "").trim(),
                code: normalizeOptionCode(o?.code),
                ...(hold ? { hold } : {}),
            }
        })
        .filter((o) => o.label && o.code)
}

function collectAllInteractionOptionsFromDom() {
    const rows = document.querySelectorAll("#interaction-options-list .interaction-option-row")
    return Array.from(rows).map((row) => {
        const hold = row.querySelector(".opt-hold")?.value.trim() || ""
        return {
            label: row.querySelector(".opt-label")?.value.trim() || "",
            code: row.querySelector(".opt-code")?.value.trim() || "",
            ...(hold ? { hold } : {}),
        }
    })
}

function collectInteractionOptionsFromDom() {
    return collectAllInteractionOptionsFromDom().filter((o) => o.label && o.code)
}

function renderInteractionOptionsList(options = []) {
    const list = document.getElementById("interaction-options-list")
    if (!list) return
    list.innerHTML = ""
    if (!options.length) {
        list.innerHTML = '<p class="prop-meta interaction-options-empty">No action options yet.</p>'
        return
    }
    options.forEach((opt) => {
        const row = document.createElement("div")
        row.className = "interaction-option-row"
        row.innerHTML = `
            <input type="text" class="opt-label" maxlength="32" placeholder="Button label" value="${escapeAttr(opt.label || "")}">
            <input type="text" class="opt-code" maxlength="64" placeholder="flow_code" value="${escapeAttr(opt.code || "")}">
            <input type="text" class="opt-hold" maxlength="32" placeholder="hold id" list="hold-item-ids" value="${escapeAttr(opt.hold || "")}">
            <button type="button" class="btn btn-ghost btn-sm opt-remove" aria-label="Remove option">×</button>
        `
        row.querySelector(".opt-label").addEventListener("change", () => {
            applyMessageFields()
        })
        row.querySelector(".opt-code").addEventListener("change", () => {
            applyMessageFields()
        })
        row.querySelector(".opt-hold").addEventListener("change", () => {
            applyMessageFields()
        })
        row.querySelector(".opt-remove").addEventListener("click", () => {
            pushHistory()
            row.remove()
            const remaining = collectAllInteractionOptionsFromDom()
            if (remaining.length === 0) {
                list.innerHTML = '<p class="prop-meta interaction-options-empty">No action options yet.</p>'
            }
            applyMessageFields()
        })
        list.appendChild(row)
    })
}

function escapeAttr(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
}

function escapeHtml(value) {
    return escapeAttr(value).replace(/>/g, "&gt;")
}

function setInteraction(key, interaction, { refreshOptionsUI = true } = {}) {
    if (!state.tilemap[key]) return
    const allOptions = Array.isArray(interaction?.options) ? interaction.options : []
    const options = normalizeInteractionOptions(allOptions)
    const hasPartialOptions = allOptions.some(
        (o) => String(o?.label || "").trim() || String(o?.code || "").trim()
    )
    const portal = interaction?.portal
    const hasPortal = !!(
        portal?.mapId?.trim() &&
        Number.isFinite(portal.x) &&
        Number.isFinite(portal.y)
    )
    const hasContent =
        interaction &&
        (interaction.title || interaction.message || options.length || hasPartialOptions || hasPortal)
    if (hasContent) {
        let payload = {
            title: interaction.title || "",
            message: interaction.message || "",
            radius: interaction.radius ?? 2,
        }
        const pickupHold = String(interaction.pickupHold || "").trim()
        if (pickupHold) payload.pickupHold = pickupHold
        if (hasPortal) {
            payload.portal = {
                mapId: portal.mapId.trim(),
                x: portal.x,
                y: portal.y,
            }
        }
        if (options.length) payload.options = options
        if (options.length || hasPortal) {
            payload.showExit = interaction.showExit !== false
        }
        if (!hasPortal) {
            payload = stripPortalFromInteraction(payload)
            if (!payload) {
                delete state.tilemap[key].interaction
                updateMessageEditor({ refreshOptions: refreshOptionsUI })
                renderPortalList()
                draw()
                return
            }
        }
        state.tilemap[key].interaction = payload
    } else {
        delete state.tilemap[key].interaction
    }
    updateMessageEditor({ refreshOptions: refreshOptionsUI })
    renderPortalList()
    draw()
}

function updateMessageEditor({ refreshOptions = true } = {}) {
    const label = document.getElementById("message-tile-label")
    const titleInput = document.getElementById("interaction-title")
    const messageInput = document.getElementById("interaction-message")
    const radiusInput = document.getElementById("interaction-radius")
    const showExitInput = document.getElementById("interaction-show-exit")
    const pickupHoldInput = document.getElementById("interaction-pickup-hold")
    const portalMapIdInput = document.getElementById("portal-map-id")
    const portalXInput = document.getElementById("portal-x")
    const portalYInput = document.getElementById("portal-y")

    if (state.tool !== "message") return

    updatePortalMapIdSelect()

    if (!getMessageSourceTile()) {
        if (state.selectedMessageTile && !tileHasPlacement(state.selectedMessageTile)) {
            state.selectedMessageTile = null
        }
        label.textContent = state.portalPick?.role === "enter"
            ? "Click the ENTER portal item on the map"
            : "Click a placed item on the map"
        if (!state.portalPick) {
            titleInput.value = ""
            messageInput.value = ""
            radiusInput.value = "2"
            if (showExitInput) showExitInput.checked = true
            if (pickupHoldInput) pickupHoldInput.value = ""
            if (portalMapIdInput) portalMapIdInput.value = ""
            if (portalXInput) portalXInput.value = ""
            if (portalYInput) portalYInput.value = ""
            renderInteractionOptionsList([])
        }
        updatePortalSpotDisplay()
        return
    }

    const { x, y } = parseKey(state.selectedMessageTile)
    const cell = state.tilemap[state.selectedMessageTile]
    const spriteId = placementId(cell.object) || placementId(cell.above_floor) || placementId(cell.floor)
    label.textContent = `${spriteId || "item"} @ ${x}, ${y}`
    const interaction = getInteraction(state.selectedMessageTile) || {}
    titleInput.value = interaction.title || ""
    messageInput.value = interaction.message || ""
    radiusInput.value = String(interaction.radius ?? 2)
    if (showExitInput) showExitInput.checked = interaction.showExit !== false
    if (pickupHoldInput) pickupHoldInput.value = interaction.pickupHold || ""
    const portal = interaction.portal
    const hasPortal = !!(portal?.mapId && Number.isFinite(portal.x) && Number.isFinite(portal.y))
    if (portalMapIdInput) portalMapIdInput.value = hasPortal ? portal.mapId : ""
    if (portalXInput) portalXInput.value = hasPortal ? String(portal.x) : ""
    if (portalYInput) portalYInput.value = hasPortal ? String(portal.y) : ""
    if (refreshOptions) {
        renderInteractionOptionsList(interaction.options || [])
    }
    updatePortalSpotDisplay()
}

function clampInteractionRadius(value) {
    if (!Number.isFinite(value)) return 2
    const clamped = Math.min(Math.max(value, 0.5), 6)
    return Math.round(clamped * 2) / 2
}

function readMessageFieldsFromDom() {
    const title = document.getElementById("interaction-title").value.trim()
    const message = document.getElementById("interaction-message").value.trim()
    const radius = Number(document.getElementById("interaction-radius").value)
    const showExit = document.getElementById("interaction-show-exit")?.checked !== false
    const pickupHold = document.getElementById("interaction-pickup-hold")?.value.trim() || ""
    const options = collectAllInteractionOptionsFromDom()
    const portalMapId = document.getElementById("portal-map-id")?.value.trim() || ""
    const portalX = Number(document.getElementById("portal-x")?.value)
    const portalY = Number(document.getElementById("portal-y")?.value)
    const payload = {
        title,
        message,
        radius: clampInteractionRadius(radius),
        options,
        showExit,
        ...(pickupHold ? { pickupHold } : {}),
    }
    if (portalMapId && Number.isFinite(portalX) && Number.isFinite(portalY)) {
        payload.portal = { mapId: portalMapId, x: portalX, y: portalY }
    }
    return payload
}

function applyMessageFieldsWithOptions(optionsOverride) {
    const key = getMessageSourceTile()
    if (!key) return
    const fields = readMessageFieldsFromDom()
    if (optionsOverride) fields.options = optionsOverride
    setInteraction(key, fields, { refreshOptionsUI: true })
}

function applyMessageFields() {
    const key = getMessageSourceTile()
    if (!key) return
    const fields = readMessageFieldsFromDom()
    setInteraction(key, fields, { refreshOptionsUI: false })
    if (
        fields.portal?.mapId &&
        Number.isFinite(fields.portal.x) &&
        Number.isFinite(fields.portal.y)
    ) {
        const targetIndex = findRoomIndexByMapId(fields.portal.mapId)
        if (targetIndex >= 0) {
            upsertPortalConnection({
                sourceRoomIndex: state.roomIndex,
                sourceKey: key,
                targetRoomIndex: targetIndex,
                exitX: fields.portal.x,
                exitY: fields.portal.y,
            })
            updatePortalSpotDisplay()
            renderPortalList()
        }
    }
}

function clearInteraction() {
    const key = getMessageSourceTile()
    if (!key) return
    pushHistory()
    setInteraction(key, null)
}

function splitCsv(value) {
    return String(value || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
}

function normalizeNpcFlows(raw) {
    if (!Array.isArray(raw)) return []
    return raw
        .map((flow) => {
            const holds = Array.isArray(flow?.requires?.holds)
                ? flow.requires.holds.map((item) => String(item).trim()).filter(Boolean)
                : splitCsv(flow?.requires?.holds)
            const notHolds = Array.isArray(flow?.requires?.notHolds)
                ? flow.requires.notHolds.map((item) => String(item).trim()).filter(Boolean)
                : splitCsv(flow?.requires?.notHolds)
            const messages = Array.isArray(flow?.messages)
                ? flow.messages.map((line) => String(line || "").trim()).filter(Boolean)
                : String(flow?.messages || "")
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
            const grantHold = String(flow?.grantHold || "").trim()
            const grantGear = String(flow?.grantGear || "").trim()
            const fishingQuest = String(flow?.fishingQuest || "").trim()
            const questStep = String(flow?.questStep || "").trim()
            const questId = String(flow?.questId || "").trim()
            const gear = Array.isArray(flow?.requires?.gear)
                ? flow.requires.gear.map((x) => String(x || "").trim()).filter(Boolean)
                : splitCsv(flow?.requires?.gear)
            const notGear = Array.isArray(flow?.requires?.notGear)
                ? flow.requires.notGear.map((x) => String(x || "").trim()).filter(Boolean)
                : splitCsv(flow?.requires?.notGear)
            const requires = {}
            if (holds.length) requires.holds = holds
            if (notHolds.length) requires.notHolds = notHolds
            if (gear.length) requires.gear = gear
            if (notGear.length) requires.notGear = notGear
            const payload = { messages }
            if (Object.keys(requires).length) payload.requires = requires
            if (grantHold) payload.grantHold = grantHold
            if (grantGear) payload.grantGear = grantGear
            if (fishingQuest) payload.fishingQuest = fishingQuest
            if (questStep) payload.questStep = questStep
            if (questId) payload.questId = questId
            return payload
        })
        .filter((flow) => flow.messages.length)
}

function collectNpcFlowsFromDom() {
    const cards = document.querySelectorAll("#npc-flows-list .npc-flow-card")
    return Array.from(cards).map((card) => {
        const holds = splitCsv(card.querySelector(".flow-holds")?.value)
        const notHolds = splitCsv(card.querySelector(".flow-not-holds")?.value)
        const messages = String(card.querySelector(".flow-messages")?.value || "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        const grantHold = card.querySelector(".flow-grant-hold")?.value.trim() || ""
        const grantGear = card.querySelector(".flow-grant-gear")?.value.trim() || ""
        const fishingQuest = card.querySelector(".flow-fishing-quest")?.value.trim() || ""
        const questStep = card.querySelector(".flow-quest-step")?.value.trim() || ""
        const questId = card.querySelector(".flow-quest-id")?.value.trim() || ""
        const gear = splitCsv(card.querySelector(".flow-gear")?.value)
        const notGear = splitCsv(card.querySelector(".flow-not-gear")?.value)
        const requires = {}
        if (holds.length) requires.holds = holds
        if (notHolds.length) requires.notHolds = notHolds
        if (gear.length) requires.gear = gear
        if (notGear.length) requires.notGear = notGear
        const payload = { messages }
        if (Object.keys(requires).length) payload.requires = requires
        if (grantHold) payload.grantHold = grantHold
        if (grantGear) payload.grantGear = grantGear
        if (fishingQuest) payload.fishingQuest = fishingQuest
        if (questStep) payload.questStep = questStep
        if (questId) payload.questId = questId
        return payload
    }).filter((flow) => flow.messages.length)
}

function renderNpcFlowsList(flows = []) {
    const list = document.getElementById("npc-flows-list")
    if (!list) return
    list.innerHTML = ""
    if (!flows.length) {
        list.innerHTML = '<p class="prop-meta interaction-options-empty">No conditional flows yet.</p>'
        return
    }

    flows.forEach((flow, index) => {
        const card = document.createElement("div")
        card.className = "npc-flow-card"
        const holds = (flow.requires?.holds || []).join(", ")
        const notHolds = (flow.requires?.notHolds || []).join(", ")
        const gear = (flow.requires?.gear || []).join(", ")
        const notGear = (flow.requires?.notGear || []).join(", ")
        card.innerHTML = `
            <div class="npc-flow-card-head">
                <strong>Flow ${index + 1}</strong>
                <button type="button" class="btn btn-ghost btn-sm flow-remove" aria-label="Remove flow">×</button>
            </div>
            <div class="npc-flow-grid">
                <input type="text" class="flow-holds" placeholder="requires holds (bag)" list="hold-item-ids" value="${escapeAttr(holds)}">
                <input type="text" class="flow-not-holds" placeholder="requires not holds" list="hold-item-ids" value="${escapeAttr(notHolds)}">
                <input type="text" class="flow-gear" placeholder="requires gear" list="gear-item-ids" value="${escapeAttr(gear)}">
                <input type="text" class="flow-not-gear" placeholder="requires not gear" list="gear-item-ids" value="${escapeAttr(notGear)}">
                <input type="text" class="flow-grant-hold" placeholder="grant hold" list="hold-item-ids" value="${escapeAttr(flow.grantHold || "")}">
                <input type="text" class="flow-grant-gear" placeholder="grant gear" list="gear-item-ids" value="${escapeAttr(flow.grantGear || "")}">
                <input type="text" class="flow-fishing-quest" placeholder="fishing quest id" list="fishing-quest-ids" value="${escapeAttr(flow.fishingQuest || "")}">
                <input type="text" class="flow-quest-step" placeholder="quest step" list="quest-step-ids" value="${escapeAttr(flow.questStep || "")}">
            </div>
            <input type="text" class="flow-quest-id" placeholder="quest id (optional)" value="${escapeAttr(flow.questId || "")}">
        `
        const messagesField = document.createElement("textarea")
        messagesField.className = "flow-messages"
        messagesField.rows = 3
        messagesField.maxLength = 2000
        messagesField.placeholder = "Messages for this flow (one per line)"
        messagesField.value = (flow.messages || []).join("\n")
        card.appendChild(messagesField)

        card.querySelectorAll("input, textarea").forEach((el) => {
            el.addEventListener("change", () => applyNpcFields())
        })

        card.querySelector(".flow-remove").addEventListener("click", () => {
            pushHistory()
            card.remove()
            if (!list.querySelector(".npc-flow-card")) {
                list.innerHTML = '<p class="prop-meta interaction-options-empty">No conditional flows yet.</p>'
            }
            applyNpcFields()
        })

        list.appendChild(card)
    })
}

function nextNpcId() {
    let n = state.npcs.length + 1
    while (state.npcs.some((npc) => npc.id === `npc-${n}`)) n++
    return `npc-${n}`
}

function getSelectedNpc() {
    return state.npcs[state.selectedNpcIndex] || null
}

function addNpc(skipHistory = false) {
    if (!skipHistory) pushHistory()
    const npc = {
        id: nextNpcId(),
        name: "Guide",
        skin: document.getElementById("npc-skin")?.value || "009",
        path: [],
        loop: true,
        waitMs: 800,
        noticeRadius: 2,
        messages: [],
    }
    state.npcs.push(npc)
    state.selectedNpcIndex = state.npcs.length - 1
    updateNpcEditor()
    draw()
}

function deleteSelectedNpc() {
    const npc = getSelectedNpc()
    if (!npc) return
    pushHistory()
    state.npcs.splice(state.selectedNpcIndex, 1)
    state.selectedNpcIndex = Math.max(0, state.selectedNpcIndex - 1)
    updateNpcEditor()
    draw()
}

function addNpcWaypoint(x, y) {
    if (!state.npcs.length) {
        addNpc(true)
    }
    const npc = getSelectedNpc()
    if (!npc) return

    const last = npc.path[npc.path.length - 1]
    if (last && last.x === x && last.y === y) return

    pushHistory()
    npc.path.push({ x, y })
    updateNpcEditor()
}

function undoNpcWaypoint() {
    const npc = getSelectedNpc()
    if (!npc?.path.length) return
    pushHistory()
    npc.path.pop()
    updateNpcEditor()
    draw()
}

function updateNpcEditor() {
    const select = document.getElementById("npc-select")
    document.getElementById("npc-count").textContent = String(state.npcs.length)

    if (state.tool !== "npc") return

    select.innerHTML = state.npcs.length
        ? state.npcs.map((npc, i) => `
            <option value="${i}" ${i === state.selectedNpcIndex ? "selected" : ""}>${npc.name || npc.id}</option>
        `).join("")
        : '<option value="">No NPCs yet</option>'

    const npc = getSelectedNpc()
    if (!npc) {
        document.getElementById("npc-name").value = ""
        document.getElementById("npc-wait").value = "800"
        document.getElementById("npc-loop").checked = true
        document.getElementById("npc-notice-radius").value = "2"
        document.getElementById("npc-messages").value = ""
        document.getElementById("npc-oncomplete-quest-step").value = ""
        document.getElementById("npc-oncomplete-grant-hold").value = ""
        renderNpcFlowsList([])
        document.getElementById("npc-waypoint-count").textContent = "0"
        renderNpcSkinGrid("009")
        return
    }

    document.getElementById("npc-name").value = npc.name || ""
    document.getElementById("npc-wait").value = String(npc.waitMs ?? 800)
    document.getElementById("npc-loop").checked = npc.loop !== false
    document.getElementById("npc-notice-radius").value = String(npc.noticeRadius ?? 2)
    document.getElementById("npc-messages").value = (npc.messages || []).join("\n")
    document.getElementById("npc-oncomplete-quest-step").value = npc.onComplete?.questStep || ""
    document.getElementById("npc-oncomplete-grant-hold").value = npc.onComplete?.grantHold || ""
    renderNpcFlowsList(npc.flows || [])
    document.getElementById("npc-waypoint-count").textContent = String(npc.path?.length || 0)
    renderNpcSkinGrid(npc.skin || "009")
}

function applyNpcFields() {
    const npc = getSelectedNpc()
    if (!npc) return
    npc.name = document.getElementById("npc-name").value.trim() || npc.id
    npc.skin = document.getElementById("npc-skin").value.trim() || "009"
    const waitMs = Number(document.getElementById("npc-wait").value)
    npc.waitMs = Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), 10000) : 800
    npc.loop = document.getElementById("npc-loop").checked
    const noticeRadius = Number(document.getElementById("npc-notice-radius").value)
    npc.noticeRadius = Number.isFinite(noticeRadius)
        ? Math.min(Math.max(noticeRadius, 0.5), 2)
        : 2
    npc.messages = document.getElementById("npc-messages").value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    const flows = normalizeNpcFlows(collectNpcFlowsFromDom())
    if (flows.length) npc.flows = flows
    else delete npc.flows

    const questStep = document.getElementById("npc-oncomplete-quest-step").value.trim()
    const grantHold = document.getElementById("npc-oncomplete-grant-hold").value.trim()
    if (questStep || grantHold) {
        npc.onComplete = {}
        if (questStep) npc.onComplete.questStep = questStep
        if (grantHold) npc.onComplete.grantHold = grantHold
    } else {
        delete npc.onComplete
    }

    updateNpcEditor()
    draw()
}

const PROPS_PANEL_WIDTH_KEY = "mapBuilderPropsWidth"
const PROPS_PANEL_MIN = 240
const PROPS_PANEL_MAX = 560

function propsPanelMaxWidth() {
    return Math.min(PROPS_PANEL_MAX, Math.max(PROPS_PANEL_MIN, Math.floor(window.innerWidth * 0.45)))
}

function setPropsPanelWidth(width) {
    const workspace = document.querySelector(".workspace")
    if (!workspace) return
    const clamped = Math.min(propsPanelMaxWidth(), Math.max(PROPS_PANEL_MIN, width))
    workspace.style.setProperty("--props-panel-width", `${clamped}px`)
    return clamped
}

function initPropsPanelResize() {
    const handle = document.getElementById("props-resize-handle")
    if (!handle) return

    let width = setPropsPanelWidth(parseInt(localStorage.getItem(PROPS_PANEL_WIDTH_KEY), 10) || PROPS_PANEL_MIN)
    let dragging = false
    let startX = 0
    let startWidth = 0

    const finishDrag = () => {
        if (!dragging) return
        dragging = false
        handle.classList.remove("dragging")
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        localStorage.setItem(PROPS_PANEL_WIDTH_KEY, String(width))
        resizeCanvas()
        resizeBoundaryCanvas()
    }

    handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        dragging = true
        handle.classList.add("dragging")
        startX = e.clientX
        startWidth = width
        document.body.style.cursor = "ew-resize"
        document.body.style.userSelect = "none"
    })

    window.addEventListener("mousemove", (e) => {
        if (!dragging) return
        width = setPropsPanelWidth(startWidth + (startX - e.clientX))
    })

    window.addEventListener("mouseup", finishDrag)
    window.addEventListener("blur", finishDrag)

    window.addEventListener("resize", () => {
        width = setPropsPanelWidth(width)
    })
}

function bindEvents() {
    initPropsPanelResize()
    document.getElementById("sprite-search").addEventListener("input", (e) => {
        state.search = e.target.value
        renderSpriteGrid({ preserveScroll: false })
    })

    document.querySelectorAll(".layer-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
            state.selectedLayer = btn.dataset.layer
            syncLayerTabs()
        })
    })

    document.querySelectorAll(".tool-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            state.tool = btn.dataset.tool
            syncTools()
            if (state.tool === "boundaries") {
                loadBoundaryEditor()
            }
            if (state.tool === "message") {
                updateMessageEditor()
            }
            if (state.tool === "portals") {
                renderPortalList()
            }
            if (state.tool === "npc") {
                updateNpcEditor()
            }
            if (state.tool === "avatars") {
                renderAvatarCostGrid()
            }
            if (state.tool === "animations") {
                state.selectedSheet = "anim"
                renderSheetTabs()
                renderSpriteGrid({ preserveScroll: false })
                renderAnimationList()
            }
            if (state.tool === "gear-items") {
                renderGearItemList()
            }
        })
    })

    document.getElementById("btn-add-room")?.addEventListener("click", addRoom)
    document.getElementById("room-map-id")?.addEventListener("change", () => {
        persistCurrentRoom()
        renderRoomTabs()
        updatePortalMapIdSelect()
        renderPortalList()
        updateMapNameOverlay()
    })
    document.getElementById("room-name")?.addEventListener("input", (e) => {
        syncRoomNameFromEditor(e.target.value)
        renderRoomTabs()
        updatePortalMapIdSelect()
        draw()
    })
    document.getElementById("room-name")?.addEventListener("change", () => {
        persistCurrentRoom()
        renderRoomTabs()
        updateMapNameOverlay()
    })
    document.getElementById("map-name-overlay-input")?.addEventListener("input", (e) => {
        if (state.portalPreview) return
        syncRoomNameFromEditor(e.target.value)
        renderRoomTabs()
        updatePortalMapIdSelect()
        draw()
    })
    document.getElementById("map-name-overlay-input")?.addEventListener("change", () => {
        if (state.portalPreview) return
        persistCurrentRoom()
        renderRoomTabs()
    })
    function syncPortalFieldsFromDom() {
        updatePortalSpotDisplay()
    }
    document.getElementById("portal-map-id")?.addEventListener("change", () => {
        const mapId = document.getElementById("portal-map-id")?.value.trim()
        if (mapId) {
            document.getElementById("portal-x").value = ""
            document.getElementById("portal-y").value = ""
        }
        syncPortalFieldsFromDom()
        pushHistory()
        applyMessageFields()
    })
    document.getElementById("portal-x")?.addEventListener("change", () => {
        syncPortalFieldsFromDom()
        pushHistory()
        applyMessageFields()
    })
    document.getElementById("portal-y")?.addEventListener("change", () => {
        syncPortalFieldsFromDom()
        pushHistory()
        applyMessageFields()
    })
    document.getElementById("portal-map-id")?.addEventListener("input", syncPortalFieldsFromDom)
    document.getElementById("btn-pick-portal-enter")?.addEventListener("click", () => {
        syncMessageSelectionFromPlacement()
        const sourceKey = getMessageSourceTile()
        const draft = {}
        if (sourceKey) {
            const { x, y } = parseKey(sourceKey)
            draft.sourceRoomIndex = state.roomIndex
            draft.sourceKey = sourceKey
            draft.sourceX = x
            draft.sourceY = y
            const portal = getInteraction(sourceKey)?.portal
            if (portal?.mapId) {
                draft.targetMapId = portal.mapId
                draft.exitX = portal.x
                draft.exitY = portal.y
            }
        }
        startPortalPick("enter", draft)
    })
    document.getElementById("btn-pick-portal-exit")?.addEventListener("click", () => {
        syncMessageSelectionFromPlacement()
        const sourceKey = getMessageSourceTile()
        const draft = {}
        if (sourceKey) {
            const { x, y } = parseKey(sourceKey)
            draft.sourceRoomIndex = state.roomIndex
            draft.sourceKey = sourceKey
            draft.sourceMapId = readRoomMapIdFromEditor()
            draft.sourceX = x
            draft.sourceY = y
            const portal = getInteraction(sourceKey)?.portal
            if (portal?.mapId) {
                draft.targetMapId = portal.mapId
                draft.exitX = portal.x
                draft.exitY = portal.y
            }
        }
        startPortalPick("exit", draft)
    })
    document.getElementById("btn-new-portal-connection")?.addEventListener("click", () => {
        state.tool = "portals"
        syncTools()
        startPortalPick("enter", { sourceRoomIndex: state.roomIndex })
    })
    document.getElementById("btn-portal-list-scope")?.addEventListener("click", () => {
        state.portalListShowAll = !state.portalListShowAll
        const btn = document.getElementById("btn-portal-list-scope")
        if (btn) btn.textContent = state.portalListShowAll ? "This map only" : "All maps"
        renderPortalList()
    })
    document.getElementById("portal-conn-title")?.addEventListener("change", () => {
        applyPortalConnectionFields()
    })
    document.getElementById("portal-conn-message")?.addEventListener("change", () => {
        applyPortalConnectionFields()
    })
    document.getElementById("portal-conn-map-id")?.addEventListener("change", () => {
        applyPortalConnectionFields()
    })
    document.getElementById("portal-conn-x")?.addEventListener("change", () => {
        applyPortalConnectionFields()
    })
    document.getElementById("portal-conn-y")?.addEventListener("change", () => {
        applyPortalConnectionFields()
    })
    document.getElementById("btn-pick-portal-conn-enter")?.addEventListener("click", () => {
        const connection = getSelectedPortalConnection()
        if (!connection) return
        const { enter } = connection
        closePortalPreview()
        startPortalPick("enter", {
            sourceRoomIndex: enter.sourceRoomIndex,
            sourceKey: enter.sourceKey,
            sourceMapId: enter.sourceMapId,
            sourceX: enter.sourceX,
            sourceY: enter.sourceY,
            targetMapId: enter.targetMapId,
            exitX: enter.targetX,
            exitY: enter.targetY,
        })
    })
    document.getElementById("btn-pick-portal-conn-exit")?.addEventListener("click", () => {
        const connection = getSelectedPortalConnection()
        if (!connection) return
        const { enter, exit } = connection
        closePortalPreview()
        startPortalPick("exit", {
            sourceRoomIndex: enter.sourceRoomIndex,
            sourceKey: enter.sourceKey,
            sourceMapId: enter.sourceMapId,
            sourceX: enter.sourceX,
            sourceY: enter.sourceY,
            targetMapId: enter.targetMapId,
            targetRoomIndex: exit?.roomIndex ?? findRoomIndexByMapId(enter.targetMapId),
            exitX: enter.targetX,
            exitY: enter.targetY,
        })
    })
    document.getElementById("btn-remove-all-portals")?.addEventListener("click", () => {
        removeAllPortals()
    })
    document.getElementById("btn-view-portal-link")?.addEventListener("click", () => {
        syncMessageSelectionFromPlacement()
        if (!getMessageSourceTile()) {
            showToast("Click a portal item on the map first", true)
            return
        }
        const fields = readMessageFieldsFromDom()
        if (!fields.portal?.mapId) {
            showToast("Configure portal target and spawn first", true)
            return
        }
        const sourceKey = getMessageSourceTile()
        const { x, y } = parseKey(sourceKey)
        openPortalPreview({
            sourceRoomIndex: state.roomIndex,
            sourceMapId: readRoomMapIdFromEditor(),
            sourceMapName: readRoomNameFromEditor(),
            sourceKey,
            sourceX: x,
            sourceY: y,
            targetMapId: fields.portal.mapId,
            targetX: fields.portal.x,
            targetY: fields.portal.y,
            title: fields.title || "Portal",
        })
    })
    document.getElementById("btn-close-portal-preview")?.addEventListener("click", () => {
        const returnIndex = state.portalPreviewReturn ?? state.roomIndex
        closePortalPreview()
        loadRoomIntoEditor(returnIndex, { skipHistory: true })
    })

    document.getElementById("btn-avatar-tier-defaults")?.addEventListener("click", () => {
        setAvatarCosts(buildDefaultAvatarCosts(state.characterSkins))
        showToast("Tier defaults applied — save map to publish")
    })
    document.getElementById("btn-avatar-all-free")?.addEventListener("click", () => {
        const costs = {}
        for (const skin of state.characterSkins) costs[skin] = 0
        setAvatarCosts(costs)
        showToast("All avatars set to free — save map to publish")
    })
    document.getElementById("avatar-cost-search")?.addEventListener("input", renderAvatarCostGrid)
    document.getElementById("avatar-cost-grid")?.addEventListener("input", (e) => {
        const input = e.target.closest(".avatar-cost-input")
        if (!input?.dataset.skin) return
        state.avatarCosts[input.dataset.skin] = Math.max(0, Math.floor(Number(input.value) || 0))
    })

    document.getElementById("interaction-title").addEventListener("change", () => {
        pushHistory()
        applyMessageFields()
    })
    document.getElementById("interaction-message").addEventListener("change", () => {
        pushHistory()
        applyMessageFields()
    })
    document.getElementById("interaction-radius").addEventListener("change", () => {
        pushHistory()
        applyMessageFields()
    })
    document.getElementById("interaction-show-exit")?.addEventListener("change", () => {
        pushHistory()
        applyMessageFields()
    })
    document.getElementById("interaction-pickup-hold")?.addEventListener("change", () => {
        pushHistory()
        applyMessageFields()
    })
    document.getElementById("btn-add-interaction-option")?.addEventListener("click", () => {
        if (!state.selectedMessageTile) return
        const list = document.getElementById("interaction-options-list")
        const empty = list?.querySelector(".interaction-options-empty")
        if (empty) empty.remove()
        const current = collectAllInteractionOptionsFromDom()
        renderInteractionOptionsList([...current, { label: "", code: "" }])
        const rows = document.querySelectorAll("#interaction-options-list .interaction-option-row")
        const last = rows[rows.length - 1]
        last?.querySelector(".opt-label")?.focus()
    })
    document.getElementById("btn-npc-add-flow")?.addEventListener("click", () => {
        const npc = getSelectedNpc()
        if (!npc) return
        pushHistory()
        const list = document.getElementById("npc-flows-list")
        const empty = list?.querySelector(".interaction-options-empty")
        if (empty) empty.remove()
        const current = collectNpcFlowsFromDom()
        renderNpcFlowsList([...current, { messages: [""], requires: {} }])
        applyNpcFields()
    })
    document.getElementById("btn-clear-interaction").addEventListener("click", clearInteraction)

    document.getElementById("npc-select").addEventListener("change", (e) => {
        state.selectedNpcIndex = Number(e.target.value)
        updateNpcEditor()
        draw()
    })
    document.getElementById("btn-npc-add").addEventListener("click", addNpc)
    document.getElementById("btn-npc-delete").addEventListener("click", deleteSelectedNpc)
    document.getElementById("btn-npc-undo").addEventListener("click", () => {
        undoNpcWaypoint()
    })
    document.getElementById("npc-name").addEventListener("change", () => {
        pushHistory()
        applyNpcFields()
    })
    document.getElementById("npc-skin-grid").addEventListener("click", (e) => {
        const btn = e.target.closest(".npc-skin-item")
        if (!btn?.dataset.skin) return
        selectNpcSkin(btn.dataset.skin)
    })
    document.getElementById("npc-wait").addEventListener("change", () => {
        pushHistory()
        applyNpcFields()
    })
    document.getElementById("npc-loop").addEventListener("change", () => {
        pushHistory()
        applyNpcFields()
    })
    document.getElementById("npc-notice-radius").addEventListener("change", () => {
        pushHistory()
        applyNpcFields()
    })
    document.getElementById("npc-messages").addEventListener("change", () => {
        pushHistory()
        applyNpcFields()
    })
    document.getElementById("npc-oncomplete-quest-step")?.addEventListener("change", () => {
        pushHistory()
        applyNpcFields()
    })
    document.getElementById("npc-oncomplete-grant-hold")?.addEventListener("change", () => {
        pushHistory()
        applyNpcFields()
    })

    document.getElementById("btn-save").addEventListener("click", () => {
        pushHistory()
        saveMap()
    })
    document.getElementById("btn-undo").addEventListener("click", undo)
    document.getElementById("btn-redo").addEventListener("click", redo)

    document.getElementById("paint-scale").addEventListener("change", (e) => {
        const scale = Number(e.target.value)
        if (!Number.isFinite(scale)) return
        state.paintScale = Math.min(Math.max(scale, 0.05), 10)
        e.target.value = String(state.paintScale)
    })

    document.getElementById("prop-tile-x").addEventListener("change", (e) => {
        const newX = Number(e.target.value)
        const newY = Number(document.getElementById("prop-tile-y").value)
        if (!Number.isFinite(newX) || !Number.isFinite(newY)) return
        pushHistory()
        applyPlacementCoordinates(newX, newY)
    })

    document.getElementById("prop-tile-y").addEventListener("change", (e) => {
        const newY = Number(e.target.value)
        const newX = Number(document.getElementById("prop-tile-x").value)
        if (!Number.isFinite(newX) || !Number.isFinite(newY)) return
        pushHistory()
        applyPlacementCoordinates(newX, newY)
    })

    document.getElementById("prop-scale").addEventListener("change", (e) => {
        const scale = Number(e.target.value)
        if (!Number.isFinite(scale)) return
        pushHistory()
        applyPlacementScale(scale)
        updatePlacementEditor()
    })

    document.getElementById("btn-boundary-undo").addEventListener("click", undoBoundaryPoint)
    document.getElementById("btn-boundary-clear").addEventListener("click", clearBoundaryPoints)
    document.getElementById("btn-boundary-save").addEventListener("click", saveBoundary)

    document.getElementById("btn-map-boundary-undo")?.addEventListener("click", () => {
        if (!state.mapBoundary.length) return
        pushHistory()
        undoMapBoundaryPoint()
    })
    document.getElementById("btn-map-boundary-clear")?.addEventListener("click", () => {
        if (!state.mapBoundary.length) return
        pushHistory()
        clearMapBoundary()
    })

    boundaryCanvas.addEventListener("pointerdown", (e) => {
        if (state.tool !== "boundaries" || e.button !== 0) return
        const tile = boundaryPointerToTile(e)
        if (tile) addBoundaryPoint(tile)
    })

    boundaryCanvas.addEventListener("contextmenu", (e) => {
        e.preventDefault()
        if (state.tool === "boundaries") undoBoundaryPoint()
    })

    document.getElementById("btn-zoom-in").addEventListener("click", () => {
        const rect = canvas.getBoundingClientRect()
        zoomAt(1.2, rect.width / 2, rect.height / 2)
    })
    document.getElementById("btn-zoom-out").addEventListener("click", () => {
        const rect = canvas.getBoundingClientRect()
        zoomAt(1 / 1.2, rect.width / 2, rect.height / 2)
    })

    wrap.addEventListener("wheel", (e) => {
        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top

        // Pinch-to-zoom (trackpad) or Ctrl/Cmd+scroll → zoom
        if (e.ctrlKey || e.metaKey) {
            const factor = e.deltaY > 0 ? 0.92 : 1.08
            zoomAt(factor, mx, my)
            return
        }

        // Two-finger scroll / mouse wheel → pan the map
        state.panX -= e.deltaX
        state.panY -= e.deltaY
        draw()
    }, { passive: false })

    wrap.addEventListener("contextmenu", (e) => {
        if (state.tool === "map-boundary") {
            e.preventDefault()
            if (state.mapBoundary.length) {
                pushHistory()
                undoMapBoundaryPoint()
            }
            return
        }
        e.preventDefault()
    })

    wrap.addEventListener("pointerdown", (e) => {
        if (shouldPan(e)) {
            e.preventDefault()
            startPan(e)
            return
        }
        if (e.button !== 0) return
        const rect = canvas.getBoundingClientRect()
        const tile = screenToTile(e.clientX - rect.left, e.clientY - rect.top)
        if (state.tool === "map-boundary") {
            pushHistory()
            handlePaint(tile.x, tile.y)
            return
        }
        state.painting = true
        pushHistory()
        handlePaint(tile.x, tile.y)
    })

    wrap.addEventListener("pointermove", (e) => {
        const rect = canvas.getBoundingClientRect()
        const tile = screenToTile(e.clientX - rect.left, e.clientY - rect.top)
        document.getElementById("coords").textContent = `${tile.x}, ${tile.y}`

        if (state.panning && panStart) {
            state.panX = e.clientX - panStart.x
            state.panY = e.clientY - panStart.y
            draw()
            return
        }
        if (state.painting) {
            handlePaint(tile.x, tile.y)
        }
    })

    const endPaint = () => {
        state.painting = false
        state.panning = false
        state.lastTile = null
        panStart = null
        wrap.classList.remove("panning")
    }
    wrap.addEventListener("pointerup", endPaint)
    wrap.addEventListener("pointerleave", endPaint)

    wrap.addEventListener("dragover", (e) => e.preventDefault())
    wrap.addEventListener("drop", (e) => {
        e.preventDefault()
        const id = e.dataTransfer.getData("text/plain")
        const sprite = getSpriteById(id)
        if (!sprite) return
        selectSprite(sprite)
        const rect = canvas.getBoundingClientRect()
        const tile = screenToTile(e.clientX - rect.left, e.clientY - rect.top)
        pushHistory()
        placeTile(tile.x, tile.y, state.selectedLayer, sprite.id)
        updateStats()
        draw()
    })

    window.addEventListener("resize", () => {
        resizeCanvas()
        resizeBoundaryCanvas()
    })

    bindAnimalFrameEditor()
    bindGearAttachEditor()
}

function syncTools() {
    const isBoundary = state.tool === "boundaries"
    const isMapBoundary = state.tool === "map-boundary"
    const isMessage = state.tool === "message"
    const isPortals = state.tool === "portals"
    const isNpc = state.tool === "npc"
    const isAvatars = state.tool === "avatars"
    const isAnimals = state.tool === "animals"
    const isAnimations = state.tool === "animations"
    const isGearItems = state.tool === "gear-items"
    const isAltCanvas = isBoundary
    const isMapEditOverlay = isMessage || isPortals || isNpc || isAvatars || isAnimals || isAnimations || isGearItems || isMapBoundary
    document.querySelectorAll(".tool-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tool === state.tool)
    })
    wrap.classList.toggle("pan-tool", state.tool === "pan")
    wrap.classList.toggle("hidden", isAltCanvas)
    boundaryWrap.classList.toggle("hidden", !isBoundary)
    document.getElementById("paint-props").classList.toggle(
        "hidden",
        isAltCanvas || isMapEditOverlay || state.selectedPlacement || !state.selectedSprite
    )
    document.getElementById("placement-props").classList.toggle(
        "hidden",
        isAltCanvas || isMapEditOverlay || !state.selectedPlacement
    )
    document.getElementById("boundary-props").classList.toggle("hidden", !isBoundary)
    document.getElementById("map-boundary-props")?.classList.toggle("hidden", !isMapBoundary)
    document.getElementById("message-props").classList.toggle("hidden", !isMessage)
    document.getElementById("portal-props")?.classList.toggle("hidden", !isPortals)
    document.getElementById("npc-props").classList.toggle("hidden", !isNpc)
    document.getElementById("avatar-props")?.classList.toggle("hidden", !isAvatars)
    document.getElementById("animal-props")?.classList.toggle("hidden", !isAnimals)
    document.getElementById("animation-props")?.classList.toggle("hidden", !isAnimations)
    document.getElementById("gear-items-props")?.classList.toggle("hidden", !isGearItems)

    const hints = {
        boundaries: "Click sprite tiles to add boundary points · Right-click undo last point",
        "map-boundary": "Click map to add edge points · lines connect in order · 3+ closes walkable area · invisible in game",
        message: "Pick Enter item, choose exit map, then Pick Exit · Purple dot = portal",
        portals: "Click a 🌀 portal on the map to select it · list shows connections for this map",
        npc: "Select NPC · click map to add patrol waypoints · green dot = start",
        avatars: "Set Chip price per trainer avatar · saved with the world map",
        animals: "Draw boxes · drag inside to move · drag yellow handles to resize · click any box to edit it",
        animations: "3×3 loop frames (0–8) · pick sprite from anim sheet · paint on object layer",
        "gear-items": "Edit attach opens full-screen editor · per-view eligible + drag/drop attach",
    }
    document.getElementById("toolbar-hint").textContent = hints[state.tool]
        || "Use Pan tool or middle mouse to move · Pinch/scroll to zoom · Left drag to paint"

    if (isBoundary) resizeBoundaryCanvas()
    if (isMessage) {
        syncMessageSelectionFromPlacement()
        updateMessageEditor()
    } else if (!state.portalPick) {
        cancelPortalPick()
    }
    if (isPortals) renderPortalList()
    if (isNpc) updateNpcEditor()
    if (isAvatars) renderAvatarCostGrid()
    if (isAnimals) renderAnimalList()
    if (isAnimations) renderAnimationList()
    if (isMapBoundary) updateMapBoundaryEditor()
    updateMapNameOverlay()
}

function shouldPan(e) {
    return state.tool === "pan" || e.button === 1 || e.button === 2
}

function startPan(e) {
    panStart = { x: e.clientX - state.panX, y: e.clientY - state.panY }
    state.panning = true
    state.painting = false
    wrap.classList.add("panning")
    wrap.setPointerCapture(e.pointerId)
}

function zoomAt(factor, mx, my) {
    const oldZoom = state.zoom
    state.zoom = Math.min(Math.max(state.zoom * factor, 0.4), 5)
    state.panX = mx - (mx - state.panX) * (state.zoom / oldZoom)
    state.panY = my - (my - state.panY) * (state.zoom / oldZoom)
    document.getElementById("zoom-label").textContent = `${Math.round(state.zoom * 100)}%`
    draw()
}

const ANIMAL_DIRECTIONS = ["down", "left", "right", "up"]
const ANIMAL_FRAMES_PER_DIR = 4
const ANIMAL_DIR_COLORS = {
    down: "rgba(91, 156, 255, 0.35)",
    left: "rgba(74, 222, 128, 0.35)",
    right: "rgba(251, 191, 36, 0.35)",
    up: "rgba(244, 114, 182, 0.35)",
}

const ANIMATION_LOOP_SLOTS = 9
const ANIMATION_LOOP_COLS = 3
const ANIMATION_LOOP_ROWS = 3
const ANIM_LOOP_COLOR = "rgba(96, 165, 250, 0.35)"

function isAnimationEditor() {
    return state.animalFrameEditor?.editorKind === "animation"
}

function defaultAnimationFrameSize(animal) {
    const cols = animal?.columns || ANIMATION_LOOP_COLS
    const rows = animal?.rows || ANIMATION_LOOP_ROWS
    return {
        w: Math.max(1, Math.round((animal?.width || 144) / cols)),
        h: Math.max(1, Math.round((animal?.height || 144) / rows)),
    }
}

function readAnimationFixedSizeInputs() {
    const editor = state.animalFrameEditor
    const w = Number(document.getElementById("anim-frame-w")?.value)
    const h = Number(document.getElementById("anim-frame-h")?.value)
    const fw = Number.isFinite(w) && w > 0 ? Math.round(w) : editor.fixedFrameW
    const fh = Number.isFinite(h) && h > 0 ? Math.round(h) : editor.fixedFrameH
    editor.fixedFrameW = fw
    editor.fixedFrameH = fh
    return { w: fw, h: fh }
}

function syncAnimationFixedSizeInputs() {
    const editor = state.animalFrameEditor
    const wEl = document.getElementById("anim-frame-w")
    const hEl = document.getElementById("anim-frame-h")
    if (wEl) wEl.value = String(editor.fixedFrameW)
    if (hEl) hEl.value = String(editor.fixedFrameH)
}

function syncAnimationEditorChrome() {
    const isAnim = isAnimationEditor()
    document.getElementById("animal-frame-fixed-wrap")?.classList.toggle("hidden", !isAnim)
    document.getElementById("animal-frame-slots-label").textContent = isAnim ? "Loop frames" : "Walk frames"
    if (isAnim) syncAnimationFixedSizeInputs()
}

function clearAnimationFrames() {
    const editor = state.animalFrameEditor
    if (!isAnimationEditor()) return
    editor.frames = {}
    editor.customFrames = false
    renderAnimalFrameSidebar()
    drawAnimalFrameCanvas()
    showToast("All frames cleared — set size then Apply to all 9")
}

function applyFixedFrameSizeToAll() {
    const editor = state.animalFrameEditor
    if (!isAnimationEditor() || !editor.animal) return

    const { w: frameW, h: frameH } = readAnimationFixedSizeInputs()
    const frames = {}
    for (let slot = 0; slot < ANIMATION_LOOP_SLOTS; slot++) {
        const col = slot % ANIMATION_LOOP_COLS
        const row = Math.floor(slot / ANIMATION_LOOP_COLS)
        frames[`loop_${slot}`] = {
            x: col * frameW,
            y: row * frameH,
            w: frameW,
            h: frameH,
        }
    }
    editor.frames = frames
    editor.customFrames = true
    renderAnimalFrameSidebar()
    drawAnimalFrameCanvas()
    showToast(`Applied ${frameW}×${frameH} to all 9 frames`)
}

function normalizeAnimationFramesForSave(frames) {
    const { w: fw, h: fh } = readAnimationFixedSizeInputs()
    const normalized = {}
    for (const [key, rect] of Object.entries(frames || {})) {
        if (!key.startsWith("loop_")) continue
        normalized[key] = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: fw,
            h: fh,
        }
    }
    return normalized
}

function animalFrameKey(direction, slot) {
    if (state.animalFrameEditor?.editorKind === "animation") {
        return `loop_${slot}`
    }
    return `walk_${direction}_${slot}`
}

function parseAnimalFrameKey(key) {
    const walk = /^walk_(down|left|right|up)_(\d+)$/.exec(key || "")
    if (walk) {
        return { kind: "walk", direction: walk[1], slot: Number(walk[2]) }
    }
    const loop = /^loop_(\d+)$/.exec(key || "")
    if (loop) {
        return { kind: "loop", slot: Number(loop[1]) }
    }
    return null
}

function animationSpriteUrl(entry) {
    if (!entry) return ""
    if (entry.url) return entry.url
    const folder = entry.folder || entry.id
    const path = entry.path || `${folder}/${entry.file}`
    return `/sprites/animations/${path}`
}

function animationThumbStyle(entry) {
    const fw = entry.frameWidth || Math.max(1, Math.floor(entry.width / (entry.columns || 8)))
    const fh = entry.frameHeight || entry.height
    const z = (CHAR_FRAME.w * CHAR_THUMB_ZOOM) / fw
    return [
        `background-image:url(${animationSpriteUrl(entry)})`,
        `background-size:${entry.width * z}px ${entry.height * z}px`,
        `background-position:0 0`,
        `width:${Math.round(fw * z)}px`,
        `height:${Math.round(fh * z)}px`,
    ].join(";")
}

function renderAnimationList() {
    const list = document.getElementById("animation-list")
    if (!list) return

    if (!state.animationSkins.length) {
        list.innerHTML = `<p class="prop-meta">Create one folder per animation in <code>sprites/animations/</code> with a PNG + auto <code>{name}.json</code></p>`
        return
    }

    list.innerHTML = state.animationSkins.map((entry) => `
        <div class="animal-list-item">
            <div class="animal-list-thumb" style="${animationThumbStyle(entry)}"></div>
            <div class="animal-list-meta">
                <strong>${entry.id}</strong>
                <span>${entry.width}×${entry.height} · 9 frames · ${entry.frameMs || 180}ms${entry.customFrames ? " · custom" : ""}</span>
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-edit-animation="${entry.id}">Edit frames</button>
        </div>
    `).join("")
}

async function openAnimationFrameEditor(animationId) {
    const res = await fetch(`/api/animations/${encodeURIComponent(animationId)}/frames`)
    const data = await res.json()
    if (!res.ok) {
        showToast(data.error || "Could not load animation frames", true)
        return
    }

    const img = new Image()
    img.src = `${animationSpriteUrl(data.animation)}?v=${Date.now()}`
    await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error("Could not load animation image"))
    })

    const loop0 = data.frames?.loop_0
    const fallback = defaultAnimationFrameSize(data.animation)
    const fixedW = data.frameWidth || loop0?.w || data.animation.frameWidth || fallback.w
    const fixedH = data.frameHeight || loop0?.h || data.animation.frameHeight || fallback.h

    state.animalFrameEditor = {
        open: true,
        editorKind: "animation",
        animal: data.animation,
        frames: { ...(data.frames || {}) },
        direction: "down",
        slot: 0,
        displayScale: data.displayScale || data.animation.displayScale || 1,
        frameMs: data.frameMs || data.animation.frameMs || 180,
        fixedFrameW: fixedW,
        fixedFrameH: fixedH,
        customFrames: Boolean(data.customFrames),
        image: img,
        drag: null,
        canvasLayout: null,
    }

    const modal = document.getElementById("animal-frame-modal")
    modal?.classList.remove("hidden")
    modal?.setAttribute("aria-hidden", "false")
    document.getElementById("animal-frame-title").textContent = `${data.animation.id} loop animation`
    document.getElementById("animal-frame-scale").value = String(state.animalFrameEditor.displayScale)
    document.getElementById("animal-frame-directions")?.classList.add("hidden")
    document.getElementById("animal-frame-ms-wrap")?.classList.remove("hidden")
    document.getElementById("anim-gear-use-wrap")?.classList.remove("hidden")
    document.getElementById("anim-gear-use-help")?.classList.remove("hidden")
    const gearUseEl = document.getElementById("anim-gear-use-target")
    if (gearUseEl) {
        gearUseEl.checked = Boolean(data.gearUseTarget || data.animation?.gearUseTarget)
    }
    document.getElementById("animal-frame-ms").value = String(state.animalFrameEditor.frameMs)
    document.getElementById("animal-frame-help").textContent =
        "Fixed size for all frames · Clear → set W/H → Apply to all 9 · click map to place"
    syncAnimationEditorChrome()

    renderAnimalFrameSidebar()
    resizeAnimalFrameCanvas()
    drawAnimalFrameCanvas()
}

function renderAnimalList() {
    const list = document.getElementById("animal-list")
    if (!list) return

    if (!state.animalSkins.length) {
        list.innerHTML = `<p class="prop-meta">No animals in <code>sprites/animals/</code></p>`
        return
    }

    list.innerHTML = state.animalSkins.map((entry) => `
        <div class="animal-list-item">
            <div class="animal-list-thumb" style="${animalThumbStyle(entry)}"></div>
            <div class="animal-list-meta">
                <strong>${entry.id}</strong>
                <span>${entry.width}×${entry.height}${entry.customFrames ? " · custom" : ""}</span>
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-edit-animal="${entry.id}">Edit frames</button>
        </div>
    `).join("")
}

async function openAnimalFrameEditor(animalId) {
    const res = await fetch(`/api/animals/${encodeURIComponent(animalId)}/frames`)
    const data = await res.json()
    if (!res.ok) {
        showToast(data.error || "Could not load animal frames", true)
        return
    }

    const img = new Image()
    img.src = `/sprites/animals/${data.animal.file}?v=${Date.now()}`
    await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error("Could not load animal image"))
    })

    state.animalFrameEditor = {
        open: true,
        editorKind: "animal",
        animal: data.animal,
        frames: { ...(data.frames || {}) },
        direction: "down",
        slot: 0,
        displayScale: data.displayScale || data.animal.displayScale || 1,
        frameMs: 120,
        customFrames: Boolean(data.customFrames),
        image: img,
        drag: null,
        canvasLayout: null,
    }

    const modal = document.getElementById("animal-frame-modal")
    modal?.classList.remove("hidden")
    modal?.setAttribute("aria-hidden", "false")
    document.getElementById("animal-frame-title").textContent = `${data.animal.id} sprite frames`
    document.getElementById("animal-frame-scale").value = String(state.animalFrameEditor.displayScale)
    document.getElementById("animal-frame-directions")?.classList.remove("hidden")
    document.getElementById("animal-frame-ms-wrap")?.classList.add("hidden")
    document.getElementById("anim-gear-use-wrap")?.classList.add("hidden")
    document.getElementById("anim-gear-use-help")?.classList.add("hidden")
    document.getElementById("animal-frame-help").textContent =
        "Idle uses frame 1 · scale targets ~48px on the tile grid"
    syncAnimationEditorChrome()

    renderAnimalFrameSidebar()
    resizeAnimalFrameCanvas()
    drawAnimalFrameCanvas()
}

function closeAnimalFrameEditor() {
    state.animalFrameEditor.open = false
    state.animalFrameEditor.drag = null
    const modal = document.getElementById("animal-frame-modal")
    modal?.classList.add("hidden")
    modal?.setAttribute("aria-hidden", "true")
}

function renderAnimalFrameSidebar() {
    const editor = state.animalFrameEditor
    const isAnim = editor.editorKind === "animation"
    const dirWrap = document.getElementById("animal-frame-directions")
    const slotWrap = document.getElementById("animal-frame-slots")
    if (!slotWrap) return

    if (dirWrap) {
        dirWrap.classList.toggle("hidden", isAnim)
        if (!isAnim) {
            dirWrap.innerHTML = ANIMAL_DIRECTIONS.map((direction) => `
                <button type="button" class="animal-frame-dir ${direction === editor.direction ? "active" : ""}" data-direction="${direction}">
                    ${direction}
                </button>
            `).join("")
        }
    }

    const slotCount = isAnim ? ANIMATION_LOOP_SLOTS : ANIMAL_FRAMES_PER_DIR
    slotWrap.innerHTML = Array.from({ length: slotCount }, (_, slot) => {
        const key = animalFrameKey(editor.direction, slot)
        const hasFrame = Boolean(editor.frames[key])
        const idleLabel = !isAnim && slot === 1 ? " · idle" : ""
        return `
            <button type="button" class="animal-frame-slot ${slot === editor.slot ? "active" : ""} ${hasFrame ? "has-frame" : ""}" data-slot="${slot}">
                ${slot}${idleLabel}
            </button>
        `
    }).join("")
}

function computeAnimalFrameCanvasLayout() {
    const editor = state.animalFrameEditor
    const canvas = document.getElementById("animal-frame-canvas")
    const wrap = canvas?.parentElement
    if (!canvas || !wrap || !editor.animal) {
        return { scale: 1, offsetX: 0, offsetY: 0, drawW: 0, drawH: 0, canvasW: 0, canvasH: 0 }
    }

    const canvasW = wrap.clientWidth
    const canvasH = wrap.clientHeight
    const maxW = Math.max(240, canvasW - 24)
    const maxH = Math.max(240, canvasH - 24)
    const scale = Math.min(maxW / editor.animal.width, maxH / editor.animal.height, 1)
    const drawW = editor.animal.width * scale
    const drawH = editor.animal.height * scale

    return {
        scale,
        offsetX: (canvasW - drawW) / 2,
        offsetY: (canvasH - drawH) / 2,
        drawW,
        drawH,
        canvasW,
        canvasH,
    }
}

function syncAnimalFrameCanvasLayout() {
    const canvas = document.getElementById("animal-frame-canvas")
    const layout = computeAnimalFrameCanvasLayout()
    if (canvas && (canvas.width !== layout.canvasW || canvas.height !== layout.canvasH)) {
        canvas.width = layout.canvasW
        canvas.height = layout.canvasH
    }
    state.animalFrameEditor.canvasLayout = layout
    return layout
}

function getAnimalFrameCanvasLayout() {
    return state.animalFrameEditor.canvasLayout || syncAnimalFrameCanvasLayout()
}

function animalFrameCanvasLayout() {
    return syncAnimalFrameCanvasLayout()
}

function canvasPointToSprite(e, layout) {
    const canvas = document.getElementById("animal-frame-canvas")
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left - layout.offsetX) / layout.scale
    const y = (e.clientY - rect.top - layout.offsetY) / layout.scale
    return { x, y }
}

function spriteRectToCanvas(rect, layout) {
    return {
        x: layout.offsetX + rect.x * layout.scale,
        y: layout.offsetY + rect.y * layout.scale,
        w: rect.w * layout.scale,
        h: rect.h * layout.scale,
    }
}

const FRAME_HANDLE_SIZE = 8
const FRAME_HANDLE_CURSORS = {
    nw: "nwse-resize",
    n: "ns-resize",
    ne: "nesw-resize",
    e: "ew-resize",
    se: "nwse-resize",
    s: "ns-resize",
    sw: "nesw-resize",
    w: "ew-resize",
}

function pointInSpriteRect(point, rect) {
    return (
        point.x >= rect.x &&
        point.x <= rect.x + rect.w &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.h
    )
}

function clampFrameRect(rect, maxW, maxH, minSize = 1) {
    let { x, y, w, h } = rect
    w = Math.max(minSize, Math.round(w))
    h = Math.max(minSize, Math.round(h))
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0) {
        w += x
        x = 0
    }
    if (y < 0) {
        h += y
        y = 0
    }
    if (x + w > maxW) w = maxW - x
    if (y + h > maxH) h = maxH - y
    w = Math.max(minSize, w)
    h = Math.max(minSize, h)
    return { x, y, w, h }
}

function hitFrameHandle(point, rect, layout) {
    const box = spriteRectToCanvas(rect, layout)
    const hs = FRAME_HANDLE_SIZE
    const half = hs / 2
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    const handles = [
        { id: "nw", x: box.x, y: box.y },
        { id: "n", x: cx, y: box.y },
        { id: "ne", x: box.x + box.w, y: box.y },
        { id: "e", x: box.x + box.w, y: cy },
        { id: "se", x: box.x + box.w, y: box.y + box.h },
        { id: "s", x: cx, y: box.y + box.h },
        { id: "sw", x: box.x, y: box.y + box.h },
        { id: "w", x: box.x, y: cy },
    ]
    for (const handle of handles) {
        if (
            point.x >= handle.x - half &&
            point.x <= handle.x + half &&
            point.y >= handle.y - half &&
            point.y <= handle.y + half
        ) {
            return handle.id
        }
    }
    return null
}

function gearAttachCanvasPointFromEvent(e) {
    const canvas = document.getElementById("gear-attach-canvas")
    const rect = canvas?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
    }
}

function canvasPointFromEvent(e, layout) {
    const canvas = document.getElementById("animal-frame-canvas")
    const rect = canvas.getBoundingClientRect()
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
    }
}

function applyFrameResize(origin, handle, dx, dy, maxW, maxH) {
    let { x, y, w, h } = { ...origin }

    if (handle.includes("e")) w += dx
    if (handle.includes("w")) {
        x += dx
        w -= dx
    }
    if (handle.includes("s")) h += dy
    if (handle.includes("n")) {
        y += dy
        h -= dy
    }

    if (w < 0) {
        x += w
        w = -w
    }
    if (h < 0) {
        y += h
        h = -h
    }

    return clampFrameRect({ x, y, w, h }, maxW, maxH)
}

function findFrameHit(point, frames, preferredKey) {
    const hits = []
    for (const [key, rect] of Object.entries(frames)) {
        if (pointInSpriteRect(point, rect)) hits.push({ key, rect })
    }
    if (!hits.length) return null
    const preferred = hits.find((hit) => hit.key === preferredKey)
    return preferred || hits[hits.length - 1]
}

function selectAnimalFrameFromKey(key) {
    const parsed = parseAnimalFrameKey(key)
    if (!parsed) return
    if (parsed.kind === "loop") {
        state.animalFrameEditor.slot = parsed.slot
        return
    }
    state.animalFrameEditor.direction = parsed.direction
    state.animalFrameEditor.slot = parsed.slot
}

function drawFrameResizeHandles(ctx, box) {
    const hs = FRAME_HANDLE_SIZE
    const half = hs / 2
    const points = [
        [box.x, box.y],
        [box.x + box.w / 2, box.y],
        [box.x + box.w, box.y],
        [box.x + box.w, box.y + box.h / 2],
        [box.x + box.w, box.y + box.h],
        [box.x + box.w / 2, box.y + box.h],
        [box.x, box.y + box.h],
        [box.x, box.y + box.h / 2],
    ]
    ctx.fillStyle = "#facc15"
    ctx.strokeStyle = "#1a1d24"
    ctx.lineWidth = 1.5
    for (const [px, py] of points) {
        ctx.fillRect(px - half, py - half, hs, hs)
        ctx.strokeRect(px - half + 0.5, py - half + 0.5, hs - 1, hs - 1)
    }
}

function updateAnimalFrameCursor(e, layout) {
    const canvas = document.getElementById("animal-frame-canvas")
    const editor = state.animalFrameEditor
    if (!canvas || !editor.open) return

    const canvasPoint = canvasPointFromEvent(e, layout)
    const spritePoint = {
        x: (canvasPoint.x - layout.offsetX) / layout.scale,
        y: (canvasPoint.y - layout.offsetY) / layout.scale,
    }
    const preferredKey = animalFrameKey(editor.direction, editor.slot)
    const hit = findFrameHit(spritePoint, editor.frames, preferredKey)

    if (hit) {
        const handle = hitFrameHandle(canvasPoint, hit.rect, layout)
        if (handle) {
            canvas.style.cursor = FRAME_HANDLE_CURSORS[handle] || "crosshair"
            return
        }
        canvas.style.cursor = "move"
        return
    }
    canvas.style.cursor = "crosshair"
}

function drawAnimalFrameCanvas() {
    const editor = state.animalFrameEditor
    const canvas = document.getElementById("animal-frame-canvas")
    if (!canvas || !editor.open || !editor.animal || !editor.image) return

    const ctx = canvas.getContext("2d")
    const layout = syncAnimalFrameCanvasLayout()

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = "#12151a"
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.imageSmoothingEnabled = false
    ctx.drawImage(editor.image, layout.offsetX, layout.offsetY, layout.drawW, layout.drawH)

    for (const [key, rect] of Object.entries(editor.frames)) {
        const parsed = parseAnimalFrameKey(key)
        if (!parsed) continue
        const box = spriteRectToCanvas(rect, layout)
        let color
        let selected
        let label
        if (parsed.kind === "loop") {
            color = ANIM_LOOP_COLOR
            selected = parsed.slot === editor.slot
            label = String(parsed.slot)
        } else {
            color = ANIMAL_DIR_COLORS[parsed.direction] || "rgba(255,255,255,0.25)"
            selected = parsed.direction === editor.direction && parsed.slot === editor.slot
            label = `${parsed.direction[0]}${parsed.slot}`
        }

        ctx.fillStyle = color
        ctx.fillRect(box.x, box.y, box.w, box.h)
        ctx.strokeStyle = selected ? "#facc15" : "rgba(255,255,255,0.85)"
        ctx.lineWidth = selected ? 3 : 1.5
        ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)

        ctx.fillStyle = selected ? "#facc15" : "#ffffff"
        ctx.font = "11px sans-serif"
        ctx.fillText(label, box.x + 4, box.y + 13)

        if (selected && !isAnimationEditor()) {
            drawFrameResizeHandles(ctx, box)
        }
    }

    if (editor.drag?.preview) {
        const box = spriteRectToCanvas(editor.drag.preview, layout)
        ctx.strokeStyle = "#facc15"
        ctx.lineWidth = 2
        ctx.setLineDash([6, 4])
        ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
        ctx.setLineDash([])
    }
}

function resizeAnimalFrameCanvas() {
    state.animalFrameEditor.canvasLayout = null
    drawAnimalFrameCanvas()
}

function resetAnimalFrameGrid() {
    const editor = state.animalFrameEditor
    if (!editor.animal) return

    if (editor.editorKind === "animation") {
        const { w: frameW, h: frameH } = readAnimationFixedSizeInputs()
        editor.fixedFrameW = frameW
        editor.fixedFrameH = frameH
        const frames = {}
        for (let slot = 0; slot < ANIMATION_LOOP_SLOTS; slot++) {
            const col = slot % ANIMATION_LOOP_COLS
            const row = Math.floor(slot / ANIMATION_LOOP_COLS)
            frames[`loop_${slot}`] = {
                x: col * frameW,
                y: row * frameH,
                w: frameW,
                h: frameH,
            }
        }
        editor.frames = frames
        editor.customFrames = false
        renderAnimalFrameSidebar()
        drawAnimalFrameCanvas()
        return
    }

    const cols = editor.animal.columns || ANIMAL_FRAMES_PER_DIR
    const rows = editor.animal.rows || ANIMAL_DIRECTIONS.length
    const frameW = Math.round(editor.animal.width / cols)
    const frameH = Math.round(editor.animal.height / rows)
    const frames = {}

    for (let row = 0; row < rows; row++) {
        const direction = ANIMAL_DIRECTIONS[row] || `row_${row}`
        for (let col = 0; col < cols; col++) {
            frames[animalFrameKey(direction, col)] = {
                x: col * frameW,
                y: row * frameH,
                w: frameW,
                h: frameH,
            }
        }
    }

    editor.frames = frames
    editor.customFrames = false
    renderAnimalFrameSidebar()
    drawAnimalFrameCanvas()
}

async function saveAnimalFrameEditor() {
    const editor = state.animalFrameEditor
    if (!editor.animal) return

    const displayScale = Number(document.getElementById("animal-frame-scale")?.value)

    if (editor.editorKind === "animation") {
        const frameMs = Number(document.getElementById("animal-frame-ms")?.value)
        const { w: frameW, h: frameH } = readAnimationFixedSizeInputs()
        const gearUseTarget = document.getElementById("anim-gear-use-target")?.checked
        const normalizedFrames = normalizeAnimationFramesForSave(editor.frames)
        const res = await fetch(`/api/animations/${encodeURIComponent(editor.animal.id)}/frames`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                frames: normalizedFrames,
                displayScale: Number.isFinite(displayScale) ? displayScale : editor.displayScale,
                frameMs: Number.isFinite(frameMs) ? frameMs : editor.frameMs,
                frameWidth: frameW,
                frameHeight: frameH,
                gearUseTarget: Boolean(gearUseTarget),
            }),
        })
        const data = await res.json()
        if (!res.ok) {
            showToast(data.error || "Could not save animation frames", true)
            return
        }

        editor.customFrames = true
        editor.frames = normalizedFrames
        editor.frameMs = data.frameMs || editor.frameMs
        if (data.animation) {
            const idx = state.animationSkins.findIndex((entry) => entry.id === data.animation.id)
            if (idx >= 0) state.animationSkins[idx] = data.animation
            else state.animationSkins.push(data.animation)
        }

        const catalogRes = await fetch("/api/sprites")
        state.catalog = await catalogRes.json()
        renderAnimationList()
        renderSpriteGrid({ preserveScroll: true })
        showToast(data.message || "Animation frames saved")
        return
    }

    const res = await fetch(`/api/animals/${encodeURIComponent(editor.animal.id)}/frames`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            frames: editor.frames,
            displayScale: Number.isFinite(displayScale) ? displayScale : editor.displayScale,
        }),
    })
    const data = await res.json()
    if (!res.ok) {
        showToast(data.error || "Could not save animal frames", true)
        return
    }

    editor.customFrames = true
    if (data.animal) {
        const idx = state.animalSkins.findIndex((entry) => entry.id === data.animal.id)
        if (idx >= 0) state.animalSkins[idx] = data.animal
        else state.animalSkins.push(data.animal)
    }

    renderAnimalList()
    renderNpcSkinGrid(document.getElementById("npc-skin")?.value || "009")
    showToast(data.message || "Animal frames saved")
}

function bindAnimalFrameEditor() {
    document.getElementById("animal-list")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-edit-animal]")
        if (!btn) return
        openAnimalFrameEditor(btn.dataset.editAnimal)
    })

    document.getElementById("animation-list")?.addEventListener("click", (e) => {
        const editBtn = e.target.closest("[data-edit-animation]")
        if (editBtn) openAnimationFrameEditor(editBtn.dataset.editAnimation)
    })

    document.getElementById("btn-animal-frame-close")?.addEventListener("click", closeAnimalFrameEditor)
    document.getElementById("btn-animal-frame-reset")?.addEventListener("click", resetAnimalFrameGrid)
    document.getElementById("btn-animal-frame-save")?.addEventListener("click", saveAnimalFrameEditor)
    document.getElementById("btn-anim-clear-frames")?.addEventListener("click", clearAnimationFrames)
    document.getElementById("btn-anim-apply-size")?.addEventListener("click", applyFixedFrameSizeToAll)

    document.getElementById("animal-frame-directions")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-direction]")
        if (!btn) return
        state.animalFrameEditor.direction = btn.dataset.direction
        state.animalFrameEditor.slot = 0
        renderAnimalFrameSidebar()
        drawAnimalFrameCanvas()
    })

    document.getElementById("animal-frame-slots")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-slot]")
        if (!btn) return
        state.animalFrameEditor.slot = Number(btn.dataset.slot)
        renderAnimalFrameSidebar()
        drawAnimalFrameCanvas()
    })

    const canvas = document.getElementById("animal-frame-canvas")
    canvas?.addEventListener("pointerdown", (e) => {
        const editor = state.animalFrameEditor
        if (!editor.open || !editor.animal) return

        const layout = animalFrameCanvasLayout()
        const canvasPoint = canvasPointFromEvent(e, layout)
        const start = canvasPointToSprite(e, layout)
        const preferredKey = animalFrameKey(editor.direction, editor.slot)
        const hit = findFrameHit(start, editor.frames, preferredKey)

        if (hit) {
            selectAnimalFrameFromKey(hit.key)
            renderAnimalFrameSidebar()
        }

        const key = animalFrameKey(editor.direction, editor.slot)
        const existing = editor.frames[key]

        if (existing) {
            if (!isAnimationEditor()) {
                const handle = hitFrameHandle(canvasPoint, existing, layout)
                if (handle) {
                    editor.drag = {
                        pointerId: e.pointerId,
                        start,
                        preview: { ...existing },
                        mode: "resize",
                        handle,
                        origin: { ...existing },
                        key,
                    }
                    canvas.setPointerCapture(e.pointerId)
                    drawAnimalFrameCanvas()
                    return
                }
            }
            if (pointInSpriteRect(start, existing)) {
                editor.drag = {
                    pointerId: e.pointerId,
                    start,
                    preview: { ...existing },
                    mode: "move",
                    origin: { ...existing },
                    key,
                }
                canvas.setPointerCapture(e.pointerId)
                drawAnimalFrameCanvas()
                return
            }
        }

        if (isAnimationEditor()) {
            const { w: fw, h: fh } = readAnimationFixedSizeInputs()
            const maxW = editor.animal.width
            const maxH = editor.animal.height
            editor.frames[key] = clampFrameRect(
                {
                    x: Math.round(start.x),
                    y: Math.round(start.y),
                    w: fw,
                    h: fh,
                },
                maxW,
                maxH
            )
            renderAnimalFrameSidebar()
            drawAnimalFrameCanvas()
            return
        }

        editor.drag = {
            pointerId: e.pointerId,
            start,
            preview: { x: start.x, y: start.y, w: 0, h: 0 },
            mode: "draw",
            origin: null,
            key,
        }

        canvas.setPointerCapture(e.pointerId)
        drawAnimalFrameCanvas()
    })

    canvas?.addEventListener("pointermove", (e) => {
        const editor = state.animalFrameEditor
        if (!editor.open) return

        if (!editor.drag || editor.drag.pointerId !== e.pointerId) {
            updateAnimalFrameCursor(e, getAnimalFrameCanvasLayout())
            return
        }

        const layout = getAnimalFrameCanvasLayout()
        const point = canvasPointToSprite(e, layout)
        const key = editor.drag.key || animalFrameKey(editor.direction, editor.slot)
        const maxW = editor.animal.width
        const maxH = editor.animal.height

        if (editor.drag.mode === "draw") {
            if (isAnimationEditor()) {
                const { w: fw, h: fh } = readAnimationFixedSizeInputs()
                editor.drag.preview = clampFrameRect(
                    {
                        x: Math.round(editor.drag.start.x),
                        y: Math.round(editor.drag.start.y),
                        w: fw,
                        h: fh,
                    },
                    maxW,
                    maxH
                )
            } else {
                const x = Math.min(editor.drag.start.x, point.x)
                const y = Math.min(editor.drag.start.y, point.y)
                const w = Math.abs(point.x - editor.drag.start.x)
                const h = Math.abs(point.y - editor.drag.start.y)
                editor.drag.preview = clampFrameRect(
                    {
                        x: Math.round(x),
                        y: Math.round(y),
                        w: Math.round(w),
                        h: Math.round(h),
                    },
                    maxW,
                    maxH
                )
            }
        } else if (editor.drag.mode === "move" && editor.drag.origin) {
            const size = isAnimationEditor()
                ? readAnimationFixedSizeInputs()
                : { w: editor.drag.origin.w, h: editor.drag.origin.h }
            editor.drag.preview = clampFrameRect(
                {
                    x: Math.round(editor.drag.origin.x + (point.x - editor.drag.start.x)),
                    y: Math.round(editor.drag.origin.y + (point.y - editor.drag.start.y)),
                    w: size.w,
                    h: size.h,
                },
                maxW,
                maxH
            )
        } else if (editor.drag.mode === "resize" && editor.drag.origin && editor.drag.handle) {
            editor.drag.preview = applyFrameResize(
                editor.drag.origin,
                editor.drag.handle,
                point.x - editor.drag.start.x,
                point.y - editor.drag.start.y,
                maxW,
                maxH
            )
        }

        editor.frames[key] = { ...editor.drag.preview }
        drawAnimalFrameCanvas()
    })

    const finishDrag = (e) => {
        const editor = state.animalFrameEditor
        if (!editor.drag || editor.drag.pointerId !== e.pointerId) return
        editor.drag = null
        canvas?.releasePointerCapture(e.pointerId)
        renderAnimalFrameSidebar()
        drawAnimalFrameCanvas()
        updateAnimalFrameCursor(e, getAnimalFrameCanvasLayout())
    }

    canvas?.addEventListener("pointerup", finishDrag)
    canvas?.addEventListener("pointercancel", finishDrag)

    window.addEventListener("resize", () => {
        if (state.animalFrameEditor.open) resizeAnimalFrameCanvas()
    })
}

async function init() {
    bindEvents()
    try {
        await loadCharacters()
        await loadAnimals()
        await loadAnimations()
        await loadGearItems()
        await loadCatalog()
        await loadMap()
        renderSheetTabs()
        renderSpriteGrid()
        updateStats()
        pushHistory()
        document.getElementById("loading").classList.add("hidden")
        syncTools()
        resizeCanvas()
        updatePlacementEditor()
    } catch (err) {
        document.getElementById("loading-text").textContent = "Failed to load: " + err.message
    }
}

init()
