(function () {
    const WALLET_CHECK = Number(window.APP_CONFIG?.walletCheck ?? 1)
    const VAULT_KEY = "pokequest_profile_vault"
    const GUEST_ID_KEY = "pokequest_guest_id"
    const GUEST_BACKUP_PREFIX = "pokequest_guest_server_backup:"
    const MAX_PROFILES = 8

    let passcodeBuffer = ""
    let passcodeMode = "profile-login" // profile-login only (per-trainer PIN)
    let flowBusy = false
    let confirmResolver = null
    let pendingPinGuestId = ""
    let pendingPinIsNew = false
    let pendingPinLabel = ""

    const flowEl = document.getElementById("play-profile-flow")
    const gateEl = document.getElementById("play-passcode-gate")
    const pickerEl = document.getElementById("play-profile-picker")
    const confirmEl = document.getElementById("play-profile-confirm")
    const confirmBodyEl = document.getElementById("play-profile-confirm-body")
    const landingActions = document.querySelector(".play-actions")
    const passcodeTitle = document.getElementById("play-passcode-title")
    const passcodeSubtitle = document.getElementById("play-passcode-subtitle")
    const passcodeStatus = document.getElementById("play-passcode-status")
    const profileList = document.getElementById("play-profile-list")
    const profileStatus = document.getElementById("play-profile-status")

    function guestProfilesEnabled() {
        return Boolean(window.APP_CONFIG?.playMode) && WALLET_CHECK === 0
    }

    function legacyProfilesForVault() {
        const legacy = localStorage.getItem(GUEST_ID_KEY)
        if (!legacy || !legacy.startsWith("guest:")) return []
        return [{
            guestId: legacy,
            name: "Saved Trainer",
            slot: 1,
            level: 0,
            updatedAt: Date.now(),
        }]
    }

    function readVault() {
        try {
            const raw = localStorage.getItem(VAULT_KEY)
            if (!raw) return null
            const data = JSON.parse(raw)
            if (!data || typeof data !== "object") return null
            if (!Array.isArray(data.profiles)) data.profiles = []
            data.profiles.forEach((profile, index) => {
                if (!profile || typeof profile !== "object") return
                if (!Number(profile.slot)) {
                    profile.slot = index + 1
                }
            })
            return data
        } catch {
            return null
        }
    }

    function writeVault(vault) {
        localStorage.setItem(VAULT_KEY, JSON.stringify(vault))
    }

    function ensureVault() {
        let vault = readVault()
        if (vault) return vault
        vault = { profiles: legacyProfilesForVault() }
        writeVault(vault)
        return vault
    }

    function setActiveGuestId(guestId) {
        localStorage.setItem(GUEST_ID_KEY, guestId)
    }

    function createGuestId() {
        const uuid = typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID().replace(/-/g, "")
            : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
        return `guest:${uuid}`
    }

    function isPlaceholderGuestName(name) {
        const text = String(name || "").trim()
        if (!text) return true
        if (/^guest:/i.test(text)) return true
        if (/^player guest:/i.test(text)) return true
        if (/^[a-f0-9]{4}…[a-f0-9]{4}$/i.test(text)) return true
        if (/^[a-f0-9]{4}\u2026[a-f0-9]{4}$/i.test(text)) return true
        if (/^new trainer(\s+\d+)?$/i.test(text)) return true
        if (/^saved trainer$/i.test(text)) return true
        return false
    }

    function profileLabel(profile) {
        const name = String(profile?.name || "").trim()
        if (name && !isPlaceholderGuestName(name)) return name
        const slot = Number(profile?.slot)
        if (slot > 0) return `New Trainer ${slot}`
        return "New Trainer"
    }

    function serverProfilePatchFromRow(row) {
        const patch = {}
        const level = Number(row.level) || 0
        if (level > 0) patch.level = level

        if (row.has_skin) patch.has_skin = true
        if (row.profile_ready) patch.profile_ready = true
        if (row.has_pin) patch.has_pin = true
        if (row.has_pin === false) patch.has_pin = false

        const skin = String(row.skin || "").trim()
        if (skin) patch.skin = skin

        const displayName = String(row.display_name || "").trim()
        if (displayName && !isPlaceholderGuestName(displayName)) {
            patch.name = displayName
        }
        return patch
    }

    function sessionBackupFromAuth(data) {
        if (!data || typeof data !== "object") return null
        const name = String(data.display_name || "").trim()
        const skin = String(data.skin || "").trim()
        const stats = data.trainer_stats || {}
        const backup = {
            savedAt: Date.now(),
            display_name: name && !isPlaceholderGuestName(name) ? name : "",
            skin: skin || "",
            balance: 0,
            holds: Array.isArray(data.holds) ? data.holds : [],
            gear_slots: Array.isArray(data.gear_slots) ? data.gear_slots : [],
            quest_progress: data.quest_progress || { completed_steps: [], removed_quests: [] },
            vault: Array.isArray(data.vault) ? data.vault : [],
            vault_detail: Array.isArray(data.vault_detail) ? data.vault_detail : [],
            owned_skins: Array.isArray(data.owned_skins) ? data.owned_skins : [],
            vending_spins: Number(data.vending_spins) || 0,
            level: Number(data.level ?? stats.level) || 0,
            // Battle record + XP so trainer level survives a server DB wipe.
            stats_xp: Number(stats.stats_xp) || 0,
            stats_wins: Number(stats.stats_wins) || 0,
            stats_battles: Number(stats.stats_battles) || 0,
            stats_losses: Number(stats.stats_losses) || 0,
            stats_wagered: Number(stats.stats_wagered) || 0,
        }
        if (!backup.display_name && !backup.skin && !backup.holds.length
            && !backup.quest_progress?.completed_steps?.length
            && !backup.vault.length && !backup.vault_detail.length) {
            return null
        }
        return backup
    }

    function readStandaloneGuestBackup(guestId) {
        if (!guestId) return null
        try {
            const raw = localStorage.getItem(`${GUEST_BACKUP_PREFIX}${guestId}`)
            if (!raw) return null
            const data = JSON.parse(raw)
            return data && typeof data === "object" ? data : null
        } catch {
            return null
        }
    }

    function writeStandaloneGuestBackup(guestId, backup) {
        if (!guestId || !backup) return
        try {
            localStorage.setItem(`${GUEST_BACKUP_PREFIX}${guestId}`, JSON.stringify(backup))
        } catch {
            /* quota — vault copy may still exist */
        }
    }

    function getGuestServerBackup(guestId) {
        if (!guestId) return null
        const standalone = readStandaloneGuestBackup(guestId)
        const vaultCopy = getCachedGuestProfileMeta(guestId)?.serverBackup
        if (standalone && vaultCopy) {
            const standaloneSteps = standalone.quest_progress?.completed_steps?.length || 0
            const vaultSteps = vaultCopy.quest_progress?.completed_steps?.length || 0
            return standaloneSteps >= vaultSteps ? standalone : vaultCopy
        }
        return standalone || vaultCopy || null
    }

    function backupHasProgress(backup) {
        if (!backup || typeof backup !== "object") return false
        if (backup.display_name && backup.skin) return true
        if (Array.isArray(backup.holds) && backup.holds.length) return true
        if (Array.isArray(backup.quest_progress?.completed_steps)
            && backup.quest_progress.completed_steps.length) return true
        if (Array.isArray(backup.vault_detail) && backup.vault_detail.length) return true
        if (Array.isArray(backup.vault) && backup.vault.length) return true
        if (Array.isArray(backup.gear_slots) && backup.gear_slots.some(Boolean)) return true
        return false
    }

    function saveGuestServerBackup(data) {
        if (!guestProfilesEnabled()) return
        const guestId = localStorage.getItem(GUEST_ID_KEY)
        if (!guestId) return
        const backup = sessionBackupFromAuth(data)
        if (!backup) return
        // Auth responses often omit PIN and (after a wipe) display_name. Never let an
        // empty re-auth clobber a previously saved username/PIN in the browser vault.
        const prev = readStandaloneGuestBackup(guestId)
            || getCachedGuestProfileMeta(guestId)?.serverBackup
            || null
        if (prev?.pin && !backup.pin) backup.pin = prev.pin
        const prevName = String(prev?.display_name || "").trim()
        if (prevName && !isPlaceholderGuestName(prevName) && !backup.display_name) {
            backup.display_name = prevName
        }
        const metaName = String(getCachedGuestProfileMeta(guestId)?.name || "").trim()
        if (metaName && !isPlaceholderGuestName(metaName) && !backup.display_name) {
            backup.display_name = metaName
        }
        writeStandaloneGuestBackup(guestId, backup)
        upsertProfileMeta(guestId, { serverBackup: backup })
    }

    function setGuestBackupPin(pin) {
        if (!guestProfilesEnabled()) return
        const clean = String(pin || "").trim()
        if (!/^\d{3}$/.test(clean)) return
        const guestId = localStorage.getItem(GUEST_ID_KEY)
        if (!guestId) return
        const backup = readStandaloneGuestBackup(guestId)
        if (!backup) return
        backup.pin = clean
        writeStandaloneGuestBackup(guestId, backup)
        upsertProfileMeta(guestId, { serverBackup: backup })
    }

    async function syncGuestProfileToServer(guestId) {
        if (!guestProfilesEnabled() || !guestId) return false
        const backup = getGuestServerBackup(guestId)
        if (!backupHasProgress(backup)) return false

        try {
            const response = await fetch("/api/guest/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                cache: "no-store",
                body: JSON.stringify({ guestId, backup }),
            })
            const data = await response.json().catch(() => ({}))
            return Boolean(response.ok && data.success)
        } catch {
            return false
        }
    }

    async function restoreGuestProfileFromVault(guestId) {
        if (!guestProfilesEnabled() || !guestId) return false
        const backup = getGuestServerBackup(guestId)
        if (!backupHasProgress(backup)) return false

        try {
            const response = await fetch("/api/guest/restore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                cache: "no-store",
                body: JSON.stringify({ guestId, backup }),
            })
            const data = await response.json()
            return Boolean(response.ok && data.success && data.restored)
        } catch {
            return false
        }
    }

    async function refreshProfileNamesFromServer(profiles) {
        const guestIds = profiles.map((p) => p.guestId).filter(Boolean)
        if (!guestIds.length) return

        try {
            const response = await fetch("/api/guest/profiles", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                cache: "no-store",
                body: JSON.stringify({ guestIds }),
            })
            const data = await response.json()
            if (!response.ok || !data.success || !Array.isArray(data.profiles)) return

            for (const row of data.profiles) {
                const guestId = String(row.guestId || "").trim()
                if (!guestId) continue
                upsertProfileMeta(guestId, serverProfilePatchFromRow(row))
            }
        } catch {
            /* picker still works from cached names */
        }
    }

    function upsertProfileMeta(guestId, patch) {
        const vault = ensureVault()
        if (!guestId) return
        const idx = vault.profiles.findIndex((p) => p.guestId === guestId)
        const now = Date.now()
        const metaPatch = { ...(patch || {}) }
        if (metaPatch.name === undefined) {
            delete metaPatch.name
        }
        if (idx >= 0) {
            const prev = vault.profiles[idx]
            const next = { ...prev, ...metaPatch, guestId, updatedAt: now }
            if (metaPatch.name !== undefined && isPlaceholderGuestName(metaPatch.name)) {
                next.name = prev.name
            }
            if (prev.has_skin && metaPatch.has_skin === false) {
                next.has_skin = true
            }
            if (prev.profile_ready && metaPatch.profile_ready === false) {
                next.profile_ready = true
            }
            if (prev.serverBackup && !metaPatch.serverBackup) {
                next.serverBackup = prev.serverBackup
            } else if (metaPatch.serverBackup && prev.serverBackup) {
                const prevSteps = prev.serverBackup?.quest_progress?.completed_steps?.length || 0
                const nextSteps = metaPatch.serverBackup?.quest_progress?.completed_steps?.length || 0
                if (prevSteps > nextSteps) {
                    next.serverBackup = prev.serverBackup
                } else {
                    const prevBackupName = String(prev.serverBackup.display_name || "").trim()
                    const nextBackupName = String(metaPatch.serverBackup.display_name || "").trim()
                    if (prevBackupName && !isPlaceholderGuestName(prevBackupName) && !nextBackupName) {
                        next.serverBackup = {
                            ...metaPatch.serverBackup,
                            display_name: prevBackupName,
                        }
                    }
                }
            }
            if (!next.slot) {
                next.slot = Number(prev.slot) > 0 ? prev.slot : idx + 1
            }
            vault.profiles[idx] = next
        } else if (vault.profiles.length < MAX_PROFILES) {
            const slot = vault.profiles.length + 1
            const name = metaPatch.name && !isPlaceholderGuestName(metaPatch.name)
                ? metaPatch.name
                : `New Trainer ${slot}`
            vault.profiles.push({
                guestId,
                name,
                slot,
                level: metaPatch.level ?? 0,
                updatedAt: now,
                ...metaPatch,
            })
        }
        writeVault(vault)
    }

    function removeProfileFromVault(guestId) {
        const vault = readVault()
        if (!vault || !guestId) return false
        const idx = vault.profiles.findIndex((p) => p.guestId === guestId)
        if (idx < 0) return false
        vault.profiles.splice(idx, 1)
        writeVault(vault)
        return true
    }

    function showFlowPanel(panel) {
        flowEl?.classList.remove("hidden")
        landingActions?.classList.add("hidden")
        gateEl?.classList.toggle("hidden", panel !== "gate")
        pickerEl?.classList.toggle("hidden", panel !== "picker")
    }

    function closeGuestProfileFlow() {
        flowEl?.classList.add("hidden")
        landingActions?.classList.remove("hidden")
        clearPasscodeEntry()
        if (profileStatus) profileStatus.textContent = ""
    }

    function clearPasscodeEntry() {
        passcodeBuffer = ""
        renderPasscodeDisplay()
        if (passcodeStatus) {
            passcodeStatus.textContent = ""
            passcodeStatus.classList.remove("is-error")
        }
    }

    function renderPasscodeDisplay() {
        const slots = document.querySelectorAll("#play-passcode-display .play-passcode-slot")
        slots.forEach((slot, index) => {
            slot.classList.toggle("is-filled", index < passcodeBuffer.length)
        })
    }

    function configurePasscodeGate(mode, label = "") {
        passcodeMode = mode
        clearPasscodeEntry()
        const name = label || pendingPinLabel || "this trainer"
        if (passcodeTitle) passcodeTitle.textContent = "Enter trainer PIN"
        if (passcodeSubtitle) {
            passcodeSubtitle.textContent = `Enter the 3-digit PIN for ${name}.`
        }
    }

    async function verifyProfilePin(guestId, pin) {
        const response = await fetch("/api/pin/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ guestId, pin }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !data.success) {
            throw new Error(data.error || "Wrong PIN")
        }
        return true
    }

    async function submitPasscode(pin) {
        if (passcodeMode !== "profile-login" || !pendingPinGuestId) {
            closeGuestProfileFlow()
            return
        }
        const guestId = pendingPinGuestId
        const isNew = pendingPinIsNew
        try {
            await verifyProfilePin(guestId, pin)
            if (window.SaiPokePlay) {
                window.SaiPokePlay._guestPinVerified = true
            }
            pendingPinGuestId = ""
            pendingPinIsNew = false
            pendingPinLabel = ""
            await bootSelectedProfile(guestId, { isNew, pinAlreadyVerified: true })
        } catch (error) {
            const msg = String(error?.message || "")
            // Server lost the PIN (wipe) — allow entry and force a new PIN setup.
            if (/not set yet/i.test(msg)) {
                upsertProfileMeta(guestId, { has_pin: false })
                pendingPinGuestId = ""
                pendingPinIsNew = false
                pendingPinLabel = ""
                if (window.SaiPokePlay) window.SaiPokePlay._guestPinVerified = false
                await bootSelectedProfile(guestId, { isNew, pinAlreadyVerified: false })
                return
            }
            if (passcodeStatus) {
                passcodeStatus.textContent = msg || "Wrong PIN."
                passcodeStatus.classList.add("is-error")
            }
            clearPasscodeEntry()
        }
    }

    function onPasscodeDigit(digit) {
        if (flowBusy || passcodeBuffer.length >= 3) return
        passcodeBuffer += digit
        renderPasscodeDisplay()
        if (passcodeBuffer.length === 3) {
            void submitPasscode(passcodeBuffer)
        }
    }

    function onPasscodeBackspace() {
        if (flowBusy) return
        passcodeBuffer = passcodeBuffer.slice(0, -1)
        renderPasscodeDisplay()
        if (passcodeStatus) {
            passcodeStatus.textContent = ""
            passcodeStatus.classList.remove("is-error")
        }
    }

    async function renderProfilePicker() {
        ensureVault()
        showFlowPanel("picker")
        if (!profileList) return

        if (profileStatus) {
            profileStatus.textContent = "Loading trainers…"
            profileStatus.classList.remove("is-error")
        }

        const vault = readVault()
        await refreshProfileNamesFromServer(vault?.profiles || [])

        const refreshedVault = readVault()
        const sorted = [...(refreshedVault?.profiles || vault?.profiles || [])].sort(
            (a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0),
        )

        if (profileStatus) profileStatus.textContent = ""

        if (!sorted.length) {
            profileList.innerHTML = (
                '<p class="play-profile-empty">No trainers yet — add your first profile.</p>'
            )
        } else {
            profileList.innerHTML = sorted.map((profile) => {
                const label = profileLabel(profile)
                const level = Number(profile.level) > 0 ? `Lv.${profile.level}` : ""
                const lock = profile.has_pin ? " · PIN" : ""
                const guestIdEnc = encodeURIComponent(profile.guestId)
                return (
                    `<div class="play-profile-row" role="listitem">`
                    + `<button type="button" class="play-btn play-btn--ghost play-profile-slot" `
                    + `data-guest-id="${guestIdEnc}">`
                    + `<span class="play-profile-slot-name">${escapeHtml(label)}</span>`
                    + `<span class="play-profile-slot-meta">${escapeHtml(level)}${escapeHtml(lock)}</span>`
                    + `</button>`
                    + `<button type="button" class="play-profile-delete" data-guest-id="${guestIdEnc}" `
                    + `aria-label="Delete ${escapeHtml(label)}" title="Delete profile">×</button>`
                    + `</div>`
                )
            }).join("")
        }

        profileList.querySelectorAll(".play-profile-delete").forEach((btn) => {
            btn.disabled = flowBusy
        })

        const addBtn = document.getElementById("play-profile-add-btn")
        if (addBtn) {
            const atCap = sorted.length >= MAX_PROFILES
            addBtn.disabled = atCap
            addBtn.textContent = atCap ? "Profile limit reached" : "+ Add new profile"
        }
    }

    function escapeHtml(text) {
        return String(text || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    }

    function closeDeleteConfirm(result) {
        confirmEl?.classList.add("hidden")
        if (confirmResolver) {
            confirmResolver(Boolean(result))
            confirmResolver = null
        }
    }

    function showDeleteConfirm(label) {
        return new Promise((resolve) => {
            if (!confirmEl || !confirmBodyEl) {
                resolve(false)
                return
            }
            confirmResolver = resolve
            confirmBodyEl.innerHTML = `Remove <strong>${escapeHtml(label)}</strong> from this device?`
            confirmEl.classList.remove("hidden")
            document.getElementById("play-profile-confirm-delete")?.focus()
        })
    }

    async function beginProfileEntry(guestId, { isNew = false } = {}) {
        if (!guestId || flowBusy) return

        await refreshProfileNamesFromServer([{ guestId }])
        const meta = getCachedGuestProfileMeta(guestId)
        const hasPin = Boolean(meta?.has_pin)
        const label = profileLabel(meta || { guestId, name: "" })

        // Existing trainer with PIN: unlock that profile before loading session.
        if (hasPin && !isNew) {
            pendingPinGuestId = guestId
            pendingPinIsNew = false
            pendingPinLabel = label
            showFlowPanel("gate")
            configurePasscodeGate("profile-login", label)
            return
        }

        // New profile or PIN not set yet — boot, then force PIN setup in-app.
        if (window.SaiPokePlay) {
            window.SaiPokePlay._guestPinVerified = false
        }
        await bootSelectedProfile(guestId, { isNew, pinAlreadyVerified: false })
    }

    async function bootSelectedProfile(guestId, { isNew = false, pinAlreadyVerified = false } = {}) {
        if (!guestId || flowBusy) return
        flowBusy = true
        if (profileStatus) {
            profileStatus.textContent = "Loading trainer…"
            profileStatus.classList.remove("is-error")
        }

        if (window.SaiPokePlay) {
            window.SaiPokePlay._returningGuestBoot = !isNew
            if (pinAlreadyVerified) {
                window.SaiPokePlay._guestPinVerified = true
            }
        }

        setActiveGuestId(guestId)
        await refreshProfileNamesFromServer([{ guestId }])

        try {
            const ok = await window.SaiPokePlay?.bootAfterWallet?.()
            if (!ok) {
                if (window.SaiPokePlay) window.SaiPokePlay._guestPinVerified = false
                if (profileStatus) {
                    profileStatus.textContent = "Could not load trainer. Try again."
                    profileStatus.classList.add("is-error")
                }
                return
            }
            closeGuestProfileFlow()
            const status = document.getElementById("play-status")
            if (status) status.textContent = ""
        } catch (error) {
            if (window.SaiPokePlay) window.SaiPokePlay._guestPinVerified = false
            if (profileStatus) {
                profileStatus.textContent = error?.message || "Could not sign in."
                profileStatus.classList.add("is-error")
            }
        } finally {
            flowBusy = false
        }
    }

    function addNewProfile() {
        const vault = ensureVault()
        if (vault.profiles.length >= MAX_PROFILES) return

        const guestId = createGuestId()
        const slot = vault.profiles.length + 1
        vault.profiles.push({
            guestId,
            name: `New Trainer ${slot}`,
            slot,
            level: 0,
            has_pin: false,
            updatedAt: Date.now(),
        })
        writeVault(vault)
        void beginProfileEntry(guestId, { isNew: true })
    }

    async function deleteProfile(guestId) {
        if (!guestId || flowBusy) return
        const vault = ensureVault()

        const profile = vault.profiles.find((p) => p.guestId === guestId)
        const label = profile ? profileLabel(profile) : "this trainer"
        const confirmed = await showDeleteConfirm(label)
        if (!confirmed) return

        flowBusy = true
        if (profileStatus) {
            profileStatus.textContent = "Deleting trainer…"
            profileStatus.classList.remove("is-error")
        }

        try {
            const response = await fetch("/api/guest/profiles/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ guestId }),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || !data.success) {
                throw new Error(data.error || "Could not delete trainer.")
            }

            removeProfileFromVault(guestId)
            if (localStorage.getItem(GUEST_ID_KEY) === guestId) {
                localStorage.removeItem(GUEST_ID_KEY)
            }
            await renderProfilePicker()
        } catch (error) {
            if (profileStatus) {
                profileStatus.textContent = error?.message || "Could not delete trainer."
                profileStatus.classList.add("is-error")
            }
        } finally {
            flowBusy = false
        }
    }

    function openGuestProfileFlow() {
        if (!guestProfilesEnabled()) return
        ensureVault()
        pendingPinGuestId = ""
        pendingPinIsNew = false
        pendingPinLabel = ""
        if (window.SaiPokePlay) window.SaiPokePlay._guestPinVerified = false
        void renderProfilePicker()
    }

    function getCachedProfileName(guestId) {
        const meta = getCachedGuestProfileMeta(guestId)
        return meta?.name || ""
    }

    function getCachedGuestProfileMeta(guestId) {
        const vault = readVault()
        if (!vault || !guestId) return null
        const profile = vault.profiles.find((p) => p.guestId === guestId)
        if (!profile) return null
        const name = String(profile.name || "").trim()
        const cleanName = name && !isPlaceholderGuestName(name) ? name : ""
        return {
            name: cleanName,
            skin: String(profile.skin || "").trim(),
            has_skin: Boolean(profile.has_skin),
            profile_ready: Boolean(profile.profile_ready),
            has_pin: Boolean(profile.has_pin),
            serverBackup: profile.serverBackup || null,
        }
    }

    function scrubCachedWalletLinks() {
        if (!guestProfilesEnabled()) return
        const vault = readVault()
        if (!vault?.profiles?.length) return
        let changed = false
        for (const profile of vault.profiles) {
            if (
                Object.prototype.hasOwnProperty.call(profile, "has_linked_wallet")
                || Object.prototype.hasOwnProperty.call(profile, "linked_wallet")
            ) {
                delete profile.has_linked_wallet
                delete profile.linked_wallet
                changed = true
            }
        }
        if (changed) writeVault(vault)
    }

    function syncGuestProfileMeta(data) {
        if (!guestProfilesEnabled()) return
        const guestId = localStorage.getItem(GUEST_ID_KEY)
        if (!guestId || !data) return

        const name = String(data.display_name || "").trim()
        const level = Number(data.level ?? data.trainer_stats?.level ?? 0)
        const patch = { level }
        if (data.has_skin) patch.has_skin = true
        if (data.profile_ready) patch.profile_ready = true
        if (data.has_pin) patch.has_pin = true
        // linked_wallet is server-only — never cache it in the browser vault.
        const skin = String(data.skin || "").trim()
        if (skin) patch.skin = skin
        if (name && !isPlaceholderGuestName(name)) {
            patch.name = name
        }
        const backup = sessionBackupFromAuth(data)
        if (backup) patch.serverBackup = backup
        upsertProfileMeta(guestId, patch)
    }

    async function acceptWalletLogin(data) {
        if (!guestProfilesEnabled()) return false
        const guestId = String(data?.guestId || "").trim()
        if (!guestId) return false

        ensureVault()
        const name = String(data.display_name || "").trim()
        upsertProfileMeta(guestId, {
            name: name && !isPlaceholderGuestName(name) ? name : undefined,
            has_pin: Boolean(data.has_pin),
        })

        const meta = getCachedGuestProfileMeta(guestId)
        if (!meta) {
            throw new Error(
                "Profile limit reached on this device. Delete a local trainer, then sign in with wallet again.",
            )
        }

        // Wallet ownership is not a PIN unlock.
        if (window.SaiPokePlay) {
            window.SaiPokePlay._guestPinVerified = false
        }

        await beginProfileEntry(guestId, { isNew: false })
        return true
    }

    function bindProfileUi() {
        if (!guestProfilesEnabled()) return

        document.getElementById("play-passcode-keypad")?.addEventListener("click", (event) => {
            const btn = event.target.closest("[data-digit],[data-action]")
            if (!btn) return
            if (btn.dataset.action === "back") {
                onPasscodeBackspace()
                return
            }
            if (btn.dataset.digit != null) {
                onPasscodeDigit(btn.dataset.digit)
            }
        })

        document.getElementById("play-passcode-back")?.addEventListener("click", () => {
            pendingPinGuestId = ""
            pendingPinIsNew = false
            pendingPinLabel = ""
            void renderProfilePicker()
        })

        document.getElementById("play-profile-back")?.addEventListener("click", () => {
            closeGuestProfileFlow()
        })

        document.getElementById("play-profile-add-btn")?.addEventListener("click", () => {
            if (!flowBusy) addNewProfile()
        })

        document.getElementById("play-profile-confirm-cancel")?.addEventListener("click", () => {
            closeDeleteConfirm(false)
        })

        document.getElementById("play-profile-confirm-delete")?.addEventListener("click", () => {
            closeDeleteConfirm(true)
        })

        confirmEl?.addEventListener("click", (event) => {
            if (event.target === confirmEl) closeDeleteConfirm(false)
        })

        profileList?.addEventListener("click", (event) => {
            const deleteBtn = event.target.closest(".play-profile-delete")
            if (deleteBtn?.dataset.guestId) {
                event.preventDefault()
                void deleteProfile(decodeURIComponent(deleteBtn.dataset.guestId))
                return
            }
            const btn = event.target.closest(".play-profile-slot")
            if (!btn?.dataset.guestId) return
            void beginProfileEntry(decodeURIComponent(btn.dataset.guestId))
        })
    }

    window.SaiPokePlay = window.SaiPokePlay || {}
    window.SaiPokePlay.openGuestProfileFlow = openGuestProfileFlow
    window.SaiPokePlay.closeGuestProfileFlow = closeGuestProfileFlow
    window.SaiPokePlay.syncGuestProfileMeta = syncGuestProfileMeta
    window.SaiPokePlay.acceptWalletLogin = acceptWalletLogin
    window.SaiPokePlay.scrubCachedWalletLinks = scrubCachedWalletLinks
    window.SaiPokePlay.getCachedGuestProfileName = getCachedProfileName
    window.SaiPokePlay.getCachedGuestProfileMeta = getCachedGuestProfileMeta
    window.SaiPokePlay.saveGuestServerBackup = saveGuestServerBackup
    window.SaiPokePlay.setGuestBackupPin = setGuestBackupPin
    window.SaiPokePlay.restoreGuestProfileFromVault = restoreGuestProfileFromVault
    window.SaiPokePlay.syncGuestProfileToServer = syncGuestProfileToServer
    window.SaiPokePlay.getGuestServerBackup = getGuestServerBackup
    window.SaiPokePlay.guestProfilesEnabled = guestProfilesEnabled

    scrubCachedWalletLinks()
    bindProfileUi()
})()
