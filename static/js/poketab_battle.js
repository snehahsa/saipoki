/**
 * PokéTab Battle — wager matches with Game Boy-style arena UI.
 */
(function () {
    const MAX_TEAM = 1
    const CARD_CATALOG = window.APP_CONFIG?.cardCatalog || {}
    const TYPE_COLORS = {
        Normal: "#a8a878",
        Fire: "#f08030",
        Water: "#6890f0",
        Grass: "#78c850",
        Electric: "#f8d030",
        Ice: "#98d8d8",
        Fighting: "#c03028",
        Poison: "#a040a0",
        Ground: "#e0c068",
        Flying: "#a890f0",
        Psychic: "#f85888",
        Bug: "#a8b820",
        Rock: "#b8a038",
        Ghost: "#705898",
        Dragon: "#7038f8",
        Dark: "#705848",
        Steel: "#b8b8d0",
        Fairy: "#ee99ac",
    }

    let apiAuthBody = () => ({})
    let showToast = () => {}
    let getVault = () => []
    let getBalance = () => 0
    let onBalanceUpdate = () => {}
    let setLedState = () => {}
    let setView = () => {}
    let refreshSummary = () => Promise.resolve()

    let alertPollTimer = null
    let turnTimer = null
    let statusCache = null
    let selectedTeam = new Set()
    let activeInviteId = null
    let battleLog = []
    let pendingAutoSelect = null
    let bagMenuOpen = false
    let revivePickOptions = null

    async function apiPost(path, extra = {}) {
        let res
        try {
            res = await fetch(path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(apiAuthBody(extra)),
            })
        } catch {
            throw new Error("Network error — check connection and retry")
        }
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
        if (data.success === false) throw new Error(data.error || "Request failed")
        return data
    }

    function escapeHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    }

    function formatCoins(n) {
        return (Number(n) || 0).toLocaleString()
    }

    function typeColor(type) {
        return TYPE_COLORS[type] || "#6890f0"
    }

    function parseInviteId(value) {
        const id = Number.parseInt(String(value || ""), 10)
        return Number.isFinite(id) && id > 0 ? id : null
    }

    function cardMeta(cardId) {
        return CARD_CATALOG[cardId] || { id: cardId, name: cardId, type: "Normal" }
    }

    function hpColorTier(pct) {
        if (pct > 50) return "hp-high"
        if (pct > 20) return "hp-mid"
        return "hp-low"
    }

    function hpBarHtml(current, max, label) {
        const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0
        const tier = hpColorTier(pct)
        return `
            <div class="poketab-gb-hpblock">
                <span class="poketab-gb-hpname">${escapeHtml(label)}</span>
                <div class="poketab-gb-hpbar">
                    <div class="poketab-gb-hpfill poketab-gb-hpfill--${tier}" style="width:${pct}%"></div>
                </div>
                <span class="poketab-gb-hpnums">${Math.max(0, Math.ceil(current))}/${max}</span>
            </div>
        `
    }

    function moveStatHtml(spell) {
        if (spell.is_defence) {
            return `<span class="poketab-gb-move-stats">DEF · ×${spell.remaining}</span>`
        }
        return `<span class="poketab-gb-move-stats">${spell.attack} DMG · ×${spell.remaining}</span>`
    }

    function bagMenuHtml(me) {
        const pool = me?.pool || []
        const poolById = Object.fromEntries(pool.map((c) => [c.card_id, c]))
        if (revivePickOptions?.length) {
            return `
                <div class="poketab-gb-menu poketab-gb-menu-bag">
                    <p class="poketab-gb-menu-title">REVIVE WHO?</p>
                    <div class="poketab-gb-moves poketab-gb-bag-items">
                        ${revivePickOptions.map((cardId) => {
                            const card = poolById[cardId] || { card_id: cardId, name: cardId }
                            return `
                                <button type="button" class="poketab-gb-move bag-item" data-battle-revive-pick="${escapeHtml(cardId)}">
                                    ${card.image ? `<img class="poketab-gb-pick-img poketab-gb-bag-img" src="${escapeHtml(card.image)}" alt="">` : ""}
                                    <span>${escapeHtml(card.name)}</span>
                                </button>
                            `
                        }).join("")}
                        <button type="button" class="poketab-gb-move bag-back" data-battle-bag-back="1">BACK</button>
                    </div>
                </div>
            `
        }
        const bagItem = me?.special_card
        const itemsHtml = bagItem
            ? `<button type="button" class="poketab-gb-move bag-item" data-battle-bag-item="1">${escapeHtml(bagItem)}</button>`
            : `<p class="poketab-gb-wait">BAG IS EMPTY</p>`
        return `
            <div class="poketab-gb-menu poketab-gb-menu-bag">
                <p class="poketab-gb-menu-title">POKéBAG</p>
                <div class="poketab-gb-moves poketab-gb-bag-items">
                    ${itemsHtml}
                    <button type="button" class="poketab-gb-move bag-back" data-battle-bag-back="1">BACK</button>
                </div>
            </div>
        `
    }

    function spriteHtml(card, flip) {
        const meta = cardMeta(card?.card_id || card?.id || card)
        const src = meta.src || card?.image
        const type = meta.type || card?.type || "Normal"
        const color = typeColor(type)
        const inner = src
            ? `<img class="poketab-gb-sprite-img" src="${escapeHtml(src)}" alt="">`
            : `<div class="poketab-gb-sprite-pixel" style="background:${color}"></div>`
        return `<div class="poketab-gb-sprite${flip ? " flip" : ""}">${inner}</div>`
    }

    function isInArena() {
        return !document.getElementById("poketab-battle-overlay")?.classList.contains("hidden")
    }

    function isInTeamSelect() {
        return !document.getElementById("poketab-battle-team")?.classList.contains("hidden")
    }

    function isBattleViewActive() {
        return document.querySelector('[data-poketab-view="battle"]')?.classList.contains("active")
    }

    function isPoketabOpen() {
        const modal = document.getElementById("poketab-modal")
        return modal && !modal.classList.contains("hidden")
    }

    function syncBattleFromStatus(data, { forceOpen = false } = {}) {
        const battle = data?.battle
        const invite = data?.invite
        const autoOpen = forceOpen || (isPoketabOpen() && (isBattleViewActive() || isInArena() || isInTeamSelect()))

        if (battle) {
            if (autoOpen || isInArena()) {
                openArena(battle)
            }
            return
        }

        if (invite?.status === "team_select" && !invite.my_team_ready) {
            if (autoOpen || isInTeamSelect()) {
                openTeamSelect(invite.id, invite.bet)
            }
            return
        }

        if (invite?.status === "team_select" && invite.my_team_ready && !invite.opponent_team_ready) {
            if (autoOpen || isInTeamSelect() || isBattleViewActive()) {
                showBattleWaiting("TEAM LOCKED — WAITING FOR FOE...")
            }
        }
    }

    function showBattleWaiting(message) {
        document.getElementById("poketab-battle-team")?.classList.add("hidden")
        document.getElementById("poketab-battle-lobby")?.classList.remove("hidden")
        closeArena()
        setTallMonitor(false)
        setView("battle")
        const list = document.getElementById("poketab-battle-opponents")
        if (list) {
            list.innerHTML = `<p class="poketab-empty">${escapeHtml(message || "WAITING...")}</p>`
        }
    }

    function isFlowLocked() {
        if (isInArena() || isInTeamSelect()) return true
        const battle = statusCache?.battle
        if (battle && battle.phase !== "ended") return true
        const invite = statusCache?.invite
        return !!(invite && (invite.status === "pending" || invite.status === "team_select"))
    }

    function resumeBattleView() {
        const battle = statusCache?.battle
        if (battle && battle.phase !== "ended") {
            openArena(battle)
            return true
        }
        const invite = statusCache?.invite
        if (invite?.status === "team_select" && !invite.my_team_ready) {
            openTeamSelect(invite.id, invite.bet)
            return true
        }
        if (invite?.status === "team_select" && invite.my_team_ready && !invite.opponent_team_ready) {
            showBattleWaiting("TEAM LOCKED — WAITING FOR FOE...")
            return true
        }
        if (invite?.status === "pending" && invite.is_challenger) {
            setView("battle")
            document.getElementById("poketab-battle-team")?.classList.add("hidden")
            document.getElementById("poketab-battle-lobby")?.classList.remove("hidden")
            const list = document.getElementById("poketab-battle-opponents")
            if (list) {
                list.innerHTML = `<p class="poketab-empty">CHALLENGE SENT — AWAITING REPLY...</p>`
            }
            return true
        }
        return false
    }

    function updateAlertPanel(invites, invite, battleAlerts) {
        const panel = document.getElementById("poketab-alert-panel")
        const list = document.getElementById("poketab-alert-list")
        if (!panel || !list) return
        const battle = statusCache?.battle
        const count = (invites?.length || 0) + (battleAlerts || 0)
        const hasContent = (invites?.length || 0) > 0
            || (invite?.status === "team_select" && !invite.my_team_ready)
            || (invite?.status === "pending" && invite.is_challenger)
            || (invite?.status === "team_select" && invite.my_team_ready && !invite.opponent_team_ready)
            || (battle && battle.phase !== "ended")
        panel.classList.toggle("poketab-duel-module-alert", count > 0 || hasContent)
        if (!invites?.length && !invite && !battle) {
            list.innerHTML = `<p class="poketab-duel-empty">STANDBY</p>`
            return
        }
        const chunks = []
        for (const inv of invites || []) {
            chunks.push(`
                <div class="poketab-duel-card poketab-duel-card-danger">
                    <p class="poketab-duel-title">CHALLENGE!</p>
                    <p class="poketab-duel-body">${escapeHtml(inv.challenger?.display_name || "Trainer")}</p>
                    <p class="poketab-duel-wager">${formatCoins(inv.bet)} $POKE</p>
                    <div class="poketab-duel-actions">
                        <button type="button" class="poketab-duel-btn accept" data-battle-accept="${inv.id}">FIGHT</button>
                        <button type="button" class="poketab-duel-btn decline" data-battle-decline="${inv.id}">NO</button>
                    </div>
                </div>
            `)
        }
        if (invite?.status === "pending" && invite.is_challenger) {
            chunks.push(`
                <div class="poketab-duel-card poketab-duel-card-warn">
                    <p class="poketab-duel-title">SENT</p>
                    <p class="poketab-duel-body">vs ${escapeHtml(invite.opponent?.display_name || "Trainer")}</p>
                    <p class="poketab-duel-wager">${formatCoins(invite.bet)} $POKE</p>
                    <p class="poketab-duel-body">AWAITING REPLY...</p>
                </div>
            `)
        }
        if (invite?.status === "team_select" && !invite.my_team_ready) {
            chunks.push(`
                <div class="poketab-duel-card poketab-duel-card-warn">
                    <p class="poketab-duel-title">TEAM</p>
                    <p class="poketab-duel-body">vs ${escapeHtml(invite.opponent?.display_name || "Trainer")}</p>
                    <p class="poketab-duel-wager">${formatCoins(invite.bet)} $POKE</p>
                    <button type="button" class="poketab-duel-btn accept" data-battle-pick-team="${invite.id}">PICK</button>
                </div>
            `)
        }
        if (invite?.status === "team_select" && invite.my_team_ready && !invite.opponent_team_ready) {
            chunks.push(`
                <div class="poketab-duel-card poketab-duel-card-warn">
                    <p class="poketab-duel-title">READY</p>
                    <p class="poketab-duel-body">vs ${escapeHtml(invite.opponent?.display_name || "Trainer")}</p>
                    <p class="poketab-duel-wager">WAITING FOR FOE TEAM...</p>
                </div>
            `)
        }
        if (battle && battle.phase !== "ended") {
            chunks.push(`
                <div class="poketab-duel-card poketab-duel-card-live">
                    <p class="poketab-duel-title">LIVE</p>
                    <p class="poketab-duel-wager">${formatCoins(battle.bet)} $POKE</p>
                    <button type="button" class="poketab-duel-btn accept" data-battle-resume="1">GO</button>
                </div>
            `)
        }
        list.innerHTML = chunks.join("") || `<p class="poketab-duel-empty">STANDBY</p>`
    }

    function updateBalanceDisplay(balance) {
        const el = document.getElementById("poketab-battle-balance")
        if (el) el.textContent = `> BALANCE: ${formatCoins(balance)} $POKE`
    }

    async function loadOpponents() {
        const list = document.getElementById("poketab-battle-opponents")
        if (!list) return
        setLedState("busy")
        list.innerHTML = `<p class="poketab-empty">SCANNING BATTLE-READY TRAINERS...</p>`
        try {
            const data = await apiPost("/api/poketab/battle/opponents")
            updateBalanceDisplay(data.balance)
            const opponents = data.opponents || []
            if (!opponents.length) {
                list.innerHTML = `<p class="poketab-empty">NO BATTLE-READY TRAINERS ONLINE.</p>`
                setLedState("ready")
                return
            }
            const wager = Number(document.getElementById("poketab-battle-wager")?.value) || 50
            list.innerHTML = opponents.map((opp) => {
                const canAfford = opp.balance >= wager && data.balance >= wager
                const friendTag = opp.is_friend
                    ? `<span class="poketab-pill poketab-pill-friend">FRIEND</span> `
                    : ""
                return `
                    <div class="poketab-row poketab-battle-opp-row">
                        <div class="poketab-row-main">
                            <div class="poketab-row-name">${friendTag}${escapeHtml(opp.display_name)}</div>
                            <div class="poketab-battle-opp-meta">${opp.vault_cards} cards · ${formatCoins(opp.balance)} $POKE</div>
                        </div>
                        <button type="button" class="poketab-action-btn poketab-battle-challenge-btn"
                            data-challenge-id="${escapeHtml(opp.telegram_id)}"
                            ${canAfford ? "" : "disabled"}>
                            ${canAfford ? "CHALLENGE" : "LOW FUNDS"}
                        </button>
                    </div>
                `
            }).join("")
            setLedState("ok")
            window.setTimeout(() => setLedState("ready"), 400)
        } catch (err) {
            list.innerHTML = `<p class="poketab-empty">${escapeHtml(err.message.toUpperCase())}</p>`
            setLedState("error")
        }
    }

    async function sendChallenge(targetId, btn) {
        const wagerEl = document.getElementById("poketab-battle-wager")
        const bet = Number(wagerEl?.value) || 0
        if (bet < 1) {
            showToast("Enter a valid wager.", true)
            return
        }
        if (getBalance() < bet) {
            showToast("Insufficient balance for this wager.", true)
            return
        }
        if (btn) {
            btn.disabled = true
            btn.textContent = "SENT"
            btn.classList.add("is-sent")
        }
        setLedState("busy")
        try {
            const data = await apiPost("/api/poketab/battle/challenge", { target_id: targetId, bet })
            showToast(data.notify_delivered === false
                ? "Challenge sent — opponent will be alerted shortly"
                : "Battle challenge sent!")
            activeInviteId = data.invite_id
            await refreshStatus()
            setLedState("ready")
        } catch (err) {
            if (btn) {
                btn.disabled = false
                btn.textContent = "CHALLENGE"
                btn.classList.remove("is-sent")
            }
            showToast(err.message, true)
            setLedState("error")
        }
    }

    async function respondInvite(inviteId, accept, triggerBtn) {
        if (triggerBtn) {
            triggerBtn.disabled = true
            triggerBtn.textContent = accept ? "..." : "NO"
        }
        setLedState("busy")
        try {
            const data = await apiPost("/api/poketab/battle/respond", {
                invite_id: inviteId,
                action: accept ? "accept" : "decline",
            })
            if (accept) {
                showToast("Challenge accepted — pick your team!")
                activeInviteId = inviteId
                setView("battle")
                await refreshStatus()
                await openTeamSelect(inviteId, statusCache?.invite?.bet)
                if (triggerBtn) triggerBtn.textContent = "GO"
            } else {
                showToast("Challenge declined.")
                await refreshStatus()
            }
            setLedState("ready")
        } catch (err) {
            if (triggerBtn) {
                triggerBtn.disabled = false
                triggerBtn.textContent = accept ? "FIGHT" : "NO"
            }
            showToast(err.message, true)
            setLedState("error")
        }
    }

    function setTallMonitor(on) {
        document.querySelector(".poketab-monitor-glass")?.classList.toggle(
            "poketab-monitor-glass--battle",
            Boolean(on),
        )
    }

    async function openTeamSelect(inviteId, bet) {
        activeInviteId = inviteId
        selectedTeam = new Set()
        document.getElementById("poketab-battle-lobby")?.classList.add("hidden")
        const teamEl = document.getElementById("poketab-battle-team")
        teamEl?.classList.remove("hidden")
        setTallMonitor(true)
        const hint = document.getElementById("poketab-battle-team-hint")
        if (hint) {
            hint.textContent = `> WAGER ${formatCoins(bet || 0)} $POKE · PICK 1 CARD`
        }
        try {
            await Promise.resolve(onBalanceUpdate())
        } catch {
            /* vault refresh best-effort */
        }
        renderTeamGrid()
        setView("battle")
    }

    function renderTeamGrid() {
        const grid = document.getElementById("poketab-battle-team-grid")
        const hint = document.getElementById("poketab-battle-team-hint")
        if (!grid) return
        const vault = getVault()
        if (!vault.length) {
            grid.innerHTML = `<p class="poketab-empty">NO CARDS IN VAULT.</p>`
            return
        }
        grid.innerHTML = vault.map((cardId) => {
            const meta = cardMeta(cardId)
            const selected = selectedTeam.has(cardId)
            const src = meta.src
            return `
                <button type="button" class="poketab-battle-card${selected ? " selected" : ""}" data-team-card="${escapeHtml(cardId)}">
                    ${src ? `<img src="${escapeHtml(src)}" alt="">` : `<span class="poketab-battle-card-fallback" style="background:${typeColor(meta.type)}"></span>`}
                    <span class="poketab-battle-card-name">${escapeHtml(meta.name || cardId)}</span>
                    <span class="poketab-battle-card-type">${escapeHtml(meta.type || "")}</span>
                </button>
            `
        }).join("")
        if (hint) {
            const bet = statusCache?.invite?.bet || 0
            hint.textContent = `> WAGER ${formatCoins(bet)} $POKE · PICK 1 CARD${selectedTeam.size ? " ✓" : ""}`
        }
    }

    async function confirmTeam() {
        if (!activeInviteId || selectedTeam.size < 1) {
            showToast("Pick at least one card.", true)
            return
        }
        const confirmBtn = document.getElementById("poketab-battle-team-confirm")
        if (confirmBtn) confirmBtn.disabled = true
        setLedState("busy")
        try {
            const data = await apiPost("/api/poketab/battle/team", {
                invite_id: activeInviteId,
                card_ids: [...selectedTeam],
            })
            document.getElementById("poketab-battle-team")?.classList.add("hidden")
            if (data.battle) {
                showToast("Battle begins!")
                statusCache = { ...(statusCache || {}), battle: data.battle, invite: null }
                openArena(data.battle)
                await refreshStatus(true)
            } else if (data.started) {
                showToast("Battle begins!")
                await refreshStatus()
                if (statusCache?.battle) {
                    openArena(statusCache.battle)
                } else {
                    showBattleWaiting("STARTING BATTLE...")
                    window.setTimeout(() => refreshStatus().then(() => {
                        if (statusCache?.battle) openArena(statusCache.battle)
                    }), 600)
                }
            } else {
                showToast("Team locked — waiting for opponent...")
                showBattleWaiting("TEAM LOCKED — WAITING FOR FOE...")
                await refreshStatus(true)
            }
            setLedState("ready")
        } catch (err) {
            showToast(err.message, true)
            setLedState("error")
        } finally {
            if (confirmBtn) confirmBtn.disabled = false
        }
    }

    function stopPoll() {
        if (turnTimer) {
            clearInterval(turnTimer)
            turnTimer = null
        }
    }

    function stopAlertPoll() {
        if (alertPollTimer) {
            clearInterval(alertPollTimer)
            alertPollTimer = null
        }
    }

    function startAlertPoll() {
        if (alertPollTimer) return
        refreshStatus(true)
        alertPollTimer = window.setInterval(() => refreshStatus(true), 4000)
    }

    function startPoll() {
        startAlertPoll()
    }

    function openArena(battle) {
        if (!battle) return
        document.getElementById("poketab-battle-team")?.classList.add("hidden")
        document.getElementById("poketab-battle-lobby")?.classList.add("hidden")
        const overlay = document.getElementById("poketab-battle-overlay")
        const monitorInner = document.querySelector(".poketab-monitor-inner")
        const monitorGlass = document.querySelector(".poketab-monitor-glass")
        overlay?.classList.remove("hidden")
        overlay?.setAttribute("aria-hidden", "false")
        monitorInner?.classList.add("poketab-monitor-inner--battle")
        monitorGlass?.classList.add("poketab-monitor-glass--battle")
        setTallMonitor(true)
        document.getElementById("poketab-screen-label").textContent = "BATTLE MODE"
        setView("battle")
        renderArena(battle)
        startPoll()
    }

    function closeArena() {
        stopPoll()
        const overlay = document.getElementById("poketab-battle-overlay")
        overlay?.classList.add("hidden")
        overlay?.setAttribute("aria-hidden", "true")
        document.querySelector(".poketab-monitor-inner")?.classList.remove("poketab-monitor-inner--battle")
        setTallMonitor(isInTeamSelect())
        battleLog = []
        bagMenuOpen = false
        revivePickOptions = null
    }

    function renderArena(battle) {
        if (!battle) return
        statusCache = { ...statusCache, battle }
        if (!battle.is_my_turn || battle.phase === "ended" || battle.phase === "select_active") {
            bagMenuOpen = false
            revivePickOptions = null
        }
        if (battle.log?.length) {
            battleLog = [...battleLog, ...battle.log].slice(-20)
        }
        const arena = document.getElementById("poketab-gb-arena")
        if (!arena) return

        const me = battle.me
        const opp = battle.opponent
        const myMon = me?.pokemon
        const oppMon = opp?.pokemon
        const turnPct = battle.turn_seconds_left != null
            ? Math.max(0, Math.min(100, (battle.turn_seconds_left / 120) * 100))
            : 100

        let menuHtml = ""
        if (battle.phase === "ended") {
            const won = battle.winner_id === me?.id
            menuHtml = `
                <div class="poketab-gb-menu poketab-gb-menu-result">
                    <p class="poketab-gb-result">${won ? "YOU WIN!" : "YOU LOST..."}</p>
                    <p class="poketab-gb-result-sub">${escapeHtml(battle.payout_note || "")}</p>
                    <button type="button" class="poketab-gb-btn" data-battle-close="1">CONTINUE</button>
                </div>
            `
            stopPoll()
            onBalanceUpdate()
            refreshSummary()
        } else if (battle.phase === "select_active") {
            const pool = me?.pool || []
            const selectable = battle.is_my_turn
                ? pool.filter((c) => c.alive)
                : []
            const pickHtml = battle.is_my_turn
                ? (selectable.length
                    ? selectable.map((c) => `
                        <button type="button" class="poketab-gb-move poketab-gb-pick" data-battle-select="${escapeHtml(c.card_id)}">
                            ${c.image ? `<img class="poketab-gb-pick-img" src="${escapeHtml(c.image)}" alt="">` : ""}
                            <span>${escapeHtml(c.name)}</span>
                        </button>
                    `).join("")
                    : `<p class="poketab-gb-wait">NO CARDS READY — TAP GO ON DUEL FEED</p>`)
                : `<p class="poketab-gb-wait">...</p>`
            menuHtml = `
                <div class="poketab-gb-menu poketab-gb-menu-select">
                    <p class="poketab-gb-menu-title">${battle.is_my_turn ? "SEND OUT A CARD!" : "FOE IS CHOOSING..."}</p>
                    <div class="poketab-gb-moves poketab-gb-picks">
                        ${pickHtml}
                    </div>
                </div>
            `
        } else if (battle.is_my_turn) {
            if (bagMenuOpen) {
                menuHtml = bagMenuHtml(me)
            } else {
                const spells = myMon?.spells || []
                const hasBag = Boolean(me?.special_card)
                menuHtml = `
                    <div class="poketab-gb-menu">
                        <p class="poketab-gb-menu-title">WHAT WILL ${escapeHtml(myMon?.name || "YOU")} DO?</p>
                        <div class="poketab-gb-moves">
                            ${spells.map((s) => `
                                <button type="button" class="poketab-gb-move${s.is_defence ? " defence" : ""}"
                                    data-battle-attack="${escapeHtml(s.name)}" ${s.remaining <= 0 ? "disabled" : ""}>
                                    <span class="poketab-gb-move-name">${escapeHtml(s.name)}</span>
                                    ${moveStatHtml(s)}
                                </button>
                            `).join("")}
                            <button type="button" class="poketab-gb-move bag" data-battle-open-bag="1"${hasBag ? "" : " disabled"}>BAG</button>
                            <button type="button" class="poketab-gb-move flee" data-battle-flee="1">FLEE</button>
                        </div>
                    </div>
                `
            }
        } else {
            menuHtml = `
                <div class="poketab-gb-menu">
                    <p class="poketab-gb-menu-title">FOE'S TURN...</p>
                    <p class="poketab-gb-wait">⌛ ${battle.turn_seconds_left}s left</p>
                </div>
            `
        }

        const logLines = battleLog.length ? battleLog : (battle.log || ["A wild battle begins!"])
        arena.innerHTML = `
            <div class="poketab-gb-scene">
                <div class="poketab-gb-hud">
                    <div class="poketab-gb-timer"><div style="width:${turnPct}%"></div></div>
                    <div class="poketab-gb-wager">⚡ ${formatCoins(battle.bet)} $POKE</div>
                </div>
                <div class="poketab-gb-field">
                    <div class="poketab-gb-me-panel">
                        <div class="poketab-gb-mon-stack">
                            ${myMon ? spriteHtml(myMon, true) : ""}
                            ${myMon ? hpBarHtml(myMon.hp, myMon.max_hp, myMon.name) : `<span class="poketab-gb-hpname">${escapeHtml(me.name)}</span>`}
                        </div>
                    </div>
                    <div class="poketab-gb-opp-panel">
                        <div class="poketab-gb-mon-stack poketab-gb-mon-stack--opp">
                            ${oppMon ? hpBarHtml(oppMon.hp, oppMon.max_hp, oppMon.name) : `<span class="poketab-gb-hpname">${escapeHtml(opp.name)}</span>`}
                            ${oppMon ? spriteHtml(oppMon, false) : ""}
                        </div>
                    </div>
                </div>
                <div class="poketab-gb-textbox">
                    ${logLines.slice(-3).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
                </div>
                ${menuHtml}
            </div>
        `

        if (battle.phase === "select_active" && battle.is_my_turn) {
            const selectable = (me?.pool || []).filter((c) => c.alive)
            if (selectable.length === 1) {
                const cardId = selectable[0].card_id
                const autoKey = `${battle.game_id}:${cardId}`
                if (pendingAutoSelect !== autoKey) {
                    pendingAutoSelect = autoKey
                    window.setTimeout(() => {
                        if (statusCache?.battle?.phase === "select_active"
                            && statusCache?.battle?.is_my_turn
                            && statusCache?.battle?.game_id === battle.game_id) {
                            doAction("select_pokemon", { card_id: cardId })
                        }
                    }, 400)
                }
            } else {
                pendingAutoSelect = null
            }
        }

        if (turnTimer) clearInterval(turnTimer)
        if (battle.phase !== "ended" && battle.turn_seconds_left != null) {
            let left = battle.turn_seconds_left
            turnTimer = window.setInterval(() => {
                left -= 1
                const bar = arena.querySelector(".poketab-gb-timer div")
                if (bar) bar.style.width = `${Math.max(0, (left / 120) * 100)}%`
                if (left <= 0) refreshStatus(true)
            }, 1000)
        }
    }

    async function doAction(action, extra = {}) {
        setLedState("busy")
        try {
            const data = await apiPost("/api/poketab/battle/action", {
                action,
                game_id: statusCache?.battle?.game_id,
                ...extra,
            })
            if (data.need_revive_target && data.revive_options?.length) {
                revivePickOptions = data.revive_options
                bagMenuOpen = true
                if (data.battle) {
                    if (data.battle.log?.length) battleLog.push(...data.battle.log)
                    renderArena(data.battle)
                } else if (statusCache?.battle) {
                    renderArena(statusCache.battle)
                }
                setLedState("ready")
                return
            }
            bagMenuOpen = false
            revivePickOptions = null
            if (data.battle) {
                if (data.battle.log?.length) battleLog.push(...data.battle.log)
                openArena(data.battle)
            }
            if (data.ended) {
                if (data.trainer_stats && window.SaiPokeTrainer?.applyTrainerStats) {
                    window.SaiPokeTrainer.applyTrainerStats(data.trainer_stats, { xp_gained: 20 })
                }
                onBalanceUpdate()
                refreshSummary()
            }
            setLedState("ready")
        } catch (err) {
            showToast(err.message, true)
            setLedState("error")
            await refreshStatus(true)
        }
    }

    async function refreshStatus(silent) {
        try {
            const data = await apiPost("/api/poketab/battle/status")
            statusCache = data
            updateBalanceDisplay(data.balance)
            if (data.trainer_stats && window.SaiPokeTrainer?.applyTrainerStats) {
                window.SaiPokeTrainer.applyTrainerStats(data.trainer_stats, { xp_gained: 20 })
            }
            updateAlertPanel(data.incoming_invites, data.invite, data.battle_alerts)
            if (data.invite?.id) activeInviteId = data.invite.id
            syncBattleFromStatus(data, { forceOpen: !silent })
            if (!silent) refreshSummary()
        } catch {
            if (!silent) updateAlertPanel([], null, 0)
        }
    }

    function openBattleLobby() {
        if (resumeBattleView()) return
        document.getElementById("poketab-battle-lobby")?.classList.remove("hidden")
        document.getElementById("poketab-battle-team")?.classList.add("hidden")
        closeArena()
        setTallMonitor(false)
        setView("battle")
        updateBalanceDisplay(getBalance())
        loadOpponents()
        refreshStatus(true)
    }

    function handleRealtime(payload) {
        if (!payload?.event) return
        const ev = payload.event
        if (ev === "battle_invite") {
            showToast("⚔ Battle challenge incoming!")
            refreshStatus()
            refreshSummary()
        } else if (ev === "battle_update" || ev === "battle_start") {
            refreshStatus().then(() => {
                syncBattleFromStatus(statusCache || {}, { forceOpen: true })
                if (ev === "battle_start" && !statusCache?.battle) {
                    window.setTimeout(() => refreshStatus().then(() => {
                        syncBattleFromStatus(statusCache || {}, { forceOpen: true })
                    }), 500)
                }
            })
            refreshSummary()
        }
    }

    function onSummaryUpdate(summary) {
        const crt = document.getElementById("poketab-crt-battles")
        const alerts = Number(summary?.battle_alerts) || 0
        if (crt) {
            crt.textContent = `> BATTLE ALERTS: ${alerts}`
            crt.classList.toggle("poketab-crt-alert", alerts > 0)
        }
        document.getElementById("poketab-battle-btn")?.classList.toggle("poketab-battle-btn-alert", alerts > 0)
        if (alerts > 0) refreshStatus(true)
    }

    function bindEvents() {
        document.getElementById("poketab-battle-btn")?.addEventListener("click", openBattleLobby)

        document.getElementById("poketab-battle-opponents")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-challenge-id]")
            if (!btn || btn.disabled) return
            sendChallenge(btn.dataset.challengeId, btn)
        })

        document.getElementById("poketab-battle-wager")?.addEventListener("change", loadOpponents)

        document.getElementById("poketab-battle-team-grid")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-team-card]")
            if (!btn) return
            const id = btn.dataset.teamCard
            if (selectedTeam.has(id)) {
                selectedTeam.delete(id)
            } else {
                selectedTeam.clear()
                selectedTeam.add(id)
            }
            renderTeamGrid()
        })

        document.getElementById("poketab-battle-team-confirm")?.addEventListener("click", confirmTeam)

        const duelRoot = document.getElementById("poketab-modal") || document.getElementById("poketab-alert-panel")
        duelRoot?.addEventListener("click", async (e) => {
            const accept = e.target.closest("[data-battle-accept]")
            const decline = e.target.closest("[data-battle-decline]")
            const pick = e.target.closest("[data-battle-pick-team]")
            const resume = e.target.closest("[data-battle-resume]")
            if (!accept && !decline && !pick && !resume) return
            e.preventDefault()
            e.stopPropagation()
            if (accept) {
                const inviteId = parseInviteId(accept.dataset.battleAccept)
                if (inviteId) await respondInvite(inviteId, true, accept)
                return
            }
            if (decline) {
                const inviteId = parseInviteId(decline.dataset.battleDecline)
                if (inviteId) await respondInvite(inviteId, false, decline)
                return
            }
            if (pick) {
                const inviteId = parseInviteId(pick.dataset.battlePickTeam)
                if (inviteId) {
                    setView("battle")
                    await openTeamSelect(inviteId, statusCache?.invite?.bet)
                }
                return
            }
            if (resume && statusCache?.battle) {
                setView("battle")
                openArena(statusCache.battle)
            }
        }, true)


        document.getElementById("poketab-battle-overlay")?.addEventListener("click", (e) => {
            const sel = e.target.closest("[data-battle-select]")
            const atk = e.target.closest("[data-battle-attack]")
            const openBag = e.target.closest("[data-battle-open-bag]")
            const bagItem = e.target.closest("[data-battle-bag-item]")
            const bagBack = e.target.closest("[data-battle-bag-back]")
            const revivePick = e.target.closest("[data-battle-revive-pick]")
            const flee = e.target.closest("[data-battle-flee]")
            const close = e.target.closest("[data-battle-close]")
            if (!sel && !atk && !openBag && !bagItem && !bagBack && !revivePick && !flee && !close) return
            e.preventDefault()
            e.stopPropagation()
            if (sel) doAction("select_pokemon", { card_id: sel.dataset.battleSelect })
            if (atk) doAction("attack", { spell_name: atk.dataset.battleAttack })
            if (openBag) {
                bagMenuOpen = true
                revivePickOptions = null
                if (statusCache?.battle) renderArena(statusCache.battle)
            }
            if (bagItem) doAction("bag", {})
            if (bagBack) {
                if (revivePickOptions?.length) {
                    revivePickOptions = null
                    bagMenuOpen = true
                } else {
                    bagMenuOpen = false
                    revivePickOptions = null
                }
                if (statusCache?.battle) renderArena(statusCache.battle)
            }
            if (revivePick) doAction("bag", { item: "revive", revive_card_id: revivePick.dataset.battleRevivePick })
            if (flee) doAction("flee", {})
            if (close) {
                closeArena()
                openBattleLobby()
            }
        }, true)
    }

    function init(deps) {
        apiAuthBody = deps.apiAuthBody || apiAuthBody
        showToast = deps.showToast || showToast
        getVault = deps.getVault || getVault
        getBalance = deps.getBalance || getBalance
        onBalanceUpdate = deps.onBalanceUpdate || onBalanceUpdate
        setLedState = deps.setLedState || setLedState
        setView = deps.setView || setView
        refreshSummary = deps.refreshSummary || refreshSummary
        bindEvents()
        refreshStatus(true)
    }

    window.PoketabBattle = {
        init,
        handleRealtime,
        refreshStatus,
        openBattleLobby,
        onSummaryUpdate,
        closeArena,
        startAlertPoll,
        stopAlertPoll,
        resumeBattleView,
        isFlowLocked,
        getStatusCache: () => statusCache,
    }
})()
