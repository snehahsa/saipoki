(function () {
    const cfg = window.PLAY_CONFIG || {}
    const GAME_JS_URL = cfg.assets?.gameJs || "/static/game/game.js"
    const DEFAULT_SKIN = cfg.defaultSkin || "009"
    const STORAGE_KEY = "pokequest_wallet_session"

    let session = null
    let spectatorMode = false
    let gameClientPromise = null
    let statsInterval = null
    let positionHandler = null
    let walletBusy = false

    const landing = document.getElementById("play-landing")
    const gameRoot = document.getElementById("play-game")
    const statusEl = document.getElementById("play-status")
    const walletModal = document.getElementById("play-wallet-modal")
    const playBtn = document.getElementById("play-now-btn")
    const spectateBtn = document.getElementById("spectate-btn")

    function setStatus(text, kind) {
        if (!statusEl) return
        statusEl.textContent = text || ""
        statusEl.classList.remove("is-error", "is-success")
        if (kind) statusEl.classList.add(kind === "error" ? "is-error" : "is-success")
    }

    function setBusy(busy) {
        walletBusy = busy
        if (playBtn) playBtn.disabled = busy
        if (spectateBtn) spectateBtn.disabled = busy
    }

    function bytesToBase64(bytes) {
        let binary = ""
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        for (let i = 0; i < arr.length; i += 1) {
            binary += String.fromCharCode(arr[i])
        }
        return btoa(binary)
    }

    function getWalletProvider(name) {
        if (name === "phantom") {
            const provider = window.phantom?.solana
            if (provider?.isPhantom) return provider
            return null
        }
        if (name === "solflare") {
            const provider = window.solflare
            if (provider?.isSolflare || provider?.publicKey) return provider
            return null
        }
        return null
    }

    function openWalletModal() {
        walletModal?.classList.remove("hidden")
    }

    function closeWalletModal() {
        walletModal?.classList.add("hidden")
    }

    function holdGrantRulesForClient() {
        const catalog = cfg.holdCatalog || {}
        const rules = {}
        Object.entries(catalog).forEach(([holdId, meta]) => {
            if (meta?.grant_requires) rules[holdId] = meta.grant_requires
        })
        return rules
    }

    function authBody(extra = {}) {
        const body = { ...extra }
        const walletSession = sessionStorage.getItem(STORAGE_KEY)
        if (walletSession) body.walletSession = walletSession
        if (spectatorMode) body.spectator = true
        return body
    }

    async function authenticate() {
        const response = await fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(authBody()),
        })
        const data = await response.json()
        if (!response.ok || !data.success) {
            throw new Error(data.error || "Authentication failed.")
        }
        return data
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
                    reject(new Error("Game client failed to load."))
                    return
                }
                resolve()
            }
            script.onerror = () => {
                gameClientPromise = null
                reject(new Error("Could not load game client."))
            }
            document.body.appendChild(script)
        })

        return gameClientPromise
    }

    function setGameLoading(message, show = true) {
        const box = document.getElementById("game-loading")
        const text = document.getElementById("game-loading-text")
        if (text && message) text.textContent = message
        if (box) box.classList.toggle("hidden", !show)
    }

    function showGameLayer() {
        landing?.classList.add("is-hidden")
        gameRoot?.classList.remove("hidden")
        document.getElementById("game-screen")?.classList.remove("hidden")
    }

    function showLandingLayer() {
        landing?.classList.remove("is-hidden")
        gameRoot?.classList.add("hidden")
        document.body.classList.remove("spectator-mode")
        spectatorMode = false
        setGameLoading("", false)
    }

    async function fetchWorldStats() {
        try {
            const response = await fetch("/health")
            const data = await response.json()
            const statPlayers = document.getElementById("stat-players")
            if (statPlayers) statPlayers.textContent = String(data.players ?? 0)
        } catch {
            /* ignore */
        }
    }

    function startGameHud() {
        stopGameHud()
        if (spectatorMode || !window.TelegramGame?.onPlayerPosition) return
        fetchWorldStats()
        statsInterval = setInterval(fetchWorldStats, 3000)
    }

    function stopGameHud() {
        if (statsInterval) {
            clearInterval(statsInterval)
            statsInterval = null
        }
        if (positionHandler) {
            window.TelegramGame?.offPlayerPosition?.(positionHandler)
            positionHandler = null
        }
    }

    function leaveGame() {
        stopGameHud()
        window.TelegramGame?.clearPadInput?.()
        window.TelegramGame?.stopGame?.()
        showLandingLayer()
        setStatus("")
    }

    async function enterRealm({ spectate = false } = {}) {
        spectatorMode = spectate
        document.body.classList.toggle("spectator-mode", spectate)

        setBusy(true)
        setStatus(spectate ? "Opening spectator view..." : "Connecting wallet session...", "success")

        try {
            session = await authenticate()
            await loadGameClient()
            showGameLayer()
            setGameLoading("CONNECTING")

            const playSkin = session.skin || DEFAULT_SKIN
            const playName = (session.display_name || (spectate ? "Spectator" : "Trainer")).trim()

            setGameLoading("LOADING WORLD")
            const result = await window.TelegramGame.startGame({
                uid: String(session.telegram_id),
                username: playName,
                skin: playSkin,
                level: Number(session.level) || 1,
                holds: Array.isArray(session.holds) ? session.holds : [],
                holdGrantRules: holdGrantRulesForClient(),
                backendUrl: window.location.origin,
                socketUrl: cfg.gameSocketUrl || "",
                spectator: spectate,
                onProgress: (message) => setGameLoading(String(message || "").toUpperCase()),
            })

            if (!result?.success) {
                throw new Error(result?.error || "Could not join the realm.")
            }

            setGameLoading("", false)
            startGameHud()
            window.RetroAudio?.resume?.()
            window.RetroAudio?.setScene?.("overworld")
            setStatus("")
        } catch (error) {
            leaveGame()
            setStatus(error.message || "Could not enter the realm.", "error")
        } finally {
            setBusy(false)
        }
    }

    async function connectWalletFlow(walletName) {
        if (walletBusy) return
        closeWalletModal()
        setBusy(true)
        setStatus("Requesting wallet connection...")

        try {
            const provider = getWalletProvider(walletName)
            if (!provider) {
                const label = walletName === "phantom" ? "Phantom" : "Solflare"
                throw new Error(`${label} not detected. Install the extension and refresh.`)
            }

            const connection = await provider.connect()
            const walletAddress = (
                connection?.publicKey?.toString?.()
                || provider.publicKey?.toString?.()
                || ""
            ).trim()

            if (!walletAddress) {
                throw new Error("Wallet did not return a public key.")
            }

            setStatus("Checking $KINS balance...")
            const challengeRes = await fetch("/api/wallet/challenge", { method: "POST" })
            const challenge = await challengeRes.json()
            if (!challengeRes.ok || !challenge?.ok || !challenge.message) {
                throw new Error("Could not start wallet sign-in.")
            }

            setStatus("Sign the message in your wallet...")
            const encoded = new TextEncoder().encode(challenge.message)
            const signed = await provider.signMessage(encoded, "utf8")
            const signature = bytesToBase64(signed.signature)

            setStatus("Verifying ownership...")
            const verifyRes = await fetch("/api/wallet/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    walletAddress,
                    challengeId: challenge.challengeId,
                    signature,
                }),
            })
            const verifyData = await verifyRes.json()
            if (!verifyRes.ok || !verifyData.success || !verifyData.walletSession) {
                throw new Error(verifyData.error || "Wallet verification failed.")
            }

            sessionStorage.setItem(STORAGE_KEY, verifyData.walletSession)
            setStatus("Wallet verified. Launching realm...", "success")
            await enterRealm({ spectate: false })
        } catch (error) {
            if (error?.code === 4001 || /reject|denied|cancel/i.test(String(error?.message || ""))) {
                setStatus("Wallet connection cancelled.", "error")
            } else {
                setStatus(error.message || "Wallet connect failed.", "error")
            }
        } finally {
            setBusy(false)
        }
    }

    function bindUi() {
        playBtn?.addEventListener("click", () => {
            if (walletBusy) return
            const existing = sessionStorage.getItem(STORAGE_KEY)
            if (existing) {
                enterRealm({ spectate: false })
                return
            }
            openWalletModal()
        })

        spectateBtn?.addEventListener("click", () => {
            if (walletBusy) return
            enterRealm({ spectate: true })
        })

        document.getElementById("play-wallet-close")?.addEventListener("click", closeWalletModal)
        walletModal?.addEventListener("click", (event) => {
            if (event.target === walletModal) closeWalletModal()
        })

        document.querySelectorAll("[data-wallet]").forEach((btn) => {
            btn.addEventListener("click", () => {
                connectWalletFlow(btn.getAttribute("data-wallet"))
            })
        })

        document.getElementById("leave-game-btn")?.addEventListener("click", leaveGame)
        document.getElementById("exit-spectate-btn")?.addEventListener("click", leaveGame)
    }

    bindUi()
})()
