(function () {
  'use strict';

  var LK = ['L', 'C', 'R'];

  var DIFF = [
    { sec: 0,  spd: 200, ms: 1400, feint: 0.05  },
    { sec: 6,  spd: 250, ms: 1100, feint: 0.15  },
    { sec: 12, spd: 310, ms: 850,  feint: 0.25  },
    { sec: 20, spd: 370, ms: 680,  feint: 0.38  },
    { sec: 30, spd: 440, ms: 540,  feint: 0.48  },
    { sec: 40, spd: 510, ms: 430,  feint: 0.58  },
    { sec: 50, spd: 580, ms: 350,  feint: 0.68  }
  ];

  var STUN_MS        = 400;
  var BOMB_MS        = 5000;
  var BOMB_CUTIN_MS  = 1000;
  var NEAR_DEATH_S   = 0.12;
  var MIN_GAP_MS     = 100;
  var FEINT_STOP_MS  = 900;
  var ZONE_S         = 30;
  var HELL_S         = 50;
  var BASE_PT        = 100;
  var MAX_PER_LANE   = 3;

  var EN_R  = 55;
  var EN_GL = 70;
  var EN_RG = 64;
  var EN_CR = 18;

  var ECOLOR = {
    normal:       0xffaa00,
    resumeNormal: 0x66ff66,
    accel1_5:     0x66ccff,
    accel2_0:     0xff66cc
  };

  var TITLES = [
    { s: 0,  n: '見習い' },  { s: 10, n: '半人前' },
    { s: 20, n: '一人前' },  { s: 30, n: '達人' },
    { s: 35, n: '鬼神' },    { s: 40, n: '修羅' },
    { s: 45, n: '覇王' },    { s: 50, n: '武神' },
    { s: 55, n: '阿修羅' },  { s: 60, n: '伝説' }
  ];

  var S = {
    nick: '名無しさん',
    supported: false,
    score: 0, time: '0.00', rank: null,
    bestSec: 0,
    prev: 'screen-title'
  };

  /* ================================================================
   *  GAME SCENE — enemies approach from BOTTOM, player at TOP
   * ================================================================ */
  var GameScene = new Phaser.Class({
    Extends: Phaser.Scene,

    initialize: function GameScene() {
      Phaser.Scene.call(this, { key: 'GameScene' });
    },

    preload: function () {
      this.load.image('bg_play', 'assets/bg_play.png');
      this.load.image('enemy_cat_paw', 'assets/enemy_cat_paw.png');
      this.load.image('enemy_toy_feather', 'assets/enemy_toy_feather.png');
      this.load.image('enemy_toy_pawball', 'assets/enemy_toy_pawball.png');
      this.load.image('fx_combo_star', 'assets/fx_combo_star.png');
      this.load.image('sayori_front', 'assets/sayorishoumen.png');
      this.load.image('sayori_left', 'assets/sayorihidari.png');
      this.load.image('sayori_right', 'assets/sayorimigi.png');
      this.load.image('sayori_center', 'assets/sayorinaka.png');
      this.load.image('sayori_bomb', 'assets/sayorihyakuretu.png');
    },

    create: function () {
      var W = this.sys.game.config.width;
      var H = this.sys.game.config.height;
      this.W = W; this.H = H;

      this.LX = { L: W * 0.2, C: W * 0.5, R: W * 0.8 };
      this.PLY     = Math.round(H * 0.20);
      this.HIT_T   = Math.round(H * 0.28);
      this.HIT_B   = Math.round(H * 0.55);
      this.SPAWN_Y = H + 60;

      this.gs = {
        on: false, ms: 0, score: 0,
        combo: 0, multi: 1.0,
        stun: false, stunT: 0,
        stage: 0,
        bomb: true, bombOn: false, bombT: 0, cutT: 0,
        bombCutinActive: false,
        nd: false, zone: false, hell: false
      };

      this.lanes = {};
      for (var i = 0; i < LK.length; i++) {
        this.lanes[LK[i]] = { e: [], cd: 0 };
      }

      this._fpsTimer = 0;
      this._fpsBadCount = 0;
      this._fpsLow = false;
      this._zoneEmitter = null;
      this._hellEmitter = null;

      this._genTex();
      this._drawArena();
      this._setupFx();
      this._setupOverlays();

      this.events.off('punchL').off('punchC').off('punchR').off('bomb');
      this.events.on('punchL', function () { this._punch('L'); }, this);
      this.events.on('punchC', function () { this._punch('C'); }, this);
      this.events.on('punchR', function () { this._punch('R'); }, this);
      this.events.on('bomb',   function () { this._bomb(); },     this);

      this._countdown();
    },

    _countdown: function () {
      var self = this;
      var W = this.W, H = this.H;
      var steps = ['3', '2', '1', 'START!'];
      var delay = 0;

      for (var i = 0; i < steps.length; i++) {
        (function (idx) {
          self.time.delayedCall(delay, function () {
            var isStart = (idx === 3);
            var t = self.add.text(W / 2, H * 0.42, steps[idx], {
              fontSize: isStart ? '48px' : '72px',
              fill: isStart ? '#ffcc00' : '#ffffff',
              fontFamily: '"M PLUS Rounded 1c",sans-serif',
              fontStyle: 'bold',
              stroke: isStart ? '#ff6600' : '#000000',
              strokeThickness: isStart ? 8 : 6
            }).setOrigin(0.5).setDepth(500).setScale(0.3).setAlpha(0);

            self.tweens.add({
              targets: t, scaleX: 1.2, scaleY: 1.2, alpha: 1,
              duration: 150, ease: 'Back.easeOut',
              onComplete: function () {
                self.tweens.add({
                  targets: t, scaleX: 0.8, scaleY: 0.8, alpha: 0,
                  duration: isStart ? 350 : 500, delay: isStart ? 200 : 100,
                  ease: 'Cubic.easeIn',
                  onComplete: function () { t.destroy(); }
                });
              }
            });

            if (isStart) {
              self.cameras.main.flash(200, 255, 220, 100);
              setTimeout(function () { GameSound.playStart(); }, 0);
            } else {
              setTimeout(function () { GameSound.playCountdown(); }, 0);
            }
          });
          delay += (idx < 3) ? 700 : 0;
        })(i);
      }

      this.time.delayedCall(delay + 600, function () {
        self.gs.on = true;
        GameSound.startBGM('play');
      });
    },

    /* -------- procedural textures -------- */

    _genTex: function () {
      if (this.textures.exists('t_dot')) return;
      var g;

      g = this.make.graphics({ add: false });
      g.fillStyle(0xffffff); g.fillCircle(4, 4, 4);
      g.generateTexture('t_dot', 8, 8); g.destroy();

      g = this.make.graphics({ add: false });
      g.fillStyle(0xffffff); g.fillCircle(2, 2, 2);
      g.generateTexture('t_sp', 4, 4); g.destroy();

      g = this.make.graphics({ add: false });
      g.fillStyle(0xffffff, 0.10); g.fillCircle(16, 16, 16);
      g.fillStyle(0xffffff, 0.30); g.fillCircle(16, 16, 8);
      g.fillStyle(0xffffff, 0.65); g.fillCircle(16, 16, 3);
      g.generateTexture('t_glow', 32, 32); g.destroy();

      g = this.make.graphics({ add: false });
      g.fillStyle(0xffffff); g.fillRect(0, 0, 2, 2);
      g.generateTexture('t_pt', 2, 2); g.destroy();

      g = this.make.graphics({ add: false });
      g.fillStyle(0xffd4b8);
      g.fillRoundedRect(22, 0, 36, 42, 10);
      g.fillStyle(0xffb8a0);
      g.fillEllipse(40, 48, 38, 26);
      g.fillCircle(18, 64, 10);
      g.fillCircle(30, 68, 10);
      g.fillCircle(50, 68, 10);
      g.fillCircle(62, 64, 10);
      g.fillStyle(0xff9999);
      g.fillEllipse(40, 49, 24, 16);
      g.fillCircle(18, 64, 6);
      g.fillCircle(30, 68, 6);
      g.fillCircle(50, 68, 6);
      g.fillCircle(62, 64, 6);
      g.generateTexture('t_paw', 80, 80);
      g.destroy();
    },

    /* -------- arena (player TOP, enemies from BOTTOM) -------- */

    _drawArena: function () {
      var W = this.W, H = this.H;
      this.cameras.main.setBackgroundColor('#f5e6d8');

      this.add.image(W / 2, H / 2, 'bg_play').setDisplaySize(W, H).setDepth(0).setAlpha(0.7);

      this._bgStars = this.add.particles(0, 0, 't_sp', {
        x: { min: 0, max: W }, y: -4,
        lifespan: { min: 4000, max: 10000 },
        speedY: { min: 6, max: 22 },
        scale: { start: 0.7, end: 0 },
        alpha: { start: 0.15, end: 0 },
        frequency: 200, quantity: 1,
        tint: [0xc49a6c, 0xd4a574, 0xe8c8a0, 0xf0d8b8]
      }).setDepth(1);

      var lg = this.add.graphics().setDepth(2);
      for (var i = 0; i < LK.length; i++) {
        var lx = this.LX[LK[i]];
        lg.lineStyle(6, 0xc49a6c, 0.06);
        lg.moveTo(lx, 0); lg.lineTo(lx, H);
        lg.lineStyle(2, 0xb8865a, 0.15);
        lg.moveTo(lx, 0); lg.lineTo(lx, H);
        lg.lineStyle(1, 0xa07040, 0.25);
        lg.moveTo(lx, 0); lg.lineTo(lx, H);
      }
      lg.strokePath();

      var hz = this.add.graphics().setDepth(3);
      hz.fillStyle(0xe8927c, 0.10);
      hz.fillRect(0, this.HIT_T - 4, W, this.HIT_B - this.HIT_T + 8);
      hz.fillStyle(0xe8927c, 0.15);
      hz.fillRect(0, this.HIT_T, W, this.HIT_B - this.HIT_T);
      for (var b = 0; b < 2; b++) {
        var yy = b === 0 ? this.HIT_T : this.HIT_B;
        hz.lineStyle(3, 0xc49a6c, 0.25);
        hz.moveTo(0, yy); hz.lineTo(W, yy);
        hz.lineStyle(1, 0xe8927c, 0.50);
        hz.moveTo(0, yy); hz.lineTo(W, yy);
      }
      hz.strokePath();

      this.add.text(W - 8, this.HIT_T + 4, 'ATTACK', {
        fontSize: '10px', fill: '#c49a6c',
        fontFamily: '"M PLUS Rounded 1c",sans-serif', fontStyle: 'bold'
      }).setOrigin(1, 0).setAlpha(0.50).setDepth(3);

      this._scanLine = this.add.rectangle(W / 2, this.HIT_T, W, 2, 0xe8927c, 0.25).setDepth(4);
      this.tweens.add({
        targets: this._scanLine, y: this.HIT_B,
        alpha: { from: 0.25, to: 0.10 },
        duration: 2200, ease: 'Sine.easeInOut', yoyo: true, repeat: -1
      });

      var dl = this.add.graphics().setDepth(5);
      dl.lineStyle(6, 0xe57373, 0.15);
      dl.moveTo(0, this.PLY); dl.lineTo(W, this.PLY);
      dl.lineStyle(2, 0xe57373, 0.40);
      dl.moveTo(0, this.PLY); dl.lineTo(W, this.PLY);
      dl.lineStyle(1, 0xc62828, 0.60);
      dl.moveTo(0, this.PLY); dl.lineTo(W, this.PLY);
      dl.strokePath();

      this.add.text(8, this.PLY + 4, 'DEFENSE', {
        fontSize: '10px', fill: '#c62828',
        fontFamily: '"M PLUS Rounded 1c",sans-serif', fontStyle: 'bold'
      }).setAlpha(0.55).setDepth(5);

      this._buildPlayer(W / 2, this.PLY - 30);
    },

    _buildPlayer: function (px, py) {
      var SAYORI_H = 130;

      this._pGlow = this.add.ellipse(px, py + 20, 80, 30, 0xff8866, 0.08).setDepth(8);
      this.tweens.add({
        targets: this._pGlow, scaleX: 1.2, alpha: 0.03,
        duration: 1000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
      });

      this._pAura = this.add.circle(px, py + 10, 45, 0xff6644, 0.04).setDepth(9);
      this.tweens.add({
        targets: this._pAura, scaleX: 1.5, scaleY: 1.5, alpha: 0,
        duration: 1400, repeat: -1
      });

      this._pawImg = this.add.image(px, py, 'sayori_front').setDepth(11);
      this._setSayoriSize(this._pawImg, SAYORI_H);
      this._pawBaseX = px;
      this._pawBaseY = py;
      this._sayoriH = SAYORI_H;

      this.tweens.add({
        targets: this._pawImg,
        scaleX: this._pawImg.scaleX * 1.02, scaleY: this._pawImg.scaleY * 1.02,
        duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
      });
    },

    _setSayoriSize: function (img, targetH) {
      var tex = img.texture.getSourceImage();
      var ratio = targetH / tex.height;
      img.setScale(ratio);
    },

    _switchSayori: function (key) {
      if (!this._pawImg || !this._pawImg.active) return;
      this._pawImg.setTexture(key);
      this._setSayoriSize(this._pawImg, this._sayoriH);
    },

    /* -------- particle emitters -------- */

    _setupFx: function () {
      var self = this;
      this._killTint = 0xffaa00;

      this._fxKill = this.add.particles(0, 0, 't_dot', {
        speed: { min: 80, max: 300 },
        lifespan: { min: 200, max: 600 },
        scale: { start: 1.5, end: 0 },
        alpha: { start: 1, end: 0 },
        angle: { min: 0, max: 360 },
        gravityY: -60,
        blendMode: Phaser.BlendModes.ADD,
        tint: { onEmit: function () { return self._killTint; } },
        emitting: false
      }).setDepth(102);

      this._fxFlash = this.add.particles(0, 0, 't_glow', {
        speed: { min: 10, max: 60 },
        lifespan: 250,
        scale: { start: 3, end: 0 },
        alpha: { start: 0.7, end: 0 },
        blendMode: Phaser.BlendModes.ADD,
        tint: { onEmit: function () { return self._killTint; } },
        emitting: false
      }).setDepth(103);

      this._fxMiss = this.add.particles(0, 0, 't_dot', {
        speed: { min: 50, max: 180 },
        lifespan: { min: 150, max: 400 },
        scale: { start: 1, end: 0 },
        alpha: { start: 0.7, end: 0 },
        blendMode: Phaser.BlendModes.ADD,
        tint: 0xff4444,
        emitting: false
      }).setDepth(102);

      this._fxBomb = this.add.particles(0, 0, 't_glow', {
        speed: { min: 100, max: 400 },
        lifespan: { min: 400, max: 1000 },
        scale: { start: 2.5, end: 0 },
        alpha: { start: 0.85, end: 0 },
        angle: { min: 0, max: 360 },
        blendMode: Phaser.BlendModes.ADD,
        tint: [0xff8800, 0xff4400, 0xffcc00, 0xffffff],
        emitting: false
      }).setDepth(250);

      this._fxCombo = this.add.particles(0, 0, 't_sp', {
        speed: { min: 50, max: 200 },
        angle: { min: 60, max: 120 },
        lifespan: { min: 400, max: 900 },
        scale: { start: 2, end: 0 },
        alpha: { start: 0.9, end: 0 },
        gravityY: -100,
        blendMode: Phaser.BlendModes.ADD,
        tint: [0xffcc00, 0xff8800, 0xff4400],
        emitting: false
      }).setDepth(102);

      this._fxTrail = this.add.particles(0, 0, 't_pt', {
        lifespan: { min: 100, max: 300 },
        scale: { start: 3, end: 0 },
        alpha: { start: 0.3, end: 0 },
        blendMode: Phaser.BlendModes.ADD,
        tint: 0xffcc88,
        emitting: false
      }).setDepth(15);
    },

    /* -------- overlays -------- */

    _setupOverlays: function () {
      var W = this.W, H = this.H;
      this.ndR = this.add.rectangle(W / 2, H / 2, W, H, 0xff0000, 0).setDepth(200);
      this.zR  = this.add.rectangle(W / 2, H / 2, W, H, 0x00ccff, 0).setDepth(90);
      this.hR  = this.add.rectangle(W / 2, H / 2, W, H, 0x440000, 0).setDepth(89);

      this._bombDark = this.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0).setDepth(298);

      this.ciT = this.add.text(W / 2, H * 0.42, 'さより百烈拳！', {
        fontSize: '52px', fill: '#ff2222',
        fontFamily: '"M PLUS Rounded 1c",sans-serif',
        fontStyle: 'bold', stroke: '#ffffff', strokeThickness: 8
      }).setOrigin(0.5).setDepth(300).setVisible(false);

      this._bombTimerText = this.add.text(W / 2, H * 0.12, '', {
        fontSize: '28px', fill: '#ff8800',
        fontFamily: '"M PLUS Rounded 1c",sans-serif',
        fontStyle: 'bold', stroke: '#000000', strokeThickness: 5
      }).setOrigin(0.5).setDepth(210).setVisible(false);

      var vig = this.add.graphics().setDepth(88);
      vig.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0.35, 0.35, 0, 0);
      vig.fillRect(0, 0, W, 30);
      vig.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0, 0, 0.35, 0.35);
      vig.fillRect(0, H - 30, W, 30);
    },

    /* -------- update -------- */

    update: function (t, dt) {
      if (!this.gs.on) return;
      this.gs.ms += dt;
      this._updFps(dt);
      this._updDiff();
      this._updStun(dt);
      this._updBomb(dt);
      this._spawn(dt);
      this._updEnemies(dt);
      this._updTrails();
      this._chkND();
      this._updZH();
      this._updHUD();
    },

    _updFps: function (dt) {
      this._fpsTimer += dt;
      if (this._fpsTimer < 1000) return;
      this._fpsTimer = 0;
      var fps = this.game.loop.actualFps;

      if (fps < 45) {
        this._fpsBadCount++;
      } else if (fps > 55) {
        this._fpsBadCount = Math.max(0, this._fpsBadCount - 1);
      }

      if (this._fpsBadCount >= 3 && !this._fpsLow) {
        this._fpsLow = true;
        if (this._bgStars) this._bgStars.frequency = 400;
        if (this._zoneEmitter) this._zoneEmitter.frequency = 200;
        if (this._hellEmitter) this._hellEmitter.frequency = 140;
      }
      if (this._fpsBadCount <= 0 && this._fpsLow) {
        this._fpsLow = false;
        if (this._bgStars) this._bgStars.frequency = 160;
        if (this._zoneEmitter) this._zoneEmitter.frequency = 100;
        if (this._hellEmitter) this._hellEmitter.frequency = 60;
      }
    },

    _updDiff: function () {
      var s = this.gs.ms / 1000;
      var st = 0;
      for (var i = DIFF.length - 1; i >= 0; i--) {
        if (s >= DIFF[i].sec) { st = i; break; }
      }
      this.gs.stage = st;
    },

    _d: function () { return DIFF[this.gs.stage]; },

    _updStun: function (dt) {
      if (!this.gs.stun) return;
      this.gs.stunT -= dt;
      if (this.gs.stunT <= 0) {
        this.gs.stun = false;
        this._setPC('normal');
        var btns = document.querySelectorAll('.btn-lane');
        for (var i = 0; i < btns.length; i++) btns[i].classList.remove('stunned');
        setTimeout(function () { GameSound.playStunEnd(); }, 0);
      }
    },

    _setPC: function (mode) {
      if (mode === 'normal') {
        this._pawImg.clearTint();
        this._pGlow.fillColor = 0xff8866;
        this._pAura.fillColor = 0xff6644;
      } else {
        this._pawImg.setTint(mode);
        this._pGlow.fillColor = mode;
        this._pAura.fillColor = mode;
      }
    },

    /* -------- bomb -------- */

    _updBomb: function (dt) {
      if (!this.gs.bombOn) return;

      if (this.gs.bombCutinActive) {
        this.gs.cutT -= dt;
        if (this.gs.cutT <= 0) {
          this.gs.bombCutinActive = false;
          this._bombFireEffects();
        }
      }

      this.gs.bombT -= dt;

      var remain = Math.max(0, this.gs.bombT / 1000);
      this._bombTimerText.setText(remain.toFixed(1) + 's');

      if (this.gs.bombT <= 0) {
        this.gs.bombOn = false;
        this._setPC('normal');
        this._bombTimerText.setVisible(false);
        try { document.getElementById('hud-controls').classList.remove('bomb-active'); } catch (_) {}

        if (this._bombSayori) {
          var bs = this._bombSayori;
          this.tweens.killTweensOf(bs);
          this.tweens.add({
            targets: bs, alpha: 0, scaleX: 0.05, scaleY: 0.05,
            duration: 250, onComplete: function () { bs.destroy(); }
          });
          this._bombSayori = null;
        }

        this._pawImg.setVisible(true);
        this._pGlow.setVisible(true);
        this._pAura.setVisible(true);
        this._switchSayori('sayori_front');

        setTimeout(function () {
          GameSound.startBGM(GameSound.getPrevBGM());
        }, 0);
        return;
      }

      for (var i = 0; i < LK.length; i++) {
        var lane = this.lanes[LK[i]];
        for (var j = 0; j < lane.e.length; j++) {
          var e = lane.e[j];
          if (e && e.active && e._st === 'stopped') {
            e._st = 'moving'; e._spd = e._bspd * 2.0;
          }
        }
      }

      for (var i = 0; i < LK.length; i++) {
        var lk = LK[i];
        var lane = this.lanes[lk];
        for (var j = lane.e.length - 1; j >= 0; j--) {
          var e = lane.e[j];
          var ehr = (e ? (e._hitR || EN_R) : 0);
          if (e && e.active && (e.y + ehr) >= this.HIT_T) {
            this._addC();
            this._popHit(e.x, e.y, this.gs.combo);
            this._kill(e, lk);
            this._addS();
            setTimeout(function () { GameSound.playBombHit(); }, 0);
          }
        }
      }
    },

    _bomb: function () {
      if (!this.gs.on || !this.gs.bomb || this.gs.bombOn) return;
      this.gs.bomb = false;
      this.gs.bombOn = true;
      this.gs.bombCutinActive = true;
      this.gs.bombT = BOMB_MS;
      this.gs.cutT = BOMB_CUTIN_MS;
      this.gs.stun = false;
      this.gs.stunT = 0;
      this._bombFired = false;
      var btns = document.querySelectorAll('.btn-lane');
      for (var i = 0; i < btns.length; i++) btns[i].classList.remove('stunned');

      this._bombDark.setAlpha(0);
      this.tweens.add({ targets: this._bombDark, alpha: 0.75, duration: 150 });

      this.ciT.setVisible(true).setScale(0.1).setAlpha(0);
      this.tweens.add({
        targets: this.ciT, scaleX: 1.4, scaleY: 1.4, alpha: 1,
        duration: 300, ease: 'Back.easeOut'
      });

      this._setPC(0xff8800);
      this._bombTimerText.setVisible(true);
      try { document.getElementById('hud-controls').classList.add('bomb-active'); } catch (e) {}

      this._pawImg.setVisible(false);
      this._pGlow.setVisible(false);
      this._pAura.setVisible(false);

      setTimeout(function () {
        GameSound.savePrevBGM();
        GameSound.muteBGMTemp(true);
        GameSound.playBombCutin();
      }, 0);

      var btn = document.getElementById('btn-bomb');
      btn.disabled = true; btn.innerText = 'さより百烈拳(使用済)';
    },

    _bombFireEffects: function () {
      if (this._bombFired) return;
      this._bombFired = true;

      this.ciT.setVisible(false);
      this.tweens.add({ targets: this._bombDark, alpha: 0, duration: 200 });
      setTimeout(function () {
        GameSound.muteBGMTemp(false);
        GameSound.startBGM('bomb');
        GameSound.playBombFire();
      }, 0);

      var bombImg = this.add.image(this.W / 2, this.H * 0.45, 'sayori_bomb')
        .setDepth(250).setAlpha(0).setScale(0.1);
      var targetH = this.H * 0.55;
      var tex = bombImg.texture.getSourceImage();
      var bombScale = targetH / tex.height;
      this._bombSayori = bombImg;
      var self = this;

      this.tweens.add({
        targets: bombImg, alpha: 1, scaleX: bombScale, scaleY: bombScale,
        duration: 300, ease: 'Back.easeOut',
        onComplete: function () {
          self.tweens.add({
            targets: bombImg, x: bombImg.x - 6,
            duration: 60, yoyo: true, repeat: -1
          });
          self.tweens.add({
            targets: bombImg, scaleX: bombScale * 1.03, scaleY: bombScale * 1.03,
            duration: 200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
          });
        }
      });

      this.cameras.main.flash(150, 255, 180, 100);
      this._fxBomb.explode(this._fpsLow ? 20 : 40, this.W / 2, this.HIT_T);

      var ring = this.add.circle(this.W / 2, this.PLY, 20)
        .setStrokeStyle(5, 0xff8800, 0.8).setFillStyle().setDepth(201);
      this.tweens.add({
        targets: ring, scaleX: 14, scaleY: 14, alpha: 0,
        duration: 600, onComplete: function () { ring.destroy(); }
      });

      var cam = this.cameras.main;
      cam.setZoom(1.05);
      var self = this;
      this.time.delayedCall(120, function () {
        self.tweens.add({ targets: cam, zoom: 1.0, duration: 220, ease: 'Cubic.easeOut' });
      });
    },

    /* -------- spawn (from BOTTOM) -------- */

    _spawn: function (dt) {
      var d = this._d();
      for (var i = 0; i < LK.length; i++) {
        var lk = LK[i];
        var lane = this.lanes[lk];
        lane.cd -= dt;
        if (lane.cd > 0) continue;

        var prob = 0.35 + this.gs.stage * 0.08;
        if (Math.random() < prob) {
          var sp = d.spd + (Math.random() * 40 - 20);
          if (this._canSpawn(lk, sp)) {
            this._mkEnemy(lk, sp, Math.random() < d.feint);
          }
        }
        lane.cd = d.ms * (0.8 + Math.random() * 0.4);
      }
    },

    _canSpawn: function (lk, spd) {
      var lane = this.lanes[lk];
      var active = 0;
      for (var i = 0; i < lane.e.length; i++) {
        if (lane.e[i] && lane.e[i].active) active++;
      }
      if (active >= MAX_PER_LANE) return false;

      var travMs = ((this.SPAWN_Y - this.HIT_B) / spd) * 1000;
      var arrMs  = this.gs.ms + travMs;
      for (var i = lane.e.length - 1; i >= 0; i--) {
        var e = lane.e[i];
        if (!e || !e.active) continue;
        var ed = e.y - this.HIT_B;
        if (ed <= 0) continue;
        var ea = this.gs.ms + (ed / e._spd) * 1000;
        if (Math.abs(arrMs - ea) < MIN_GAP_MS) return false;
      }
      return true;
    },

    _mkEnemy: function (lk, sp, feint) {
      var x = this.LX[lk];
      var fk = 'none';
      var col = ECOLOR.normal;
      if (feint) {
        var ks = ['resumeNormal', 'accel1_5', 'accel2_0'];
        fk = ks[Math.floor(Math.random() * ks.length)];
        col = ECOLOR[fk];
      }

      var texKey = 'enemy_cat_paw';
      var diam = EN_R * 2;
      var dw = diam, dh = diam;
      var hitR = EN_R;
      if (feint && fk === 'accel1_5') {
        texKey = 'enemy_toy_feather';
        dw = diam * 0.7; dh = diam * 1.0;
        hitR = Math.round(dh / 2);
      } else if (feint && fk === 'accel2_0') {
        texKey = 'enemy_toy_pawball';
        dw = diam * 0.7; dh = diam * 0.7;
        hitR = Math.round(dh / 2);
      }

      var body = this.add.image(x, this.SPAWN_Y, texKey).setDepth(20);
      body.setDisplaySize(dw, dh);
      if (texKey === 'enemy_cat_paw') body.setTint(col);

      body._lk = lk;
      body._typ = feint ? 'feint' : 'normal';
      body._fk  = fk;
      body._bspd = sp;
      body._spd  = sp;
      body._st   = 'moving';
      body._stopped = false;
      body._stopT   = 0;
      body._col  = col;
      body._hitR = hitR;
      body._vis  = [];
      this.lanes[lk].e.push(body);
    },

    /* -------- enemies (move UPWARD) -------- */

    _updEnemies: function (dt) {
      for (var i = 0; i < LK.length; i++) {
        var lk = LK[i];
        var lane = this.lanes[lk];
        for (var j = lane.e.length - 1; j >= 0; j--) {
          var e = lane.e[j];
          if (!e || !e.active) { lane.e.splice(j, 1); continue; }

          if (e._st === 'moving') {
            e.y -= e._spd * (dt / 1000);

            if (e._typ === 'feint' && !e._stopped) {
              var prog = (this.SPAWN_Y - e.y) / (this.SPAWN_Y - this.PLY);
              if (prog >= 0.30 && e.y > this.HIT_B) {
                e._st = 'stopped';
                e._stopped = true;
                e._stopT = FEINT_STOP_MS + (Math.random() * 200 - 100);
              }
            }

            if ((e.y - (e._hitR || EN_R)) <= this.PLY) { this._gameOver(); return; }

          } else if (e._st === 'stopped') {
            e._stopT -= dt;
            var pulse = 0.35 + 0.65 * Math.abs(Math.sin(this.gs.ms / 150));
            e.setAlpha(pulse);
            if (e._vis) {
              for (var v = 0; v < e._vis.length; v++) e._vis[v].setAlpha(pulse * 0.6);
            }
            if (e._stopT <= 0) {
              e._st = 'moving';
              e.setAlpha(1);
              if (e._vis) {
                for (var v = 0; v < e._vis.length; v++) e._vis[v].setAlpha(1);
              }
              if (e._fk === 'accel1_5') e._spd = e._bspd * 1.5;
              else if (e._fk === 'accel2_0') e._spd = e._bspd * 2.0;
            }
          }

          if (e._vis) {
            for (var v = 0; v < e._vis.length; v++) {
              e._vis[v].x = e.x;
              e._vis[v].y = e.y;
            }
          }
        }
      }
    },

    _updTrails: function () {
      if (this._fpsLow) return;
      if (Math.random() > 0.35) return;
      for (var i = 0; i < LK.length; i++) {
        var lane = this.lanes[LK[i]];
        for (var j = 0; j < lane.e.length; j++) {
          var e = lane.e[j];
          if (!e || !e.active || e._st !== 'moving') continue;
          this._fxTrail.emitParticleAt(
            e.x + (Math.random() * 8 - 4),
            e.y + EN_R * 0.6,
            1
          );
        }
      }
    },

    /* -------- punch (paw jabs to lane) -------- */

    _punch: function (lk) {
      if (!this.gs.on || this.gs.stun || this.gs.bombOn) return;
      setTimeout(function () { GameSound.playPunch(); }, 0);

      var dirMap = { L: 'sayori_left', C: 'sayori_center', R: 'sayori_right' };
      this._switchSayori(dirMap[lk]);

      var tgtX = this.LX[lk];
      var baseScaleX = this._pawImg.scaleX;
      var baseScaleY = this._pawImg.scaleY;
      var punchScale = 1.15;
      var self = this;
      this.tweens.add({
        targets: this._pawImg,
        x: tgtX, y: this._pawBaseY + 35,
        scaleX: baseScaleX * punchScale, scaleY: baseScaleY * punchScale,
        duration: 45, yoyo: true,
        onComplete: function () {
          self._pawImg.x = self._pawBaseX;
          self._pawImg.y = self._pawBaseY;
          self._switchSayori('sayori_front');
        }
      });

      var lane = this.lanes[lk];
      var tgt = null;
      for (var i = 0; i < lane.e.length; i++) {
        var e = lane.e[i];
        if (!e || !e.active) continue;
        if (!tgt || e.y < tgt.y) tgt = e;
      }
      var hr = tgt ? (tgt._hitR || EN_R) : 0;
      if (tgt && (tgt.y + hr) >= this.HIT_T && (tgt.y - hr) <= this.HIT_B) {
        this._addC();
        this._popHit(tgt.x, tgt.y, this.gs.combo);
        this._kill(tgt, lk);
        this._addS();
        var c = this.gs.combo;
        setTimeout(function () { GameSound.playHit(c); }, 0);
      } else {
        this._miss();
      }
    },

    _kill: function (e, lk) {
      this._killTint = e._col || 0xffaa00;
      var kn = this._fpsLow ? 9 : 18;
      var fn = this._fpsLow ? 2 : 4;
      this._fxKill.explode(kn, e.x, e.y);
      this._fxFlash.explode(fn, e.x, e.y);

      if (e._vis) {
        for (var v = 0; v < e._vis.length; v++) {
          if (e._vis[v]) e._vis[v].destroy();
        }
      }

      this.tweens.add({
        targets: e, scaleX: 2.5, scaleY: 2.5, alpha: 0,
        duration: 140, onComplete: function () { e.destroy(); }
      });
      e.active = false;
      var idx = this.lanes[lk].e.indexOf(e);
      if (idx > -1) this.lanes[lk].e.splice(idx, 1);
    },

    _addS: function () {
      this.gs.score += Math.floor(BASE_PT * this.gs.multi);
    },

    _addC: function () {
      this.gs.combo++;
      this.gs.multi = 1.0 + Math.floor(this.gs.combo / 10) * 0.1;
      if (this.gs.combo > 0 && this.gs.combo % 10 === 0) {
        this._pop(this.W / 2, this.H * 0.35, this.gs.combo + ' COMBO!', '#ff8800');
        this._fxCombo.explode(this._fpsLow ? 12 : 25, this.W / 2, this.H * 0.40);

        var star = this.add.image(this.W / 2, this.H * 0.32, 'fx_combo_star')
          .setDepth(160).setScale(0.2).setAlpha(0);
        this.tweens.add({
          targets: star, scaleX: 1.2, scaleY: 1.2, alpha: 1,
          duration: 150, ease: 'Back.easeOut',
          onComplete: function () {
            star.scene.tweens.add({
              targets: star, scaleX: 0.4, scaleY: 0.4, alpha: 0, y: star.y - 40,
              duration: 400, ease: 'Cubic.easeOut',
              onComplete: function () { star.destroy(); }
            });
          }
        });

        var cb = this.gs.combo;
        setTimeout(function () { GameSound.playCombo10(cb); }, 0);
      }
    },

    _miss: function () {
      this.gs.stun = true;
      this.gs.stunT = STUN_MS;
      this.gs.combo = 0;
      this.gs.multi = 1.0;
      this._setPC(0xff4444);
      this.cameras.main.shake(80, 0.008);
      this._pop(this.W / 2, this.PLY + 40, 'MISS', '#ff4444');
      setTimeout(function () { GameSound.playMiss(); }, 0);

      var ring = this.add.circle(this.W / 2, this.PLY, 15)
        .setStrokeStyle(4, 0xff4444, 0.7).setFillStyle().setDepth(101);
      this.tweens.add({
        targets: ring, scaleX: 8, scaleY: 8, alpha: 0,
        duration: 350, onComplete: function () { ring.destroy(); }
      });
      this._fxMiss.explode(this._fpsLow ? 6 : 12, this.W / 2, this.PLY);

      var btns = document.querySelectorAll('.btn-lane');
      for (var i = 0; i < btns.length; i++) btns[i].classList.add('stunned');
    },

    /* -------- near death -------- */

    _chkND: function () {
      var found = false;
      for (var i = 0; i < LK.length; i++) {
        var lane = this.lanes[LK[i]];
        for (var j = 0; j < lane.e.length; j++) {
          var e = lane.e[j];
          if (!e || !e.active || e._st === 'stopped') continue;
          var d = e.y - this.PLY;
          if (d > 0 && (d / e._spd) <= NEAR_DEATH_S) { found = true; break; }
        }
        if (found) break;
      }
      if (found && !this.gs.nd) {
        this.gs.nd = true;
        this.ndR.setAlpha(0.4);
        this.tweens.add({ targets: this.ndR, alpha: 0, duration: 300 });
        this.cameras.main.shake(50, 0.005);
        var cam = this.cameras.main;
        cam.setZoom(1.05);
        this.tweens.add({ targets: cam, zoom: 1.0, duration: 280, ease: 'Cubic.easeOut' });
        setTimeout(function () {
          GameSound.playNearDeath();
          GameSound.setBGMLowpass(true);
        }, 0);
      }
      if (!found && this.gs.nd) {
        setTimeout(function () { GameSound.setBGMLowpass(false); }, 0);
      }
      if (!found) this.gs.nd = false;
    },

    /* -------- zone / hell -------- */

    _updZH: function () {
      var s = this.gs.ms / 1000;
      if (s >= HELL_S && !this.gs.hell) {
        this.gs.hell = true; this.gs.zone = true;
        this.cameras.main.setBackgroundColor('#e8c8a0');
        setTimeout(function () {
          GameSound.playHellEnter();
          GameSound.startBGM('hell');
        }, 0);
        this.hR.setAlpha(0.08);
        this.tweens.add({
          targets: this.hR, alpha: { from: 0.06, to: 0.22 },
          duration: 600, yoyo: true, repeat: -1
        });
        this._hellEmitter = this.add.particles(0, 0, 't_sp', {
          x: { min: 0, max: this.W }, y: this.H + 5,
          lifespan: { min: 2000, max: 4000 },
          speedY: { min: -30, max: -10 },
          scale: { start: 1, end: 0 },
          alpha: { start: 0.35, end: 0 },
          frequency: this._fpsLow ? 140 : 60,
          tint: [0xe57373, 0xc62828, 0xe8927c, 0xd07060]
        }).setDepth(1);
      } else if (s >= ZONE_S && !this.gs.zone) {
        this.gs.zone = true;
        this.cameras.main.setBackgroundColor('#eedcc4');
        setTimeout(function () {
          GameSound.playZoneEnter();
          GameSound.startBGM('zone');
        }, 0);
        this.zR.setAlpha(0.03);
        this.tweens.add({
          targets: this.zR, alpha: { from: 0.02, to: 0.08 },
          duration: 1200, yoyo: true, repeat: -1
        });
        this._zoneEmitter = this.add.particles(0, 0, 't_sp', {
          x: { min: 0, max: this.W }, y: { min: 0, max: this.H },
          lifespan: { min: 3000, max: 6000 },
          speed: { min: 3, max: 10 },
          angle: { min: 0, max: 360 },
          scale: { start: 1.2, end: 0 },
          alpha: { start: 0.20, end: 0 },
          frequency: this._fpsLow ? 200 : 100,
          tint: [0xdaa520, 0xc49a6c, 0xe8c8a0]
        }).setDepth(1);
      }
    },

    /* -------- HUD -------- */

    _updHUD: function () {
      document.getElementById('hud-time').innerText  = (this.gs.ms / 1000).toFixed(1);
      document.getElementById('hud-score').innerText = this.gs.score;
      document.getElementById('hud-combo').innerText = this.gs.combo;
      document.getElementById('hud-multiplier').innerText = 'x' + this.gs.multi.toFixed(1);
    },

    /* -------- game over -------- */

    _gameOver: function () {
      this.gs.on = false;
      if (this._bombSayori) {
        this._bombSayori.destroy();
        this._bombSayori = null;
      }
      this.cameras.main.shake(400, 0.05);
      this.cameras.main.fade(800, 0, 0, 0);
      setTimeout(function () {
        GameSound.setBGMLowpass(false);
        GameSound.muteBGMTemp(false);
        GameSound.playGameover();
        GameSound.stopBGM();
      }, 0);

      var goN = this._fpsLow ? 6 : 12;
      for (var i = 0; i < LK.length; i++) {
        this._killTint = 0xff4444;
        this._fxKill.explode(goN, this.LX[LK[i]], this.PLY);
      }
      this._fxBomb.explode(this._fpsLow ? 10 : 20, this.W / 2, this.PLY);

      var self = this;
      this.time.delayedCall(1200, function () { App.showResult(self.gs); });
    },

    /* -------- pop text -------- */

    _popHit: function (x, y, combo) {
      var big = combo >= 30;
      var mid = combo >= 10;
      var label = combo + ' COMBO!';
      var sz = big ? '32px' : (mid ? '24px' : '18px');
      var col = big ? '#ff2200' : (mid ? '#ffaa00' : '#ffff00');
      var sc = big ? 1.8 : (mid ? 1.4 : 1.1);
      var stk = big ? '#660000' : (mid ? '#553300' : '#444400');

      var t = this.add.text(x, y, label, {
        fontSize: sz, fill: col,
        fontFamily: '"M PLUS Rounded 1c",sans-serif',
        fontStyle: 'bold', stroke: stk, strokeThickness: big ? 7 : (mid ? 5 : 4)
      }).setOrigin(0.5).setDepth(150).setScale(0.1).setAlpha(0);

      var rot = (Math.random() - 0.5) * 0.15;
      t.setRotation(rot);

      this.tweens.add({
        targets: t, scaleX: sc * 1.3, scaleY: sc * 1.3, alpha: 1,
        duration: 60, ease: 'Cubic.easeOut',
        onComplete: function () {
          t.scene.tweens.add({
            targets: t, scaleX: sc, scaleY: sc,
            duration: 80, ease: 'Back.easeOut',
            onComplete: function () {
              t.scene.tweens.add({
                targets: t, y: y + 55, alpha: 0,
                scaleX: sc * 0.6, scaleY: sc * 0.6,
                rotation: rot + (Math.random() - 0.5) * 0.3,
                duration: 350, ease: 'Cubic.easeOut',
                onComplete: function () { t.destroy(); }
              });
            }
          });
        }
      });

      if (big) {
        this._fxKill.explode(this._fpsLow ? 4 : 8, x, y);
        this.cameras.main.shake(40, 0.005);
      } else if (mid) {
        this._fxFlash.explode(this._fpsLow ? 2 : 4, x, y);
        this.cameras.main.shake(25, 0.003);
      }

      if (combo >= 5) {
        var streak = this.add.circle(x, y, 8)
          .setStrokeStyle(big ? 4 : 2, big ? 0xff2200 : (mid ? 0xffaa00 : 0xffff00), 0.7)
          .setFillStyle().setDepth(149);
        this.tweens.add({
          targets: streak,
          scaleX: big ? 6 : (mid ? 4 : 2.5),
          scaleY: big ? 6 : (mid ? 4 : 2.5),
          alpha: 0, duration: 250,
          onComplete: function () { streak.destroy(); }
        });
      }
    },

    _pop: function (x, y, txt, col) {
      var t = this.add.text(x, y, txt, {
        fontSize: '22px', fill: col,
        fontFamily: '"M PLUS Rounded 1c",sans-serif',
        fontStyle: 'bold', stroke: '#000', strokeThickness: 4
      }).setOrigin(0.5).setDepth(150);
      this.tweens.add({
        targets: t, y: y + 40, alpha: 0, scaleX: 1.3, scaleY: 1.3,
        duration: 600, ease: 'Cubic.easeOut',
        onComplete: function () { t.destroy(); }
      });
    }
  });

  /* ================================================================
   *  PHASER CONFIG
   * ================================================================ */
  var cfg = {
    type: Phaser.AUTO,
    parent: 'phaser-game',
    width: 375, height: 667,
    backgroundColor: '#08081a',
    scene: [GameScene]
  };
  var game = null;

  /* ================================================================
   *  UI CONTROLLER
   * ================================================================ */
  var App = window.__SayoriApp = {

    init: function () {
      this.bind();
      this._restoreNick();
      this.show('screen-title');
      this._stats();
      GameSound.init();
      if (typeof BakenekoAnalytics !== 'undefined') {
        BakenekoAnalytics.event('page_view', { page: 'sayori-punch' });
      }
    },

    bind: function () {
      var self = this;

      $('btn-start').addEventListener('click', function () {
        GameSound.unlock().then(function () { GameSound.startBGM('title'); });
        self.show('screen-nickname');
      });
      $('btn-title-ranking').addEventListener('click', function () { S.prev = 'screen-title'; self._rank(); });

      $('btn-nick-ok').addEventListener('click', function () {
        var v = $('input-nickname').value.trim();
        if (v) { S.nick = v; try { localStorage.setItem('sayori_nick', v); } catch (_) {} }
        self._start();
      });
      $('btn-nick-skip').addEventListener('click', function () { self._start(); });

      var _lastPunchMs = 0;
      var PUNCH_COOLDOWN = 60;
      for (var i = 0; i < LK.length; i++) {
        (function (k) {
          $('btn-lane-' + k).addEventListener('pointerdown', function (ev) {
            ev.preventDefault();
            var now = Date.now();
            if (now - _lastPunchMs < PUNCH_COOLDOWN) return;
            _lastPunchMs = now;
            if (game) {
              var sc = game.scene.getScene('GameScene');
              if (sc) sc.events.emit('punch' + k);
            }
          });
        })(LK[i]);
      }
      $('btn-bomb').addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        if (game) { var sc = game.scene.getScene('GameScene'); if (sc) sc.events.emit('bomb'); }
      });

      $('btn-retry').addEventListener('click', function () { self._start(); });
      $('btn-ranking').addEventListener('click', function () { S.prev = 'screen-result'; self._rank(); });
      $('btn-share').addEventListener('click', function () { self._share(); });
      $('btn-support-ad').addEventListener('click', function () { self._ad(); });
      $('btn-rank-close').addEventListener('click', function () {
        $('screen-ranking').classList.add('hidden');
        if (S.prev) $(S.prev).classList.remove('hidden');
      });

      var gc = $('game-container');
      gc.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
      gc.addEventListener('touchstart', function (ev) {
        if (ev.touches.length > 1) ev.preventDefault();
      }, { passive: false });
      gc.addEventListener('gesturestart', function (ev) { ev.preventDefault(); });
      gc.addEventListener('gesturechange', function (ev) { ev.preventDefault(); });

      document.addEventListener('touchmove', function (ev) {
        if (ev.touches.length > 1) ev.preventDefault();
      }, { passive: false });

      document.addEventListener('keydown', function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === '+' || ev.key === '-' || ev.key === '0')) {
          ev.preventDefault();
        }
      });
    },

    show: function (id) {
      var all = document.querySelectorAll('.screen');
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === id) all[i].classList.remove('hidden');
        else all[i].classList.add('hidden');
      }
    },

    _restoreNick: function () {
      try {
        var v = localStorage.getItem('sayori_nick');
        if (v) { $('input-nickname').value = v; S.nick = v; }
      } catch (_) {}
    },

    _start: function () {
      this.show('screen-hud');
      $('hud-score').innerText = '0';
      $('hud-combo').innerText = '0';
      $('hud-multiplier').innerText = 'x1.0';
      $('hud-time').innerText = '0.0';
      var bb = $('btn-bomb'); bb.disabled = false; bb.innerText = 'さより百烈拳';
      try { $('hud-controls').classList.remove('bomb-active'); } catch (_) {}
      S.supported = false;
      GameSound.unlock();
      GameSound.stopBGM();

      if (!game) {
        var c = $('game-container');
        cfg.width  = c.clientWidth  || window.innerWidth;
        cfg.height = c.clientHeight || window.innerHeight;
        game = new Phaser.Game(cfg);
      } else {
        var sc = game.scene.getScene('GameScene');
        if (sc) sc.scene.restart();
      }

      if (typeof BakenekoAnalytics !== 'undefined') {
        BakenekoAnalytics.event('game_start', { nickname: S.nick });
      }
    },

    showResult: function (gs) {
      this.show('screen-result');
      GameSound.startBGM('result');
      var sec = gs.ms / 1000;
      var ss  = sec.toFixed(2);
      $('r-score').innerText = gs.score;
      $('r-time').innerText  = ss;
      $('r-title').innerText = _title(sec);

      var dw = $('r-diff-wrap');
      if (S.bestSec > 0) {
        var d = sec - S.bestSec;
        $('r-diff').innerText = (d >= 0 ? '+' : '') + d.toFixed(2) + 's';
        $('r-diff').style.color = d >= 0 ? '#4caf50' : '#f44336';
        dw.style.display = 'block';
      } else { dw.style.display = 'none'; }
      if (sec > S.bestSec) S.bestSec = sec;

      S.score = gs.score; S.time = ss; S.rank = null;

      if (typeof BakenekoAnalytics !== 'undefined') {
        BakenekoAnalytics.event('game_over', { score: gs.score, time: ss });
      }
      if (typeof BakenekoRanking !== 'undefined') {
        BakenekoRanking.submit(gs.score, S.nick).then(function (r) {
          if (r && r.ok && r.rank) S.rank = r.rank;
        });
      }
      this._stats();

      var sb = $('btn-support-ad');
      sb.style.display = S.supported ? 'none' : '';
      sb.disabled = false;
      $('support-success-overlay').style.display = 'none';
      $('support-error-message').style.display   = 'none';
      $('support-loading-text').style.display     = 'none';
    },

    _stats: function () {
      if (typeof BakenekoStats === 'undefined') return;
      BakenekoStats.get().then(function (s) {
        $('title-play-count').innerText         = s.totalPlays || '0';
        $('title-support-count').innerText      = s.todaySupportCount || '0';
        $('result-support-count-value').innerText = s.todaySupportCount || '0';
      });
    },

    _rank: function () {
      var el = $('ranking-list');
      el.innerHTML = '<p style="text-align:center">読み込み中...</p>';
      $('screen-ranking').classList.remove('hidden');

      if (typeof BakenekoRanking === 'undefined') { el.innerHTML = '<p style="text-align:center">—</p>'; return; }
      BakenekoRanking.fetch(50).then(function (d) {
        if (d.error) { el.innerHTML = '<p style="text-align:center">エラーが発生しました</p>'; return; }
        var items = d.items || [];
        var h = '';
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var dt = ''; try { dt = new Date(it.created_at).toLocaleDateString(); } catch (_) {}
          h += '<div class="rank-item">';
          h += '<span class="rank-no">#' + (it.rank || (i + 1)) + '</span>';
          h += '<span class="rank-name">' + (it.nickname || '名無しさん');
          if (dt) h += '<br><small>' + dt + '</small>';
          h += '</span>';
          h += '<span class="rank-score">' + it.score + '</span>';
          h += '</div>';
        }
        if (!items.length) h = '<p style="text-align:center">まだデータがありません</p>';
        el.innerHTML = h;
      });
    },

    _share: function () {
      if (typeof BakenekoShare === 'undefined') return;
      BakenekoShare.post({
        result: 'さよりパンチ防衛 ' + S.time + '秒 生存！ スコア: ' + S.score,
        rank: S.rank,
        tags: ['さよりパンチ防衛', 'BAKENEKOGAMES'],
        gameUrl: 'https://bakenekocafe.studio/sayori-punch/',
        gameName: 'さよりパンチ防衛',
        imageBlob: null,
        imageFileName: 'sayori-record.png'
      });
    },

    _ad: function () {
      if (typeof BakenekoAds === 'undefined') return;
      var btn = $('btn-support-ad');
      var ld  = $('support-loading-text');
      var err = $('support-error-message');
      var ok  = $('support-success-overlay');

      if (!BakenekoAds.isRewardedAvailable()) { err.style.display = 'block'; return; }
      btn.disabled = true; btn.style.display = 'none';
      ld.style.display = 'block'; err.style.display = 'none';

      BakenekoAds.runRewarded().then(function (granted) {
        ld.style.display = 'none';
        if (granted) {
          ok.style.display = 'block';
          S.supported = true;
          if (typeof BakenekoAnalytics !== 'undefined') BakenekoAnalytics.event('reward_granted');
          App._stats();
        } else {
          btn.style.display = ''; btn.disabled = false;
          err.style.display = 'block';
        }
      });
    }
  };

  function $(id) { return document.getElementById(id); }

  function _title(sec) {
    var n = TITLES[0].n;
    for (var i = TITLES.length - 1; i >= 0; i--) {
      if (sec >= TITLES[i].s) { n = TITLES[i].n; break; }
    }
    return n;
  }

  document.addEventListener('DOMContentLoaded', function () { App.init(); });
})();
