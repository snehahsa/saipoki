(function () {
    const WALLET_CHECK = Number(window.APP_CONFIG?.walletCheck ?? 1)
    const VAULT_KEY = "pokequest_profile_vault"
    const GUEST_ID_KEY = "pokequest_guest_id"
    const UNLOCK_KEY = "pokequest_vault_unlocked"
    const MAX_PROFILES = 8

    let passcodeBuffer = ""
    let passcodeMode = "unlock" // unlock | create | confirm
    let pendingCreateHash = ""
    let flowBusy = false
    let confirmResolver = null

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
            if (!data || typeof data !== "object" || !data.passcodeHash) return null
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

    async function hashPasscode(pin) {
        const text = `pokequest-vault:${pin}`
        if (!window.crypto?.subtle) {
            return text
        }
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
        return Array.from(new Uint8Array(buf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
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

    function unlockSession(passcodeHash) {
        sessionStorage.setItem(UNLOCK_KEY, passcodeHash)
    }

    function isVaultUnlocked(vault) {
        if (!vault) return false
        return sessionStorage.getItem(UNLOCK_KEY) === vault.passcodeHash
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
                const displayName = String(row.display_name || "").trim()
                const patch = {
                    level: Number(row.level) || 0,
                    has_skin: Boolean(row.has_skin),
                    profile_ready: Boolean(row.profile_ready),
                }
                if (displayName && !isPlaceholderGuestName(displayName)) {
                    patch.name = displayName
                }
                upsertProfileMeta(guestId, patch)
            }
        } catch {
            /* picker still works from cached names */
        }
    }

    function upsertProfileMeta(guestId, patch) {
        const vault = readVault()
        if (!vault || !guestId) return
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

    function configurePasscodeGate(mode) {
        passcodeMode = mode
        clearPasscodeEntry()
        if (mode === "create") {
            if (passcodeTitle) passcodeTitle.textContent = "Create passcode"
            if (passcodeSubtitle) {
                passcodeSubtitle.textContent = "Pick a 3-digit code to protect profiles on this browser."
            }
        } else if (mode === "confirm") {
            if (passcodeTitle) passcodeTitle.textContent = "Confirm passcode"
            if (passcodeSubtitle) passcodeSubtitle.textContent = "Enter the same code again."
        } else {
            if (passcodeTitle) passcodeTitle.textContent = "Enter passcode"
            if (passcodeSubtitle) {
                passcodeSubtitle.textContent = "Unlock your saved trainers on this device."
            }
        }
    }

    async function submitPasscode(pin) {
        const vault = readVault()
        const hash = await hashPasscode(pin)

        if (passcodeMode === "create") {
            pendingCreateHash = hash
            configurePasscodeGate("confirm")
            return
        }

        if (passcodeMode === "confirm") {
            if (hash !== pendingCreateHash) {
                if (passcodeStatus) {
                    passcodeStatus.textContent = "Codes did not match. Try again."
                    passcodeStatus.classList.add("is-error")
                }
                configurePasscodeGate("create")
                pendingCreateHash = ""
                return
            }
            writeVault({ passcodeHash: hash, profiles: legacyProfilesForVault() })
            unlockSession(hash)
            renderProfilePicker()
            return
        }

        if (!vault) {
            configurePasscodeGate("create")
            return
        }

        if (hash !== vault.passcodeHash) {
            if (passcodeStatus) {
                passcodeStatus.textContent = "Wrong passcode."
                passcodeStatus.classList.add("is-error")
            }
            return
        }

        unlockSession(hash)
        renderProfilePicker()
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
        const vault = readVault()
        if (!vault || !isVaultUnlocked(vault)) {
            openGuestProfileFlow()
            return
        }

        showFlowPanel("picker")
        if (!profileList) return

        if (profileStatus) {
            profileStatus.textContent = "Loading trainers…"
            profileStatus.classList.remove("is-error")
        }

        await refreshProfileNamesFromServer(vault.profiles)

        const refreshedVault = readVault()
        const sorted = [...(refreshedVault?.profiles || vault.profiles)].sort(
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
                const guestIdEnc = encodeURIComponent(profile.guestId)
                return (
                    `<div class="play-profile-row" role="listitem">`
                    + `<button type="button" class="play-btn play-btn--ghost play-profile-slot" `
                    + `data-guest-id="${guestIdEnc}">`
                    + `<span class="play-profile-slot-name">${escapeHtml(label)}</span>`
                    + `<span class="play-profile-slot-meta">${escapeHtml(level)}</span>`
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

    async function bootSelectedProfile(guestId) {
        if (!guestId || flowBusy) return
        flowBusy = true
        if (profileStatus) {
            profileStatus.textContent = "Loading trainer…"
            profileStatus.classList.remove("is-error")
        }

        setActiveGuestId(guestId)
        await refreshProfileNamesFromServer([{ guestId }])
        upsertProfileMeta(guestId, { level: 0 })

        try {
            const ok = await window.SaiPokePlay?.bootAfterWallet?.()
            if (!ok) {
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
            if (profileStatus) {
                profileStatus.textContent = error?.message || "Could not sign in."
                profileStatus.classList.add("is-error")
            }
        } finally {
            flowBusy = false
        }
    }

    function addNewProfile() {
        const vault = readVault()
        if (!vault || !isVaultUnlocked(vault)) return
        if (vault.profiles.length >= MAX_PROFILES) return

        const guestId = createGuestId()
        const slot = vault.profiles.length + 1
        vault.profiles.push({
            guestId,
            name: `New Trainer ${slot}`,
            slot,
            level: 0,
            updatedAt: Date.now(),
        })
        writeVault(vault)
        void bootSelectedProfile(guestId)
    }

    async function deleteProfile(guestId) {
        if (!guestId || flowBusy) return
        const vault = readVault()
        if (!vault || !isVaultUnlocked(vault)) return

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

        const vault = readVault()
        if (!vault) {
            showFlowPanel("gate")
            configurePasscodeGate("create")
            return
        }

        if (isVaultUnlocked(vault)) {
            renderProfilePicker()
            return
        }

        showFlowPanel("gate")
        configurePasscodeGate("unlock")
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
            has_skin: Boolean(profile.has_skin),
            profile_ready: Boolean(profile.profile_ready),
        }
    }

    function syncGuestProfileMeta(data) {
        if (!guestProfilesEnabled()) return
        const guestId = localStorage.getItem(GUEST_ID_KEY)
        if (!guestId || !data) return

        const name = String(data.display_name || "").trim()
        const level = Number(data.level ?? data.trainer_stats?.level ?? 0)
        const patch = {
            level,
            has_skin: Boolean(data.has_skin),
            profile_ready: Boolean(data.profile_ready),
        }
        if (name && !isPlaceholderGuestName(name)) {
            patch.name = name
        }
        upsertProfileMeta(guestId, patch)
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
            if (passcodeMode === "confirm") {
                configurePasscodeGate("create")
                return
            }
            closeGuestProfileFlow()
        })

        document.getElementById("play-profile-back")?.addEventListener("click", () => {
            sessionStorage.removeItem(UNLOCK_KEY)
            const vault = readVault()
            if (!vault) {
                closeGuestProfileFlow()
                return
            }
            showFlowPanel("gate")
            configurePasscodeGate("unlock")
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
            void bootSelectedProfile(decodeURIComponent(btn.dataset.guestId))
        })
    }

    window.SaiPokePlay = window.SaiPokePlay || {}
    window.SaiPokePlay.openGuestProfileFlow = openGuestProfileFlow
    window.SaiPokePlay.closeGuestProfileFlow = closeGuestProfileFlow
    window.SaiPokePlay.syncGuestProfileMeta = syncGuestProfileMeta
    window.SaiPokePlay.getCachedGuestProfileName = getCachedProfileName
    window.SaiPokePlay.getCachedGuestProfileMeta = getCachedGuestProfileMeta
    window.SaiPokePlay.guestProfilesEnabled = guestProfilesEnabled

    bindProfileUi()
})()
