(function () {
    const STORAGE_KEY = "pokequest_wallet_session"

    let walletBusy = false

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
            setStatus("Wallet verified. Setting up trainer...", "success")

            const ok = await window.SaiPokePlay?.bootAfterWallet?.()
            if (!ok) {
                throw new Error("Could not load your trainer profile.")
            }
            setStatus("")
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

    async function startSpectator() {
        if (walletBusy) return
        setBusy(true)
        setStatus("Opening spectator view...", "success")
        try {
            const ok = await window.SaiPokePlay?.bootSpectator?.()
            if (!ok) throw new Error("Could not open spectator view.")
            setStatus("")
        } catch (error) {
            setStatus(error.message || "Spectator mode failed.", "error")
        } finally {
            setBusy(false)
        }
    }

    function bindLanding() {
        playBtn?.addEventListener("click", () => {
            if (walletBusy) return
            const existing = sessionStorage.getItem(STORAGE_KEY)
            if (existing) {
                setBusy(true)
                window.SaiPokePlay?.bootAfterWallet?.()
                    .then((ok) => {
                        if (!ok) setStatus("Session expired. Connect wallet again.", "error")
                    })
                    .catch((error) => setStatus(error.message || "Could not sign in.", "error"))
                    .finally(() => setBusy(false))
                return
            }
            openWalletModal()
        })

        spectateBtn?.addEventListener("click", () => {
            if (!walletBusy) startSpectator()
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

        document.getElementById("exit-spectate-btn")?.addEventListener("click", () => {
            document.getElementById("leave-game-btn")?.click()
        })
    }

    window.SaiPokePlay = window.SaiPokePlay || {}
    window.SaiPokePlay.bindLanding = bindLanding
})()
