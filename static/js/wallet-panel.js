/**
 * Connected-wallet $POKEQUEST ↔ CHIPS deposit / withdraw panel (1:1).
 */
(function () {
    let apiAuthBody = () => ({})
    let getBalance = () => 0
    let onBalanceUpdate = () => {}
    let showToast = () => {}
    let walletConfig = null
    let busy = false
    let bound = false
    let activeTab = "deposit"
    let depositMethod = "manual" // manual | wallet
    let balances = {
        chips_balance: 0,
        wallet_token_balance: 0,
        treasury_token_balance: 0,
    }
    let withdrawPollTimer = null

    const DEPOSIT_STEPS = [
        "Preparing transfer…",
        "Approve in your wallet…",
        "Waiting for on-chain confirmation…",
        "Verifying mint, sender, treasury & amount…",
        "Crediting CHIPS…",
    ]

    const MANUAL_VERIFY_STEPS = [
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

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms))
    }

    function connectedWallet() {
        return (window.KinsWallet?.getSavedPaymentWallet?.() || "").trim()
    }

    async function apiPost(path, body = {}) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody(body)),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.success === false) {
            const err = new Error(data.error || `Request failed (${res.status})`)
            err.code = data.code
            err.tx_signature = data.tx_signature
            err.status = res.status
            throw err
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
        el("wallet-deposit-submit")?.toggleAttribute("disabled", state)
        el("wallet-deposit-verify")?.toggleAttribute("disabled", state)
        el("wallet-withdraw-submit")?.toggleAttribute("disabled", state)
        el("wallet-connect-btn")?.toggleAttribute("disabled", state)
        el("wallet-deposit-btn")?.toggleAttribute("disabled", state)
        el("wallet-withdraw-btn")?.toggleAttribute("disabled", state)
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
        } else if (qr) {
            qr.classList.add("hidden")
        }
    }

    async function refreshBalances() {
        const wallet = connectedWallet()
        try {
            const data = await apiPost("/api/wallet/balances", { wallet })
            balances = {
                chips_balance: Number(data.chips_balance) || 0,
                wallet_token_balance: Number(data.wallet_token_balance) || 0,
                treasury_token_balance: Number(data.treasury_token_balance) || 0,
            }
            if (Number.isFinite(data.chips_balance) && window.session) {
                window.session.balance = balances.chips_balance
            }
            refreshWalletDisplay(balances.chips_balance)
        } catch {
            balances.chips_balance = getBalance()
            if (wallet && window.KinsWallet?.getTokenUiBalance) {
                try {
                    balances.wallet_token_balance = await window.KinsWallet.getTokenUiBalance(wallet)
                } catch {
                    /* ignore */
                }
            }
        }
        renderBalances()
    }

    function renderBalances() {
        const wallet = connectedWallet()
        const short = window.KinsWallet?.shortWallet?.(wallet) || wallet || "—"
        const chips = balances.chips_balance || getBalance()
        const tokenBal = balances.wallet_token_balance || 0
        const treasury = balances.treasury_token_balance || 0

        const setText = (id, text) => {
            const node = el(id)
            if (node) node.textContent = text
        }
        setText("wallet-deposit-wallet", short)
        setText("wallet-withdraw-wallet", short)
        setText("wallet-deposit-token-bal", fmt(tokenBal))
        setText("wallet-deposit-chips-bal", fmt(chips))
        setText("wallet-withdraw-chips", fmt(chips))
        setText("wallet-withdraw-treasury", fmt(treasury))
        updateWithdrawPreview()
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

    function renderDepositHistory(rows) {
        const box = el("wallet-deposit-history")
        if (!box) return
        if (!rows.length) {
            box.innerHTML = `<p class="wallet-history-empty">No deposits yet.</p>`
            return
        }
        box.innerHTML = rows.slice(0, 8).map((row) => {
            const when = formatWhen(row.verified_at || row.created_at)
            const sig = row.tx_signature
            const solscan = sig
                ? `<a class="wallet-solscan" href="https://solscan.io/tx/${escapeHtml(sig)}" target="_blank" rel="noopener">Solscan</a>`
                : ""
            return `
                <div class="wallet-history-row wallet-history-row--in">
                    <span class="wallet-history-amt">+${fmt(row.amount_chips)} CHIPS</span>
                    <span class="wallet-history-status">${escapeHtml(formatStatus(row.status || "confirmed"))}</span>
                    <span class="wallet-history-when">${escapeHtml(when)} ${solscan}</span>
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

    function openModal(tab = "deposit") {
        el("wallet-modal")?.classList.remove("hidden")
        syncConnectUi()
        setTab(tab)
        setDepositMethod(depositMethod)
        refreshBalances()
        loadHistory()
        loadConfig()
    }

    function closeModal() {
        el("wallet-modal")?.classList.add("hidden")
        stopWithdrawPoll()
    }

    function setTab(tab) {
        activeTab = tab === "withdraw" ? "withdraw" : "deposit"
        const depositTab = el("wallet-tab-deposit")
        const withdrawTab = el("wallet-tab-withdraw")
        const depositPanel = el("wallet-panel-deposit")
        const withdrawPanel = el("wallet-panel-withdraw")
        const isDeposit = activeTab === "deposit"
        depositTab?.classList.toggle("is-active", isDeposit)
        withdrawTab?.classList.toggle("is-active", !isDeposit)
        depositTab?.setAttribute("aria-selected", isDeposit ? "true" : "false")
        withdrawTab?.setAttribute("aria-selected", isDeposit ? "false" : "true")
        depositPanel?.classList.toggle("hidden", !isDeposit)
        withdrawPanel?.classList.toggle("hidden", isDeposit)
        if (isDeposit) {
            if (el("wallet-deposit-error")) el("wallet-deposit-error").textContent = ""
            el("wallet-deposit-success")?.classList.add("hidden")
        } else {
            if (el("wallet-withdraw-error")) el("wallet-withdraw-error").textContent = ""
            el("wallet-withdraw-success")?.classList.add("hidden")
            updateWithdrawPreview()
        }
        syncConnectUi()
    }

    function setDepositMethod(method) {
        depositMethod = method === "wallet" ? "wallet" : "manual"
        const manualTab = el("wallet-method-manual")
        const walletTab = el("wallet-method-wallet")
        const manualPanel = el("wallet-deposit-manual")
        const walletPanel = el("wallet-deposit-wallet-flow")
        const isManual = depositMethod === "manual"
        manualTab?.classList.toggle("is-active", isManual)
        walletTab?.classList.toggle("is-active", !isManual)
        manualPanel?.classList.toggle("hidden", !isManual)
        walletPanel?.classList.toggle("hidden", isManual)
        if (el("wallet-deposit-error")) el("wallet-deposit-error").textContent = ""
        el("wallet-deposit-success")?.classList.add("hidden")
        el("wallet-deposit-steps")?.classList.add("hidden")
        syncConnectUi()
    }

    function syncConnectUi() {
        const wallet = connectedWallet()
        const short = window.KinsWallet?.shortWallet?.(wallet) || wallet
        const status = el("wallet-connect-status")
        const btn = el("wallet-connect-btn")
        if (status) {
            status.textContent = wallet ? `Connected: ${short}` : "Wallet not connected"
        }
        if (btn) {
            btn.textContent = wallet ? "Change Wallet" : "Connect Wallet"
        }

        const walletGate = el("wallet-deposit-wallet-gate")
        const walletBody = el("wallet-deposit-wallet-body")
        walletGate?.classList.toggle("hidden", Boolean(wallet))
        walletBody?.classList.toggle("hidden", !wallet)

        const withdrawGate = el("wallet-withdraw-gate")
        const withdrawBody = el("wallet-withdraw-body")
        withdrawGate?.classList.toggle("hidden", Boolean(wallet))
        withdrawBody?.classList.toggle("hidden", !wallet)

        renderBalances()
    }

    async function connectWallet() {
        try {
            if (window.SaiPokePlay?.connectPaymentWallet) {
                window.SaiPokePlay.connectPaymentWallet()
                return
            }
            const addr = await window.KinsWallet?.ensureWalletConnected?.()
            if (addr) {
                syncConnectUi()
                await refreshBalances()
                await loadHistory()
                showToast("Wallet connected!")
            }
        } catch (err) {
            showToast(err.message || "Could not connect wallet.", true)
        }
    }

    function updateWithdrawPreview() {
        const amount = Math.floor(Number(el("wallet-withdraw-amount")?.value) || 0)
        const out = el("wallet-withdraw-receive")
        if (out) out.textContent = `${fmt(amount)} $POKEQUEST`
    }

    function validateDepositAmount(amount) {
        const min = Number(walletConfig?.minDeposit) || 1
        if (!Number.isFinite(amount) || amount <= 0) {
            return "Enter an amount greater than 0."
        }
        if (amount < min) {
            return `Minimum deposit is ${fmt(min)} $POKEQUEST.`
        }
        if (amount > (balances.wallet_token_balance || 0)) {
            return `Amount exceeds wallet balance (${fmt(balances.wallet_token_balance)} $POKEQUEST).`
        }
        if (!Number.isInteger(amount)) {
            return "Amount must be a whole number of tokens."
        }
        return ""
    }

    function validateWithdrawAmount(amount) {
        const min = Number(walletConfig?.minWithdraw) || 1
        const max = Number(walletConfig?.maxWithdraw) || Number.MAX_SAFE_INTEGER
        const chips = balances.chips_balance || getBalance()
        const treasury = balances.treasury_token_balance || 0
        if (!Number.isFinite(amount) || amount <= 0) {
            return "Enter an amount greater than 0."
        }
        if (amount < min) {
            return `Minimum withdrawal is ${fmt(min)} CHIPS.`
        }
        if (amount > max) {
            return `Maximum withdrawal is ${fmt(max)} CHIPS.`
        }
        if (amount > chips) {
            return `Not enough CHIPS — you have ${fmt(chips)}.`
        }
        if (amount > treasury) {
            return `Treasury has insufficient $POKEQUEST (${fmt(treasury)} available).`
        }
        if (!Number.isInteger(amount)) {
            return "Amount must be a whole number of CHIPS."
        }
        return ""
    }

    async function showDepositSteps(lines) {
        const box = el("wallet-deposit-steps")
        if (!box) return
        box.classList.remove("hidden")
        box.innerHTML = ""
        for (const line of lines) {
            const p = document.createElement("p")
            p.className = "wallet-verify-step is-done"
            p.textContent = line
            box.appendChild(p)
            await sleep(180)
        }
    }

    async function verifyDepositWithRetry(signature, wallet = "", amount = null) {
        let lastError = null
        for (let attempt = 0; attempt < 18; attempt += 1) {
            try {
                const body = { signature }
                if (wallet) body.sender_wallet = wallet
                if (amount != null) body.amount = amount
                return await apiPost("/api/wallet/deposit/verify", body)
            } catch (err) {
                lastError = err
                if (err.code === "pending_credit") {
                    await sleep(1500)
                    continue
                }
                const msg = String(err.message || "")
                if (/not found yet|not finalized|load transaction|try again shortly/i.test(msg)) {
                    await sleep(2000)
                    continue
                }
                throw err
            }
        }
        throw lastError || new Error("Deposit verification timed out.")
    }

    async function applyDepositSuccess(data, creditedFallback = 0) {
        const credited = data.credited_amount || creditedFallback
        const successEl = el("wallet-deposit-success")
        if (successEl) {
            successEl.textContent = `Deposit successful! +${fmt(credited)} CHIPS`
            successEl.classList.remove("hidden")
        }
        if (data.new_balance != null && window.session) {
            window.session.balance = data.new_balance
        }
        refreshWalletDisplay(data.new_balance)
        await onBalanceUpdate()
        await refreshBalances()
        await loadHistory()
        showToast(`+${fmt(credited)} CHIPS credited!`)
    }

    async function verifyManualDeposit() {
        if (busy) return
        const input = el("wallet-deposit-signature")
        const errEl = el("wallet-deposit-error")
        const sig = input?.value?.trim()
        if (!sig) {
            if (errEl) errEl.textContent = "Paste your transaction signature or Solscan link."
            return
        }
        if (errEl) errEl.textContent = ""
        el("wallet-deposit-success")?.classList.add("hidden")
        setBusy(true)
        try {
            await showDepositSteps(MANUAL_VERIFY_STEPS.slice(0, 1))
            const data = await verifyDepositWithRetry(sig)
            await showDepositSteps(MANUAL_VERIFY_STEPS)
            await applyDepositSuccess(data)
            if (input) input.value = ""
        } catch (err) {
            if (errEl) errEl.textContent = err.message || "Verification failed."
            el("wallet-deposit-steps")?.classList.add("hidden")
            showToast(err.message || "Verification failed.", true)
        } finally {
            setBusy(false)
        }
    }

    async function submitDeposit() {
        if (busy) return
        const errEl = el("wallet-deposit-error")
        const successEl = el("wallet-deposit-success")
        const amount = Math.floor(Number(el("wallet-deposit-amount")?.value) || 0)
        if (errEl) errEl.textContent = ""
        successEl?.classList.add("hidden")
        el("wallet-deposit-steps")?.classList.add("hidden")

        const wallet = connectedWallet()
        if (!wallet) {
            if (errEl) errEl.textContent = "Connect your wallet first."
            return
        }

        await refreshBalances()
        const validation = validateDepositAmount(amount)
        if (validation) {
            if (errEl) errEl.textContent = validation
            return
        }

        setBusy(true)
        window.KinsWallet?.setPaymentPending?.(true, "Approve deposit in your wallet…")
        try {
            await showDepositSteps(DEPOSIT_STEPS.slice(0, 2))
            const treasury = walletConfig?.gameWallet || walletConfig?.game_wallet
            const signature = await window.KinsWallet.sendKinsTransfer({
                amountKins: amount,
                treasuryWallet: treasury,
                mint: walletConfig?.tokenMint,
                decimals: walletConfig?.mintDecimals,
                tokenProgram: walletConfig?.tokenProgram,
                createTreasuryAtaIfNeeded: walletConfig?.createTreasuryAtaIfNeeded,
            })
            await showDepositSteps(DEPOSIT_STEPS.slice(0, 4))
            const data = await verifyDepositWithRetry(signature, wallet, amount)
            await showDepositSteps(DEPOSIT_STEPS)
            await applyDepositSuccess(data, amount)
            const input = el("wallet-deposit-amount")
            if (input) input.value = ""
        } catch (err) {
            if (errEl) errEl.textContent = err.message || "Deposit failed."
            el("wallet-deposit-steps")?.classList.add("hidden")
            showToast(err.message || "Deposit failed.", true)
        } finally {
            window.KinsWallet?.setPaymentPending?.(false)
            setBusy(false)
        }
    }

    function stopWithdrawPoll() {
        if (withdrawPollTimer) {
            window.clearTimeout(withdrawPollTimer)
            withdrawPollTimer = null
        }
    }

    async function pollWithdrawal(withdrawalId) {
        const progress = el("wallet-withdraw-progress")
        const successEl = el("wallet-withdraw-success")
        const errEl = el("wallet-withdraw-error")
        const maxAttempts = 40
        for (let i = 0; i < maxAttempts; i += 1) {
            try {
                const qs = new URLSearchParams(apiAuthBody({}))
                const res = await fetch(`/api/wallet/withdraw/${withdrawalId}?${qs}`)
                const data = await res.json().catch(() => ({}))
                if (!res.ok || !data.success) {
                    throw new Error(data.error || "Could not check withdrawal status.")
                }
                const status = String(data.status || "").toLowerCase()
                if (progress) {
                    if (status === "pending") progress.textContent = "Queued — waiting for treasury payout…"
                    else if (status === "broadcasting") progress.textContent = "Sending $POKEQUEST from treasury…"
                    else progress.textContent = `Status: ${status}`
                }
                if (status === "confirmed") {
                    if (progress) progress.classList.add("hidden")
                    if (successEl) {
                        successEl.textContent = `Withdrawal complete! ${fmt(data.amount_chips)} $POKEQUEST sent.`
                        successEl.classList.remove("hidden")
                    }
                    await onBalanceUpdate()
                    await refreshBalances()
                    await loadHistory()
                    showToast("Withdrawal completed!")
                    return
                }
                if (status === "failed" || status === "cancelled") {
                    if (progress) progress.classList.add("hidden")
                    const msg = data.error_message || "Withdrawal failed. CHIPS were restored."
                    if (errEl) errEl.textContent = msg
                    await onBalanceUpdate()
                    await refreshBalances()
                    await loadHistory()
                    showToast(msg, true)
                    return
                }
            } catch (err) {
                if (i === maxAttempts - 1) {
                    if (errEl) errEl.textContent = err.message || "Could not confirm withdrawal."
                    return
                }
            }
            await sleep(3000)
        }
        if (progress) {
            progress.textContent = "Still processing — check history shortly."
        }
        await loadHistory()
    }

    async function submitWithdraw() {
        if (busy) return
        const errEl = el("wallet-withdraw-error")
        const successEl = el("wallet-withdraw-success")
        const progress = el("wallet-withdraw-progress")
        const amount = Math.floor(Number(el("wallet-withdraw-amount")?.value) || 0)
        if (errEl) errEl.textContent = ""
        successEl?.classList.add("hidden")
        progress?.classList.add("hidden")

        const wallet = connectedWallet()
        if (!wallet) {
            if (errEl) errEl.textContent = "Connect your wallet first."
            return
        }

        await refreshBalances()
        const validation = validateWithdrawAmount(amount)
        if (validation) {
            if (errEl) errEl.textContent = validation
            return
        }

        setBusy(true)
        try {
            if (progress) {
                progress.classList.remove("hidden")
                progress.textContent = "Reserving CHIPS…"
            }
            const data = await apiPost("/api/wallet/withdraw", {
                amount,
                destination_wallet: wallet,
            })
            if (data.new_balance != null && window.session) {
                window.session.balance = data.new_balance
            }
            refreshWalletDisplay(data.new_balance)
            await onBalanceUpdate()
            await refreshBalances()
            await loadHistory()
            if (progress) progress.textContent = "Queued — waiting for treasury payout…"
            showToast("Withdrawal queued!")
            const input = el("wallet-withdraw-amount")
            if (input) input.value = ""
            updateWithdrawPreview()
            // Keep button free while we poll; payout is server-side.
            setBusy(false)
            await pollWithdrawal(data.withdrawal_id)
        } catch (err) {
            if (errEl) errEl.textContent = err.message || "Withdrawal failed."
            progress?.classList.add("hidden")
            showToast(err.message || "Withdrawal failed.", true)
            await refreshBalances()
            setBusy(false)
        }
    }

    function bindEvents() {
        if (bound) return
        bound = true

        el("wallet-deposit-btn")?.addEventListener("click", () => openModal("deposit"))
        el("wallet-withdraw-btn")?.addEventListener("click", () => openModal("withdraw"))
        el("wallet-modal-close")?.addEventListener("click", closeModal)
        el("wallet-modal-scrim")?.addEventListener("click", closeModal)
        el("wallet-connect-btn")?.addEventListener("click", connectWallet)
        el("wallet-tab-deposit")?.addEventListener("click", () => setTab("deposit"))
        el("wallet-tab-withdraw")?.addEventListener("click", () => setTab("withdraw"))
        el("wallet-method-manual")?.addEventListener("click", () => setDepositMethod("manual"))
        el("wallet-method-wallet")?.addEventListener("click", () => setDepositMethod("wallet"))
        el("wallet-deposit-submit")?.addEventListener("click", submitDeposit)
        el("wallet-deposit-verify")?.addEventListener("click", verifyManualDeposit)
        el("wallet-withdraw-submit")?.addEventListener("click", submitWithdraw)
        el("wallet-withdraw-amount")?.addEventListener("input", updateWithdrawPreview)
        el("wallet-deposit-max")?.addEventListener("click", () => {
            const input = el("wallet-deposit-amount")
            if (input) input.value = String(Math.max(0, balances.wallet_token_balance || 0))
        })
        el("wallet-withdraw-max")?.addEventListener("click", () => {
            const input = el("wallet-withdraw-amount")
            const chips = balances.chips_balance || getBalance()
            const treasury = balances.treasury_token_balance || 0
            const maxW = walletConfig?.maxWithdraw || chips
            if (input) input.value = String(Math.max(0, Math.min(chips, treasury, maxW)))
            updateWithdrawPreview()
        })
        el("wallet-deposit-copy")?.addEventListener("click", async () => {
            const addr = el("wallet-deposit-address")?.textContent?.trim()
            const copyBtn = el("wallet-deposit-copy")
            if (!addr || addr === "—" || !copyBtn) return
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

        window.addEventListener("pokequest:payment-wallet", async () => {
            syncConnectUi()
            if (connectedWallet()) {
                await refreshBalances()
                await loadHistory()
            }
        })
        window.addEventListener("pokequest:wallet-connected", async () => {
            syncConnectUi()
            await refreshBalances()
            await loadHistory()
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
        syncConnectUi()
        refreshWalletDisplay()
    }

    function sync() {
        refreshWalletDisplay()
        syncConnectUi()
    }

    window.SaiPokeWallet = {
        init,
        sync,
        refreshWalletDisplay,
        loadHistory,
        syncDepositConnectUi: syncConnectUi,
        open: openModal,
        close: closeModal,
    }
})()
