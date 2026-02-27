/**
 * BAKENEKO GAMES — ポータル共通スクリプト
 * ローダー・のれん・キャンバス・カーソル・スクロール連動など（要素が存在する場合のみ実行）
 */
(function () {
  'use strict';

  // ═══ CANVAS 1 — BG (grid + ink drops + seigaiha) ═══
  (function () {
    const cv = document.getElementById('canvas-bg');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    let W, H, t = 0;
    const GS = 60;
    const drops = Array.from({ length: 8 }, () => ({
      x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
      r: Math.random() * 220 + 80, op: Math.random() * 0.07 + 0.02,
      sp: Math.random() * 0.0004 + 0.0002, ph: Math.random() * Math.PI * 2
    }));
    function resize() { W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#030508'; ctx.fillRect(0, 0, W, H);
      ctx.lineWidth = 0.35;
      for (let x = 0; x < W; x += GS) {
        const a = 0.025 + 0.018 * Math.sin(t * 0.0008 + x * 0.012);
        ctx.strokeStyle = `rgba(0,212,255,${a})`;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let y = 0; y < H; y += GS) {
        const a = 0.018 + 0.012 * Math.sin(t * 0.0008 + y * 0.012);
        ctx.strokeStyle = `rgba(0,212,255,${a})`;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      drops.forEach(d => {
        d.ph += d.sp;
        const o = d.op + 0.016 * Math.sin(d.ph);
        const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
        g.addColorStop(0, `rgba(0,50,70,${o * 3.5})`);
        g.addColorStop(0.5, `rgba(0,20,45,${o})`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
      });
      const SS = 48;
      ctx.globalAlpha = 0.028;
      for (let col = 0; col < Math.ceil(W / SS) + 2; col++) {
        for (let row = 0; row < Math.ceil(H / (SS * 0.7)) + 2; row++) {
          const ox = (row % 2 === 0) ? 0 : SS / 2;
          const x = col * SS + ox - SS; const y = row * SS * 0.7 - SS * 0.7;
          const ph = Math.sin(t * 0.0004 + x * 0.008 + y * 0.008);
          ctx.strokeStyle = ph > 0 ? 'rgba(0,212,255,1)' : 'rgba(255,215,0,1)';
          ctx.lineWidth = 0.9;
          ctx.beginPath(); ctx.arc(x, y, SS / 2, Math.PI, 0); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      t++; requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize); resize(); draw();
  })();

  // ═══ CANVAS 2 — KATAKANA RAIN ═══
  (function () {
    const cv = document.getElementById('canvas-katakana');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン化猫遊夢幻侍忍刀';
    let W, H, cols, drops;
    const FS = 14;
    function resize() {
      W = cv.width = window.innerWidth; H = cv.height = window.innerHeight;
      cols = Math.floor(W / FS); drops = Array.from({ length: cols }, () => Math.random() * -100);
    }
    function draw() {
      ctx.fillStyle = 'rgba(3,5,8,.06)'; ctx.fillRect(0, 0, W, H);
      drops.forEach((y, i) => {
        const ch = CHARS[Math.floor(Math.random() * CHARS.length)];
        const x = i * FS;
        const bright = Math.random() > 0.95;
        ctx.fillStyle = bright ? 'rgba(255,255,255,0.9)' : 'rgba(0,212,255,0.7)';
        ctx.font = `${FS}px 'Share Tech Mono',monospace`;
        ctx.fillText(ch, x, y * FS);
        drops[i] = (y * FS > H && Math.random() > 0.975) ? 0 : y + 1;
      });
      requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize); resize(); draw();
  })();

  // ═══ CANVAS 3 — SAKURA PETALS ═══
  (function () {
    const cv = document.getElementById('canvas-sakura');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    let W, H;
    function createPetal() {
      return {
        x: Math.random() * (window.innerWidth || 1440),
        y: Math.random() * (window.innerHeight || 900) - 100,
        size: Math.random() * 9 + 4,
        speedX: (Math.random() - 0.4) * 0.8,
        speedY: Math.random() * 0.9 + 0.3,
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.04,
        opacity: Math.random() * 0.55 + 0.1,
        swing: Math.random() * Math.PI * 2,
        swingSpeed: Math.random() * 0.025 + 0.01
      };
    }
    const petals = Array.from({ length: 55 }, createPetal);
    function drawPetal(p) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = p.opacity;
      ctx.beginPath();
      ctx.moveTo(0, -p.size);
      ctx.bezierCurveTo(p.size * 0.6, -p.size * 0.5, p.size * 0.6, p.size * 0.5, 0, p.size);
      ctx.bezierCurveTo(-p.size * 0.6, p.size * 0.5, -p.size * 0.6, -p.size * 0.5, 0, -p.size);
      const r = Math.random() > 0.5 ? 'rgba(255,180,200,.6)' : 'rgba(255,215,180,.5)';
      ctx.fillStyle = r; ctx.fill(); ctx.restore();
    }
    function resize() { W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      petals.forEach(p => {
        p.swing += p.swingSpeed;
        p.x += p.speedX + Math.sin(p.swing) * 0.5;
        p.y += p.speedY; p.rot += p.rotSpeed;
        if (p.y > H + 20 || p.x < -20 || p.x > W + 20) {
          const np = createPetal(); np.y = -20; np.x = Math.random() * W;
          Object.assign(p, np);
        }
        drawPetal(p);
      });
      requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize); resize(); draw();
  })();

  // ═══ CUSTOM CURSOR（ポータルトップのみ body.portal-cursor で有効化） ═══
  (function () {
    const cur = document.getElementById('cursor');
    const dot = document.getElementById('cursor-dot');
    if (!cur || !dot) return;
    let mx = 0, my = 0, cx = 0, cy = 0;
    document.addEventListener('mousemove', function (e) {
      mx = e.clientX; my = e.clientY;
      dot.style.left = mx + 'px'; dot.style.top = my + 'px';
    });
    function loop() {
      cx += (mx - cx) * 0.14; cy += (my - cy) * 0.14;
      cur.style.left = cx + 'px'; cur.style.top = cy + 'px';
      requestAnimationFrame(loop);
    }
    loop();
    document.querySelectorAll('a,.portal-cta,.game-card,.step-item,.stat-item').forEach(function (el) {
      el.addEventListener('mouseenter', function () { cur.classList.add('hover'); });
      el.addEventListener('mouseleave', function () { cur.classList.remove('hover'); });
    });
  })();

  // ═══ INK SPLASH ON CLICK ═══
  document.addEventListener('click', function (e) {
    const sp = document.createElement('div');
    sp.className = 'ink-click';
    sp.style.left = e.clientX + 'px'; sp.style.top = e.clientY + 'px';
    document.body.appendChild(sp);
    setTimeout(function () { sp.remove(); }, 700);
  });

  // ═══ HEADER SCROLL + PROGRESS BAR ═══
  var header = document.getElementById('header');
  var pb = document.getElementById('progress-bar');
  if (header || pb) {
    window.addEventListener('scroll', function () {
      if (header) header.classList.toggle('scrolled', window.scrollY > 60);
      if (pb) {
        var maxScroll = document.body.scrollHeight - window.innerHeight;
        var pct = maxScroll > 0 ? (window.scrollY / maxScroll) * 100 : 0;
        pb.style.width = pct + '%';
      }
    });
  }

  // ═══ SCROLL REVEAL ═══
  var revObs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.08 });
  document.querySelectorAll('.portal-section').forEach(function (el) { revObs.observe(el); });

  // ═══ PARALLAX HERO ═══
  var kanji = document.querySelector('.hero-kanji');
  var catSvg = document.querySelector('.hero-cat-svg');
  var heroContent = document.querySelector('.hero-content');
  if (kanji || catSvg || heroContent) {
    window.addEventListener('scroll', function () {
      var y = window.scrollY;
      if (kanji) kanji.style.transform = 'translateY(calc(-50% + ' + (y * 0.22) + 'px))';
      if (catSvg) catSvg.style.transform = 'translateY(' + (y * 0.12) + 'px)';
      if (heroContent) heroContent.style.transform = 'translateY(' + (y * 0.08) + 'px)';
    });
  }

  // ═══ TYPEWRITER TAGLINE ═══
  window.addEventListener('load', function () {
    var tl = document.getElementById('tagline');
    if (!tl) return;
    var orig = tl.innerHTML;
    tl.innerHTML = ''; tl.style.opacity = '1';
    var text = 'PLAY  /  WATCH  /  SUPPORT';
    var i = 0;
    var tm = setInterval(function () {
      tl.textContent += text[i++];
      if (i >= text.length) { clearInterval(tm); tl.innerHTML = orig; }
    }, 55);
  });

  // ═══ WAVEFORM BARS ═══
  (function () {
    var wf = document.getElementById('waveform');
    if (!wf) return;
    var heights = [6, 12, 20, 30, 22, 14, 8, 18, 28, 36, 28, 18, 8, 14, 22, 30, 20, 12, 6];
    heights.forEach(function (h, i) {
      var bar = document.createElement('span');
      bar.style.height = h + 'px';
      bar.style.animationDuration = (0.5 + Math.random() * 0.6) + 's';
      bar.style.animationDelay = (i * 0.06) + 's';
      wf.appendChild(bar);
    });
    var styleEl = document.createElement('style');
    styleEl.textContent = '.hero-waveform span{display:block;width:2px;background:rgba(0,212,255,.35);border-radius:1px;animation:wf-bar .7s ease-in-out infinite alternate}@keyframes wf-bar{from{transform:scaleY(.2)}to{transform:scaleY(1)}}';
    document.head.appendChild(styleEl);
  })();

  // ═══ COUNTER ANIMATION ═══
  var counterObs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var el = e.target.querySelector('.counter-num');
      if (!el) return;
      var target = 100; var cur = 0;
      function step() {
        cur = Math.min(cur + 2, target);
        el.textContent = cur;
        if (cur < target) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
      counterObs.unobserve(e.target);
    });
  }, { threshold: 0.3 });
  document.querySelectorAll('.stat-item').forEach(function (el) { counterObs.observe(el); });

  // ═══ 3D TILT on game cards ═══
  document.querySelectorAll('.game-card').forEach(function (card) {
    card.addEventListener('mousemove', function (e) {
      var r = card.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5;
      var y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = 'perspective(800px) rotateY(' + (x * 12) + 'deg) rotateX(' + (-y * 8) + 'deg) translateY(-6px)';
    });
    card.addEventListener('mouseleave', function () {
      card.style.transform = 'perspective(800px) rotateY(0) rotateX(0) translateY(0)';
    });
  });

  // ═══ MAGNETIC BUTTON ═══
  var ctaBtn = document.getElementById('cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('mousemove', function (e) {
      var r = ctaBtn.getBoundingClientRect();
      var x = (e.clientX - r.left - r.width / 2) * 0.35;
      var y = (e.clientY - r.top - r.height / 2) * 0.35;
      ctaBtn.style.transform = 'translateX(' + x + 'px) translateY(' + y + 'px)';
    });
    ctaBtn.addEventListener('mouseleave', function () {
      ctaBtn.style.transform = 'translateX(0) translateY(0)';
    });
  }

  // ═══ PERIODIC GLITCH FLASH ═══
  setInterval(function () {
    var t = document.querySelector('.hero-title');
    if (!t) return;
    t.style.filter = 'hue-rotate(40deg) brightness(1.6)';
    setTimeout(function () { t.style.filter = 'hue-rotate(0) brightness(1)'; }, 90);
  }, 4500 + Math.random() * 3000);

  // ═══ LOADER → NOREN → REVEAL（ポータルトップのみ） ═══
  var loader = document.getElementById('loader');
  var noren = document.getElementById('noren');
  if (loader || noren) {
    window.addEventListener('load', function () {
      if (loader) {
        setTimeout(function () {
          loader.classList.add('hide');
          setTimeout(function () { loader.remove(); }, 900);
        }, 2000);
      }
      if (noren) {
        setTimeout(function () { noren.remove(); }, 3600);
      }
    });
  }

  // ポータルトップではカスタムカーソル用に body に class
  if (document.body && document.getElementById('cursor')) {
    document.body.classList.add('portal-cursor');
  }

  // ═══ ページビュー計測（全ポータルページ共通） ═══
  (function () {
    var API_BASE = 'https://api.bakenekocafe.studio';
    var sid;
    try { sid = sessionStorage.getItem('bakeneko_session_id'); } catch (_) {}
    if (!sid) {
      sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { sessionStorage.setItem('bakeneko_session_id', sid); } catch (_) {}
    }
    var page = location.pathname.replace(/^\//, '').replace(/\.html$/, '') || 'index';
    try {
      fetch(API_BASE + '/api/analytics/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: 'portal', session_id: sid, event_name: 'page_view', props: { page: page } })
      }).catch(function(){});
    } catch (_) {}
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'portal_page_view', { page_name: page });
      }
    } catch (_) {}
  })();

  // ═══ 本日の応援回数（GET /api/public-stats）60秒TTLキャッシュ・safeGet/safeSet ─══
  (function () {
    var el = document.getElementById('portal-today-support-value');
    if (!el) return;
    var TTL_MS = 60000;
    var cache = { val: null, ts: 0 };
    function safeGet(key) {
      try { var v = localStorage.getItem(key); return v === null ? null : v; } catch (_) { return null; }
    }
    function safeSet(key, value) {
      try {
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, String(value));
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') { /* 容量超過時は握りつぶし（portal はキューを持たない） */ }
      }
    }
    var now = Date.now();
    if (cache.val != null && (now - cache.ts) < TTL_MS) {
      el.textContent = String(cache.val);
      return;
    }
    var apiBase = 'https://api.bakenekocafe.studio';
    fetch(apiBase + '/api/public-stats?gameId=kohada', { method: 'GET', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (data) {
        var n = data && typeof data.todaySupportCount !== 'undefined' ? Number(data.todaySupportCount)
          : (data && typeof data.totalSupportCount !== 'undefined' ? Number(data.totalSupportCount)
            : (data && typeof data.totalRewards !== 'undefined' ? Number(data.totalRewards) : NaN));
        var val = (n !== n || n < 0) ? 0 : Math.round(n);
        el.textContent = String(val);
        safeSet('fallback_today_support', String(val));
        cache.val = val;
        cache.ts = Date.now();
      })
      .catch(function () {
        var fallback = 0;
        var v = safeGet('fallback_today_support');
        if (v !== null && v !== '') { var n = parseInt(v, 10); if (!isNaN(n)) fallback = Math.max(0, n); }
        console.warn('[portal public-stats] 取得失敗。fallback_today_support を使用:', fallback);
        el.textContent = String(fallback);
      });
  })();
})();
