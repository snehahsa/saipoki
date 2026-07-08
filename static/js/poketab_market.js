/**
 * PokéTab — Card Market. Players list, browse, buy, and cancel PokéCards for
 * CHIPS. All ownership + CHIPS transfers happen server-side; this module only
 * renders state and forwards intents.
 */
(function () {
    const DEFAULT_LABELS = { 1: "Standard", 2: "Silver", 3: "Gold", 4: "Platinum", 5: "Mythic" }
    const DEFAULT_MULTS = { 1: 1.0, 2: 1.22, 3: 1.48, 4: 1.78, 5: 2.15 }

    let apiAuthBody = () => ({})
    let showToast = () => {}
    let getVault = () => []
    let getBalance = () => 0
    let onBalanceUpdate = async () => {}
    let getCard = () => null
    let getGrading = () => null
    let getMarketLocked = () => []
    let setMarketLocked = () => {}

    let config = { fee_pct: 0.05, min_price: 1, max_price: 100000000 }
    let currentSub = "browse"
    let lastBrowse = []
    let lastMine = []
    let lastHistory = []
    let searchTimer = null
    let busy = false
    let bound = false
    let sellCardId = null
    let buyListingId = null

    function el(id) {
        return document.getElementById(id)
    }

    function fmt(n) {
        return Number(n || 0).toLocaleString("en-US")
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    }

    function gradeLabel(g) {
        const grading = getGrading?.()
        return (grading?.labels?.[g]) || DEFAULT_LABELS[g] || "Standard"
    }

    function gradeMult(g) {
        const grading = getGrading?.()
        const m = grading?.multipliers?.[g]
        return typeof m === "number" ? m : (DEFAULT_MULTS[g] || 1)
    }

    function formatMult(m) {
        return `×${(Number(m) || 1).toFixed(2)}`
    }

    function basePower(card) {
        let p = Number(card?.hp) || 0
        for (const spell of card?.spells || []) {
            if (!spell?.is_defence) p += Number(spell?.attack) || 0
        }
        return p
    }

    function totalPower(card, grade) {
        return Math.round(basePower(card) * gradeMult(grade))
    }

    async function api(path, extra = {}) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody(extra)),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.success === false) {
            const err = new Error(data.message || data.error || "Market request failed")
            err.code = data.error
            err.data = data
            throw err
        }
        return data
    }

    // --- Wallet + sub-tab chrome ------------------------------------------

    function refreshWallet() {
        const wallet = el("market-wallet")
        if (wallet) wallet.textContent = `◈ ${fmt(getBalance())}`
    }

    function setSub(sub) {
        currentSub = sub
        document.querySelectorAll(".market-subtab").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.marketSub === sub)
        })
        el("market-browse-panel")?.classList.toggle("hidden", sub !== "browse")
        el("market-mine-panel")?.classList.toggle("hidden", sub !== "mine")
        el("market-history-panel")?.classList.toggle("hidden", sub !== "history")
        const filters = el("market-filters")
        if (filters) filters.classList.toggle("hidden", sub !== "browse")
    }

    // --- Rendering --------------------------------------------------------

    function cardVisualHtml(item, extraBadge) {
        const grade = Number(item.grade) || 1
        const mult = item.multiplier != null ? item.multiplier : gradeMult(grade)
        const badge = extraBadge || ""
        return `
            <div class="market-card-visual vault-slot-visual" data-grade="${grade}">
                <div class="vault-slot-frame" data-grade="${grade}">
                    <img class="bag-card-img" src="${escapeHtml(item.image || "")}" alt="${escapeHtml(item.name || "")}" loading="lazy" decoding="async">
                </div>
                <span class="vault-slot-grade vault-grade-tag" data-grade="${grade}">G${grade}</span>
                <span class="market-card-mult">${formatMult(mult)}</span>
                ${badge}
            </div>`
    }

    function listingTileHtml(item, mode) {
        const grade = Number(item.grade) || 1
        const power = item.total_power != null ? item.total_power : ""
        const typeLabel = item.type ? String(item.type).toUpperCase() : ""
        const sub = [typeLabel, `G${grade} ${String(item.grade_label || gradeLabel(grade)).toUpperCase()}`]
            .filter(Boolean)
            .join(" · ")

        let footHtml = ""
        let stateClass = ""
        if (mode === "browse") {
            if (item.is_own) {
                footHtml = `<span class="market-card-price">◈ ${fmt(item.price_chips)}</span>
                    <span class="market-card-owned">OWNED</span>`
                stateClass = "is-own"
            } else {
                footHtml = `<span class="market-card-price">◈ ${fmt(item.price_chips)}</span>
                    <button type="button" class="market-btn market-btn--buy" data-buy="${item.listing_id}">BUY</button>`
            }
        } else if (mode === "mine") {
            const status = String(item.status || "active")
            if (status === "active") {
                footHtml = `<span class="market-card-price">◈ ${fmt(item.price_chips)}</span>
                    <button type="button" class="market-btn market-btn--cancel" data-cancel="${item.listing_id}">CANCEL</button>`
            } else {
                const label = status === "sold" ? `SOLD ◈ ${fmt(item.price_chips)}` : "CANCELLED"
                footHtml = `<span class="market-card-status market-card-status--${status}">${label}</span>`
                stateClass = `is-${status}`
            }
        }

        const sellerHtml = mode === "browse" && !item.is_own
            ? `<p class="market-card-seller">by ${escapeHtml(item.seller_name || "Trainer")}</p>`
            : ""

        return `
            <div class="market-card ${stateClass}" data-grade="${grade}">
                ${cardVisualHtml(item)}
                <div class="market-card-info">
                    <p class="market-card-name">${escapeHtml(item.name)}</p>
                    <p class="market-card-sub">${escapeHtml(sub)}</p>
                    ${power !== "" ? `<p class="market-card-power">⚔ ${fmt(power)} PWR</p>` : ""}
                    ${sellerHtml}
                </div>
                <div class="market-card-foot">${footHtml}</div>
            </div>`
    }

    function renderBrowse() {
        const grid = el("market-listings")
        if (!grid) return
        if (!lastBrowse.length) {
            grid.innerHTML = `<p class="market-empty">◈ No cards listed yet.<br>Be the first — open MY CARDS to sell one.</p>`
            return
        }
        grid.innerHTML = lastBrowse.map((it) => listingTileHtml(it, "browse")).join("")
    }

    function renderMine() {
        const grid = el("market-mine-listings")
        if (!grid) return
        if (!lastMine.length) {
            grid.innerHTML = `<p class="market-empty">◈ You have no listings.<br>Tap SELL A CARD to put one up.</p>`
            return
        }
        grid.innerHTML = lastMine.map((it) => listingTileHtml(it, "mine")).join("")
    }

    function renderHistory() {
        const box = el("market-history")
        if (!box) return
        if (!lastHistory.length) {
            box.innerHTML = `<p class="market-empty">◈ No sales yet.</p>`
            return
        }
        box.innerHTML = lastHistory.map((it) => `
            <div class="market-history-row" data-grade="${Number(it.grade) || 1}">
                <span class="market-history-grade vault-grade-tag" data-grade="${Number(it.grade) || 1}">G${Number(it.grade) || 1}</span>
                <span class="market-history-name">${escapeHtml(it.name)}</span>
                <span class="market-history-price">◈ ${fmt(it.price_chips)}</span>
            </div>`).join("")
    }

    function populateTypeFilter() {
        const select = el("market-filter-type")
        if (!select) return
        const current = select.value
        const types = Array.from(new Set(lastBrowse.map((it) => it.type).filter(Boolean))).sort()
        select.innerHTML = `<option value="all">ALL TYPES</option>` +
            types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(String(t).toUpperCase())}</option>`).join("")
        if (current && (current === "all" || types.includes(current))) select.value = current
    }

    // --- Loaders ----------------------------------------------------------

    function browseFilters() {
        return {
            query: el("market-search")?.value || "",
            type: el("market-filter-type")?.value || "all",
            grade: el("market-filter-grade")?.value || "all",
            sort: el("market-sort")?.value || "newest",
        }
    }

    async function loadBrowse() {
        try {
            const data = await api("/api/market/browse", browseFilters())
            if (data.config) config = { ...config, ...data.config }
            lastBrowse = Array.isArray(data.listings) ? data.listings : []
            lastHistory = Array.isArray(data.history) ? data.history : []
            populateTypeFilter()
            renderBrowse()
            renderHistory()
        } catch (err) {
            const grid = el("market-listings")
            if (grid) grid.innerHTML = `<p class="market-empty">◈ ${escapeHtml(err.message)}</p>`
        }
    }

    async function loadMine() {
        try {
            const data = await api("/api/market/mine")
            if (data.config) config = { ...config, ...data.config }
            lastMine = Array.isArray(data.listings) ? data.listings : []
            if (Array.isArray(data.locked_card_ids)) setMarketLocked(data.locked_card_ids)
            renderMine()
        } catch (err) {
            const grid = el("market-mine-listings")
            if (grid) grid.innerHTML = `<p class="market-empty">◈ ${escapeHtml(err.message)}</p>`
        }
    }

    function loadCurrentSub() {
        if (currentSub === "mine") loadMine()
        else if (currentSub === "history") { renderHistory(); if (!lastHistory.length) loadBrowse() }
        else loadBrowse()
    }

    async function load() {
        refreshWallet()
        setSub(currentSub)
        await loadBrowse()
        if (currentSub === "mine") await loadMine()
    }

    // --- Sell flow --------------------------------------------------------

    function sellableStacks() {
        const locked = new Set(getMarketLocked?.() || [])
        return (getVault?.() || []).filter((s) => s?.card_id && !locked.has(s.card_id))
    }

    function openPickModal() {
        const grid = el("market-pick-grid")
        const modal = el("market-pick-modal")
        if (!grid || !modal) return
        const stacks = sellableStacks()
        if (!stacks.length) {
            grid.innerHTML = `<p class="market-empty">◈ No sellable cards.<br>All your cards are already listed, or your Vault is empty.</p>`
        } else {
            grid.innerHTML = stacks.map((stack) => {
                const card = getCard(stack.card_id)
                const grade = Number(stack.grade) || 1
                return `
                    <button type="button" class="market-pick-card" data-pick="${escapeHtml(stack.card_id)}" data-grade="${grade}">
                        <div class="vault-slot-visual" data-grade="${grade}">
                            <div class="vault-slot-frame" data-grade="${grade}">
                                <img class="bag-card-img" src="${escapeHtml(card?.src || "")}" alt="${escapeHtml(card?.name || "")}" loading="lazy">
                            </div>
                            <span class="vault-slot-grade vault-grade-tag" data-grade="${grade}">G${grade}</span>
                        </div>
                        <span class="market-pick-name">${escapeHtml(card?.name || stack.card_id)}</span>
                    </button>`
            }).join("")
        }
        modal.classList.remove("hidden")
    }

    function closePickModal() {
        el("market-pick-modal")?.classList.add("hidden")
    }

    function updateSellBreakdown() {
        const price = Math.max(0, Math.floor(Number(el("market-sell-price")?.value) || 0))
        const fee = Math.floor(price * (config.fee_pct || 0.05))
        const net = price - fee
        const feeEl = el("market-sell-fee")
        const netEl = el("market-sell-net")
        const pctEl = el("market-sell-fee-pct")
        if (pctEl) pctEl.textContent = `${Math.round((config.fee_pct || 0.05) * 100)}%`
        if (feeEl) feeEl.textContent = `◈ ${fmt(fee)}`
        if (netEl) netEl.textContent = `◈ ${fmt(net)}`
    }

    // When the sell dialog is triggered from the in-game Vault, the PokéTab is
    // closed, so open it (to the Market) first — the popup lives inside the tab.
    function ensureMarketOpen() {
        const modal = document.getElementById("poketab-modal")
        if (modal && modal.classList.contains("hidden")) {
            window.PoketabSocial?.open?.()
            const tabBtn = document.querySelector('[data-go="market"]')
            if (tabBtn) tabBtn.click()
        }
    }

    function openSellModal(cardId) {
        const stack = (getVault?.() || []).find((s) => s?.card_id === cardId)
        if (!stack) {
            showToast("That card isn't in your Vault.", true)
            return
        }
        if ((getMarketLocked?.() || []).includes(cardId)) {
            showToast("That card is already listed.", true)
            return
        }
        ensureMarketOpen()
        closePickModal()
        sellCardId = cardId
        const card = getCard(cardId)
        const grade = Number(stack.grade) || 1
        const panel = document.querySelector("#market-sell-modal .market-sell-panel")
        if (panel) panel.dataset.grade = String(grade)

        const setGrade = (id) => { const n = el(id); if (n) n.dataset.grade = String(grade) }
        setGrade("market-sell-visual")
        setGrade("market-sell-frame")
        setGrade("market-sell-grade")
        setGrade("market-sell-tag")

        const art = el("market-sell-art")
        if (art) { art.src = card?.src || ""; art.alt = card?.name || cardId }
        const gradeEl = el("market-sell-grade")
        if (gradeEl) gradeEl.textContent = `G${grade}`
        const nameEl = el("market-sell-name")
        if (nameEl) nameEl.textContent = card?.name || cardId
        const tagEl = el("market-sell-tag")
        if (tagEl) tagEl.textContent = String(gradeLabel(grade)).toUpperCase()
        const statEl = el("market-sell-stat")
        if (statEl) {
            const parts = [
                card?.type ? String(card.type).toUpperCase() : null,
                card ? `⚔ ${fmt(totalPower(card, grade))} PWR` : null,
                `BATTLE ${formatMult(gradeMult(grade))}`,
            ].filter(Boolean)
            statEl.textContent = parts.join("  ·  ")
        }
        const errEl = el("market-sell-error")
        if (errEl) errEl.textContent = ""
        const priceInput = el("market-sell-price")
        if (priceInput) priceInput.value = ""
        updateSellBreakdown()
        el("market-sell-modal")?.classList.remove("hidden")
        setTimeout(() => priceInput?.focus(), 60)
    }

    function closeSellModal() {
        sellCardId = null
        el("market-sell-modal")?.classList.add("hidden")
    }

    async function confirmSell() {
        if (busy || !sellCardId) return
        const price = Math.floor(Number(el("market-sell-price")?.value) || 0)
        const errEl = el("market-sell-error")
        const min = config.min_price || 1
        if (!Number.isFinite(price) || price < min) {
            if (errEl) errEl.textContent = `Price must be at least ◈ ${fmt(min)}.`
            return
        }
        busy = true
        const confirmBtn = el("market-sell-confirm")
        if (confirmBtn) confirmBtn.disabled = true
        try {
            const data = await api("/api/market/sell", { card_id: sellCardId, price })
            if (Array.isArray(data.locked_card_ids)) setMarketLocked(data.locked_card_ids)
            showToast("Card listed on the Market!")
            closeSellModal()
            currentSub = "mine"
            setSub("mine")
            await loadMine()
        } catch (err) {
            if (errEl) errEl.textContent = err.message || "Could not list card."
        } finally {
            busy = false
            if (confirmBtn) confirmBtn.disabled = false
        }
    }

    // --- Cancel flow ------------------------------------------------------

    async function cancelListing(listingId) {
        if (busy || !listingId) return
        busy = true
        try {
            const data = await api("/api/market/cancel", { listing_id: Number(listingId) })
            if (Array.isArray(data.locked_card_ids)) setMarketLocked(data.locked_card_ids)
            showToast("Listing cancelled — card unlocked.")
            await loadMine()
            if (currentSub === "browse") await loadBrowse()
        } catch (err) {
            showToast(err.message || "Could not cancel listing.", true)
        } finally {
            busy = false
        }
    }

    async function cancelForCard(cardId) {
        // Ensure we have fresh listings so we can map card -> active listing id.
        if (!lastMine.some((it) => it.card_id === cardId && it.status === "active")) {
            try {
                const data = await api("/api/market/mine")
                lastMine = Array.isArray(data.listings) ? data.listings : []
                if (Array.isArray(data.locked_card_ids)) setMarketLocked(data.locked_card_ids)
            } catch { /* ignore */ }
        }
        const listing = lastMine.find((it) => it.card_id === cardId && it.status === "active")
        if (!listing) {
            showToast("Couldn't find that listing.", true)
            return
        }
        await cancelListing(listing.listing_id)
    }

    // --- Buy flow ---------------------------------------------------------

    function openBuyModal(listingId) {
        const item = lastBrowse.find((it) => String(it.listing_id) === String(listingId))
        if (!item) return
        buyListingId = item.listing_id
        const grade = Number(item.grade) || 1
        const panel = document.querySelector("#market-buy-modal .market-buy-panel")
        if (panel) panel.dataset.grade = String(grade)
        const setGrade = (id) => { const n = el(id); if (n) n.dataset.grade = String(grade) }
        setGrade("market-buy-visual"); setGrade("market-buy-frame"); setGrade("market-buy-grade"); setGrade("market-buy-tag")
        const art = el("market-buy-art")
        if (art) { art.src = item.image || ""; art.alt = item.name || "" }
        el("market-buy-grade").textContent = `G${grade}`
        el("market-buy-name").textContent = item.name
        el("market-buy-tag").textContent = String(item.grade_label || gradeLabel(grade)).toUpperCase()
        el("market-buy-stat").textContent = [
            item.type ? String(item.type).toUpperCase() : null,
            item.total_power != null ? `⚔ ${fmt(item.total_power)} PWR` : null,
            `BATTLE ${formatMult(item.multiplier != null ? item.multiplier : gradeMult(grade))}`,
        ].filter(Boolean).join("  ·  ")
        el("market-buy-seller").textContent = `Seller: ${item.seller_name || "Trainer"}`
        el("market-buy-price").textContent = `◈ ${fmt(item.price_chips)}`
        el("market-buy-balance").textContent = `◈ ${fmt(getBalance())}`
        const errEl = el("market-buy-error")
        if (errEl) errEl.textContent = getBalance() < item.price_chips ? "Not enough CHIPS for this card." : ""
        const confirmBtn = el("market-buy-confirm")
        if (confirmBtn) confirmBtn.disabled = getBalance() < item.price_chips
        el("market-buy-modal")?.classList.remove("hidden")
    }

    function closeBuyModal() {
        buyListingId = null
        el("market-buy-modal")?.classList.add("hidden")
    }

    async function confirmBuy() {
        if (busy || !buyListingId) return
        busy = true
        const confirmBtn = el("market-buy-confirm")
        if (confirmBtn) confirmBtn.disabled = true
        try {
            const data = await api("/api/market/buy", { listing_id: Number(buyListingId) })
            showToast(`Bought ${data.card_name || "card"}! It's in your Vault.`)
            closeBuyModal()
            await onBalanceUpdate()
            refreshWallet()
            await loadBrowse()
        } catch (err) {
            const errEl = el("market-buy-error")
            if (errEl) errEl.textContent = err.message || "Purchase failed."
            // Listing may have been taken — refresh the board.
            if (err.code === "listing_not_active" || err.code === "seller_no_longer_owns") {
                await loadBrowse()
            }
        } finally {
            busy = false
            if (confirmBtn) confirmBtn.disabled = false
        }
    }

    // --- Events -----------------------------------------------------------

    function bindEvents() {
        if (bound) return
        bound = true

        document.querySelectorAll(".market-subtab").forEach((btn) => {
            btn.addEventListener("click", () => {
                setSub(btn.dataset.marketSub)
                loadCurrentSub()
            })
        })

        el("market-search")?.addEventListener("input", () => {
            clearTimeout(searchTimer)
            searchTimer = setTimeout(loadBrowse, 260)
        })
        ;["market-filter-type", "market-filter-grade", "market-sort"].forEach((id) => {
            el(id)?.addEventListener("change", loadBrowse)
        })

        el("market-listings")?.addEventListener("click", (e) => {
            const buyBtn = e.target.closest("[data-buy]")
            if (buyBtn) openBuyModal(buyBtn.dataset.buy)
        })

        el("market-mine-listings")?.addEventListener("click", (e) => {
            const cancelBtn = e.target.closest("[data-cancel]")
            if (cancelBtn) cancelListing(cancelBtn.dataset.cancel)
        })

        el("market-sell-cta")?.addEventListener("click", openPickModal)
        el("market-pick-grid")?.addEventListener("click", (e) => {
            const pick = e.target.closest("[data-pick]")
            if (pick) openSellModal(pick.dataset.pick)
        })
        el("market-pick-close")?.addEventListener("click", closePickModal)
        el("market-pick-scrim")?.addEventListener("click", closePickModal)

        el("market-sell-price")?.addEventListener("input", updateSellBreakdown)
        el("market-sell-confirm")?.addEventListener("click", confirmSell)
        el("market-sell-cancel")?.addEventListener("click", closeSellModal)
        el("market-sell-close")?.addEventListener("click", closeSellModal)
        el("market-sell-scrim")?.addEventListener("click", closeSellModal)

        el("market-buy-confirm")?.addEventListener("click", confirmBuy)
        el("market-buy-cancel")?.addEventListener("click", closeBuyModal)
        el("market-buy-close")?.addEventListener("click", closeBuyModal)
        el("market-buy-scrim")?.addEventListener("click", closeBuyModal)

        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return
            if (!el("market-buy-modal")?.classList.contains("hidden")) closeBuyModal()
            else if (!el("market-sell-modal")?.classList.contains("hidden")) closeSellModal()
            else if (!el("market-pick-modal")?.classList.contains("hidden")) closePickModal()
        })
    }

    function init(deps = {}) {
        apiAuthBody = deps.apiAuthBody || apiAuthBody
        showToast = deps.showToast || showToast
        getVault = deps.getVault || getVault
        getBalance = deps.getBalance || getBalance
        onBalanceUpdate = deps.onBalanceUpdate || onBalanceUpdate
        getCard = deps.getCard || getCard
        getGrading = deps.getGrading || getGrading
        getMarketLocked = deps.getMarketLocked || getMarketLocked
        setMarketLocked = deps.setMarketLocked || setMarketLocked
        bindEvents()
    }

    window.PoketabMarket = {
        init,
        load,
        openSellModal,
        cancelForCard,
        refreshWallet,
        isBusy: () => busy,
    }
})()
