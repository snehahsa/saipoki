(function () {
    const trainers = [
        { skin: "009", el: "trainer-a" },
        { skin: "024", el: "trainer-b" },
        { skin: "051", el: "trainer-c" },
    ]

    const pool = Array.isArray(window.LANDING_POOL) ? window.LANDING_POOL : []
    const bootCfg = window.LANDING_BOOT || {}

    let landingMusicEnabled = true
    const LANDING_FADE_IN_SEC = 3
    const BOOT_MAX_MS = 9000
    const ASSET_TIMEOUT_MS = 4000

    function withTimeout(promise, ms, fallback = null) {
        return Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
        ])
    }

    function landingAudioElement() {
        return document.getElementById("landing-audio-unlock")
    }

    function syncLandingAudioToggle(on) {
        const btn = document.getElementById("landing-audio-toggle")
        if (!btn) return
        const active = !!on
        btn.classList.toggle("is-on", active)
        btn.setAttribute("aria-pressed", active ? "true" : "false")
        btn.setAttribute("aria-label", active ? "Turn music off" : "Turn music on")
        const icon = btn.querySelector(".landing-audio-toggle__icon")
        if (icon) icon.textContent = active ? "🔊" : "🔇"
    }

    async function startLandingMusic() {
        if (!landingMusicEnabled || !window.RetroAudio) return false
        const ok = await window.RetroAudio.startWithMediaUnlock(
            "menu",
            landingAudioElement(),
            { fadeIn: LANDING_FADE_IN_SEC }
        )
        syncLandingAudioToggle(landingMusicEnabled)
        return ok
    }

    function initAudioToggle() {
        const btn = document.getElementById("landing-audio-toggle")
        if (!btn || !window.RetroAudio) return

        syncLandingAudioToggle(true)

        btn.addEventListener("click", async (e) => {
            e.stopPropagation()
            if (landingMusicEnabled) {
                landingMusicEnabled = false
                window.RetroAudio.setMuted(true)
                syncLandingAudioToggle(false)
                return
            }
            landingMusicEnabled = true
            syncLandingAudioToggle(true)
            await startLandingMusic()
        })
    }

    function preloadImage(url) {
        if (!url) return Promise.resolve(null)
        return withTimeout(
            new Promise((resolve) => {
                const img = new Image()
                img.onload = () => resolve(img)
                img.onerror = () => resolve(null)
                img.src = url
            }),
            ASSET_TIMEOUT_MS,
            null
        )
    }

    async function preloadFont() {
        if (!document.fonts?.load) return
        await withTimeout(document.fonts.load("10px silkscreen"), 2000).catch(() => null)
    }

    function applyTrainerSprites() {
        trainers.forEach(({ skin, el }) => {
            const node = document.getElementById(el)
            if (!node) return
            node.style.backgroundImage = `url(/sprites/characters/Character_${skin}.png)`
        })
    }

    function setLoadProgress(pct) {
        const bar = document.getElementById("landing-load-bar")
        if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`
    }

    async function preloadLandingAssets() {
        const steps = []

        steps.push({ pct: 8, run: () => preloadFont() })
        steps.push({
            pct: 18,
            run: () => preloadImage(bootCfg.titles || "/static/imgs/titles.png"),
        })

        trainers.forEach((t, i) => {
            steps.push({
                pct: 22 + i * 8,
                run: () => preloadImage(`/sprites/characters/Character_${t.skin}.png`),
            })
        })

        if (bootCfg.gif) {
            steps.push({ pct: 48, run: () => preloadImage(bootCfg.gif) })
        }

        const cardUrls = pool.map((c) => c.src).filter(Boolean)
        const bootCards = cardUrls.slice(0, 6)
        if (bootCards.length) {
            steps.push({
                pct: 70,
                run: () => Promise.all(bootCards.map((url) => preloadImage(url))),
            })
        }

        for (const step of steps) {
            setLoadProgress(step.pct)
            await step.run()
        }

        setLoadProgress(100)
    }

    function preloadRemainingCards() {
        const cardUrls = pool.map((c) => c.src).filter(Boolean).slice(6)
        if (!cardUrls.length) return
        void Promise.allSettled(cardUrls.map((url) => preloadImage(url)))
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function revealLanding() {
        const splash = document.getElementById("landing-load-screen")
        const app = document.getElementById("landing-app")
        document.body.classList.remove("landing-is-loading")

        if (splash) splash.classList.add("is-hidden")
        if (app) {
            app.classList.remove("hidden")
            app.removeAttribute("aria-hidden")
        }

        setTimeout(() => splash?.remove(), 400)
    }

    function finishBoot() {
        applyTrainerSprites()
        initStatsTabs()
        startLivePoll()
        initCards()
        initAudioToggle()
        preloadRemainingCards()
    }

    async function bootLanding() {
        const bootDone = preloadLandingAssets().catch(() => null)
        const bootCap = delay(BOOT_MAX_MS)

        await Promise.race([bootDone, bootCap])
        setLoadProgress(100)
        await delay(200)
        revealLanding()
        finishBoot()

        for (let i = 0; i < 6; i += 1) {
            if (await startLandingMusic()) break
            await delay(250)
        }
    }

    function formatNum(value) {
        const n = Number(value) || 0
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
        if (n >= 10_000) return `${Math.round(n / 1000)}K`
        if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`
        return n.toLocaleString()
    }

    function escapeText(text) {
        const el = document.createElement("span")
        el.textContent = text ?? ""
        return el.innerHTML
    }

    let lbData = null
    let lbActive = 0
    let pollTimer = null
    let statsTab = "revenue"

    function switchStatsTab(tab) {
        statsTab = tab
        const revBtn = document.getElementById("stats-tab-revenue")
        const lbBtn = document.getElementById("stats-tab-leaderboard")
        const revPanel = document.getElementById("stats-panel-revenue")
        const lbPanel = document.getElementById("stats-panel-leaderboard")

        const isRevenue = tab === "revenue"
        revBtn?.classList.toggle("active", isRevenue)
        lbBtn?.classList.toggle("active", !isRevenue)
        revBtn?.setAttribute("aria-selected", isRevenue ? "true" : "false")
        lbBtn?.setAttribute("aria-selected", !isRevenue ? "true" : "false")

        if (revPanel) {
            revPanel.classList.toggle("hidden", !isRevenue)
            revPanel.hidden = !isRevenue
        }
        if (lbPanel) {
            lbPanel.classList.toggle("hidden", isRevenue)
            lbPanel.hidden = isRevenue
        }
    }

    function setPulse(id, value) {
        const el = document.getElementById(id)
        if (el) el.textContent = value
    }

    function renderRevenueShare(data) {
        setPulse("rev-pool", formatNum(data?.reward_pool))
        setPulse("rev-distributed", formatNum(data?.distributed))
        setPulse("rev-holders", formatNum(data?.eligible_holders))

        const body = document.getElementById("rev-table-body")
        if (!body) return

        const entries = data?.entries || []
        if (!entries.length) {
            body.innerHTML = `
                <tr class="landing-rev-table-empty">
                    <td colspan="4">Table coming soon — live payouts will appear here.</td>
                </tr>`
            return
        }

        body.replaceChildren()
        entries.forEach((row, i) => {
            const tr = document.createElement("tr")
            tr.innerHTML = `
                <td>${i + 1}</td>
                <td>${escapeText(row.trainer || row.display_name || "—")}</td>
                <td>${escapeText(String(row.points ?? "—"))}</td>
                <td>${escapeText(row.share || "—")}</td>`
            body.appendChild(tr)
        })
    }

    function initStatsTabs() {
        document.querySelectorAll("[data-stats-tab]").forEach((btn) => {
            btn.addEventListener("click", () => switchStatsTab(btn.dataset.statsTab))
        })
    }

    function renderPulse(global, online) {
        setPulse("pulse-trainers", formatNum(global?.trainers))
        setPulse("pulse-online", formatNum(online))
        setPulse("pulse-battles", formatNum(global?.battles_fought))
        setPulse("pulse-wagered", formatNum(global?.tokens_wagered))
        setPulse("pulse-cards", formatNum(global?.cards_in_vaults))
        setPulse("pulse-wins", formatNum(global?.total_wins))
    }

    function renderLbPodium(category) {
        const podium = document.getElementById("landing-lb-podium")
        if (!podium) return
        podium.replaceChildren()

        const entries = category?.entries || []
        if (!entries.length) {
            podium.className = "landing-lb-podium landing-lb-podium--empty"
            podium.textContent = "No rankings yet — battle or collect to appear here."
            return
        }

        podium.className = "landing-lb-podium"
        const order = [entries[1], entries[0], entries[2]].filter(Boolean)
        for (const entry of order) {
            const slot = document.createElement("div")
            slot.className = `landing-lb-slot rank-${entry.rank}`
            slot.innerHTML = `
                <div class="landing-lb-rank">#${entry.rank}</div>
                <div class="landing-lb-name" title="${escapeText(entry.display_name)}">${escapeText(entry.display_name)}</div>
                <div class="landing-lb-val">${escapeText(entry.value_display)}</div>`
            podium.appendChild(slot)
        }
    }

    function renderLbList(category) {
        const list = document.getElementById("landing-lb-list")
        if (!list) return
        list.replaceChildren()

        const rest = (category?.entries || []).slice(3)
        for (const entry of rest) {
            const li = document.createElement("li")
            li.className = "landing-lb-row"
            li.innerHTML = `
                <span>#${entry.rank}</span>
                <span title="${escapeText(entry.display_name)}">${escapeText(entry.display_name)}</span>
                <span>${escapeText(entry.value_display)}</span>`
            list.appendChild(li)
        }
    }

    function renderLbCategory(index) {
        if (!lbData?.categories?.length) return
        lbActive = index
        const category = lbData.categories[index]

        document.querySelectorAll(".landing-lb-tab").forEach((btn, i) => {
            btn.classList.toggle("active", i === index)
            btn.setAttribute("aria-selected", i === index ? "true" : "false")
        })

        const head = document.getElementById("landing-lb-head")
        if (head) {
            head.innerHTML = `
                <div class="landing-lb-cat-title">${escapeText(category.emoji)} ${escapeText(category.title)}</div>
                <div class="landing-lb-cat-tag">${escapeText(category.tagline)}</div>`
        }

        renderLbPodium(category)
        renderLbList(category)
    }

    function renderLbTabs() {
        const tabs = document.getElementById("landing-lb-tabs")
        if (!tabs || !lbData?.categories) return
        tabs.replaceChildren()

        lbData.categories.forEach((cat, index) => {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.className = `landing-lb-tab${index === lbActive ? " active" : ""}`
            btn.setAttribute("role", "tab")
            btn.setAttribute("aria-selected", index === lbActive ? "true" : "false")
            btn.textContent = cat.title
            btn.addEventListener("click", () => renderLbCategory(index))
            tabs.appendChild(btn)
        })
    }

    function renderLeaderboard(data) {
        lbData = data
        renderLbTabs()
        renderLbCategory(lbActive)
    }

    async function fetchLiveStats() {
        let online = 0
        try {
            const health = await fetch("/health")
            const h = await health.json()
            online = h.players ?? 0
        } catch {
            online = 0
        }

        try {
            const [lbRes, revRes] = await Promise.all([
                fetch("/api/leaderboard"),
                fetch("/api/revenue-share"),
            ])
            const lbJson = await lbRes.json()
            const revJson = await revRes.json()

            if (lbRes.ok && lbJson.success) {
                renderPulse(lbJson.global, online)
                renderLeaderboard(lbJson)
            }
            if (revRes.ok && revJson.success) {
                renderRevenueShare(revJson)
            }
        } catch {
            /* keep last values */
        }
    }

    function startLivePoll() {
        fetchLiveStats()
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = setInterval(fetchLiveStats, 8000)
    }

    let cardIndex = 0
    let cardTimer = null
    let stripDragMoved = false
    let stripUserActive = false
    let stripIdleTimer = null
    const CARD_AUTO_MS = 6500
    const CARD_IDLE_RESUME_MS = 8000
    const STRIP_PIXEL_CHUNK = 6
    const STRIP_PIXEL_TICK_MS = 58

    function updateThumbSelection() {
        document.querySelectorAll(".landing-card-thumb-btn").forEach((btn) => {
            const idx = Number(btn.dataset.index)
            btn.classList.toggle("is-selected", idx === cardIndex)
            btn.setAttribute("aria-pressed", idx === cardIndex ? "true" : "false")
        })
    }

    function getStripStep() {
        const btn = document.querySelector(".landing-card-thumb-btn")
        return btn ? btn.offsetWidth + 10 : 66
    }

    function clearPixelScrollAnim() {
        const strip = document.getElementById("card-strip")
        if (strip?._pixelScrollTimer) {
            clearInterval(strip._pixelScrollTimer)
            strip._pixelScrollTimer = null
        }
    }

    function pixelScrollStripTo(targetLeft) {
        const strip = document.getElementById("card-strip")
        if (!strip || stripUserActive) return

        clearPixelScrollAnim()
        const max = Math.max(0, strip.scrollWidth - strip.clientWidth)
        const target = Math.max(0, Math.min(targetLeft, max))

        strip._pixelScrollTimer = setInterval(() => {
            const cur = strip.scrollLeft
            const diff = target - cur
            if (Math.abs(diff) <= STRIP_PIXEL_CHUNK) {
                strip.scrollLeft = target
                clearPixelScrollAnim()
                return
            }
            strip.scrollLeft = cur + (diff > 0 ? STRIP_PIXEL_CHUNK : -STRIP_PIXEL_CHUNK)
        }, STRIP_PIXEL_TICK_MS)
    }

    function scrollStripToCardPixel(index) {
        const strip = document.getElementById("card-strip")
        const btn = document.querySelector(`.landing-card-thumb-btn[data-index="${index}"]`)
        if (!strip || !btn || stripUserActive) return

        const btnCenter = btn.offsetLeft + btn.offsetWidth / 2
        const target = btnCenter - strip.clientWidth / 2
        pixelScrollStripTo(target)
    }

    function scrollStripToNextCard() {
        const strip = document.getElementById("card-strip")
        if (!strip || stripUserActive) return

        const loopWidth = strip.scrollWidth / 2
        let remaining = getStripStep()

        clearPixelScrollAnim()
        strip._pixelScrollTimer = setInterval(() => {
            if (remaining <= 0) {
                clearPixelScrollAnim()
                return
            }
            const chunk = Math.min(STRIP_PIXEL_CHUNK, remaining)
            strip.scrollLeft += chunk
            remaining -= chunk
            if (loopWidth > 0 && strip.scrollLeft >= loopWidth) {
                strip.scrollLeft -= loopWidth
            }
        }, STRIP_PIXEL_TICK_MS)
    }

    function stopCardAuto() {
        if (cardTimer) {
            clearInterval(cardTimer)
            cardTimer = null
        }
        clearPixelScrollAnim()
    }

    function pauseStripAuto() {
        stripUserActive = true
        stopCardAuto()
        if (stripIdleTimer) clearTimeout(stripIdleTimer)
        stripIdleTimer = setTimeout(() => {
            stripUserActive = false
            startCardAuto()
        }, CARD_IDLE_RESUME_MS)
    }

    function startCardAuto() {
        stopCardAuto()
        if (pool.length <= 1 || stripUserActive) return
        cardTimer = setInterval(() => {
            if (stripUserActive) return
            showCard(cardIndex + 1, { userPick: false, advanceStrip: true })
        }, CARD_AUTO_MS)
    }

    function showCard(index, { userPick = false, advanceStrip = false } = {}) {
        if (!pool.length) return
        cardIndex = ((index % pool.length) + pool.length) % pool.length
        const card = pool[cardIndex]
        const img = document.getElementById("card-show-img")
        const name = document.getElementById("card-show-name")

        if (img) {
            img.classList.add("is-fading")
            setTimeout(() => {
                img.src = card.src
                img.alt = card.name
                img.classList.remove("is-fading")
            }, 120)
        }
        if (name) name.textContent = card.name

        updateThumbSelection()
        if (userPick) {
            scrollStripToCardPixel(cardIndex)
        } else if (advanceStrip) {
            scrollStripToNextCard()
        }
    }

    function appendStripThumb(track, card, index) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "landing-card-thumb-btn"
        btn.dataset.index = String(index)
        btn.setAttribute("aria-label", card.name)
        btn.setAttribute("aria-pressed", index === cardIndex ? "true" : "false")
        btn.innerHTML = `<img src="${escapeText(card.src)}" alt="" width="56" height="78" loading="lazy" draggable="false">`
        btn.addEventListener("click", () => {
            if (stripDragMoved) return
            pauseStripAuto()
            showCard(index, { userPick: true })
        })
        track.appendChild(btn)
    }

    function buildCardStrip() {
        const track = document.getElementById("card-strip-track")
        if (!track || !pool.length) return

        track.replaceChildren()
        pool.forEach((card, index) => appendStripThumb(track, card, index))
        pool.forEach((card, index) => appendStripThumb(track, card, index))
    }

    function initStripDrag() {
        const strip = document.getElementById("card-strip")
        if (!strip) return

        let active = false
        let startX = 0
        let startScroll = 0
        let moved = 0

        const onDown = (clientX) => {
            active = true
            moved = 0
            stripDragMoved = false
            pauseStripAuto()
            clearPixelScrollAnim()
            startX = clientX
            startScroll = strip.scrollLeft
            strip.classList.add("is-dragging")
        }

        const onMove = (clientX) => {
            if (!active) return
            const delta = clientX - startX
            moved = Math.max(moved, Math.abs(delta))
            if (moved > 6) stripDragMoved = true
            strip.scrollLeft = startScroll - delta
        }

        const normalizeStripLoop = () => {
            const loopWidth = strip.scrollWidth / 2
            if (loopWidth > 0 && strip.scrollLeft >= loopWidth) {
                strip.scrollLeft -= loopWidth
            }
        }

        const onUp = () => {
            if (!active) return
            active = false
            strip.classList.remove("is-dragging")
            normalizeStripLoop()
            if (stripDragMoved) {
                setTimeout(() => {
                    stripDragMoved = false
                }, 80)
            }
        }

        strip.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return
            e.preventDefault()
            onDown(e.clientX)
        })
        window.addEventListener("mousemove", (e) => {
            if (!active) return
            e.preventDefault()
            onMove(e.clientX)
        })
        window.addEventListener("mouseup", onUp)

        strip.addEventListener(
            "touchstart",
            () => pauseStripAuto(),
            { passive: true }
        )
    }

    function initCards() {
        if (!pool.length) {
            const name = document.getElementById("card-show-name")
            if (name) name.textContent = "Cards loading soon…"
            return
        }
        buildCardStrip()
        initStripDrag()
        showCard(0, { userPick: false })
        startCardAuto()
    }

    function initHeaderScroll() {
        const header = document.querySelector(".landing-header")
        if (!header) return
        let lastY = window.scrollY
        window.addEventListener(
            "scroll",
            () => {
                const y = window.scrollY
                header.style.opacity = y > lastY && y > 80 ? "0.92" : "1"
                lastY = y
            },
            { passive: true }
        )
    }

    bootLanding().then(() => initHeaderScroll())
})()
