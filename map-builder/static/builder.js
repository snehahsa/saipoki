const TILE = 32
const DEFAULT_ROOM_NAME = "SaiPoke Realm"
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
    npcs: [],
    selectedNpcIndex: 0,
    selectedMessageTile: null,
    roomMeta: {},
    characterSkins: [],
    animalSkins: [],
    avatarCosts: {},
    rooms: [],
    portalPreview: null,
    portalPreviewReturn: 0,
    portalPick: null,
    animalFrameEditor: {
        open: false,
        animal: null,
        frames: {},
        direction: "down",
        slot: 0,
        displayScale: 1,
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

function collectPortalConnections() {
    return collectAllPortals()
        .filter((enter) => {
            const room = state.rooms[enter.sourceRoomIndex]
            return !room?.tilemap?.[enter.sourceKey]?.interaction?.portalAutoReturn
        })
        .map((enter) => ({
            enter,
            exit: resolveExitForEnter(enter),
        }))
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

    if (sourceRoomIndex !== state.roomIndex) {
        loadRoomIntoEditor(sourceRoomIndex, { skipHistory: true })
        state.selectedMessageTile = sourceKey
        state.tool = "message"
        syncTools()
    } else {
        state.selectedMessageTile = sourceKey
        setInteraction(sourceKey, readMessageFieldsFromDom(), { refreshOptionsUI: false })
    }

    pushHistory()
    updateMessageEditor()
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
    state.roomMeta = { channelId: room.channelId }
    state.selectedNpcIndex = Math.min(state.selectedNpcIndex, Math.max(0, state.npcs.length - 1))
    state.selectedMessageTile = null
    state.selectedPlacement = null

    document.getElementById("room-name").value = state.roomName
    document.getElementById("room-map-id").value = getRoomId(room, index)

    updateNpcEditor()
    updateMessageEditor()
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
    loadRoomIntoEditor(newIndex)
    showToast(`Added ${defaultRoomNameForIndex(newIndex)}`)
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
    const select = document.getElementById("portal-map-id")
    if (!select) return
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
}

function renderPortalList() {
    const list = document.getElementById("portal-list")
    if (!list) return
    const connections = collectPortalConnections()
    list.innerHTML = ""
    if (!connections.length) {
        list.innerHTML =
            '<p class="prop-meta interaction-options-empty">No portal connections yet. Use Messages or the buttons below to add one.</p>'
        return
    }

    connections.forEach((connection) => {
        const { enter, exit } = connection
        const card = document.createElement("div")
        card.className = "portal-card"
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
    state.selectedPlacement = null
    state.selectedMessageTile = null
    updateStats()
    updatePlacementEditor()
    updateNpcEditor()
    updateMessageEditor()
    draw()
}

function getSpriteById(id) {
    return state.catalog?.sprites.find((s) => s.id === id) || null
}

function getSheetImage(sheetName) {
    return state.sheetImages[sheetName]
}

function spriteAnchor(sprite) {
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

function drawSpriteOnCtx(targetCtx, sprite, tx, ty, placementVal) {
    const img = sprite.url ? state.spriteImages[sprite.id] : getSheetImage(sprite.sheet)
    if (!img) return
    const placement = normalizePlacement(placementVal)
    const scale = placement?.scale ?? 1
    const px = tx * TILE
    const py = ty * TILE
    const anchor = spriteAnchor(sprite)
    const dw = sprite.width * scale
    const dh = sprite.height * scale
    const dx = px - dw * anchor.x
    const dy = py - dh * anchor.y
    const sx = sprite.url ? 0 : sprite.x
    const sy = sprite.url ? 0 : sprite.y
    targetCtx.drawImage(
        img,
        sx, sy, sprite.width, sprite.height,
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
            const anchor = spriteAnchor(sprite)
            const topRows = Math.ceil((sprite.height * scale * anchor.y) / TILE)
            const rightCols = Math.ceil((sprite.width * scale * (1 - anchor.x)) / TILE)
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
            const anchor = spriteAnchor(sprite)
            const dw = (sprite?.width || TILE) * scale
            const dh = (sprite?.height || TILE) * scale
            const dx = x * TILE - dw * anchor.x
            const dy = y * TILE - dh * anchor.y
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
    drawPortalPreviewOverlay(ctx)
    if (state.tool === "boundaries") drawMapNameBanner(ctx)

    ctx.restore()
    updateMapNameOverlay()
}

function drawInteractionMarkers(targetCtx) {
    for (const [key, cell] of Object.entries(state.tilemap)) {
        const interaction = cell.interaction
        const hasPortal = !!interaction?.portal?.mapId
        if (!interaction?.title && !interaction?.message && !hasPortal) continue
        const { x, y } = parseKey(key)
        const px = x * TILE + TILE / 2
        const py = y * TILE + 6 / state.zoom
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
    state.tilemap[key][layer] = compactPlacement({ id: spriteId, scale: scale ?? 1 })
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
                state.paintScale = normalizePlacement(raw)?.scale ?? sprite.defaultScale ?? 1
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

    if (state.tool === "message") {
        selectMessageTile(x, y)
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

    if (state.tool === "paint" && state.selectedSprite) {
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
        const scale = spritePreviewScale(sprite, maxSize)
        const w = Math.max(1, Math.round(sprite.width * scale))
        const h = Math.max(1, Math.round(sprite.height * scale))
        el.style.width = `${w}px`
        el.style.height = `${h}px`
        el.style.backgroundImage = `url(${sprite.url})`
        el.style.backgroundSize = "contain"
        el.style.backgroundRepeat = "no-repeat"
        el.style.backgroundPosition = "center"
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
    state.paintScale = sprite.defaultScale ?? 1
    state.tool = state.tool === "boundaries" ? "boundaries"
        : state.tool === "message" ? "message"
        : state.tool === "npc" ? "npc"
        : state.tool === "avatars" ? "avatars" : "paint"
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

function selectNpcSkin(skin) {
    const npc = getSelectedNpc()
    if (!npc) return
    pushHistory()
    npc.skin = skin
    document.getElementById("npc-skin").value = skin
    renderNpcSkinGrid(skin)
    draw()
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
        showToast("Click a tile with a placed sprite", true)
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
            const questStep = String(flow?.questStep || "").trim()
            const questId = String(flow?.questId || "").trim()
            const requires = {}
            if (holds.length) requires.holds = holds
            if (notHolds.length) requires.notHolds = notHolds
            const payload = { messages }
            if (Object.keys(requires).length) payload.requires = requires
            if (grantHold) payload.grantHold = grantHold
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
        const questStep = card.querySelector(".flow-quest-step")?.value.trim() || ""
        const questId = card.querySelector(".flow-quest-id")?.value.trim() || ""
        const requires = {}
        if (holds.length) requires.holds = holds
        if (notHolds.length) requires.notHolds = notHolds
        const payload = { messages }
        if (Object.keys(requires).length) payload.requires = requires
        if (grantHold) payload.grantHold = grantHold
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
        card.innerHTML = `
            <div class="npc-flow-card-head">
                <strong>Flow ${index + 1}</strong>
                <button type="button" class="btn btn-ghost btn-sm flow-remove" aria-label="Remove flow">×</button>
            </div>
            <div class="npc-flow-grid">
                <input type="text" class="flow-holds" placeholder="requires holds (bag)" list="hold-item-ids" value="${escapeAttr(holds)}">
                <input type="text" class="flow-not-holds" placeholder="requires not holds" list="hold-item-ids" value="${escapeAttr(notHolds)}">
                <input type="text" class="flow-grant-hold" placeholder="grant hold" list="hold-item-ids" value="${escapeAttr(flow.grantHold || "")}">
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
        state.tool = "message"
        syncTools()
        startPortalPick("enter", {})
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

    wrap.addEventListener("contextmenu", (e) => e.preventDefault())

    wrap.addEventListener("pointerdown", (e) => {
        if (shouldPan(e)) {
            e.preventDefault()
            startPan(e)
            return
        }
        if (e.button !== 0) return
        const rect = canvas.getBoundingClientRect()
        const tile = screenToTile(e.clientX - rect.left, e.clientY - rect.top)
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
}

function syncTools() {
    const isBoundary = state.tool === "boundaries"
    const isMessage = state.tool === "message"
    const isPortals = state.tool === "portals"
    const isNpc = state.tool === "npc"
    const isAvatars = state.tool === "avatars"
    const isAnimals = state.tool === "animals"
    const isAltCanvas = isBoundary
    document.querySelectorAll(".tool-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tool === state.tool)
    })
    wrap.classList.toggle("pan-tool", state.tool === "pan")
    wrap.classList.toggle("hidden", isAltCanvas)
    boundaryWrap.classList.toggle("hidden", !isBoundary)
    document.getElementById("paint-props").classList.toggle(
        "hidden",
        isAltCanvas || isMessage || isPortals || isNpc || isAvatars || isAnimals || state.selectedPlacement || !state.selectedSprite
    )
    document.getElementById("placement-props").classList.toggle(
        "hidden",
        isAltCanvas || isMessage || isPortals || isNpc || isAvatars || isAnimals || !state.selectedPlacement
    )
    document.getElementById("boundary-props").classList.toggle("hidden", !isBoundary)
    document.getElementById("message-props").classList.toggle("hidden", !isMessage)
    document.getElementById("portal-props")?.classList.toggle("hidden", !isPortals)
    document.getElementById("npc-props").classList.toggle("hidden", !isNpc)
    document.getElementById("avatar-props")?.classList.toggle("hidden", !isAvatars)
    document.getElementById("animal-props")?.classList.toggle("hidden", !isAnimals)

    const hints = {
        boundaries: "Click sprite tiles to add boundary points · Right-click undo last point",
        message: "Pick Enter item, choose exit map, then Pick Exit · Purple dot = portal",
        portals: "Each connection has an Enter spot and an Exit spot — both are editable",
        npc: "Select NPC · click map to add patrol waypoints · green dot = start",
        avatars: "Set coin price per trainer avatar · saved with the world map",
        animals: "Draw boxes · drag inside to move · drag yellow handles to resize · click any box to edit it",
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

function animalFrameKey(direction, slot) {
    return `walk_${direction}_${slot}`
}

function parseAnimalFrameKey(key) {
    const match = /^walk_(down|left|right|up)_(\d+)$/.exec(key || "")
    if (!match) return null
    return { direction: match[1], slot: Number(match[2]) }
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
        animal: data.animal,
        frames: { ...(data.frames || {}) },
        direction: "down",
        slot: 0,
        displayScale: data.displayScale || data.animal.displayScale || 1,
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
    const dirWrap = document.getElementById("animal-frame-directions")
    const slotWrap = document.getElementById("animal-frame-slots")
    if (!dirWrap || !slotWrap) return

    dirWrap.innerHTML = ANIMAL_DIRECTIONS.map((direction) => `
        <button type="button" class="animal-frame-dir ${direction === editor.direction ? "active" : ""}" data-direction="${direction}">
            ${direction}
        </button>
    `).join("")

    slotWrap.innerHTML = Array.from({ length: ANIMAL_FRAMES_PER_DIR }, (_, slot) => {
        const key = animalFrameKey(editor.direction, slot)
        const hasFrame = Boolean(editor.frames[key])
        return `
            <button type="button" class="animal-frame-slot ${slot === editor.slot ? "active" : ""} ${hasFrame ? "has-frame" : ""}" data-slot="${slot}">
                ${slot}${slot === 1 ? " · idle" : ""}
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
        const color = ANIMAL_DIR_COLORS[parsed.direction] || "rgba(255,255,255,0.25)"
        const selected = parsed.direction === editor.direction && parsed.slot === editor.slot

        ctx.fillStyle = color
        ctx.fillRect(box.x, box.y, box.w, box.h)
        ctx.strokeStyle = selected ? "#facc15" : "rgba(255,255,255,0.85)"
        ctx.lineWidth = selected ? 3 : 1.5
        ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)

        ctx.fillStyle = selected ? "#facc15" : "#ffffff"
        ctx.font = "11px sans-serif"
        ctx.fillText(`${parsed.direction[0]}${parsed.slot}`, box.x + 4, box.y + 13)

        if (selected) {
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

    document.getElementById("btn-animal-frame-close")?.addEventListener("click", closeAnimalFrameEditor)
    document.getElementById("btn-animal-frame-reset")?.addEventListener("click", resetAnimalFrameGrid)
    document.getElementById("btn-animal-frame-save")?.addEventListener("click", saveAnimalFrameEditor)

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
        } else if (editor.drag.mode === "move" && editor.drag.origin) {
            editor.drag.preview = clampFrameRect(
                {
                    ...editor.drag.origin,
                    x: Math.round(editor.drag.origin.x + (point.x - editor.drag.start.x)),
                    y: Math.round(editor.drag.origin.y + (point.y - editor.drag.start.y)),
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
