/**
 * PokéTab — friends, requests, and direct messages (vending-machine CRT UI).
 */
(function () {
    const SKIN_SHEET = 192
    const SKIN_FRAME = { x: 48, y: 0, w: 48, h: 48 }
    const SCREEN_LABELS = {
        menu: "LINK DISPLAY",
        online: "ONLINE SCAN",
        requests: "REQUESTS",
        friends: "FRIENDS",
        messages: "MESSAGES",
        chat: "LIVE CHAT",
        battle: "BATTLE ARENA",
    }

    let apiAuthBody = () => ({})
    let showToast = () => {}
    let badgeTimer = null
    let chatPeerId = null
    let currentView = "menu"
    let bootTimer = null
    let summaryCache = {
        pending_requests: 0,
        friends_count: 0,
        unread_messages: 0,
        new_friends: 0,
        notification_count: 0,
        battle_alerts: 0,
    }
    let lastBattleAlerts = 0

    function totalNotifications() {
        const fromApi = Number(summaryCache.notification_count)
        if (fromApi > 0) return fromApi
        return (Number(summaryCache.pending_requests) || 0)
            + (Number(summaryCache.unread_messages) || 0)
            + (Number(summaryCache.new_friends) || 0)
            + (Number(summaryCache.battle_alerts) || 0)
    }

    function skinImage(skin) {
        return `/sprites/characters/Character_${skin || "009"}.png`
    }

    function skinThumbStyle(skin) {
        const zoom = 1.5
        const frame = SKIN_FRAME
        return [
            `background-image:url(${skinImage(skin)})`,
            `background-size:${SKIN_SHEET * zoom}px ${SKIN_SHEET * zoom}px`,
            `background-position:-${frame.x * zoom}px -${frame.y * zoom}px`,
            `width:${Math.round(frame.w * zoom)}px`,
            `height:${Math.round(frame.h * zoom)}px`,
        ].join(";")
    }

    function escapeHtml(value) {
        return String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    }

    function formatTime(ts) {
        if (!ts) return ""
        const d = new Date(ts * 1000)
        const now = new Date()
        const sameDay = d.toDateString() === now.toDateString()
        if (sameDay) {
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        }
        return d.toLocaleDateString([], { month: "short", day: "numeric" })
    }

    async function apiPost(path, extra = {}) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(apiAuthBody(extra)),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
            throw new Error(data.error || "Request failed")
        }
        return data
    }

    function modalEl() {
        return document.getElementById("poketab-modal")
    }

    function machineEl() {
        return document.getElementById("poketab-machine")
    }

    function setLedState(state) {
        const machine = machineEl()
        if (machine) machine.setAttribute("data-led-state", state)
    }

    function syncTabs(view) {
        const tabView = view === "chat" ? "messages" : view
        document.querySelectorAll(".poketab-tab").forEach((tab) => {
            tab.classList.toggle("active", tab.dataset.go === tabView)
        })
    }

    function setView(view) {
        currentView = view
        document.querySelectorAll("[data-poketab-view]").forEach((el) => {
            el.classList.toggle("active", el.dataset.poketabView === view)
        })
        const label = document.getElementById("poketab-screen-label")
        if (label) label.textContent = SCREEN_LABELS[view] || "CRT OUTPUT"
        syncTabs(view)
        if (view !== "chat" && machineEl()?.getAttribute("data-led-state") !== "boot") {
            setLedState("ready")
        }
    }

    function renderEmpty(listEl, message) {
        if (!listEl) return
        listEl.innerHTML = `<p class="poketab-empty">${escapeHtml(message)}</p>`
    }

    function renderUserRow(user, actionsHtml) {
        const online = user.online ? '<span class="poketab-online-dot" title="Online"></span>' : ""
        return `
            <div class="poketab-row">
                <div class="poketab-avatar" style="${skinThumbStyle(user.skin)}"></div>
                <div class="poketab-row-main">
                    <div class="poketab-row-name">${online}${escapeHtml(user.display_name)}</div>
                </div>
                <div class="poketab-row-actions">${actionsHtml}</div>
            </div>
        `
    }

    function setTabBadge(id, count) {
        const el = document.getElementById(id)
        if (!el) return
        const n = Number(count) || 0
        if (n > 0) {
            el.textContent = n > 9 ? "9+" : String(n)
            el.classList.remove("hidden")
        } else {
            el.classList.add("hidden")
        }
    }

    function updateMenuCounts() {
        const crtStatus = document.getElementById("poketab-crt-status")
        const crtReq = document.getElementById("poketab-crt-requests")
        const crtFriends = document.getElementById("poketab-crt-friends")
        const crtNewFriends = document.getElementById("poketab-crt-new-friends")
        const crtMsgs = document.getElementById("poketab-crt-messages")
        if (crtStatus) crtStatus.textContent = "> NETWORK: ONLINE"
        if (crtReq) crtReq.textContent = `> REQUESTS: ${summaryCache.pending_requests}`
        if (crtFriends) crtFriends.textContent = `> FRIENDS: ${summaryCache.friends_count}`
        if (crtNewFriends) {
            crtNewFriends.textContent = `> NEW FRIENDS: ${summaryCache.new_friends}`
            crtNewFriends.classList.toggle("poketab-crt-alert", summaryCache.new_friends > 0)
        }
        if (crtMsgs) {
            crtMsgs.textContent = `> UNREAD MSGS: ${summaryCache.unread_messages}`
            crtMsgs.classList.toggle("poketab-crt-alert", summaryCache.unread_messages > 0)
        }
        if (crtReq) crtReq.classList.toggle("poketab-crt-alert", summaryCache.pending_requests > 0)

        window.PoketabBattle?.onSummaryUpdate?.(summaryCache)

        setTabBadge("poketab-tab-requests-count", summaryCache.pending_requests)
        setTabBadge("poketab-tab-friends-count", summaryCache.new_friends)
        setTabBadge("poketab-tab-messages-count", summaryCache.unread_messages)

        document.querySelector(".poketab-tab-requests")?.classList.toggle(
            "poketab-tab-alert",
            summaryCache.pending_requests > 0,
        )
        document.querySelector(".poketab-tab-friends")?.classList.toggle(
            "poketab-tab-alert",
            summaryCache.new_friends > 0,
        )
        document.querySelector(".poketab-tab-messages")?.classList.toggle(
            "poketab-tab-alert",
            summaryCache.unread_messages > 0,
        )
    }

    function updateBadge() {
        const badge = document.getElementById("poketab-badge")
        const btn = document.getElementById("game-poketab-btn")
        if (!badge) return
        const count = totalNotifications()
        if (count > 0) {
            badge.textContent = count > 9 ? "9+" : String(count)
            badge.classList.remove("hidden")
            badge.setAttribute("aria-hidden", "false")
            const label = count === 1 ? "1 PokéTab notification" : `${count} PokéTab notifications`
            btn?.setAttribute("aria-label", `Open PokéTab (${label})`)
        } else {
            badge.classList.add("hidden")
            badge.setAttribute("aria-hidden", "true")
            btn?.setAttribute("aria-label", "Open PokéTab")
        }
    }

    async function refreshSummary() {
        try {
            const data = await apiPost("/api/poketab/summary")
            const battleAlerts = data.battle_alerts || 0
            if (battleAlerts > lastBattleAlerts) {
                showToast("⚔ Battle challenge on PokéTab!")
            }
            lastBattleAlerts = battleAlerts
            summaryCache = {
                pending_requests: data.pending_requests || 0,
                friends_count: data.friends_count || 0,
                unread_messages: data.unread_messages || 0,
                new_friends: data.new_friends || 0,
                notification_count: data.notification_count || 0,
                battle_alerts: battleAlerts,
            }
            updateMenuCounts()
            updateBadge()
        } catch {
            const crtStatus = document.getElementById("poketab-crt-status")
            if (crtStatus) crtStatus.textContent = "> NETWORK: OFFLINE"
        }
    }

    async function loadOnline() {
        const list = document.getElementById("poketab-online-list")
        setLedState("busy")
        renderEmpty(list, "SCANNING TRAINERS...")
        try {
            const data = await apiPost("/api/poketab/online")
            const players = data.players || []
            if (!players.length) {
                renderEmpty(list, "NO OTHER TRAINERS ONLINE.")
                setLedState("ready")
                return
            }
            list.innerHTML = players.map((player) => {
                let action = ""
                if (player.relation === "friend") {
                    action = `<span class="poketab-pill poketab-pill-friend">FRIENDS</span>`
                } else if (player.relation === "request_sent") {
                    action = `<span class="poketab-pill">PENDING</span>`
                } else if (player.relation === "request_received") {
                    action = `<span class="poketab-pill">CHECK REQ</span>`
                } else {
                    action = `<button type="button" class="poketab-action-btn poketab-action-add" data-add-friend="${escapeHtml(player.telegram_id)}">ADD</button>`
                }
                return renderUserRow(player, action)
            }).join("")
            setLedState("ok")
            window.setTimeout(() => setLedState("ready"), 500)
        } catch (err) {
            renderEmpty(list, err.message.toUpperCase())
            setLedState("error")
        }
    }

    async function loadRequests() {
        const list = document.getElementById("poketab-requests-list")
        setLedState("busy")
        renderEmpty(list, "LOADING REQUESTS...")
        try {
            const data = await apiPost("/api/poketab/friend-requests")
            const requests = data.requests || []
            if (!requests.length) {
                renderEmpty(list, "NO PENDING REQUESTS.")
                setLedState("ready")
                return
            }
            list.innerHTML = requests.map((req) => {
                const user = req.from
                return renderUserRow(user, `
                    <button type="button" class="poketab-action-btn poketab-action-accept" data-accept-request="${req.id}">YES</button>
                    <button type="button" class="poketab-action-btn poketab-action-decline" data-decline-request="${req.id}">NO</button>
                `)
            }).join("")
            setLedState("ok")
            window.setTimeout(() => setLedState("ready"), 500)
        } catch (err) {
            renderEmpty(list, err.message.toUpperCase())
            setLedState("error")
        }
    }

    async function loadFriends() {
        const list = document.getElementById("poketab-friends-list")
        setLedState("busy")
        renderEmpty(list, "LOADING ROSTER...")
        try {
            const data = await apiPost("/api/poketab/friends")
            const friends = data.friends || []
            if (!friends.length) {
                renderEmpty(list, "NO FRIENDS YET — FIND TRAINERS ONLINE.")
            } else {
                list.innerHTML = friends.map((friend) => renderUserRow(friend, `
                    <button type="button" class="poketab-action-btn poketab-action-send" data-open-chat="${escapeHtml(friend.telegram_id)}">MSG</button>
                `)).join("")
            }
            setLedState("ready")
            await refreshSummary()
        } catch (err) {
            renderEmpty(list, err.message.toUpperCase())
            setLedState("error")
        }
    }

    async function loadConversations() {
        const list = document.getElementById("poketab-conversations-list")
        setLedState("busy")
        renderEmpty(list, "LOADING MESSAGES...")
        try {
            const data = await apiPost("/api/poketab/messages/conversations")
            const conversations = data.conversations || []
            if (!conversations.length) {
                renderEmpty(list, "NO MESSAGES YET.")
                setLedState("ready")
                return
            }
            list.innerHTML = conversations.map((conv) => {
                const peer = conv.peer
                const unread = conv.unread > 0 ? `<span class="poketab-unread">${conv.unread}</span>` : ""
                const preview = escapeHtml(conv.last_message || "")
                return `
                    <button type="button" class="poketab-conv-row" data-open-chat="${escapeHtml(peer.telegram_id)}">
                        <div class="poketab-avatar" style="${skinThumbStyle(peer.skin)}"></div>
                        <div class="poketab-conv-main">
                            <div class="poketab-conv-top">
                                <span class="poketab-row-name">${escapeHtml(peer.display_name)}</span>
                                <span class="poketab-conv-time">${formatTime(conv.last_at)}</span>
                            </div>
                            <div class="poketab-conv-preview">${conv.last_from_self ? "YOU: " : ""}${preview}</div>
                        </div>
                        ${unread}
                    </button>
                `
            }).join("")
            setLedState("ok")
            window.setTimeout(() => setLedState("ready"), 500)
        } catch (err) {
            renderEmpty(list, err.message.toUpperCase())
            setLedState("error")
        }
    }

    function renderChatMessages(messages) {
        const thread = document.getElementById("poketab-chat-thread")
        if (!thread) return
        if (!messages.length) {
            thread.innerHTML = `<p class="poketab-empty">Say hello — friends only.</p>`
            return
        }
        thread.innerHTML = messages.map((msg) => `
            <div class="poketab-bubble ${msg.mine ? "mine" : "theirs"}">
                <p>${escapeHtml(msg.body)}</p>
                <time>${formatTime(msg.created_at)}</time>
            </div>
        `).join("")
        thread.scrollTop = thread.scrollHeight
    }

    async function openChat(peerId) {
        chatPeerId = peerId
        setView("chat")
        setLedState("busy")
        const peerEl = document.getElementById("poketab-chat-peer")
        const thread = document.getElementById("poketab-chat-thread")
        if (peerEl) peerEl.innerHTML = ""
        if (thread) renderEmpty(thread, "OPENING CHANNEL...")
        try {
            const data = await apiPost("/api/poketab/messages/thread", { peer_id: peerId })
            const peer = data.peer
            if (peerEl && peer) {
                peerEl.innerHTML = `
                    <div class="poketab-avatar" style="${skinThumbStyle(peer.skin)}"></div>
                    <span class="poketab-row-name">${escapeHtml(peer.display_name)}</span>
                `
            }
            renderChatMessages(data.messages || [])
            setLedState("ready")
            await refreshSummary()
            document.getElementById("poketab-chat-input")?.focus()
        } catch (err) {
            if (thread) renderEmpty(thread, err.message.toUpperCase())
            setLedState("error")
        }
    }

    async function sendChatMessage(body) {
        if (!chatPeerId) return
        const input = document.getElementById("poketab-chat-input")
        try {
            const data = await apiPost("/api/poketab/messages/send", {
                peer_id: chatPeerId,
                body,
            })
            if (data.message) {
                const thread = document.getElementById("poketab-chat-thread")
                const empty = thread?.querySelector(".poketab-empty")
                if (empty) empty.remove()
                const bubble = document.createElement("div")
                bubble.className = "poketab-bubble mine"
                bubble.innerHTML = `<p>${escapeHtml(data.message.body)}</p><time>${formatTime(data.message.created_at)}</time>`
                thread?.appendChild(bubble)
                thread.scrollTop = thread?.scrollHeight || 0
            }
            if (input) input.value = ""
        } catch (err) {
            showToast(err.message, true)
            setLedState("error")
            window.setTimeout(() => setLedState("ready"), 800)
        }
    }

    function playBootSequence() {
        const crtStatus = document.getElementById("poketab-crt-status")
        if (bootTimer) clearTimeout(bootTimer)
        setLedState("boot")
        if (crtStatus) crtStatus.textContent = "> LINKING..."
        bootTimer = window.setTimeout(() => {
            if (crtStatus) crtStatus.textContent = "> NETWORK: ONLINE"
            setLedState("ready")
            bootTimer = null
        }, 650)
    }

    async function goToView(view) {
        if (view === "chat") return
        setView(view)
        if (view === "online") await loadOnline()
        else if (view === "requests") await loadRequests()
        else if (view === "friends") await loadFriends()
        else if (view === "messages") await loadConversations()
        else if (view === "menu") await refreshSummary()
        else if (view === "battle") window.PoketabBattle?.openBattleLobby?.()
    }

    function open() {
        const modal = modalEl()
        if (!modal) return
        modal.classList.remove("hidden")
        modal.setAttribute("aria-hidden", "false")
        document.body.classList.add("poketab-open")
        const btn = document.getElementById("game-poketab-btn")
        btn?.setAttribute("aria-expanded", "true")
        chatPeerId = null
        playBootSequence()
        window.PoketabBattle?.startAlertPoll?.()
        if (!window.PoketabBattle?.resumeBattleView?.()) {
            goToView("menu")
        }
    }

    function close() {
        if (window.PoketabBattle?.isFlowLocked?.()) {
            showToast("Finish or flee the battle before closing PokéTab.", true)
            return
        }
        const modal = modalEl()
        if (!modal) return
        modal.classList.add("hidden")
        modal.setAttribute("aria-hidden", "true")
        document.body.classList.remove("poketab-open")
        const btn = document.getElementById("game-poketab-btn")
        btn?.setAttribute("aria-expanded", "false")
        chatPeerId = null
        window.PoketabBattle?.stopAlertPoll?.()
        window.PoketabBattle?.closeArena?.()
        if (bootTimer) {
            clearTimeout(bootTimer)
            bootTimer = null
        }
        setView("menu")
    }

    function handleRealtime(payload) {
        if (!payload?.event) return
        window.PoketabBattle?.handleRealtime?.(payload)
        const modalClosed = !modalEl() || modalEl().classList.contains("hidden")
        refreshSummary().then(() => {
            if (!modalClosed) return
            if (payload.event === "friend_request") showToast("New friend request on PokéTab!")
            else if (payload.event === "friend_accepted") showToast("Friend request accepted!")
            else if (payload.event === "message") showToast("New PokéTab message!")
            else if (payload.event === "battle_invite") showToast("Battle challenge on PokéTab!")
        })
        if (modalClosed) return
        if (payload.event === "friend_request" && currentView === "requests") loadRequests()
        if (payload.event === "friend_accepted" && currentView === "friends") loadFriends()
        if (payload.event === "message") {
            if (currentView === "messages") loadConversations()
            if (currentView === "chat" && chatPeerId && payload.data?.from_id === chatPeerId) {
                openChat(chatPeerId)
            }
        }
    }

    function startBadgePolling() {
        stopBadgePolling()
        refreshSummary()
        badgeTimer = window.setInterval(refreshSummary, 8000)
    }

    function stopBadgePolling() {
        if (badgeTimer) {
            clearInterval(badgeTimer)
            badgeTimer = null
        }
    }

    function bindEvents() {
        document.getElementById("poketab-close")?.addEventListener("click", close)
        document.getElementById("poketab-scrim")?.addEventListener("click", close)

        document.querySelectorAll("[data-go]").forEach((btn) => {
            btn.addEventListener("click", () => {
                if (currentView === "chat" && btn.dataset.go === "messages") {
                    chatPeerId = null
                    goToView("messages")
                    return
                }
                goToView(btn.dataset.go)
            })
        })

        document.getElementById("poketab-online-list")?.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-add-friend]")
            if (!btn) return
            setLedState("busy")
            try {
                await apiPost("/api/poketab/friend-request/send", { target_id: btn.dataset.addFriend })
                showToast("Friend request sent!")
                loadOnline()
                refreshSummary()
            } catch (err) {
                showToast(err.message, true)
                setLedState("error")
            }
        })

        document.getElementById("poketab-requests-list")?.addEventListener("click", async (e) => {
            const accept = e.target.closest("[data-accept-request]")
            const decline = e.target.closest("[data-decline-request]")
            const id = accept?.dataset.acceptRequest || decline?.dataset.declineRequest
            if (!id) return
            setLedState("busy")
            try {
                await apiPost("/api/poketab/friend-request/respond", {
                    request_id: Number(id),
                    action: accept ? "accept" : "decline",
                })
                showToast(accept ? "Friend added!" : "Request declined")
                loadRequests()
                refreshSummary()
            } catch (err) {
                showToast(err.message, true)
                setLedState("error")
            }
        })

        document.getElementById("poketab-friends-list")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-open-chat]")
            if (!btn) return
            openChat(btn.dataset.openChat)
        })

        document.getElementById("poketab-conversations-list")?.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-open-chat]")
            if (!btn) return
            openChat(btn.dataset.openChat)
        })

        document.getElementById("poketab-chat-form")?.addEventListener("submit", (e) => {
            e.preventDefault()
            const input = document.getElementById("poketab-chat-input")
            const text = input?.value?.trim()
            if (!text) return
            sendChatMessage(text)
        })
    }

    function init(deps) {
        apiAuthBody = deps.apiAuthBody || apiAuthBody
        showToast = deps.showToast || showToast
        bindEvents()
        window.PoketabBattle?.init?.({
            apiAuthBody,
            showToast,
            getVault: deps.getVault,
            getBalance: deps.getBalance,
            onBalanceUpdate: deps.onBalanceUpdate,
            setLedState,
            setView,
            refreshSummary,
        })
    }

    window.PoketabSocial = {
        init,
        open,
        close,
        refreshSummary,
        startBadgePolling,
        stopBadgePolling,
        handleRealtime,
    }
})()
