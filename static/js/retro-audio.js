/**
 * Procedural Game Boy–style audio: looping routes/menu themes + Pokémon-like SFX.
 * No external files — square/triangle/noise oscillators only.
 */
(function () {
    const NOTES = {
        C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, B3: 246.94,
        C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
        C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
        C6: 1046.5,
    }

    const MENU_PATTERN = [
        { m: "E4", b: "C3" }, { m: "G4", b: "E3" }, { m: "B4", b: "G3" }, { m: "E5", b: "C3" },
        { m: "D5", b: "A3" }, { m: "B4", b: "F3" }, { m: "G4", b: "E3" }, { m: null, b: "C3" },
        { m: "A4", b: "F3" }, { m: "C5", b: "G3" }, { m: "E5", b: "C3" }, { m: "G5", b: "E3" },
        { m: "F5", b: "D3" }, { m: "D5", b: "B3" }, { m: "B4", b: "G3" }, { m: null, b: "E3" },
    ]

    const OVERWORLD_PATTERN = [
        { m: "G4", b: "C3", h: true }, { m: "B4", b: "G3" }, { m: "D5", b: "C3" }, { m: "G4", b: "E3" },
        { m: "A4", b: "F3", h: true }, { m: "C5", b: "A3" }, { m: "E5", b: "C3" }, { m: "D5", b: "B3" },
        { m: "B4", b: "G3", h: true }, { m: "G4", b: "E3" }, { m: "A4", b: "F3" }, { m: "B4", b: "G3" },
        { m: "C5", b: "C3", h: true }, { m: "A4", b: "A3" }, { m: "G4", b: "F3" }, { m: "E4", b: "E3" },
        { m: "F4", b: "D3", h: true }, { m: "A4", b: "F3" }, { m: "C5", b: "A3" }, { m: "E5", b: "C3" },
        { m: "D5", b: "B3", h: true }, { m: "B4", b: "G3" }, { m: "G4", b: "E3" }, { m: null, b: "C3" },
    ]

    const DIALOGUE_PATTERN = [
        { m: null, b: "A3" }, { m: "E5", b: "C3" }, { m: null, b: "A3" }, { m: "G4", b: "E3" },
        { m: null, b: "F3" }, { m: "C5", b: "A3" }, { m: null, b: "G3" }, { m: "B4", b: "E3" },
    ]

    class RetroAudioEngine {
        constructor() {
            this.ctx = null
            this.master = null
            this.musicGain = null
            this.sfxGain = null
            this.scene = "silent"
            this.pattern = null
            this.step = 0
            this.tempo = 128
            this.timer = null
            this.nextBeatAt = 0
            this.unlocked = false
            this.muted = false
            this._pendingScene = null
            this._fadeInSec = 0
            this._mediaUnlockEl = null
            this._mediaSource = null
            // File-based music tracks (looped) keyed by scene name.
            this.trackUrls = {
                overworld: "/static/music/background.ogg",
                battle: "/static/music/battle.ogg",
                victory: "/static/music/victory.ogg",
            }
            this.trackVolumes = { overworld: 0.5, battle: 0.55, victory: 0.62 }
            this.tracks = {}
            this.trackReady = {}
            this._trackBlobUrls = {}
            this.trackPreloadPromise = null
            this.currentTrack = null
        }

        tracksReady() {
            return Object.keys(this.trackUrls).every((name) => this.trackReady[name])
        }

        async _fetchTrack(name) {
            if (this.trackReady[name]) return
            const url = this.trackUrls[name]
            if (!url) return

            const res = await fetch(url, { cache: "force-cache" })
            if (!res.ok) throw new Error(`Music fetch failed: ${name}`)

            const blob = await res.blob()
            const blobUrl = URL.createObjectURL(blob)
            if (this._trackBlobUrls[name]) {
                try { URL.revokeObjectURL(this._trackBlobUrls[name]) } catch { /* ignore */ }
            }
            this._trackBlobUrls[name] = blobUrl

            const el = this._getTrack(name)
            const wasPlaying = this.currentTrack === name && !el.paused
            const resumeAt = wasPlaying ? el.currentTime : 0

            el.src = blobUrl

            await new Promise((resolve, reject) => {
                const onReady = () => { cleanup(); resolve() }
                const onErr = () => { cleanup(); reject(new Error(`Music decode failed: ${name}`)) }
                const cleanup = () => {
                    el.removeEventListener("canplaythrough", onReady)
                    el.removeEventListener("error", onErr)
                }
                if (el.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
                    resolve()
                    return
                }
                el.addEventListener("canplaythrough", onReady, { once: true })
                el.addEventListener("error", onErr, { once: true })
                el.load()
            })

            if (wasPlaying) {
                try { el.currentTime = resumeAt } catch { /* ignore */ }
                if (!this.muted) {
                    const p = el.play()
                    if (p && typeof p.catch === "function") p.catch(() => {})
                }
            }

            this.trackReady[name] = true
        }

        preloadTracks(opts = {}) {
            const names = Object.keys(this.trackUrls)
            if (this.tracksReady()) {
                opts.onProgress?.({ done: names.length, total: names.length, track: null, ready: true })
                return Promise.resolve(true)
            }
            if (this.trackPreloadPromise) return this.trackPreloadPromise

            const onProgress = opts.onProgress
            let completed = 0

            const report = (track) => {
                onProgress?.({
                    done: completed,
                    total: names.length,
                    track,
                    ready: this.tracksReady(),
                })
            }

            report(null)
            this.trackPreloadPromise = (async () => {
                await Promise.all(names.map(async (name) => {
                    if (this.trackReady[name]) {
                        completed += 1
                        report(name)
                        return
                    }
                    try {
                        await this._fetchTrack(name)
                    } catch (err) {
                        console.warn("Music preload:", name, err)
                    } finally {
                        completed += 1
                        report(name)
                    }
                }))
                return this.tracksReady()
            })()

            return this.trackPreloadPromise
        }

        async waitForTracks(opts = {}) {
            if (this.tracksReady()) return true

            const timeout = Number(opts.timeout) || 120000
            const deadline = Date.now() + timeout
            const onProgress = opts.onProgress

            while (Date.now() < deadline) {
                if (!this.trackPreloadPromise) {
                    this.preloadTracks({ onProgress })
                }
                try {
                    await this.trackPreloadPromise
                } catch {
                    /* retry below */
                }

                if (this.tracksReady()) return true

                this.trackPreloadPromise = null
                await new Promise((r) => setTimeout(r, 400))
            }

            throw new Error("Music download timed out. Check your connection and try again.")
        }

        _getTrack(name) {
            if (this.tracks[name]) return this.tracks[name]
            const url = this.trackUrls[name]
            if (!url) return null
            const el = new Audio()
            el.src = url
            el.preload = "auto"
            this._bindTrackPlayback(el, name)
            this.tracks[name] = el
            return el
        }

        _bindTrackPlayback(el, name) {
            if (name === "victory") {
                el.loop = false
                el.onended = () => {
                    if (this.currentTrack === "victory") this.playTrack("overworld")
                }
                return
            }
            // loop=false + onended restart: Chrome can loop OGG early when loop=true
            // if duration metadata is off — this plays the full decode before repeating.
            el.loop = false
            el.onended = () => {
                if (this.currentTrack !== name) return
                try { el.currentTime = 0 } catch { return }
                const p = el.play()
                if (p && typeof p.catch === "function") p.catch(() => {})
            }
        }

        _pauseAllTracks() {
            for (const el of Object.values(this.tracks)) {
                try { el.pause() } catch { /* ignore */ }
            }
        }

        _stopAllTracks(except = null) {
            for (const [n, el] of Object.entries(this.tracks)) {
                if (n === except) continue
                try {
                    el.pause()
                    el.currentTime = 0
                } catch { /* ignore */ }
            }
        }

        playTrack(name, { restart = false } = {}) {
            const el = this._getTrack(name)
            if (!el) return
            const vol = this.trackVolumes[name] ?? 0.5

            // Already the active track and running — just keep it (no restart jump).
            if (this.currentTrack === name && !el.paused && !restart) {
                el.volume = this.muted ? 0 : vol
                return
            }

            this._stopAllTracks(name)
            this.stopMusic()
            this.currentTrack = name
            this.scene = name
            el.volume = this.muted ? 0 : vol
            this._bindTrackPlayback(el, name)

            if (this.muted) {
                el.pause()
                return
            }
            if (restart) {
                try { el.currentTime = 0 } catch { /* ignore */ }
            }
            const p = el.play()
            if (p && typeof p.catch === "function") p.catch(() => { /* autoplay gate */ })
        }

        stopTrack() {
            this._stopAllTracks()
            this.currentTrack = null
        }

        ensureContext() {
            if (this.ctx) return this.ctx
            const Ctx = window.AudioContext || window.webkitAudioContext
            if (!Ctx) return null
            this.ctx = new Ctx()
            this.master = this.ctx.createGain()
            this.master.gain.value = 0.55
            this.master.connect(this.ctx.destination)

            this.musicGain = this.ctx.createGain()
            this.musicGain.gain.value = 0.42
            this.musicGain.connect(this.master)

            this.sfxGain = this.ctx.createGain()
            this.sfxGain.gain.value = 0.65
            this.sfxGain.connect(this.master)
            return this.ctx
        }

        async resume() {
            this.ensureContext()
            if (!this.ctx) return false
            if (this.ctx.state === "running") {
                this.unlocked = true
                return true
            }
            try {
                if (this.ctx.state === "suspended") await this.ctx.resume()
                this.unlocked = this.ctx.state === "running"
                return this.unlocked
            } catch {
                this.unlocked = false
                return false
            }
        }

        isMusicPlaying() {
            if (this.currentTrack) {
                const el = this.tracks[this.currentTrack]
                if (el && !el.paused) return true
            }
            return !!(this.timer && !this.muted && this.pattern)
        }

        _fadeMusicGain(targetVol, durationSec) {
            if (!this.ctx || !this.musicGain || durationSec <= 0) return
            const now = this.ctx.currentTime
            const target = Math.max(targetVol, 0.0001)
            this.musicGain.gain.cancelScheduledValues(now)
            this.musicGain.gain.setValueAtTime(0.0001, now)
            this.musicGain.gain.exponentialRampToValueAtTime(target, now + durationSec)
        }

        primeScene(name) {
            this._pendingScene = name
            this.ensureContext()
            this.stopMusic()
            this.stopTrack()
            if (this.ctx && this.musicGain) {
                const now = this.ctx.currentTime
                this.musicGain.gain.cancelScheduledValues(now)
                this.musicGain.gain.setValueAtTime(0.0001, now)
            }
        }

        _applyScene(name, force = false) {
            this._fadeInSec = 0
            switch (name) {
                case "overworld":
                    // In-game background music track.
                    this.playTrack("overworld")
                    break
                case "battle":
                    this.playTrack("battle", { restart: force })
                    break
                case "victory":
                    this.playTrack("victory", { restart: true })
                    break
                case "dialogue":
                    // Keep the background track playing under NPC dialogue.
                    this.playTrack("overworld")
                    break
                case "menu":
                    // No music on landing/menu screens.
                    this.stopTrack()
                    this.stopMusic()
                    this.scene = "menu"
                    break
                case "vending":
                case "machine":
                    this.stopTrack()
                    this.stopMusic()
                    this.scene = "machine"
                    break
                case "silent":
                    this.stopTrack()
                    this.stopMusic()
                    this.scene = "silent"
                    break
                default:
                    break
            }
        }

        async _tryStartPendingScene(force = false) {
            if (!this._pendingScene) return false
            if (!force && this.isMusicPlaying() && this.scene === this._pendingScene) {
                await this.resume()
                return true
            }
            const ok = await this.resume()
            if (!ok) return false
            this._applyScene(this._pendingScene, force)
            return true
        }

        _wireMediaUnlock(mediaEl) {
            if (!mediaEl || this._mediaSource) return
            this.ensureContext()
            if (!this.ctx) return
            try {
                this._mediaSource = this.ctx.createMediaElementSource(mediaEl)
                this._mediaSource.connect(this.master)
                this._mediaUnlockEl = mediaEl
            } catch {
                /* element may already be routed */
            }
        }

        async unlockFromMediaElement(mediaEl) {
            if (!mediaEl) return false
            this.ensureContext()
            mediaEl.muted = true
            mediaEl.loop = true
            this._wireMediaUnlock(mediaEl)
            try {
                await mediaEl.play()
            } catch {
                return false
            }
            return this.resume()
        }

        async startWithMediaUnlock(name, mediaEl, opts = {}) {
            this.ensureContext()
            if (!this.ctx) return false
            this._pendingScene = name
            this._fadeInSec = Number(opts.fadeIn) || 0
            if (this.muted) return false
            this.muted = false
            if (this.master) this.master.gain.value = 0.55

            if (mediaEl) {
                mediaEl.muted = true
                mediaEl.loop = true
                this._wireMediaUnlock(mediaEl)
                try {
                    await mediaEl.play()
                } catch {
                    /* muted autoplay may already be running */
                }
            }

            try {
                if (this.ctx.state === "suspended") await this.ctx.resume()
            } catch {
                return false
            }

            if (this.ctx.state !== "running") return false
            this.unlocked = true
            this._applyScene(name, true)
            return this.isMusicPlaying()
        }

        async tryAutoplay(name, mediaEl = null, opts = {}) {
            const started = await this.startWithMediaUnlock(name, mediaEl, opts)
            if (started) return true

            this._pendingScene = name
            this._fadeInSec = Number(opts.fadeIn) || 0
            for (let i = 0; i < 20; i += 1) {
                if (await this._tryStartPendingScene(true)) return true
                await new Promise((resolve) => setTimeout(resolve, 120))
            }
            return false
        }

        bindUnlock() {
            if (this._unlockBound) return
            this._unlockBound = true
            const unlock = () => {
                if (this.muted) return
                void (async () => {
                    await this.resume()
                    if (this.isMusicPlaying()) return
                    if (this._pendingScene) await this._tryStartPendingScene(false)
                })()
            }
            document.addEventListener("pointerdown", unlock, { once: false, passive: true })
            document.addEventListener("keydown", unlock, { once: false, passive: true })
            document.addEventListener("touchstart", unlock, { once: false, passive: true })
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) return
                void (async () => {
                    await this.resume()
                    // Resume the current file track without restarting from 0.
                    if (this.currentTrack && !this.muted) {
                        const el = this.tracks[this.currentTrack]
                        if (el && el.paused) {
                            const p = el.play()
                            if (p && typeof p.catch === "function") p.catch(() => {})
                        }
                    }
                })()
            })
        }

        noteFreq(name) {
            return name ? NOTES[name] || null : null
        }

        playTone(freq, when, duration, type = "square", dest, volume = 0.12) {
            if (!this.ctx || !freq || this.muted) return
            const osc = this.ctx.createOscillator()
            const gain = this.ctx.createGain()
            osc.type = type
            osc.frequency.setValueAtTime(freq, when)
            gain.gain.setValueAtTime(0.0001, when)
            gain.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0002), when + 0.012)
            gain.gain.exponentialRampToValueAtTime(0.0001, when + duration)
            osc.connect(gain)
            gain.connect(dest || this.sfxGain)
            osc.start(when)
            osc.stop(when + duration + 0.02)
        }

        playNoise(when, duration, volume = 0.08) {
            if (!this.ctx || this.muted) return
            const bufferSize = this.ctx.sampleRate * duration
            const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate)
            const data = buffer.getChannelData(0)
            for (let i = 0; i < bufferSize; i += 1) {
                data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize)
            }
            const src = this.ctx.createBufferSource()
            src.buffer = buffer
            const gain = this.ctx.createGain()
            gain.gain.value = volume
            src.connect(gain)
            gain.connect(this.sfxGain)
            src.start(when)
            src.stop(when + duration)
        }

        beatDuration() {
            return 60 / this.tempo / 2
        }

        stopMusic() {
            if (this.timer) {
                clearInterval(this.timer)
                this.timer = null
            }
            this.step = 0
        }

        scheduleStep() {
            if (!this.ctx || !this.pattern || this.muted) return
            const row = this.pattern[this.step % this.pattern.length]
            const t = this.ctx.currentTime + 0.02
            const dur = this.beatDuration() * 0.92

            const melVol = this.scene === "dialogue" ? 0.06 : 0.11
            const bassVol = this.scene === "dialogue" ? 0.08 : 0.14

            if (row.m) {
                this.playTone(this.noteFreq(row.m), t, dur, "square", this.musicGain, melVol)
            }
            if (row.b) {
                this.playTone(this.noteFreq(row.b), t, dur * 1.1, "triangle", this.musicGain, bassVol)
            }
            if (row.h && this.step % 2 === 0) {
                this.playNoise(t, 0.04, 0.05)
            } else if (!row.h && this.step % 4 === 0) {
                this.playNoise(t, 0.025, 0.035)
            }

            this.step += 1
        }

        startLoop(scene, pattern, tempo, musicVol, force = false, fadeInSec = 0) {
            if (!force && this.scene === scene && this.timer) return
            this.stopMusic()
            this.scene = scene
            this.pattern = pattern
            this.tempo = tempo
            if (fadeInSec > 0) {
                this._fadeMusicGain(musicVol, fadeInSec)
            } else if (this.musicGain) {
                this.musicGain.gain.value = musicVol
            }
            this.scheduleStep()
            this.timer = setInterval(() => this.scheduleStep(), this.beatDuration() * 1000)
        }

        setScene(name, opts = {}) {
            const force = !!(opts && opts.restart)
            this._fadeInSec = Number(opts.fadeIn) || 0
            this._pendingScene = name
            if (this.muted) return
            this.ensureContext()
            if (!force && this.isMusicPlaying() && this.scene === name) {
                void this.resume()
                return
            }
            void this._tryStartPendingScene(force)
        }

        restartScene() {
            if (!this._pendingScene && this.scene && this.scene !== "silent") {
                this._pendingScene = this.scene
            }
            if (!this._pendingScene) this._pendingScene = "menu"
            void this._tryStartPendingScene(true)
        }

        sfx(name) {
            this.ensureContext()
            if (!this.ctx || this.muted) return
            const t = this.ctx.currentTime

            switch (name) {
                case "encounter": {
                    const seq = [
                        [988, 0.09, 0.14],
                        [988, 0.09, 0.14],
                        [0, 0.04, 0],
                        [1047, 0.09, 0.14],
                        [0, 0.04, 0],
                        [784, 0.1, 0.13],
                        [0, 0.04, 0],
                        [988, 0.09, 0.14],
                        [1175, 0.22, 0.16],
                    ]
                    let at = t
                    for (const [freq, dur, vol] of seq) {
                        if (freq > 0) this.playTone(freq, at, dur, "square", this.sfxGain, vol)
                        at += dur
                    }
                    this.playNoise(t, 0.06, 0.06)
                    break
                }
                case "text":
                    this.playTone(920, t, 0.035, "square", this.sfxGain, 0.07)
                    break
                case "interact":
                    this.playTone(660, t, 0.05, "square", this.sfxGain, 0.09)
                    this.playTone(880, t + 0.06, 0.06, "triangle", this.sfxGain, 0.08)
                    break
                case "select":
                    this.playTone(523, t, 0.045, "square", this.sfxGain, 0.08)
                    break
                case "confirm":
                    this.playTone(523, t, 0.06, "square", this.sfxGain, 0.09)
                    this.playTone(659, t + 0.07, 0.06, "square", this.sfxGain, 0.09)
                    this.playTone(784, t + 0.14, 0.1, "square", this.sfxGain, 0.1)
                    break
                case "cancel":
                    this.playTone(392, t, 0.08, "triangle", this.sfxGain, 0.08)
                    break
                case "beep":
                    this.playTone(880, t, 0.07, "square", this.sfxGain, 0.06)
                    break
                default:
                    break
            }
        }

        /** Drop-in for vending machine square beeps */
        beep(freq = 880, duration = 0.07, volume = 0.06) {
            this.ensureContext()
            if (!this.ctx || this.muted) return
            this.playTone(freq, this.ctx.currentTime, duration, "square", this.sfxGain, volume)
        }

        setMuted(muted) {
            this.muted = !!muted
            try {
                localStorage.setItem(AUDIO_MUTED_STORAGE_KEY, this.muted ? "1" : "0")
            } catch {
                /* ignore */
            }
            if (this.muted) {
                this.stopMusic()
                this._pauseAllTracks()
                if (this.master) this.master.gain.value = 0
                return true
            }
            if (this.master) this.master.gain.value = 0.55
            const scene =
                this.scene && this.scene !== "silent"
                    ? this.scene
                    : this._pendingScene && this._pendingScene !== "silent"
                      ? this._pendingScene
                      : "silent"
            this._pendingScene = scene
            void this._tryStartPendingScene(true)
            return false
        }

        toggleMuted() {
            return this.setMuted(!this.muted)
        }

        isMuted() {
            return this.muted
        }
    }

    const AUDIO_MUTED_STORAGE_KEY = "pokequest_audio_muted"
    const engine = new RetroAudioEngine()
    engine.bindUnlock()
    try {
        if (localStorage.getItem(AUDIO_MUTED_STORAGE_KEY) === "1") {
            engine.setMuted(true)
        }
    } catch {
        /* ignore */
    }

    window.RetroAudio = {
        resume: () => engine.resume(),
        setScene: (name, opts) => engine.setScene(name, opts),
        primeScene: (name) => engine.primeScene(name),
        restartScene: () => engine.restartScene(),
        isMusicPlaying: () => engine.isMusicPlaying(),
        startWithMediaUnlock: (name, mediaEl, opts) => engine.startWithMediaUnlock(name, mediaEl, opts),
        tryAutoplay: (name, mediaEl, opts) => engine.tryAutoplay(name, mediaEl, opts),
        unlockFromMediaElement: (mediaEl) => engine.unlockFromMediaElement(mediaEl),
        setMuted: (muted) => engine.setMuted(muted),
        toggleMuted: () => engine.toggleMuted(),
        isMuted: () => engine.isMuted(),
        sfx: (name) => engine.sfx(name),
        beep: (freq, dur, vol) => engine.beep(freq, dur, vol),
        preloadTracks: (opts) => engine.preloadTracks(opts),
        waitForTracks: (opts) => engine.waitForTracks(opts),
        tracksReady: () => engine.tracksReady(),
    }
})()
