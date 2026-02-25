// ============================================================
// こはだジャンプ～BAKENEKOドリーム～ Sound System
// Web Audio API procedural music & SFX (no external files needed)
// ============================================================

const Sound = {
    ctx: null,
    masterGain: null,
    bgmGain: null,
    sfxGain: null,
    bgmPlaying: false,
    bgmNodes: [],
    muted: false,

    // ─── Init ───
    init() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.5;
        this.masterGain.connect(this.ctx.destination);

        this.bgmGain = this.ctx.createGain();
        this.bgmGain.gain.value = 0.35;
        this.bgmGain.connect(this.masterGain);

        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.value = 0.6;
        this.sfxGain.connect(this.masterGain);
    },

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume().then(() => {
                console.log('AudioContext resumed');
            });
        }
    },

    // Mobile Audio Unlock (iOS requires playing a sound in user event)
    unlock() {
        if (!this.ctx) this.init();
        if (this.ctx.state === 'running') return;

        // Play silent buffer
        const buffer = this.ctx.createBuffer(1, 1, 22050);
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.ctx.destination);
        if (source.start) source.start(0);
        else source.noteOn(0);

        this.resume();
    },

    toggleMute() {
        this.muted = !this.muted;
        this.masterGain.gain.value = this.muted ? 0 : 0.5;
        return this.muted;
    },

    // ─── Note helpers ───
    noteFreq(note, octave) {
        const notes = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        const n = notes[note[0]] + (note.includes('#') ? 1 : note.includes('b') ? -1 : 0);
        return 440 * Math.pow(2, (n - 9) / 12 + (octave - 4));
    },

    // ─── BGM: Catchy chiptune loop ───
    startBGM(type) {
        this.stopBGM();
        if (!this.ctx) this.init();
        this.resume();

        if (type === 'title') this._playTitleBGM();
        else if (type === 'flying') this._playFlyingBGM();
        else if (type === 'result') this._playResultBGM();
    },

    stopBGM() {
        // Clear loop timer to prevent duplicate playback
        if (this._bgmTimer) {
            clearTimeout(this._bgmTimer);
            this._bgmTimer = null;
        }
        this.bgmNodes.forEach(n => { try { n.stop(); } catch (e) { } });
        this.bgmNodes = [];
        this.bgmPlaying = false;
    },

    // ── Title BGM: Chill jazzy loop ──
    _playTitleBGM() {
        const bpm = 110;
        const beatLen = 60 / bpm;
        const barLen = beatLen * 4;
        const loopLen = barLen * 4;

        // Melody (cute, catchy tune)
        const melody = [
            // Bar 1
            ['E5', 0, 0.4], ['G5', 0.5, 0.3], ['A5', 1, 0.5], ['G5', 1.5, 0.3],
            ['E5', 2, 0.4], ['D5', 2.5, 0.3], ['C5', 3, 0.8],
            // Bar 2
            ['D5', 4, 0.4], ['E5', 4.5, 0.3], ['G5', 5, 0.5], ['A5', 5.5, 0.3],
            ['B5', 6, 0.4], ['A5', 6.5, 0.3], ['G5', 7, 0.8],
            // Bar 3
            ['A5', 8, 0.4], ['B5', 8.5, 0.3], ['C6', 9, 0.6], ['B5', 9.5, 0.3],
            ['A5', 10, 0.4], ['G5', 10.5, 0.3], ['E5', 11, 0.8],
            // Bar 4
            ['G5', 12, 0.4], ['E5', 12.5, 0.3], ['D5', 13, 0.5], ['C5', 13.5, 0.3],
            ['D5', 14, 0.4], ['E5', 14.5, 0.3], ['C5', 15, 1.0],
        ];

        // Bass line
        const bass = [
            ['C3', 0, 3.8], ['A2', 4, 3.8], ['F3', 8, 3.8], ['G3', 12, 3.8],
        ];

        this._loopPattern(melody, bass, loopLen, 'triangle', 'sine', bpm);
    },

    // ── Flying BGM: Energetic fast loop ──
    _playFlyingBGM() {
        const bpm = 160;
        const beatLen = 60 / bpm;
        const barLen = beatLen * 4;
        const loopLen = barLen * 4;

        const melody = [
            // Bar 1 - driving ascending
            ['C5', 0, 0.2], ['E5', 0.25, 0.2], ['G5', 0.5, 0.2], ['C6', 0.75, 0.3],
            ['B5', 1, 0.2], ['G5', 1.25, 0.2], ['A5', 1.5, 0.5],
            ['G5', 2, 0.2], ['A5', 2.25, 0.2], ['B5', 2.5, 0.2], ['C6', 2.75, 0.5],
            ['D6', 3, 0.2], ['C6', 3.25, 0.2], ['B5', 3.5, 0.4],
            // Bar 2
            ['E5', 4, 0.2], ['G5', 4.25, 0.2], ['A5', 4.5, 0.2], ['B5', 4.75, 0.3],
            ['C6', 5, 0.4], ['A5', 5.5, 0.4],
            ['G5', 6, 0.2], ['A5', 6.25, 0.2], ['G5', 6.5, 0.2], ['E5', 6.75, 0.2],
            ['D5', 7, 0.3], ['E5', 7.5, 0.4],
            // Bar 3 - intense
            ['C6', 8, 0.15], ['D6', 8.25, 0.15], ['E6', 8.5, 0.3], ['D6', 8.75, 0.2],
            ['C6', 9, 0.2], ['B5', 9.25, 0.2], ['A5', 9.5, 0.4],
            ['B5', 10, 0.2], ['C6', 10.25, 0.2], ['D6', 10.5, 0.3], ['E6', 10.75, 0.15],
            ['D6', 11, 0.2], ['C6', 11.25, 0.2], ['B5', 11.5, 0.4],
            // Bar 4 - resolve
            ['A5', 12, 0.3], ['C6', 12.5, 0.3], ['E6', 13, 0.5],
            ['D6', 13.5, 0.2], ['C6', 13.75, 0.2], ['B5', 14, 0.3],
            ['A5', 14.5, 0.2], ['G5', 14.75, 0.2], ['C5', 15, 0.8],
        ];

        const bass = [
            ['C3', 0, 0.3], ['C3', 0.5, 0.3], ['C3', 1, 0.3], ['C3', 1.5, 0.3],
            ['C3', 2, 0.3], ['C3', 2.5, 0.3], ['G2', 3, 0.3], ['G2', 3.5, 0.3],
            ['A2', 4, 0.3], ['A2', 4.5, 0.3], ['A2', 5, 0.3], ['A2', 5.5, 0.3],
            ['F2', 6, 0.3], ['F2', 6.5, 0.3], ['G2', 7, 0.3], ['G2', 7.5, 0.3],
            ['A2', 8, 0.3], ['A2', 8.5, 0.3], ['A2', 9, 0.3], ['A2', 9.5, 0.3],
            ['F2', 10, 0.3], ['F2', 10.5, 0.3], ['G2', 11, 0.3], ['G2', 11.5, 0.3],
            ['F2', 12, 0.3], ['F2', 12.5, 0.3], ['G2', 13, 0.5],
            ['G2', 14, 0.3], ['G2', 14.5, 0.3], ['C3', 15, 0.8],
        ];

        this._loopPattern(melody, bass, loopLen, 'square', 'triangle', bpm);
    },

    // ── Result BGM: Short fanfare then chill ──
    _playResultBGM() {
        const bpm = 100;
        const beatLen = 60 / bpm;
        const barLen = beatLen * 4;
        const loopLen = barLen * 4;

        const melody = [
            ['C5', 0, 0.3], ['E5', 0.3, 0.3], ['G5', 0.6, 0.3], ['C6', 1, 0.8],
            ['B5', 2, 0.4], ['A5', 2.5, 0.4], ['G5', 3, 0.8],
            ['A5', 4, 0.4], ['G5', 4.5, 0.3], ['E5', 5, 0.8],
            ['D5', 6, 0.4], ['E5', 6.5, 0.3], ['C5', 7, 1.0],
            ['E5', 8, 0.3], ['G5', 8.5, 0.3], ['A5', 9, 0.5],
            ['G5', 10, 0.4], ['E5', 10.5, 0.3], ['D5', 11, 0.8],
            ['E5', 12, 0.4], ['G5', 12.5, 0.3], ['A5', 13, 0.4],
            ['G5', 13.5, 0.3], ['E5', 14, 0.4], ['C5', 15, 1.0],
        ];

        const bass = [
            ['C3', 0, 3.8], ['F3', 4, 3.8], ['A2', 8, 3.8], ['G2', 12, 3.8],
        ];

        this._loopPattern(melody, bass, loopLen, 'triangle', 'sine', bpm);
    },

    _loopPattern(melody, bass, loopLen, melodyWave, bassWave, bpm) {
        const beatLen = 60 / bpm;
        this.bgmPlaying = true;

        const playLoop = () => {
            if (!this.bgmPlaying) return;
            const now = this.ctx.currentTime + 0.05;
            const endTime = now + loopLen + 0.1;
            this.bgmNodes = this.bgmNodes.filter(n => {
                try { return n._stopTime > now; } catch (e) { return false; }
            });

            for (const [note, beat, dur] of melody) {
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = melodyWave;
                osc.frequency.value = this._parseNote(note);
                const t = now + beat * beatLen;
                const d = dur * beatLen;
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(0.15, t + 0.02);
                gain.gain.linearRampToValueAtTime(0.1, t + d * 0.5);
                gain.gain.linearRampToValueAtTime(0, t + d);
                osc.connect(gain);
                gain.connect(this.bgmGain);
                osc.start(t);
                osc.stop(t + d + 0.01);
                osc._stopTime = t + d + 0.01;
                this.bgmNodes.push(osc);
            }

            for (const [note, beat, dur] of bass) {
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = bassWave;
                osc.frequency.value = this._parseNote(note);
                const t = now + beat * beatLen;
                const d = dur * beatLen;
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(0.12, t + 0.03);
                gain.gain.linearRampToValueAtTime(0.08, t + d * 0.7);
                gain.gain.linearRampToValueAtTime(0, t + d);
                osc.connect(gain);
                gain.connect(this.bgmGain);
                osc.start(t);
                osc.stop(t + d + 0.01);
                osc._stopTime = t + d + 0.01;
                this.bgmNodes.push(osc);
            }

            this._bgmTimer = setTimeout(() => playLoop(), loopLen * 1000 - 50);
        };

        playLoop();
    },

    _parseNote(note) {
        const match = note.match(/^([A-G]#?)(\d)$/);
        if (!match) return 440;
        return this.noteFreq(match[1], parseInt(match[2]));
    },

    // ─── SFX ───
    playCharge() {
        if (!this.ctx) return;
        this.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(600, this.ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start();
        osc.stop(this.ctx.currentTime + 0.35);
    },

    playLaunch() {
        if (!this.ctx) return;
        this.resume();
        const t = this.ctx.currentTime;
        // Whoosh
        const noise = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        noise.type = 'sawtooth';
        noise.frequency.setValueAtTime(200, t);
        noise.frequency.exponentialRampToValueAtTime(1500, t + 0.15);
        noise.frequency.exponentialRampToValueAtTime(100, t + 0.5);
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
        noise.connect(gain);
        gain.connect(this.sfxGain);
        noise.start(t);
        noise.stop(t + 0.55);

        // Glass break
        setTimeout(() => this._playGlassBreak(), 200);
    },

    _playGlassBreak() {
        const t = this.ctx.currentTime;
        for (let i = 0; i < 5; i++) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = 2000 + Math.random() * 4000;
            gain.gain.setValueAtTime(0.08, t + i * 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.02 + 0.1);
            osc.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(t + i * 0.02);
            osc.stop(t + i * 0.02 + 0.12);
        }
    },

    playBoost() {
        if (!this.ctx) return;
        this.resume();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(800, t + 0.1);
        osc.frequency.exponentialRampToValueAtTime(1200, t + 0.3);
        osc.frequency.exponentialRampToValueAtTime(200, t + 0.6);
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.linearRampToValueAtTime(0.25, t + 0.1);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.6);
        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.65);

        // Explosion sub-bass
        const sub = this.ctx.createOscillator();
        const subG = this.ctx.createGain();
        sub.type = 'sine';
        sub.frequency.value = 60;
        subG.gain.setValueAtTime(0.3, t);
        subG.gain.exponentialRampToValueAtTime(0.01, t + 0.4);
        sub.connect(subG);
        subG.connect(this.sfxGain);
        sub.start(t);
        sub.stop(t + 0.45);
    },

    playMilestone() {
        if (!this.ctx) return;
        this.resume();
        const t = this.ctx.currentTime;
        const notes = [523, 659, 784, 1047]; // C5, E5, G5, C6
        notes.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.value = freq;
            const start = t + i * 0.1;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.15, start + 0.03);
            gain.gain.linearRampToValueAtTime(0.1, start + 0.15);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
            osc.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(start);
            osc.stop(start + 0.45);
        });
    },

    playLand() {
        if (!this.ctx) return;
        this.resume();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, t);
        osc.frequency.exponentialRampToValueAtTime(50, t + 0.3);
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.35);
    },

    playGaugeStop() {
        if (!this.ctx) return;
        this.resume();
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(gain);
        gain.connect(this.sfxGain);
        osc.start(t);
        osc.stop(t + 0.1);
    },

    playGoal() {
        if (!this.ctx) return;
        this.resume();
        const t = this.ctx.currentTime;
        // Victory fanfare
        const fanfare = [
            [523, 0], [659, 0.15], [784, 0.3], [1047, 0.45],
            [988, 0.7], [1047, 0.85], [1319, 1.0], [1568, 1.2],
        ];
        fanfare.forEach(([freq, delay]) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, t + delay);
            gain.gain.linearRampToValueAtTime(0.15, t + delay + 0.03);
            gain.gain.linearRampToValueAtTime(0.1, t + delay + 0.2);
            gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.5);
            osc.connect(gain);
            gain.connect(this.sfxGain);
            osc.start(t + delay);
            osc.stop(t + delay + 0.55);
        });
    }
};
