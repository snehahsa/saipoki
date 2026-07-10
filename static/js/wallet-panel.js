/**
 * $POKEQUEST deposit / withdraw wallet panel (Rollbit-style signature verify).
 */
(function () {
    let apiAuthBody = () => ({})
    let getBalance = () => 0
    let onBalanceUpdate = () => {}
    let showToast = () => {}
    let walletConfig = null
    let busy = false
    let bound = false

    const VERIFY_STEPS = [
        "Checking transaction…",
        "✓ Signature valid",
        "✓ Transaction finalized",
        "✓ Token verified",
        "✓ Deposit verified",
        "✓ CHIPS credited",
    ]

    function el(id) {
        return document.getElementById(id)
    }

    function fmt(n) {
        return Number(n || 0).toLocaleString("en-US")
    }

    function escapeHtml(v) {
        return String(v || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    }

    async function apiPost(path, body = {}) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody(body)),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.success === false) {
            throw new Error(data.error || `Request failed (${res.status})`)
        }
        return data
    }

    async function apiGet(path) {
        const qs = new URLSearchParams(apiAuthBody({}))
        const res = await fetch(`${path}?${qs}`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.success === false) {
            throw new Error(data.error || `Request failed (${res.status})`)
        }
        return data
    }

    function setBusy(state) {
        busy = state
        el("wallet-deposit-btn")?.toggleAttribute("disabled", state)
        el("wallet-withdraw-btn")?.toggleAttribute("disabled", state)
        el("wallet-deposit-verify")?.toggleAttribute("disabled", state)
        el("wallet-withdraw-submit")?.toggleAttribute("disabled", state)
    }

    function refreshWalletDisplay(balance) {
        const chips = balance != null ? balance : getBalance()
        const chipsEl = el("wallet-chips-balance")
        if (chipsEl) chipsEl.textContent = fmt(chips)
    }

    async function loadConfig() {
        try {
            walletConfig = await fetch("/api/wallet/config").then((r) => r.json())
        } catch {
            walletConfig = window.APP_CONFIG?.wallet || {}
        }
        const addr = walletConfig.gameWallet || walletConfig.game_wallet || ""
        const addrEl = el("wallet-deposit-address")
        if (addrEl) addrEl.textContent = addr || "—"
        const qr = el("wallet-deposit-qr")
        if (qr && addr) {
            qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(addr)}`
            qr.alt = "Deposit QR"
            qr.classList.remove("hidden")
        }
    }

    async function loadHistory() {
        try {
            const data = await apiGet("/api/wallet/history")
            renderDepositHistory(data.deposits || [])
            renderWithdrawHistory(data.withdrawals || [])
        } catch {
            /* optional */
        }
    }

    function formatStatus(status) {
        const s = String(status || "").toLowerCase()
        if (!s) return ""
        return s.charAt(0).toUpperCase() + s.slice(1)
    }

    function renderDepositHistory(rows) {
        const box = el("wallet-deposit-history")
        if (!box) return
        if (!rows.length) {
            box.innerHTML = `<p class="wallet-history-empty">No deposits yet.</p>`
            return
        }
        box.innerHTML = rows.slice(0, 8).map((row) => {
            const when = formatWhen(row.verified_at || row.created_at)
            return `
                <div class="wallet-history-row wallet-history-row--in">
                    <span class="wallet-history-amt">+${fmt(row.amount_chips)} CHIPS</span>
                    <span class="wallet-history-status">${escapeHtml(formatStatus(row.status || "confirmed"))}</span>
                    <span class="wallet-history-when">${escapeHtml(when)}</span>
                </div>`
        }).join("")
    }

    function renderWithdrawHistory(rows) {
        const box = el("wallet-withdraw-history")
        if (!box) return
        if (!rows.length) {
            box.innerHTML = `<p class="wallet-history-empty">No withdrawals yet.</p>`
            return
        }
        box.innerHTML = rows.slice(0, 8).map((row) => {
            const when = formatWhen(row.completed_at || row.created_at)
            const sig = row.tx_signature
            const solscan = sig
                ? `<a class="wallet-solscan" href="https://solscan.io/tx/${escapeHtml(sig)}" target="_blank" rel="noopener">Solscan</a>`
                : ""
            return `
                <div class="wallet-history-row wallet-history-row--out">
                    <span class="wallet-history-amt">−${fmt(row.amount_chips)} CHIPS</span>
                    <span class="wallet-history-status">${escapeHtml(formatStatus(row.status || "pending"))}</span>
                    <span class="wallet-history-when">${escapeHtml(when)} ${solscan}</span>
                </div>`
        }).join("")
    }

    function formatWhen(ts) {
        const n = Number(ts) || 0
        if (!n) return ""
        const diff = Math.floor(Date.now() / 1000) - n
        if (diff < 60) return "just now"
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
        if (diff < 172800) return "yesterday"
        return new Date(n * 1000).toLocaleDateString()
    }

    function openModal(id) {
        el(id)?.classList.remove("hidden")
    }

    function closeModal(id) {
        el(id)?.classList.add("hidden")
    }

    function spawnConfetti(root) {
        if (!root) return
        const colors = ["#8bffcf", "#ffd700", "#ff6b9d", "#46d9a0", "#fff"]
        for (let i = 0; i < 28; i++) {
            const p = document.createElement("span")
            p.className = "wallet-confetti"
            p.style.left = `${10 + Math.random() * 80}%`
            p.style.background = colors[i % colors.length]
            p.style.animationDelay = `${Math.random() * 0.35}s`
            p.style.setProperty("--wallet-drift", `${(Math.random() - 0.5) * 80}px`)
            root.appendChild(p)
            window.setTimeout(() => p.remove(), 1600)
        }
    }

    async function animateVerifySteps(verifyPromise) {
        const box = el("wallet-deposit-steps")
        if (!box) return null
        box.innerHTML = ""
        box.classList.remove("hidden")

        const first = document.createElement("p")
        first.className = "wallet-verify-step"
        first.textContent = VERIFY_STEPS[0]
        box.appendChild(first)
        await new Promise((r) => window.setTimeout(r, 320))

        let data
        try {
            data = await verifyPromise
        } catch (err) {
            throw err
        }

        for (const line of VERIFY_STEPS.slice(1)) {
            const p = document.createElement("p")
            p.className = "wallet-verify-step is-done"
            p.textContent = line
            box.appendChild(p)
            await new Promise((r) => window.setTimeout(r, 260))
        }
        return data
    }

    async function verifyDeposit() {
        if (busy) return
        const input = el("wallet-deposit-signature")
        const errEl = el("wallet-deposit-error")
        const sig = input?.value?.trim()
        if (!sig) {
            if (errEl) errEl.textContent = "Paste your transaction signature or Solscan link."
            return
        }
        if (errEl) errEl.textContent = ""
        setBusy(true)
        el("wallet-deposit-success")?.classList.add("hidden")
        try {
            const verifyPromise = apiPost("/api/wallet/deposit/verify", { signature: sig })
            const data = await animateVerifySteps(verifyPromise)
            const credited = data.credited_amount || 0
            const success = el("wallet-deposit-success")
            if (success) {
                success.textContent = `Deposit successful! +${fmt(credited)} CHIPS`
                success.classList.remove("hidden")
            }
            spawnConfetti(el("wallet-deposit-modal"))
            if (data.new_balance != null && window.session) {
                window.session.balance = data.new_balance
            }
            refreshWalletDisplay(data.new_balance)
            await onBalanceUpdate()
            showToast(`+${fmt(credited)} CHIPS credited!`)
            await loadHistory()
            if (input) input.value = ""
            window.setTimeout(() => closeModal("wallet-deposit-modal"), 3000)
        } catch (err) {
            if (errEl) errEl.textContent = err.message || "Verification failed."
            el("wallet-deposit-steps")?.classList.add("hidden")
        } finally {
            setBusy(false)
        }
    }

    function updateWithdrawPreview() {
        const amount = Math.floor(Number(el("wallet-withdraw-amount")?.value) || 0)
        const out = el("wallet-withdraw-receive")
        if (out) out.textContent = `${fmt(amount)} POKEQUEST`
    }

    async function submitWithdraw() {
        if (busy) return
        const errEl = el("wallet-withdraw-error")
        const amount = Math.floor(Number(el("wallet-withdraw-amount")?.value) || 0)
        const dest = el("wallet-withdraw-dest")?.value?.trim()
        if (errEl) errEl.textContent = ""
        if (!dest || amount <= 0) {
            if (errEl) errEl.textContent = "Enter amount and destination wallet."
            return
        }
        setBusy(true)
        const progress = el("wallet-withdraw-progress")
        if (progress) {
            progress.classList.remove("hidden")
            progress.textContent = "Preparing…"
        }
        try {
            if (progress) progress.textContent = "Signing…"
            await new Promise((r) => window.setTimeout(r, 200))
            if (progress) progress.textContent = "Broadcasting…"
            const data = await apiPost("/api/wallet/withdraw", {
                amount,
                destination_wallet: dest,
            })
            if (progress) progress.textContent = "Waiting confirmation…"
            await new Promise((r) => window.setTimeout(r, 400))
            if (progress) progress.textContent = "Completed — payout queued."
            if (data.new_balance != null && window.session) {
                window.session.balance = data.new_balance
            }
            refreshWalletDisplay(data.new_balance)
            await onBalanceUpdate()
            showToast("Withdrawal queued!")
            await loadHistory()
            window.setTimeout(() => closeModal("wallet-withdraw-modal"), 2000)
        } catch (err) {
            if (errEl) errEl.textContent = err.message || "Withdrawal failed."
            if (progress) progress.classList.add("hidden")
        } finally {
            setBusy(false)
        }
    }

    function syncDepositConnectUi() {
        const status = el("wallet-deposit-connect-status")
        const btn = el("wallet-deposit-connect")
        const address =
            window.KinsWallet?.getSavedPaymentWallet?.()
            || sessionStorage.getItem("pokequest_wallet_address")
            || ""
        const short = window.KinsWallet?.shortWallet?.(address) || address
        if (status) {
            status.textContent = address ? `Connected: ${short}` : "Wallet not connected"
        }
        if (btn) {
            btn.textContent = address ? "Change Wallet" : "Connect Wallet"
        }
    }

    async function connectDepositWallet() {
        try {
            if (window.SaiPokePlay?.connectPaymentWallet) {
                window.SaiPokePlay.connectPaymentWallet()
                return
            }
            const addr = await window.KinsWallet?.ensureWalletConnected?.()
            if (addr) {
                syncDepositConnectUi()
                showToast("Wallet connected!")
            }
        } catch (err) {
            showToast(err.message || "Could not connect wallet.", true)
        }
    }

    function bindEvents() {
        if (bound) return
        bound = true

        el("wallet-deposit-btn")?.addEventListener("click", () => {
            el("wallet-deposit-error").textContent = ""
            el("wallet-deposit-success")?.classList.add("hidden")
            el("wallet-deposit-steps")?.classList.add("hidden")
            syncDepositConnectUi()
            openModal("wallet-deposit-modal")
            loadHistory()
        })
        el("wallet-withdraw-btn")?.addEventListener("click", () => {
            el("wallet-withdraw-error").textContent = ""
            el("wallet-withdraw-progress")?.classList.add("hidden")
            el("wallet-withdraw-chips").textContent = fmt(getBalance())
            updateWithdrawPreview()
            openModal("wallet-withdraw-modal")
            loadHistory()
        })

        el("wallet-deposit-connect")?.addEventListener("click", () => {
            connectDepositWallet()
        })

        el("wallet-deposit-close")?.addEventListener("click", () => closeModal("wallet-deposit-modal"))
        el("wallet-deposit-scrim")?.addEventListener("click", () => closeModal("wallet-deposit-modal"))
        el("wallet-withdraw-close")?.addEventListener("click", () => closeModal("wallet-withdraw-modal"))
        el("wallet-withdraw-scrim")?.addEventListener("click", () => closeModal("wallet-withdraw-modal"))

        el("wallet-deposit-copy")?.addEventListener("click", async () => {
            const addr = el("wallet-deposit-address")?.textContent?.trim()
            const copyBtn = el("wallet-deposit-copy")
            if (!addr || !copyBtn) return
            const original = copyBtn.textContent || "Copy"
            try {
                await navigator.clipboard.writeText(addr)
                copyBtn.textContent = "Copied!"
                showToast("Copied!")
                window.setTimeout(() => {
                    copyBtn.textContent = original
                }, 2000)
            } catch {
                showToast("Could not copy.", true)
            }
        })

        el("wallet-deposit-paste")?.addEventListener("click", async () => {
            try {
                const text = await navigator.clipboard.readText()
                const input = el("wallet-deposit-signature")
                if (input) input.value = text.trim()
            } catch {
                showToast("Paste manually.", true)
            }
        })

        el("wallet-deposit-verify")?.addEventListener("click", verifyDeposit)
        el("wallet-withdraw-submit")?.addEventListener("click", submitWithdraw)
        el("wallet-withdraw-amount")?.addEventListener("input", updateWithdrawPreview)
        el("wallet-withdraw-max")?.addEventListener("click", () => {
            const input = el("wallet-withdraw-amount")
            const bal = getBalance()
            const maxW = walletConfig?.maxWithdraw || bal
            if (input) input.value = String(Math.min(bal, maxW))
            updateWithdrawPreview()
        })

        window.addEventListener("pokequest:payment-wallet", () => syncDepositConnectUi())
        window.addEventListener("pokequest:wallet-connected", () => {
            syncDepositConnectUi()
            showToast("Wallet connected!")
        })
    }

    function init(deps = {}) {
        apiAuthBody = deps.apiAuthBody || apiAuthBody
        getBalance = deps.getBalance || getBalance
        onBalanceUpdate = deps.onBalanceUpdate || onBalanceUpdate
        showToast = deps.showToast || showToast
        bindEvents()
        loadConfig()
        syncDepositConnectUi()
    }

    function sync() {
        refreshWalletDisplay()
        syncDepositConnectUi()
    }

    window.SaiPokeWallet = { init, sync, refreshWalletDisplay, loadHistory, syncDepositConnectUi }
})()
