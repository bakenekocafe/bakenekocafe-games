(function () {
  'use strict';

  /* ============================================================
   *  CONFIG
   * ============================================================ */
  var GAME_W = 375;
  var FLOOR_W = 300, FLOOR_H = 20;
  var DROP_H = 140;
  var SETTLE_MS = 1500, SETTLE_V = 0.5;
  var TILT_LIM = Math.PI / 4;
  var API_HOST = (typeof window.BAKENEKO_API_BASE === 'string') ? window.BAKENEKO_API_BASE.trim().replace(/\/+$/, '') : 'https://api.bakenekocafe.studio';
  var GAME_ID = (typeof window.BAKENEKO_GAME_ID === 'string') ? window.BAKENEKO_GAME_ID : 'nameko-balance';

  var TYPES = {
    maru:  { id:'maru',  shape:'roundRect',size:'M', mass:3, rest:0.10, fric:0.6, pts:200, color:'#F5C97F', w:55, h:50, ch:12, speeches:['…','別に','ふーん'] },
    peta:  { id:'peta',  shape:'ellipse',  size:'L', mass:2, rest:0.10, fric:0.7, pts:300, color:'#D4A76A', w:80, h:40,        speeches:['邪魔','どけ','狭い'] },
    chibi: { id:'chibi', shape:'roundRect',size:'S', mass:2, rest:0.15, fric:0.6, pts:150, color:'#E8B4B8', w:38, h:34, ch:6,  speeches:['お前のせい','知らない','ちっ'] }
  };

  var WEIGHTS = [
    { id:'maru',  w:35 },
    { id:'peta',  w:30 },
    { id:'chibi', w:35 }
  ];

  var POWERUP = { id:'floorFix', label:'床固定', color:'#6B9BD1', effect:'floorFix' };
  var POWERUP_CHANCE = 0.06;
  var PU_W = 44, PU_H = 28;
  var FLOOR_FIX_MS = 10000;

  /* ============================================================
   *  Matter.js aliases
   * ============================================================ */
  var Engine     = Matter.Engine;
  var Bodies     = Matter.Bodies;
  var Body       = Matter.Body;
  var Composite  = Matter.Composite;
  var Constraint = Matter.Constraint;

  /* ============================================================
   *  DOM references (set on DOMContentLoaded)
   * ============================================================ */
  var canvas, ctx, container;
  var $screens = {};
  var $hudScore, $nbox0, $nbox1, $popups, $hint;
  var $rScore, $rSpeech, $rankList, $fixTimer, $fixTimerVal;
  var $btnSupport, $supportLoading, $supportError, $supportQueued, $supportOverlay;
  var $supportCountVal, $supportBarWrap, $supportBarFill;
  var supportDoneThisResult = false;
  var todaySupportCount = null;
  var myNick = '';

  /* ============================================================
   *  Display helpers
   * ============================================================ */
  var dpr = 1, dispW = 0, dispH = 0, scale = 1, gameH = 0;

  function resize() {
    var r = container.getBoundingClientRect();
    dpr   = window.devicePixelRatio || 1;
    dispW = r.width;
    dispH = r.height;
    canvas.width  = r.width  * dpr;
    canvas.height = r.height * dpr;
    canvas.style.width  = r.width  + 'px';
    canvas.style.height = r.height + 'px';
    scale = r.width / GAME_W;
    gameH = r.height / scale;
  }

  /* ============================================================
   *  Spawn logic
   * ============================================================ */
  var spHist = [], spQueue = [];

  function spInit() {
    spHist = []; spQueue = [spDraw(), spDraw()];
  }

  function spPop() {
    var id = spQueue.shift();
    spQueue.push(spDraw());
    return TYPES[id];
  }

  function spPeek(i) { return TYPES[spQueue[i]]; }

  function spDraw() {
    var id, ok;
    for (var t = 0; t < 20; t++) {
      id = wPick();
      ok = spValid(id);
      if (ok) break;
    }
    spHist.push(id);
    if (spHist.length > 5) spHist.shift();
    return id;
  }

  function wPick() {
    var total = 0, i;
    for (i = 0; i < WEIGHTS.length; i++) total += WEIGHTS[i].w;
    var r = Math.random() * total;
    for (i = 0; i < WEIGHTS.length; i++) {
      if (r < WEIGHTS[i].w) return WEIGHTS[i].id;
      r -= WEIGHTS[i].w;
    }
    return WEIGHTS[WEIGHTS.length - 1].id;
  }

  function spValid(id) {
    var n = spHist.length;
    if (n >= 1 && spHist[n - 1] === id) return false;
    if (n >= 2 && spHist[n - 2] === id) return false;
    if (n >= 2) {
      var sz = TYPES[id].size;
      if (TYPES[spHist[n - 1]].size === sz && TYPES[spHist[n - 2]].size === sz) return false;
    }
    return true;
  }

  /* ============================================================
   *  Score
   * ============================================================ */
  var totalScore = 0;
  function scoreReset() { totalScore = 0; }
  function scoreAdd(cfg, towerMass, floorY, bodyY) {
    var h = Math.max(0, floorY - bodyY);
    var pts = cfg.pts + Math.floor(h / 40) * 50 + Math.floor(towerMass * 10);
    totalScore += pts;
    return pts;
  }

  /* ============================================================
   *  Ranking API (delegates to core/ranking-client.js)
   * ============================================================ */
  function apiSubmit(nick, score) {
    if (typeof BakenekoRanking !== 'undefined') {
      return BakenekoRanking.submit(score, nick).then(function (r) { return r.ok; });
    }
    return Promise.resolve(false);
  }

  function apiFetch(limit) {
    if (typeof BakenekoRanking !== 'undefined') {
      return BakenekoRanking.fetch(limit).then(function (r) {
        if (r.error) return { error: r.error };
        return r.items;
      });
    }
    return Promise.resolve({ error: 'ranking client not loaded' });
  }

  /* ============================================================
   *  UI helpers
   * ============================================================ */
  function showScreen(name) {
    for (var k in $screens) $screens[k].classList.toggle('hidden', k !== name);
  }

  function hudScore(v) { $hudScore.textContent = v.toLocaleString(); }

  function planNext() {
    // 通常ブロックが6個出たら、7個目をパワーアップにする
    nextIsPowerUp = (sincePowerUp >= 6);
  }

  function hudNext() {
    // nextIsPowerUp が true のときは NEXT にパワーアップを表示
    if (nextIsPowerUp) {
      // メイン枠: パワーアップ
      if ($nbox0) {
        $nbox0.style.backgroundColor = POWERUP.color;
        $nbox0.style.borderColor = '#ffffff';
      }
      // サブ枠: 通常ブロック（次に落ちる通常なめこ）
      var c1 = spPeek(0);
      if ($nbox1) {
        $nbox1.style.backgroundColor = c1 ? c1.color : '#eee';
        $nbox1.style.borderColor = 'rgba(155,142,196,0.3)';
      }
      return;
    }
    // 通常時: キューの先頭2つを表示
    var c0 = spPeek(0), c1n = spPeek(1);
    if ($nbox0) {
      $nbox0.style.backgroundColor = c0 ? c0.color : '#eee';
      $nbox0.style.borderColor = 'rgba(155,142,196,0.3)';
    }
    if ($nbox1) {
      $nbox1.style.backgroundColor = c1n ? c1n.color : '#eee';
      $nbox1.style.borderColor = 'rgba(155,142,196,0.3)';
    }
  }

  function showPopup(pts, sx, sy) {
    var el = document.createElement('div');
    el.className = 'popup';
    el.textContent = (typeof pts === 'number' ? '+' + pts : pts);
    el.style.left = sx + 'px';
    el.style.top  = sy + 'px';
    $popups.appendChild(el);
    setTimeout(function () { el.remove(); }, 1100);
  }

  function getResultSpeech(score, lastCfg) {
    // 0〜10000 を 10 段階、それ以上を 11 段目として評価する
    var lines = [
      '全然ダメだにゃ',          // 0 〜 999
      '努力が必要だにゃ',        // 1000 〜 1999
      '一人前だにゃ',            // 2000 〜 2999
      'エース級だにゃ',          // 3000 〜 3999
      '東京トップクラスだにゃ',  // 4000 〜 4999
      '関東トップクラスだにゃ',  // 5000 〜 5999
      '東日本トップクラスだにゃ',// 6000 〜 6999
      '日本トップクラスだにゃ',  // 7000 〜 7999
      'アジアの最高峰だにゃ',    // 8000 〜 8999
      '世界のトップクラスだにゃ',// 9000 〜 9999
      'ついに、神になったんだにゃ！' // 10000 以上
    ];
    var idx = Math.floor(score / 1000);
    if (idx < 0) idx = 0;
    if (idx > 10) idx = 10;
    return lines[idx];
  }

  var lastSubmitRank = null;

  function showResult(score, lastCfg) {
    $rScore.textContent = score.toLocaleString();
    $rSpeech.textContent = '「' + getResultSpeech(score, lastCfg) + '」';
    supportDoneThisResult = false;
    if ($btnSupport) { $btnSupport.disabled = false; $btnSupport.textContent = '🐱 広告を見てなめこを応援する'; }
    if ($supportLoading) $supportLoading.style.display = 'none';
    if ($supportError) $supportError.style.display = 'none';
    if ($supportQueued) $supportQueued.style.display = 'none';
    if ($supportOverlay) $supportOverlay.style.display = 'none';
    updateSupportDisplay();
    showScreen('result');

    lastSubmitRank = null;
    apiSubmit(myNick, score).then(function (ok) {
      if (ok) {
        apiFetch(20).then(function (data) {
          if (Array.isArray(data)) {
            for (var i = 0; i < data.length; i++) {
              if (data[i].nickname === myNick && data[i].score === score) {
                lastSubmitRank = i + 1;
                break;
              }
            }
          }
        });
      }
    });
  }

  function fetchPublicStats() {
    if (typeof BakenekoStats === 'undefined') return;
    BakenekoStats.get().then(function (s) {
      todaySupportCount = Math.max(0, Math.round(s.todaySupportCount || 0));
      updateSupportDisplay();
      var titlePlay = document.getElementById('title-play-count');
      if (titlePlay && s.totalPlays > 0) titlePlay.textContent = String(s.totalPlays);
    }).catch(function () {});
  }

  function updateSupportDisplay() {
    var v = todaySupportCount;
    if ($supportCountVal) $supportCountVal.textContent = (v !== null && v >= 0) ? String(v) : '—';
    if ($supportBarWrap) $supportBarWrap.style.display = (v !== null && v >= 0) ? 'block' : 'none';
    if ($supportBarFill && v !== null && v >= 0) {
      var pct = Math.min(100, (v / 100) * 100);
      $supportBarFill.style.width = pct + '%';
    }
    var titleCount = document.getElementById('title-support-count');
    if (titleCount) titleCount.textContent = (v !== null && v >= 0) ? String(v) : '—';
  }

  function startSupportFlow() {
    if (supportDoneThisResult) return;
    if ($btnSupport) { $btnSupport.disabled = true; $btnSupport.textContent = '処理中…'; }
    if ($supportLoading) $supportLoading.style.display = '';

    if (typeof adBreak === 'function') {
      adBreak({
        type: 'reward',
        name: 'support-nameko',
        beforeReward: function() {},
        adViewed: function() { onSupportSuccess(); },
        adDismissed: function() { onSupportFail('広告がスキップされました'); },
        adBreakDone: function() {}
      });
    } else {
      setTimeout(function(){ onSupportSuccess(); }, 500);
    }
  }

  function onSupportSuccess() {
    supportDoneThisResult = true;
    if ($supportLoading) $supportLoading.style.display = 'none';
    if ($btnSupport) { $btnSupport.disabled = true; $btnSupport.textContent = '応援済み！ありがとう'; }
    if ($supportOverlay) $supportOverlay.style.display = '';

    if (typeof BakenekoAnalytics !== 'undefined') {
      BakenekoAnalytics.event('reward_granted', {});
    }

    if (todaySupportCount !== null) todaySupportCount++;
    updateSupportDisplay();
  }

  function onSupportFail(msg) {
    if ($supportLoading) $supportLoading.style.display = 'none';
    if ($supportError) { $supportError.textContent = msg || '現在応援できません'; $supportError.style.display = ''; }
    if ($btnSupport) { $btnSupport.disabled = false; $btnSupport.textContent = '🐱 広告を見てなめこを応援する'; }
  }

  function renderRanking(data, myNick) {
    $rankList.innerHTML = '';
    if (data && data.error) {
      $rankList.innerHTML = '<div style="padding:16px;text-align:center;color:#c44">' +
        '読み込み失敗<br><small style="color:#999">' + data.error + '</small></div>';
      return;
    }
    if (!data || !Array.isArray(data) || !data.length) {
      $rankList.innerHTML = '<div style="padding:16px;text-align:center;color:#aaa">データなし</div>';
      return;
    }
    for (var i = 0; i < data.length; i++) {
      var it = data[i];
      var d = document.createElement('div');
      d.className = 'rank-row' + (it.nickname === myNick ? ' me' : '');
      d.innerHTML =
        '<span class="rk">' + (i + 1) + '</span>' +
        '<span class="rn">' + esc(it.nickname || '名無し') + '</span>' +
        '<span class="rs">' + (it.score || 0).toLocaleString() + '</span>';
      $rankList.appendChild(d);
    }
  }

  function esc(s) {
    var el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  /* ============================================================
   *  GAME STATE
   * ============================================================ */
  var engine = null;
  var state  = 'idle';       // idle | playing | dropping | gameover
  var namekos = [];          // settled namekos
  var active  = null;        // { body, cfg or powerUp, st, timer, isPowerUp? }
  var floor = null, floorPin = null;
  var camY = 0, camTarget = 0;
  var floorY = 0;
  var goTimer = null;
  var floorFixedUntil = 0;
  var bgImg = null;
  var bgImgProcessed = null;
  var resultImg = null;
  var resultImgProcessed = null;
  var puFlashAlpha = 0;
  var puParticles = [];
  var bgPaws = [];
  var ambientDust = [];
  var sincePowerUp = 0;
  var nextIsPowerUp = false;
  var bgFlipTimer = 0;
  var bgFlipSide = 1;
  var audioCtx = null;
  var bgmGain = null;
  var bgmOscs = [];
  var bgmPlaying = false;

  /* --- World init --- */
  function initWorld() {
    if (engine) {
      Composite.clear(engine.world);
      Engine.clear(engine);
    }
    engine = Engine.create({ gravity: { x: 0, y: 1 } });

    namekos  = [];
    active   = null;
    camY     = 0;
    camTarget = 0;
    floorFixedUntil = 0;
    sincePowerUp = 0;
    nextIsPowerUp = false;
    bgFlipTimer = 0;
    bgFlipSide = 1;

    floorY = gameH * 0.72;
    var cx = GAME_W / 2;

    floor = Bodies.rectangle(cx, floorY, FLOOR_W, FLOOR_H, {
      friction: 0.8, restitution: 0.05, label: 'floor'
    });

    floorPin = Constraint.create({
      pointA: { x: cx, y: floorY },
      bodyB: floor,
      pointB: { x: 0, y: 0 },
      stiffness: 1, length: 0
    });

    Body.setInertia(floor, floor.inertia * 40);
    floor.frictionAir = 0.06;

    Composite.add(engine.world, [floor, floorPin]);

    bgPaws = [];
    ambientDust = [];
    for (var pi = 0; pi < 14; pi++) {
      bgPaws.push({
        type: 'paw',
        x: Math.random() * GAME_W,
        y: floorY - 1500 + Math.random() * 2200,
        size: 10 + Math.random() * 18,
        rot: Math.random() * Math.PI * 2,
        alpha: 0.14 + Math.random() * 0.12
      });
    }
    for (var si = 0; si < 6; si++) {
      bgPaws.push({
        type: 'star',
        x: Math.random() * GAME_W,
        y: floorY - 1200 + Math.random() * 1800,
        size: 5 + Math.random() * 8,
        rot: 0,
        alpha: 0.18 + Math.random() * 0.12
      });
    }
  }

  /* --- Start game --- */
  function startGame() {
    if (goTimer) { clearTimeout(goTimer); goTimer = null; }

    initWorld();
    scoreReset();
    hudScore(0);
    spInit();
    sincePowerUp = 0;
    planNext();
    hudNext();

    // BGM 再生（初回スタート時に有効化）
    playBgm();
    if ($hint) $hint.style.display = '';

    showScreen('hud');
    state = 'idle';
    spawnOne();
  }

  /* --- Spawn --- */
  function spawnOne() {
    if (state === 'gameover') return;

    var topY = floorY - FLOOR_H / 2;
    for (var i = 0; i < namekos.length; i++) {
      var t = namekos[i].body.bounds.min.y;
      if (t < topY) topY = t;
    }

    var sy = topY - DROP_H;
    var sx = GAME_W / 2;

    if (nextIsPowerUp) {
      // 確定パワーアップ
      active = makePowerUpBody(sx, sy, POWERUP);
      active.isPowerUp = true;
      active.powerUp = POWERUP;
      sincePowerUp = 0;
    } else {
      // 通常なめこ
      var cfg = spPop();
      active = makeBody(sx, sy, cfg);
      sincePowerUp++;
    }

    Body.setStatic(active.body, true);
    Composite.add(engine.world, active.body);
    state = 'playing';

    // 次の1個を計画してNEXT表示を更新
    planNext();
    hudNext();
  }

  function makePowerUpBody(x, y, pu) {
    var b = Bodies.rectangle(x, y, PU_W, PU_H, {
      restitution: 0.1, friction: 0.6, label: 'powerup',
      chamfer: { radius: 6 }
    });
    Body.setMass(b, 1);
    return { body: b, st: 'held', timer: 0 };
  }

  function makeBody(x, y, cfg) {
    var o = { restitution: cfg.rest, friction: cfg.fric, label: 'n_' + cfg.id };
    var b;
    switch (cfg.shape) {
      case 'circle':    b = Bodies.circle(x, y, cfg.r, o); break;
      case 'ellipse':   b = Bodies.rectangle(x, y, cfg.w, cfg.h, Object.assign({}, o, { chamfer: { radius: Math.min(cfg.w, cfg.h) * 0.4 } })); break;
      case 'roundRect': b = Bodies.rectangle(x, y, cfg.w, cfg.h, Object.assign({}, o, { chamfer: { radius: cfg.ch || 8 } })); break;
      case 'capsule':   b = Bodies.rectangle(x, y, cfg.w, cfg.h, Object.assign({}, o, { chamfer: { radius: cfg.w / 2 } })); break;
      case 'trapezoid': b = Bodies.trapezoid(x, y, cfg.w, cfg.h, cfg.sl || 0.3, o); break;
      case 'triangle':  b = Bodies.polygon(x, y, 3, cfg.r, o); break;
      default:          b = Bodies.rectangle(x, y, 40, 40, o);
    }
    Body.setMass(b, cfg.mass);
    return { body: b, cfg: cfg, st: 'held', timer: 0 };
  }

  /* --- Input --- */
  var dragging = false;
  var activePointerId = null;

  function bindInput() {
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (state !== 'playing' || !active) return;
      if (active.st !== 'held') return;
      dragging = true;
      activePointerId = e.pointerId;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      if ($hint) $hint.style.display = 'none';
      moveActive(e.clientX);
    });

    canvas.addEventListener('pointermove', function (e) {
      e.preventDefault();
      if (!dragging || e.pointerId !== activePointerId) return;
      moveActive(e.clientX);
    });

    function up(e) {
      if (!dragging) return;
      if (e && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;
      if (state === 'playing' && active && active.st === 'held') {
        Body.setStatic(active.body, false);
        active.st = 'dropping';
        state = 'dropping';
      }
    }
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('lostpointercapture', up);
    window.addEventListener('pointerup', up);
  }

  function moveActive(screenX) {
    if (!active || active.st !== 'held') return;
    var r = container.getBoundingClientRect();
    var lx = (screenX - r.left) / scale;
    lx = Math.max(30, Math.min(GAME_W - 30, lx));
    Body.setPosition(active.body, { x: lx, y: active.body.position.y });
  }

  /* ============================================================
   *  GAME LOOP
   * ============================================================ */
  function loop() {
    requestAnimationFrame(loop);

    if (state === 'idle') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    // Physics
    Engine.update(engine, 1000 / 60);

    // 背景なめこの左右反転タイマー（約1秒ごと）
    bgFlipTimer += 1000 / 60;
    if (bgFlipTimer >= 1000) {
      bgFlipTimer = 0;
      bgFlipSide *= -1;
    }

    // Logic (skip during gameover)
    if (state !== 'gameover') {
      if (floor && Math.abs(floor.angle) > TILT_LIM) { gameOver(); }
      else {
        var lim = floorY + 300;
        var fell = false;
        for (var i = 0; i < namekos.length; i++) {
          if (namekos[i].body.position.y > lim) { fell = true; break; }
        }
        if (!fell && active && active.st === 'dropping' && active.body.position.y > lim) fell = true;
        if (fell) gameOver();
      }
      if (floorFixedUntil > Date.now() && floor) {
        floor.angle = 0;
        floor.angularVelocity = 0;
      }
      // settle check
      if (state === 'dropping' && active && active.st === 'dropping') {
        var v = active.body.velocity;
        var sp = Math.sqrt(v.x * v.x + v.y * v.y);
        if (sp < SETTLE_V) {
          active.timer += 1000 / 60;
          if (active.timer >= SETTLE_MS) settle();
        } else {
          active.timer = 0;
        }
      }
    }

    // Fix-timer HUD
    var fixRemain = floorFixedUntil - Date.now();
    if (fixRemain > 0) {
      if ($fixTimer) $fixTimer.classList.remove('hidden');
      if ($fixTimerVal) $fixTimerVal.textContent = (fixRemain / 1000).toFixed(1);
    } else {
      if ($fixTimer) $fixTimer.classList.add('hidden');
    }

    // Power-up particles
    if (puFlashAlpha > 0) puFlashAlpha -= 0.02;
    for (var pi = puParticles.length - 1; pi >= 0; pi--) {
      var p = puParticles[pi];
      p.y -= p.vy;
      p.x += p.vx;
      p.life -= 0.015;
      if (p.life <= 0) puParticles.splice(pi, 1);
    }
    if (floorFixedUntil > Date.now() && Math.random() < 0.3) {
      puParticles.push({
        x: Math.random() * dispW,
        y: dispH + 5,
        vx: (Math.random() - 0.5) * 1.5,
        vy: 1 + Math.random() * 2,
        size: 3 + Math.random() * 5,
        life: 1
      });
    }

    // Ambient dust
    if (ambientDust.length < 25 && Math.random() < 0.12) {
      ambientDust.push({
        x: Math.random() * dispW,
        y: dispH + 5,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -(0.2 + Math.random() * 0.4),
        size: 2 + Math.random() * 3,
        alpha: 0.22 + Math.random() * 0.2,
        life: 1,
        color: ['#D4A76A','#E8B4B8','#5CB8A5','#9B8EC4','#E8927C','#7BA7CC'][Math.floor(Math.random()*6)]
      });
    }
    for (var ai = ambientDust.length - 1; ai >= 0; ai--) {
      var ad = ambientDust[ai];
      ad.x += ad.vx;
      ad.y += ad.vy;
      ad.life -= 0.003;
      if (ad.life <= 0 || ad.y < -10) ambientDust.splice(ai, 1);
    }

    // Camera
    updateCam();
    // Render
    render();
  }

  function ensureAudioCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function playSeDropSound() {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.12);
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.15);

    var n = ctx.createBufferSource();
    var buf = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.15;
    n.buffer = buf;
    var ng = ctx.createGain();
    ng.gain.setValueAtTime(0.2, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    n.connect(ng);
    ng.connect(ctx.destination);
    n.start(t);
  }

  function playSeGameOverSound() {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    var t = ctx.currentTime;
    var notes = [440, 370, 311, 261];
    for (var i = 0; i < notes.length; i++) {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(notes[i], t + i * 0.2);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.3, t + i * 0.2);
      g.gain.setValueAtTime(0.3, t + i * 0.2);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.2 + 0.25);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t + i * 0.2);
      osc.stop(t + i * 0.2 + 0.25);
    }
    var sub = ctx.createOscillator();
    var sg = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, t);
    sub.frequency.exponentialRampToValueAtTime(40, t + 1.0);
    sg.gain.setValueAtTime(0.25, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    sub.connect(sg);
    sg.connect(ctx.destination);
    sub.start(t);
    sub.stop(t + 1.0);
  }

  function playBgm() {
    var ctx = ensureAudioCtx();
    if (!ctx || bgmPlaying) return;
    bgmPlaying = true;
    bgmGain = ctx.createGain();
    bgmGain.gain.value = 0.08;
    bgmGain.connect(ctx.destination);

    var melody = [262, 294, 330, 349, 392, 349, 330, 294,
                  262, 330, 392, 523, 392, 330, 294, 262];
    var noteLen = 0.25;
    var loopLen = melody.length * noteLen;

    function scheduleLoop() {
      if (!bgmPlaying) return;
      var t = ctx.currentTime + 0.05;
      for (var i = 0; i < melody.length; i++) {
        var osc = ctx.createOscillator();
        var ng = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = melody[i];
        ng.gain.setValueAtTime(0, t + i * noteLen);
        ng.gain.linearRampToValueAtTime(1, t + i * noteLen + 0.02);
        ng.gain.setValueAtTime(1, t + i * noteLen + noteLen * 0.7);
        ng.gain.linearRampToValueAtTime(0, t + i * noteLen + noteLen * 0.95);
        osc.connect(ng);
        ng.connect(bgmGain);
        osc.start(t + i * noteLen);
        osc.stop(t + i * noteLen + noteLen * 0.95);
        bgmOscs.push(osc);
      }
      bgmOscs._timer = setTimeout(scheduleLoop, loopLen * 1000 - 50);
    }
    scheduleLoop();
  }

  function stopBgm() {
    bgmPlaying = false;
    if (bgmOscs._timer) clearTimeout(bgmOscs._timer);
    for (var i = 0; i < bgmOscs.length; i++) {
      try { bgmOscs[i].stop(); } catch (_) { }
    }
    bgmOscs = [];
    if (bgmGain) { try { bgmGain.disconnect(); } catch (_) { } bgmGain = null; }
  }

  function settle() {
    active.st = 'settled';

    if (active.isPowerUp) {
      Composite.remove(engine.world, active.body);
      applyPowerUp(active.powerUp);
      var sx = active.body.position.x * scale;
      var sy = (active.body.position.y - camY) * scale;
      showPopup(active.powerUp.label, sx, sy);
      active = null;
      spawnOne();
      return;
    }

    playSeDropSound();

    var mass = 0;
    for (var i = 0; i < namekos.length; i++) mass += namekos[i].cfg.mass;
    var pts = scoreAdd(active.cfg, mass, floorY, active.body.position.y);
    hudScore(totalScore);

    var sx = active.body.position.x * scale;
    var sy = (active.body.position.y - camY) * scale;
    showPopup('+' + pts, sx, sy);

    namekos.push(active);
    active = null;
    spawnOne();
  }

  function applyPowerUp(pu) {
    if (pu.effect === 'floorFix') {
      floorFixedUntil = Date.now() + FLOOR_FIX_MS;
      if (floor) { floor.angle = 0; floor.angularVelocity = 0; }
      puFlashAlpha = 0.6;
      for (var i = 0; i < 20; i++) {
        puParticles.push({
          x: dispW * 0.5 + (Math.random() - 0.5) * 200,
          y: dispH * 0.5 + (Math.random() - 0.5) * 200,
          vx: (Math.random() - 0.5) * 3,
          vy: 1 + Math.random() * 3,
          size: 4 + Math.random() * 8,
          life: 1
        });
      }
    }
  }

  function gameOver() {
    if (state === 'gameover') return;
    state = 'gameover';
    engine.timing.timeScale = 0.15;

    playSeGameOverSound();

    if (active && active.isPowerUp) {
      Composite.remove(engine.world, active.body);
      active = null;
    }
    if (floorPin) {
      Composite.remove(engine.world, floorPin);
      floorPin = null;
    }
    camTarget = 0;

    goTimer = setTimeout(function () {
      goTimer = null;
      if (state !== 'gameover') return;
      var last = namekos.length > 0 ? namekos[namekos.length - 1].cfg : null;
      showResult(totalScore, last);
    }, 2500);
  }

  function updateCam() {
    if (state === 'gameover') {
      camY += (0 - camY) * 0.05;
      return;
    }
    var top = floorY;
    for (var i = 0; i < namekos.length; i++) {
      if (namekos[i].body.position.y < top) top = namekos[i].body.position.y;
    }
    if (active && active.body.position.y < top) top = active.body.position.y;

    var t = top - gameH * 0.3;
    if (t < camTarget) camTarget = t;
    if (camTarget > 0) camTarget = 0;
    camY += (camTarget - camY) * 0.08;
  }

  /* ============================================================
   *  RENDER
   * ============================================================ */
  function render() {
    var c = ctx;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.save();
    c.scale(dpr, dpr);

    // BG gradient (warmer, more depth)
    var bg = c.createLinearGradient(0, 0, 0, dispH);
    bg.addColorStop(0, '#fdfbf7');
    bg.addColorStop(0.4, '#f5efe6');
    bg.addColorStop(1, '#e8dfd3');
    c.fillStyle = bg;
    c.fillRect(0, 0, dispW, dispH);

    // Corner warm glows (multi-color)
    var cg1 = c.createRadialGradient(0, 0, 0, 0, 0, dispW * 0.5);
    cg1.addColorStop(0, 'rgba(155,142,196,0.25)');
    cg1.addColorStop(1, 'rgba(155,142,196,0)');
    c.fillStyle = cg1;
    c.fillRect(0, 0, dispW, dispH);
    var cg2 = c.createRadialGradient(dispW, dispH, 0, dispW, dispH, dispW * 0.45);
    cg2.addColorStop(0, 'rgba(232,146,124,0.22)');
    cg2.addColorStop(1, 'rgba(232,146,124,0)');
    c.fillStyle = cg2;
    c.fillRect(0, 0, dispW, dispH);
    var cg3 = c.createRadialGradient(dispW, 0, 0, dispW, 0, dispW * 0.4);
    cg3.addColorStop(0, 'rgba(92,184,165,0.18)');
    cg3.addColorStop(1, 'rgba(92,184,165,0)');
    c.fillStyle = cg3;
    c.fillRect(0, 0, dispW, dispH);
    var cg4 = c.createRadialGradient(0, dispH, 0, 0, dispH, dispW * 0.4);
    cg4.addColorStop(0, 'rgba(218,165,32,0.15)');
    cg4.addColorStop(1, 'rgba(218,165,32,0)');
    c.fillStyle = cg4;
    c.fillRect(0, 0, dispW, dispH);

    // Background paw prints (in game coordinates)
    c.save();
    c.scale(scale, scale);
    c.translate(0, -camY);
    for (var di = 0; di < bgPaws.length; di++) {
      var dp = bgPaws[di];
      if (dp.type === 'star') {
        drawStarBg(c, dp.x, dp.y, dp.size, dp.alpha);
      } else {
        drawPawBg(c, dp.x, dp.y, dp.size, dp.rot, dp.alpha);
      }
    }
    c.restore();

    // Ambient dust particles
    for (var ai = 0; ai < ambientDust.length; ai++) {
      var ad = ambientDust[ai];
      var adAlpha = ad.alpha * (ad.life < 0.2 ? ad.life / 0.2 : (ad.life > 0.8 ? (1 - ad.life) / 0.2 : 1));
      c.globalAlpha = adAlpha;
      c.fillStyle = ad.color;
      c.beginPath();
      c.arc(ad.x, ad.y, ad.size, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;

    // Background cat image (chroma-keyed, flip horizontally every second)
    var isFixed = floorFixedUntil > Date.now();
    if (!isFixed && bgImgProcessed) {
      var imgW = dispW * 1.1;
      var imgH = imgW * (bgImgProcessed.height / bgImgProcessed.width);
      var imgX = (dispW - imgW) / 2;
      var imgY = dispH - imgH;
      c.save();
      if (bgFlipSide < 0) {
        // 左右反転
        c.translate(dispW, 0);
        c.scale(-1, 1);
        c.drawImage(bgImgProcessed, imgX, imgY, imgW, imgH);
      } else {
        c.drawImage(bgImgProcessed, imgX, imgY, imgW, imgH);
      }
      c.restore();
    }

    // Power-up particles (behind game layer)
    for (var pi = 0; pi < puParticles.length; pi++) {
      var pp = puParticles[pi];
      c.globalAlpha = pp.life * 0.7;
      c.fillStyle = '#6BC5FF';
      c.beginPath();
      c.arc(pp.x, pp.y, pp.size, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;

    // Flash overlay
    if (puFlashAlpha > 0) {
      c.fillStyle = 'rgba(107,155,209,' + puFlashAlpha + ')';
      c.fillRect(0, 0, dispW, dispH);
    }

    // Game-coord transform
    c.save();
    c.scale(scale, scale);
    c.translate(0, -camY);

    // Pillar (wood grain)
    var pw = 24, pcx = GAME_W / 2;
    var pillarGrad = c.createLinearGradient(pcx - pw / 2, 0, pcx + pw / 2, 0);
    pillarGrad.addColorStop(0, '#B88E58');
    pillarGrad.addColorStop(0.3, '#D4A76A');
    pillarGrad.addColorStop(0.7, '#C49A5C');
    pillarGrad.addColorStop(1, '#A8834E');
    c.fillStyle = pillarGrad;
    c.fillRect(pcx - pw / 2, floorY, pw, gameH);
    c.strokeStyle = 'rgba(139,111,71,0.3)';
    c.lineWidth = 1;
    for (var yl = floorY; yl < floorY + gameH; yl += 8) {
      c.beginPath(); c.moveTo(pcx - pw / 2, yl); c.lineTo(pcx + pw / 2, yl); c.stroke();
    }
    c.strokeStyle = '#A07840';
    c.lineWidth = 1.5;
    c.strokeRect(pcx - pw / 2, floorY, pw, gameH);

    // Floor (cat tower shelf)
    if (floor) {
      c.save();
      c.translate(floor.position.x, floor.position.y);
      c.rotate(floor.angle);
      var flGrad = c.createLinearGradient(0, -FLOOR_H / 2, 0, FLOOR_H / 2);
      flGrad.addColorStop(0, '#E0C89B');
      flGrad.addColorStop(0.4, '#D4A76A');
      flGrad.addColorStop(1, '#C49A5C');
      c.fillStyle = flGrad;
      c.fillRect(-FLOOR_W / 2, -FLOOR_H / 2, FLOOR_W, FLOOR_H);
      c.fillStyle = 'rgba(255,255,255,0.2)';
      c.fillRect(-FLOOR_W / 2 + 2, -FLOOR_H / 2 + 1, FLOOR_W - 4, 4);
      c.strokeStyle = '#A07840';
      c.lineWidth = 2;
      c.strokeRect(-FLOOR_W / 2, -FLOOR_H / 2, FLOOR_W, FLOOR_H);
      c.strokeStyle = 'rgba(139,111,71,0.35)';
      c.lineWidth = 1;
      for (var fi = -FLOOR_W / 2 + 25; fi < FLOOR_W / 2; fi += 25) {
        c.beginPath(); c.moveTo(fi, -FLOOR_H / 2 + 2); c.lineTo(fi, FLOOR_H / 2 - 2); c.stroke();
      }
      if (floorFixedUntil > Date.now()) {
        c.strokeStyle = 'rgba(107,197,255,' + (0.5 + 0.3 * Math.sin(Date.now() / 200)) + ')';
        c.lineWidth = 3;
        c.strokeRect(-FLOOR_W / 2 - 3, -FLOOR_H / 2 - 3, FLOOR_W + 6, FLOOR_H + 6);
      }
      c.restore();
    }

    // Namekos
    for (var i = 0; i < namekos.length; i++) drawNameko(c, namekos[i]);
    if (active) {
      if (active.isPowerUp) drawPowerUp(c, active); else drawNameko(c, active);
    }

    // Guide line
    if (active && active.st === 'held') {
      var ax = active.body.position.x;
      c.setLineDash([4, 4]);
      c.strokeStyle = 'rgba(139,111,71,0.25)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(ax, active.body.position.y + 20);
      c.lineTo(ax, floorY - 5);
      c.stroke();
      c.setLineDash([]);
    }

    c.restore(); // game-coord

    // 床固定発動中！ — 最前面に大きく表示
    if (floorFixedUntil > Date.now()) {
      c.save();
      c.font = 'bold 56px "M PLUS Rounded 1c"';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.strokeStyle = '#fff';
      c.lineWidth = 6;
      c.strokeText('床固定発動中！', dispW / 2, dispH * 0.45);
      c.fillStyle = '#1a5fb4';
      c.fillText('床固定発動中！', dispW / 2, dispH * 0.45);
      c.restore();
    }

    // Vignette
    var vigGrad = c.createRadialGradient(dispW / 2, dispH / 2, dispW * 0.32, dispW / 2, dispH / 2, dispW * 0.85);
    vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
    vigGrad.addColorStop(1, 'rgba(74,55,40,0.22)');
    c.fillStyle = vigGrad;
    c.fillRect(0, 0, dispW, dispH);

    // Side frame edges (gradient color)
    var sfL = c.createLinearGradient(0, 0, 0, dispH);
    sfL.addColorStop(0, 'rgba(155,142,196,0.18)');
    sfL.addColorStop(0.5, 'rgba(92,184,165,0.15)');
    sfL.addColorStop(1, 'rgba(232,146,124,0.18)');
    c.fillStyle = sfL;
    c.fillRect(0, 0, 5, dispH);
    c.fillRect(dispW - 5, 0, 5, dispH);

    c.restore(); // dpr
  }

  function drawPawBg(c, x, y, size, rot, alpha) {
    c.save();
    c.translate(x, y);
    c.rotate(rot);
    c.globalAlpha = Math.min(1, alpha * 1.2);
    var pawColors = ['#6B4F37','#9B8EC4','#5CB8A5','#E8927C'];
    c.fillStyle = pawColors[Math.floor(x + y) % pawColors.length];
    c.beginPath();
    c.ellipse(0, size * 0.25, size * 0.45, size * 0.35, 0, 0, Math.PI * 2);
    c.fill();
    var tr = size * 0.2;
    c.beginPath(); c.arc(-size * 0.32, -size * 0.15, tr, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(0, -size * 0.32, tr, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(size * 0.32, -size * 0.15, tr, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  function drawStarBg(c, x, y, size, alpha) {
    c.save();
    c.globalAlpha = Math.min(1, alpha * 1.2);
    var starColors = ['#DAA520','#E8927C','#9B8EC4','#5CB8A5'];
    c.fillStyle = starColors[Math.floor(x + y) % starColors.length];
    c.beginPath();
    for (var i = 0; i < 4; i++) {
      var ang = (Math.PI / 2) * i;
      c.lineTo(x + Math.cos(ang) * size, y + Math.sin(ang) * size);
      c.lineTo(x + Math.cos(ang + Math.PI / 4) * size * 0.35, y + Math.sin(ang + Math.PI / 4) * size * 0.35);
    }
    c.closePath();
    c.fill();
    c.restore();
  }

  function drawNameko(c, n) {
    var b = n.body;
    var v = b.vertices;
    c.save();
    c.beginPath();
    c.moveTo(v[0].x, v[0].y);
    for (var i = 1; i < v.length; i++) c.lineTo(v[i].x, v[i].y);
    c.closePath();
    c.fillStyle = n.cfg.color;
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = '#4A3728';
    c.stroke();
    c.restore();
  }

  function drawPowerUp(c, n) {
    var b = n.body;
    var v = b.vertices;
    var pu = n.powerUp;
    c.save();
    c.beginPath();
    c.moveTo(v[0].x, v[0].y);
    for (var i = 1; i < v.length; i++) c.lineTo(v[i].x, v[i].y);
    c.closePath();
    c.fillStyle = pu.color;
    c.fill();
    c.fillStyle = '#fff';
    c.font = 'bold 14px "M PLUS Rounded 1c"';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(pu.label, b.position.x, b.position.y);
    c.lineWidth = 2;
    c.strokeStyle = '#4A3728';
    c.stroke();
    c.restore();
  }

  /* ============================================================
   *  CHROMA KEY
   * ============================================================ */
  function chromaKey(img) {
    var cv = document.createElement('canvas');
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    var c = cv.getContext('2d');
    c.drawImage(img, 0, 0);
    var d = c.getImageData(0, 0, cv.width, cv.height);
    var px = d.data;
    for (var i = 0; i < px.length; i += 4) {
      var r = px[i], g = px[i + 1], b = px[i + 2];
      var isGreen = g > 180 && g - r > 70 && g - b > 70;
      if (isGreen) px[i + 3] = 0;
    }
    c.putImageData(d, 0, 0);
    return cv;
  }

  /* ============================================================
   *  INIT
   * ============================================================ */
  document.addEventListener('DOMContentLoaded', function () {
    canvas    = document.getElementById('game-canvas');
    ctx       = canvas.getContext('2d');
    container = document.getElementById('game-container');

    $screens.title    = document.getElementById('screen-title');
    $screens.nickname = document.getElementById('screen-nickname');
    $screens.hud      = document.getElementById('screen-hud');
    $screens.result   = document.getElementById('screen-result');
    $screens.ranking  = document.getElementById('screen-ranking');

    $hudScore = document.getElementById('hud-score-val');
    $nbox0    = document.getElementById('nbox-0');
    $nbox1    = document.getElementById('nbox-1');
    $popups   = document.getElementById('popup-layer');
    $hint     = document.getElementById('hint');
    $rScore   = document.getElementById('r-score');
    $rSpeech  = document.getElementById('r-speech');
    $rankList = document.getElementById('ranking-list');
    $fixTimer = document.getElementById('fix-timer');
    $fixTimerVal = document.getElementById('fix-timer-val');
    $btnSupport = document.getElementById('btn-support-ad');
    $supportLoading = document.getElementById('support-loading-text');
    $supportError = document.getElementById('support-error-message');
    $supportQueued = document.getElementById('support-queued-message');
    $supportOverlay = document.getElementById('support-success-overlay');
    $supportCountVal = document.getElementById('result-support-count-value');
    $supportBarWrap = document.getElementById('result-support-bar-wrap');
    $supportBarFill = document.getElementById('result-support-bar-fill');


    bgImg = new Image();
    bgImg.onload = function () {
      bgImgProcessed = chromaKey(bgImg);
      var tc = document.getElementById('title-cat-canvas');
      if (tc && bgImgProcessed) {
        var s = 280;
        tc.width = s;
        tc.height = s;
        var tctx = tc.getContext('2d');
        tctx.fillStyle = '#f5efe6';
        tctx.fillRect(0, 0, s, s);
        tctx.drawImage(bgImgProcessed, 0, 0, bgImgProcessed.width, bgImgProcessed.height, 0, 0, s, s);
      }
    };
    bgImg.src = 'namekohaikei1.png';

    // Result cat image (wide, chroma-keyed)
    resultImg = new Image();
    resultImg.onload = function () {
      // リザルト用なめこ画像もクロマキーして横長キャンバスに描画
      resultImgProcessed = chromaKey(resultImg);
      var rc = document.getElementById('result-cat-canvas');
      if (rc && resultImgProcessed) {
        var w = 320, h = 160;
        rc.width = w;
        rc.height = h;
        var rctx = rc.getContext('2d');
        rctx.clearRect(0, 0, w, h);
        var iw = resultImgProcessed.width;
        var ih = resultImgProcessed.height;
        if (iw > 0 && ih > 0) {
          var scale = Math.min(w / iw, h / ih);
          var dw = iw * scale;
          var dh = ih * scale;
          var dx = (w - dw) / 2;
          var dy = (h - dh) / 2;
          rctx.drawImage(resultImgProcessed, 0, 0, iw, ih, dx, dy, dw, dh);
        }
      }
    };
    // nameko-balance フォルダ直下の画像を参照（ファイル名: namekobalancerizaruto.png）
    resultImg.src = 'namekobalancerizaruto.png';

    resize();
    window.addEventListener('resize', resize);
    bindInput();

    myNick = localStorage.getItem('nameko_nickname') || '';
    var nickInput = document.getElementById('input-nickname');
    nickInput.value = myNick;

    /* --- Buttons --- */
    var btnStart = document.getElementById('btn-start');
    if (btnStart) {
      btnStart.addEventListener('click', function (e) {
        e.preventDefault();
        if (!myNick) {
          showScreen('nickname');
          if (nickInput) nickInput.focus();
        } else {
          startGame();
        }
      });
    }

    var btnNickOk = document.getElementById('btn-nick-ok');
    if (btnNickOk) btnNickOk.addEventListener('click', function () {
      myNick = nickInput && nickInput.value.trim() ? nickInput.value.trim() : '名無しさん';
      localStorage.setItem('nameko_nickname', myNick);
      startGame();
    });

    var btnNickSkip = document.getElementById('btn-nick-skip');
    if (btnNickSkip) btnNickSkip.addEventListener('click', function () {
      myNick = '名無しさん';
      startGame();
    });

    var btnRetry = document.getElementById('btn-retry');
    if (btnRetry) btnRetry.addEventListener('click', function () { startGame(); });

    var btnShare = document.getElementById('btn-share');
    if (btnShare) {
      btnShare.addEventListener('click', function () {
        var speech = getResultSpeech(totalScore, null);
        var resultText = '🐱🏗️ なめこバランス: ' + totalScore.toLocaleString() + '点！\n' + '「' + speech + '」';
        if (typeof BakenekoShare !== 'undefined' && BakenekoShare.post) {
          BakenekoShare.post({
            result: resultText,
            rank: lastSubmitRank,
            tags: ['なめこバランス', 'BAKENEKO GAMES'],
            gameUrl: 'https://bakenekocafe.studio/nameko-balance/',
          });
        } else {
          var text = resultText + '\n\n#なめこバランス #BAKENEKO GAMES\nhttps://bakenekocafe.studio/nameko-balance/';
          window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text), '_blank');
        }
      });
    }

    var rankReturnTo = 'result';
    function openRanking() {
      rankReturnTo = (state === 'idle') ? 'title' : 'result';
      showScreen('ranking');
      $rankList.innerHTML = '<div style="padding:16px;text-align:center;color:#aaa">読み込み中...</div>';
      apiFetch(20).then(function (data) { renderRanking(data, myNick); });
    }
    var btnRanking = document.getElementById('btn-ranking');
    if (btnRanking) btnRanking.addEventListener('click', openRanking);
    var btnTitleRanking = document.getElementById('btn-title-ranking');
    if (btnTitleRanking) btnTitleRanking.addEventListener('click', openRanking);

    var btnRankClose = document.getElementById('btn-rank-close');
    if (btnRankClose) btnRankClose.addEventListener('click', function () {
      showScreen(rankReturnTo);
    });

    if ($btnSupport) $btnSupport.addEventListener('click', function () {
      startSupportFlow();
    });

    fetchPublicStats();

    /* --- Start loop --- */
    loop();
  });
})();
