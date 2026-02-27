// ============================================================
// こはだジャンプ～BAKENEKOドリーム～ Game Engine
// ============================================================

const Game = {
    // ─── Constants ───
    GRAVITY: 9.81,
    AIR_RESISTANCE: 0.00001,  // Drastically reduced
    MAX_POWER: 900,
    GOAL_DISTANCE: 100,
    BOOST_IMPULSE: 400,
    TIME_SCALE: 8.0,  // 8x speed simulation (User Request)
    KOHADA_GAME_ID: 'kohada',
    BAKENEKO_API_BASE: 'https://api.bakenekocafe.studio',

    // ─── Sprite Sheet Regions (from green screen image) ───
    // The source image is ~820x1024 with 5 poses:
    //   Top-left: charge/crouch, Top-right: flying
    //   Middle-right: splat/fail, Bottom-left: success/sit, Bottom-right: relaxed/fail
    spriteRegions: {
        charge: { sx: 0, sy: 0, sw: 410, sh: 340 },  // Top-left: crouching
        fly: { sx: 410, sy: 0, sw: 410, sh: 340 },  // Top-right: flying
        splat: { sx: 350, sy: 320, sw: 400, sh: 300 },  // Middle-right: face-down
        success: { sx: 0, sy: 520, sw: 370, sh: 500 },  // Bottom-left: sitting
        fail: { sx: 410, sy: 600, sw: 410, sh: 420 },  // Bottom-right: lying
    },

    // ─── State ───
    state: 'title',
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    nickname: '',
    _lastSubmitRank: null,
    _supportCount: null,       // 本日の応援回数（表示用）
    _supportCountTotal: null,  // 累計応援回数（表示用）
    _supportDoneThisResult: false,  // このリザルトで1回成功したら true（1プレイ1回制限）
    MAX_QUEUE_LENGTH: 10,
    FLUSH_BATCH_SIZE: 3,
    FLUSH_INTERVAL_MS: 500,
    SUPPORT_LOCK_TTL_MS: 5000,
    PUBLIC_STATS_CACHE_TTL_MS: 60000,
    isRewardProcessing: false,
    _flushingQueue: false,
    _flushBackoffMs: 1000,
    _publicStatsCache: null,
    _publicStatsCacheTs: 0,

    // Sprite
    spriteSheet: null,
    spriteCanvases: {},  // Pre-processed sprites with green removed
    spriteLoaded: false,
    cloudCatImage: null,  // 雲に乗る猫の画像
    additionalImages: [],  // 追加画像の配列
    additionalImagesLoaded: 0,  // 読み込み済み画像数
    flyFrames: [],  // 発射後のアニメーションフレーム配列
    flyFrameIndex: 0,  // 現在のフレームインデックス
    flyFrameTimer: 0,  // フレーム切り替えタイマー

    // Phase results
    power: 0,
    angle: 0,
    timing: 0,
    boostUsed: false,

    // Physics
    x: 0, y: 0,
    vx: 0, vy: 0,
    distance: 0,
    altitude: 0,
    maxAlt: 0,
    speed: 0,
    landed: false,
    windowBroken: false,

    // Gauge
    gaugeValue: 0,
    gaugeDir: 1,
    gaugeSpeed: 0,
    phaseActive: false,

    // Camera
    camX: 0, camY: 0,

    // Milestones（ゴール100kmを10区間に等分）
    milestones: [
        { dist: 10000, text: '新宿 通過！', icon: '🏙️', color: '#e84c4c', theme: 'shinjuku' },
        { dist: 20000, text: '都心横断 通過！', icon: '🚃', color: '#ff8844', theme: 'tosin' },
        { dist: 30000, text: '東京タワー 通過！', icon: '🗼', color: '#ff3333', theme: 'tokyo' },
        { dist: 40000, text: 'お台場 通過！', icon: '🎡', color: '#3388ff', theme: 'odaiba' },
        { dist: 50000, text: '海ほたる 通過！', icon: '🐚', color: '#00ccff', theme: 'sea' },
        { dist: 60000, text: '木更津 通過！', icon: '🌊', color: '#22aa88', theme: 'kisarazu' },
        { dist: 70000, text: '鋸山 通過！', icon: '⛰️', color: '#668844', theme: 'nokogiri' },
        { dist: 80000, text: 'マザー牧場 通過！', icon: '🐄', color: '#88cc44', theme: 'mother' },
        { dist: 90000, text: '富津岬 通過！', icon: '🗾', color: '#44aa66', theme: 'futtsu' },
        { dist: 100000, text: '大貫海岸 通過！ 猫又療養所 到着!!', icon: '🏥', color: '#ffd700', theme: 'goal' }
    ],
    triggeredMilestones: new Set(),
    currentMilestone: null,
    milestoneTimer: 0,
    cutInTimer: 0, // For stop effect



    // Visual
    stars: [],
    buildings: [],
    clouds: [],
    particles: [],

    // Timing
    lastTime: 0,
    animId: null,
    shakeTimer: 0,
    flashTimer: 0,
    holdingDown: false,
    gameMessages: [],
    nextMilestone: 10000,
    physicsAccumulator: 0,
    lastInputTime: 0,
    INPUT_THROTTLE_MS: 120,
    inputLock: false,
    INPUT_LOCK_MS: 250,
    _phaseTimeoutId: null,  // フェーズ遷移の setTimeout（2回目落ち防止で retry/startGame 時に必ず解除）
    lastTouchTime: 0,       // スマホ: タップ直後の合成 click を無視する用
    boostTapIgnoreUntil: 0, // 発射後ブースト1回だけ・連打で落ちないように無視する期間の終了時刻

    // ─── Init ───
    init() {
        if (this._inited) return;
        this._inited = true;
        // どこで例外が出ても落ちないようにグローバルでキャッチ
        window.addEventListener('error', function (e) {
            console.warn('Caught error:', e.message, e.filename, e.lineno);
            e.preventDefault();
            return true;
        });
        window.addEventListener('unhandledrejection', function (e) {
            console.warn('Unhandled promise:', e.reason);
            e.preventDefault();
        });

        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        try { this.resize(); } catch (_) {}
        try {
            window.addEventListener('resize', () => { try { this.resize(); } catch (_) {} });
        } catch (_) {}

        // Init sound (starts on first user interaction)
        // Sound.init(); // Deferred to interaction for Mobile support

        // ─── Initialize UI Elements reference ───
        this.els = {
            uiBottom: document.getElementById('ui-bottom'),
            phaseUI: document.getElementById('phase-ui'),
            values: {
                phaseTitle: document.getElementById('phase-title'),
                phaseInstruction: document.getElementById('phase-instruction'),
                phaseValue: document.getElementById('phase-value')
            },
            gauges: {
                sweet: document.getElementById('phase-gauge-sweet')
            }
        };

        const startSound = (e) => {
            try {
                const isStartBtn = e.target && (e.target.id === 'btn-start' || e.target.closest('#btn-start'));
                if (isStartBtn && this.state === 'title') {
                    this.startGame();
                    e.preventDefault();
                    e.stopPropagation();
                }
                if (typeof Sound !== 'undefined') {
                    Sound.unlock();
                    if (Sound.ctx && Sound.ctx.state === 'running') {
                        if (!Sound.bgmPlaying) Sound.startBGM('title');
                        document.removeEventListener('click', startSound, { capture: true });
                        document.removeEventListener('touchstart', startSound, { capture: true });
                        document.removeEventListener('keydown', startSound, { capture: true });
                    }
                }
            } catch (err) { console.warn(err); }
        };
        document.addEventListener('click', startSound, { capture: true });
        document.addEventListener('touchstart', startSound, { capture: true });
        document.addEventListener('keydown', startSound, { capture: true });

        try {
            this.loadSprites();
            this.loadCloudCat();
            this.loadAdditionalImages();
            this.loadSiyougazou();
        } catch (e) {
            console.warn('load assets error:', e);
        }

        try { this.fetchPublicStats(); } catch (_) {}

        // Load nickname
        try {
            this.nickname = (typeof localStorage !== 'undefined' && localStorage.getItem('kohada_nickname')) || '';
            const nickEl = document.getElementById('nickname');
            if (nickEl) nickEl.value = this.nickname;
        } catch (_) {}

        try {
            this.generateStars();
            this.generateBuildings();
            this.generateClouds();
        } catch (e) {
            console.warn('generate background error:', e);
        }

        // Button events (Safe binding)
        const bindClick = (id, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handler);
        };

        bindClick('btn-start', () => { try { this.startGame(); } catch (err) { console.warn(err); } });
        bindClick('btn-howto', () => { try { this.showScreen('howto-screen'); } catch (err) { console.warn(err); } });
        bindClick('btn-howto-back', () => { try { this.showScreen('title-screen'); } catch (err) { console.warn(err); } });
        bindClick('btn-retry', () => { try { this.retry(); } catch (err) { console.warn(err); } });
        document.addEventListener('click', (e) => {
            try {
                const t = e && e.target;
                if (t && (t.id === 'btn-start' || t.closest('#btn-start'))) {
                    this.startGame();
                    e.preventDefault();
                    e.stopPropagation();
                }
            } catch (err) { console.warn(err); }
        }, true);
        bindClick('btn-share', () => { try { this.share(); } catch (err) { console.warn(err); } });
        bindClick('btn-show-ranking', () => { try { this.showRanking('title'); } catch (err) { console.warn(err); } });
        bindClick('btn-result-ranking', () => { try { this.showRanking('result'); } catch (err) { console.warn(err); } });
        bindClick('btn-ranking-back', () => { try { this.hideRanking(); } catch (err) { console.warn(err); } });
        bindClick('btn-support-ad', () => { try { this.startSupportFlow(); } catch (err) { console.warn(err); } });

        // Touch/Click events（touch-area が無くてもスタート等はボタン・キーで可能）
        const ta = document.getElementById('touch-area');
        const gameContainer = document.getElementById('game-container');
        if (ta) {
            ta.addEventListener('mousedown', (e) => { try { this.handleInput(e); } catch (err) { console.warn(err); } });
            ta.addEventListener('touchstart', (e) => { try { e.preventDefault(); this.handleInput(e); } catch (err) { console.warn(err); } }, { passive: false });
            ta.addEventListener('mouseup', (e) => { try { this.handleRelease(e); } catch (err) { console.warn(err); } });
            ta.addEventListener('touchend', (e) => { try { e.preventDefault(); this.handleRelease(e); } catch (err) { console.warn(err); } }, { passive: false });
            // チャージ中に指が少し動いてもスクロールに取られず長押しを維持する
            ta.addEventListener('touchmove', (e) => {
                if (this.state === 'phase1' || this.state === 'phase2' || this.state === 'phase3') e.preventDefault();
            }, { passive: false });
            ta.addEventListener('touchcancel', () => {
                try {
                    if (this.state === 'phase1' && this.holdingDown) {
                        this.holdingDown = false;
                        this.stopGauge('phase1');
                    }
                } catch (err) { console.warn(err); }
            });
        }
        // スマホ長押しでブラウザのコンテキストメニュー（コピー等）を出さない
        if (gameContainer) {
            gameContainer.addEventListener('contextmenu', (e) => e.preventDefault());
        }

        // Keyboard support (Space / Enter)
        document.addEventListener('keydown', (e) => {
            try {
                if (document.activeElement && document.activeElement.id === 'nickname') return;
                if (e.code === 'Space' || e.code === 'Enter') {
                    e.preventDefault();
                    this.handleInput(e);
                }
            } catch (err) { console.warn(err); }
        });
        document.addEventListener('keyup', (e) => {
            try {
                if (document.activeElement && document.activeElement.id === 'nickname') return;
                if (e.code === 'Space' || e.code === 'Enter') {
                    e.preventDefault();
                    this.handleRelease(e);
                }
            } catch (err) { console.warn(err); }
        });

        try { this.updateTitlePlayCount(); } catch (_) {}
        try { this.sendAnalyticsEvent('page_view', { page: 'game' }); } catch (_) {}

        try {
            this.render();
        } catch (e) {
            console.warn('init render error:', e);
            try { this.animId = requestAnimationFrame((t) => this.render(t)); } catch (_) {}
        }
    },

    // ─── Sprite Loading & Green Screen Removal ───
    loadSprites() {
        this.spriteSheet = new Image();
        // this.spriteSheet.crossOrigin = 'anonymous'; // Removed for local file compatibility
        this.spriteSheet.onload = () => {
            try {
                this.processSprites();
                this.spriteLoaded = true;
                // Update title with kohada image（siyougazou/taitoru があれば優先、なければ 着地/飛び乗り4 等）
                this.updateTitleScreenImage();
            } catch (e) {
                console.error('Sprite processing failed:', e);
                this.spriteLoaded = false;
            }
        };
        this.spriteSheet.onerror = () => {
            console.warn('Sprite sheet failed to load. Using emojis.');
            this.spriteLoaded = false;
        };
        this.spriteSheet.src = 'assets/kohada-sprites.jpg';
    },

    processSprites() {
        if (!this.spriteSheet) return;
        const img = this.spriteSheet;
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        if (!nw || !nh) return;
        const scaleX = nw / 820;
        const scaleY = nh / 1024;

        for (const [name, region] of Object.entries(this.spriteRegions)) {
            const c = document.createElement('canvas');
            const sx = Math.round(region.sx * scaleX);
            const sy = Math.round(region.sy * scaleY);
            const sw = Math.round(region.sw * scaleX);
            const sh = Math.round(region.sh * scaleY);
            c.width = sw;
            c.height = sh;
            const cctx = c.getContext('2d');
            if (!cctx) continue;
            cctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

            // 全画像で共通のクロマキー処理
            this.removeBackgroundSafe(cctx, sw, sh);
            this.spriteCanvases[name] = c;
        }
        // メインスプライトからフォールバックを設定（追加画像が無くても動く・404を減らす）
        if (this.spriteCanvases['fly']) {
            this.spriteCanvases['飛行中'] = this.spriteCanvases['fly'];
            if (!this.spriteCanvases['トップスピード']) this.spriteCanvases['トップスピード'] = this.spriteCanvases['fly'];
        }
        if (this.spriteCanvases['charge'] && !this.spriteCanvases['飛び乗り4']) this.spriteCanvases['飛び乗り4'] = this.spriteCanvases['charge'];
        if (this.spriteCanvases['success'] && !this.spriteCanvases['着地']) this.spriteCanvases['着地'] = this.spriteCanvases['success'];
    },

    // 雲に乗る猫（Gemini画像）は読み込まない＝404を出さない。siyougazou・メインスプライトで表示
    loadCloudCat() {
        this.cloudCatImage = null;
    },

    // 画像を分割して複数のモーションに割り当て
    processAndSplitImage(img, filename) {
        if (!img) return;
        const imgWidth = img.naturalWidth || 0;
        const imgHeight = img.naturalHeight || 0;
        if (!imgWidth || !imgHeight) return;

        // 発射後の画像（sb8xilsb8xilsb8x）は横に4フレーム並んでいる
        if (filename.includes('sb8xilsb8xilsb8x')) {
            const framesPerRow = 4; // 横に4フレーム
            const framesPerCol = 1; // 縦に1フレーム
            const frameWidth = imgWidth / framesPerRow;
            const frameHeight = imgHeight / framesPerCol;

            // フレーム配列を初期化
            this.flyFrames = [];

            // 各フレームを処理
            for (let col = 0; col < framesPerRow; col++) {
                const sx = col * frameWidth;
                const sy = 0;
                const sw = frameWidth;
                const sh = frameHeight;

                const c = document.createElement('canvas');
                c.width = sw;
                c.height = sh;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

                // 改善された背景抜き処理（猫が消えないように慎重に）
                this.removeBackgroundSafe(ctx, c.width, c.height);

                // フレーム配列に追加
                this.flyFrames.push(c);
                console.log(`Processed ${filename} frame ${col + 1}/${framesPerRow} for 飛行中 animation`);
            }

            // 最初のフレームを飛行中スプライトとして設定（アニメーション用）
            if (this.flyFrames.length > 0) {
                this.spriteCanvases['飛行中'] = this.flyFrames[0];
            }
        } else {
            // その他の画像は1フレームとして処理
            const framesPerRow = 1;
            const framesPerCol = 1;
            const frameWidth = imgWidth / framesPerRow;
            const frameHeight = imgHeight / framesPerCol;

            for (let row = 0; row < framesPerCol; row++) {
                for (let col = 0; col < framesPerRow; col++) {
                    const sx = col * frameWidth;
                    const sy = row * frameHeight;
                    const sw = frameWidth;
                    const sh = frameHeight;

                    const c = document.createElement('canvas');
                    c.width = sw;
                    c.height = sh;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

                    this.removeBackgroundSafe(ctx, c.width, c.height);
                }
            }
        }
    },

    // クロマキー処理（背景抜き）- 弱め：キャラの輪郭・毛を残し、はっきりした背景だけ透明に
    removeBackgroundSafe(ctx, width, height) {
        try {
            const imageData = ctx.getImageData(0, 0, width, height);
            const data = imageData.data;
            
            const isEdge = (x, y) => x === 0 || y === 0 || x === width - 1 || y === height - 1;
            const getNeighborBrightness = (x, y) => {
                let sum = 0, count = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx, ny = y + dy;
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height && !(dx === 0 && dy === 0)) {
                            const ni = (ny * width + nx) * 4;
                            sum += (data[ni] + data[ni + 1] + data[ni + 2]) / 3;
                            count++;
                        }
                    }
                }
                return count > 0 ? sum / count : 0;
            };
            
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = (y * width + x) * 4;
                    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
                    if (a === 0) continue;
                    
                    const brightness = (r + g + b) / 3;
                    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
                    const diffRG = Math.abs(r - g), diffGB = Math.abs(g - b), diffRB = Math.abs(r - b);
                    
                    // 先に緑・白を判定（緑は彩度が高いので「キャラ」と誤判定されないよう先に抜く）
                    const isBrightGreen = g >= 140 && g >= r && g >= b && (g - r) + (g - b) > 50;
                    const isGreen = g >= 120 && g > r * 1.2 && g > b * 1.2;
                    const isCyanGreen = g >= 130 && b >= 130 && g >= r && b >= r && (g + b) > r * 2.2;
                    const isPureWhite = brightness > 248 && saturation < 10;
                    const neighborBrightness = getNeighborBrightness(x, y);
                    const isLightBackground = isEdge(x, y) && brightness > 238 && neighborBrightness > 220;
                    
                    if (isBrightGreen || isGreen || isCyanGreen) {
                        data[i + 3] = 0;
                    } else if (isPureWhite) {
                        data[i + 3] = 0;
                    } else if (isLightBackground) {
                        data[i + 3] = Math.round(a * 0.35);
                    }
                    // それ以外（キャラ部分）はそのまま残す
                }
            }
            
            ctx.putImageData(imageData, 0, 0);
        } catch (e) {
            console.warn('Background removal failed:', e);
        }
    },

    // ─── siyougazou フォルダから画像を読み込み（クロマキー処理） ───
    // ファイルが無い場合は 404 になるので、置いている画像だけ読み込む想定（パスは1つずつに絞ってエラーを減らす）
    loadSiyougazou() {
        // 速度2000超用：siyougaziou と siyougazou の両方を試す（フォルダ名の表記ゆれ対応）
        const img2001 = new Image();
        const folders2001 = ['siyougaziou', 'siyougazou'];
        let idx2001 = 0;
        img2001.onload = () => {
            try {
                this.processAndSplitImageForSprite(img2001, 'トップスピード_2001以上', 1, 1);
                if (this.spriteCanvases['トップスピード_2001以上']) {
                    this.spriteCanvases['トップスピード'] = this.spriteCanvases['トップスピード_2001以上'];
                }
            } catch (e) { /* 無視 */ }
        };
        img2001.onerror = () => {
            idx2001++;
            if (idx2001 < folders2001.length) img2001.src = folders2001[idx2001] + '/2001ijou.png';
        };
        img2001.src = folders2001[0] + '/2001ijou.png';

        // siyougaziou / siyougazou の両方のフォルダ名に対応
        const siyouFolders = ['siyougaziou', 'siyougazou'];
        const list = [
            { file: '発射前.png', sprite: '飛び乗り4' },
            { file: '2000以下.png', sprite: '飛行中_2000以下' },
            { file: 'chakuti.png', sprite: '着地' },
            { file: 'taitoru.png', sprite: 'タイトル' }
        ];
        list.forEach(({ file: fileName, sprite }) => {
            let folderIdx = 0;
            const img = new Image();
            img.onload = () => {
                try {
                    this.processAndSplitImageForSprite(img, sprite, 1, 1);
                    if (sprite === 'タイトル') this.updateTitleScreenImage();
                } catch (e) { /* 無視 */ }
            };
            img.onerror = () => {
                folderIdx++;
                if (folderIdx < siyouFolders.length) img.src = siyouFolders[folderIdx] + '/' + fileName;
            };
            img.src = siyouFolders[0] + '/' + fileName;
        });
    },

    // タイトル画面の猫画像を spriteCanvases から更新（siyougazou/taitoru 読み込み後など）
    updateTitleScreenImage() {
        const titleImg = document.getElementById('title-cat-img');
        const emoji = document.getElementById('title-cat-emoji');
        if (!titleImg) return;
        const canvas = this.spriteCanvases['タイトル'] || this.spriteCanvases['着地'] || this.spriteCanvases['飛び乗り4'] || this.spriteCanvases['飛び乗り1'];
        if (canvas) {
            try {
                titleImg.src = canvas.toDataURL();
                titleImg.style.display = 'block';
                if (emoji) emoji.style.display = 'none';
            } catch (_) {}
            return;
        }
        if (typeof this.spriteCanvases === 'object') {
            for (const name of Object.keys(this.spriteCanvases)) {
                const c = this.spriteCanvases[name];
                if (c) {
                    try {
                        titleImg.src = c.toDataURL();
                        titleImg.style.display = 'block';
                        if (emoji) emoji.style.display = 'none';
                    } catch (_) {}
                    return;
                }
            }
        }
        // キャンバスに無い場合は siyougaziou / siyougazou の taitoru.png を試す
        let taitoruIdx = 0;
        const taitoruFolders = ['siyougaziou', 'siyougazou'];
        titleImg.onload = () => { titleImg.style.display = 'block'; if (emoji) emoji.style.display = 'none'; };
        titleImg.onerror = () => {
            taitoruIdx++;
            if (taitoruIdx < taitoruFolders.length) titleImg.src = taitoruFolders[taitoruIdx] + '/taitoru.png';
            else { titleImg.style.display = 'none'; if (emoji) emoji.style.display = 'block'; }
        };
        titleImg.src = taitoruFolders[0] + '/taitoru.png';
    },

    // 追加画像は読み込まない（404を減らす）。メインスプライト＋siyougazou のみ使用
    loadAdditionalImages() {
        this.additionalImages = [];
        this.additionalImagesLoaded = 0;
    },

    processAdditionalImage(img, spriteName) {
        // 画像を分割して処理
        this.processAndSplitImageForSprite(img, spriteName);
    },

    // 追加画像を分割して特定のスプライトに割り当て
    processAndSplitImageForSprite(img, spriteName, framesPerRow = 1, framesPerCol = 1) {
        if (!img) return;
        const imgWidth = img.naturalWidth || 0;
        const imgHeight = img.naturalHeight || 0;
        if (!imgWidth || !imgHeight) return;

        const frameWidth = imgWidth / framesPerRow;
        const frameHeight = imgHeight / framesPerCol;

        // 複数フレームがある場合は配列に保存（flyモーション用）
        const frames = [];

        for (let row = 0; row < framesPerCol; row++) {
            for (let col = 0; col < framesPerRow; col++) {
                const sx = col * frameWidth;
                const sy = row * frameHeight;
                const sw = frameWidth;
                const sh = frameHeight;

                const c = document.createElement('canvas');
                c.width = sw;
                c.height = sh;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

                // クロマキー処理（背景抜き）
                this.removeBackgroundSafe(ctx, c.width, c.height);

                // フレーム配列に追加
                frames.push(c);
                console.log(`Processed additional image frame [${row},${col}] for ${spriteName}`);
            }
        }

        // スプライトに割り当て
        if (frames.length === 1) {
            this.spriteCanvases[spriteName] = frames[0];
            // トップスピードを設定する場合、siyougazou/2001以上 が既に読み込まれていればそれを優先
            if (spriteName === 'トップスピード' && this.spriteCanvases['トップスピード_2001以上']) {
                this.spriteCanvases['トップスピード'] = this.spriteCanvases['トップスピード_2001以上'];
            }
            if (spriteName === 'トップスピード' && !this.spriteCanvases['飛行中']) {
                this.spriteCanvases['飛行中'] = frames[0];
            }
        } else if (frames.length > 1 && (spriteName === '飛行中' || spriteName === 'トップスピード')) {
            this.flyFrames = frames;
            this.spriteCanvases[spriteName] = frames[0];
            if (spriteName === 'トップスピード' && this.spriteCanvases['トップスピード_2001以上']) {
                this.spriteCanvases['トップスピード'] = this.spriteCanvases['トップスピード_2001以上'];
            }
            console.log(`Set ${frames.length} frames for ${spriteName} animation`);
        } else {
            this.spriteCanvases[spriteName] = frames[0];
        }
    },

    resize() {
        try {
            if (!this.canvas || !this.ctx) return;
            const dpr = window.devicePixelRatio || 1;
            const cw = this.canvas.clientWidth || 0;
            const ch = this.canvas.clientHeight || 0;
            this.width = cw > 0 ? cw : (window.innerWidth || 800);
            this.height = ch > 0 ? ch : (window.innerHeight - 100) || 500;
            this.canvas.width = Math.floor(this.width * dpr);
            this.canvas.height = Math.floor(this.height * dpr);
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        } catch (e) {
            console.warn('resize error:', e);
        }
    },

    // ─── Background Generation ───
    generateStars() {
        this.stars = [];
        for (let i = 0; i < 200; i++) {
            this.stars.push({
                x: Math.random() * 2000 - 500,
                y: Math.random() * 1000 - 200,
                size: Math.random() * 2 + 0.5,
                alpha: Math.random() * 0.8 + 0.2,
                twinkle: Math.random() * Math.PI * 2
            });
        }
    },

    generateBuildings() {
        this.buildings = [];
        for (let i = 0; i < 60; i++) {
            this.buildings.push({
                x: i * 80 - 200,
                w: 30 + Math.random() * 50,
                h: 60 + Math.random() * 200,
                color: `hsl(${220 + Math.random() * 20}, ${20 + Math.random() * 15}%, ${15 + Math.random() * 15}%)`,
                windows: Math.random() > 0.3
            });
        }
    },

    generateClouds() {
        this.clouds = [];
        for (let i = 0; i < 30; i++) {
            this.clouds.push({
                x: Math.random() * 200000,
                y: Math.random() * 400 + 100,
                w: 80 + Math.random() * 120,
                h: 30 + Math.random() * 40,
                alpha: 0.1 + Math.random() * 0.15
            });
        }
    },

    // フェーズ遷移タイマーを必ず解除（2回目以降で古いタイマーが残らないように）
    clearPhaseTimeout() {
        if (this._phaseTimeoutId != null) {
            clearTimeout(this._phaseTimeoutId);
            this._phaseTimeoutId = null;
        }
    },

    // ─── Game Flow ───
    startGame() {
        this.clearPhaseTimeout();
        try {
            const titleScreen = document.getElementById('title-screen');
            const onTitleScreen = titleScreen && titleScreen.classList.contains('active');
            if (!onTitleScreen && this.state !== 'title') return;
            if (onTitleScreen) this.state = 'title';
            const nickEl = document.getElementById('nickname');
            this.nickname = (nickEl && nickEl.value && nickEl.value.trim()) ? nickEl.value.trim() : '名無しの猫';
            try { localStorage.setItem('kohada_nickname', this.nickname); } catch (_) {}

            this.resetPhysics();
            this.triggeredMilestones.clear();
            this.currentMilestone = null;
            this.milestoneTimer = 0;
            this.cutInTimer = 0;
            this.nextMilestone = 10000;
            this.boostUsed = false;
            this.boostTapIgnoreUntil = 0;
            this.windowBroken = false;
            this.particles = [];

            try {
                const n = parseInt(localStorage.getItem('kohada_play_count') || '0', 10);
                localStorage.setItem('kohada_play_count', String(n + 1));
            } catch (_) {}

            this._supportDoneThisResult = false;
            this._scoreSubmitted = false;
            this.sendAnalyticsEvent('game_start');
            this.showScreen('none');
            this.state = 'phase1';
            this.inputLock = false;
            this.startPhase1();
            try { if (typeof Sound !== 'undefined' && Sound.resume) Sound.resume(); } catch (_) {}
        } catch (e) {
            console.warn('startGame error:', e);
        }
    },

    // タイトル「何人がプレイしました」表示を更新（localStorage または window.KOHADA_PLAY_COUNT_API で取得）
    updateTitlePlayCount() {
        try {
            const el = document.getElementById('title-play-count-value');
            if (!el) return;
            const base = (this.BAKENEKO_API_BASE || '').trim();
            const gameId = this.KOHADA_GAME_ID || 'kohada';
            const showLocal = () => {
                const n = parseInt(localStorage.getItem('kohada_play_count') || '0', 10);
                el.textContent = n > 0 ? n.toLocaleString() + '人' : '—';
            };
            if (base) {
                this._fetchWithTimeout(base + '/api/public-stats?gameId=' + encodeURIComponent(gameId), {}, 6000)
                    .then(r => r.json())
                    .then(data => {
                        const n = data.totalPlays != null ? Number(data.totalPlays) : 0;
                        if (n > 0) {
                            el.textContent = n.toLocaleString() + '人';
                        } else {
                            showLocal();
                        }
                    })
                    .catch(showLocal);
                return;
            }
            showLocal();
        } catch (_) {}
    },

    safeGet(key) {
        try {
            const v = localStorage.getItem(key);
            return v === null ? null : v;
        } catch (_) { return null; }
    },
    safeSet(key, value) {
        try {
            if (value === null || value === undefined) localStorage.removeItem(key);
            else localStorage.setItem(key, String(value));
            return true;
        } catch (e) {
            if (e && e.name === 'QuotaExceededError' && key === 'pending_support_queue') {
                try {
                    const raw = localStorage.getItem(key);
                    let arr = [];
                    if (raw) try { arr = JSON.parse(raw); } catch (_) {}
                    arr = Array.isArray(arr) ? arr.slice(-3) : [];
                    localStorage.setItem(key, JSON.stringify(arr));
                    return true;
                } catch (_) {}
            }
            return false;
        }
    },
    getCurrentPlayId() {
        try {
            let id = sessionStorage.getItem('kohada_support_play_id');
            if (!id) {
                id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('play-' + Date.now() + '-' + Math.random().toString(36).slice(2));
                sessionStorage.setItem('kohada_support_play_id', id);
            }
            return id;
        } catch (_) { return 'play-' + Date.now(); }
    },
    hasSupportedForCurrentPlay() {
        try {
            const done = sessionStorage.getItem('kohada_support_done_play_id');
            const current = sessionStorage.getItem('kohada_support_play_id');
            return !!(current && done && done === current);
        } catch (_) { return false; }
    },
    setSupportedForCurrentPlay() {
        try {
            sessionStorage.setItem('kohada_support_done_play_id', this.getCurrentPlayId());
        } catch (_) {}
    },
    generateLockOwnerId() {
        return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('owner-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    },
    tryAcquireSupportLock() {
        const tsKey = 'support_lock_timestamp';
        const ownerKey = 'support_lock_owner';
        const now = Date.now();
        const rawTs = this.safeGet(tsKey);
        const rawOwner = this.safeGet(ownerKey);
        const prevTs = rawTs ? parseInt(rawTs, 10) : 0;
        const owner = this.generateLockOwnerId();
        if (prevTs && (now - prevTs) < this.SUPPORT_LOCK_TTL_MS && rawOwner && rawOwner !== owner) return false;
        this.safeSet(tsKey, String(now));
        this.safeSet(ownerKey, owner);
        this._supportLockOwner = owner;
        return true;
    },
    releaseSupportLock() {
        this.safeSet('support_lock_timestamp', null);
        this.safeSet('support_lock_owner', null);
        this._supportLockOwner = null;
    },
    extendSupportLock() {
        if (!this._supportLockOwner) return;
        const tsKey = 'support_lock_timestamp';
        const ownerKey = 'support_lock_owner';
        const now = Date.now();
        this.safeSet(tsKey, String(now));
        this.safeSet(ownerKey, this._supportLockOwner);
    },
    generateIdempotencyKey() {
        return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('idem-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    },

    // ─── 本日の応援回数（public-stats） ───
    fetchPublicStats() {
        const base = (this.BAKENEKO_API_BASE || '').trim();
        const gameId = this.KOHADA_GAME_ID || 'kohada';
        if (!base) {
            this._supportCount = null;
            this._supportCountTotal = null;
            this.updateSupportMeterDisplay(null, null);
            return;
        }
        const now = Date.now();
        if (this._publicStatsCache != null && (now - this._publicStatsCacheTs) < this.PUBLIC_STATS_CACHE_TTL_MS) {
            this._supportCount = this._publicStatsCache.today;
            this._supportCountTotal = this._publicStatsCache.total;
            this.updateSupportMeterDisplay(this._supportCount, this._supportCountTotal);
            return;
        }
        fetch(base + '/api/public-stats?gameId=' + encodeURIComponent(gameId), { method: 'GET', headers: { 'Accept': 'application/json' } })
            .then(r => r.ok ? r.json() : Promise.reject(new Error('public-stats ' + r.status)))
            .then(data => {
                let today = data && typeof data.todaySupportCount !== 'undefined' ? Number(data.todaySupportCount) : NaN;
                let total = data && typeof data.totalSupportCount !== 'undefined' ? Number(data.totalSupportCount) : NaN;
                if (today !== today || today < 0) today = (data && typeof data.totalRewards !== 'undefined') ? Number(data.totalRewards) : 0;
                if (total !== total || total < 0) total = today;
                this._supportCount = Math.max(0, Math.round(today));
                this._supportCountTotal = Math.max(0, Math.round(total));
                this.safeSet('fallback_today_support', String(this._supportCount));
                this._publicStatsCache = { today: this._supportCount, total: this._supportCountTotal };
                this._publicStatsCacheTs = Date.now();
                this.updateSupportMeterDisplay(this._supportCount, this._supportCountTotal);
            })
            .catch(() => {
                let fallback = 0;
                const v = this.safeGet('fallback_today_support');
                if (v !== null && v !== '') { const n = parseInt(v, 10); if (!Number.isNaN(n)) fallback = Math.max(0, n); }
                console.warn('[public-stats] 取得失敗。fallback_today_support を使用:', fallback);
                this._supportCount = fallback;
                this._supportCountTotal = fallback;
                this.updateSupportMeterDisplay(this._supportCount, this._supportCountTotal);
            });
    },

    updateSupportMeterDisplay(todayCount, totalCount, options) {
        const opts = options || {};
        const animateFrom = opts.animateFrom;
        const text = (todayCount === null || todayCount === undefined) ? '—' : String(todayCount);
        try {
            const titleWrap = document.getElementById('title-support-count-wrap');
            const resultWrap = document.getElementById('result-support-count-wrap');
            const t = document.getElementById('title-support-count-value');
            const r = document.getElementById('result-support-count-value');
            const tSub = document.getElementById('title-support-count-subtitle');
            const rSub = document.getElementById('result-support-count-subtitle');

            const tierRaw = (todayCount != null && todayCount >= 0) ? Math.floor(todayCount / 10) : -1;
            const tier = tierRaw >= 0 ? tierRaw % 11 : -1;
            const milestone = (todayCount != null && todayCount >= 100) ? 'support-milestone' : '';
            [titleWrap, resultWrap].forEach(w => {
                if (!w) return;
                w.classList.remove('support-milestone');
                for (let i = 0; i <= 10; i++) w.classList.remove('support-count-tier-' + i);
                if (tier >= 0) w.classList.add('support-count-tier-' + tier);
                if (milestone) w.classList.add(milestone);
            });

            const subtitleText = (todayCount != null && todayCount >= 0) ? '今日の' + todayCount + '回目の応援です' : '';
            if (tSub) tSub.textContent = subtitleText;
            if (rSub) rSub.textContent = subtitleText;

            if (animateFrom != null && todayCount != null && todayCount >= 0 && (t || r)) {
                const fromVal = Math.max(0, Number(animateFrom));
                const toVal = Math.max(0, Math.round(todayCount));
                const duration = 400;
                const start = performance.now();
                const tick = (now) => {
                    const elapsed = now - start;
                    const ratio = Math.min(1, elapsed / duration);
                    const eased = ratio < 0.5 ? 2 * ratio * ratio : 1 - Math.pow(-2 * ratio + 2, 2) / 2;
                    const current = Math.round(fromVal + (toVal - fromVal) * eased);
                    if (t) t.textContent = String(current);
                    if (r) r.textContent = String(current);
                    if (ratio < 1) requestAnimationFrame(tick);
                    else {
                        if (t) t.textContent = String(toVal);
                        if (r) r.textContent = String(toVal);
                        [t, r].forEach(el => {
                            if (el) {
                                el.classList.add('support-count-updated');
                                setTimeout(() => el.classList.remove('support-count-updated'), 500);
                            }
                        });
                    }
                };
                requestAnimationFrame(tick);
            } else {
                if (t) t.textContent = text;
                if (r) r.textContent = text;
            }

            const barWrap = document.getElementById('result-support-bar-wrap');
            const barFill = document.getElementById('result-support-bar-fill');
            if (barWrap) barWrap.style.display = (todayCount != null && todayCount >= 0) ? 'block' : 'none';
            if (barFill) {
                const barMax = 100;
                const pct = (todayCount != null && todayCount >= 0) ? Math.min(100, (todayCount / barMax) * 100) : 0;
                barFill.style.width = pct + '%';
            }
        } catch (_) {}
    },

    getPendingSupportQueue() {
        try {
            const raw = this.safeGet('pending_support_queue');
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            this.safeSet('pending_support_queue', null);
            return [];
        }
    },

    setPendingSupportQueue(queue) {
        const arr = Array.isArray(queue) ? queue : [];
        const payload = arr.length ? JSON.stringify(arr) : null;
        return this.safeSet('pending_support_queue', payload);
    },
    getBackoffState() {
        try {
            const ms = sessionStorage.getItem('kohada_backoff_ms');
            const until = sessionStorage.getItem('kohada_backoff_until');
            const untilTs = until ? parseInt(until, 10) : 0;
            if (untilTs && Date.now() < untilTs) return { backoffMs: Math.min(30000, parseInt(ms, 10) || 1000), untilTs };
            return null;
        } catch (_) { return null; }
    },
    setBackoffState(backoffMs, untilTs) {
        try {
            sessionStorage.setItem('kohada_backoff_ms', String(backoffMs));
            sessionStorage.setItem('kohada_backoff_until', String(untilTs));
        } catch (_) {}
    },
    clearBackoffState() {
        try {
            sessionStorage.removeItem('kohada_backoff_ms');
            sessionStorage.removeItem('kohada_backoff_until');
        } catch (_) {}
    },
    sendSupportTelemetry(eventName, props) {
        const base = (this.BAKENEKO_API_BASE || '').trim();
        const gameId = this.KOHADA_GAME_ID || 'kohada';
        if (!base || !gameId) return;
        try {
            fetch(base + '/api/analytics/event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ game_id: gameId, event_name: eventName, props: props || {} })
            }).catch(() => {});
        } catch (_) {}
    },

    sendAnalyticsEvent(eventName, props) {
        const base = (this.BAKENEKO_API_BASE || '').trim();
        const gameId = this.KOHADA_GAME_ID || 'kohada';
        if (!base || !gameId) return;
        try {
            var sid = this._sessionId;
            if (!sid) {
                try { sid = sessionStorage.getItem('kohada_session_id'); } catch (_) {}
                if (!sid) {
                    sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                    try { sessionStorage.setItem('kohada_session_id', sid); } catch (_) {}
                }
                this._sessionId = sid;
            }
            fetch(base + '/api/analytics/event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ game_id: gameId, session_id: sid, event_name: eventName, props: props || {} })
            }).catch(() => {});
        } catch (_) {}
    },

    flushPendingSupportQueue() {
        const base = (this.BAKENEKO_API_BASE || '').trim();
        const gameId = this.KOHADA_GAME_ID || 'kohada';
        if (!base) return Promise.resolve();
        const queue = this.getPendingSupportQueue();
        if (!queue.length) {
            this._flushingQueue = false;
            this.clearBackoffState();
            this.releaseSupportLock();
            return Promise.resolve();
        }
        const self = this;
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const waitBackoff = () => {
            const state = self.getBackoffState();
            if (!state) return Promise.resolve();
            const wait = Math.max(0, state.untilTs - Date.now());
            return wait > 0 ? delay(wait) : Promise.resolve();
        };
        return waitBackoff().then(() => {
            const batch = queue.slice(0, this.FLUSH_BATCH_SIZE);
            const remaining = queue.slice(this.FLUSH_BATCH_SIZE);
            let backoff = self._flushBackoffMs;
            const sendOne = (item) => {
                const idempotencyKey = item.idempotencyKey || self.generateIdempotencyKey();
                return fetch(base + '/api/support/increment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ gameId: item.gameId || gameId, idempotency_key: idempotencyKey })
                }).then(r => r.ok ? r.json() : Promise.reject(new Error('increment ' + r.status)));
            };
            const processBatch = (index) => {
                if (index >= batch.length) {
                    self.setPendingSupportQueue(remaining);
                    self._flushBackoffMs = 1000;
                    self.clearBackoffState();
                    self._flushingQueue = false;
                    self.releaseSupportLock();
                    self.sendSupportTelemetry('support_flush_result', { result: 'success' });
                    if (remaining.length) return self.flushPendingSupportQueue();
                    return Promise.resolve();
                }
                self.extendSupportLock();
                const item = batch[index];
                return sendOne(item)
                    .then(res => {
                        if (res && res.idempotency_replay) self.sendSupportTelemetry('idempotency_replay', { replayed: true });
                        if (res && typeof res.todaySupportCount !== 'undefined') {
                            self._supportCount = Math.max(0, Number(res.todaySupportCount));
                            self._supportCountTotal = Math.max(0, Number(res.totalSupportCount || self._supportCountTotal || 0));
                        } else {
                            self._supportCount = (self._supportCount != null ? self._supportCount : 0) + 1;
                            self._supportCountTotal = (self._supportCountTotal != null ? self._supportCountTotal : 0) + 1;
                        }
                        self.safeSet('fallback_today_support', String(self._supportCount));
                        self.updateSupportMeterDisplay(self._supportCount, self._supportCountTotal);
                        return delay(self.FLUSH_INTERVAL_MS).then(() => processBatch(index + 1));
                    })
                    .catch(() => {
                        remaining.unshift(item);
                        self.setPendingSupportQueue(remaining);
                        const nextBackoff = Math.min(30000, backoff * 2);
                        backoff = nextBackoff;
                        self._flushBackoffMs = nextBackoff;
                        self.setBackoffState(nextBackoff, Date.now() + nextBackoff);
                        self._flushingQueue = false;
                        self.releaseSupportLock();
                        self.sendSupportTelemetry('support_flush_result', { result: 'fail' });
                        return delay(nextBackoff).then(() => { self._flushingQueue = true; return self.flushPendingSupportQueue(); });
                    });
            };
            this._flushingQueue = true;
            return processBatch(0);
        });
    },

    startSupportFlow() {
        const btn = document.getElementById('btn-support-ad');
        const errEl = document.getElementById('support-error-message');
        const loadingEl = document.getElementById('support-loading-text');
        const overlay = document.getElementById('support-success-overlay');
        const queuedEl = document.getElementById('support-queued-message');

        if (this.isRewardProcessing || this._flushingQueue) return;
        if (this.hasSupportedForCurrentPlay()) {
            if (btn) btn.disabled = true;
            return;
        }
        if (!this.tryAcquireSupportLock()) return;

        try { this.sendSupportTelemetry('support_cta_click', {}); } catch (_) {}
        this.isRewardProcessing = true;
        if (btn) btn.disabled = true;
        if (errEl) errEl.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        if (queuedEl) queuedEl.style.display = 'none';
        if (loadingEl) loadingEl.style.display = 'block';

        const base = (this.BAKENEKO_API_BASE || '').trim();
        const gameId = this.KOHADA_GAME_ID || 'kohada';
        const self = this;
        const finish = (success, queuedOnly) => {
            self.isRewardProcessing = false;
            self.releaseSupportLock();
            if (loadingEl) loadingEl.style.display = 'none';
            if (!success) {
                if (btn) btn.disabled = false;
                if (errEl) errEl.style.display = queuedOnly ? 'none' : 'block';
            }
        };

        const runIncrement = (prevToday) => {
            const idempotencyKey = self.generateIdempotencyKey();
            return fetch(base + '/api/support/increment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ gameId, idempotency_key: idempotencyKey })
            })
                .then(r => r.ok ? r.json() : Promise.reject(new Error('increment ' + r.status)))
                .then(res => {
                    if (res && res.idempotency_replay) self.sendSupportTelemetry('idempotency_replay', { replayed: true });
                    if (res && typeof res.todaySupportCount !== 'undefined') {
                        self._supportCount = Math.max(0, Number(res.todaySupportCount));
                        self._supportCountTotal = Math.max(0, Number(res.totalSupportCount || self._supportCountTotal || 0));
                    } else {
                        self._supportCount = (self._supportCount != null ? self._supportCount : 0) + 1;
                        self._supportCountTotal = (self._supportCountTotal != null ? self._supportCountTotal : 0) + 1;
                    }
                    self._supportDoneThisResult = true;
                    self.setSupportedForCurrentPlay();
                    self.safeSet('fallback_today_support', String(self._supportCount));
                    self.updateSupportMeterDisplay(self._supportCount, self._supportCountTotal, { animateFrom: prevToday });
                    try { self.sendSupportTelemetry('support_increment_success', {}); } catch (_) {}
                    self.showSupportSuccess();
                    if (loadingEl) loadingEl.style.display = 'none';
                    return self.flushPendingSupportQueue();
                })
                .catch(() => {
                    let q = self.getPendingSupportQueue();
                    const newItem = { gameId, idempotencyKey: self.generateIdempotencyKey() };
                    q.push(newItem);
                    if (q.length > self.MAX_QUEUE_LENGTH) {
                        q = q.slice(-self.MAX_QUEUE_LENGTH);
                        console.warn('[support] キュー上限超過のため最古を削除');
                    }
                    const saved = self.setPendingSupportQueue(q);
                    self.sendSupportTelemetry('support_queue_len', { value: q.length });
                    try { self.sendSupportTelemetry('support_increment_queued', {}); } catch (_) {}
                    if (queuedEl) {
                        queuedEl.style.display = 'block';
                        queuedEl.textContent = saved ? '一時保存しました。接続回復後に反映されます。' : '通信不安定のため反映に失敗しました（再試行）';
                    }
                    finish(false, true);
                });
        };

        if (!base) {
            try { self.sendSupportTelemetry('support_increment_fail', {}); } catch (_) {}
            finish(false);
            return;
        }

        const runRewarded = (typeof window.BakenekoAds !== 'undefined' && window.BakenekoAds.runRewarded)
            ? window.BakenekoAds.runRewarded()
            : Promise.resolve(false);

        runRewarded
            .then(granted => {
                if (!granted) {
                    try { self.sendSupportTelemetry('support_increment_fail', {}); } catch (_) {}
                    finish(false);
                    return;
                }
                fetch(base + '/api/analytics/event', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ game_id: gameId, event_name: 'reward_granted' })
                }).catch(() => {});
                const prevToday = self._supportCount != null ? self._supportCount : 0;
                return runIncrement(prevToday);
            })
            .catch(() => {
                try { self.sendSupportTelemetry('support_increment_fail', {}); } catch (_) {}
                finish(false);
            });
    },

    showSupportSuccess() {
        const overlay = document.getElementById('support-success-overlay');
        const heartsEl = document.getElementById('support-success-hearts');
        const container = document.getElementById('result-cat-container');
        if (!overlay || !heartsEl) return;
        heartsEl.innerHTML = '';
        const count = 12;
        for (let i = 0; i < count; i++) {
            const span = document.createElement('span');
            span.className = 'heart-particle';
            span.textContent = '❤';
            const cx = 50 + (Math.random() - 0.5) * 40;
            const cy = 50 + (Math.random() - 0.5) * 40;
            span.style.left = cx + '%';
            span.style.top = cy + '%';
            span.style.animationDelay = (i * 0.08) + 's';
            heartsEl.appendChild(span);
        }
        overlay.style.display = 'flex';
        const t = setTimeout(() => {
            overlay.style.display = 'none';
            if (heartsEl) heartsEl.innerHTML = '';
        }, 3000);
        if (overlay._supportTimeout) clearTimeout(overlay._supportTimeout);
        overlay._supportTimeout = t;
    },

    resetPhysics() {
        this.x = 0; this.y = 50;
        this.vx = 0; this.vy = 0;
        this.distance = 0; this.altitude = 50;
        this.maxAlt = 50; this.speed = 0;
        this.landed = false;
        this.camX = 0; this.camY = 0;
        this.flyFrameTimer = 0;
        this.flyFrameIndex = 0;
        this.physicsAccumulator = 0;
    },

    // ─── Phase 1: Power Charge (high-speed oscillation!) ───
    startPhase1() {
        this.clearPhaseTimeout();
        try {
            this.phaseActive = true;
            this.gaugeValue = 0;
            this.gaugeDir = 1;
            this.gaugeSpeed = 10.0;
            this.holdingDown = false;

            if (this.els?.uiBottom) this.els.uiBottom.classList.remove('hidden');
            if (this.els?.phaseUI) this.els.phaseUI.classList.remove('hidden');
            if (this.els?.values?.phaseTitle) this.els.values.phaseTitle.textContent = '① パワーチャージ';
            if (this.els?.values?.phaseInstruction) {
                this.els.values.phaseInstruction.textContent = 'PC: スペースキー長押し→離す / スマホ: 長押し→指を離す';
            }
            if (this.els?.gauges?.sweet) {
                this.els.gauges.sweet.style.display = 'block';
                this.els.gauges.sweet.style.left = '90%';
                this.els.gauges.sweet.style.width = '10%';
            }
        } catch (e) {
            console.warn('startPhase1 error:', e);
            this.phaseActive = true;
            this.gaugeValue = 0;
            this.gaugeDir = 1;
            this.gaugeSpeed = 10.0;
            this.holdingDown = false;
        }
    },

    // ─── Phase 2: Angle ───
    startPhase2() {
        this.clearPhaseTimeout();
        this.phaseActive = true;
        this.gaugeValue = 50;
        this.gaugeDir = 1;
        this.gaugeSpeed = 5.0;
        try {
            const phaseUI = document.getElementById('phase-ui');
            if (phaseUI) phaseUI.classList.remove('hidden');
            const title = document.getElementById('phase-title');
            const inst = document.getElementById('phase-instruction');
            const sweet = document.getElementById('phase-gauge-sweet');
            if (title) try { title.textContent = '② 角度決定'; } catch (_) {}
            if (inst) try { inst.textContent = 'PC: スペースキー or クリック / スマホ: タップ'; } catch (_) {}
            if (sweet) {
                try {
                    sweet.style.display = 'block';
                    sweet.style.left = '30%';
                    sweet.style.width = '25%';
                } catch (_) {}
            }
        } catch (e) {
            console.warn('startPhase2 error:', e);
            this.phaseActive = true;
            this.gaugeValue = 50;
            this.gaugeDir = 1;
            this.gaugeSpeed = 5.0;
        }
    },

    // ─── Phase 3: Timing ───
    startPhase3() {
        this.clearPhaseTimeout();
        this.phaseActive = true;
        this.gaugeValue = 0;
        this.gaugeDir = 1;
        this.gaugeSpeed = 7.0;
        try {
            const phaseUI = document.getElementById('phase-ui');
            if (phaseUI) phaseUI.classList.remove('hidden');
            const title = document.getElementById('phase-title');
            const inst = document.getElementById('phase-instruction');
            const sweet = document.getElementById('phase-gauge-sweet');
            if (title) try { title.textContent = '③ タイミング'; } catch (_) {}
            if (inst) try { inst.textContent = 'PC: スペースキー or クリック / スマホ: タップで中央を狙う！'; } catch (_) {}
            if (sweet) {
                try {
                    sweet.style.display = 'block';
                    sweet.style.left = '45%';
                    sweet.style.width = '10%';
                } catch (_) {}
            }
        } catch (e) {
            console.warn('startPhase3 error:', e);
            this.phaseActive = true;
            this.gaugeValue = 0;
            this.gaugeDir = 1;
            this.gaugeSpeed = 7.0;
        }
    },

    // ─── Launch ───
    launch() {
        this.clearPhaseTimeout();
        try {
            document.getElementById('phase-ui')?.classList.add('hidden');
            try { if (typeof Sound !== 'undefined') { Sound.playLaunch(); Sound.startBGM('flying'); } } catch (_) {}

            const power = Math.max(0, Math.min(100, Number(this.power) || 50));
            const angle = Math.max(0, Math.min(100, Number(this.angle) || 50));
            const timing = Math.max(0, Math.min(100, Number(this.timing) || 50));
            const powerFactor = Number.isFinite(power) ? power / 100 : 0.5;
            const angleDeg = 10 + (Number.isFinite(angle) ? angle : 50) / 100 * 80;
            const angleRad = angleDeg * Math.PI / 180;
            const timingBonus = 1.0 + (Number.isFinite(timing) ? timing : 50) / 100 * 0.5;

            const initialSpeed = this.MAX_POWER * powerFactor * timingBonus;
            const spd = Number.isFinite(initialSpeed) ? initialSpeed : this.MAX_POWER * 0.5;
            this.vx = spd * Math.cos(angleRad);
            this.vy = spd * Math.sin(angleRad);
            if (!Number.isFinite(this.vx)) this.vx = 0;
            if (!Number.isFinite(this.vy)) this.vy = 0;

            this.state = 'flying';
            this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this.flyFrameTimer = 0;
            this.flyFrameIndex = 0;

            document.getElementById('boost-ui')?.classList.remove('hidden');
        } catch (e) {
            console.warn('launch error:', e);
            this.state = 'flying';
            this.vx = Number.isFinite(this.vx) ? this.vx : this.MAX_POWER * 0.5 * Math.cos(50 * Math.PI / 180);
            this.vy = Number.isFinite(this.vy) ? this.vy : this.MAX_POWER * 0.5 * Math.sin(50 * Math.PI / 180);
            this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
        }
    },

    // ─── Physics ───
    updatePhysics(dt) {
        if (this.cutInTimer > 0) {
            this.cutInTimer -= dt;
            // Physics continues!
        }
        if (this.landed) return;
        // NaN 伝播防止（スマホで落ちる原因の一つ）
        if (!Number.isFinite(this.vx)) this.vx = 0;
        if (!Number.isFinite(this.vy)) this.vy = 0;
        if (!Number.isFinite(this.x)) this.x = 0;
        if (!Number.isFinite(this.y)) this.y = 0;

        this.vy -= this.GRAVITY * dt;

        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (speed > 0) {
            const drag = this.AIR_RESISTANCE * speed * speed;
            const dragX = (drag * this.vx / speed) * dt;
            const dragY = (drag * this.vy / speed) * dt;
            this.vx -= dragX;
            this.vy -= dragY;
        }

        this.x += this.vx * dt;
        this.y += this.vy * dt;

        if (this.y <= 0 && this.vy < 0) {
            this.y = 0;
            this.landed = true;
            this.vx = 0; this.vy = 0;
            this.onLand();
        }

        this.distance = Math.max(0, this.x);
        this.altitude = Math.max(0, this.y);
        this.maxAlt = Math.max(this.maxAlt, this.altitude);
        this.speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);

        this.checkMilestones();

        if (this.distance >= 100 && !this.windowBroken) {
            this.windowBroken = true;
            this.spawnGlassParticles();
        }
    },

    onLand() {
        try {
            this.boostTapIgnoreUntil = 0;
            document.getElementById('boost-ui')?.classList.add('hidden');
            this.state = 'result';
            try { if (typeof Sound !== 'undefined') { Sound.playLand(); Sound.stopBGM(); } } catch (_) {}

            this.shakeTimer = 30;
            this.spawnImpactParticles();

            this.saveScore();
            const self = this;
            setTimeout(() => { try { self.showResult(); } catch (e) { console.warn(e); } }, 800);
        } catch (e) {
            console.warn('onLand error:', e);
            this.state = 'result';
            setTimeout(() => { try { this.showResult(); } catch (e2) { console.warn(e2); } }, 800);
        }
    },

    spawnImpactParticles() {
        for (let i = 0; i < 50; i++) {
            this.particles.push({
                x: this.x + (Math.random() - 0.5) * 100,
                y: 0,
                vx: (Math.random() - 0.5) * 50,
                vy: Math.random() * 50,
                size: 5 + Math.random() * 15,
                life: 60 + Math.random() * 30,
                maxLife: 90,
                color: `rgba(100, 80, 60, ${0.5 + Math.random() * 0.5})`,
                type: 'dust'
            });
        }
    },

    // ─── Boost ───
    boost() {
        try {
            if (this.state !== 'flying' || this.boostUsed || this.landed) return;
            // 発射直後など vx/vy が未設定・NaN のときは計算しない（落ち防止）
            const vx = Number(this.vx);
            const vy = Number(this.vy);
            if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
            this.boostUsed = true;
            // 発射後の連打で落ちないよう、ブースト後は一定時間タップをすべて無視
            this.boostTapIgnoreUntil = (typeof Date.now === 'function' ? Date.now() : 0) + 350;
            document.getElementById('boost-ui')?.classList?.add('hidden');
            try { if (typeof Sound !== 'undefined' && Sound.playBoost) Sound.playBoost(); } catch (_) {}

            const altFactor = Math.max(0, 1 - Math.abs((this.altitude || 0) - 350) / 500);
            const boostPower = this.BOOST_IMPULSE * (0.5 + altFactor * 0.5);
            const angle = Math.atan2(vy, vx);
            this.vx = vx + boostPower * Math.cos(angle + 0.1);
            this.vy = vy + boostPower * Math.sin(angle + 0.1);
            this.spawnBoostParticles();
            this.flashTimer = 20;
        } catch (e) {
            console.warn('boost error:', e);
        }
    },

    // ─── Milestones ───
    checkMilestones() {
        for (const ms of this.milestones) {
            if (this.distance >= ms.dist && !this.triggeredMilestones.has(ms.dist)) {
                this.triggeredMilestones.add(ms.dist);
                this.showMilestone(ms);
            }
        }
    },

    showMilestone(ms) {
        try {
            this.currentMilestone = ms;
            this.milestoneTimer = 120;
            this.cutInTimer = 5.0;
            this.shakeTimer = 15;
            try { if (typeof Sound !== 'undefined' && Sound.playMilestone) Sound.playMilestone(); } catch (_) {}
        } catch (e) {
            console.warn('showMilestone error:', e);
        }
    },

    drawCutIn(ctx, W, H) {
        try {
            if (!ctx || !this.currentMilestone) return;
            const ms = this.currentMilestone;
            const color = ms.color || '#ffd700';
            const icon = ms.icon != null ? ms.icon : '🎉';
            const text = ms.text != null ? ms.text : '';

            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(0, 0, W, H);

            const bandH = 200;
            const bandY = H / 2 - bandH / 2;
            const grad = ctx.createLinearGradient(0, bandY, W, bandY + bandH);
            grad.addColorStop(0, 'rgba(0,0,0,0)');
            grad.addColorStop(0.2, color);
            grad.addColorStop(0.8, color);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, bandY, W, bandH);

            ctx.fillStyle = '#fff';
            ctx.shadowColor = '#000';
            ctx.shadowBlur = 10;
            ctx.textAlign = 'center';
            ctx.font = '80px Arial';
            ctx.fillText(icon, W / 2, bandY + 80, W * 0.9);
            ctx.font = '900 60px "Zen Maru Gothic"';
            ctx.fillText(text, W / 2, bandY + 160, W * 0.9);
            ctx.restore();
        } catch (e) {
            console.warn('drawCutIn error:', e);
        }
    },

    // ─── Particles ───
    spawnGlassParticles() {
        for (let i = 0; i < 30; i++) {
            this.particles.push({
                x: this.x, y: this.y,
                vx: (Math.random() - 0.3) * 15, vy: (Math.random() - 0.5) * 10,
                size: 2 + Math.random() * 6, life: 60 + Math.random() * 60, maxLife: 120,
                color: `hsla(${200 + Math.random() * 40}, 80%, ${70 + Math.random() * 30}%, `,
                type: 'glass'
            });
        }
    },

    spawnBoostParticles() {
        // Massive explosion effect!
        for (let i = 0; i < 60; i++) {
            const spd = 3 + Math.random() * 12;
            const ang = Math.random() * Math.PI * 2;
            this.particles.push({
                x: this.x, y: this.y,
                vx: Math.cos(ang) * spd - this.vx * 0.05,
                vy: Math.sin(ang) * spd - this.vy * 0.05,
                size: 4 + Math.random() * 10, life: 60 + Math.random() * 60, maxLife: 120,
                color: `hsla(${Math.random() * 60}, 100%, ${50 + Math.random() * 40}%, `,
                type: 'fire'
            });
        }
        // Screen shake on boost
        this.shakeTimer = 20;
    },

    updateParticles(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt * 60;
            p.y += p.vy * dt * 60;
            p.vy -= 2 * dt * 60;
            p.life--;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    },

    // ─── Input ───
    handleInput(e) {
        try {
            const now = Date.now();
            // 発射後はブースト1回だけ。連打は最初の1回以外すべて無視（イベントも読まないので落ちない）
            if (this.state === 'flying') {
                if (this.boostUsed) return;
                if (this.boostTapIgnoreUntil && now < this.boostTapIgnoreUntil) return;
            }

            if (!e) return;
            // スマホ: タップ後に発火する合成 click を無視（二重処理で落ちるのを防ぐ）
            let isTouch = false;
            try {
                isTouch = (e.type === 'touchstart') || (e.touches && e.touches.length > 0);
            } catch (_) {}
            if (isTouch) this.lastTouchTime = now;
            if (!isTouch && (e.type === 'click' || e.type === 'mousedown') && (now - this.lastTouchTime < 300)) return;

            if (this.inputLock) return;
            if (this.state === 'flying' && this.boostUsed) return;
            if (this.state !== 'phase1' && now - this.lastInputTime < this.INPUT_THROTTLE_MS) return;
            if (this.state !== 'phase1') this.lastInputTime = now;

            const self = this;
            const setLock = () => {
                self.inputLock = true;
                setTimeout(function () { self.inputLock = false; }, self.INPUT_LOCK_MS);
            };

            switch (this.state) {
                case 'title': setLock(); this.startGame(); break;
                case 'result': setLock(); this.retry(); break;
                case 'phase1': this.holdingDown = true; break;
                case 'phase2': setLock(); this.stopGauge('phase2'); break;
                case 'phase3': setLock(); this.stopGauge('phase3'); break;
                case 'flying': setLock(); if (!this.boostUsed) this.boost(); break;
            }
        } catch (err) {
            console.warn('handleInput error:', err);
            this.inputLock = false;
        }
    },

    handleRelease(e) {
        try {
            if (this.inputLock) return;
            if (this.state !== 'phase1') return;
            if (!this.holdingDown) return;
            this.holdingDown = false;
            this.inputLock = true;
            this.stopGauge('phase1');
        } catch (err) {
            console.warn('handleRelease error:', err);
            this.inputLock = false;
        }
    },

    stopGauge(phase) {
        try {
            if (!phase || !this.phaseActive) return;
            this.phaseActive = false;

            try { if (typeof Sound !== 'undefined' && Sound.playGaugeStop) Sound.playGaugeStop(); } catch (_) {}

            const self = this;
            const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));

            if (phase === 'phase1') {
                this.power = clamp(this.gaugeValue);
                try {
                    const pv = self.els?.values?.phaseValue;
                    if (pv) pv.textContent = `パワー: ${Math.round(this.power)}%`;
                } catch (_) {}
            } else if (phase === 'phase2') {
                this.angle = clamp(this.gaugeValue);
                try {
                    const angleDeg = (10 + (this.angle / 100) * 80).toFixed(1);
                    const pv = self.els?.values?.phaseValue;
                    if (pv) pv.textContent = `角度: ${angleDeg}°`;
                } catch (_) {}
            } else if (phase === 'phase3') {
                const g = clamp(this.gaugeValue);
                this.timing = Math.max(0, 100 - Math.abs(g - 50) * 2);
                try {
                    const pv = self.els?.values?.phaseValue;
                    if (pv) pv.textContent = `精度: ${Math.round(this.timing)}%`;
                } catch (_) {}
            }

            self.clearPhaseTimeout();
            if (phase === 'phase1') {
                self._phaseTimeoutId = setTimeout(() => {
                    self._phaseTimeoutId = null;
                    self.inputLock = false;
                    try { self.state = 'phase2'; self.startPhase2(); } catch (e2) { console.warn(e2); }
                }, 300);
            } else if (phase === 'phase2') {
                self._phaseTimeoutId = setTimeout(() => {
                    self._phaseTimeoutId = null;
                    self.inputLock = false;
                    try { self.state = 'phase3'; self.startPhase3(); } catch (e2) { console.warn(e2); }
                }, 300);
            } else if (phase === 'phase3') {
                self._phaseTimeoutId = setTimeout(() => {
                    self._phaseTimeoutId = null;
                    self.inputLock = false;
                    try { self.launch(); } catch (e2) { console.warn(e2); }
                }, 350);
            }
        } catch (e) {
            console.warn('stopGauge error:', e);
            this.phaseActive = false;
            this.clearPhaseTimeout();
        }
    },

    // ─── Score & Ranking ───
    _fetchWithTimeout(url, opts, timeoutMs) {
        timeoutMs = timeoutMs || 8000;
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var signal = controller ? controller.signal : undefined;
        var tid = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
        var fetchOpts = signal ? Object.assign({}, opts, { signal: signal }) : opts;
        return fetch(url, fetchOpts).finally(function () { if (tid) clearTimeout(tid); });
    },

    _scoreSubmitted: false,

    submitScoreToApi() {
        if (this._scoreSubmitted) return;
        const base = (this.BAKENEKO_API_BASE || '').trim();
        if (!base) return;
        const score = Math.max(0, Math.min(999999999, Math.round(this.distance)));
        const nickname = (this.nickname && this.nickname.trim()) ? this.nickname.trim() : 'anon';
        const self = this;
        var attempt = 0;
        function trySubmit() {
            if (self._scoreSubmitted) return;
            attempt++;
            self._fetchWithTimeout(base + '/api/ranking/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gameId: self.KOHADA_GAME_ID || 'kohada', nickname: nickname, score: score })
            }, 8000).then(function (res) {
                if (!res.ok) throw new Error('submit ' + res.status);
                return res.json();
            }).then(function (data) {
                self._scoreSubmitted = true;
                if (data && data.ok && typeof data.rank === 'number') {
                    self._lastSubmitRank = data.rank;
                    var el = document.getElementById('result-api-rank');
                    if (el) el.textContent = '世界ランキング: ' + data.rank + '\u4f4d';
                }
            }).catch(function (err) {
                console.warn('[ranking] submit attempt ' + attempt + ':', err.message || err);
                if (attempt < 2) setTimeout(trySubmit, 1500);
            });
        }
        trySubmit();
    },

    saveScore() {
        try {
            let scores = [];
            try {
                const raw = typeof localStorage !== 'undefined' && localStorage.getItem('kohada_scores');
                scores = raw ? JSON.parse(raw) : [];
            } catch (_) {}
            if (!Array.isArray(scores)) scores = [];
            scores.push({
                nickname: this.nickname || '名無しの猫',
                distance: Number(this.distance) / 1000 || 0,
                date: new Date().toISOString().slice(2, 10).replace(/-/g, '/')
            });
            scores.sort((a, b) => (b.distance || 0) - (a.distance || 0));
            localStorage.setItem('kohada_scores', JSON.stringify(scores.slice(0, 50)));
            this.submitScoreToApi();
        } catch (e) {
            console.warn('saveScore error:', e);
        }
    },

    getScores() {
        try {
            const raw = typeof localStorage !== 'undefined' && localStorage.getItem('kohada_scores');
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            console.warn('getScores error:', e);
            return [];
        }
    },

    // 着地距離からエリア名を返す（スコア表示用）
    getLandingAreaName() {
        const d = this.distance;
        if (d >= 100000) return '猫又療養所（ゴール）';
        if (d >= 90000) return '富津岬〜大貫海岸間';
        if (d >= 80000) return 'マザー牧場〜富津岬間';
        if (d >= 70000) return '鋸山〜マザー牧場間';
        if (d >= 60000) return '木更津〜鋸山間';
        if (d >= 50000) return '海ほたる〜木更津間';
        if (d >= 40000) return 'お台場〜海ほたる間';
        if (d >= 30000) return '東京タワー〜お台場間';
        if (d >= 20000) return '都心横断〜東京タワー間';
        if (d >= 10000) return '新宿〜都心横断間';
        return 'スタート〜新宿間';
    },

    showResult() {
        try {
            const so = document.getElementById('support-success-overlay');
            const se = document.getElementById('support-error-message');
            if (so) so.style.display = 'none';
            if (se) se.style.display = 'none';

            const distKm = (this.distance / 1000).toFixed(3);
            const isGoal = this.distance >= 100000;
            const landingArea = this.getLandingAreaName();

            const distEl = document.getElementById('result-dist-value');
            const titleEl = document.getElementById('result-title');
            if (distEl) distEl.textContent = distKm;
            if (titleEl) titleEl.textContent = isGoal ? '🎉 猫又療養所 到着!!' : '着地！';

            const resultImg = document.getElementById('result-cat-img');
            const resultEmoji = document.getElementById('result-cat-emoji');
            const resultSpriteName = '着地';
            let resultSprite = this.spriteCanvases && this.spriteCanvases[resultSpriteName];
            if (!resultSprite && typeof this.spriteCanvases === 'object') {
                const fallbackOrder = ['着地', '飛び乗り4', '飛び乗り1', 'トップスピード'];
                for (const name of fallbackOrder) {
                    if (this.spriteCanvases[name]) {
                        resultSprite = this.spriteCanvases[name];
                        break;
                    }
                }
            }
            if (resultImg && resultEmoji) {
                if (resultSprite) {
                    try { resultImg.src = resultSprite.toDataURL(); } catch (_) {}
                    resultImg.style.display = 'block';
                    resultEmoji.style.display = 'none';
                } else {
                    resultEmoji.textContent = isGoal ? '✨👑✨' : (this.distance > 5000 ? '😼' : '😿');
                    resultEmoji.style.display = 'block';
                    resultImg.style.display = 'none';
                }
            }

            const scores = this.getScores();
            const rank = scores.findIndex(s => s.distance <= this.distance / 1000) + 1 || scores.length + 1;

            const detailEl = document.getElementById('result-detail');
            if (detailEl) detailEl.innerHTML = `
      <strong>着地エリア: ${landingArea}</strong><br>
      パワー: ${Math.round(this.power)}% / 角度: ${(10 + (this.angle / 100) * 80).toFixed(1)}°<br>
      タイミング精度: ${Math.round(this.timing)}% / ブースト: ${this.boostUsed ? '使用' : '未使用'}<br>
      最高高度: ${(this.maxAlt / 1000).toFixed(2)}km / ランキング: ${rank}位
    `;
            var apiRankEl = document.getElementById('result-api-rank');
            if (apiRankEl) { apiRankEl.textContent = ''; this._lastSubmitRank = null; }

            this.showScreen('result-screen');
            this.getCurrentPlayId();
            this.updateSupportMeterDisplay(this._supportCount != null ? this._supportCount : null, this._supportCountTotal);
            const supportBtn = document.getElementById('btn-support-ad');
            if (supportBtn && (this._supportDoneThisResult || this.hasSupportedForCurrentPlay())) supportBtn.disabled = true;
            try { this.sendSupportTelemetry('support_cta_view', {}); } catch (_) {}
            try { if (typeof Sound !== 'undefined') { Sound.startBGM('result'); if (this.distance >= 100000) Sound.playGoal(); } } catch (_) {}
        } catch (e) {
            console.warn('showResult error:', e);
            try { this.showScreen('result-screen'); this.getCurrentPlayId(); this.updateSupportMeterDisplay(this._supportCount != null ? this._supportCount : null, this._supportCountTotal); var sb = document.getElementById('btn-support-ad'); if (sb && (this._supportDoneThisResult || this.hasSupportedForCurrentPlay())) sb.disabled = true; this.sendSupportTelemetry('support_cta_view', {}); } catch (_) {}
        }
    },

    renderRankingFromStorage(list) {
        const scores = this.getScores();
        if (!scores.length) {
            list.innerHTML = '<p style="color:#a0a0b0;padding:20px">まだ記録がありません</p>';
        } else {
            list.innerHTML = scores.slice(0, 20).map((s, i) => {
                const dist = Number(s.distance);
                const isGoal = dist >= 100;
                const name = this.escapeHtml(s.nickname != null ? s.nickname : '');
                const date = s.date != null ? s.date : '';
                return `
          <div class="rank-row">
            <div class="rank-pos">${i + 1}</div>
            <div class="rank-icon">${isGoal ? '🐱' : ''}</div>
            <div class="rank-name">${name}</div>
            <div class="rank-dist">${Number.isFinite(dist) ? dist.toFixed(3) : '0.000'}km</div>
            <div class="rank-date">${date}</div>
          </div>
        `;
            }).join('');
        }
    },

    showRanking(from) {
        try {
            this._rankingFrom = from || 'title';
            const list = document.getElementById('ranking-list');
            if (!list) {
                this.showScreen('ranking-screen');
                return;
            }
            const base = (this.BAKENEKO_API_BASE || '').trim();
            const gameId = this.KOHADA_GAME_ID || 'kohada';
            if (!base) {
                this.renderRankingFromStorage(list);
                this.showScreen('ranking-screen');
                return;
            }
            list.innerHTML = '<p style="color:#a0a0b0;padding:20px">読み込み中...</p>';
            var retryWrap = document.getElementById('ranking-retry-wrap');
            if (retryWrap) retryWrap.style.display = 'none';
            this.showScreen('ranking-screen');
            const self = this;
            function showRankingError() {
                list.innerHTML = '<p style="color:#c0a0a0;padding:12px">現在ランキングを取得できません</p><p style="color:#888;font-size:12px;margin-top:8px">ローカル記録:</p>';
                var wrap = document.createElement('div');
                self.renderRankingFromStorage(wrap);
                list.appendChild(wrap);
                if (retryWrap) retryWrap.style.display = 'block';
                var retryBtn = document.getElementById('btn-ranking-retry');
                if (retryBtn) {
                    retryBtn.onclick = function () {
                        if (retryWrap) retryWrap.style.display = 'none';
                        self.showRanking(self._rankingFrom);
                    };
                }
            }
            self._fetchWithTimeout(base + '/api/ranking/leaderboard?gameId=' + encodeURIComponent(gameId) + '&limit=50', {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }, 8000).then(function (res) {
                if (!res.ok) throw new Error('leaderboard ' + res.status);
                return res.json();
            }).then(function (data) {
                if (retryWrap) retryWrap.style.display = 'none';
                if (data && data.entries && data.entries.length > 0) {
                    list.innerHTML = data.entries.map(function (e) {
                        const distKm = (Number(e.score) / 1000).toFixed(3);
                        const name = self.escapeHtml(e.nickname != null ? e.nickname : '');
                        var dateStr = '';
                        if (e.submitted_at) {
                            try {
                                var d = new Date(e.submitted_at);
                                dateStr = (d.getMonth()+1) + '/' + d.getDate();
                            } catch(_){}
                        }
                        return '<div class="rank-row"><div class="rank-pos">' + e.rank + '</div><div class="rank-name">' + name + '</div><div class="rank-date">' + dateStr + '</div><div class="rank-dist">' + distKm + 'km</div></div>';
                    }).join('');
                } else if (data && Array.isArray(data.entries)) {
                    list.innerHTML = '<p style="color:#a0a0b0;padding:20px">まだ記録がありません</p><p style="color:#888;font-size:12px">ローカル記録:</p>';
                    var wrap = document.createElement('div');
                    self.renderRankingFromStorage(wrap);
                    list.appendChild(wrap);
                } else {
                    showRankingError();
                }
            }).catch(function (err) {
                console.error('[ranking API] leaderboard error:', err);
                showRankingError();
            });
        } catch (e) {
            console.warn('showRanking error:', e);
            try {
                const list = document.getElementById('ranking-list');
                if (list) this.renderRankingFromStorage(list);
                this.showScreen('ranking-screen');
            } catch (_) {}
        }
    },

    hideRanking() {
        this.showScreen(this._rankingFrom === 'result' ? 'result-screen' : 'title-screen');
    },

    retry() {
        this.clearPhaseTimeout();
        try {
            this.boostTapIgnoreUntil = 0;
            this.inputLock = false;
            this.state = 'title';
            this.cutInTimer = 0;
            this.currentMilestone = null;
            this.phaseActive = false;
            if (this.els?.phaseUI) this.els.phaseUI.classList.add('hidden');
            if (this.els?.uiBottom) this.els.uiBottom.classList.add('hidden');
            document.getElementById('boost-ui')?.classList.add('hidden');
            this.showScreen('title-screen');
            this.updateTitlePlayCount();
            try { if (typeof Sound !== 'undefined' && Sound.startBGM) Sound.startBGM('title'); } catch (_) {}
        } catch (e) {
            console.warn('retry error:', e);
            this.state = 'title';
            try { this.showScreen('title-screen'); this.updateTitlePlayCount(); } catch (_) {}
        }
    },

    // 記録画像を1枚の画像（Blob）で生成（Xで画像付きシェア用）
    createRecordImageBlob() {
        return new Promise((resolve, reject) => {
            try {
                const W = 600, H = 400;
                const c = document.createElement('canvas');
                c.width = W;
                c.height = H;
                const ctx = c.getContext('2d');
                if (!ctx) { reject(new Error('no canvas')); return; }
                const distKm = (this.distance / 1000).toFixed(3);
                const isGoal = this.distance >= 100000;
                const grad = ctx.createLinearGradient(0, 0, 0, H);
                grad.addColorStop(0, '#1a1a2e');
                grad.addColorStop(1, '#0f3460');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, W, H);
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 22px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('こはだジャンプ ～ BAKENEKOドリーム ～', W / 2, 42);
                ctx.font = 'bold 48px sans-serif';
                ctx.fillText(distKm + ' km', W / 2, 140);
                ctx.font = '20px sans-serif';
                ctx.fillStyle = isGoal ? '#ffd700' : '#aaa';
                ctx.fillText(isGoal ? '🎉 猫又療養所 到着!!' : '着地！', W / 2, 180);
                const catImg = this.spriteCanvases && (this.spriteCanvases['着地'] || this.spriteCanvases['飛び乗り4'] || this.spriteCanvases['fly']);
                if (catImg && catImg.width && catImg.height) {
                    const size = 120;
                    const scale = Math.min(size / catImg.width, size / catImg.height);
                    const w = catImg.width * scale, h = catImg.height * scale;
                    ctx.drawImage(catImg, W / 2 - w / 2, 200 - h / 2, w, h);
                } else {
                    ctx.font = '64px serif';
                    ctx.fillStyle = '#fff';
                    ctx.fillText('🐱', W / 2, 250);
                }
                ctx.font = '16px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.8)';
                ctx.fillText('#こはだジャンプ #BAKENEKOドリーム', W / 2, H - 24);
                c.toBlob(function (blob) {
                    if (blob) resolve(blob);
                    else reject(new Error('toBlob failed'));
                }, 'image/png', 0.9);
            } catch (e) {
                reject(e);
            }
        });
    },

    share() {
        const distKm = (this.distance / 1000).toFixed(3);
        const isGoal = this.distance >= 100000;
        const text = isGoal
            ? `🐱✨ こはだが猫又療養所に到着しました！(${distKm}km)\n#こはだジャンプ #BAKENEKOドリーム`
            : `🐱💨 こはだの飛距離: ${distKm}km！猫又療養所まであと${(100 - distKm).toFixed(1)}km...\n#こはだジャンプ #BAKENEKOドリーム`;
        const openTweet = () => { window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank'); };
        if (typeof navigator !== 'undefined' && navigator.share) {
            this.createRecordImageBlob()
                .then((blob) => {
                    const file = new File([blob], 'kohada-record.png', { type: 'image/png' });
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                        return navigator.share({ text, files: [file] });
                    }
                    openTweet();
                })
                .catch(() => { openTweet(); });
        } else {
            openTweet();
        }
    },

    showScreen(id) {
        try {
            document.querySelectorAll('.screen').forEach(s => { try { s.classList.remove('active'); } catch (_) {} });
            if (id !== 'none') document.getElementById(id)?.classList?.add('active');
            const gc = document.getElementById('game-container');
            if (gc) gc.classList.toggle('title-screen-visible', id === 'title-screen');
        } catch (e) {
            console.warn('showScreen error:', e);
        }
    },

    escapeHtml(str) {
        try {
            const d = document.createElement('div');
            d.textContent = str != null ? String(str) : '';
            return d.innerHTML;
        } catch (e) {
            return '';
        }
    },

    // ─── Get Current Sprite Name ───
    getCurrentSprite() {
        // チャージ中（phase1-3）は飛び乗り4の画像を使用
        if (this.state === 'phase1') return '飛び乗り4';
        if (this.state === 'phase2' || this.state === 'phase3') return '飛び乗り4';
        if (this.state === 'flying' && !this.landed) {
            const speedKmh = this.speed * 3.6; // 画面表示と同じ km/h
            // 表示2000km/h超は「トップスピード」（2001ijou.png で上書き済みならその画像）
            if (speedKmh > 2000) return 'トップスピード';
            // 表示2000km/h以下は siyougazou/2000以下.png
            if (speedKmh <= 2000 && this.spriteCanvases['飛行中_2000以下']) return '飛行中_2000以下';
            return '飛行中';
        }
        if (this.landed) {
            // 着地は全て 着地.png を使用（距離別画像が無くても404にしない）
            return '着地';
        }
        return '飛び乗り4';
    },

    // ─── Main Render Loop ───
    render(timestamp) {
        if (!this.ctx || !this.canvas) {
            try { this.animId = requestAnimationFrame((t) => this.render(t)); } catch (_) {}
            return;
        }
        try {
            const now = timestamp || (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const dt = Math.min((now - (this.lastTime || now)) / 1000, 0.05);
            this.lastTime = now;

            const ctx = this.ctx;
            const W = this.width;
            const H = this.height;

            // Update gauge（phase1/2/3 のときだけ。2回目以降の状態ズレで落とさない）
            const inPhase = this.state === 'phase1' || this.state === 'phase2' || this.state === 'phase3';
            if (this.phaseActive && inPhase) {
                try {
                    const g = Number(this.gaugeValue);
                    const sp = Number(this.gaugeSpeed);
                    this.gaugeValue = (typeof g === 'number' && !Number.isNaN(g) ? g : 50) + this.gaugeDir * (typeof sp === 'number' && !Number.isNaN(sp) ? sp : 5);
                    if (this.gaugeValue >= 100) { this.gaugeValue = 100; this.gaugeDir = -1; }
                    if (this.gaugeValue <= 0) { this.gaugeValue = 0; this.gaugeDir = 1; }
                    const gaugeFill = document.getElementById('phase-gauge-fill');
                    const gaugeMarker = document.getElementById('phase-gauge-marker');
                    const pct = `${Math.max(0, Math.min(100, this.gaugeValue))}%`;
                    if (gaugeFill) try { gaugeFill.style.width = pct; } catch (_) {}
                    if (gaugeMarker) try { gaugeMarker.style.left = pct; } catch (_) {}
                } catch (e) { /* ゲージ更新で落とさない */ }
            }

            // Update physics: 固定タイムステップで実機のFPSに依存しない（スマホでも同じ難易度）
            if (this.state === 'flying') {
                const PHYSICS_STEP = (1 / 60) * this.TIME_SCALE;
                const MAX_STEPS = 15;
                this.physicsAccumulator += dt * this.TIME_SCALE;
                let steps = 0;
                while (this.physicsAccumulator >= PHYSICS_STEP && steps < MAX_STEPS) {
                    try {
                        this.updatePhysics(PHYSICS_STEP);
                        this.updateParticles(PHYSICS_STEP);
                    } catch (pe) {
                        console.warn('physics/particles error:', pe);
                    }
                    this.physicsAccumulator -= PHYSICS_STEP;
                    steps++;
                }
                if (this.physicsAccumulator > 0 && steps < MAX_STEPS) {
                    try {
                        this.updatePhysics(this.physicsAccumulator);
                        this.updateParticles(this.physicsAccumulator);
                    } catch (pe) {
                        console.warn('physics/particles error:', pe);
                    }
                    this.physicsAccumulator = 0;
                } else if (this.physicsAccumulator > PHYSICS_STEP * 2) {
                    this.physicsAccumulator = PHYSICS_STEP;
                }

                // 発射後のアニメーション。表示2000km/h超はトップスピード、以下は飛行中/2000以下
                const speedKmhF = this.speed * 3.6;
                const use2000Below = speedKmhF <= 2000 && this.spriteCanvases['飛行中_2000以下'];
                const animDt = dt * this.TIME_SCALE;
                if (this.flyFrames && this.flyFrames.length > 0 && speedKmhF <= 2000 && !use2000Below) {
                    this.flyFrameTimer += animDt * 60;
                    const frameRate = 8;
                    const frameIndex = Math.floor(this.flyFrameTimer / frameRate) % this.flyFrames.length;
                    this.flyFrameIndex = frameIndex;
                    this.spriteCanvases['飛行中'] = this.flyFrames[frameIndex];
                }
                // 速度2000超のときは spriteCanvases['トップスピード'] は上書きしない（loadAdditionalImages で読み込んだ トップスピード.png を使用）

                // Update Messages
                if (this.gameMessages) {
                    this.gameMessages.forEach(msg => {
                        msg.life--;
                        msg.y += msg.vy;
                        msg.x = this.x;
                        msg.y += 5; // Move up
                    });
                    this.gameMessages = this.gameMessages.filter(m => m.life > 0);
                }

                // Distance Milestones
                if (this.distance > this.nextMilestone) {
                    const words = [
                        "GOOD!", "GREAT!", "EXCELLENT!", "AMAZING!", "GODLIKE!",
                        "UNREAL!", "LEGENDARY!", "COSMIC!", "GALAXY!", "BIG BANG!"
                    ];
                    const idx = Math.min(words.length - 1, Math.floor(this.distance / 10000) - 1);
                    if (idx >= 0) {
                        this.spawnMessage(words[idx % words.length]);
                        try { if (typeof Sound !== 'undefined' && Sound.playBoost) Sound.playBoost(); } catch (_) {}
                    }
                    this.nextMilestone += 10000;  // 10kmごと
                }

                // Trail particles
                if (!this.landed && this.speed > 50) {
                    const angle = Math.atan2(this.vy, this.vx);
                    const backAngle = angle + Math.PI;
                    const spread = 0.5;
                    const numP = this.speed > 500 ? 3 : 1;
                    for (let i = 0; i < numP; i++) {
                        const emitAngle = backAngle + (Math.random() - 0.5) * spread;
                        const emitSpeed = Math.random() * 20;
                        this.particles.push({
                            x: this.x - Math.cos(angle) * 30 + (Math.random() - 0.5) * 20,
                            y: this.y - Math.sin(angle) * 30 + (Math.random() - 0.5) * 20,
                            vx: Math.cos(emitAngle) * emitSpeed + this.vx * 0.1,
                            vy: Math.sin(emitAngle) * emitSpeed + this.vy * 0.1,
                            size: 3 + Math.random() * 6,
                            life: 20 + Math.random() * 20,
                            maxLife: 40,
                            color: `hsla(${30 + Math.random() * 30}, 80%, ${60 + Math.random() * 30}%, `,
                            type: 'fire'
                        });
                    }
                }
            }

            // Milestone timer
            if (this.milestoneTimer > 0) {
                this.milestoneTimer--;
                if (this.milestoneTimer <= 0) {
                    document.getElementById('milestone-popup')?.classList?.add('hidden');
                }
            }

            if (this.shakeTimer > 0) this.shakeTimer--;

            // Camera
            // Camera
            if (this.state === 'flying' || this.state === 'result') {
                const targetCamX = this.x - W * 0.3;
                // User Request: Center the character (0.5H)
                // Render Y = 0.9H + (y - camY) * -scale
                // We want Render Y = 0.5H
                // 0.9H - (camY - y) * scale = 0.5H
                // (camY - y) * scale = 0.4H
                // camY = y + 0.4H / scale
                // So yOffset = 0.4H / scale. 
                // Wait, my previous logic was targetCamY = y + yOffset -> camY ~ y + yOffset
                // And I used negative offset to move camera down (so player goes up).
                // Let's re-verify sign.
                // ctx.translate(0, -camY) -> moves world up by -camY (or down by camY?)
                // Positive y goes UP. camY goes UP.
                // If camY is higher than y, player is drawn lower.
                // We want player at 0.5H (Center) instead of 0.9H (Bottom).
                // So we want player to be "higher" on screen -> Camera must be "lower" than before?
                // No, existing was 0.9H. Center is 0.5H (Higher on screen).
                // 0.9H (Bottom) -> 0.5H (Center).
                // Yes, "Higher".
                // My formula: y_screen = 0.9H - (camY - y) * scale
                // 0.5H = 0.9H - (offset) * scale
                // offset * scale = 0.4H
                // offset = 0.4H / scale.
                // So camY should be y + 0.4H/scale.

                // Wait, if camY is y + positive, camera is ABOVE player.
                // Player is drawn BELOW camera.
                // So y_screen becomes smaller (higher coordinate value? No, HTML5 Canvas 0 is top).
                // Wait, I am confused about Canvas Y.
                // In my code: ctx.translate(..., H * 0.9); ctx.scale(s, -s);
                // So Y axis is flipped UP.
                // y_screen_pixel = H*0.9 - (y_world_relative * s).
                // If y_world_relative (y - camY) is 0, pixel is 0.9H (Bottom).
                // To get to 0.5H (Center), (y - camY) must be POSITIVE (player above camera).
                // (y - camY) * s = 0.4H
                // y - camY = 0.4H / s
                // camY = y - 0.4H / s
                // So offset is NEGATIVE.

                let yOffset = 0;
                if (this.state === 'flying' && !this.landed) {
                    const scale = this.getZoomScale();
                    yOffset = -(H * 0.4) / scale;
                }
                const targetCamY = this.y + yOffset;

                this.camX += (targetCamX - this.camX) * 0.25;
                this.camY += (targetCamY - this.camY) * 0.1; // Smoother Y follow
            }

            // ─── Draw ───
            ctx.save();
            if (this.shakeTimer > 0) {
                const s = this.shakeTimer * 0.8;
                ctx.translate(Math.random() * s - s / 2, Math.random() * s - s / 2);
            }

            this.drawBackground(ctx, W, H);

            // World transform
            ctx.save();
            const scale = this.getZoomScale();
            ctx.translate(W * 0.3, H * 0.9);
            ctx.scale(scale, -scale);
            ctx.translate(-this.camX, -this.camY);

            this.drawGround(ctx);
            this.drawBGObjects(ctx);
            this.drawBuildings(ctx);
            this.drawParticles(ctx);
            this.drawShockwave(ctx);

            // Draw Kohada
            ctx.save();
            const spriteName = this.getCurrentSprite();
            const spriteImg = this.spriteCanvases[spriteName];
            const isCharge = this.state === 'phase1' || this.state === 'phase2' || this.state === 'phase3';

            let yOffset = 0;
            let drawScale = 2.0;
            const worldScale = this.getZoomScale();

            if (isCharge && spriteImg) {
                // 発射前：全身が入るように縮小し、ゲージ・ボタンと被らない位置に
                const imgH = spriteImg.height || 340;
                const maxScreenH = H * 0.42;
                drawScale = Math.min(2.0, (maxScreenH / worldScale) / imgH);
                yOffset = -60;
            } else if ((this.state === 'flying' || this.landed) && spriteImg) {
                // 発射後・着地：画像を画面内に収めるようスケールを調整
                const imgH = spriteImg.height || 340;
                const imgW = spriteImg.width || 410;
                const maxScreenH = H * 0.48;  // 画面高さの48%以内
                const maxScreenW = W * 0.5;   // 画面幅の50%以内
                const scaleH = (maxScreenH / worldScale) / imgH;
                const scaleW = (maxScreenW / worldScale) / imgW;
                drawScale = Math.min(2.0, scaleH, scaleW);
            }

            ctx.translate(this.x, this.y + yOffset);
            ctx.scale(drawScale, drawScale);
            const offsetX = spriteImg ? -(spriteImg.width / 2) : -205;
            ctx.translate(offsetX, 0);
            this.drawKohadaSprite(ctx);
            ctx.restore();

            this.drawMessages(ctx);
            ctx.restore();

            // Flash Effect
            if (this.flashTimer > 0) {
                ctx.fillStyle = `rgba(255, 255, 255, ${this.flashTimer / 20})`;
                ctx.fillRect(0, 0, W, H);
                this.flashTimer--;
            }

            // CUT-IN Overlay
            if (this.cutInTimer > 0) {
                this.drawCutIn(ctx, W, H);
            }

            if (this.state === 'flying' || this.state === 'result') {
                try { this.updateHUD(); } catch (_) {}

                // Speed Lines
                if (this.speed > 300) {
                    ctx.save();
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    const angle = Math.atan2(this.vy, this.vx);
                    const numLines = Math.min(30, (this.speed - 300) / 40);
                    for (let i = 0; i < numLines; i++) {
                        const lx = Math.random() * W;
                        const ly = Math.random() * H;
                        const len = 100 + Math.random() * 200;
                        ctx.moveTo(lx, ly);
                        ctx.lineTo(lx - Math.cos(angle) * len, ly - Math.sin(angle) * len);
                    }
                    ctx.stroke();
                    ctx.restore();
                }
            }
            ctx.restore();

            // Debug Info（例外で落とさない）
            try {
                const dbg = document.getElementById('debug-overlay');
                if (dbg && this.canvas) {
                    dbg.textContent = `
State: ${this.state}
Size: ${W} x ${H}
Pos: ${this.x.toFixed(1)}, ${this.y.toFixed(1)}
Cam: ${this.camX.toFixed(1)}, ${this.camY.toFixed(1)}
Speed: ${this.speed.toFixed(1)}
Canvas: ${this.canvas.width}x${this.canvas.height}
                    `.trim();
                }
            } catch (_) {}
        } catch (e) {
            console.warn('render error:', e);
        } finally {
            try { this.animId = requestAnimationFrame((t) => this.render(t)); } catch (_) {}
        }
    },

    getZoomScale() {
        if (this.state === 'flying') {
            const alt = this.altitude;
            if (alt < 100) return 1.0;
            if (alt < 1000) return 1.0 - (alt - 100) / 900 * 0.5;
            if (alt < 5000) return 0.5 - (alt - 1000) / 4000 * 0.3;
            return 0.2;
        }
        return 1.0;
    },

    // ─── Draw Background & Visuals ───
    drawBackground(ctx, W, H) {
        // Sky Gradient based on Altitude
        // 0-10km: Blue -> Deep Blue
        // 10-30km: Deep Blue -> Space Black
        // 30km+: Space
        const alt = this.altitude;
        let r, g, b;

        const skyBlue = [135, 206, 235];
        const deepBlue = [25, 25, 112];
        const spaceBlack = [10, 10, 20];

        if (alt < 10000) {
            const t = Math.min(alt / 10000, 1);
            r = skyBlue[0] * (1 - t) + deepBlue[0] * t;
            g = skyBlue[1] * (1 - t) + deepBlue[1] * t;
            b = skyBlue[2] * (1 - t) + deepBlue[2] * t;
        } else {
            const t = Math.min((alt - 10000) / 20000, 1);
            r = deepBlue[0] * (1 - t) + spaceBlack[0] * t;
            g = deepBlue[1] * (1 - t) + spaceBlack[1] * t;
            b = deepBlue[2] * (1 - t) + spaceBlack[2] * t;
        }

        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, `rgb(${r},${g},${b})`);
        grad.addColorStop(1, `rgb(${r * 1.2},${g * 1.2},${b * 1.5})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // Sun & Moon (Visible at high altitude)
        if (alt > 25000) {
            const alpha = Math.min((alt - 25000) / 5000, 1);
            ctx.save();
            ctx.globalAlpha = alpha;

            // Sun (Top Left)
            const sunX = W * 0.1;
            const sunY = H * 0.15;
            const sunGrad = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 60);
            sunGrad.addColorStop(0, '#fff');
            sunGrad.addColorStop(0.2, '#fff6d5');
            sunGrad.addColorStop(1, 'rgba(255, 200, 100, 0)');
            ctx.fillStyle = sunGrad;
            ctx.beginPath();
            ctx.arc(sunX, sunY, 60, 0, Math.PI * 2);
            ctx.fill();

            // Moon (Top Right)
            const moonX = W * 0.9;
            const moonY = H * 0.2;
            ctx.fillStyle = '#eee';
            ctx.beginPath();
            ctx.arc(moonX, moonY, 30, 0, Math.PI * 2);
            ctx.fill();
            // Crater
            ctx.fillStyle = '#ddd';
            ctx.beginPath();
            ctx.arc(moonX - 10, moonY - 5, 8, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        }

        // Stars (Visible when getting dark)
        if (alt > 5000) {
            const alpha = Math.min((alt - 5000) / 10000, 1);
            ctx.fillStyle = '#fff';
            ctx.globalAlpha = alpha;
            for (const s of this.stars) {
                const sx = ((s.x - this.camX * 0.02) % W + W) % W;
                const sy = ((s.y - this.camY * 0.02) % H + H) % H;
                ctx.beginPath();
                ctx.arc(sx, sy, s.size * (1 + Math.random() * 0.5), 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }

        // Cloud Layer (Below player when high)
        if (alt > 15000) {
            // Clouds appear at "20000m" altitude visually relative to start?
            // Actually let's draw them fixed near bottom of screen to simulate being "above" them
            const cloudAlpha = Math.min((alt - 15000) / 5000, 0.8);
            ctx.save();
            ctx.globalAlpha = cloudAlpha;
            const cloudY = H * 0.8;

            // Scrolling cloud layer
            const shift = (this.camX * 0.1) % W;

            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            for (let i = 0; i < 10; i++) {
                const cx = (i * W / 5 - shift + W * 2) % (W * 2) - W * 0.5;
                const cy = cloudY + Math.sin(i) * 20;
                const w = W / 3;
                ctx.beginPath();
                ctx.ellipse(cx, cy, w, 40, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        // ─── Far Ground (Map View) ───
        // Visible at bottom when high altitude
        if (this.altitude > 500) {
            const groundH = H * 0.25; // Take up bottom 25% of screen
            const groundY = H - groundH;

            // Fade within scaling
            const fade = Math.min((this.altitude - 500) / 1000, 1);

            ctx.save();
            ctx.globalAlpha = fade;

            // Horizon Line
            ctx.beginPath();
            ctx.moveTo(0, groundY);
            ctx.lineTo(W, groundY);
            ctx.strokeStyle = `rgba(255,255,255,0.3)`;
            ctx.lineWidth = 1;
            ctx.stroke();

            // Ground Fill
            // Change color based on biome
            const distKm = this.distance / 1000;
            let groundColor = '#223'; // Default dark
            if (distKm < 15) groundColor = '#223'; // City (Dark)
            else if (distKm < 40) groundColor = '#124'; // Sea (Blue-ish)
            else if (distKm < 70) groundColor = '#232'; // Urban Chiba
            else groundColor = '#131'; // Rural Green

            const gGrad = ctx.createLinearGradient(0, groundY, 0, H);
            gGrad.addColorStop(0, groundColor);
            gGrad.addColorStop(1, '#000');
            ctx.fillStyle = gGrad;
            ctx.fillRect(0, groundY, W, groundH);

            // Scrolling Grid (Perspective)
            ctx.strokeStyle = `rgba(255,255,255,0.1)`;
            ctx.lineWidth = 1;
            ctx.beginPath();

            // Vertical lines (moving left)
            const gridSpeed = this.vx * 0.05; // Map scale speed
            const offset = (this.x * 0.05) % 100;
            for (let gx = 0; gx < W + 100; gx += 100) {
                // Perspective X
                // Simple: just straight lines for map view, or angled?
                // Let's do straight for map view clarity
                const lineX = gx - offset;
                ctx.moveTo(lineX, groundY);
                ctx.lineTo(lineX, H);
            }

            // Horizontal lines (perspective z)
            for (let gy = 0; gy < groundH; gy += 20) {
                const lineY = groundY + gy;
                ctx.moveTo(0, lineY);
                ctx.lineTo(W, lineY);
            }
            ctx.stroke();

            // Biome details on Map
            // Cities
            if (distKm < 15 || (distKm > 40 && distKm < 70)) {
                ctx.fillStyle = 'rgba(255,255,100,0.5)';
                const cityOffset = (this.x * 0.05) % 300;
                for (let cx = 0; cx < W + 300; cx += 300) {
                    if (Math.random() > 0.5) continue;
                    const bx = cx - cityOffset;
                    ctx.fillRect(bx, groundY + 10, 10, 5);
                }
            }

            ctx.restore();
        }

        // Distance markers (HUD style)
        if (this.state === 'flying' || this.state === 'result') {
            // Only draw if relatively low, or integrate into Far Ground?
            // Existing logic is fine for low altitude
        }
    },

    // ─── Draw BG Objects (Fuji, etc) ───
    drawBGObjects(ctx) {
        // Mt Fuji (Visible from 10km to 80km)
        // Parallax slower than buildings
        const distKm = this.distance / 1000;
        if (distKm > 5 && distKm < 90) {
            ctx.save();
            // Parallax position
            const fujiX = 5000 + (this.x * 0.9) + 2000; // Moves with camera but slightly slower? 
            // Actually distant objects should move SLOWER than camera, meaning they should lag behind?
            // If camera moves +1000, Fuji should move +900 relative to world?
            // Standard parallax: screen_x = (world_x - cam_x * factor)

            const fujiWorldX = 20000; // Fixed world position
            const camFactor = 0.1; // Very distant
            const screenX = fujiWorldX - this.camX * camFactor;

            // Allow it to draw even if "screenX" is in world coords because of the transform?
            // Wait, we are inside world transform.
            // So we need to position it in world coordinates relative to camera?
            // It's easier to draw strictly based on camera position relative to "screen"
            // But we are in `scale` transform.

            // Let's just place it at a position that moves with the player but slowly.
            const fujiX_rel = this.camX + 1000; // Always 1000m ahead? No.

            // Proper Parallax in World Space is tricky with Zoom.
            // Let's draw it fixed relative to camera X with an offset.
            ctx.translate(this.camX + 2000 - (this.camX * 0.05 % 4000), 0);

            ctx.fillStyle = '#6677aa';
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(800, 1500); // Tall Fuji
            ctx.lineTo(1600, 0);
            ctx.fill();

            // Snow cap
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.moveTo(800, 1500);
            ctx.lineTo(600, 1125);
            ctx.lineTo(700, 1200);
            ctx.lineTo(800, 1100);
            ctx.lineTo(900, 1200);
            ctx.lineTo(1000, 1125);
            ctx.fill();

            ctx.restore();
        }
    },

    drawGround(ctx) {
        const distKm = this.distance / 1000;
        let groundColor;
        if (distKm < 5) groundColor = '#222228';
        else if (distKm < 30) groundColor = '#1a2a3a';
        else if (distKm < 60) groundColor = '#1a3a2a';
        else groundColor = '#2a3a1a';

        ctx.fillStyle = groundColor;
        ctx.fillRect(-10000, -500, 200000, 500);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-10000, 0);
        ctx.lineTo(200000, 0);
        ctx.stroke();
    },

    drawBuildings(ctx) {
        if (this.camX > 6000) return;

        for (const b of this.buildings) {
            if (b.x + b.w < this.camX - 200 || b.x > this.camX + this.width + 200) continue;
            ctx.fillStyle = b.color;
            ctx.fillRect(b.x, 0, b.w, b.h);

            if (b.windows) {
                ctx.fillStyle = 'rgba(255, 200, 100, 0.3)';
                for (let wy = 10; wy < b.h - 10; wy += 15) {
                    for (let wx = 5; wx < b.w - 5; wx += 12) {
                        if (Math.random() > 0.3) ctx.fillRect(b.x + wx, wy, 6, 8);
                    }
                }
            }
        }

        // BAKENEKO CAFE building
        ctx.fillStyle = '#2a2a35';
        ctx.fillRect(-80, 0, 120, 60);
        ctx.fillStyle = '#ff6b35';
        ctx.save();
        ctx.scale(1, -1);
        ctx.font = 'bold 8px "Zen Maru Gothic"';
        ctx.textAlign = 'center';
        ctx.fillText('BAKENEKO', -20, -40);
        ctx.fillText('CAFE', -20, -30);
        ctx.restore();
    },

    // ─── Shockwave Effect ───
    drawShockwave(ctx) {
        if (this.speed > 340 && this.state === 'flying') {
            ctx.save();
            ctx.translate(this.x, this.y + 150); // Center on body (approx)

            // Pulsing Rings
            const time = performance.now() / 100;
            const count = 3;

            for (let i = 0; i < count; i++) {
                const t = (time + i * (10 / count)) % 10;
                const progress = t / 10; // 0 to 1
                const size = progress * 400;
                const alpha = 1 - progress;

                ctx.beginPath();
                ctx.arc(0, 0, size, 0, Math.PI * 2);
                ctx.lineWidth = 10 * (1 - progress);
                ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.5})`;
                ctx.stroke();
            }

            // Cone lines (Subtle)
            const angle = Math.atan2(this.vy, this.vx);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(50, 0);
            ctx.lineTo(-300, 200);
            ctx.moveTo(50, 0);
            ctx.lineTo(-300, -200);
            ctx.strokeStyle = `rgba(255, 255, 255, 0.2)`;
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.restore();
        }
    },

    // ─── Floating Messages ───
    spawnMessage(text) {
        try {
            if (!Array.isArray(this.gameMessages)) this.gameMessages = [];
            this.gameMessages.push({
                text: text != null ? String(text) : '',
                x: this.x,
                y: this.y + 300,
                life: 120,
                vy: 2
            });
        } catch (e) {
            console.warn('spawnMessage error:', e);
        }
    },

    drawMessages(ctx) {
        if (!ctx) return;
        try {
            if (!Array.isArray(this.gameMessages)) return;
            ctx.save();
            ctx.textAlign = 'center';
            ctx.font = 'bold 160px "Arial Black", sans-serif';

            this.gameMessages.forEach(msg => {
            if (msg.life > 0) {
                ctx.save();
                ctx.translate(msg.x, msg.y);
                ctx.scale(1, -1); // Flip text back up

                const alpha = Math.min(1, msg.life / 30);

                ctx.fillStyle = `rgba(255, 200, 50, ${alpha})`;
                ctx.strokeStyle = `rgba(0, 0, 0, ${alpha})`;
                ctx.lineWidth = 12;
                ctx.strokeText(msg.text, 0, 0);
                ctx.fillText(msg.text, 0, 0);

                ctx.restore();
            }
        });
            ctx.restore();
        } catch (e) {
            console.warn('drawMessages error:', e);
        }
    },

    // ─── Draw Kohada (必ず写真を使用・猫の顔が進行方向右になる) ───
    drawKohadaSprite(ctx) {
        if (!ctx) return;
        try {
            const spriteName = this.getCurrentSprite();
            let img = this.spriteCanvases && this.spriteCanvases[spriteName];
            if (!img && typeof this.spriteCanvases === 'object') {
                const fallbackOrder = ['飛び乗り4', '飛び乗り1', '飛行中_2000以下', '飛行中', 'トップスピード_2001以上', 'トップスピード', '着地'];
                for (const name of fallbackOrder) {
                    if (this.spriteCanvases[name]) {
                        img = this.spriteCanvases[name];
                        break;
                    }
                }
            }

            if ((this.speed * 3.6) > 2000) {
                ctx.shadowBlur = 40;
                ctx.shadowColor = '#ff0000';
            } else {
                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';
            }

            if (img) {
            // Rotation based on velocity
            let rot = 0;
            if (this.state === 'flying' && !this.landed) {
                rot = Math.atan2(this.vy, this.vx);
            }

            // 画像の実際のサイズを取得
            const imgWidth = img.width || 410;
            const imgHeight = img.height || 340;
            const centerX = imgWidth / 2;
            const centerY = imgHeight / 2;

            // Pivot center for rotation
            ctx.translate(centerX, centerY);
            ctx.rotate(rot);

            // 発射前・発射後・着地の画像を左右反転して表示
            // 猫の顔が進行方向（右）を向くようにする
            let scaleX = 1;
            if (this.state === 'flying' && !this.landed) {
                scaleX = this.vx >= 0 ? 1 : -1;  // 発射後：右進行で顔右、左進行で顔左（反転済み）
            } else {
                // 発射前・着地：左右反転
                scaleX = 1;
            }
            ctx.scale(scaleX, -1);

            ctx.translate(-centerX, -centerY);

            ctx.drawImage(img, 0, 0, imgWidth, imgHeight);
            } else {
                ctx.save();
                ctx.translate(205, 170);
                ctx.scale(1, -1);
                ctx.font = '200px serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('🐱', 0, 0);
                ctx.restore();
            }
        } catch (e) {
            console.warn('drawKohadaSprite error:', e);
        }
    },
    drawKohada(ctx) {
        const spriteKey = this.getCurrentSprite();
        const spriteCanvas = this.spriteLoaded ? this.spriteCanvases[spriteKey] : null;

        ctx.save();
        ctx.translate(this.x, this.y);

        // Rotation based on velocity
        let rotation = 0;
        if (this.state === 'flying' && !this.landed) {
            rotation = -Math.atan2(this.vy, this.vx);
        }
        ctx.rotate(rotation);
        ctx.scale(1, -1); // Flip Y back for image

        const drawSize = 200; // Big enough to clearly see kohada!

        if (spriteCanvas) {
            // Draw real kohada sprite
            const aspect = spriteCanvas.width / spriteCanvas.height;
            const w = drawSize * aspect;
            const h = drawSize;
            ctx.drawImage(spriteCanvas, -w / 2, -h / 2, w, h);
        } else {
            // Fallback: draw circle cat
            ctx.fillStyle = '#888';
            ctx.beginPath();
            ctx.arc(0, 0, drawSize / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = `${drawSize * 0.6}px serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('🐱', 0, 0);
        }

        // Speed lines when flying fast - LOTS of them!
        if (this.state === 'flying' && this.speed > 30) {
            const intensity = Math.min(this.speed / 100, 1);
            const lineCount = Math.floor(5 + intensity * 15);
            ctx.lineWidth = 1 + intensity * 2;
            for (let i = 0; i < lineCount; i++) {
                const alpha = 0.15 + intensity * 0.4;
                ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
                const lx = -drawSize / 2 - 5 - Math.random() * 60;
                const ly = (Math.random() - 0.5) * drawSize * 1.5;
                const len = 20 + Math.random() * 50 + intensity * 40;
                ctx.beginPath();
                ctx.moveTo(lx, ly);
                ctx.lineTo(lx - len, ly);
                ctx.stroke();
            }
        }

        ctx.restore();
    },

    drawParticles(ctx) {
        for (const p of this.particles) {
            const alpha = p.life / p.maxLife;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.scale(1, -1);
            ctx.fillStyle = p.color + alpha + ')';
            if (p.type === 'glass') {
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            } else {
                ctx.beginPath();
                ctx.arc(0, 0, p.size, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
    },

    updateHUD() {
        try {
            const d = document.getElementById('hud-distance');
            const a = document.getElementById('hud-altitude');
            const s = document.getElementById('hud-speed');
            if (d) d.textContent = (this.distance / 1000).toFixed(3);
            if (a) a.textContent = Math.round(this.altitude);
            if (s) s.textContent = Math.round(this.speed * 3.6);
        } catch (e) {
            console.warn('updateHUD error:', e);
        }
    }
};

// ─── Start ───
window.Game = Game;
// スタートボタン用：未初期化なら先に init してから startGame（クリックで確実に動くようにする）
window.startKohadaGame = function () {
    if (!window.Game) return;
    try {
        if (!window.Game._inited) window.Game.init();
        window.Game.startGame();
    } catch (e) {
        console.error('startKohadaGame:', e);
    }
};
function runInit() {
    try {
        Game.init();
    } catch (e) {
        console.error('Game.init failed:', e);
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runInit);
} else {
    runInit();
}
