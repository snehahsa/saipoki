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
            if (this.ctx && this.musicGain) {
                const now = this.ctx.currentTime
                this.musicGain.gain.cancelScheduledValues(now)
                this.musicGain.gain.setValueAtTime(0.0001, now)
            }
        }

        _applyScene(name, force = false) {
            const fadeIn = this._fadeInSec || 0
            this._fadeInSec = 0
            switch (name) {
                case "menu":
                    this.startLoop("menu", MENU_PATTERN, 118, 0.38, force, fadeIn)
                    break
                case "overworld":
                    this.startLoop("overworld", OVERWORLD_PATTERN, 132, 0.42, force, fadeIn)
                    break
                case "dialogue":
                    this.startLoop("dialogue", DIALOGUE_PATTERN, 100, 0.28, force, fadeIn)
                    break
                case "vending":
                case "machine":
                    this.stopMusic()
                    this.scene = "machine"
                    break
                case "silent":
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
            this.muted = false
            this._pendingScene = name
            this._fadeInSec = Number(opts.fadeIn) || 0
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
                if (!document.hidden) void this.resume()
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
            this.ensureContext()
            if (!force && this.isMusicPlaying() && this.scene === name) {
                void this.resume()
                return
            }
            this._pendingScene = name
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
            if (this.muted) {
                this.stopMusic()
                if (this.master) this.master.gain.value = 0
                return true
            }
            if (this.master) this.master.gain.value = 0.55
            const scene =
                this.scene && this.scene !== "silent"
                    ? this.scene
                    : this._pendingScene && this._pendingScene !== "silent"
                      ? this._pendingScene
                      : "menu"
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

    const engine = new RetroAudioEngine()
    engine.bindUnlock()

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
    }
})()
