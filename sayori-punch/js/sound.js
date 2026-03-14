// ============================================================
// Tone.js Sound System Template (BAKENEKO GAMES)
// CDN: https://cdnjs.cloudflare.com/ajax/libs/tone/15.3.5/Tone.min.js
//
// 音量基準: こはだジャンプ実測値
//   master 0.5 (-6dB) / BGM 0.35 (-9dB) / SFX 0.6 (-4.4dB)
//
// ES5 呼び出し互換: var, function, .then() のみ使用
// ============================================================

var GameSound = (function () {
  'use strict';

  var _started = false;
  var _muted = false;

  // ─── Channel (Tone.Channel) ───
  var _master = null;
  var _bgmCh = null;
  var _sfxCh = null;

  // ─── BGM state ───
  var _bgmSeq = null;
  var _bgmSynths = [];
  var _bgmType = '';

  // ─── SE synths (事前生成・再利用) ───
  var _se = {};

  // ─── dB helpers ───
  function gainToDb(g) { return 20 * Math.log10(Math.max(g, 0.0001)); }

  // ============================================================
  //  init — ページ読み込み時に呼ぶ（Tone.start 前でも可）
  // ============================================================
  function init() {
    if (_master) return;

    _master = new Tone.Channel({ volume: gainToDb(0.5) }).toDestination();
    _bgmCh  = new Tone.Channel({ volume: gainToDb(0.35) }).connect(_master);
    _sfxCh  = new Tone.Channel({ volume: gainToDb(0.6) }).connect(_master);

    _buildSE();
  }

  // ============================================================
  //  unlock — ユーザー操作のコールバック内で呼ぶ（必須）
  // ============================================================
  function unlock() {
    if (_started) return Promise.resolve();
    init();
    return Tone.start().then(function () {
      _started = true;
    });
  }

  // ============================================================
  //  toggleMute
  // ============================================================
  function toggleMute() {
    _muted = !_muted;
    if (_master) _master.volume.value = _muted ? -Infinity : gainToDb(0.5);
    return _muted;
  }

  function isMuted() { return _muted; }

  // ============================================================
  //  SE 定義 — ゲームごとにここをカスタマイズ
  // ============================================================
  function _buildSE() {

    // --- countdown (3,2,1) ---
    _se.countdown = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.06, sustain: 0, release: 0.02 }
    }).connect(_sfxCh);

    // --- start! ---
    _se.start = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.15, sustain: 0.1, release: 0.15 }
    }).connect(_sfxCh);

    // --- punch (swipe noise) ---
    _se.punch = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.003, decay: 0.08, sustain: 0, release: 0.01 }
    }).connect(_sfxCh);
    _se.punch.volume.value = -8;

    // --- hit (strike) ---
    _se.hit = new Tone.MembraneSynth({
      pitchDecay: 0.02,
      octaves: 2,
      envelope: { attack: 0.002, decay: 0.1, sustain: 0, release: 0.05 }
    }).connect(_sfxCh);

    // --- miss (buzz) ---
    _se.miss = new Tone.Synth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.005, decay: 0.15, sustain: 0, release: 0.05 }
    }).connect(_sfxCh);

    // --- combo10 (arpeggio shimmer) ---
    _se.combo10 = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.05, release: 0.2 }
    }).connect(_sfxCh);

    // --- bomb_cutin (deep impact) ---
    _se.bombCutin = new Tone.MembraneSynth({
      pitchDecay: 0.15,
      octaves: 6,
      envelope: { attack: 0.01, decay: 0.6, sustain: 0, release: 0.3 }
    }).connect(_sfxCh);

    var _bombCutinVerb = new Tone.Reverb({ decay: 1.5, wet: 0.5 }).connect(_sfxCh);
    _se.bombCutin.connect(_bombCutinVerb);

    // --- bomb_fire (explosion burst) ---
    _se.bombFire = new Tone.NoiseSynth({
      noise: { type: 'brown' },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.05, release: 0.15 }
    }).connect(_sfxCh);

    // --- bomb_hit (light tap — auto-kill during bomb) ---
    _se.bombHit = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.002, decay: 0.04, sustain: 0, release: 0.01 }
    }).connect(_sfxCh);
    _se.bombHit.volume.value = -10;

    // --- near_death (heartbeat) ---
    _se.nearDeath = new Tone.MembraneSynth({
      pitchDecay: 0.05,
      octaves: 3,
      envelope: { attack: 0.01, decay: 0.25, sustain: 0, release: 0.1 }
    }).connect(_sfxCh);

    // --- gameover (heavy impact + descend) ---
    _se.gameover = new Tone.Synth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.01, decay: 0.5, sustain: 0.1, release: 0.3 }
    }).connect(_sfxCh);

    var _goVerb = new Tone.Reverb({ decay: 2.0, wet: 0.4 }).connect(_sfxCh);
    _se.gameover.connect(_goVerb);

    // --- stun_end (chime) ---
    _se.stunEnd = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0, release: 0.05 }
    }).connect(_sfxCh);

    // --- zone_enter ---
    _se.zoneEnter = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.05, decay: 0.3, sustain: 0.1, release: 0.3 }
    }).connect(_sfxCh);

    // --- hell_enter ---
    _se.hellEnter = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.02, decay: 0.4, sustain: 0.1, release: 0.3 }
    }).connect(_sfxCh);
  }

  // ============================================================
  //  SE 再生 — Phaser から setTimeout(fn,0) 経由で呼ぶ
  // ============================================================

  function playCountdown() {
    if (!_started) return;
    _se.countdown.triggerAttackRelease('A5', '32n');
  }

  function playStart() {
    if (!_started) return;
    var now = Tone.now();
    _se.start.triggerAttackRelease('C5', '16n', now);
    _se.start.triggerAttackRelease('E5', '16n', now + 0.08);
    _se.start.triggerAttackRelease('G5', '16n', now + 0.16);
    _se.start.triggerAttackRelease('C6', '8n',  now + 0.24);
  }

  function playPunch() {
    if (!_started) return;
    _se.punch.triggerAttackRelease('16n');
  }

  function playHit(combo) {
    if (!_started) return;
    var note = 'C5';
    if (combo >= 30) note = 'F5';
    else if (combo >= 10) note = 'D5';
    _se.hit.triggerAttackRelease(note, '32n');
  }

  function playMiss() {
    if (!_started) return;
    _se.miss.triggerAttackRelease('E2', '16n');
  }

  function playCombo10(combo) {
    if (!_started) return;
    var now = Tone.now();
    _se.combo10.triggerAttackRelease('E5', '16n', now);
    _se.combo10.triggerAttackRelease('G5', '16n', now + 0.06);
    _se.combo10.triggerAttackRelease('B5', '16n', now + 0.12);
    _se.combo10.triggerAttackRelease('E6', '8n',  now + 0.18);
  }

  function playBombCutin() {
    if (!_started) return;
    _se.bombCutin.triggerAttackRelease('C1', '2n');
  }

  function playBombFire() {
    if (!_started) return;
    _se.bombFire.triggerAttackRelease('4n');
  }

  function playBombHit() {
    if (!_started) return;
    _se.bombHit.triggerAttackRelease('E6', '64n');
  }

  function playNearDeath() {
    if (!_started) return;
    _se.nearDeath.triggerAttackRelease('G2', '8n');
  }

  function playGameover() {
    if (!_started) return;
    var now = Tone.now();
    _se.gameover.triggerAttackRelease('A3', '4n', now);
    _se.gameover.frequency.linearRampTo('E2', 0.6, now);
  }

  function playStunEnd() {
    if (!_started) return;
    _se.stunEnd.triggerAttackRelease('G5', '32n');
  }

  function playZoneEnter() {
    if (!_started) return;
    var now = Tone.now();
    _se.zoneEnter.triggerAttackRelease(['A4', 'C5', 'E5'], '8n', now);
  }

  function playHellEnter() {
    if (!_started) return;
    var now = Tone.now();
    _se.hellEnter.triggerAttackRelease(['E4', 'G#4', 'B4'], '8n', now);
  }

  // ============================================================
  //  BGM — Tone.Sequence ループ
  // ============================================================

  function startBGM(type) {
    if (!_started) return;
    stopBGM();
    _bgmType = type;

    if (type === 'title')  _playTitleBGM();
    else if (type === 'play')   _playPlayBGM();
    else if (type === 'zone')   _playZoneBGM();
    else if (type === 'hell')   _playHellBGM();
    else if (type === 'bomb')   _playBombBGM();
    else if (type === 'result') _playResultBGM();

    Tone.getTransport().start();
  }

  function stopBGM() {
    Tone.getTransport().stop();
    Tone.getTransport().cancel();
    if (_bgmSeq) { _bgmSeq.dispose(); _bgmSeq = null; }
    for (var i = 0; i < _bgmSynths.length; i++) {
      try { _bgmSynths[i].dispose(); } catch (e) {}
    }
    _bgmSynths = [];
    _bgmType = '';
  }

  function getBGMType() { return _bgmType; }

  // Near-Death: BGM にローパスフィルタをかける
  var _ndFilter = null;

  function setBGMLowpass(on) {
    if (!_bgmCh) return;
    if (on && !_ndFilter) {
      _ndFilter = new Tone.Filter({ frequency: 400, type: 'lowpass' }).connect(_master);
      _bgmCh.disconnect(_master);
      _bgmCh.connect(_ndFilter);
    } else if (!on && _ndFilter) {
      _bgmCh.disconnect(_ndFilter);
      _bgmCh.connect(_master);
      _ndFilter.dispose();
      _ndFilter = null;
    }
  }

  // Bomb cutin: BGM一時ミュート
  function muteBGMTemp(mute) {
    if (!_bgmCh) return;
    _bgmCh.volume.value = mute ? -Infinity : gainToDb(0.35);
  }

  // ─── Title BGM: ゆるいループ (100 BPM, Cm) ───
  function _playTitleBGM() {
    Tone.getTransport().bpm.value = 100;

    var mel = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.15, release: 0.3 }
    }).connect(_bgmCh);
    mel.volume.value = -2;

    var bass = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.03, decay: 0.3, sustain: 0.2, release: 0.3 }
    }).connect(_bgmCh);
    bass.volume.value = -6;

    _bgmSynths.push(mel, bass);

    var melNotes = [
      'Eb4', 'G4', null, 'Ab4', 'G4', null, 'Eb4', 'D4',
      'C4',  null, 'D4', 'Eb4', null, 'G4', 'Ab4', null,
      'G4',  'Bb4', null, 'Ab4', 'G4', null, 'Eb4', null,
      'D4',  'Eb4', null, 'C4',  null, null, null,  null
    ];
    var bassNotes = [
      'C2', null, null, null, 'Ab1', null, null, null,
      'Eb2', null, null, null, 'G1', null, null, null,
      'C2', null, null, null, 'Ab1', null, null, null,
      'Eb2', null, null, null, 'G1', null, null, null
    ];

    var melSeq = new Tone.Sequence(function (time, note) {
      if (note) mel.triggerAttackRelease(note, '8n', time);
    }, melNotes, '8n');

    var bassSeq = new Tone.Sequence(function (time, note) {
      if (note) bass.triggerAttackRelease(note, '4n', time);
    }, bassNotes, '8n');

    melSeq.loop = true;
    bassSeq.loop = true;
    melSeq.start(0);
    bassSeq.start(0);
    _bgmSeq = melSeq;
    _bgmSynths.push(bassSeq);
  }

  // ─── Play BGM: アップテンポ (140 BPM, Am) ───
  function _playPlayBGM() {
    Tone.getTransport().bpm.value = 140;

    var mel = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.1, release: 0.1 }
    }).connect(_bgmCh);
    mel.volume.value = -4;

    var bass = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.15, sustain: 0.15, release: 0.15 }
    }).connect(_bgmCh);
    bass.volume.value = -6;

    _bgmSynths.push(mel, bass);

    var melNotes = [
      'A4', 'C5', 'E5', null, 'D5', 'C5', null, 'B4',
      'C5', null, 'E5', 'A5', null, 'G5', 'E5', null,
      'F5', 'E5', 'D5', null, 'C5', 'B4', null, 'A4',
      'B4', 'C5', null, 'D5', null, 'E5', null, null
    ];
    var bassNotes = [
      'A2', null, null, null, 'A2', null, null, null,
      'F2', null, null, null, 'F2', null, null, null,
      'D2', null, null, null, 'D2', null, null, null,
      'E2', null, null, null, 'E2', null, null, null
    ];

    var melSeq = new Tone.Sequence(function (time, note) {
      if (note) mel.triggerAttackRelease(note, '16n', time);
    }, melNotes, '8n');

    var bassSeq = new Tone.Sequence(function (time, note) {
      if (note) bass.triggerAttackRelease(note, '4n', time);
    }, bassNotes, '8n');

    melSeq.loop = true;
    bassSeq.loop = true;
    melSeq.start(0);
    bassSeq.start(0);
    _bgmSeq = melSeq;
    _bgmSynths.push(bassSeq);
  }

  // ─── Zone BGM: テンション上昇 (160 BPM) ───
  function _playZoneBGM() {
    Tone.getTransport().bpm.value = 160;

    var mel = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.005, decay: 0.08, sustain: 0.08, release: 0.08 }
    }).connect(_bgmCh);
    mel.volume.value = -3;

    var bass = new Tone.Synth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.01, decay: 0.12, sustain: 0.1, release: 0.1 }
    }).connect(_bgmCh);
    bass.volume.value = -8;

    _bgmSynths.push(mel, bass);

    var melNotes = [
      'A4', 'C5', 'E5', 'A5', null, 'G5', 'E5', 'C5',
      'D5', 'F5', 'A5', null, 'G5', 'F5', 'E5', null,
      'E5', 'G5', 'B5', null, 'A5', 'G5', 'F5', 'E5',
      'D5', 'E5', 'F5', null, 'E5', null, null, null
    ];
    var bassNotes = [
      'A2', null, 'A2', null, 'A2', null, 'G2', null,
      'D2', null, 'D2', null, 'F2', null, 'F2', null,
      'E2', null, 'E2', null, 'E2', null, 'D2', null,
      'D2', null, 'E2', null, 'E2', null, 'A1', null
    ];

    var melSeq = new Tone.Sequence(function (time, note) {
      if (note) mel.triggerAttackRelease(note, '16n', time);
    }, melNotes, '8n');

    var bassSeq = new Tone.Sequence(function (time, note) {
      if (note) bass.triggerAttackRelease(note, '8n', time);
    }, bassNotes, '8n');

    melSeq.loop = true;
    bassSeq.loop = true;
    melSeq.start(0);
    bassSeq.start(0);
    _bgmSeq = melSeq;
    _bgmSynths.push(bassSeq);
  }

  // ─── Hell BGM: 最高潮 (180 BPM) ───
  function _playHellBGM() {
    Tone.getTransport().bpm.value = 180;

    var mel = new Tone.Synth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.003, decay: 0.06, sustain: 0.06, release: 0.06 }
    }).connect(_bgmCh);
    mel.volume.value = -3;

    var bass = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.08, release: 0.08 }
    }).connect(_bgmCh);
    bass.volume.value = -8;

    _bgmSynths.push(mel, bass);

    var melNotes = [
      'E5', 'G5', 'B5', 'E6', null, 'D6', 'B5', 'G5',
      'A5', 'B5', 'E6', null, 'D6', 'C6', 'B5', null,
      'G5', 'A5', 'B5', 'D6', null, 'C6', 'B5', 'A5',
      'G5', 'A5', 'B5', null, 'E5', 'G5', null, null
    ];
    var bassNotes = [
      'E2', null, 'E2', null, 'E2', null, 'E2', null,
      'A1', null, 'A1', null, 'A1', null, 'B1', null,
      'E2', null, 'E2', null, 'D2', null, 'D2', null,
      'B1', null, 'B1', null, 'E2', null, 'E2', null
    ];

    var melSeq = new Tone.Sequence(function (time, note) {
      if (note) mel.triggerAttackRelease(note, '16n', time);
    }, melNotes, '8n');

    var bassSeq = new Tone.Sequence(function (time, note) {
      if (note) bass.triggerAttackRelease(note, '8n', time);
    }, bassNotes, '8n');

    melSeq.loop = true;
    bassSeq.loop = true;
    melSeq.start(0);
    bassSeq.start(0);
    _bgmSeq = melSeq;
    _bgmSynths.push(bassSeq);
  }

  // ─── Bomb BGM: 百裂拳専用 (200 BPM, Em, 非ループ ~4.8s) ───
  var _prevBGMType = '';

  function savePrevBGM() { _prevBGMType = _bgmType; }
  function getPrevBGM() { return _prevBGMType || 'play'; }

  function _playBombBGM() {
    Tone.getTransport().bpm.value = 200;

    var lead = new Tone.Synth({
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 0.002, decay: 0.05, sustain: 0.08, release: 0.04 }
    }).connect(_bgmCh);
    lead.volume.value = -2;

    var bass = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.005, decay: 0.08, sustain: 0.06, release: 0.06 }
    }).connect(_bgmCh);
    bass.volume.value = -6;

    var perc = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 }
    }).connect(_bgmCh);
    perc.volume.value = -12;

    _bgmSynths.push(lead, bass, perc);

    // 32 eighth notes @ 200BPM = ~4.8s
    var melNotes = [
      // Bar 1: 爆発的な導入
      'E5', 'G5', 'B5', 'E6', 'D6', 'B5', 'G5', 'B5',
      // Bar 2: 駆け上がり
      'A5', 'C6', 'E6', 'A6', 'G6', 'E6', 'C6', 'E6',
      // Bar 3: 畳みかけ
      'B5', 'D6', 'F#6', 'B6', 'A6', 'F#6', 'D6', 'B5',
      // Bar 4: フィニッシュ → 最高音で決め
      'E6', 'G6', 'B6', null, 'E7', null, null, null
    ];
    var bassNotes = [
      'E2', null, 'E2', null, 'E2', null, 'E2', null,
      'A1', null, 'A1', null, 'A1', null, 'A1', null,
      'B1', null, 'B1', null, 'B1', null, 'D2', null,
      'E2', null, 'E2', null, 'E2', null, null, null
    ];

    var melSeq = new Tone.Sequence(function (time, note) {
      if (note) lead.triggerAttackRelease(note, '16n', time);
      perc.triggerAttackRelease('32n', time);
    }, melNotes, '8n');

    var bassSeq = new Tone.Sequence(function (time, note) {
      if (note) bass.triggerAttackRelease(note, '8n', time);
    }, bassNotes, '8n');

    melSeq.loop = false;
    bassSeq.loop = false;
    melSeq.start(0);
    bassSeq.start(0);
    _bgmSeq = melSeq;
    _bgmSynths.push(bassSeq);
  }

  // ─── Result BGM: 穏やか (90 BPM, C) ───
  function _playResultBGM() {
    Tone.getTransport().bpm.value = 90;

    var mel = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.03, decay: 0.25, sustain: 0.15, release: 0.3 }
    }).connect(_bgmCh);
    mel.volume.value = -2;

    var bass = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.04, decay: 0.3, sustain: 0.2, release: 0.3 }
    }).connect(_bgmCh);
    bass.volume.value = -6;

    _bgmSynths.push(mel, bass);

    var melNotes = [
      'C5', 'E5', null, 'G5', null, 'E5', 'D5', null,
      'C5', null, 'D5', 'E5', null, null, null, null,
      'F5', 'E5', null, 'D5', null, 'C5', null, null,
      'D5', null, 'E5', 'C5', null, null, null, null
    ];
    var bassNotes = [
      'C2', null, null, null, 'G2', null, null, null,
      'A2', null, null, null, 'E2', null, null, null,
      'F2', null, null, null, 'C2', null, null, null,
      'G2', null, null, null, 'C2', null, null, null
    ];

    var melSeq = new Tone.Sequence(function (time, note) {
      if (note) mel.triggerAttackRelease(note, '8n', time);
    }, melNotes, '8n');

    var bassSeq = new Tone.Sequence(function (time, note) {
      if (note) bass.triggerAttackRelease(note, '4n', time);
    }, bassNotes, '8n');

    melSeq.loop = true;
    bassSeq.loop = true;
    melSeq.start(0);
    bassSeq.start(0);
    _bgmSeq = melSeq;
    _bgmSynths.push(bassSeq);
  }

  // ============================================================
  //  Public API
  // ============================================================
  return {
    init: init,
    unlock: unlock,
    toggleMute: toggleMute,
    isMuted: isMuted,

    startBGM: startBGM,
    stopBGM: stopBGM,
    getBGMType: getBGMType,
    savePrevBGM: savePrevBGM,
    getPrevBGM: getPrevBGM,
    setBGMLowpass: setBGMLowpass,
    muteBGMTemp: muteBGMTemp,

    playCountdown: playCountdown,
    playStart: playStart,
    playPunch: playPunch,
    playHit: playHit,
    playMiss: playMiss,
    playCombo10: playCombo10,
    playBombCutin: playBombCutin,
    playBombFire: playBombFire,
    playBombHit: playBombHit,
    playNearDeath: playNearDeath,
    playGameover: playGameover,
    playStunEnd: playStunEnd,
    playZoneEnter: playZoneEnter,
    playHellEnter: playHellEnter
  };
})();
