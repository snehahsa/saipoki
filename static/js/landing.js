(function () {
    const trainers = [
        { skin: "016", el: "trainer-a" },
        { skin: "049", el: "trainer-b" },
        { skin: "024", el: "trainer-c" },
    ]

    const pool = Array.isArray(window.LANDING_POOL) ? window.LANDING_POOL : []
    const bootCfg = window.LANDING_BOOT || {}

    const BOOT_MAX_MS = 9000
    const ASSET_TIMEOUT_MS = 4000

    const SKIN_IDS = Array.from({ length: 83 }, (_, i) => String(i + 1).padStart(3, "0"))
    const DEFAULT_SKIN = "009"
    const SKIN_SHEET = 192
    const SKIN_FRAME = { x: 48, y: 0, w: 48, h: 48 }

    function skinPriceTier(price) {
        const value = Math.max(0, Number(price) || 0)
        if (value >= 5000) return "gold"
        if (value >= 3000) return "bronze"
        if (value >= 1500) return "silver"
        return "green"
    }

    function defaultSkinPrice(skin) {
        if (skin === DEFAULT_SKIN) return 0
        const n = parseInt(skin, 10)
        if (Number.isNaN(n)) return 100
        if (n <= 5) return 0
        if (n <= 20) return 40
        if (n <= 40) return 80
        if (n <= 60) return 150
        return 250
    }

    function skinThumbStyle(skin) {
        const zoom = 1.5
        const url = `/sprites/characters/Character_${skin}.png`
        return [
            `background-image:url(${url})`,
            `background-size:${SKIN_SHEET * zoom}px ${SKIN_SHEET * zoom}px`,
            `background-position:-${SKIN_FRAME.x * zoom}px -${SKIN_FRAME.y * zoom}px`,
            `width:${SKIN_FRAME.w * zoom}px`,
            `height:${SKIN_FRAME.h * zoom}px`,
        ].join(";")
    }

    function buildExclusiveSkinEntry(skin, price) {
        const safePrice = Math.max(0, Number(price) || 0)
        return {
            skin,
            price: safePrice,
            tier: skinPriceTier(safePrice),
            thumb_style: skinThumbStyle(skin),
            sprite_url: `/sprites/characters/Character_${skin}.png`,
        }
    }

    function topExclusiveSkinsFromCosts(avatarCosts) {
        const costs = avatarCosts && typeof avatarCosts === "object" ? avatarCosts : {}
        const ranked = SKIN_IDS
            .filter((skin) => skin !== DEFAULT_SKIN)
            .map((skin) => {
                const raw = costs[skin]
                const price = raw == null ? defaultSkinPrice(skin) : Math.max(0, parseInt(raw, 10) || 0)
                return buildExclusiveSkinEntry(skin, price)
            })
            .sort((a, b) => b.price - a.price || b.skin.localeCompare(a.skin, undefined, { numeric: true }))
        return ranked.slice(0, 3)
    }

    function formatSkinPrice(price) {
        return `${Math.max(0, Number(price) || 0).toLocaleString()} Chips`
    }

    function renderExclusiveSkinCard(skin) {
        return `
            <li class="profile-skin-item profile-skin-item--tier-${escapeText(skin.tier)} landing-skin-pick" role="listitem" aria-label="Skin ${escapeText(skin.skin)}, ${escapeText(formatSkinPrice(skin.price))}">
                <span class="profile-skin-thumb" style="${skin.thumb_style || skinThumbStyle(skin.skin)}" aria-hidden="true"></span>
                <span class="profile-skin-id">${escapeText(skin.skin)}</span>
                <span class="profile-skin-cost">${escapeText(formatSkinPrice(skin.price))}</span>
            </li>
        `
    }

    async function resolveExclusiveSkins() {
        const embedded = Array.isArray(window.LANDING_EXCLUSIVE_SKINS) ? window.LANDING_EXCLUSIVE_SKINS : []
        if (embedded.length >= 3) return embedded.slice(0, 3)

        try {
            const res = await fetch("/api/world", { cache: "no-store" })
            if (!res.ok) return embedded
            const map = await res.json()
            const fromMap = topExclusiveSkinsFromCosts(map.avatarCosts)
            return fromMap.length ? fromMap : embedded
        } catch (_) {
            return embedded
        }
    }

    async function renderExclusiveSkins() {
        const showcase = document.getElementById("landing-skin-showcase")
        if (!showcase) return

        const skins = await resolveExclusiveSkins()
        if (!skins.length) return

        showcase.innerHTML = skins
            .map((skin) => renderExclusiveSkinCard(skin))
            .join("")
    }

    function withTimeout(promise, ms, fallback = null) {
        return Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
        ])
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

        const heroMedia = bootCfg.heroMedia || bootCfg.gif || (
            Array.isArray(bootCfg.gifs) ? bootCfg.gifs.find(Boolean) : null
        )
        if (heroMedia) {
            steps.push({ pct: 48, run: () => preloadImage(heroMedia) })
        }

        const skinUrls = (Array.isArray(window.LANDING_EXCLUSIVE_SKINS)
            ? window.LANDING_EXCLUSIVE_SKINS
            : Array.isArray(bootCfg.exclusiveSkins)
                ? bootCfg.exclusiveSkins.map((url) => ({ sprite_url: url }))
                : []
        ).map((s) => s.sprite_url).filter(Boolean)
        if (skinUrls.length) {
            steps.push({
                pct: 58,
                run: () => Promise.all(skinUrls.map((url) => preloadImage(url))),
            })
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
        preloadRemainingCards()
        void renderExclusiveSkins()
        initIntroTyping()
    }

    function initIntroTyping() {
        const dialog = document.getElementById("landing-intro-dialog")
        const textEl = document.getElementById("landing-intro-type-text")
        const cursor = document.getElementById("landing-intro-cursor")
        const linesEl = document.getElementById("landing-intro-lines")
        if (!dialog || !textEl || !linesEl) return

        let lines = []
        try {
            lines = JSON.parse(linesEl.textContent || "[]")
        } catch (_) {
            return
        }
        if (!Array.isArray(lines) || !lines.length) return

        const fullText = lines.join("\n\n")
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            textEl.textContent = fullText
            cursor?.classList.remove("hidden")
            return
        }

        const CHAR_MS = 30
        const PUNCT_MS = 200
        const PARA_MS = 480
        let started = false

        async function typeIntro() {
            if (started) return
            started = true
            cursor?.classList.remove("hidden")
            textEl.textContent = ""

            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                if (lineIndex > 0) {
                    textEl.textContent += "\n\n"
                    await delay(PARA_MS)
                }
                const line = lines[lineIndex]
                for (let i = 0; i < line.length; i += 1) {
                    const ch = line[i]
                    textEl.textContent += ch
                    const pause = (ch === "." || ch === "!" || ch === "?" || ch === "—")
                        ? PUNCT_MS
                        : CHAR_MS
                    await delay(pause)
                }
            }
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                void typeIntro()
                observer.disconnect()
            }
        }, { threshold: 0.2, rootMargin: "0px 0px -8% 0px" })

        observer.observe(dialog)

        requestAnimationFrame(() => {
            const rect = dialog.getBoundingClientRect()
            if (rect.top < window.innerHeight * 0.92 && rect.bottom > 0) {
                void typeIntro()
                observer.disconnect()
            }
        })
    }

    async function bootLanding() {
        void renderExclusiveSkins()
        const bootDone = preloadLandingAssets().catch(() => null)
        const bootCap = delay(BOOT_MAX_MS)

        await Promise.race([bootDone, bootCap])
        setLoadProgress(100)
        await delay(200)
        revealLanding()
        finishBoot()
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
    let stripScrollLastTs = 0
    const CARD_AUTO_MS = 6500
    const CARD_IDLE_RESUME_MS = 8000
    const STRIP_PIXEL_CHUNK = 6
    const STRIP_PIXEL_TICK_MS = 58
    const STRIP_SCROLL_PX_PER_SEC = 20

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

    function stopContinuousStripScroll() {
        const strip = document.getElementById("card-strip")
        if (strip?._scrollRaf) {
            cancelAnimationFrame(strip._scrollRaf)
            strip._scrollRaf = null
        }
        stripScrollLastTs = 0
    }

    function startContinuousStripScroll() {
        stopContinuousStripScroll()
        if (stripUserActive || !pool.length) return
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

        const strip = document.getElementById("card-strip")
        if (!strip) return

        const tick = (ts) => {
            if (stripUserActive) {
                stripScrollLastTs = 0
                strip._scrollRaf = requestAnimationFrame(tick)
                return
            }
            if (!stripScrollLastTs) stripScrollLastTs = ts
            const dt = Math.min(ts - stripScrollLastTs, 48)
            stripScrollLastTs = ts

            const loopWidth = strip.scrollWidth / 2
            if (loopWidth > 0) {
                strip.scrollLeft += (STRIP_SCROLL_PX_PER_SEC * dt) / 1000
                if (strip.scrollLeft >= loopWidth) {
                    strip.scrollLeft -= loopWidth
                }
            }

            strip._scrollRaf = requestAnimationFrame(tick)
        }

        strip._scrollRaf = requestAnimationFrame(tick)
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
        stopContinuousStripScroll()
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
        if (!pool.length || stripUserActive) return
        startContinuousStripScroll()
        if (pool.length <= 1) return
        cardTimer = setInterval(() => {
            if (stripUserActive) return
            showCard(cardIndex + 1, { userPick: false })
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
            stopContinuousStripScroll()
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

    function initMobileNav() {
        const drawer = document.getElementById("landing-nav-drawer")
        const openBtn = document.getElementById("landing-menu-btn")
        const closeBtn = document.getElementById("landing-nav-close")
        const scrim = document.getElementById("landing-nav-scrim")
        if (!drawer || !openBtn) return

        function setOpen(isOpen) {
            drawer.classList.toggle("is-open", isOpen)
            drawer.setAttribute("aria-hidden", isOpen ? "false" : "true")
            openBtn.setAttribute("aria-expanded", isOpen ? "true" : "false")
            document.body.classList.toggle("landing-nav-open", isOpen)
        }

        openBtn.addEventListener("click", () => setOpen(true))
        closeBtn?.addEventListener("click", () => setOpen(false))
        scrim?.addEventListener("click", () => setOpen(false))
        drawer.querySelectorAll(".landing-nav--drawer a").forEach((link) => {
            link.addEventListener("click", () => setOpen(false))
        })
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && drawer.classList.contains("is-open")) {
                setOpen(false)
                openBtn.focus()
            }
        })
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

    function initCopyables() {
        const toast = document.getElementById("landing-copy-toast")
        let toastTimer = null

        function showCopied(btn) {
            if (toast) {
                toast.textContent = "Copied!"
                toast.classList.remove("hidden")
                clearTimeout(toastTimer)
                toastTimer = setTimeout(() => toast.classList.add("hidden"), 1600)
            }
            btn.classList.add("is-copied")
            const meta = btn.querySelector(".landing-copyable-meta")
            if (meta) meta.textContent = "copied!"
            setTimeout(() => {
                btn.classList.remove("is-copied")
                if (meta) meta.textContent = "click to copy"
            }, 1600)
        }

        async function copyText(value, btn) {
            const text = String(value || "").trim()
            if (!text) return
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text)
                } else {
                    const area = document.createElement("textarea")
                    area.value = text
                    area.setAttribute("readonly", "")
                    area.style.position = "fixed"
                    area.style.opacity = "0"
                    document.body.appendChild(area)
                    area.select()
                    document.execCommand("copy")
                    area.remove()
                }
                showCopied(btn)
            } catch {
                if (toast) {
                    toast.textContent = "Copy failed"
                    toast.classList.remove("hidden")
                    clearTimeout(toastTimer)
                    toastTimer = setTimeout(() => toast.classList.add("hidden"), 1600)
                }
            }
        }

        document.querySelectorAll(".landing-copyable[data-copy]").forEach((btn) => {
            btn.addEventListener("click", () => copyText(btn.dataset.copy, btn))
        })
    }

    bootLanding().then(() => {
        initMobileNav()
        initHeaderScroll()
        initCopyables()
    })
})()
