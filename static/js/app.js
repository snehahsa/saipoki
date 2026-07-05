const SKINS = window.APP_CONFIG.skins
const DEFAULT_SKIN = window.APP_CONFIG.defaultSkin
const BAG_ITEMS = window.APP_CONFIG.bagItems || []
const POOL_ITEMS = window.APP_CONFIG.poolItems || []
const CARD_CATALOG = window.APP_CONFIG.cardCatalog || {}
const BAG_SLOT_COUNT = window.APP_CONFIG.bagSlotCount || 8
const QUEST_CATALOG = window.APP_CONFIG.quests || []
const HOLD_CATALOG = window.APP_CONFIG.holdCatalog || {}
const GEAR_CATALOG = window.APP_CONFIG.gearCatalog || {}
const FISHING_CATALOG = window.APP_CONFIG.fishingCatalog || {}
const UI_UNLOCKS = window.APP_CONFIG.uiUnlocks || {}
const AVATAR_COSTS = window.APP_CONFIG.avatarCosts || {}
const STARTING_BALANCE = Number(window.APP_CONFIG.startingBalance) || 0
const MIN_WITHDRAW_KINS = Number(window.APP_CONFIG.minWithdrawKins) || 5000
const VENDING_SPIN_FIRST_COST = Number(window.APP_CONFIG.vendingSpinFirstCost) || 1000
const VENDING_SPIN_REPEAT_COST = Number(window.APP_CONFIG.vendingSpinRepeatCost) || 2000
const GAME_JS_URL = window.APP_CONFIG.assets?.gameJs || "/static/game/game.js"
const XP_LEVELS = window.APP_CONFIG.xpLevels || { levels: [], xp_rewards: { quest_step: 5, battle_win: 20 } }

let itemGetCloseResolve = null
let itemGetQueue = Promise.resolve()
let gameClientPromise = null
let gameEventsBound = false

const WORLD_CX = 31
const WORLD_CY = 37
const FLOWER_PATCH = 21
const MAIN_W = 63
const MAIN_H = 74

let session = null
let pinVerified = false
let pinMode = "setup"
let pinBuffer = ""
let skinIndex = 0
let profileSelectedSkin = null
let skinSetupStep = "name"
let statsInterval = null
let menuStatsInterval = null
let positionHandler = null

const QUICKBAR_SLOT_COUNT = window.APP_CONFIG.gearSlotCount || 3
let quickbarSelectedSlot = -1
let quickbarHintTimer = null
let activeFishingMode = localStorage.getItem("saipoke_fishing_mode") || "fish"
let gearModeMenuSlot = -1
let gearModeMenuPinned = false
let suppressQuickbarSlotUntil = 0
let fishingCastActive = false
let fishingCastAbort = null
let fishingRetryPromptPromise = null

const tg = window.Telegram?.WebApp
const PLAY_MODE = Boolean(window.APP_CONFIG?.playMode)
const WALLET_CHECK = Number(window.APP_CONFIG?.walletCheck ?? 1)
const WALLET_STORAGE_KEY = "pokequest_wallet_session"
const GUEST_STORAGE_KEY = "pokequest_guest_id"
let playSpectatorMode = false
const TEST_QUERY_RESERVED = new Set(["tgWebAppStartParam", "v", "_"])

function normalizeTestSlug(raw) {
    const slug = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "")
    return slug.slice(0, 24)
}

function parseTestPlayerSlug() {
    if (window.APP_CONFIG?.testMode) {
        return normalizeTestSlug(window.APP_CONFIG.testPlayerSlug || "")
    }
    try {
        const params = new URLSearchParams(window.location.search)
        if (params.get("tgWebAppStartParam")?.toLowerCase() === "test") return ""
        if (params.has("test")) {
            const explicit = normalizeTestSlug(params.get("test"))
            if (explicit) return explicit
            for (const key of params.keys()) {
                if (!TEST_QUERY_RESERVED.has(key) && key !== "test") {
                    return normalizeTestSlug(key)
                }
            }
            return ""
        }
        const aliases = [...params.keys()].filter((key) => !TEST_QUERY_RESERVED.has(key))
        if (aliases.length === 1) return normalizeTestSlug(aliases[0])
    } catch {
        /* ignore */
    }
    const tgParam = (tg?.initDataUnsafe?.start_param || "").trim().toLowerCase()
    if (tgParam === "test") return ""
    return null
}

function detectTestMode() {
    return parseTestPlayerSlug() !== null
}

const TEST_MODE = detectTestMode()
const TEST_PLAYER_SLUG = TEST_MODE ? (parseTestPlayerSlug() ?? "") : ""

function getActiveGuestId() {
    return String(localStorage.getItem(GUEST_STORAGE_KEY) || "").trim()
}

function walletRequired() {
    return WALLET_CHECK !== 0
}

function guestPlayMode() {
    return PLAY_MODE && !walletRequired()
}

function syncWelcomeCopy() {
    const footnote = document.querySelector(".welcome-footnote")
    if (!footnote) return
    footnote.textContent = guestPlayMode()
        ? "Enter your trainer name & choose your avatar"
        : "Set a PIN, enter your trainer name & choose your avatar"
}

function questTitleForId(questId) {
    const quest = QUEST_CATALOG.find((item) => item.quest_id === questId)
    return quest?.title || questId
}

function formatNextLevelRequirements(stats) {
    if (!stats || stats.next_level == null) return ""
    const parts = []
    if (Number(stats.wins_to_next_level) > 0) {
        const n = Number(stats.wins_to_next_level)
        parts.push(`${n} more win${n === 1 ? "" : "s"}`)
    }
    if (Array.isArray(stats.blocking_quests) && stats.blocking_quests.length) {
        parts.push(`complete ${stats.blocking_quests.map(questTitleForId).join(" & ")}`)
    }
    return parts.join(" · ")
}

function showXpGainToast(amount) {
    const stack = document.getElementById("join-toast-stack")
    if (!stack || !amount) return
    const toast = document.createElement("div")
    toast.className = "join-toast"
    toast.textContent = `+${amount} XP`
    stack.appendChild(toast)
    setTimeout(() => toast.remove(), 2400)
}

function showLevelUpToast(level, title, xpGained) {
    const stack = document.getElementById("join-toast-stack")
    if (!stack) return
    const toast = document.createElement("div")
    toast.className = "join-toast join-toast-levelup"
    toast.innerHTML = `<strong>LEVEL UP!</strong><br>Lv.${level} · ${escapeLbText(title || "Trainer")}${xpGained ? ` · +${Number(xpGained)} XP` : ""}`
    stack.appendChild(toast)
    setTimeout(() => toast.remove(), 4500)
}

function renderProfileXp() {
    const stats = session?.trainer_stats
    if (stats) {
        const lvlEl = document.getElementById("profile-level")
        const xpEl = document.getElementById("profile-xp")
        const fill = document.getElementById("profile-xpfill")
        const hint = document.getElementById("profile-xp-hint")
        const level = Number(stats.level ?? 0)
        if (lvlEl) lvlEl.textContent = `Lv.${level} · ${stats.level_title || "Trainer"}`
        if (xpEl) xpEl.textContent = `${Number(stats.stats_xp ?? 0)} XP`
        const span = Math.max(1, Number(stats.xp_span ?? 1))
        const into = Number(stats.xp_into_level ?? 0)
        if (fill) fill.style.width = `${Math.min(100, (into / span) * 100)}%`
        if (hint) {
            const req = formatNextLevelRequirements(stats)
            hint.textContent = req ? `Next level: ${req}` : (stats.level_description || "")
        }
    }
    renderGameHudXp()
}

function renderGameHudXp() {
    const stats = session?.trainer_stats
    const level = Number(session?.level ?? stats?.level ?? 0)
    const title = stats?.level_title || "Newcomer"
    const xp = Number(stats?.stats_xp ?? 0)
    const lvlEl = document.getElementById("stat-level")
    const xpEl = document.getElementById("stat-xp")
    if (lvlEl) lvlEl.textContent = `${level} · ${title}`
    if (xpEl) xpEl.textContent = String(xp)
}

function applyTrainerStats(stats, meta = {}) {
    if (!stats || !session) return
    const prevLevel = Number(session.level ?? session.trainer_stats?.level ?? 0)
    session.trainer_stats = stats
    session.level = Number(stats.level ?? 0)
    populateMenu()
    renderProfileXp()
    const nextLevel = Number(stats.level ?? 0)
    const leveledUp = Boolean(meta.leveled_up) || (nextLevel > prevLevel && nextLevel > 0)
    if (leveledUp) {
        showLevelUpToast(nextLevel, stats.level_title, meta.xp_gained)
    } else if (Number(meta.xp_gained) > 0) {
        showXpGainToast(Number(meta.xp_gained))
    }
}

function isSignedIn() {
    if (TEST_MODE) return true
    if (tg?.initData) return true
    if (PLAY_MODE && playSpectatorMode) return true
    if (PLAY_MODE && walletRequired() && sessionStorage.getItem(WALLET_STORAGE_KEY)) return true
    if (PLAY_MODE && !walletRequired() && getActiveGuestId()) return true
    return false
}

function apiAuthBody(extra = {}) {
    const body = { ...extra }
    if (TEST_MODE) {
        body.testMode = true
        body.testPlayer = TEST_PLAYER_SLUG
    } else if (tg?.initData) {
        body.initData = tg.initData
    } else if (PLAY_MODE) {
        if (walletRequired()) {
            const walletSession = sessionStorage.getItem(WALLET_STORAGE_KEY)
            if (walletSession) body.walletSession = walletSession
        } else {
            const guestId = getActiveGuestId()
            if (guestId) body.guestId = guestId
        }
        if (playSpectatorMode) body.spectator = true
    }
    return body
}

function hidePlayLanding() {
    document.getElementById("play-landing")?.classList.add("is-hidden")
    document.body.classList.add("play-in-app")
    window.SaiPokePlay?.syncWalletConnectedUi?.()
}

function showPlayLanding() {
    document.getElementById("play-landing")?.classList.remove("is-hidden")
    document.body.classList.remove("play-in-app", "spectator-mode", "game-active", "dialogue-active")
    Object.values(screens).forEach((el) => el?.classList.add("hidden"))
    window.SaiPokePlay?.closeGuestProfileFlow?.()
    window.SaiPokePlay?.syncWalletConnectedUi?.()
}

try {
    tg?.expand?.()
    tg?.disableVerticalSwipes?.()
} catch {
    /* ignore */
}
const screens = {
    loading: document.getElementById("loading-screen"),
    error: document.getElementById("error-screen"),
    welcome: document.getElementById("welcome-screen"),
    pin: document.getElementById("pin-screen"),
    skin: document.getElementById("skin-screen"),
    menu: document.getElementById("menu-screen"),
    profile: document.getElementById("profile-screen"),
    bag: document.getElementById("bag-screen"),
    quests: document.getElementById("quests-screen"),
    revenueShare: document.getElementById("revenue-share-screen"),
    leaderboard: document.getElementById("leaderboard-screen"),
    trainerStats: document.getElementById("trainer-stats-screen"),
    game: document.getElementById("game-screen"),
}
let trainerStatsReturnScreen = "menu"

function inFlowerPatch(x, y) {
    const margin = 1
    const end = margin + FLOWER_PATCH - 1
    if (x >= margin && x <= end && y >= margin && y <= end) return "nw"
    if (x >= MAIN_W - margin - FLOWER_PATCH && x <= MAIN_W - margin - 1 && y >= margin && y <= end) return "ne"
    if (x >= margin && x <= end && y >= MAIN_H - margin - FLOWER_PATCH && y <= MAIN_H - margin - 1) return "sw"
    return null
}

function zoneFromPosition(room, x, y) {
    if (room === 1) return "Moonlit Grove"

    const flower = inFlowerPatch(x, y)
    if (flower === "nw") return "Dark Flower Field"
    if (flower === "ne") return "Blue Flower Field"
    if (flower === "sw") return "Vibrant Flower Field"

    const dx = x - WORLD_CX
    const dy = y - WORLD_CY
    const lakeX = WORLD_CX * 0.38
    const lakeY = WORLD_CY * 0.52

    if (((x - lakeX) ** 2) / 124 + ((y - lakeY) ** 2) / 54 < 1 && x < WORLD_CX + 3) {
        return "Crystal Lake"
    }
    if (x > WORLD_CX + 12 && y > WORLD_CY + 7) return "Sunset Beach"
    if (x > WORLD_CX + 9 && Math.abs(y - WORLD_CY) < 15) return "Neon City"
    if (x < WORLD_CX - 11 && y < WORLD_CY + 3) return "Whisper Forest"
    if (x < WORLD_CX - 5 && y > WORLD_CY + 8) return "Wildflower Meadow"
    if (Math.abs(dx) < 8 && Math.abs(dy) < 6) return "Spawn Plaza"
    if (y < WORLD_CY - 8) return "Highland Peaks"
    return "Open Grasslands"
}

async function fetchWorldStats() {
    try {
        const response = await fetch("/health")
        const data = await response.json()
        const players = data.players ?? 0
        const maxPlayers = data.maxPlayers ?? 50

        const menuCount = document.getElementById("menu-live-count")
        if (menuCount) menuCount.textContent = String(players)

        const statPlayers = document.getElementById("stat-players")
        if (statPlayers) statPlayers.textContent = String(players)

        return data
    } catch {
        return null
    }
}

function startMenuStats() {
    stopMenuStats()
    fetchWorldStats()
    menuStatsInterval = setInterval(fetchWorldStats, 5000)
}

function stopMenuStats() {
    if (menuStatsInterval) {
        clearInterval(menuStatsInterval)
        menuStatsInterval = null
    }
}

function startGameHud() {
    stopGameHud()
    syncGameHudDepositUi()
    window.SaiPokePlay?.syncWalletConnectedUi?.()
    if (!window.TelegramGame?.onPlayerPosition) return

    updateBalanceDisplays()
    renderGameHudXp()
    fetchWorldStats()
    statsInterval = setInterval(fetchWorldStats, 3000)

    positionHandler = ({ x, y, room }) => {
        document.getElementById("stat-zone").textContent = zoneFromPosition(room, x, y)
        document.getElementById("stat-coord").textContent = `${x}, ${y}`
    }
    window.TelegramGame.onPlayerPosition(positionHandler)
}

function stopGameHud() {
    if (statsInterval) {
        clearInterval(statsInterval)
        statsInterval = null
    }
    if (positionHandler) {
        window.TelegramGame.offPlayerPosition(positionHandler)
        positionHandler = null
    }
}

function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
        el.classList.toggle("hidden", key !== name)
    })

    document.body.classList.toggle("game-active", name === "game")
    document.body.classList.toggle(
        "sky-plain-bg",
        name === "menu" || name === "welcome" || name === "pin" || name === "skin"
    )

    if (name === "game") {
        document.body.classList.remove("dialogue-active")
    }

    syncRetroAudioForScreen(name)
    window.SaiPokePlay?.syncWalletConnectedUi?.()

    const active = screens[name]
    if (active) {
        requestAnimationFrame(() => {
            void active.offsetHeight
            if (name === "skin") {
                if (skinSetupStep === "picker") {
                    updateBalanceDisplays()
                    updateSkinPreview(sortedSkins[skinIndex])
                }
            }
            if (name === "profile") {
                renderProfileScreen()
            }
        })
    }
}

function setBootMessage(text) {
    const el = document.getElementById("boot-progress-text")
    if (el && text) el.textContent = text
    setLoading(text)
}

function dismissBootSplash() {
    const splash = document.getElementById("tg-boot-splash")
    if (!splash || splash.classList.contains("is-hidden")) return
    splash.classList.add("is-hidden")
    setTimeout(() => splash.remove(), 360)
}

const MENU_AUDIO_SCREENS = new Set([
    "menu", "welcome", "pin", "skin", "profile", "quests", "bag", "revenueShare", "leaderboard", "loading",
])

function syncRetroAudioForScreen(name) {
    if (!window.RetroAudio || window.RetroAudio.isMuted?.()) return
    window.RetroAudio.resume()
    if (document.getElementById("vending-screen") && !document.getElementById("vending-screen").classList.contains("hidden")) {
        window.RetroAudio.setScene("silent")
        return
    }
    if (MENU_AUDIO_SCREENS.has(name)) {
        window.RetroAudio.setScene("menu")
    } else if (name === "game") {
        window.RetroAudio.setScene("overworld")
    }
}

function syncRetroAudioAfterDialogue() {
    if (!window.RetroAudio || window.RetroAudio.isMuted?.()) return
    document.body.classList.remove("dialogue-active")
    if (document.getElementById("vending-screen") && !document.getElementById("vending-screen").classList.contains("hidden")) {
        window.RetroAudio.setScene("silent")
        return
    }
    if (screens.game && !screens.game.classList.contains("hidden")) {
        window.RetroAudio.setScene("overworld")
    } else {
        window.RetroAudio.setScene("menu")
    }
}

function syncAudioMuteUi() {
    const muted = Boolean(window.RetroAudio?.isMuted?.())
    document.querySelectorAll(".audio-mute-btn").forEach((btn) => {
        btn.classList.toggle("is-muted", muted)
        btn.setAttribute("aria-pressed", muted ? "true" : "false")
        btn.setAttribute("aria-label", muted ? "Sound off" : "Sound on")
        btn.title = muted ? "Sound off — tap to unmute" : "Sound on — tap to mute"
        const text = btn.querySelector(".audio-mute-text")
        if (text) text.textContent = muted ? "Muted" : "Sound"
    })
}

function toggleAudioMute() {
    if (!window.RetroAudio?.toggleMuted) return
    window.RetroAudio.toggleMuted()
    syncAudioMuteUi()
}

function bindAudioMuteButtons() {
    document.querySelectorAll(".audio-mute-btn").forEach((btn) => {
        if (btn.dataset.audioMuteBound) return
        btn.dataset.audioMuteBound = "1"
        btn.addEventListener("click", () => {
            toggleAudioMute()
        })
    })
    syncAudioMuteUi()
}

function gameClientReady() {
    return Boolean(window.TelegramGame?.startGame)
}

function loadGameClient() {
    if (gameClientReady()) return Promise.resolve()
    if (gameClientPromise) return gameClientPromise

    gameClientPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script")
        script.src = GAME_JS_URL
        script.async = true
        script.onload = () => {
            if (!gameClientReady()) {
                gameClientPromise = null
                reject(new Error("Game client failed to initialize. Hard refresh and try again."))
                return
            }
            resolve()
        }
        script.onerror = () => {
            gameClientPromise = null
            reject(new Error("Could not load game client"))
        }
        document.body.appendChild(script)
    })

    return gameClientPromise
}

function bindGameEvents() {
    if (gameEventsBound || !window.TelegramGame) return
    gameEventsBound = true

    window.TelegramGame.onGameEvent("showKickedModal", (message) => {
        leaveGame()
        document.getElementById("menu-status").textContent = message
        document.getElementById("menu-status").classList.add("error")
    })

    window.TelegramGame.onGameEvent("showDisconnectModal", () => {
        leaveGame()
        document.getElementById("menu-status").textContent = "Disconnected from server."
        document.getElementById("menu-status").classList.add("error")
    })

    window.TelegramGame.onGameEvent("npcEncounterAlert", () => {
        window.RetroAudio?.resume()
        window.RetroAudio?.sfx("encounter")
        document.body.classList.add("encounter-flash")
        setTimeout(() => document.body.classList.remove("encounter-flash"), 520)
    })

    window.TelegramGame.onGameEvent("showSignModal", showSignModal)
    window.TelegramGame.onGameEvent("hideSignModal", hideSignModal)
    window.TelegramGame.onGameEvent("questStep", ({ step_id, quest_id }) => {
        if (step_id) completeQuestStep(step_id, quest_id)
    })
    window.TelegramGame.onGameEvent("grantHold", ({ item, source }) => {
        if (item) grantHold(item, source || "")
    })

    window.TelegramGame.onGameEvent("grantBalance", ({ grant_id, source }) => {
        if (grant_id) void grantNpcBalance(grant_id, source || "")
    })

    window.TelegramGame.onGameEvent("grantGear", ({ item, source }) => {
        if (item) grantGear(item, source || "")
    })

    window.TelegramGame.onGameEvent("takeGear", ({ item, source }) => {
        if (item) removeGear(item, source || "")
    })

    window.TelegramGame.onGameEvent("gearUsed", ({ item, animId }) => {
        if (fishingCastActive || gearMeta(item)?.default_fishing_quest) return
        const label = gearMeta(item)?.label || item || "Gear"
        showQuickbarHint(`${label} — splash!`)
        keepGearModeMenuOpen()
        if (animId) {
            console.debug("gear used on animation", animId)
        }
    })
    window.TelegramGame.onGameEvent("poketab", (payload) => {
        window.PoketabSocial?.handleRealtime?.(payload)
    })
}

const SKIN_SHEET = 192
const SKIN_FRAME = { x: 48, y: 0, w: 48, h: 48 }
const SKIN_HERO_ZOOM = 3.5
const SKIN_PROFILE_ZOOM = 3
const SKIN_MENU_BOX_FALLBACK = 99
const SKIN_IDLE_DIRECTIONS = [
    { x: 48, y: 0, w: 48, h: 48 },
    { x: 48, y: 48, w: 48, h: 48 },
    { x: 48, y: 96, w: 48, h: 48 },
    { x: 48, y: 144, w: 48, h: 48 },
]
const GAME_LOADING_AVATAR_SIZE = 72
let gameLoadingDirectionTimer = null
let gameLoadingDirectionIndex = 0

function applySpritePreview(el, skin, frame, zoom) {
    if (!el) return
    const url = skinImage(skin)
    el.style.backgroundImage = `url(${url})`
    el.style.backgroundSize = `${SKIN_SHEET * zoom}px ${SKIN_SHEET * zoom}px`
    el.style.backgroundPosition = `-${frame.x * zoom}px -${frame.y * zoom}px`
    el.style.width = `${frame.w * zoom}px`
    el.style.height = `${frame.h * zoom}px`
}

function updateSkinPreview(skin, prefix = "skin") {
    const el = document.getElementById(`${prefix}-preview`) || document.getElementById("skin-preview")
    const counter = document.getElementById(`${prefix}-counter`)
    updateAvatarPriceTag(skin, prefix)
    const zoom = prefix === "profile" ? SKIN_PROFILE_ZOOM : SKIN_HERO_ZOOM

    applySpritePreview(el, skin, SKIN_FRAME, zoom)
    if (counter) {
        const idx = sortedSkins.indexOf(skin)
        counter.textContent = `${idx >= 0 ? idx + 1 : SKINS.indexOf(skin) + 1} / ${sortedSkins.length}`
    }
}

function readMenuAvatarLayout(el) {
    const wrap = el?.closest(".menu-avatar-wrap")
        || document.querySelector("#menu-screen .menu-avatar-wrap")
    if (!wrap) {
        return { slot: SKIN_MENU_BOX_FALLBACK, scale: SKIN_MENU_BOX_FALLBACK }
    }
    const style = getComputedStyle(wrap)
    const num = (name, fallback) => {
        const value = parseFloat(style.getPropertyValue(name))
        return Number.isFinite(value) && value > 0 ? value : fallback
    }
    const slot = num("--menu-avatar-slot", SKIN_MENU_BOX_FALLBACK)
    const scale = num("--menu-avatar-scale", slot)
    return { slot, scale }
}

function updateMenuAvatar(skin) {
    const el = document.getElementById("menu-avatar")
    if (!el) return
    const { scale } = readMenuAvatarLayout(el)
    const box = scale
    const frame = SKIN_FRAME
    const zoom = box / frame.h
    const renderW = frame.w * zoom
    const bgX = -((frame.x * zoom) - (box - renderW) / 2)

    el.style.width = `${box}px`
    el.style.height = `${box}px`
    el.style.backgroundImage = `url(${skinImage(skin)})`
    el.style.backgroundSize = `${SKIN_SHEET * zoom}px ${SKIN_SHEET * zoom}px`
    el.style.backgroundPosition = `${bgX}px ${-(frame.y * zoom)}px`
}

function truncateDisplayName(name) {
    const trimmed = (name || "").trim()
    if (!trimmed) return "Trainer"
    const word = trimmed.split(/\s+/).filter(Boolean)[0] || trimmed
    return word.length > 6 ? `${word.slice(0, 6)}..` : word
}

function normalizePlayerName(raw) {
    const name = String(raw || "").trim().replace(/\s+/g, " ")
    if (!name || name.length > 24) return null
    return name
}

function getSkinNameInputValue() {
    return document.getElementById("skin-player-name-input")?.value || ""
}

function looksLikeWalletName(name) {
    const n = String(name || "").trim()
    if (!n) return false
    if (/^[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}$/.test(n)) return true
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(n)) return true
    return false
}

function isGuestPlaceholderName(name) {
    const text = String(name || "").trim()
    if (!text) return true
    if (/^guest:/i.test(text)) return true
    if (/^player guest:/i.test(text)) return true
    if (/^[a-f0-9]{4}…[a-f0-9]{4}$/i.test(text)) return true
    if (/^[a-f0-9]{4}\u2026[a-f0-9]{4}$/i.test(text)) return true
    if (/^new trainer(\s+\d+)?$/i.test(text)) return true
    if (/^saved trainer$/i.test(text)) return true
    return false
}

function guestHasRealName(name) {
    const text = String(name || "").trim()
    return Boolean(text) && !isGuestPlaceholderName(text) && !looksLikeWalletName(text)
}

function guestProfileReady() {
    if (!session) return false
    if (session.profile_ready) return true
    return Boolean(session.has_skin) && guestHasRealName(session.display_name)
}

function guestNeedsProfileSetup() {
    return guestPlayMode() && !guestProfileReady()
}

function initSkinNameInput() {
    const input = document.getElementById("skin-player-name-input")
    if (!input || !session) return
    let name = session.display_name || ""
    if (!guestHasRealName(name)) {
        name = ""
    }
    input.value = name
}

function setSkinSetupStep(step) {
    skinSetupStep = step === "picker" ? "picker" : "name"
    const nameStep = document.getElementById("skin-setup-name-step")
    const skinStep = document.getElementById("skin-setup-skin-step")
    const nextBtn = document.getElementById("skin-name-next-btn")
    const saveBtn = document.getElementById("save-skin-btn")
    const backBtn = document.getElementById("skin-name-back-btn")
    const subtitle = document.getElementById("skin-setup-subtitle")
    const status = document.getElementById("skin-status")
    const hint = document.getElementById("skin-purchase-hint")

    const onNameStep = skinSetupStep === "name"
    nameStep?.classList.toggle("hidden", !onNameStep)
    skinStep?.classList.toggle("hidden", onNameStep)
    nextBtn?.classList.toggle("hidden", !onNameStep)
    saveBtn?.classList.toggle("hidden", onNameStep)
    backBtn?.classList.toggle("hidden", onNameStep)

    if (subtitle) {
        subtitle.textContent = onNameStep ? "Enter your trainer name" : "Choose your avatar"
    }
    if (onNameStep) {
        if (hint) hint.textContent = ""
        if (status) {
            status.textContent = ""
            status.classList.remove("error")
        }
        requestAnimationFrame(() => {
            document.getElementById("skin-player-name-input")?.focus()
        })
    } else {
        if (!session?.has_skin) skinIndex = 0
        updateBalanceDisplays()
        updateSkinPreview(sortedSkins[skinIndex])
    }
}

function openSkinSetupScreen() {
    if (!pinUnlocked()) {
        openPinScreen(session?.has_pin ? "login" : "setup")
        return
    }
    initSkinNameInput()
    if (guestPlayMode() && guestHasRealName(session?.display_name)) {
        setSkinSetupStep("picker")
    } else {
        setSkinSetupStep("name")
    }
    showScreen("skin")
}

function advanceSkinSetupFromName() {
    const status = document.getElementById("skin-status")
    const displayName = normalizePlayerName(getSkinNameInputValue())
    if (!displayName) {
        if (status) {
            status.textContent = "Enter a trainer name (1–24 characters)"
            status.classList.add("error")
        }
        return
    }
    setSkinSetupStep("picker")
}

function skinImage(skin) {
    return `/sprites/characters/Character_${skin}.png`
}

function avatarListPrice(skin) {
    const raw = AVATAR_COSTS[skin]
    return Math.max(0, Number.isFinite(raw) ? raw : 0)
}

function skinPriceTier(price) {
    const value = Math.max(0, Number(price) || 0)
    if (value >= 5000) return "gold"
    if (value >= 3000) return "bronze"
    if (value >= 1500) return "silver"
    return "green"
}

function compareSkinsByPrice(a, b) {
    const diff = avatarListPrice(a) - avatarListPrice(b)
    if (diff !== 0) return diff
    if (a === "006") return -1
    if (b === "006") return 1
    return a.localeCompare(b, undefined, { numeric: true })
}

function sortSkinsByPrice(skins) {
    return [...skins].sort(compareSkinsByPrice)
}

let sortedSkins = sortSkinsByPrice(SKINS)

function refreshSortedSkins() {
    sortedSkins = sortSkinsByPrice(SKINS)
}

function isAvatarOwned(skin) {
    const owned = session?.owned_skins
    return Array.isArray(owned) && owned.includes(skin)
}

function avatarPurchaseCost(skin) {
    if (!skin || isAvatarOwned(skin)) return 0
    return avatarListPrice(skin)
}

function formatChipsAmount(n) {
    return Math.max(0, Number(n) || 0).toLocaleString()
}

function requiresKinsPayments() {
    if (!walletRequired()) return false
    return Boolean(session?.requires_kins_payments || session?.wallet_address)
}

function syncWalletEconomyLabels() {
    const kins = requiresKinsPayments()
    const profileLabel = document.querySelector(".profile-balance-label")
    if (profileLabel) {
        profileLabel.textContent = kins ? " balance (1 $POKEQUEST = 1 Chip)" : " Chips"
    }
    const skinBalanceLabel = document.querySelector("#skin-screen .skin-economy-row .skin-economy-label")
    if (skinBalanceLabel && kins) {
        skinBalanceLabel.textContent = "In-game balance:"
    }
}

let gameHudChipsMode = "buy"
let profileChipsMode = "buy"
let gameHudChipsToastTimer = null

function syncGameHudDepositUi() {
    const wrap = document.getElementById("game-hud-deposit")
    if (!wrap) return
    const show = requiresKinsPayments()
    wrap.classList.toggle("hidden", !show)
    if (!show) {
        closeGameHudDepositPop()
        hideGameHudChipsToast()
    }
}

function hideGameHudChipsToast() {
    if (gameHudChipsToastTimer) {
        clearTimeout(gameHudChipsToastTimer)
        gameHudChipsToastTimer = null
    }
    const toast = document.getElementById("game-hud-chips-toast")
    if (!toast) return
    toast.classList.add("hidden")
    toast.classList.remove("is-error", "is-success")
    const text = document.getElementById("game-hud-chips-toast-text")
    if (text) text.textContent = ""
}

function showGameHudChipsToast(message, kind = "info", autoHideMs = 4500) {
    const toast = document.getElementById("game-hud-chips-toast")
    const text = document.getElementById("game-hud-chips-toast-text")
    const form = document.getElementById("game-hud-chips-form")
    if (!toast || !text) return
    if (gameHudChipsToastTimer) {
        clearTimeout(gameHudChipsToastTimer)
        gameHudChipsToastTimer = null
    }
    form?.classList.remove("hidden")
    text.textContent = message || ""
    toast.classList.remove("hidden")
    toast.classList.toggle("is-error", kind === "error")
    toast.classList.toggle("is-success", kind === "success")
    if (autoHideMs > 0 && kind !== "info") {
        gameHudChipsToastTimer = setTimeout(hideGameHudChipsToast, autoHideMs)
    }
}

function closeGameHudDepositPop() {
    document.getElementById("game-hud-chips-form")?.classList.add("hidden")
    document.getElementById("game-hud-buy-toggle")?.classList.remove("is-active")
    document.getElementById("game-hud-sell-toggle")?.classList.remove("is-active")
    const input = document.getElementById("game-hud-deposit-amount")
    if (input) input.value = ""
    hideGameHudChipsToast()
}

function setGameHudChipsMode(mode) {
    gameHudChipsMode = mode === "sell" ? "sell" : "buy"
    const submit = document.getElementById("game-hud-chips-submit")
    const buyBtn = document.getElementById("game-hud-buy-toggle")
    const sellBtn = document.getElementById("game-hud-sell-toggle")
    const isSell = gameHudChipsMode === "sell"
    buyBtn?.classList.toggle("is-active", !isSell)
    sellBtn?.classList.toggle("is-active", isSell)
    if (submit) {
        submit.textContent = isSell ? "Sell" : "Buy"
        submit.classList.toggle("game-hud-chips-submit--buy", !isSell)
        submit.classList.toggle("game-hud-chips-submit--sell", isSell)
        if (isSell) {
            submit.removeAttribute("data-kins-buy")
        } else {
            submit.setAttribute("data-kins-buy", "")
        }
    }
}

function openGameHudChipsPop(mode) {
    const form = document.getElementById("game-hud-chips-form")
    if (!form) return
    setGameHudChipsMode(mode)
    form.classList.remove("hidden")
    document.getElementById("game-hud-deposit-amount")?.focus()
}

function openProfileChipsForm(mode) {
    profileChipsMode = mode === "sell" ? "sell" : "buy"
    const form = document.getElementById("profile-chips-form")
    const submit = document.getElementById("profile-chips-submit")
    const buyBtn = document.getElementById("profile-deposit-btn")
    const sellBtn = document.getElementById("profile-withdraw-btn")
    const isSell = profileChipsMode === "sell"
    buyBtn?.classList.toggle("is-active", !isSell)
    sellBtn?.classList.toggle("is-active", isSell)
    if (submit) {
        submit.textContent = isSell ? "Sell" : "Buy"
        submit.classList.toggle("profile-chips-btn--sell", isSell)
        submit.classList.toggle("profile-chips-btn--buy", !isSell)
        if (isSell) {
            submit.removeAttribute("data-kins-buy")
        } else {
            submit.setAttribute("data-kins-buy", "")
        }
    }
    form?.classList.remove("hidden")
    document.getElementById("profile-deposit-amount")?.focus()
}

function closeProfileChipsForm() {
    document.getElementById("profile-chips-form")?.classList.add("hidden")
    document.getElementById("profile-deposit-btn")?.classList.remove("is-active")
    document.getElementById("profile-withdraw-btn")?.classList.remove("is-active")
    const input = document.getElementById("profile-deposit-amount")
    if (input) input.value = ""
}

async function withdrawKinsBalance(amountKins) {
    const response = await fetch("/api/kins/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({ amountKins })),
    })
    const data = await response.json()
    if (!response.ok || !data.success) {
        throw new Error(data.error || "Could not sell Chips.")
    }
    return data
}

async function handleGameHudChipsSubmit() {
    const input = document.getElementById("game-hud-deposit-amount")
    const amount = Math.trunc(Number(input?.value || 0))
    if (!Number.isFinite(amount) || amount < 1) {
        showGameHudChipsToast("Enter a valid amount.", "error")
        return
    }

    const submitBtn = document.getElementById("game-hud-chips-submit")
    const isSell = gameHudChipsMode === "sell"
    if (isSell && amount < MIN_WITHDRAW_KINS) {
        showGameHudChipsToast(`Minimum sell amount is ${formatChipsAmount(MIN_WITHDRAW_KINS)} Chips.`, "error")
        return
    }
    if (submitBtn) submitBtn.disabled = true
    if (window.KinsWallet?.isPaymentPending?.()) {
        showGameHudChipsToast("A wallet payment is already in progress.", "error")
        if (submitBtn) submitBtn.disabled = false
        return
    }

    try {
        const data = isSell
            ? await withdrawKinsBalance(amount)
            : await depositKinsBalance(amount)
        if (Number.isFinite(data.balance)) session.balance = data.balance
        updateBalanceDisplays()
        if (input) input.value = ""
        showGameHudChipsToast(
            isSell
                ? `Sold ${formatChipsAmount(data.amountKins || amount)} Chip${amount === 1 ? "" : "s"} — $POKEQUEST payout queued.`
                : `Bought ${formatChipsAmount(data.amountKins || amount)} Chip${amount === 1 ? "" : "s"}!`,
            "success",
        )
        window.RetroAudio?.sfx?.("confirm")
    } catch (error) {
        showGameHudChipsToast(
            error.message || (isSell ? "Sell failed." : "Buy failed."),
            "error",
        )
        window.RetroAudio?.sfx?.("cancel")
    } finally {
        if (submitBtn) submitBtn.disabled = false
    }
}

function syncProfileKinsDepositUi() {
    const section = document.getElementById("profile-kins-deposit")
    if (!section) return
    section.classList.toggle("hidden", !requiresKinsPayments())
    syncWalletEconomyLabels()
}

async function purchaseSkinWithKins(skin, displayName) {
    if (!window.KinsWallet?.payKinsIntent) {
        throw new Error("Wallet payments are not available. Refresh and try again.")
    }
    return window.KinsWallet.payKinsIntent(
        "/api/kins/skin-intent",
        { skin, displayName },
        apiAuthBody,
    )
}
async function handleProfileChipsAction(mode) {
    const status = document.getElementById("profile-status")
    const input = document.getElementById("profile-deposit-amount")
    const amount = Math.trunc(Number(input?.value || 0))
    if (!Number.isFinite(amount) || amount < 1) {
        status.textContent = "Enter a valid amount."
        status.classList.add("error")
        return
    }

    const isSell = mode === "sell"
    if (isSell && amount < MIN_WITHDRAW_KINS) {
        status.textContent = `Minimum sell amount is ${formatChipsAmount(MIN_WITHDRAW_KINS)} Chips.`
        status.classList.add("error")
        return
    }
    status.textContent = isSell
        ? "Selling Chips..."
        : "Approve $POKEQUEST transfer in your wallet..."
    status.classList.remove("error")

    try {
        const data = isSell
            ? await withdrawKinsBalance(amount)
            : await depositKinsBalance(amount)
        if (Number.isFinite(data.balance)) session.balance = data.balance
        updateBalanceDisplays()
        renderProfileScreen()
        if (input) input.value = ""
        closeProfileChipsForm()
        status.textContent = isSell
            ? `Sold ${formatChipsAmount(data.amountKins || amount)} Chips — $POKEQUEST payout queued.`
            : `Bought ${formatChipsAmount(data.amountKins || amount)} Chips!`
    } catch (error) {
        status.textContent = error.message
        status.classList.add("error")
    }
}

async function depositKinsBalance(amountKins) {
    if (!window.KinsWallet?.payKinsIntent) {
        throw new Error("Wallet payments are not available. Refresh and try again.")
    }
    return window.KinsWallet.payKinsIntent(
        "/api/kins/deposit-intent",
        { amountKins },
        apiAuthBody,
    )
}

window.SaiPokeKins = {
    refreshBuyButtons() {
        const skin = profileSelectedSkin || session?.skin
        if (skin) updateProfileActionButton(skin)
        if (sortedSkins[skinIndex]) updateAvatarPriceTag(sortedSkins[skinIndex], "skin")
    },
}

async function saveSkinOrPay(skin, displayName) {
    const cost = avatarPurchaseCost(skin)
    if (requiresKinsPayments() && cost > 0) {
        return purchaseSkinWithKins(skin, displayName)
    }
    return saveSkin(skin, displayName)
}

function updateBalanceDisplays() {
    const balance = session?.balance ?? 0
    for (const id of ["skin-balance", "profile-balance", "menu-balance", "stat-balance"]) {
        const el = document.getElementById(id)
        if (el) el.textContent = formatChipsAmount(balance)
    }
    if (document.getElementById("vending-screen") && !document.getElementById("vending-screen").classList.contains("hidden")) {
        vendingUpdateDrawButton()
    }
}

function updateAvatarPriceTag(skin, prefix = "skin") {
    const tag = document.getElementById(`${prefix}-price-tag`)
    const saveBtn = prefix === "skin" ? document.getElementById("save-skin-btn") : null
    const hint = document.getElementById(prefix === "profile" ? "profile-purchase-hint" : "skin-purchase-hint")
    if (!tag) return

    const price = avatarListPrice(skin)
    const cost = avatarPurchaseCost(skin)
    const balance = session?.balance ?? 0
    const kinsPay = requiresKinsPayments() && !isAvatarOwned(skin) && cost > 0

    tag.classList.remove("is-owned", "is-expensive", "skin-price-value")
    tag.classList.add("skin-economy-value", "skin-price-value")
    if (isAvatarOwned(skin)) {
        tag.textContent = "OWNED"
        tag.classList.add("is-owned")
    } else if (price === 0) {
        tag.textContent = "FREE"
    } else if (kinsPay) {
        tag.textContent = `${formatChipsAmount(price)} $POKEQUEST`
    } else {
        tag.textContent = formatChipsAmount(price)
        if (cost > balance) tag.classList.add("is-expensive")
    }

    if (saveBtn && prefix === "skin") {
        if (cost === 0) {
            saveBtn.removeAttribute("data-kins-buy")
            saveBtn.classList.remove("is-unaffordable")
            saveBtn.textContent = "Equip"
        } else if (kinsPay) {
            saveBtn.setAttribute("data-kins-buy", "")
            saveBtn.classList.remove("is-unaffordable")
            saveBtn.textContent = `Buy — ${formatChipsAmount(price)} $POKEQUEST`
        } else {
            saveBtn.removeAttribute("data-kins-buy")
            saveBtn.classList.toggle("is-unaffordable", cost > balance)
            saveBtn.textContent = cost > balance ? "Not enough Chips" : "Buy"
        }
    }

    if (prefix === "profile") {
        updateProfileActionButton(skin)
    }

    if (hint && prefix === "skin") {
        if (kinsPay) {
            hint.textContent = `Sends ${formatChipsAmount(price)} $POKEQUEST on-chain to unlock this avatar.`
        } else if (!session?.has_skin && !requiresKinsPayments()) {
            hint.textContent = walletRequired()
                ? "New trainers start with 0 Chips — meet Cristy on the waterfront for a vending trial bonus."
                : `New trainers start with ${formatChipsAmount(STARTING_BALANCE)} Chips.`
        } else if (cost > balance && cost > 0) {
            hint.textContent = `You need ${formatChipsAmount(cost - balance)} more Chips for this avatar.`
        } else if (cost > 0) {
            hint.textContent = `${formatChipsAmount(cost)} Chips will be deducted when you save.`
        } else {
            hint.textContent = isAvatarOwned(skin) ? "You already own this avatar." : "This avatar is free."
        }
    }

    if (hint && prefix === "profile") {
        if (session?.skin === skin && isAvatarOwned(skin)) {
            hint.textContent = "This avatar is currently equipped."
        } else if (isAvatarOwned(skin)) {
            hint.textContent = "Tap Equip to wear this owned avatar."
        } else if (kinsPay) {
            hint.textContent = `Sends ${formatChipsAmount(price)} $POKEQUEST on-chain to unlock this avatar.`
        } else if (cost > balance && cost > 0) {
            hint.textContent = `You need ${formatChipsAmount(cost - balance)} more Chips to unlock this avatar.`
        } else if (cost > 0) {
            hint.textContent = `${formatChipsAmount(cost)} Chips will be deducted when you purchase.`
        } else {
            hint.textContent = "This avatar is free — claim it to add to your collection."
        }
    }
}

function profileSkinThumbStyle(skin) {
    const zoom = 2
    const frame = SKIN_FRAME
    return [
        `background-image:url(${skinImage(skin)})`,
        `background-size:${SKIN_SHEET * zoom}px ${SKIN_SHEET * zoom}px`,
        `background-position:-${frame.x * zoom}px -${frame.y * zoom}px`,
        `width:${frame.w * zoom}px`,
        `height:${frame.h * zoom}px`,
    ].join(";")
}

function getOwnedSkinsList() {
    const owned = session?.owned_skins
    const list = Array.isArray(owned) ? owned.filter((s) => SKINS.includes(s)) : []
    if (!list.includes(DEFAULT_SKIN)) list.unshift(DEFAULT_SKIN)
    return sortSkinsByPrice(SKINS.filter((s) => list.includes(s)))
}

function getShopSkinsList() {
    const owned = new Set(getOwnedSkinsList())
    return sortSkinsByPrice(SKINS.filter((s) => !owned.has(s)))
}

function syncProfileGridSelection() {
    document.querySelectorAll(".profile-skin-item").forEach((btn) => {
        const skin = btn.dataset.skin
        btn.classList.toggle("selected", skin === profileSelectedSkin)
        btn.classList.toggle("is-equipped", skin === session?.skin)
    })
}

function updateProfileEquippedLabel(skin) {
    const label = document.getElementById("profile-equipped-label")
    if (!label) return
    if (session?.skin === skin) {
        label.textContent = "Equipped avatar"
    } else if (isAvatarOwned(skin)) {
        label.textContent = "Owned avatar — not equipped"
    } else {
        label.textContent = "Shop preview — not owned yet"
    }
}

function updateProfileActionButton(skin) {
    const btn = document.getElementById("profile-action-btn")
    if (!btn) return

    const cost = avatarPurchaseCost(skin)
    const balance = session?.balance ?? 0
    const owned = isAvatarOwned(skin)
    const equipped = session?.skin === skin
    const kinsPay = requiresKinsPayments() && !owned && cost > 0

    btn.classList.remove("is-unaffordable")
    if (equipped && owned) {
        btn.textContent = "Equipped"
        btn.disabled = true
        btn.removeAttribute("data-kins-buy")
    } else if (owned) {
        btn.textContent = "Equip"
        btn.disabled = false
        btn.removeAttribute("data-kins-buy")
    } else if (kinsPay) {
        btn.setAttribute("data-kins-buy", "")
        btn.textContent = `Buy — ${formatChipsAmount(cost)} $POKEQUEST`
        btn.disabled = false
    } else if (cost > balance) {
        btn.textContent = "Not enough Chips"
        btn.disabled = true
        btn.removeAttribute("data-kins-buy")
        btn.classList.add("is-unaffordable")
    } else if (cost === 0) {
        btn.textContent = "Equip"
        btn.disabled = false
        btn.removeAttribute("data-kins-buy")
    } else {
        btn.textContent = "Buy"
        btn.disabled = false
        btn.removeAttribute("data-kins-buy")
    }
}

function selectProfileSkin(skin) {
    if (!SKINS.includes(skin)) return
    profileSelectedSkin = skin
    updateSkinPreview(skin, "profile")
    updateProfileEquippedLabel(skin)
    syncProfileGridSelection()
}

function buildProfileSkinButton(skin, { shop = false } = {}) {
    const cost = avatarPurchaseCost(skin)
    const price = avatarListPrice(skin)
    const tier = skinPriceTier(price)
    const balance = session?.balance ?? 0
    const kinsPay = requiresKinsPayments() && shop && cost > 0
    const costClass = shop && !kinsPay && cost > balance && cost > 0 ? " is-expensive" : ""
    const costLabel = shop
        ? (price === 0 ? "FREE" : formatChipsAmount(price))
        : ""

    return `
        <button
            type="button"
            class="profile-skin-item profile-skin-item--tier-${tier}${session?.skin === skin ? " is-equipped" : ""}${profileSelectedSkin === skin ? " selected" : ""}"
            data-skin="${skin}"
            role="listitem"
            aria-label="Avatar ${skin}${shop ? `, ${costLabel}` : ", owned"}"
        >
            <span class="profile-skin-thumb" style="${profileSkinThumbStyle(skin)}"></span>
            <span class="profile-skin-id">${skin}</span>
            ${shop ? `<span class="profile-skin-cost${costClass}">${costLabel}</span>` : ""}
        </button>
    `
}

function renderProfileOwnedGrid() {
    const grid = document.getElementById("profile-owned-grid")
    const countEl = document.getElementById("profile-owned-count")
    if (!grid) return

    const owned = getOwnedSkinsList()
    if (countEl) countEl.textContent = `${owned.length} owned`
    grid.innerHTML = owned.map((skin) => buildProfileSkinButton(skin)).join("")
}

function renderProfileShopGrid() {
    const grid = document.getElementById("profile-shop-grid")
    const emptyEl = document.getElementById("profile-shop-empty")
    if (!grid) return

    const shop = getShopSkinsList()
    grid.innerHTML = shop.map((skin) => buildProfileSkinButton(skin, { shop: true })).join("")
    grid.classList.toggle("hidden", shop.length === 0)
    emptyEl?.classList.toggle("hidden", shop.length > 0)
}

function renderProfileScreen() {
    updateBalanceDisplays()
    syncProfileKinsDepositUi()
    profileSelectedSkin = session?.skin && SKINS.includes(session.skin)
        ? session.skin
        : (getOwnedSkinsList()[0] || DEFAULT_SKIN)
    renderProfileOwnedGrid()
    renderProfileShopGrid()
    selectProfileSkin(profileSelectedSkin)
}

function handleProfileGridClick(event) {
    const btn = event.target.closest(".profile-skin-item")
    if (!btn?.dataset.skin) return
    selectProfileSkin(btn.dataset.skin)
}

function setLoading(text) {
    document.getElementById("loading-text").textContent = text
}

const skinImageCache = new Map()

function preloadImage(url) {
    return new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => resolve(null)
        img.src = url
    })
}

function decodeSkinImage(img) {
    try {
        const canvas = document.createElement("canvas")
        canvas.width = SKIN_FRAME.w
        canvas.height = SKIN_FRAME.h
        const ctx = canvas.getContext("2d")
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(
            img,
            SKIN_FRAME.x, SKIN_FRAME.y, SKIN_FRAME.w, SKIN_FRAME.h,
            0, 0, SKIN_FRAME.w, SKIN_FRAME.h
        )
    } catch {
        /* ignore decode errors */
    }
}

async function preloadSkin(skin) {
    if (skinImageCache.has(skin)) return skinImageCache.get(skin)

    const url = skinImage(skin)
    const img = await preloadImage(url)
    if (img) {
        decodeSkinImage(img)
        skinImageCache.set(skin, img)
    }
    return img
}

async function preloadAllSkins() {
    const total = SKINS.length
    const batchSize = 10

    for (let i = 0; i < total; i += batchSize) {
        const batch = SKINS.slice(i, i + batchSize)
        await Promise.all(batch.map((skin) => preloadSkin(skin)))
        const done = Math.min(i + batchSize, total)
        setLoading(`Loading characters ${done}/${total}...`)
    }
}

async function preloadEssentials() {
    const initialSkin = sortedSkins[skinIndex] || DEFAULT_SKIN
    setBootMessage("Entering PokéCards Quest..")
    await Promise.all([
        preloadSkin(DEFAULT_SKIN),
        initialSkin !== DEFAULT_SKIN ? preloadSkin(initialSkin) : Promise.resolve(),
    ])
}

async function preloadRemainingAssets() {
    try {
        await Promise.all(BAG_ITEMS.map((item) => preloadImage(item.src)))
        await Promise.all(POOL_ITEMS.map((item) => preloadImage(item.src)))
        await preloadAllSkins()
    } catch {
        /* background preload */
    }
}

function renderBagGrid() {
    const grid = document.getElementById("bag-grid")
    if (!grid) return

    grid.innerHTML = ""

    if (!hasHoldContent("vault_cards")) {
        const empty = document.createElement("p")
        empty.className = "bag-empty-msg"
        empty.textContent = "Your vault unlocks as you progress through the world."
        grid.appendChild(empty)
        return
    }

    const items = getVaultDisplayItems()
    if (!items.length) {
        const empty = document.createElement("p")
        empty.className = "bag-empty-msg"
        empty.textContent = "No PokéCards yet — find a vending machine to draw your first card."
        grid.appendChild(empty)
        return
    }

    for (let i = 0; i < BAG_SLOT_COUNT; i++) {
        const slot = document.createElement("div")
        slot.className = "bag-slot"
        const item = items[i]

        if (item) {
            slot.classList.add("bag-slot-filled")
            const img = document.createElement("img")
            img.className = "bag-card-img"
            img.src = item.src
            img.alt = item.name || "card"
            slot.appendChild(img)
        } else {
            slot.textContent = "empty"
        }

        grid.appendChild(slot)
    }
}

function renderGameVaultGrid() {
    const grid = document.getElementById("game-vault-grid")
    if (!grid) return

    grid.innerHTML = ""

    if (!hasHoldContent("vault_cards")) {
        return
    }

    const items = getVaultDisplayItems()
    if (!items.length) {
        const empty = document.createElement("p")
        empty.className = "game-drawer-empty-msg"
        empty.textContent = "No PokéCards yet — draw from a vending machine!"
        grid.appendChild(empty)
        return
    }

    for (let i = 0; i < BAG_SLOT_COUNT; i++) {
        const slot = document.createElement("div")
        slot.className = "game-drawer-slot"
        const item = items[i]

        if (item) {
            slot.classList.add("game-drawer-slot-filled")
            const img = document.createElement("img")
            img.className = "bag-card-img"
            img.src = item.src
            img.alt = item.name || "card"
            slot.appendChild(img)
        } else {
            slot.textContent = "—"
        }

        grid.appendChild(slot)
    }
}

function switchGameDrawerTab(tabId) {
    if (!tabId) return

    document.querySelectorAll(".game-drawer-tab").forEach((el) => {
        const active = el.dataset.tab === tabId && !el.hidden
        el.classList.toggle("active", active)
        el.setAttribute("aria-selected", active ? "true" : "false")
    })

    document.querySelectorAll(".game-drawer-pane[data-pane]").forEach((pane) => {
        if (pane.id === "game-drawer-empty") return
        const show = pane.dataset.pane === tabId && !pane.hidden
        pane.classList.toggle("active", show)
    })

    updateGameDrawerTitle(tabId)
}

function updateGameDrawerTitle(tabId) {
    const labels = { vault: "POKÉ VAULT", poketab: "POKÉTAB" }
    const titleEl = document.querySelector(".game-drawer-title")
    if (titleEl && tabId && labels[tabId]) {
        titleEl.textContent = labels[tabId]
    }
}

function setGameDrawerOpen(open) {
    const drawer = document.getElementById("game-drawer")
    const bagBtn = document.getElementById("game-bag-btn")
    const poketabBtn = document.getElementById("game-poketab-btn")
    if (!drawer || !bagBtn) return

    drawer.classList.toggle("hidden", !open)
    drawer.setAttribute("aria-hidden", open ? "false" : "true")
    bagBtn.setAttribute("aria-expanded", open ? "true" : "false")
    if (poketabBtn && !poketabBtn.hidden) {
        poketabBtn.setAttribute("aria-expanded", open ? "true" : "false")
    }
}

function openGameDrawer(tabId = null) {
    syncHoldUi()
    if (hasHoldContent("vault_cards")) {
        renderGameVaultGrid()
    }
    if (tabId) {
        switchGameDrawerTab(tabId)
    }
    setGameDrawerOpen(true)
}

function closeGameDrawer() {
    setGameDrawerOpen(false)
}

function bindGameDrawer() {
    document.getElementById("game-bag-btn")?.addEventListener("click", () => {
        if (!isUiUnlocked("bag_button")) return

        const drawer = document.getElementById("game-drawer")
        const isOpen = drawer && !drawer.classList.contains("hidden")
        if (isOpen) closeGameDrawer()
        else openGameDrawer()
    })

    document.getElementById("game-poketab-btn")?.addEventListener("click", () => {
        if (!isUiUnlocked("poketab_button")) return
        closeGameDrawer()
        window.PoketabSocial?.open?.()
    })

    document.getElementById("game-drawer-close")?.addEventListener("click", closeGameDrawer)
    document.getElementById("game-drawer-scrim")?.addEventListener("click", closeGameDrawer)

    document.querySelectorAll(".game-drawer-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            const id = tab.dataset.tab
            if (!id) return
            switchGameDrawerTab(id)
        })
    })
}

function showError(message) {
    document.getElementById("error-text").textContent = message
    showScreen("error")
}

function normalizeQuestProgress(raw) {
    const completed = Array.isArray(raw?.completed_steps) ? raw.completed_steps : []
    const removed = Array.isArray(raw?.removed_quests) ? raw.removed_quests : []
    const fishing = raw?.fishing && typeof raw.fishing === "object" ? raw.fishing : {}
    return { completed_steps: completed, removed_quests: removed, fishing }
}

function normalizeHolds(raw) {
    return Array.isArray(raw) ? raw.filter(Boolean) : []
}

function normalizeVault(raw) {
    if (!Array.isArray(raw)) return []
    return raw
        .map((entry) => {
            if (typeof entry === "string") return entry.trim()
            if (entry && typeof entry === "object") {
                return String(entry.card_id || entry.id || "").trim()
            }
            return ""
        })
        .filter(Boolean)
}

function applyVaultFromServer(vault) {
    if (!session || !Array.isArray(vault)) return
    session.vault = normalizeVault(vault)
    renderBagGrid()
    renderGameVaultGrid()
}

function catalogCard(cardId) {
    return CARD_CATALOG[cardId] || POOL_ITEMS.find((item) => item.id === cardId) || null
}

function getVaultCardIds() {
    return normalizeVault(session?.vault)
}

function getVaultDisplayItems() {
    return getVaultCardIds().map((id) => catalogCard(id)).filter(Boolean)
}

function resolveCardItem(itemOrId) {
    if (!itemOrId) return null
    if (typeof itemOrId === "string") {
        return catalogCard(itemOrId) || BAG_ITEMS.find((entry) => entry.id === itemOrId) || null
    }
    if (itemOrId.id && CARD_CATALOG[itemOrId.id]) return CARD_CATALOG[itemOrId.id]
    return itemOrId
}

function playerHasHold(item) {
    return normalizeHolds(session?.holds).includes(item)
}

function holdMeta(itemId) {
    return HOLD_CATALOG[itemId] || null
}

function holdGrantRulesForClient() {
    const rules = {}
    for (const [itemId, meta] of Object.entries(HOLD_CATALOG)) {
        if (meta?.grant_requires) {
            rules[itemId] = meta.grant_requires
        }
    }
    return rules
}

function holdGrantRequirementsMet(holdId, holds = normalizeHolds(session?.holds)) {
    const req = holdMeta(holdId)?.grant_requires
    if (!req) return true
    if (req.holds?.some((item) => !holds.includes(item))) return false
    if (req.notHolds?.some((item) => holds.includes(item))) return false
    return true
}

function holdForContent(contentId) {
    for (const [itemId, meta] of Object.entries(HOLD_CATALOG)) {
        if (meta.content === contentId) return itemId
    }
    return null
}

function hasHoldContent(contentId) {
    const holdId = holdForContent(contentId)
    return holdId ? playerHasHold(holdId) : false
}

function isUiUnlocked(uiId) {
    const rule = UI_UNLOCKS[uiId]
    if (!rule?.requires_hold) return true
    return playerHasHold(rule.requires_hold)
}

function syncGameDrawerPanes() {
    const emptyPane = document.getElementById("game-drawer-empty")
    const tabs = Array.from(document.querySelectorAll('.game-drawer-tab[data-hold-ui^="drawer:"]'))
    const panes = Array.from(document.querySelectorAll('.game-drawer-pane[data-hold-ui^="drawer:"]'))
    const tabsNav = document.querySelector(".game-drawer-tabs")

    const visibleTabs = tabs.filter((tab) => {
        const uiId = tab.dataset.holdUi
        const unlocked = uiId ? isUiUnlocked(uiId) : false
        tab.hidden = !unlocked
        return unlocked
    })

    panes.forEach((pane) => {
        const uiId = pane.dataset.holdUi
        pane.hidden = !(uiId && isUiUnlocked(uiId))
    })

    const anyUnlocked = visibleTabs.length > 0
    if (emptyPane) {
        emptyPane.hidden = anyUnlocked
        emptyPane.classList.toggle("active", !anyUnlocked)
    }

    if (tabsNav) {
        tabsNav.hidden = !anyUnlocked
    }

    if (!anyUnlocked) return

    const activeTab = visibleTabs.find((tab) => tab.classList.contains("active")) || visibleTabs[0]
    const activeId = activeTab?.dataset.tab
    visibleTabs.forEach((tab) => {
        const active = tab.dataset.tab === activeId
        tab.classList.toggle("active", active)
        tab.setAttribute("aria-selected", active ? "true" : "false")
    })
    document.querySelectorAll(".game-drawer-pane[data-pane]").forEach((pane) => {
        if (pane.id === "game-drawer-empty") return
        const paneId = pane.dataset.pane
        const show = paneId === activeId && !pane.hidden
        pane.classList.toggle("active", show)
    })

    if (activeId) {
        updateGameDrawerTitle(activeId)
    }
}

function normalizeGearSlots(raw) {
    const slots = Array.from({ length: QUICKBAR_SLOT_COUNT }, () => null)
    if (!Array.isArray(raw)) return slots
    for (let i = 0; i < QUICKBAR_SLOT_COUNT; i++) {
        const item = raw[i]
        slots[i] = item && GEAR_CATALOG[item] ? item : null
    }
    return slots
}

function gearMeta(itemId) {
    return GEAR_CATALOG[itemId] || null
}

function playerHasGear(itemId) {
    return normalizeGearSlots(session?.gear_slots).includes(itemId)
}

function getQuickbarSlotItems() {
    return normalizeGearSlots(session?.gear_slots)
}

function quickbarGearIcon(gearId) {
    return gearMeta(gearId)?.icon || ""
}

function showQuickbarHint(text) {
    const hint = document.getElementById("game-quickbar-hint")
    if (!hint) return
    if (quickbarHintTimer) {
        clearTimeout(quickbarHintTimer)
        quickbarHintTimer = null
    }
    hint.textContent = text || ""
    hint.classList.toggle("is-visible", Boolean(text))
    if (text) {
        quickbarHintTimer = setTimeout(() => {
            hint.classList.remove("is-visible")
            hint.textContent = ""
            quickbarHintTimer = null
        }, 2200)
    }
}

function fishingQuestMeta(questKey) {
    return FISHING_CATALOG[questKey] || null
}

function resolveFishingQuestForGear(gearId) {
    return gearMeta(gearId)?.default_fishing_quest || null
}

function showFishingHud(label, progressPct = 0) {
    const hud = document.getElementById("game-fishing-hud")
    const labelEl = document.getElementById("game-fishing-label")
    const fill = document.getElementById("game-fishing-bar-fill")
    if (labelEl) labelEl.textContent = label || "Fishing…"
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, progressPct))}%`
    hud?.classList.remove("hidden")
}

function hideFishingHud() {
    document.getElementById("game-fishing-hud")?.classList.add("hidden")
    const fill = document.getElementById("game-fishing-bar-fill")
    if (fill) fill.style.width = "0%"
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function playFishingCatchFanfare() {
    window.RetroAudio?.resume?.()
    window.RetroAudio?.sfx?.("encounter")
    document.body.classList.add("encounter-flash")
    setTimeout(() => document.body.classList.remove("encounter-flash"), 520)
}

async function animateFishingProgress(durationMs, resolveAtMs, label, signal, onResolve) {
    const totalMs = Math.max(1, Number(durationMs) || 60000)
    const biteMs = Math.min(Math.max(1, Number(resolveAtMs) || totalMs), totalMs)
    const started = performance.now()
    let resolved = false

    showFishingHud(label, 0)
    while (true) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

        const elapsed = performance.now() - started
        const pct = Math.min(100, (elapsed / totalMs) * 100)
        showFishingHud(label, pct)

        if (!resolved && elapsed >= biteMs && onResolve) {
            resolved = true
            const stopEarly = await onResolve()
            if (stopEarly) break
        }

        if (elapsed >= totalMs) break
        await sleep(50)
    }

    showFishingHud(label, 100)
}

async function completeFishingCastSession(sessionId) {
    const response = await fetch("/api/fishing/cast/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({ session_id: sessionId })),
    })
    const data = await response.json()
    if (response.status === 425 && data.error === "Cast still in progress") {
        await sleep(Number(data.wait_ms) || 500)
        return completeFishingCastSession(sessionId)
    }
    return data
}

function promptFishingRetry({ title, message }) {
    if (fishingRetryPromptPromise) return fishingRetryPromptPromise

    fishingRetryPromptPromise = new Promise((resolve) => {
        let settled = false
        const finish = (yes) => {
            if (settled) return
            settled = true
            window.removeEventListener("fishing-retry-choice", onChoice)
            fishingRetryPromptPromise = null
            hideSignModal({ skipAudioSync: true })
            resolve(yes)
        }
        const onChoice = (event) => {
            finish(Boolean(event.detail?.yes))
        }
        window.addEventListener("fishing-retry-choice", onChoice)
        showSignModal({
            title: title || "Try again?",
            message: message || "Cast again and restart the fishing bar?",
            source: "fishing",
            options: [
                { label: "Yes", code: "fishing_retry_yes" },
                { label: "No", code: "fishing_retry_no" },
            ],
            showExit: false,
        })
        document.getElementById("sign-modal-close")?.classList.add("hidden")
    })

    return fishingRetryPromptPromise
}

async function performFishingCastAttempt(gearId, questKey, quest) {
    const startResponse = await fetch("/api/fishing/cast/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({
            quest_key: questKey,
            mode: activeFishingMode,
            gear_id: gearId,
        })),
    })
    const startData = await startResponse.json()
    if (!startResponse.ok || !startData.success) {
        window.RetroAudio?.sfx?.("cancel")
        showQuickbarHint(startData.error || "Could not start fishing")
        return { ok: false }
    }

    if (startData.quest_progress && session) {
        session.quest_progress = normalizeQuestProgress(startData.quest_progress)
        renderQuestBoard()
    }

    const durationMs = Number(startData.duration_ms) || 60000
    const resolveAtMs = Number(startData.resolve_at_ms) || durationMs
    const label = startData.status_label || "Fishing…"
    let result = null

    await animateFishingProgress(
        durationMs,
        resolveAtMs,
        label,
        fishingCastAbort.signal,
        async () => {
            result = await completeFishingCastSession(startData.session_id)
            return Boolean(result?.caught)
        },
    )

    if (!result) {
        result = await completeFishingCastSession(startData.session_id)
    }

    hideFishingHud()

    if (!result.success) {
        window.RetroAudio?.sfx?.("cancel")
        showQuickbarHint(result.error || result.message || "Cast failed")
        return { ok: false }
    }

    if (session && result.quest_progress) {
        session.quest_progress = normalizeQuestProgress(result.quest_progress)
        renderQuestBoard()
    }

    return { ok: true, result, quest }
}

async function runFishingCast(gearId) {
    if (fishingCastActive) return false

    const questKey = resolveFishingQuestForGear(gearId)
    if (!questKey) return false

    const quest = fishingQuestMeta(questKey)
    if (!quest) return false

    const rewardGear = quest.reward_gear
    if (rewardGear && playerHasGear(rewardGear)) {
        showQuickbarHint("You already found what you were looking for.")
        return false
    }

    window.RetroAudio?.resume?.()
    window.TelegramGame?.setFishingMode?.(activeFishingMode)
    const clientResult = window.TelegramGame?.tryUseGear?.()
    if (!clientResult?.success) {
        window.RetroAudio?.sfx?.("cancel")
        showQuickbarHint(clientResult?.message || "Can't use that here")
        return false
    }

    fishingCastActive = true
    fishingCastAbort = new AbortController()
    try {
        let lastResult = null

        while (true) {
            const attempt = await performFishingCastAttempt(gearId, questKey, quest)
            if (!attempt.ok) return false

            const result = attempt.result
            lastResult = result

            if (result.caught && result.gear_slots) {
                session.gear_slots = normalizeGearSlots(result.gear_slots)
                syncQuickbar()
                playFishingCatchFanfare()
                const meta = result.meta || gearMeta(result.reward_gear)
                if (meta) showGearPickupPopup(meta)
                showSignModal({
                    title: result.catch_title || quest.catch_title || "Found it!",
                    message: result.message || quest.catch_message || "You found something!",
                    source: "fishing",
                })
                return true
            }

            if (result.show_retry_prompt && !result.caught) {
                const retry = await promptFishingRetry({
                    title: result.retry_prompt_title || quest.retry_prompt_title || "Try again?",
                    message: result.retry_prompt_message
                        || quest.retry_prompt_message
                        || result.message
                        || "Cast again and restart the fishing bar?",
                })
                if (retry) continue
            }

            break
        }

        if (lastResult?.message && !lastResult?.show_retry_prompt) {
            showQuickbarHint(lastResult.message)
        } else {
            showQuickbarHint("Nothing this time.")
        }
        return true
    } catch (error) {
        if (error?.name !== "AbortError") {
            console.warn("Fishing cast failed:", error)
            showQuickbarHint("Fishing interrupted.")
        }
        return false
    } finally {
        fishingCastActive = false
        fishingCastAbort = null
        hideFishingHud()
    }
}

async function useQuickbarGear(gearId) {
    if (!gearId || !playerHasGear(gearId)) return false

    if (resolveFishingQuestForGear(gearId)) {
        return runFishingCast(gearId)
    }

    window.RetroAudio?.resume?.()
    const result = window.TelegramGame?.tryUseGear?.()
    if (!result) return false

    if (result.success) {
        window.RetroAudio?.sfx?.("confirm")
        showQuickbarHint(result.message)
        return true
    }

    window.RetroAudio?.sfx?.("cancel")
    showQuickbarHint(result.message || "Can't use that here")
    return false
}

function isGearModeMenuOpen() {
    const menu = document.getElementById("game-gear-mode-menu")
    return Boolean(menu && !menu.classList.contains("hidden") && gearModeMenuPinned)
}

function markGearModeMenuInteraction() {
    suppressQuickbarSlotUntil = performance.now() + 700
}

function keepGearModeMenuOpen() {
    const gearId = quickbarSelectedSlot >= 0 ? getQuickbarSlotItems()[quickbarSelectedSlot] : null
    if (gearId !== "fishing_rod" || !fishingModesForGear(gearId)) return
    const menu = document.getElementById("game-gear-mode-menu")
    if (!menu) return
    gearModeMenuPinned = true
    gearModeMenuSlot = quickbarSelectedSlot
    menu.classList.remove("hidden")
    if (!menu.querySelector("[data-fishing-cast]")) {
        showGearModeMenu(quickbarSelectedSlot, gearId)
        return
    }
    positionGearModeMenu(quickbarSelectedSlot)
    updateGearModeMenuActiveState()
}

function syncEquippedGearVisual() {
    const slots = getQuickbarSlotItems()
    const equipped = quickbarSelectedSlot >= 0 ? slots[quickbarSelectedSlot] : null
    window.TelegramGame?.setEquippedGear?.(equipped || null)
    if (!equipped) {
        hideGearModeMenu()
        return
    }
    if (equipped === "fishing_rod" && fishingModesForGear(equipped)) {
        if (isGearModeMenuOpen() && gearModeMenuSlot === quickbarSelectedSlot) {
            updateGearModeMenuActiveState()
            positionGearModeMenu(quickbarSelectedSlot)
        }
    } else if (isGearModeMenuOpen()) {
        hideGearModeMenu()
    }
}

function updateGearModeMenuActiveState() {
    document.querySelectorAll(".game-gear-mode-btn[data-fishing-mode]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.fishingMode === activeFishingMode)
    })
}

function syncQuickbar() {
    const slots = document.querySelectorAll(".game-quickslot")
    if (!slots.length) return

    const items = getQuickbarSlotItems()
    if (quickbarSelectedSlot >= 0 && !items[quickbarSelectedSlot]) {
        quickbarSelectedSlot = -1
    }

    slots.forEach((slotEl, index) => {
        const gearId = items[index]
        const meta = gearId ? gearMeta(gearId) : null
        const iconEl = slotEl.querySelector(".game-quickslot-icon")
        const label = meta?.label || (gearId ? gearId : "empty")

        slotEl.classList.toggle("is-filled", Boolean(gearId))
        slotEl.classList.toggle("is-selected", quickbarSelectedSlot === index)
        slotEl.disabled = !gearId
        slotEl.setAttribute(
            "aria-label",
            gearId
                ? `Gear slot ${index + 1}, ${label}${quickbarSelectedSlot === index ? ", equipped" : ""}`
                : `Gear slot ${index + 1}, empty`
        )

        if (iconEl) {
            const icon = quickbarGearIcon(gearId)
            if (icon) {
                iconEl.src = icon
                iconEl.alt = label
                iconEl.classList.remove("hidden")
            } else {
                iconEl.removeAttribute("src")
                iconEl.alt = ""
                iconEl.classList.add("hidden")
            }
        }
    })

    syncEquippedGearVisual()
    syncPlayerGearToGame()
}

function flashQuickbarSlot(index) {
    const slotEl = document.querySelector(`.game-quickslot[data-slot="${index}"]`)
    if (!slotEl) return
    slotEl.classList.add("is-use-flash")
    setTimeout(() => slotEl.classList.remove("is-use-flash"), 220)
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

function fishingModesForGear(gearId) {
    const modes = gearMeta(gearId)?.fishing_modes
    return Array.isArray(modes) && modes.length ? modes : null
}

function syncPlayerGearToGame() {
    const ids = getQuickbarSlotItems().filter(Boolean)
    window.TelegramGame?.setPlayerGear?.(ids)
}

function hideGearModeMenu() {
    gearModeMenuSlot = -1
    gearModeMenuPinned = false
    const menu = document.getElementById("game-gear-mode-menu")
    if (menu) {
        menu.classList.add("hidden")
        menu.innerHTML = ""
    }
}

function positionGearModeMenu(slotIndex) {
    const menu = document.getElementById("game-gear-mode-menu")
    const anchor = document.querySelector(".game-quickbar-anchor")
    const slotEl = document.querySelector(`.game-quickslot[data-slot="${slotIndex}"]`)
    if (!menu || !anchor || !slotEl) return

    const anchorRect = anchor.getBoundingClientRect()
    const slotRect = slotEl.getBoundingClientRect()
    const centerX = slotRect.left + slotRect.width / 2 - anchorRect.left
    menu.style.left = `${centerX}px`
    menu.style.transform = "translateX(-50%)"
}

function showGearModeMenu(slotIndex, gearId) {
    const modes = fishingModesForGear(gearId)
    if (!modes) {
        hideGearModeMenu()
        return
    }

    const menu = document.getElementById("game-gear-mode-menu")
    if (!menu) return

    const menuOpen = isGearModeMenuOpen() && gearModeMenuSlot === slotIndex
    if (menuOpen && menu.querySelector("[data-fishing-cast]")) {
        updateGearModeMenuActiveState()
        return
    }

    gearModeMenuSlot = slotIndex
    gearModeMenuPinned = true
    menu.innerHTML = `
        <p class="game-gear-mode-title">CATCH TYPE</p>
        ${modes.map((mode) => `
            <button type="button" class="game-gear-mode-btn ${mode.id === activeFishingMode ? "is-active" : ""}" data-fishing-mode="${mode.id}">
                ${escapeHtml(mode.label || mode.id)}
                <small>${escapeHtml(mode.hint || "")}</small>
            </button>
        `).join("")}
        <button type="button" class="game-gear-mode-btn is-cast" data-fishing-cast="1">CAST</button>
    `
    menu.classList.remove("hidden")
    positionGearModeMenu(slotIndex)
    window.TelegramGame?.setFishingMode?.(activeFishingMode)
}

function selectFishingMode(modeId) {
    if (!modeId) return
    activeFishingMode = modeId
    localStorage.setItem("saipoke_fishing_mode", modeId)
    window.TelegramGame?.setFishingMode?.(modeId)
    document.querySelectorAll(".game-gear-mode-btn[data-fishing-mode]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.fishingMode === modeId)
    })
    const label = (fishingModesForGear("fishing_rod") || []).find((m) => m.id === modeId)?.label || modeId
    showQuickbarHint(`Mode: ${label}`)
}

function stowQuickbarGear(gearId) {
    quickbarSelectedSlot = -1
    hideGearModeMenu()
    syncQuickbar()
    const label = gearMeta(gearId)?.label || gearId
    showQuickbarHint(`${label} stowed`)
}

function isTypingInField(target) {
    const el = target || document.activeElement
    if (!el || !(el instanceof HTMLElement)) return false
    if (el.isContentEditable) return true
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
    return Boolean(el.closest("[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']"))
}

function shouldIgnoreGameShortcuts(event) {
    return Boolean(event?.isComposing || isTypingInField(event?.target))
}

function bindQuickbar() {
    const quickbar = document.getElementById("game-quickbar")
    if (!quickbar || quickbar.dataset.bound === "1") return
    quickbar.dataset.bound = "1"

    const handleGearModeMenuPointer = (event) => {
        markGearModeMenuInteraction()
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()

        const modeBtn = event.target.closest("[data-fishing-mode]")
        if (modeBtn) {
            selectFishingMode(modeBtn.dataset.fishingMode)
            keepGearModeMenuOpen()
            return
        }
        if (event.target.closest("[data-fishing-cast]")) {
            const gearId = getQuickbarSlotItems()[quickbarSelectedSlot]
            window.TelegramGame?.setFishingMode?.(activeFishingMode)
            hideGearModeMenu()
            if (gearId) {
                void useQuickbarGear(gearId)
            }
        }
    }

    const menu = document.getElementById("game-gear-mode-menu")
    menu?.addEventListener("pointerdown", handleGearModeMenuPointer, true)
    menu?.addEventListener("click", (event) => {
        markGearModeMenuInteraction()
        event.stopPropagation()
        event.stopImmediatePropagation()
    }, true)

    quickbar.addEventListener("pointerdown", (event) => {
        if (event.target.closest("#game-gear-mode-menu")) return
        if (performance.now() < suppressQuickbarSlotUntil) return

        const slotEl = event.target.closest(".game-quickslot")
        if (!slotEl || slotEl.disabled) return

        const index = Number(slotEl.dataset.slot)
        if (!Number.isFinite(index)) return

        const items = getQuickbarSlotItems()
        const gearId = items[index]
        if (!gearId) return

        window.RetroAudio?.resume?.()
        window.RetroAudio?.sfx?.("select")

        if (quickbarSelectedSlot === index) {
            stowQuickbarGear(gearId)
            return
        }

        quickbarSelectedSlot = index
        syncQuickbar()
        const label = gearMeta(gearId)?.label || gearId
        if (fishingModesForGear(gearId)) {
            showGearModeMenu(index, gearId)
            showQuickbarHint(`Equip: ${label} · pick catch type · CAST by water`)
        } else {
            showQuickbarHint(`Equip: ${label} · tap again to stow`)
        }
    })

    document.addEventListener("keydown", (event) => {
        if (!screens.game || screens.game.classList.contains("hidden")) return
        if (shouldIgnoreGameShortcuts(event)) return
        const key = event.key
        if (key !== "1" && key !== "2" && key !== "3") return

        const index = Number(key) - 1
        const items = getQuickbarSlotItems()
        const gearId = items[index]
        if (!gearId) return

        event.preventDefault()
        if (quickbarSelectedSlot === index) {
            stowQuickbarGear(gearId)
        } else {
            quickbarSelectedSlot = index
            syncQuickbar()
            const label = gearMeta(gearId)?.label || gearId
            if (fishingModesForGear(gearId)) {
                showGearModeMenu(index, gearId)
                showQuickbarHint(`Equip: ${label} · pick catch type · CAST by water`)
            } else {
                showQuickbarHint(`Equip: ${label} · tap again to stow`)
            }
        }
    })
}

function showGearPickupPopup(meta) {
    showItemGetPopup(itemGetSpecFromMeta(meta))
}

function completeGearQuestFromMeta(meta) {
    if (!meta?.quest_step) return
    completeQuestStep(meta.quest_step, meta.quest_id || null)
}

async function grantGear(item, source = "") {
    const gearId = String(item || "").trim()
    if (!gearId || !GEAR_CATALOG[gearId]) return
    if (playerHasGear(gearId)) return

    const meta = gearMeta(gearId) || { id: gearId, label: gearId }
    const priorSlots = normalizeGearSlots(session?.gear_slots)

    const optimistic = [...priorSlots]
    const emptyIndex = optimistic.findIndex((slot) => !slot)
    if (emptyIndex === -1) {
        showQuickbarHint("Gear bar full")
        return
    }
    optimistic[emptyIndex] = gearId
    session.gear_slots = optimistic
    syncQuickbar()

    try {
        const response = await fetch("/api/gear/grant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody({ item: gearId, source })),
        })
        const data = await response.json()
        if (!response.ok || !data.success) {
            console.warn("Could not grant gear:", data.error || gearId)
            session.gear_slots = priorSlots
            syncQuickbar()
            showQuickbarHint(data.error || "Gear bar full")
            return
        }

        session.gear_slots = normalizeGearSlots(data.gear_slots)
        syncQuickbar()
        syncPlayerGearToGame()

        const resolvedMeta = data.meta || meta
        if (data.newly_granted) {
            showGearPickupPopup(resolvedMeta)
            completeGearQuestFromMeta(resolvedMeta)
        }
    } catch (error) {
        console.warn("Could not grant gear:", error)
        session.gear_slots = priorSlots
        syncQuickbar()
    }
}

async function removeGear(item, source = "") {
    const gearId = String(item || "").trim()
    if (!gearId || !playerHasGear(gearId)) return

    const priorSlots = normalizeGearSlots(session?.gear_slots)
    const optimistic = priorSlots.map((slot) => (slot === gearId ? null : slot))
    session.gear_slots = optimistic
    syncQuickbar()

    const equipped = getQuickbarSlotItems()[quickbarSelectedSlot]
    if (equipped === gearId) {
        quickbarSelectedSlot = -1
        window.TelegramGame?.setEquippedGear?.(null)
    }
    syncPlayerGearToGame()

    try {
        const response = await fetch("/api/gear/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody({ item: gearId, source })),
        })
        const data = await response.json()
        if (!response.ok || !data.success) {
            session.gear_slots = priorSlots
            syncQuickbar()
            syncPlayerGearToGame()
            return
        }
        session.gear_slots = normalizeGearSlots(data.gear_slots)
        syncQuickbar()
        syncPlayerGearToGame()
    } catch (error) {
        console.warn("Could not remove gear:", error)
        session.gear_slots = priorSlots
        syncQuickbar()
        syncPlayerGearToGame()
    }
}

function syncHoldUi() {
    for (const [uiId, rule] of Object.entries(UI_UNLOCKS)) {
        const unlocked = isUiUnlocked(uiId)
        const selector = rule.selector || `[data-hold-ui="${uiId}"]`
        document.querySelectorAll(selector).forEach((el) => {
            el.classList.toggle("is-hold-locked", !unlocked)
            if (rule.lock_mode === "hide") {
                el.hidden = !unlocked
            }
        })

        if (uiId === "bag_button") {
            const bagBtn = document.getElementById("game-bag-btn")
            if (!bagBtn) continue
            bagBtn.setAttribute("aria-disabled", unlocked ? "false" : "true")
            bagBtn.title = unlocked
                ? (rule.title_unlocked || "Open bag")
                : (rule.title_locked || "Locked")
        }

        if (uiId === "poketab_button") {
            const poketabBtn = document.getElementById("game-poketab-btn")
            if (!poketabBtn) continue
            poketabBtn.hidden = !unlocked
            poketabBtn.setAttribute("aria-disabled", unlocked ? "false" : "true")
            poketabBtn.title = unlocked
                ? (rule.title_unlocked || "Open PokéTab")
                : (rule.title_locked || "Locked")
        }
    }

    syncGameDrawerPanes()
}

function itemGetSpecFromMeta(meta) {
    const popup = meta?.pickup_popup || {}
    return {
        headline: popup.headline || "YOU GOT!",
        title: popup.title || meta?.label || meta?.name || "Mystery Item",
        message: popup.message || meta?.description || "",
        icon: popup.icon || meta?.src || "",
        theme: popup.theme || meta?.theme || "gear",
        tag: popup.tag || "NEW ITEM",
    }
}

function itemGetSpecForBagItem(item) {
    if (!item) return null
    return itemGetSpecFromMeta({ ...item, pickup_popup: item.pickup_popup, label: item.name })
}

function itemGetSpecForHold(holdId) {
    return itemGetSpecFromMeta(holdMeta(holdId) || { id: holdId, label: holdId })
}

function finishItemGetPopup() {
    const popup = document.getElementById("item-get-popup")
    const iconEl = document.getElementById("item-get-icon")
    if (iconEl) iconEl.hidden = true
    if (popup && !popup.classList.contains("hidden")) {
        popup.classList.add("hidden")
    }
    if (itemGetCloseResolve) {
        itemGetCloseResolve()
        itemGetCloseResolve = null
    }
}

function preloadItemGetIcon(iconEl, icon, title) {
    if (!iconEl) return Promise.resolve()
    if (!icon) {
        iconEl.removeAttribute("src")
        iconEl.alt = ""
        iconEl.hidden = true
        return Promise.resolve()
    }

    iconEl.hidden = true
    iconEl.alt = title || "Item"

    const current = iconEl.getAttribute("src") || ""
    if (current === icon) {
        iconEl.hidden = false
        return Promise.resolve()
    }

    return new Promise((resolve) => {
        const finish = () => {
            iconEl.onload = null
            iconEl.onerror = null
            iconEl.hidden = false
            resolve()
        }
        iconEl.onload = finish
        iconEl.onerror = finish
        iconEl.src = icon
    })
}

function hideItemGetPopup() {
    finishItemGetPopup()
}

function showItemGetPopup(metaOrSpec) {
    const spec = metaOrSpec?.headline ? metaOrSpec : itemGetSpecFromMeta(metaOrSpec || {})
    const popup = document.getElementById("item-get-popup")
    const headlineEl = document.getElementById("item-get-headline")
    const tagEl = document.getElementById("item-get-tag")
    const nameEl = document.getElementById("item-get-name")
    const msgEl = document.getElementById("item-get-msg")
    const iconEl = document.getElementById("item-get-icon")
    if (!popup || !headlineEl || !nameEl || !msgEl) return Promise.resolve()

    const run = () => new Promise((resolve) => {
        itemGetCloseResolve = resolve

        headlineEl.textContent = spec.headline || "YOU GOT!"
        if (tagEl) tagEl.textContent = spec.tag || "NEW ITEM"
        nameEl.textContent = spec.title || "Item"
        msgEl.textContent = spec.message || ""

        preloadItemGetIcon(iconEl, spec.icon || "", spec.title || "Item").then(() => {
            popup.classList.remove("hidden")
        })
    })

    itemGetQueue = itemGetQueue.then(run, run)
    return itemGetQueue
}

function bindItemGetPopup() {
    const close = () => finishItemGetPopup()
    document.getElementById("item-get-close")?.addEventListener("click", close)
    document.getElementById("item-get-ok")?.addEventListener("click", close)
    document.getElementById("item-get-scrim")?.addEventListener("click", close)
}

function showHoldPickupPopup(meta) {
    showItemGetPopup(meta)
}

async function grantNpcBalance(grantId, source = "") {
    if (!isSignedIn() || !grantId) return

    try {
        const response = await fetch("/api/economy/npc-grant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody({ grantId, source })),
        })
        const data = await response.json()
        if (!response.ok || !data.success) {
            console.warn("Could not grant balance:", data.error || grantId)
            return
        }
        if (Number.isFinite(data.balance)) {
            session.balance = data.balance
            updateBalanceDisplays()
        }
        if (!data.already_granted && Number(data.amount) > 0) {
            showQuickbarHint(`+${formatChipsAmount(data.amount)} Chips!`)
        }
    } catch (error) {
        console.warn("Could not grant balance:", error)
    }
}

function completeHoldQuestFromMeta(meta) {
    if (!meta?.quest_step) return
    completeQuestStep(meta.quest_step, meta.quest_id || null)
}

async function receivePokecard(cardId, source = "unknown", opts = {}) {
    const result = await addCardToVault(cardId, source)
    if (result.added && opts.showPopup !== false) {
        const item = resolveCardItem(cardId)
        if (item) await showItemGetPopup(itemGetSpecForBagItem(item))
    }
    return result
}

async function addCardToVault(cardId, source = "unknown") {
    if (!isSignedIn() || !cardId) return { success: false, error: "Missing card" }

    const response = await fetch("/api/vault/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({ card_id: cardId, source })),
    })
    const data = await response.json()
    if (response.ok && data.success && session) {
        applyVaultFromServer(data.vault)
    }
    return data
}

async function grantHold(item, source = "") {
    const holdId = String(item || "").trim()
    if (!holdId || playerHasHold(holdId)) return
    if (!holdGrantRequirementsMet(holdId)) {
        console.warn("Grant blocked: prerequisites not met for", holdId)
        return
    }

    const meta = holdMeta(holdId) || { id: holdId, label: holdId }
    const priorHolds = normalizeHolds(session.holds)

    session.holds = normalizeHolds([...priorHolds, holdId])
    syncHoldUi()
    window.TelegramGame.setPlayerHolds?.(session.holds)

    try {
        const response = await fetch("/api/holds/grant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody({ item: holdId, source })),
        })
        const data = await response.json()
        if (!response.ok || !data.success) {
            console.warn("Could not grant hold:", data.error || holdId)
            session.holds = priorHolds
            syncHoldUi()
            window.TelegramGame.setPlayerHolds?.(session.holds)
            return
        }

        session.holds = normalizeHolds(data.holds)
        syncHoldUi()
        window.TelegramGame.setPlayerHolds?.(session.holds)

        const resolvedMeta = data.meta || meta
        if (data.newly_granted) {
            completeHoldQuestFromMeta(resolvedMeta)
            showHoldPickupPopup(resolvedMeta)
        }
    } catch (error) {
        console.warn("Could not grant hold:", error)
        session.holds = priorHolds
        syncHoldUi()
        window.TelegramGame.setPlayerHolds?.(session.holds)
    }
}

function getQuestProgress() {
    return normalizeQuestProgress(session?.quest_progress)
}

function isQuestStepComplete(stepId) {
    return getQuestProgress().completed_steps.includes(stepId)
}

function isQuestRemoved(questId) {
    return getQuestProgress().removed_quests.includes(questId)
}

function isQuestComplete(quest) {
    const steps = quest.steps || []
    if (!steps.length) return false
    return steps.every((step) => isQuestStepComplete(step.id))
}

function isQuestUnlocked(quest) {
    const unlock = quest.unlock_after
    if (!unlock) return true
    const prev = QUEST_CATALOG.find((q) => q.quest_id === unlock)
    return prev ? isQuestComplete(prev) : false
}

function questUnlockHint(quest) {
    if (!quest.unlock_after) return "Coming soon"
    const prev = QUEST_CATALOG.find((q) => q.quest_id === quest.unlock_after)
    return prev ? `Complete ${prev.title}` : "Previous quest required"
}

async function completeQuestStep(stepId, questId = null, opts = {}) {
    if (!isSignedIn()) return { success: false, error: "Not signed in" }

    const wasComplete = isQuestStepComplete(stepId)

    const response = await fetch("/api/quests/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({ step_id: stepId, quest_id: questId })),
    })
    const data = await response.json()
    if (response.ok && data.success && session) {
        session.quest_progress = normalizeQuestProgress(data.quest_progress)
        renderQuestBoard()
        if (data.trainer_stats) {
            applyTrainerStats(data.trainer_stats, {
                leveled_up: data.leveled_up,
                xp_gained: data.xp_gained,
            })
        } else if (Number(data.xp_gained) > 0) {
            showXpGainToast(Number(data.xp_gained))
        }

        if (!wasComplete && stepId === "collect_first_card") {
            const item = resolveCardItem(opts.bagItem || opts.cardId || getVaultCardIds()[0])
            if (item) showItemGetPopup(itemGetSpecForBagItem(item))
        }
    }
    return data
}

async function removeQuest(questId) {
    if (!isSignedIn()) return { success: false, error: "Not signed in" }

    const response = await fetch("/api/quests/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({ quest_id: questId })),
    })
    const data = await response.json()
    if (response.ok && data.success && session) {
        session.quest_progress = normalizeQuestProgress(data.quest_progress)
        renderQuestBoard()
    }
    return data
}

function renderQuestBoard() {
    const timeline = document.getElementById("quests-timeline")
    if (!timeline) return

    const visible = QUEST_CATALOG.filter((q) => !isQuestRemoved(q.quest_id))
    timeline.replaceChildren()

    visible.forEach((quest, nodeIndex) => {
        const steps = quest.steps || []
        const unlocked = isQuestUnlocked(quest)
        const complete = isQuestComplete(quest)
        const locked = !unlocked || steps.length === 0
        const isLast = nodeIndex === visible.length - 1

        const node = document.createElement("article")
        node.className = "quest-node"
        node.dataset.questId = quest.quest_id
        node.setAttribute("role", "listitem")

        if (locked) node.classList.add("quest-node--locked")
        else if (complete) node.classList.add("quest-node--complete")
        else node.classList.add("quest-node--active")
        if (isLast) node.classList.add("quest-node--last")

        const rail = document.createElement("div")
        rail.className = "quest-node-rail"
        rail.setAttribute("aria-hidden", "true")
        const dot = document.createElement("span")
        dot.className = "quest-node-dot"
        if (!locked && !complete) dot.classList.add("quest-node-dot--live")
        if (complete) dot.classList.add("quest-node-dot--done")
        rail.appendChild(dot)

        const card = document.createElement("div")
        card.className = "quest-wood-card"
        if (locked) card.classList.add("quest-wood-card--locked")

        const top = document.createElement("div")
        top.className = "quest-card-top"

        const badge = document.createElement("span")
        badge.className = "quest-badge"
        if (locked) {
            badge.classList.add("quest-badge--locked")
            badge.textContent = "LOCKED"
        } else if (complete) {
            badge.classList.add("quest-badge--complete")
            badge.textContent = "DONE"
        } else {
            badge.classList.add("quest-badge--live")
            badge.textContent = "ACTIVE"
        }

        const weekTag = document.createElement("span")
        weekTag.className = "quest-week-tag"
        weekTag.textContent = `Week ${quest.week}`

        top.append(badge, weekTag)

        const title = document.createElement("h3")
        title.className = "quest-title"
        title.textContent = quest.title

        const blurb = document.createElement("p")
        blurb.className = "quest-blurb"
        if (locked) blurb.classList.add("quest-blurb--locked")
        blurb.textContent = quest.blurb

        card.append(top, title, blurb)

        if (steps.length) {
            const list = document.createElement("ol")
            list.className = "quest-sub-list"

            let currentMarked = false
            steps.forEach((step, stepIndex) => {
                const done = isQuestStepComplete(step.id)
                const isCurrent = !locked && !done && !currentMarked
                if (isCurrent) currentMarked = true

                const item = document.createElement("li")
                item.className = "quest-sub"
                item.dataset.stepId = step.id
                item.dataset.questId = quest.quest_id
                if (done) item.classList.add("quest-sub--done")
                if (isCurrent) item.classList.add("quest-sub--current")

                const stepIdEl = document.createElement("span")
                stepIdEl.className = "quest-sub-id"
                stepIdEl.textContent = done ? "✓" : `${quest.week}.${stepIndex + 1}`

                const body = document.createElement("span")
                body.className = "quest-sub-body"

                const name = document.createElement("span")
                name.className = "quest-sub-name"
                name.textContent = step.name

                const hint = document.createElement("span")
                hint.className = "quest-sub-hint"
                hint.textContent = step.hint

                body.append(name, hint)
                item.append(stepIdEl, body)
                list.appendChild(item)
            })

            card.appendChild(list)
        }

        if (quest.prize) {
            const prize = document.createElement("div")
            prize.className = "quest-prize-strip"
            prize.innerHTML = `<span class="quest-prize-label">Prize</span><span class="quest-prize-value">${quest.prize}</span>`
            card.appendChild(prize)
        }

        if (locked) {
            const overlay = document.createElement("div")
            overlay.className = "quest-locked-overlay"
            overlay.setAttribute("aria-hidden", "true")
            overlay.innerHTML = `<span class="quest-lock-icon">?</span><span>${questUnlockHint(quest)}</span>`
            card.appendChild(overlay)
        }

        node.append(rail, card)
        timeline.appendChild(node)
    })
}

window.Quest = {
    catalog: QUEST_CATALOG,
    getProgress: getQuestProgress,
    isStepComplete: isQuestStepComplete,
    isQuestComplete,
    completeStep: completeQuestStep,
    removeQuest,
    refresh: renderQuestBoard,
}

window.Vault = {
    cardIds: getVaultCardIds,
    displayItems: getVaultDisplayItems,
    add: addCardToVault,
    receive: receivePokecard,
    catalog: () => CARD_CATALOG,
}

window.ItemGet = {
    show: showItemGetPopup,
    showHold: (holdId) => showItemGetPopup(holdMeta(holdId) || itemGetSpecForHold(holdId)),
    showBagItem: (itemOrId) => {
        const item = resolveCardItem(itemOrId)
        if (item) showItemGetPopup(itemGetSpecForBagItem(item))
    },
    addToVault: addCardToVault,
    receive: receivePokecard,
}

async function authenticate() {
    if (!isSignedIn()) {
        dismissBootSplash()
        showError(
            PLAY_MODE
                ? (walletRequired()
                    ? "Connect your wallet to continue."
                    : "Could not start play session.")
                : "Please open this app from Telegram."
        )
        return null
    }

    try { tg?.expand?.() } catch { /* ignore */ }

    setBootMessage(
        TEST_MODE
            ? `Loading test trainer${TEST_PLAYER_SLUG ? ` (${TEST_PLAYER_SLUG})` : ""}...`
            : (PLAY_MODE ? "Loading your trainer..." : "Signing you in...")
    )

    const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody()),
    })

    const raw = await response.text()
    let data
    try {
        data = JSON.parse(raw)
    } catch {
        dismissBootSplash()
        showError(
            response.ok
                ? "Authentication failed (invalid server response)."
                : `Server error (${response.status}). Is Flask running on port 5000?`
        )
        return null
    }
    if (!response.ok || !data.success) {
        dismissBootSplash()
        showError(
            data.error
                || (PLAY_MODE
                    ? (walletRequired()
                        ? "Authentication failed. Connect your wallet and try again."
                        : "Authentication failed. Refresh and try again.")
                    : "Authentication failed. Open the app from the PokéCards bot — send /start and tap Open Web App.")
        )
        return null
    }

    return data
}

function renderPinDisplay() {
    const slots = document.querySelectorAll("#pin-display .pin-slot")
    slots.forEach((slot, index) => {
        slot.classList.toggle("is-filled", index < pinBuffer.length)
    })
}

function clearPinStatus() {
    const status = document.getElementById("pin-status")
    if (status) {
        status.textContent = ""
        status.classList.remove("error")
    }
}

function resetPinEntry(mode) {
    pinMode = mode
    pinBuffer = ""
    renderPinDisplay()
    clearPinStatus()

    const title = document.getElementById("pin-title")
    const subtitle = document.getElementById("pin-subtitle")
    if (mode === "login") {
        if (title) title.textContent = "ENTER PIN"
        if (subtitle) subtitle.textContent = "3-digit trainer code"
    } else {
        if (title) title.textContent = "SET YOUR PIN"
        if (subtitle) subtitle.textContent = "Pick a 3-digit trainer code"
    }
}

function openPinScreen(mode) {
    resetPinEntry(mode)
    showScreen("pin")
}

function pinUnlocked() {
    if (TEST_MODE || guestPlayMode()) return true
    return Boolean(session?.has_pin && pinVerified)
}

function routeAfterAuth() {
    if (guestPlayMode()) {
        if (guestNeedsProfileSetup()) {
            if (session.has_skin && !guestHasRealName(session.display_name)) {
                openSkinSetupScreen()
            } else if (guestHasRealName(session.display_name) && !session.has_skin) {
                openSkinSetupScreen()
            } else {
                syncWelcomeCopy()
                showScreen("welcome")
            }
            return
        }
        showScreen("menu")
        startMenuStats()
        return
    }
    if (session.has_pin && !pinVerified) {
        openPinScreen("login")
        return
    }
    if (!session.has_pin) {
        showScreen("welcome")
        return
    }
    if (!session.has_skin) {
        openSkinSetupScreen()
        return
    }
    showScreen("menu")
    startMenuStats()
}

async function savePin(pin) {
    const response = await fetch("/api/pin/set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({ pin })),
    })
    const data = await response.json()
    if (!response.ok || !data.success) {
        throw new Error(data.error || "Could not save PIN")
    }
    return data
}

async function verifyPin(pin) {
    const response = await fetch("/api/pin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({ pin })),
    })
    const data = await response.json()
    if (!response.ok || !data.success) {
        throw new Error(data.error || "Wrong PIN")
    }
    return data
}

async function completePinEntry() {
    const status = document.getElementById("pin-status")
    if (pinBuffer.length !== 3) return

    if (status) {
        status.textContent = pinMode === "login" ? "Checking..." : "Saving..."
        status.classList.remove("error")
    }

    try {
        if (pinMode === "login") {
            await verifyPin(pinBuffer)
            pinVerified = true
            clearPinStatus()
            if (!session.has_skin) {
                openSkinSetupScreen()
            } else {
                showScreen("menu")
                startMenuStats()
            }
            return
        }

        await savePin(pinBuffer)
        session.has_pin = true
        pinVerified = true
        clearPinStatus()
        if (!session.has_skin) {
            openSkinSetupScreen()
        } else {
            showScreen("menu")
            startMenuStats()
        }
    } catch (error) {
        pinBuffer = ""
        renderPinDisplay()
        if (status) {
            status.textContent = error.message
            status.classList.add("error")
        }
    }
}

function bindPinKeypad() {
    const keypad = document.getElementById("pin-keypad")
    if (!keypad || keypad.dataset.bound === "1") return
    keypad.dataset.bound = "1"

    keypad.addEventListener("click", (event) => {
        const btn = event.target.closest(".pin-key")
        if (!btn) return

        window.RetroAudio?.resume()
        window.RetroAudio?.sfx("interact")

        if (btn.dataset.action === "back") {
            pinBuffer = pinBuffer.slice(0, -1)
            renderPinDisplay()
            clearPinStatus()
            return
        }

        const digit = btn.dataset.digit
        if (!digit || pinBuffer.length >= 3) return

        pinBuffer += digit
        renderPinDisplay()
        clearPinStatus()
        if (pinBuffer.length === 3) {
            completePinEntry()
        }
    })
}

async function saveSkin(skin, displayName) {
    const response = await fetch("/api/skin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiAuthBody({ skin, displayName })),
    })

    const data = await response.json()
    if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to save skin")
    }

    return data
}

function populateMenu() {
    updateBalanceDisplays()
    renderGameHudXp()
    const lvl = Number(session?.level ?? session?.trainer_stats?.level) || 0
    const xp = Number(session?.trainer_stats?.stats_xp) || 0
    document.getElementById("menu-player-name").textContent = truncateDisplayName(session.display_name)
    const metaParts = [`Lv.${lvl}`, `${xp} XP`]
    if (session.username) metaParts.push(`@${session.username}`)
    else metaParts.push("Telegram trainer")
    document.getElementById("menu-player-meta").textContent = metaParts.join(" · ")

    const badgesEl = document.getElementById("menu-player-badges")
    if (badgesEl) {
        const badges = Array.isArray(session.badges) ? session.badges : []
        badgesEl.replaceChildren()

        for (const badge of badges) {
            const label = typeof badge === "string" ? badge : badge?.label || badge?.id || ""
            if (!label) continue
            const item = document.createElement("span")
            item.className = "player-badges-item"
            item.textContent = label
            badgesEl.appendChild(item)
        }
    }

    updateMenuAvatar(session.skin)
    initSkinNameInput()
}

function bindSkinControls(prevId, nextId, onChange) {
    document.getElementById(prevId).addEventListener("click", () => {
        skinIndex = (skinIndex - 1 + sortedSkins.length) % sortedSkins.length
        onChange(sortedSkins[skinIndex])
    })

    document.getElementById(nextId).addEventListener("click", () => {
        skinIndex = (skinIndex + 1) % sortedSkins.length
        onChange(sortedSkins[skinIndex])
    })
}

function applyGameLoadingAvatar(skin, directionIndex = 0) {
    const el = document.getElementById("game-loading-avatar")
    if (!el) return
    const frame = SKIN_IDLE_DIRECTIONS[directionIndex % SKIN_IDLE_DIRECTIONS.length]
    const box = GAME_LOADING_AVATAR_SIZE
    const zoom = box / frame.h
    const renderW = frame.w * zoom
    const bgX = -((frame.x * zoom) - (box - renderW) / 2)

    el.style.width = `${box}px`
    el.style.height = `${box}px`
    el.style.backgroundImage = `url(${skinImage(skin)})`
    el.style.backgroundSize = `${SKIN_SHEET * zoom}px ${SKIN_SHEET * zoom}px`
    el.style.backgroundPosition = `${bgX}px ${-(frame.y * zoom)}px`
}

function startGameLoadingAvatar(skin) {
    stopGameLoadingAvatar()
    gameLoadingDirectionIndex = 0
    const tick = () => {
        applyGameLoadingAvatar(skin, gameLoadingDirectionIndex)
        gameLoadingDirectionIndex = (gameLoadingDirectionIndex + 1) % SKIN_IDLE_DIRECTIONS.length
    }
    tick()
    gameLoadingDirectionTimer = setInterval(tick, 450)
}

function stopGameLoadingAvatar() {
    if (gameLoadingDirectionTimer) {
        clearInterval(gameLoadingDirectionTimer)
        gameLoadingDirectionTimer = null
    }
}

function setGameLoading(text, visible = true) {
    const overlay = document.getElementById("game-loading")
    const label = document.getElementById("game-loading-text")
    if (label && text) label.textContent = text
    overlay?.classList.toggle("hidden", !visible)
    if (visible) {
        const skin = session?.skin || sortedSkins[skinIndex] || sortedSkins[0]
        startGameLoadingAvatar(skin)
    } else {
        stopGameLoadingAvatar()
    }
}

function showJoinToast(username) {
    const stack = document.getElementById("join-toast-stack")
    if (!stack) return

    const toast = document.createElement("div")
    toast.className = "join-toast"
    toast.textContent = `${truncateDisplayName(username)} joined`
    stack.appendChild(toast)

    while (stack.children.length > 4) {
        stack.removeChild(stack.firstChild)
    }

    setTimeout(() => toast.remove(), 3200)
}

function bindJoinToasts() {
    if (!window.TelegramGame?.onGameEvent) return null
    const handler = (data) => {
        if (data?.username) showJoinToast(data.username)
    }
    window.TelegramGame.onGameEvent("playerJoined", handler)
    return handler
}

let joinToastHandler = null
let questsReturnScreen = "menu"

let lbData = null
let lbActiveCategory = 0

function escapeLbText(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

function formatLbNumber(value) {
    const n = Number(value) || 0
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 10_000) return `${Math.round(n / 1000)}K`
    if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`
    return n.toLocaleString()
}

function applyLbAvatar(el, skin) {
    if (!el) return
    const id = skin && SKINS.includes(skin) ? skin : DEFAULT_SKIN
    applySpritePreview(el, id, SKIN_FRAME, 1.15)
}

function renderLbPulse(global) {
    const map = {
        "lb-pulse-trainers": formatLbNumber(global?.trainers),
        "lb-pulse-battles": formatLbNumber(global?.battles_fought),
        "lb-pulse-wagered": formatLbNumber(global?.tokens_wagered),
        "lb-pulse-cards": formatLbNumber(global?.cards_in_vaults),
        "lb-pulse-wins": formatLbNumber(global?.total_wins),
        "lb-pulse-circulating": formatLbNumber(global?.tokens_circulating),
    }
    for (const [id, text] of Object.entries(map)) {
        const el = document.getElementById(id)
        if (el) el.textContent = text
    }
}

function renderLbYouCard(data, categoryId) {
    const card = document.getElementById("lb-you-card")
    const rankEl = document.getElementById("lb-you-rank")
    const statsEl = document.getElementById("lb-you-stats")
    if (!card || !rankEl || !statsEl) return

    const rank = data.your_ranks?.[categoryId]
    const stats = data.your_stats
    if (!stats) {
        card.classList.add("hidden")
        return
    }

    card.classList.remove("hidden")
    if (rank) {
        rankEl.textContent = `#${rank} on this board`
    } else {
        rankEl.textContent = "Not ranked in the top 10 for this category."
    }

    const parts = [
        `Lv.${stats.level ?? 0} · ${stats.stats_xp ?? 0} XP`,
        `${stats.stats_wagered.toLocaleString()} wagered`,
        `${stats.stats_battles} battles · ${stats.stats_wins}W / ${stats.stats_losses ?? 0}L`,
        `${stats.vault_count} vault cards`,
        `${stats.balance.toLocaleString()} $POKE balance`,
    ]
    if (stats.win_rate != null) parts.push(`${stats.win_rate}% win rate`)
    statsEl.textContent = parts.join(" · ")
}

async function openTrainerStats(returnScreen = "menu") {
    trainerStatsReturnScreen = returnScreen
    showScreen("trainerStats")
    const grid = document.getElementById("trainer-stats-grid")
    const historyEl = document.getElementById("trainer-stats-history")
    const subtitle = document.getElementById("trainer-stats-subtitle")
    if (grid) grid.innerHTML = `<p class="poketab-empty">LOADING STATS...</p>`
    if (historyEl) historyEl.replaceChildren()
    try {
        const res = await fetch("/api/trainer/stats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody()),
        })
        const data = await res.json()
        if (!res.ok || !data.success) throw new Error(data.error || "Could not load stats")
        const stats = data.stats || {}
        session.trainer_stats = stats
        session.level = stats.level ?? 0
        populateMenu()
        const lvlEl = document.getElementById("trainer-stats-level")
        const xpEl = document.getElementById("trainer-stats-xp")
        const xpFill = document.getElementById("trainer-stats-xpfill")
        if (lvlEl) lvlEl.textContent = `Lv.${stats.level ?? 0} · ${stats.level_title || "Trainer"}`
        const into = stats.xp_into_level ?? 0
        const span = Math.max(1, stats.xp_span ?? 1)
        const toNext = stats.xp_to_next_level ?? Math.max(0, span - into)
        if (xpEl) {
            xpEl.textContent = stats.next_level != null
                ? `${stats.stats_xp ?? 0} XP · ${into}/${span} toward Lv.${stats.next_level}`
                : `${stats.stats_xp ?? 0} XP · max level`
        }
        if (xpFill) xpFill.style.width = `${Math.min(100, (into / span) * 100)}%`
        const reqHint = formatNextLevelRequirements(stats)
        const reqHintEl = document.getElementById("trainer-stats-req-hint")
        if (reqHintEl) {
            reqHintEl.textContent = reqHint ? `Next level: ${reqHint}` : ""
        }
        if (subtitle) {
            subtitle.textContent = stats.display_name
                ? `${stats.display_name}'s battle record`
                : "Your battle record"
        }
        if (grid) {
            grid.innerHTML = [
                ["Battles", stats.stats_battles ?? 0],
                ["Wins", stats.stats_wins ?? 0],
                ["Losses", stats.stats_losses ?? 0],
                ["Total XP", stats.stats_xp ?? 0],
                ["Wagered", `${(stats.stats_wagered ?? 0).toLocaleString()} $POKE`],
                ["Balance", `${(stats.balance ?? 0).toLocaleString()} $POKE`],
                ["Vault cards", stats.vault_count ?? 0],
                ["Win rate", stats.win_rate != null ? `${stats.win_rate}%` : "—"],
            ].map(([label, val]) => `
                <div class="trainer-stats-cell">
                    <span class="trainer-stats-label">${escapeLbText(label)}</span>
                    <span class="trainer-stats-val">${escapeLbText(String(val))}</span>
                </div>
            `).join("")
        }
        if (historyEl) {
            const rows = data.recent_battles || []
            historyEl.replaceChildren()
            if (!rows.length) {
                const li = document.createElement("li")
                li.className = "trainer-stats-history-empty"
                li.textContent = "No battles logged yet."
                historyEl.appendChild(li)
            } else {
                for (const row of rows) {
                    const li = document.createElement("li")
                    li.className = `trainer-stats-history-row${row.won ? " won" : " lost"}`
                    const src = row.source === "poketab" ? "PokéTab" : row.source === "telegram" ? "TG" : row.source
                    const bet = row.bet ? `${Number(row.bet).toLocaleString()} $POKE` : "—"
                    li.textContent = `${row.won ? "WIN" : "LOSS"} · ${src} · ${bet}`
                    historyEl.appendChild(li)
                }
            }
        }
    } catch (err) {
        if (grid) grid.innerHTML = `<p class="poketab-empty">${escapeLbText(err.message)}</p>`
    }
}

function renderLbPodiumAndList(category) {
    const podium = document.getElementById("lb-podium")
    const list = document.getElementById("lb-rank-list")
    if (!podium || !list) return

    podium.replaceChildren()
    list.replaceChildren()

    const entries = category?.entries || []
    if (!entries.length) {
        podium.className = "lb-podium lb-podium--empty"
        podium.innerHTML = `<p class="lb-empty">No rankings yet. Battle or collect cards to appear on this board.</p>`
        return
    }

    podium.className = "lb-podium"

    const top3 = entries.slice(0, 3)
    const rest = entries.slice(3)

    for (const entry of top3) {
        const slot = document.createElement("div")
        slot.className = `lb-podium-slot rank-${entry.rank}`
        const youMark = entry.is_you ? " ★" : ""
        slot.innerHTML = `
            <div class="lb-podium-avatar" role="img" aria-label="${escapeLbText(entry.display_name)}"></div>
            <div class="lb-podium-bar">
                <div class="lb-podium-rank">#${entry.rank}</div>
                <div class="lb-podium-name" title="${escapeLbText(entry.display_name)}">${escapeLbText(entry.display_name)}${entry.level ? ` · Lv.${entry.level}` : ""}${youMark}</div>
                <div class="lb-podium-val">${escapeLbText(entry.value_display)}</div>
            </div>`
        applyLbAvatar(slot.querySelector(".lb-podium-avatar"), entry.skin)
        podium.appendChild(slot)
    }

    for (const entry of rest) {
        const li = document.createElement("li")
        li.className = `lb-rank-row${entry.is_you ? " is-you" : ""}`
        const youMark = entry.is_you ? " ★" : ""
        li.innerHTML = `
            <span class="lb-rank-num">#${entry.rank}</span>
            <span class="lb-rank-name" title="${escapeLbText(entry.display_name)}">${escapeLbText(entry.display_name)}${entry.level ? ` · Lv.${entry.level}` : ""}${youMark}</span>
            <span class="lb-rank-val">${escapeLbText(entry.value_display)}</span>`
        list.appendChild(li)
    }
}

function renderLbCategory(index) {
    if (!lbData?.categories?.length) return
    lbActiveCategory = index
    const category = lbData.categories[index]

    document.querySelectorAll(".lb-tab").forEach((btn, i) => {
        btn.classList.toggle("active", i === index)
        btn.setAttribute("aria-selected", i === index ? "true" : "false")
    })

    const head = document.getElementById("lb-category-head")
    if (head) {
        head.innerHTML = `
            <div class="lb-cat-title">${escapeLbText(category.title)}</div>
            <div class="lb-cat-tagline">${escapeLbText(category.tagline)}</div>`
    }

    renderLbPodiumAndList(category)
    renderLbYouCard(lbData, category.id)
}

function renderLbTabs() {
    const tabs = document.getElementById("lb-tabs")
    if (!tabs || !lbData?.categories) return
    tabs.replaceChildren()
    lbData.categories.forEach((cat, index) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `lb-tab${index === lbActiveCategory ? " active" : ""}`
        btn.setAttribute("role", "tab")
        btn.setAttribute("aria-selected", index === lbActiveCategory ? "true" : "false")
        btn.textContent = cat.title
        btn.addEventListener("click", () => renderLbCategory(index))
        tabs.appendChild(btn)
    })
}

function renderLeaderboard(data) {
    lbData = data
    renderLbPulse(data.global)
    renderLbTabs()
    renderLbCategory(lbActiveCategory)
}

async function openLeaderboard() {
    showScreen("leaderboard")
    const scrollBody = document.querySelector("#leaderboard-screen .lb-scroll-body")
    if (scrollBody) scrollBody.scrollTop = 0

    try {
        const opts = { method: "GET" }
        if (isSignedIn()) {
            opts.method = "POST"
            opts.headers = { "Content-Type": "application/json" }
            opts.body = JSON.stringify(apiAuthBody())
        }
        const response = await fetch("/api/leaderboard", opts)
        const data = await response.json()
        if (!response.ok || !data.success) {
            throw new Error(data.error || "Could not load leaderboard.")
        }
        renderLeaderboard(data)
    } catch (error) {
        const podium = document.getElementById("lb-podium")
        const list = document.getElementById("lb-rank-list")
        if (podium) {
            podium.innerHTML = `<p class="lb-empty">${escapeLbText(error.message || "Leaderboard unavailable.")}</p>`
        }
        if (list) list.replaceChildren()
    }
}

const PAD_DIRECTIONS = ["up", "down", "left", "right"]
const PAD_DEAD_ZONE = 0.24
let padDirectionState = { up: false, down: false, left: false, right: false }
let padJoystickPointerId = null

let enterRealmBusy = false

function bindMenuAction(el, handler) {
    if (!el || el.dataset.boundAction === "1") return
    el.dataset.boundAction = "1"
    let lastFire = 0
    const run = (event) => {
        if (event?.type === "pointerup" && event.button !== 0) return
        const now = Date.now()
        if (now - lastFire < 350) return
        lastFire = now
        handler(event)
    }
    el.addEventListener("click", run)
    el.addEventListener("pointerup", run)
}

async function handleEnterRealm() {
    const menuStatus = document.getElementById("menu-status")
    const enterBtn = document.getElementById("enter-btn")

    if (enterRealmBusy) return

    if (!playSpectatorMode && !pinUnlocked()) {
        if (menuStatus) {
            menuStatus.textContent = session?.has_pin
                ? "Enter your trainer PIN first."
                : "Set a trainer PIN first."
            menuStatus.classList.remove("error")
        }
        openPinScreen(session?.has_pin ? "login" : "setup")
        return
    }

    enterRealmBusy = true
    if (enterBtn) enterBtn.disabled = true
    if (menuStatus) {
        menuStatus.textContent = "Opening realm..."
        menuStatus.classList.remove("error")
    }

    try {
        await enterGame()
    } finally {
        enterRealmBusy = false
        if (enterBtn) enterBtn.disabled = false
        if (menuStatus?.textContent === "Opening realm...") {
            menuStatus.textContent = ""
        }
    }
}

async function enterGame() {
    const menuStatus = document.getElementById("menu-status")
    if (menuStatus) {
        menuStatus.textContent = ""
        menuStatus.classList.remove("error")
    }

    setGameLoading(playSpectatorMode ? "ENTERING REALM" : "OPENING REALM")

    try {
        await loadGameClient()
        bindGameEvents()

        if (!joinToastHandler) {
            joinToastHandler = bindJoinToasts()
        }
    } catch (error) {
        setGameLoading("", false)
        if (menuStatus) {
            menuStatus.textContent = error.message || "Could not load game."
            menuStatus.classList.add("error")
        }
        return
    }

    showScreen("game")
    setGameLoading("CONNECTING")
    startGameHud()

    try {
        const controller = new AbortController()
        const authTimer = setTimeout(() => controller.abort(), 20000)
        const response = await fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody()),
            signal: controller.signal,
        })
        clearTimeout(authTimer)
        const fresh = await response.json()
        if (!response.ok || !fresh.success) {
            throw new Error(fresh.error || "Session expired. Reopen the app.")
        }
        session = {
            ...session,
            ...fresh,
            quest_progress: normalizeQuestProgress(fresh.quest_progress),
            holds: normalizeHolds(fresh.holds),
            gear_slots: normalizeGearSlots(fresh.gear_slots),
            vault: normalizeVault(fresh.vault),
        }
    } catch (error) {
        setGameLoading("", false)
        stopGameHud()
        showScreen("menu")
        startMenuStats()
        const msg = error.name === "AbortError"
            ? "Connection timed out. Check your network and try again."
            : (error.message || "Could not connect.")
        if (menuStatus) {
            menuStatus.textContent = msg
            menuStatus.classList.add("error")
        }
        return
    }

    setGameLoading("LOADING WORLD")
    syncHoldUi()
    syncQuickbar()

    const playSkin = session.skin || sortedSkins[skinIndex] || DEFAULT_SKIN
    const playName = (session.display_name || "Trainer").trim() || "Trainer"
    if (!playSkin) {
        setGameLoading("", false)
        stopGameHud()
        showScreen("menu")
        startMenuStats()
        menuStatus.textContent = "Choose an avatar before entering the realm."
        menuStatus.classList.add("error")
        return
    }

    let result
    try {
        result = await window.TelegramGame.startGame({
            uid: String(session.telegram_id),
            username: playName,
            skin: playSkin,
            level: Number(session.level ?? session.trainer_stats?.level) || 0,
            holds: normalizeHolds(session.holds),
            holdGrantRules: holdGrantRulesForClient(),
            backendUrl: window.location.origin,
            socketUrl: window.APP_CONFIG.gameSocketUrl || "",
            spectator: playSpectatorMode,
            onProgress: (message) => setGameLoading(message.toUpperCase()),
        })
    } catch (error) {
        setGameLoading("", false)
        stopGameHud()
        showScreen("menu")
        startMenuStats()
        document.getElementById("menu-status").textContent = error.message || "Could not join the world."
        document.getElementById("menu-status").classList.add("error")
        return
    }

    setGameLoading("", false)

    if (!result.success) {
        stopGameHud()
        showScreen("menu")
        startMenuStats()
        document.getElementById("menu-status").textContent = result.error || "Could not join the world."
        document.getElementById("menu-status").classList.add("error")
        return
    }

    window.RetroAudio?.resume()
    window.RetroAudio?.setScene("overworld")
    window.PoketabSocial?.startBadgePolling?.()
    syncEquippedGearVisual()
    syncPlayerGearToGame()
    window.TelegramGame?.setFishingMode?.(activeFishingMode)
}

let activeMessageSetId = null

function getDialogueStorageKey() {
    const id = session?.telegram_id
    return id ? `saipoke_seen_message_sets_${id}` : "saipoke_seen_message_sets"
}

function getSeenMessageSets() {
    try {
        const raw = localStorage.getItem(getDialogueStorageKey())
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed.filter(Boolean) : []
    } catch {
        return []
    }
}

function isMessageSetSeen(messageSetId) {
    return !!(messageSetId && getSeenMessageSets().includes(messageSetId))
}

function markMessageSetSeen(messageSetId) {
    if (!messageSetId) return
    const seen = new Set(getSeenMessageSets())
    if (seen.has(messageSetId)) return
    seen.add(messageSetId)
    localStorage.setItem(getDialogueStorageKey(), JSON.stringify([...seen]))
}

function hideSignModal(opts = {}) {
    const options = opts && typeof opts === "object" ? opts : {}

    if (!options.fromNpcFinish) {
        const closedNpcDialogue = window.TelegramGame.finishNpcDialogue?.()
        if (!closedNpcDialogue) {
            window.TelegramGame.onSignModalClosed?.()
        }
    }

    activeMessageSetId = null
    document.body.classList.remove("dialogue-active")

    const modal = document.getElementById("sign-modal")
    if (modal) modal.classList.add("hidden")
    document.getElementById("sign-modal-close")?.classList.remove("hidden")
    document.getElementById("sign-modal-next")?.classList.add("hidden")
    document.getElementById("sign-modal-skip")?.classList.add("hidden")
    document.getElementById("sign-modal-box")?.classList.remove("has-next", "has-skip", "has-options")
    document.getElementById("sign-modal-title")?.classList.remove("no-close-padding")
    const optionsEl = document.getElementById("sign-modal-options")
    if (optionsEl) {
        optionsEl.innerHTML = ""
        optionsEl.classList.add("hidden")
    }
    if (!opts.skipAudioSync) syncRetroAudioAfterDialogue()
}

/* ── Vending machine (use_vending) ── */
let vendingBusy = false
let vendingBootTimer = null
let vendingPendingWinner = null
let vendingEquipResolve = null

const VENDING_CARD_WIDTH = 92
const VENDING_SHUFFLE_SLOTS = 48
const VENDING_WINNER_SLOT = 38

function isWalletVerified() {
    return true
}

function vendingSpinCount() {
    return Math.max(0, Number(session?.vending_spins) || 0)
}

function vendingSpinCost() {
    return vendingSpinCount() <= 0 ? VENDING_SPIN_FIRST_COST : VENDING_SPIN_REPEAT_COST
}

function vendingAccessCheck() {
    if (!isWalletVerified()) {
        return { ok: false, code: "WALLET", message: "WALLET NOT VERIFIED.\nLINK YOUR WALLET TO USE THIS TERMINAL." }
    }
    if (!playerHasHold("card_vault")) {
        return { ok: false, code: "VAULT", message: "NO POKÉ VAULT DETECTED.\nOBTAIN A VAULT BEFORE USING THE MACHINE." }
    }
    return { ok: true }
}

function hasUsedFreeVendingDraw() {
    return isQuestStepComplete("collect_first_card")
}

function vendingBeep(freq = 880, duration = 0.07, volume = 0.06) {
    if (window.RetroAudio?.beep) {
        window.RetroAudio.resume()
        window.RetroAudio.beep(freq, duration, volume)
        return
    }
}

function vendingBeepSequence() {
    vendingBeep(660, 0.05)
    setTimeout(() => vendingBeep(880, 0.05), 70)
    setTimeout(() => vendingBeep(1100, 0.08), 140)
}

function vendingSetLeds(state) {
    const machine = document.getElementById("vending-machine")
    if (!machine) return
    machine.dataset.ledState = state
}

function vendingShowView(viewId) {
    const views = [
        "vending-view-boot",
        "vending-view-menu",
        "vending-view-error",
        "vending-view-soon",
        "vending-view-shuffle",
        "vending-view-result",
    ]
    for (const id of views) {
        document.getElementById(id)?.classList.toggle("hidden", id !== viewId)
    }
}

function vendingSetButtonsEnabled(enabled) {
    for (const id of ["vending-btn-draw", "vending-btn-sell", "vending-btn-buy"]) {
        const btn = document.getElementById(id)
        if (btn) btn.disabled = !enabled
    }
}

function vendingUpdateDrawButton() {
    const btn = document.getElementById("vending-btn-draw")
    const menuLine = document.getElementById("vending-menu-draw-line")
    if (!btn) return
    const cost = vendingSpinCost()
    const balance = session?.balance ?? 0
    const canAfford = balance >= cost
    btn.disabled = vendingBusy || !canAfford
    btn.classList.toggle("vending-btn-unaffordable", !canAfford && !vendingBusy)
    btn.innerHTML = `<span class="vending-btn-led" aria-hidden="true"></span>DRAW POKÉCARD<span class="vending-btn-price">${formatChipsAmount(cost)} $POKE</span>`
    if (menuLine) {
        menuLine.textContent = `> DRAW  — SPIN ${formatChipsAmount(cost)} $POKE`
    }
}

function vendingDrawPool() {
    return POOL_ITEMS.length ? POOL_ITEMS : BAG_ITEMS
}

/** Cards allowed on the shuffle reel (excludes poke.json entries with shuffle: false). */
function vendingShufflePool() {
    return vendingDrawPool().filter((item) => item.shuffle !== false)
}

function vendingTypeLabel(type) {
    const labels = {
        Fire: "🔥 FIRE",
        Water: "💧 WATER",
        Grass: "🌿 GRASS",
        Rock: "🪨 ROCK",
        Ghost: "👻 GHOST",
        Electric: "⚡ ELECTRIC",
        Legendary: "🌟 LEGENDARY",
        Basic: "🐾 BASIC",
    }
    return labels[type] || type || "???"
}

function vendingHideEquipButton() {
    const btn = document.getElementById("vending-btn-equip")
    if (btn) {
        btn.classList.add("hidden")
        btn.disabled = false
    }
}

function vendingShowEquipButton() {
    const btn = document.getElementById("vending-btn-equip")
    if (btn) {
        btn.classList.remove("hidden")
        btn.disabled = false
    }
}

function vendingWaitForEquip() {
    return new Promise((resolve) => {
        vendingEquipResolve = resolve
    })
}

async function vendingConfirmEquip() {
    if (!vendingPendingWinner) return

    const winner = vendingPendingWinner
    const equipBtn = document.getElementById("vending-btn-equip")
    if (equipBtn) equipBtn.disabled = true

    vendingBeep(1100, 0.08, 0.07)
    vendingBeep(1320, 0.1, 0.08)

    const item = resolveCardItem(winner)
    if (item) await showItemGetPopup(itemGetSpecForBagItem(item))

    await completeQuestStep("collect_first_card", "week1_vault_trail", {
        bagItem: winner,
        cardId: winner.id,
    })

    vendingPendingWinner = null
    vendingHideEquipButton()
    vendingBusy = false
    vendingUpdateDrawButton()
    closeVendingScreen()

    if (vendingEquipResolve) {
        vendingEquipResolve()
        vendingEquipResolve = null
    }
}

function vendingShowCardResult(card) {
    vendingShowView("vending-view-result")
    const imgEl = document.getElementById("vending-result-card")
    const nameEl = document.getElementById("vending-result-name")
    const metaEl = document.getElementById("vending-result-meta")
    const spellsEl = document.getElementById("vending-result-spells")

    if (imgEl) {
        imgEl.src = card?.src || ""
        imgEl.alt = card?.name || "Card"
    }
    if (nameEl) nameEl.textContent = card?.name || "Unknown"
    if (metaEl) {
        const parts = [
            vendingTypeLabel(card?.type),
            card?.hp != null ? `HP ${card.hp}` : null,
            card?.lvl != null ? `LV ${card.lvl}` : null,
        ].filter(Boolean)
        metaEl.textContent = parts.join("  ·  ")
    }
    if (spellsEl) {
        spellsEl.replaceChildren()
        const spells = Array.isArray(card?.spells) ? card.spells : []
        if (!spells.length) {
            const li = document.createElement("li")
            li.textContent = "No move data scanned."
            spellsEl.appendChild(li)
        } else {
            for (const spell of spells) {
                const li = document.createElement("li")
                if (spell.is_defence) {
                    li.className = "vending-spell-def"
                    li.textContent = `${spell.name} — DEF · PP ${spell.max_count}`
                } else {
                    li.textContent = `${spell.name} — ${spell.attack} DMG · PP ${spell.max_count}`
                }
                spellsEl.appendChild(li)
            }
        }
    }
}

function vendingRandomCard() {
    const pool = vendingDrawPool()
    if (!pool.length) return null
    return pool[Math.floor(Math.random() * pool.length)]
}

function vendingBuildShuffleDeck(winner) {
    const reelPool = vendingShufflePool()
    const fillers = reelPool.length ? reelPool : [winner]
    const deck = []
    for (let i = 0; i < VENDING_SHUFFLE_SLOTS; i += 1) {
        if (i === VENDING_WINNER_SLOT) {
            deck.push(winner)
        } else {
            deck.push(fillers[Math.floor(Math.random() * fillers.length)] || winner)
        }
    }
    return deck
}

function vendingRenderShuffleTrack(deck) {
    const track = document.getElementById("vending-shuffle-track")
    if (!track) return
    track.replaceChildren()
    track.style.transition = "none"
    track.style.transform = "translateX(0)"

    for (const item of deck) {
        const slot = document.createElement("div")
        slot.className = "vending-shuffle-card"
        const img = document.createElement("img")
        img.src = item?.src || ""
        img.alt = item?.name || "Card"
        slot.appendChild(img)
        track.appendChild(slot)
    }
}

function vendingRunBootSequence(access) {
    return new Promise((resolve) => {
        vendingShowView("vending-view-boot")
        vendingSetLeds("boot")
        const bootEl = document.getElementById("vending-boot-text")
        if (!bootEl) {
            resolve()
            return
        }

        const vaultOk = access.ok
        const lines = [
            "> POKÉCARD VTM-9000",
            "> POWER ON.............. OK",
            "> CRT WARMUP............ OK",
            `> WALLET LINK........... ${isWalletVerified() ? "OK" : "FAIL"}`,
            `> VAULT SYNC............ ${vaultOk ? "OK" : "MISSING"}`,
            vaultOk ? "> TERMINAL READY_" : "> ACCESS DENIED_",
        ]

        bootEl.textContent = ""
        let lineIndex = 0
        clearInterval(vendingBootTimer)
        vendingBootTimer = setInterval(() => {
            if (lineIndex >= lines.length) {
                clearInterval(vendingBootTimer)
                vendingBootTimer = null
                vendingBeep(990, 0.06)
                resolve()
                return
            }
            bootEl.textContent += `${lines[lineIndex]}\n`
            vendingBeep(520 + lineIndex * 40, 0.04, 0.04)
            lineIndex += 1
        }, 220)
    })
}

function openVendingScreen() {
    const screen = document.getElementById("vending-screen")
    if (!screen || vendingBusy) return

    hideSignModal()
    vendingPendingWinner = null
    vendingHideEquipButton()
    screen.classList.remove("hidden")
    document.body.classList.add("vending-open")
    window.RetroAudio?.resume()
    window.RetroAudio?.setScene("silent")
    vendingBusy = false
    vendingSetButtonsEnabled(false)
    vendingUpdateDrawButton()

    const access = vendingAccessCheck()
    vendingBeepSequence()
    vendingSetLeds("power")

    vendingRunBootSequence(access).then(() => {
        if (!access.ok) {
            vendingShowView("vending-view-error")
            const codeEl = document.getElementById("vending-error-code")
            const msgEl = document.getElementById("vending-error-msg")
            if (codeEl) codeEl.textContent = `ERR-${access.code}`
            if (msgEl) msgEl.textContent = access.message
            vendingSetLeds("error")
            vendingBeep(180, 0.15, 0.08)
            return
        }

        vendingShowView("vending-view-menu")
        vendingSetLeds("ready")
        vendingSetButtonsEnabled(true)
        vendingUpdateDrawButton()
    })
}

function closeVendingScreen() {
    clearInterval(vendingBootTimer)
    vendingBootTimer = null
    const screen = document.getElementById("vending-screen")
    screen?.classList.add("hidden")
    document.body.classList.remove("vending-open")
    vendingPendingWinner = null
    vendingHideEquipButton()
    if (vendingEquipResolve) {
        vendingEquipResolve()
        vendingEquipResolve = null
    }
    vendingBusy = false
    vendingSetLeds("off")
    vendingSetButtonsEnabled(true)
    syncRetroAudioAfterDialogue()
}

function vendingShowSoon(title, message) {
    vendingShowView("vending-view-soon")
    const titleEl = document.getElementById("vending-soon-title")
    const msgEl = document.getElementById("vending-soon-msg")
    if (titleEl) titleEl.textContent = title
    if (msgEl) msgEl.textContent = message
    vendingSetLeds("busy")
    vendingBeep(440, 0.06)
}

async function vendingPerformDraw() {
    if (vendingBusy) return
    const access = vendingAccessCheck()
    if (!access.ok) return

    const cost = vendingSpinCost()
    const balance = session?.balance ?? 0
    if (balance < cost) {
        vendingShowView("vending-view-error")
        document.getElementById("vending-error-code").textContent = "ERR-FUNDS"
        document.getElementById("vending-error-msg").textContent =
            `INSUFFICIENT CHIPS.\nNEED ${formatChipsAmount(cost)} $POKE TO SPIN.`
        vendingSetLeds("error")
        vendingBeep(200, 0.1)
        return
    }

    vendingBusy = true
    vendingSetButtonsEnabled(false)
    vendingSetLeds("busy")
    vendingBeep(740, 0.05)

    let winner = null
    try {
        const response = await fetch("/api/vending/spin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody()),
        })
        const data = await response.json()
        if (!response.ok || data.success === false) {
            throw new Error(data.error || "Spin failed")
        }
        if (session) {
            session.balance = Number(data.balance) || 0
            session.vending_spins = Number(data.vending_spins) || 0
            updateBalanceDisplays()
            applyVaultFromServer(data.vault)
        }
        winner = resolveCardItem(data.card_id) || data.card
        if (!winner) throw new Error("Draw failed")
    } catch (err) {
        vendingBusy = false
        vendingSetButtonsEnabled(true)
        vendingUpdateDrawButton()
        vendingShowView("vending-view-error")
        document.getElementById("vending-error-code").textContent = "ERR-SPIN"
        document.getElementById("vending-error-msg").textContent = String(err.message || "SPIN FAILED.")
        vendingSetLeds("error")
        vendingBeep(200, 0.1)
        return
    }

    vendingShowView("vending-view-shuffle")
    const deck = vendingBuildShuffleDeck(winner)
    vendingRenderShuffleTrack(deck)

    const track = document.getElementById("vending-shuffle-track")
    const statusEl = document.getElementById("vending-shuffle-status")
    const windowEl = document.querySelector(".vending-shuffle-window")
    const windowWidth = windowEl?.clientWidth || 280
    const centerOffset = (windowWidth - VENDING_CARD_WIDTH) / 2
    const targetX = -(VENDING_WINNER_SLOT * VENDING_CARD_WIDTH - centerOffset)

    const bars = ["▮▯▯▯▯▯", "▮▮▯▯▯▯", "▮▮▮▯▯▯", "▮▮▮▮▯▯", "▮▮▮▮▮▯", "▮▮▮▮▮▮"]
    let barIdx = 0
    const barTimer = setInterval(() => {
        if (statusEl) statusEl.textContent = bars[barIdx % bars.length]
        barIdx += 1
        if (barIdx % 2 === 0) vendingBeep(600 + barIdx * 30, 0.025, 0.035)
    }, 120)

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    if (track) {
        track.style.transition = "transform 3.4s cubic-bezier(0.08, 0.85, 0.15, 1)"
        track.style.transform = `translateX(${targetX}px)`
    }

    await new Promise((r) => setTimeout(r, 3600))
    clearInterval(barTimer)
    vendingBeep(1320, 0.12, 0.07)

    vendingShowCardResult(winner)
    vendingSetLeds("ok")
    vendingPendingWinner = winner
    vendingShowEquipButton()
    await vendingWaitForEquip()
}

function bindVendingMachine() {
    document.getElementById("vending-exit")?.addEventListener("click", () => {
        if (vendingPendingWinner) return
        vendingBeep(320, 0.05)
        closeVendingScreen()
    })

    document.getElementById("vending-btn-equip")?.addEventListener("click", () => {
        vendingConfirmEquip()
    })

    document.getElementById("vending-btn-draw")?.addEventListener("click", () => {
        vendingPerformDraw()
    })

    document.getElementById("vending-btn-sell")?.addEventListener("click", () => {
        vendingShowSoon("SELL MODULE", "Listing cards on the marketplace is not wired yet.\nCheck back soon, trainer!")
    })

    document.getElementById("vending-btn-buy")?.addEventListener("click", () => {
        vendingShowSoon("BUY MODULE", "Marketplace purchases are not wired yet.\nBrowse the vault for now!")
    })
}

async function handleInteractionFlow(code, context = {}) {
    window.dispatchEvent(new CustomEvent("poke-interaction", {
        detail: { code, ...context },
    }))

    if (context.hold) {
        grantHold(context.hold, context.tileKey || context.source || "")
    } else if (code === "take_bag") {
        grantHold("bag", context.tileKey || context.source || "")
    }

    const questSteps = new Set([
        "collect_first_card",
    ])
    if (questSteps.has(code)) {
        completeQuestStep(code, "week1_vault_trail")
    }

    switch (code) {
        case "use_vending":
            openVendingScreen()
            break
        case "enter_portal":
            if (context.portal?.mapId) {
                await window.TelegramGame.teleportToMapId?.(
                    context.portal.mapId,
                    context.portal.x,
                    context.portal.y
                )
            }
            break
        case "live_games":
        case "shuffle_cards":
            break
        default:
            break
    }
}

function selectSignOption(code, context = {}) {
    if (code === "fishing_retry_yes" || code === "fishing_retry_no") {
        window.dispatchEvent(new CustomEvent("fishing-retry-choice", {
            detail: { yes: code === "fishing_retry_yes" },
        }))
        return
    }
    if (code === "exit") {
        closeSignModal()
        return
    }
    hideSignModal({ skipAudioSync: code === "use_vending" })
    void handleInteractionFlow(code, context)
}

function renderSignModalOptions(options, showExit, source, tileKey, portal) {
    const container = document.getElementById("sign-modal-options")
    const boxEl = document.getElementById("sign-modal-box")
    if (!container) return

    container.innerHTML = ""
    const list = Array.isArray(options)
        ? options.filter((o) => o?.label && o?.code)
        : []
    const exitEnabled = showExit !== false
    const hasOptions = list.length > 0

    if (!hasOptions) {
        container.classList.add("hidden")
        boxEl?.classList.remove("has-options")
        return
    }

    container.classList.remove("hidden")
    boxEl?.classList.add("has-options")

    const context = { source, tileKey, portal }

    for (const opt of list) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "sign-modal-option"
        btn.textContent = opt.label
        btn.addEventListener("click", () => selectSignOption(opt.code, { ...context, hold: opt.hold }))
        container.appendChild(btn)
    }

    if (exitEnabled) {
        const exitBtn = document.createElement("button")
        exitBtn.type = "button"
        exitBtn.className = "sign-modal-option sign-modal-option-exit"
        exitBtn.textContent = "Exit"
        exitBtn.addEventListener("click", () => selectSignOption("exit", context))
        container.appendChild(exitBtn)
    }
}

function closeSignModal() {
    if (!window.TelegramGame.finishNpcDialogue?.()) {
        hideSignModal()
    }
}

function advanceSignModal() {
    const messageSetId = activeMessageSetId
    const advanced = window.TelegramGame.advanceNpcDialogue?.()
    if (advanced === false && messageSetId) {
        markMessageSetSeen(messageSetId)
    }
}

function skipSignModal() {
    const messageSetId = activeMessageSetId
    if (messageSetId) {
        markMessageSetSeen(messageSetId)
    }
    window.TelegramGame.finishNpcDialogue?.({ patrolDelayMs: 0 })
}

function showSignModal({
    title,
    message,
    source,
    hasMore,
    messageTotal,
    messageIndex,
    options,
    showExit,
    tileKey,
    portal,
    npcId,
    messageSetId,
}) {
    const modal = document.getElementById("sign-modal")
    const boxEl = document.getElementById("sign-modal-box")
    const titleEl = document.getElementById("sign-modal-title")
    const bodyEl = document.getElementById("sign-modal-body")
    const closeBtn = document.getElementById("sign-modal-close")
    const nextBtn = document.getElementById("sign-modal-next")
    const skipBtn = document.getElementById("sign-modal-skip")
    if (!modal || !titleEl || !bodyEl) return

    window.RetroAudio?.resume()

    const isNpc = source === "npc"
    const idx = Number.isFinite(messageIndex) ? messageIndex : 0
    activeMessageSetId =
        messageSetId ||
        (isNpc && npcId ? `npc:${npcId}:msgs:unknown` : null) ||
        (tileKey ? `item:${tileKey}` : null)

    if (isNpc) {
        document.body.classList.add("dialogue-active")
        if (idx > 0) {
            window.RetroAudio?.sfx("text")
        }
        window.RetroAudio?.setScene("dialogue")
    } else if (source === "item") {
        document.body.classList.add("dialogue-active")
        window.RetroAudio?.sfx("interact")
        window.RetroAudio?.setScene("dialogue")
    }

    titleEl.textContent = title || "Notice"
    bodyEl.textContent = message || ""

    const multiNpc = isNpc && messageTotal > 1

    if (multiNpc) {
        closeBtn?.classList.add("hidden")
        nextBtn?.classList.remove("hidden")
        boxEl?.classList.add("has-next")
        titleEl.classList.add("no-close-padding")
        const showSkip = isMessageSetSeen(activeMessageSetId)
        skipBtn?.classList.toggle("hidden", !showSkip)
        boxEl?.classList.toggle("has-skip", showSkip)
        renderSignModalOptions([], false, source, tileKey)
    } else {
        closeBtn?.classList.remove("hidden")
        nextBtn?.classList.add("hidden")
        skipBtn?.classList.add("hidden")
        boxEl?.classList.remove("has-next")
        titleEl.classList.remove("no-close-padding")
        renderSignModalOptions(options, showExit, source, tileKey, portal)
    }

    modal.classList.remove("hidden")
}

function leaveGame() {
    stopGameHud()
    clearPadInput()
    closeGameDrawer()
    quickbarSelectedSlot = -1
    hideGearModeMenu()
    showQuickbarHint("")
    syncQuickbar()
    window.TelegramGame?.setEquippedGear?.(null)
    window.PoketabSocial?.close?.()
    window.PoketabSocial?.stopBadgePolling?.()
    hideSignModal()
    setGameLoading("", false)
    if (joinToastHandler) {
        window.TelegramGame?.offGameEvent("playerJoined", joinToastHandler)
        joinToastHandler = null
    }
    document.getElementById("join-toast-stack")?.replaceChildren()
    window.TelegramGame?.stopGame?.()
    if (PLAY_MODE && playSpectatorMode) {
        playSpectatorMode = false
        document.body.classList.remove("spectator-mode")
        showPlayLanding()
        return
    }
    showScreen("menu")
    startMenuStats()
}

function padVectorToDirections(normX, normY) {
    const magnitude = Math.hypot(normX, normY)
    if (magnitude < PAD_DEAD_ZONE) {
        return { up: false, down: false, left: false, right: false }
    }

    if (Math.abs(normY) >= Math.abs(normX)) {
        return { up: normY < 0, down: normY > 0, left: false, right: false }
    }

    return { up: false, down: false, left: normX < 0, right: normX > 0 }
}

function applyPadDirections(nextState) {
    if (!window.TelegramGame?.setPadDirection) {
        padDirectionState = { ...nextState }
        return
    }

    for (const dir of PAD_DIRECTIONS) {
        if (padDirectionState[dir] === nextState[dir]) continue
        window.TelegramGame.setPadDirection(dir, nextState[dir])
        padDirectionState[dir] = nextState[dir]
    }
}

function resetPadJoystickVisual() {
    padJoystickPointerId = null
    const zone = document.getElementById("game-joystick")
    const stick = document.getElementById("game-joystick-stick")
    zone?.classList.remove("is-active")
    if (stick) stick.style.transform = "translate(-50%, -50%)"
    applyPadDirections({ up: false, down: false, left: false, right: false })
}

function clearPadInput() {
    resetPadJoystickVisual()
    window.TelegramGame?.clearPadInput?.()
}

function bindNoSelectOnButtons() {
    const noSelectZones = "#game-screen, #game-screen *, .btn, .icon-btn, .btn-leave, .game-quests-btn, .game-joystick, .game-quickslot, .game-bag-btn, .game-poketab-btn, .game-drawer-tab, button"

    const block = (e) => {
        if (e.target.closest(noSelectZones)) e.preventDefault()
    }

    document.addEventListener("selectstart", block, true)
    document.addEventListener("contextmenu", block, true)
}

function bindButtonPressAnimation() {
    const pressables = ".btn, .icon-btn, .btn-leave, .game-quests-btn, .game-quickslot, .game-bag-btn, .game-poketab-btn, .game-drawer-tab, .game-drawer-close"

    document.addEventListener("pointerdown", (e) => {
        const btn = e.target.closest(pressables)
        if (!btn || btn.disabled) return

        window.RetroAudio?.resume()
        if (btn.id === "enter-btn" || btn.classList.contains("item-get-ok")) {
            window.RetroAudio?.sfx("confirm")
        } else if (btn.classList.contains("btn-leave") || btn.classList.contains("sign-modal-x")) {
            window.RetroAudio?.sfx("cancel")
        } else {
            window.RetroAudio?.sfx("select")
        }

        btn.classList.add("pressed")

        if (!btn.closest(".menu-grid-pixel") && typeof btn.setPointerCapture === "function") {
            try {
                btn.setPointerCapture(e.pointerId)
            } catch {
                /* ignore */
            }
        }

        const release = () => {
            btn.classList.remove("pressed")
            btn.removeEventListener("pointerup", release)
            btn.removeEventListener("pointercancel", release)
            btn.removeEventListener("pointerleave", release)
            btn.removeEventListener("lostpointercapture", release)
        }

        btn.addEventListener("pointerup", release)
        btn.addEventListener("pointercancel", release)
        btn.addEventListener("pointerleave", release)
        btn.addEventListener("lostpointercapture", release)
    }, { passive: true })
}

function prefersDesktopControls() {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches
}

function syncDesktopControlsUi() {
    document.body.classList.toggle("desktop-controls", prefersDesktopControls())
}

function bindPadControls() {
    syncDesktopControlsUi()
    if (prefersDesktopControls()) return

    const zone = document.getElementById("game-joystick")
    const base = document.getElementById("game-joystick-base")
    const stick = document.getElementById("game-joystick-stick")
    if (!zone || !base || !stick) return

    let centerX = 0
    let centerY = 0

    const maxTravel = () => Math.max(18, base.offsetWidth * 0.36)

    const updateFromPointer = (clientX, clientY) => {
        const dx = clientX - centerX
        const dy = clientY - centerY
        const distance = Math.hypot(dx, dy)
        const travel = maxTravel()
        const scale = distance > travel ? travel / distance : 1
        const offsetX = dx * scale
        const offsetY = dy * scale

        stick.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`

        const normX = offsetX / travel
        const normY = offsetY / travel
        applyPadDirections(padVectorToDirections(normX, normY))
    }

    const beginPointer = (event) => {
        if (padJoystickPointerId !== null) return
        event.preventDefault()
        padJoystickPointerId = event.pointerId
        zone.classList.add("is-active")

        try {
            zone.setPointerCapture(event.pointerId)
        } catch {
            /* ignore */
        }

        const rect = base.getBoundingClientRect()
        centerX = rect.left + rect.width / 2
        centerY = rect.top + rect.height / 2
        updateFromPointer(event.clientX, event.clientY)
    }

    const movePointer = (event) => {
        if (event.pointerId !== padJoystickPointerId) return
        event.preventDefault()
        updateFromPointer(event.clientX, event.clientY)
    }

    const endPointer = (event) => {
        if (padJoystickPointerId === null) return
        if (event.pointerId !== padJoystickPointerId) return

        try {
            if (zone.hasPointerCapture(event.pointerId)) {
                zone.releasePointerCapture(event.pointerId)
            }
        } catch {
            /* ignore */
        }

        resetPadJoystickVisual()
    }

    zone.addEventListener("pointerdown", beginPointer)
    zone.addEventListener("pointermove", movePointer)
    zone.addEventListener("pointerup", endPointer)
    zone.addEventListener("pointercancel", endPointer)
    zone.addEventListener("lostpointercapture", endPointer)
}

function bindGameTouchGuard() {
    const blockGameSwipe = (event) => {
        if (screens.game?.classList.contains("hidden")) return
        if (!event.cancelable) return
        event.preventDefault()
    }

    document.addEventListener("touchmove", blockGameSwipe, { passive: false })
}

function applySessionFromAuth(data) {
    session = data
    session.quest_progress = normalizeQuestProgress(session.quest_progress)
    session.holds = normalizeHolds(session.holds)
    session.gear_slots = normalizeGearSlots(session.gear_slots)
    session.vault = normalizeVault(session.vault)
    session.balance = Number(session.balance) || 0
    session.vending_spins = Number(session.vending_spins) || 0
    session.level = Number(session.level ?? session.trainer_stats?.level) || 0
    session.trainer_stats = session.trainer_stats || {}
    session.owned_skins = Array.isArray(session.owned_skins) ? session.owned_skins : [DEFAULT_SKIN]
    if (session.avatar_costs && typeof session.avatar_costs === "object") {
        Object.assign(AVATAR_COSTS, session.avatar_costs)
    }
    refreshSortedSkins()
    syncHoldUi()
    syncQuickbar()
    updateBalanceDisplays()
    renderProfileXp()

    if (session.skin) {
        skinIndex = Math.max(0, sortedSkins.indexOf(session.skin))
    } else {
        skinIndex = 0
    }

    populateMenu()
    updateSkinPreview(sortedSkins[skinIndex])
    renderBagGrid()
    session.has_pin = Boolean(session.has_pin)
    if (walletRequired() && data.wallet_address) {
        session.wallet_address = data.wallet_address
        session.requires_kins_payments = Boolean(data.requires_kins_payments)
        session.kins_treasury = data.kins_treasury || window.APP_CONFIG?.kinsTreasury || null
        sessionStorage.setItem("pokequest_wallet_address", data.wallet_address)
    } else {
        session.wallet_address = null
        session.requires_kins_payments = false
    }
    syncWalletEconomyLabels()
    syncGameHudDepositUi()
    syncProfileKinsDepositUi()
    if (guestPlayMode() && !guestHasRealName(session.display_name)) {
        const cached = window.SaiPokePlay?.getCachedGuestProfileName?.(getActiveGuestId())
        if (cached) session.display_name = cached
    }
    if (guestPlayMode() && session.profile_ready == null) {
        session.profile_ready = guestProfileReady()
    }
    window.SaiPokePlay?.syncGuestProfileMeta?.(data)
    window.SaiPokePlay?.syncWalletConnectedUi?.()
}

function onWalletDisconnect() {
    stopGameHud()
    clearPadInput()
    closeGameDrawer()
    quickbarSelectedSlot = -1
    hideGearModeMenu()
    showQuickbarHint("")
    syncQuickbar()
    window.TelegramGame?.setEquippedGear?.(null)
    window.PoketabSocial?.close?.()
    window.PoketabSocial?.stopBadgePolling?.()
    hideSignModal()
    setGameLoading("", false)
    if (joinToastHandler) {
        window.TelegramGame?.offGameEvent("playerJoined", joinToastHandler)
        joinToastHandler = null
    }
    document.getElementById("join-toast-stack")?.replaceChildren()
    window.TelegramGame?.stopGame?.()
    playSpectatorMode = false
    document.body.classList.remove("spectator-mode")
    session = {}
    pinVerified = false
    Object.values(screens).forEach((el) => el?.classList.add("hidden"))
    showPlayLanding()
}

async function completeSessionBootstrap() {
    const data = await authenticate()
    if (!data) return false

    applySessionFromAuth(data)

    if (playSpectatorMode) {
        setGameLoading("ENTERING REALM")
        hidePlayLanding()
        document.body.classList.add("spectator-mode")
        dismissBootSplash()
        window.RetroAudio?.resume()
        await enterGame()
        return true
    }

    hidePlayLanding()
    pinVerified = guestPlayMode()

    if (guestPlayMode() && guestNeedsProfileSetup()) {
        if (session.has_skin && !guestHasRealName(session.display_name)) {
            openSkinSetupScreen()
        } else if (guestHasRealName(session.display_name) && !session.has_skin) {
            openSkinSetupScreen()
        } else {
            syncWelcomeCopy()
            showScreen("welcome")
        }
    } else if (!guestPlayMode() && !session.has_skin) {
        syncWelcomeCopy()
        showScreen("welcome")
    } else {
        session.skin = session.skin || sortedSkins[skinIndex]
        routeAfterAuth()
    }

    dismissBootSplash()
    window.RetroAudio?.resume()
    window.RetroAudio?.setScene("menu")
    return true
}

async function init() {
    if (PLAY_MODE) {
        dismissBootSplash()
        syncWelcomeCopy()
        window.SaiPokePlay?.bindLanding?.()
        if (walletRequired()) {
            window.SaiPokePlay?.warmWallet?.()
        }
    } else {
        setBootMessage("Starting up...")
        await preloadEssentials()
    }

    if (!PLAY_MODE) {
        session = await authenticate()
        if (!session) return
        applySessionFromAuth(session)
        pinVerified = TEST_MODE ? true : false

        if (TEST_MODE) {
            session.has_skin = true
            session.skin = session.skin || DEFAULT_SKIN
            skinIndex = Math.max(0, sortedSkins.indexOf(session.skin))
            showScreen("menu")
            startMenuStats()
        } else if (!session.has_skin) {
            showScreen("welcome")
        } else {
            session.skin = session.skin || sortedSkins[skinIndex]
            routeAfterAuth()
        }

        const startParam = TEST_MODE
            ? "test"
            : (tg?.initDataUnsafe?.start_param || "").trim().toLowerCase()
        if (startParam === "leaderboard" && session.has_skin && pinUnlocked()) {
            lbActiveCategory = 0
            openLeaderboard()
        }

        dismissBootSplash()
        window.RetroAudio?.resume()
        window.RetroAudio?.setScene("menu")
    }

    window.PoketabSocial?.init?.({
        apiAuthBody,
        showToast: (message, isError = false) => {
            const stack = document.getElementById("join-toast-stack")
            if (!stack || !message) return
            const toast = document.createElement("div")
            toast.className = `join-toast${isError ? " join-toast-error" : ""}`
            toast.textContent = message
            stack.appendChild(toast)
            setTimeout(() => toast.remove(), 2800)
        },
        getVault: () => normalizeVault(session?.vault),
        getBalance: () => Number(session?.balance) || 0,
        onBalanceUpdate: () =>
            fetch("/api/auth", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(apiAuthBody()),
            })
                .then((r) => r.json())
                .then((data) => {
                    if (data.success) {
                        if (Number.isFinite(data.balance)) {
                            session.balance = data.balance
                            updateBalanceDisplays()
                        }
                        if (Array.isArray(data.vault)) {
                            applyVaultFromServer(data.vault)
                        }
                        if (data.trainer_stats) {
                            applyTrainerStats(data.trainer_stats)
                        } else if (data.level != null) {
                            session.level = data.level
                            populateMenu()
                        }
                    }
                    return data
                })
                .catch(() => {}),
    })

    preloadRemainingAssets()
    loadGameClient().then(bindGameEvents).catch(() => {})

    window.SaiPokeTrainer = { applyTrainerStats, renderProfileXp }

    bindPinKeypad()

    document.getElementById("welcome-setup-btn")?.addEventListener("click", () => {
        if (!pinUnlocked()) {
            openPinScreen(session?.has_pin ? "login" : "setup")
            return
        }
        openSkinSetupScreen()
    })

    bindItemGetPopup()
    bindSkinControls("skin-prev", "skin-next", (skin) => updateSkinPreview(skin, "skin"))

    document.getElementById("skin-player-name-input")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && skinSetupStep === "name") {
            event.preventDefault()
            advanceSkinSetupFromName()
        }
    })

    document.getElementById("skin-name-next-btn")?.addEventListener("click", () => {
        advanceSkinSetupFromName()
    })

    document.getElementById("skin-name-back-btn")?.addEventListener("click", () => {
        setSkinSetupStep("name")
    })

    document.getElementById("profile-owned-grid")?.addEventListener("click", handleProfileGridClick)
    document.getElementById("profile-shop-grid")?.addEventListener("click", handleProfileGridClick)

    document.getElementById("save-skin-btn").addEventListener("click", async () => {
        const status = document.getElementById("skin-status")
        status.textContent = requiresKinsPayments() && avatarPurchaseCost(sortedSkins[skinIndex]) > 0
            ? ""
            : "Saving..."
        status.classList.remove("error")

        try {
            const skin = sortedSkins[skinIndex]
            const displayName = normalizePlayerName(getSkinNameInputValue())
            if (!displayName) {
                throw new Error("Enter a trainer name (1–24 characters)")
            }

            const cost = avatarPurchaseCost(skin)
            if (!requiresKinsPayments() && cost > (session.balance ?? 0)) {
                throw new Error(`Need ${formatChipsAmount(cost)} Chips — you have ${formatChipsAmount(session.balance)}`)
            }

            const data = await saveSkinOrPay(skin, displayName)
            session.skin = skin
            session.display_name = data.display_name || displayName
            window.SaiPokePlay?.syncGuestProfileMeta?.(session)
            session.has_skin = true
            session.profile_ready = true
            if (Number.isFinite(data.balance)) session.balance = data.balance
            if (Array.isArray(data.owned_skins)) session.owned_skins = data.owned_skins
            populateMenu()
            showScreen("menu")
            status.textContent = ""
        } catch (error) {
            status.textContent = error.message
            status.classList.add("error")
        }
    })

    bindMenuAction(document.getElementById("enter-btn"), () => {
        handleEnterRealm()
    })
    document.getElementById("profile-btn").addEventListener("click", () => {
        renderProfileXp()
        renderProfileScreen()
        showScreen("profile")
    })
    document.getElementById("quests-btn").addEventListener("click", () => {
        questsReturnScreen = "menu"
        renderQuestBoard()
        showScreen("quests")
    })
    document.getElementById("game-quests-btn").addEventListener("click", () => {
        questsReturnScreen = "game"
        renderQuestBoard()
        showScreen("quests")
    })
    document.getElementById("revenue-share-btn").addEventListener("click", () => showScreen("revenueShare"))
    document.getElementById("leaderboard-btn")?.addEventListener("click", () => {
        lbActiveCategory = 0
        openLeaderboard()
    })
    document.getElementById("leaderboard-back-btn")?.addEventListener("click", () => {
        showScreen("menu")
        startMenuStats()
    })
    bindMenuAction(document.getElementById("lb-challenge-btn"), () => {
        handleEnterRealm()
    })
    document.getElementById("exit-btn").addEventListener("click", () => tg?.close())
    document.getElementById("leave-game-btn").addEventListener("click", leaveGame)
    document.getElementById("profile-back-btn").addEventListener("click", () => showScreen("menu"))
    document.getElementById("profile-stats-btn")?.addEventListener("click", () => openTrainerStats("profile"))
    document.getElementById("lb-my-stats-btn")?.addEventListener("click", () => openTrainerStats("leaderboard"))
    document.getElementById("trainer-stats-back-btn")?.addEventListener("click", () => showScreen(trainerStatsReturnScreen))
    document.getElementById("quests-back-btn").addEventListener("click", () => showScreen(questsReturnScreen))
    document.getElementById("revenue-share-back-btn").addEventListener("click", () => showScreen("menu"))
    document.getElementById("bag-back-btn").addEventListener("click", () => showScreen("menu"))

    document.getElementById("profile-action-btn").addEventListener("click", async () => {
        const status = document.getElementById("profile-status")
        const skin = profileSelectedSkin || session.skin
        const cost = avatarPurchaseCost(skin)
        status.textContent = requiresKinsPayments() && cost > 0
            ? ""
            : "Saving..."
        status.classList.remove("error")

        try {
            if (!skin) throw new Error("Select an avatar first")

            if (!requiresKinsPayments() && cost > (session.balance ?? 0)) {
                throw new Error(`Need ${formatChipsAmount(cost)} Chips — you have ${formatChipsAmount(session.balance)}`)
            }

            const data = await saveSkinOrPay(skin, session.display_name)
            session.skin = skin
            if (data.display_name) session.display_name = data.display_name
            if (Number.isFinite(data.balance)) session.balance = data.balance
            if (Array.isArray(data.owned_skins)) session.owned_skins = data.owned_skins
            populateMenu()
            renderProfileScreen()
            window.TelegramGame?.switchGameSkin?.(skin)
            if (requiresKinsPayments() && cost > 0) {
                status.textContent = `Purchased with ${formatChipsAmount(cost)} $POKEQUEST!`
            } else {
                status.textContent = cost > 0 ? `Saved! −${formatChipsAmount(cost)} Chips` : "Equipped!"
            }
        } catch (error) {
            status.textContent = error.message
            status.classList.add("error")
        }
    })

    document.getElementById("game-hud-buy-toggle")?.addEventListener("click", () => {
        openGameHudChipsPop("buy")
    })
    document.getElementById("game-hud-sell-toggle")?.addEventListener("click", () => {
        openGameHudChipsPop("sell")
    })
    document.getElementById("game-hud-chips-submit")?.addEventListener("click", () => {
        handleGameHudChipsSubmit()
    })
    document.getElementById("game-hud-chips-close")?.addEventListener("click", () => {
        closeGameHudDepositPop()
    })

    document.getElementById("profile-deposit-btn")?.addEventListener("click", () => {
        openProfileChipsForm("buy")
    })
    document.getElementById("profile-withdraw-btn")?.addEventListener("click", () => {
        openProfileChipsForm("sell")
    })
    document.getElementById("profile-chips-submit")?.addEventListener("click", () => {
        handleProfileChipsAction(profileChipsMode)
    })

    document.getElementById("sign-modal-close")?.addEventListener("click", closeSignModal)
    document.getElementById("sign-modal-next")?.addEventListener("click", advanceSignModal)
    document.getElementById("sign-modal-skip")?.addEventListener("click", skipSignModal)

    bindAudioMuteButtons()
    bindNoSelectOnButtons()
    bindButtonPressAnimation()
    bindPadControls()
    window.matchMedia("(hover: hover) and (pointer: fine)").addEventListener("change", syncDesktopControlsUi)
    bindQuickbar()
    bindGameTouchGuard()
    bindGameDrawer()
    bindVendingMachine()

    if (PLAY_MODE) {
        preloadEssentials().catch(() => {})
    }
}

const playLandingBinder = window.SaiPokePlay?.bindLanding
const playWarmWallet = window.SaiPokePlay?.warmWallet
const playSyncWalletUi = window.SaiPokePlay?.syncWalletConnectedUi
const playDisconnectWallet = window.SaiPokePlay?.disconnectWallet
const openGuestProfileFlow = window.SaiPokePlay?.openGuestProfileFlow
const closeGuestProfileFlow = window.SaiPokePlay?.closeGuestProfileFlow
const syncGuestProfileMeta = window.SaiPokePlay?.syncGuestProfileMeta
const getCachedGuestProfileName = window.SaiPokePlay?.getCachedGuestProfileName

window.SaiPokePlay = {
    hidePlayLanding,
    showPlayLanding,
    bootAfterWallet: () => {
        playSpectatorMode = false
        document.body.classList.remove("spectator-mode")
        return completeSessionBootstrap()
    },
    bootSpectator: () => {
        playSpectatorMode = true
        return completeSessionBootstrap()
    },
    onWalletDisconnect,
    bindLanding: playLandingBinder,
    warmWallet: playWarmWallet,
    syncWalletConnectedUi: playSyncWalletUi,
    disconnectWallet: playDisconnectWallet,
    openGuestProfileFlow,
    closeGuestProfileFlow,
    syncGuestProfileMeta,
    getCachedGuestProfileName,
}

init().catch((error) => {
    console.error("Pokequest-cards init failed:", error)
    dismissBootSplash()
    showError(error?.message || "Failed to start. Hard refresh and try again.")
})
