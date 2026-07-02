(function () {
    const WALLET_CHECK = Boolean(window.APP_CONFIG?.walletCheck)
    const STORAGE_KEY = "pokequest_wallet_session"
    const WALLET_ADDRESS_KEY = "pokequest_wallet_address"
    const CONNECT_TIMEOUT_MS = 45000
    const WALLET_HINT_MS = 7000
    const WALLET_INJECT_MS = 8000

    let walletBusy = false
    let landingBound = false
    let pendingChallenge = null
    let challengeFetchPromise = null
    let walletWarmPromise = null

    const statusEl = document.getElementById("play-status")
    const walletModal = document.getElementById("play-wallet-modal")
    const walletStatusEl = document.getElementById("play-wallet-status")
    const playBtn = document.getElementById("play-now-btn")
    const spectateBtn = document.getElementById("spectate-btn")
    const walletBar = document.getElementById("play-wallet-bar")
    const walletBarLabel = document.getElementById("play-wallet-bar-label")
    const walletDisconnectBtn = document.getElementById("play-wallet-disconnect")

    function setLandingStatus(text, kind) {
        if (!statusEl) return
        statusEl.textContent = text || ""
        statusEl.classList.remove("is-error", "is-success")
        if (kind) statusEl.classList.add(kind === "error" ? "is-error" : "is-success")
    }

    function setModalStatus(text, kind) {
        if (!walletStatusEl) return
        walletStatusEl.textContent = text || ""
        walletStatusEl.classList.toggle("hidden", !text)
        walletStatusEl.classList.remove("is-error", "is-success", "is-info")
        if (kind === "error") walletStatusEl.classList.add("is-error")
        else if (kind === "success") walletStatusEl.classList.add("is-success")
        else if (kind === "info") walletStatusEl.classList.add("is-info")
    }

    function clearModalStatus() {
        setModalStatus("")
    }

    function setBusy(busy) {
        walletBusy = busy
        if (playBtn) playBtn.disabled = busy
        if (spectateBtn) spectateBtn.disabled = busy
        document.querySelectorAll("[data-wallet]").forEach((btn) => {
            btn.disabled = busy
        })
    }

    function clearWalletSession() {
        sessionStorage.removeItem(STORAGE_KEY)
        sessionStorage.removeItem(WALLET_ADDRESS_KEY)
    }

    function shouldShowWalletDisconnect() {
        const game = document.getElementById("game-screen")
        if (game && !game.classList.contains("hidden")) return false

        const landing = document.getElementById("play-landing")
        const menu = document.getElementById("menu-screen")
        if (landing && !landing.classList.contains("is-hidden")) return true
        if (menu && !menu.classList.contains("hidden")) return true
        return false
    }

    function syncWalletConnectedUi() {
        const token = sessionStorage.getItem(STORAGE_KEY)
        const address = sessionStorage.getItem(WALLET_ADDRESS_KEY) || ""
        const showBar = Boolean(token) && shouldShowWalletDisconnect()
        if (walletBar) {
            walletBar.classList.toggle("hidden", !showBar)
        }
        if (walletBarLabel) {
            walletBarLabel.textContent = address
                ? `${address.slice(0, 4)}…${address.slice(-4)}`
                : ""
            walletBarLabel.classList.toggle("hidden", !address)
        }
        if (walletDisconnectBtn) {
            walletDisconnectBtn.disabled = !token
        }
    }

    async function disconnectWallet() {
        if (walletBusy) return
        setBusy(true)
        try {
            clearWalletSession()
            for (const name of ["phantom", "solflare"]) {
                const provider = getWalletProvider(name)
                if (!provider?.disconnect) continue
                try {
                    await provider.disconnect()
                } catch {
                    /* extension may already be disconnected */
                }
            }
            syncWalletConnectedUi()
            setLandingStatus("Wallet disconnected.", "success")
            window.SaiPokePlay?.onWalletDisconnect?.()
        } finally {
            setBusy(false)
        }
    }

    function walletLabel(name) {
        return name === "phantom" ? "Phantom" : "Solflare"
    }

    /** Phantom only injects on https, localhost, or 127.0.0.1 (not LAN IPs). */
    function isPhantomSupportedHost() {
        const host = window.location.hostname
        if (window.location.protocol === "https:") return true
        return host === "localhost" || host === "127.0.0.1"
    }

    function phantomLocalhostUrl() {
        const port = window.location.port || "5000"
        return `http://127.0.0.1:${port}${window.location.pathname}`
    }

    function bytesToBase64(bytes) {
        let binary = ""
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        for (let i = 0; i < arr.length; i += 1) {
            binary += String.fromCharCode(arr[i])
        }
        return btoa(binary)
    }

    function signatureToBase64(signature) {
        if (signature instanceof Uint8Array) {
            return bytesToBase64(signature)
        }
        if (Array.isArray(signature)) {
            return bytesToBase64(new Uint8Array(signature))
        }
        if (typeof signature === "string") {
            if (/^[A-Za-z0-9+/=]+$/.test(signature) && signature.length % 4 === 0) {
                return signature
            }
            if (window.bs58?.decode) {
                return bytesToBase64(window.bs58.decode(signature))
            }
        }
        throw new Error("Unsupported wallet signature format.")
    }

    /** https://docs.phantom.com/solana/detecting-the-provider */
    function getPhantomProvider() {
        if ("phantom" in window) {
            const provider = window.phantom?.solana
            if (provider?.isPhantom) return provider
        }
        if (window.solana?.isPhantom) return window.solana
        return null
    }

    function getSolflareProvider() {
        const provider = window.solflare
        if (provider?.isSolflare || typeof provider?.connect === "function") return provider
        return null
    }

    function getWalletProvider(name) {
        if (name === "phantom") return getPhantomProvider()
        if (name === "solflare") return getSolflareProvider()
        return null
    }

    function anyWalletReady() {
        return Boolean(getPhantomProvider() || getSolflareProvider())
    }

    function waitForWalletInject() {
        if (anyWalletReady()) {
            return Promise.resolve(true)
        }
        if (walletWarmPromise) {
            return walletWarmPromise
        }

        walletWarmPromise = new Promise((resolve) => {
            const finish = () => resolve(anyWalletReady())
            const timer = setTimeout(finish, WALLET_INJECT_MS)

            const onReady = () => {
                if (!anyWalletReady()) return
                clearTimeout(timer)
                window.removeEventListener("phantom#initialized", onReady)
                window.removeEventListener("solflare#initialized", onReady)
                resolve(true)
            }

            window.addEventListener("phantom#initialized", onReady)
            window.addEventListener("solflare#initialized", onReady)

            const poll = setInterval(() => {
                if (!anyWalletReady()) return
                clearInterval(poll)
                clearTimeout(timer)
                window.removeEventListener("phantom#initialized", onReady)
                window.removeEventListener("solflare#initialized", onReady)
                resolve(true)
            }, 80)
        })

        return walletWarmPromise
    }

    function withTimeout(promise, ms, message) {
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error(message)), ms)
            }),
        ])
    }

    function publicKeyToString(key) {
        if (!key) return ""
        if (typeof key === "string") return key
        if (typeof key.toBase58 === "function") return key.toBase58()
        if (typeof key.toString === "function") return key.toString()
        return String(key)
    }

    /**
     * Start provider.connect() in the click handler (same synchronous turn).
     * https://docs.phantom.com/solana/establishing-a-connection
     */
    function startWalletConnect(walletName, provider) {
        if (walletName === "solflare") {
            return provider.connect().then(() => {
                const key = publicKeyToString(provider.publicKey)
                if (!key) throw new Error("Solflare did not return a public key.")
                return key
            })
        }

        return provider.connect().then((response) => {
            const key = publicKeyToString(response?.publicKey || provider.publicKey)
            if (!key) throw new Error("Phantom did not return a public key.")
            return key
        })
    }

    function syncWalletOptionDetection() {
        const phantomDetected = isPhantomSupportedHost() && Boolean(getPhantomProvider())
        const solflareDetected = Boolean(getSolflareProvider())
        document.querySelectorAll("[data-wallet-detected]").forEach((el) => {
            const wallet = el.getAttribute("data-wallet-detected")
            const show =
                (wallet === "phantom" && phantomDetected)
                || (wallet === "solflare" && solflareDetected)
            el.classList.toggle("hidden", !show)
        })
    }

    function openWalletModal() {
        walletModal?.classList.remove("hidden")
        clearModalStatus()
        syncWalletOptionDetection()
        void waitForWalletInject().then(() => syncWalletOptionDetection())
        prefetchChallenge()

        if (!isPhantomSupportedHost()) {
            setModalStatus(
                `Phantom requires localhost. Open ${phantomLocalhostUrl()} instead of this address.`,
                "error",
            )
        }
    }

    function closeWalletModal() {
        walletModal?.classList.add("hidden")
        clearModalStatus()
    }

    function resetChallengePrefetch() {
        pendingChallenge = null
        challengeFetchPromise = null
    }

    function prefetchChallenge() {
        if (challengeFetchPromise) {
            return challengeFetchPromise
        }
        challengeFetchPromise = fetchWalletChallenge()
            .then((challenge) => {
                pendingChallenge = challenge
                return challenge
            })
            .catch(() => {
                resetChallengePrefetch()
                return null
            })
        return challengeFetchPromise
    }

    async function fetchWalletChallenge() {
        const challengeRes = await fetch("/api/wallet/challenge", {
            method: "POST",
            cache: "no-store",
        })
        const challenge = await challengeRes.json()
        if (!challengeRes.ok || !challenge?.ok || !challenge.message || !challenge.challengeId) {
            throw new Error(challenge?.error || "Could not start wallet sign-in.")
        }
        return challenge
    }

    async function resolveChallenge() {
        if (pendingChallenge?.challengeId) {
            const cached = pendingChallenge
            resetChallengePrefetch()
            return cached
        }
        resetChallengePrefetch()
        return fetchWalletChallenge()
    }

    async function signWalletChallenge(provider, challenge) {
        const encoded = new TextEncoder().encode(challenge.message)
        const signed = await provider.signMessage(encoded, "utf8")
        return signatureToBase64(signed.signature)
    }

    async function verifyWalletProof(walletAddress, challengeId, signature) {
        const verifyRes = await fetch("/api/wallet/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
                walletAddress,
                challengeId,
                signature,
            }),
        })
        const verifyData = await verifyRes.json()
        return { verifyRes, verifyData }
    }

    async function finishWalletConnect(walletName, provider, connectPromise) {
        if (walletBusy) return

        const label = walletLabel(walletName)
        setBusy(true)
        setModalStatus(`Opening ${label}…`, "info")

        const hintTimer = setTimeout(() => {
            setModalStatus(
                `No popup? Click the ${label} puzzle-piece icon in your browser toolbar, unlock the wallet, then approve.`,
                "error",
            )
        }, WALLET_HINT_MS)

        try {
            const walletAddress = String(
                await withTimeout(
                    connectPromise,
                    CONNECT_TIMEOUT_MS,
                    `${label} did not respond. Open the extension from your browser toolbar and try again.`,
                ) || "",
            ).trim()

            clearTimeout(hintTimer)

            if (!walletAddress) {
                throw new Error("Wallet did not return a public key.")
            }

            closeWalletModal()

            let challenge = await resolveChallenge()
            setLandingStatus("Sign the message in your wallet…")
            let signature = await signWalletChallenge(provider, challenge)

            setLandingStatus("Verifying ownership…")
            let { verifyRes, verifyData } = await verifyWalletProof(
                walletAddress,
                challenge.challengeId,
                signature,
            )

            if (
                !verifyRes.ok
                && /challenge expired/i.test(String(verifyData?.error || ""))
            ) {
                setLandingStatus("Refreshing sign-in — approve the new message…")
                challenge = await fetchWalletChallenge()
                signature = await signWalletChallenge(provider, challenge)
                setLandingStatus("Verifying ownership…")
                ;({ verifyRes, verifyData } = await verifyWalletProof(
                    walletAddress,
                    challenge.challengeId,
                    signature,
                ))
            }

            if (!verifyRes.ok || !verifyData.success || !verifyData.walletSession) {
                throw new Error(verifyData.error || "Wallet verification failed.")
            }

            sessionStorage.setItem(STORAGE_KEY, verifyData.walletSession)
            if (verifyData.walletAddress) {
                sessionStorage.setItem(WALLET_ADDRESS_KEY, verifyData.walletAddress)
            }
            syncWalletConnectedUi()
            setLandingStatus("Wallet verified. Setting up trainer…", "success")

            const ok = await window.SaiPokePlay?.bootAfterWallet?.()
            if (!ok) {
                clearWalletSession()
                throw new Error("Could not load your trainer profile.")
            }
            setLandingStatus("")
        } catch (error) {
            clearTimeout(hintTimer)
            const code = error?.code
            const message = String(error?.message || "")

            if (code === 4001 || /reject|denied|cancel/i.test(message)) {
                setModalStatus("Wallet connection cancelled.", "error")
            } else if (code === -32002) {
                setModalStatus("Phantom already has a pending request — check the extension popup.", "error")
            } else if (walletModal && !walletModal.classList.contains("hidden")) {
                setModalStatus(message || "Wallet connect failed.", "error")
            } else {
                setLandingStatus(message || "Wallet connect failed.", "error")
            }
        } finally {
            setBusy(false)
        }
    }

    function onWalletButtonClick(walletName) {
        if (walletBusy || !walletName) return

        const label = walletLabel(walletName)

        if (walletName === "phantom" && !isPhantomSupportedHost()) {
            setModalStatus(
                `Phantom only works on localhost or https. Open ${phantomLocalhostUrl()} instead.`,
                "error",
            )
            return
        }

        const provider = getWalletProvider(walletName)
        if (!provider) {
            if (walletName === "phantom") {
                setModalStatus(
                    `${label} extension not detected. Install from phantom.app, enable it, then refresh this page.`,
                    "error",
                )
            } else {
                setModalStatus(
                    `${label} not detected. Install the extension, refresh, then try again.`,
                    "error",
                )
            }
            return
        }

        let connectPromise
        try {
            connectPromise = startWalletConnect(walletName, provider)
        } catch (error) {
            setModalStatus(error?.message || "Could not open wallet.", "error")
            return
        }

        void finishWalletConnect(walletName, provider, connectPromise)
    }

    async function startSpectator() {
        if (walletBusy) return
        setBusy(true)
        setLandingStatus("Opening spectator view...", "success")
        try {
            const ok = await window.SaiPokePlay?.bootSpectator?.()
            if (!ok) throw new Error("Could not open spectator view.")
            setLandingStatus("")
        } catch (error) {
            setLandingStatus(error.message || "Spectator mode failed.", "error")
        } finally {
            setBusy(false)
        }
    }

    function bootGuestPlay() {
        if (walletBusy) return
        setBusy(true)
        setLandingStatus("Loading trainer…", "success")
        window.SaiPokePlay?.bootAfterWallet?.()
            .then((ok) => {
                if (!ok) {
                    setLandingStatus("Could not load your trainer profile.", "error")
                } else {
                    setLandingStatus("")
                }
            })
            .catch((error) => {
                setLandingStatus(error.message || "Could not sign in.", "error")
            })
            .finally(() => setBusy(false))
    }

    function bindLanding() {
        if (landingBound) return
        landingBound = true

        playBtn?.addEventListener("click", () => {
            if (walletBusy) return
            if (!WALLET_CHECK) {
                bootGuestPlay()
                return
            }
            const existing = sessionStorage.getItem(STORAGE_KEY)
            if (existing) {
                setBusy(true)
                window.SaiPokePlay?.bootAfterWallet?.()
                    .then((ok) => {
                        if (!ok) {
                            clearWalletSession()
                            setLandingStatus("Session expired. Connect wallet again.", "error")
                        }
                    })
                    .catch((error) => {
                        clearWalletSession()
                        setLandingStatus(error.message || "Could not sign in.", "error")
                    })
                    .finally(() => setBusy(false))
                return
            }
            openWalletModal()
        })

        spectateBtn?.addEventListener("click", () => {
            if (!walletBusy) startSpectator()
        })

        walletDisconnectBtn?.addEventListener("click", () => {
            if (!walletBusy) void disconnectWallet()
        })

        document.getElementById("play-wallet-close")?.addEventListener("click", closeWalletModal)
        walletModal?.addEventListener("click", (event) => {
            if (event.target === walletModal) closeWalletModal()
        })

        document.querySelectorAll("[data-wallet]").forEach((btn) => {
            btn.addEventListener("click", (event) => {
                event.preventDefault()
                onWalletButtonClick(btn.getAttribute("data-wallet"))
            })
        })

        document.getElementById("exit-spectate-btn")?.addEventListener("click", () => {
            document.getElementById("leave-game-btn")?.click()
        })

        void waitForWalletInject().then(() => syncWalletOptionDetection())
        if (WALLET_CHECK) {
            prefetchChallenge()
        }
        syncWalletConnectedUi()
    }

    window.SaiPokePlay = window.SaiPokePlay || {}
    window.SaiPokePlay.bindLanding = bindLanding
    window.SaiPokePlay.warmWallet = waitForWalletInject
    window.SaiPokePlay.syncWalletConnectedUi = syncWalletConnectedUi
    window.SaiPokePlay.disconnectWallet = disconnectWallet

    bindLanding()
})()
