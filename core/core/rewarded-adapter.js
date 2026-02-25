/**
 * リワード広告 抽象アダプタ（SDK 差し替えは showAdAndGetToken のみ修正で完結）
 * - 公開API: runRewarded(): Promise<boolean>
 * - USE_REAL_ADS = false のときは runPseudoRewarded（5秒ローディング・100%成功）
 * - USE_REAL_ADS = true のときは runRealRewarded（nonce → showAdAndGetToken → verify）
 * - いずれも必ず resolve(true/false)。reject 禁止。90秒でタイムアウト。
 */
(function () {
  'use strict';

  /** 実広告を使う場合は true。window.BAKENEKO_USE_REAL_ADS で本番切替（index.html でデフォルト false）。 */
  const USE_REAL_ADS = (typeof window !== 'undefined' && window.BAKENEKO_USE_REAL_ADS === true);

  const PSEUDO_LOADING_MS = 5000;
  const TIMEOUT_MS = 90000;
  const COOLDOWN_MS = 5000;

  /** 失敗後のクールダウン終了時刻。0 は未設定。 */
  var cooldownUntil = 0;
  /** UI 向け失敗カテゴリ: 'transient' | 'user_action' | 'suspicious' | 'unknown'。成功時・未失敗時は null。 */
  var lastFailureCategory = null;
  /** サーバから返った reason（表示用に許可リスト内のみ保持。PII なし）。 */
  var lastFailureReason = null;

  function normalizeApiBase(val) {
    if (typeof val !== 'string') return '';
    var s = val.trim();
    if (!s) return '';
    try {
      var u = new URL(s);
      u.pathname = u.pathname.replace(/\/+$/, '') || '/';
      return u.origin + u.pathname;
    } catch (_) { return s.replace(/\/+$/, ''); }
  }

  var API_BASE = normalizeApiBase(typeof window.BAKENEKO_API_BASE !== 'undefined' ? window.BAKENEKO_API_BASE : '');
  var config = { type: 'none', rewarded: 'off' };

  /** 二重実行防止: 実行中は同じ Promise を返す。完了時（resolve/reject 両方）にクリア。ES5 互換のため .then でクリア。 */
  var inFlightPromise = null;

  /** runRewarded() 1回あたり rewarded_result テレメトリを1回だけ送るためのガード。新規 run 開始時に false にリセット。 */
  var telemetrySent = false;

  /** [rewarded-debug] を1回だけ出すためのフラグ。 */
  var _rewardedDebugLogged = false;

  function clearInFlight() {
    inFlightPromise = null;
  }

  /** fetch が reject した（レスポンスを得る前に失敗）場合に true。429 や HTTP レスポンスがある場合は false。 */
  function isNetworkError(err) {
    if (!err || (err && err.rateLimited === true)) return false;
    if (typeof err.status === 'number') return false;
    return true;
  }

  /**
   * 内部結果オブジェクトから UX カテゴリを算出。429 / timeout / reason に基づく。
   * @param {{ success: boolean, reason?: string, was429?: boolean, timeout?: boolean }} result
   * @returns {'transient'|'user_action'|'suspicious'|'unknown'}
   */
  function inferCategory(result) {
    if (!result) return 'unknown';
    if (result.was429 === true || (result.reason === 'rate_limited')) return 'suspicious';
    if (result.timeout === true) return 'transient';
    if (result.reason === 'missing_token') return 'user_action';
    var r = result.reason || '';
    if (r === 'missing_nonce' || r === 'nonexistent_nonce' || r === 'invalid_or_used_nonce' ||
        r === 'verification_failed' || r === 'attempts_exceeded') return 'transient';
    return 'unknown';
  }

  var _gameIdLogOnce = false;

  /**
   * gameId と source を取得。優先: A) window.BAKENEKO_GAME_ID → B) meta/data 属性 → C) pathname 推定 → D) "template"。
   * 初回のみ console.log('rewarded_adapter: gameId=<id> source=<A|B|C|D>') を出力。
   * @returns {{ id: string, source: string }}
   */
  function getGameIdAndSource() {
    var id = '';
    var source = 'D';

    if (typeof window.BAKENEKO_GAME_ID !== 'undefined' && window.BAKENEKO_GAME_ID !== null && window.BAKENEKO_GAME_ID !== '') {
      id = String(window.BAKENEKO_GAME_ID).trim();
      if (id) source = 'A';
    }
    if (!id && typeof document !== 'undefined' && document.querySelector) {
      var meta = document.querySelector('meta[name="bakeneko:gameId"]');
      if (meta && meta.getAttribute('content')) {
        id = String(meta.getAttribute('content')).trim();
        if (id) source = 'B';
      }
      if (!id) {
        var el = document.querySelector('[data-bakeneko-game-id]');
        if (el && el.getAttribute('data-bakeneko-game-id')) {
          id = String(el.getAttribute('data-bakeneko-game-id')).trim();
          if (id) source = 'B';
        }
      }
    }
    if (!id && typeof location !== 'undefined' && location.pathname) {
      var m = location.pathname.match(/\/games\/([^/]+)/);
      if (m && m[1]) {
        id = m[1];
        source = 'C';
        console.warn('rewarded_adapter: gameId inferred from pathname', id);
      }
    }
    if (!id) {
      id = 'template';
      source = 'D';
      console.warn('rewarded_adapter: gameId fallback to default', id);
    }
    if (!_gameIdLogOnce) {
      _gameIdLogOnce = true;
      console.log('rewarded_adapter: gameId=' + id + ' source=' + source);
    }
    return { id: id, source: source };
  }

  /** @returns {string} */
  function getGameId() {
    return getGameIdAndSource().id;
  }

  /**
   * 内部結果を rewarded_result 用の result に正規化。adapter 送信のみ。
   * @param {{ success?: boolean, reason?: string, was429?: boolean, timeout?: boolean }} result
   * @returns {'granted'|'skipped'|'sdk_error'}
   */
  function mapResultToStr(result) {
    if (result && result.success === true) return 'granted';
    if (result && result.timeout === true) return 'skipped';
    if (result && result.reason === 'missing_token') return 'skipped';
    if (result && (result.reason || result.was429)) return 'skipped';
    if (result && result.success === false) return 'skipped';
    return 'sdk_error';
  }

  /**
   * リワード結果テレメトリを /api/analytics/event に送信。失敗は握りつぶす（UX優先）。
   * @param {string} eventName
   * @param {Object} props - gameId, mode, result, ms, source など
   */
  function sendRewardedTelemetry(eventName, props) {
    if (!API_BASE) return;
    try {
      var gs = getGameIdAndSource();
      var body = JSON.stringify({
        game_id: gs.id,
        event_name: eventName,
        ts: Date.now(),
        props: props && typeof props === 'object' ? props : {}
      });
      fetch(API_BASE + '/api/analytics/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).catch(function () {});
    } catch (_) {}
  }

  /**
   * rewarded_result を同一 run 内で1回だけ送る。telemetrySent が false のときのみ送信して true にする。
   * props: gameId, mode ('pseudo'|'real'), result ('granted'|'skipped'|'sdk_error'), ms, source ('adapter')。
   */
  function sendRewardedTelemetryOnce(props) {
    if (telemetrySent) return;
    telemetrySent = true;
    try {
      sendRewardedTelemetry('rewarded_result', props);
    } catch (_) {}
  }

  function loadConfig() {
    var gid = getGameId();
    if (!API_BASE || !gid) return Promise.resolve();
    return fetch(API_BASE + '/api/ads-config?game=' + encodeURIComponent(gid))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) {
          config.type = data.rewarded === 'on' ? 'rewarded' : 'none';
          config.rewarded = data.rewarded || 'off';
          config.placements = data.placements || {};
        }
      })
      .catch(function () { config.type = 'none'; config.rewarded = 'off'; });
  }

  /**
   * nonce 取得。429 のときはリトライせず reject({ rateLimited: true })。ネットワークエラー時のみ 1 回リトライ。
   * @param {string} [gameIdOverride]
   * @param {number} [attempt]
   */
  function getNonceWithRetry(gameIdOverride, attempt) {
    var gid = (typeof gameIdOverride === 'string' && gameIdOverride.trim()) ? gameIdOverride.trim() : getGameId();
    if (!API_BASE || !gid) return Promise.reject(new Error('no api'));
    var a = typeof attempt === 'number' ? attempt : 0;
    return fetch(API_BASE + '/api/reward/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: gid })
    })
      .then(function (r) {
        if (r.status === 429) return Promise.reject({ rateLimited: true });
        return r.json().then(function (data) { return data && data.nonce ? data.nonce : null; });
      })
      .catch(function (err) {
        if (a < 1 && isNetworkError(err)) return getNonceWithRetry(gid, 1);
        return Promise.reject(err);
      });
  }

  /** @deprecated 内部は getNonceWithRetry を使用 */
  function getNonce(gameIdOverride) {
    return getNonceWithRetry(gameIdOverride, 0);
  }

  /**
   * サーバ verify。429 のときはリトライせず { granted: false, reason: 'rate_limited' }。ネットワークエラー時のみ 1 回リトライ。
   * @returns {Promise<{granted:boolean, reason?: string}>}
   */
  function verifyRewardWithRetry(nonce, token, adNetworkOverride, gameIdOverride, attempt) {
    var gid = (typeof gameIdOverride === 'string' && gameIdOverride.trim()) ? gameIdOverride.trim() : getGameId();
    if (!API_BASE || !gid || !nonce) return Promise.resolve({ granted: false, reason: '' });
    var adNetwork = adNetworkOverride !== undefined ? adNetworkOverride : (token ? 'adsense' : 'pseudo');
    var a = typeof attempt === 'number' ? attempt : 0;
    return fetch(API_BASE + '/api/reward/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: gid,
        nonce: nonce,
        adNetwork: adNetwork,
        token: token || ''
      })
    })
      .then(function (r) {
        if (r.status === 429) return { granted: false, reason: 'rate_limited' };
        return r.json().then(function (data) {
          return { granted: !!(data && data.granted), reason: (data && typeof data.reason === 'string') ? data.reason : '' };
        });
      })
      .catch(function (err) {
        if (a < 1 && isNetworkError(err)) return verifyRewardWithRetry(nonce, token, adNetworkOverride, gameIdOverride, 1);
        return { granted: false, reason: '' };
      });
  }

  /** 後方互換: verifyReward は verifyRewardWithRetry を 1 回呼ぶ。 */
  function verifyReward(nonce, token, adNetworkOverride, gameIdOverride) {
    return verifyRewardWithRetry(nonce, token, adNetworkOverride, gameIdOverride, 0);
  }

  /**
   * 抽象: 広告を表示し、視聴完了時に token を返す。未視聴・キャンセルは null。
   * 【将来SDK差し替え位置】ここだけ実広告SDKを呼び、視聴完了コールバックで resolve(token) する。
   * @returns {Promise<string|null>} token はメモリのみ。localStorage/sessionStorage 使用禁止。
   */
  function showAdAndGetToken() {
    return new Promise(function (resolve) {
      // TODO: 実広告SDK実装箇所。現在はダミーで5秒後に null を返す。
      setTimeout(function () { resolve(null); }, 5000);
    });
  }

  /**
   * 疑似リワード。内部で { success, reason?, was429? } を返し、withTimeout で boolean にまとめる前の結果とする。
   * @returns {Promise<{success: boolean, reason?: string, was429?: boolean}>}
   */
  function runPseudoRewarded() {
    var gid = getGameId();
    return getNonceWithRetry(gid, 0)
      .then(function (nonce) {
        if (!nonce) return { success: false, reason: '' };
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(nonce); }, PSEUDO_LOADING_MS);
        });
      })
      .then(function (nonce) { return verifyRewardWithRetry(nonce, null, undefined, gid, 0); })
      .then(function (r) {
        if (r && r.granted) return { success: true };
        return { success: false, reason: r ? r.reason : '', was429: r && r.reason === 'rate_limited' };
      })
      .catch(function (err) {
        return { success: false, was429: !!(err && err.rateLimited) };
      });
  }

  /**
   * SDK差し替え専用の呼び出しポイント。ここだけ書き換えればよい。
   * placement モード: Google Ad Placement API の adBreak() を使用。
   * simple モード: window.ads.showRewarded() を使用（他SDK向け）。
   * SDK未ロード時は最大2秒ポーリング後 onSkipped()。
   * @param {{ onGranted: function(), onSkipped: function(), onError: function(*) }} callbacks
   */
  function callRewardedSdk(callbacks) {
    var onGranted = callbacks && callbacks.onGranted;
    var onSkipped = callbacks && callbacks.onSkipped;
    var onError = callbacks && callbacks.onError;
    if (typeof onGranted !== 'function') onGranted = function () {};
    if (typeof onSkipped !== 'function') onSkipped = function () {};
    if (typeof onError !== 'function') onError = function () {};
    // ===== SDKマッピング設定（実SDK差し替え時はここだけ変更） =====
    // BAKENEKO_REWARDED_API_TYPE='simple' で simple（window.ads.showRewarded）に切替。未設定時は placement。
    var apiType = (typeof window !== 'undefined' && window.BAKENEKO_REWARDED_API_TYPE === 'simple') ? 'simple' : 'placement';
    var SDK = {
      apiType: apiType,
      placementName: 'support_reward',
      root: 'ads',
      method: 'showRewarded',
      cbComplete: 'onComplete',
      cbClose: 'onClose',
      cbError: 'onError'
    };
    // ===== SDK待ち（最大2秒）・呼び出し =====
    var start = Date.now();
    var MAX_WAIT_MS = 2000;

    function tryStart() {
      try {
        if (!_rewardedDebugLogged && typeof window !== 'undefined') {
          _rewardedDebugLogged = true;
          try {
            console.log('[rewarded-debug]', JSON.stringify({
              apiType: SDK.apiType,
              adBreak: typeof window.adBreak,
              adsbygoogle: typeof window.adsbygoogle,
              isArray: Array.isArray(window.adsbygoogle),
              len: (window.adsbygoogle && window.adsbygoogle.length != null) ? window.adsbygoogle.length : null
            }));
          } catch (_) {}
        }
        if (SDK.apiType === 'placement' && typeof window.adBreak === 'function') {
          var settled = false;
          function onceGranted() { if (settled) return; settled = true; clearTimeout(placementTimer); onGranted(); }
          function onceSkipped() { if (settled) return; settled = true; clearTimeout(placementTimer); onSkipped(); }
          window.adBreak({
            type: 'reward',
            name: SDK.placementName || 'support_reward',
            beforeAd: function () {},
            afterAd: function () {},
            beforeReward: function (showAdFn) { showAdFn(); },
            adViewed: onceGranted,
            adDismissed: onceSkipped,
            adBreakDone: function () { onceSkipped(); }
          });
          var placementTimer = setTimeout(function () { onceSkipped(); }, 8000);
          return;
        }
        var root = window[SDK.root];
        if (root && typeof root[SDK.method] === 'function') {
          var opts = {};
          opts[SDK.cbComplete] = onGranted;
          opts[SDK.cbClose] = onSkipped;
          opts[SDK.cbError] = onError;
          root[SDK.method](opts);
          return;
        }
        if (SDK.apiType === 'simple') {
          var reason = !root ? 'window.ads is missing' : (typeof root[SDK.method] !== 'function' ? 'window.ads.showRewarded is not a function' : '');
          console.warn('[rewarded-adapter] simple: fail', reason);
          onSkipped();
          return;
        }
        if (Date.now() - start >= MAX_WAIT_MS) {
          onSkipped();
          return;
        }
        setTimeout(tryStart, 50);
      } catch (e) {
        onError(e);
      }
    }
    tryStart();
  }

  /**
   * 実広告リワード（コールバック→Promise変換の薄い層）。Promise<boolean>。
   * resolve(true)=完視聴、resolve(false)=スキップ、reject(err)=SDKエラー。
   * 二重コール耐性のため once ガードで一度しか確定しない。
   */
  function runRealRewarded() {
    return new Promise(function (resolve, reject) {
      var done = false;
      function safeResolve(v) { if (done) return; done = true; resolve(v); }
      function safeReject(e) { if (done) return; done = true; reject(e); }
      try {
        callRewardedSdk({
          onGranted: function () { safeResolve(true); },
          onSkipped: function () { safeResolve(false); },
          onError: function (err) { safeReject(err); }
        });
      } catch (e) {
        safeReject(e);
      }
    });
  }

  /**
   * 内部結果オブジェクトをそのまま返す。タイムアウト時は { success: false, timeout: true }。
   * @param {Promise<{success: boolean, reason?: string, was429?: boolean, timeout?: boolean}>} promise
   */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve({ success: false, timeout: true }); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }).catch(function () { clearTimeout(t); resolve({ success: false }); });
    });
  }

  /**
   * 内部: 実/疑似のいずれかをタイムアウト付きで実行。結果オブジェクトを返す。
   * 実広告時は runRealRewarded() の Promise<boolean> を { success } に変換してから withTimeout。
   */
  function internalRunRewarded() {
    var innerPromise = USE_REAL_ADS
      ? runRealRewarded().then(function (granted) { return { success: !!granted }; }).catch(function () { return { success: false }; })
      : runPseudoRewarded();
    return withTimeout(innerPromise, TIMEOUT_MS);
  }

  /** runRewarded 内のみ。公開契約 Promise<boolean> を強制する。boolean はそのまま、object は !!result.granted、それ以外は false。 */
  function normalizeResultToBool(result) {
    if (result === true || result === false) return result;
    if (result && typeof result === 'object') return !!result.granted;
    return false;
  }

  /**
   * リワード広告を表示する（公開API）。実行中は同じ Promise を返す。クールダウン中は即 resolve(false)。
   * 完了時に rewarded_result を analytics/event に必ず1回だけ送信（telemetrySent ガードで二重送信防止）。
   * @returns {Promise<boolean>} 視聴完了かつ付与成功なら true
   */
  function runRewarded() {
    if (inFlightPromise) return inFlightPromise;
    if (Date.now() < cooldownUntil) return Promise.resolve(false);
    telemetrySent = false;
    var startTs = Date.now();
    inFlightPromise = internalRunRewarded()
      .then(function (result) {
        var gs = getGameIdAndSource();
        sendRewardedTelemetryOnce({
          gameId: gs.id,
          mode: USE_REAL_ADS ? 'real' : 'pseudo',
          result: mapResultToStr(result),
          ms: Date.now() - startTs,
          source: 'adapter'
        });
        if (result && result.success) {
          lastFailureCategory = null;
          lastFailureReason = null;
          cooldownUntil = 0;
          return true;
        }
        lastFailureCategory = inferCategory(result);
        lastFailureReason = (result && result.reason) || null;
        cooldownUntil = Date.now() + COOLDOWN_MS;
        return false;
      }, function (err) {
        var gs = getGameIdAndSource();
        sendRewardedTelemetryOnce({
          gameId: gs.id,
          mode: USE_REAL_ADS ? 'real' : 'pseudo',
          result: 'sdk_error',
          ms: Date.now() - startTs,
          source: 'adapter'
        });
        clearInFlight();
        return false;
      })
      .then(function (value) { clearInFlight(); return normalizeResultToBool(value); }, function (err) { clearInFlight(); return normalizeResultToBool(); });
    return inFlightPromise;
  }

  /** 後方互換: showRewardedAd は runRewarded のラッパー */
  function showRewardedAd() {
    return runRewarded().then(function (granted) {
      return { completed: true, granted: granted };
    });
  }

  function isRewardedAvailable() {
    var gid = getGameId();
    if (!USE_REAL_ADS) return !!API_BASE && !!gid;
    return config.rewarded === 'on' && !!gid;
  }

  function getLastFailureCategory() {
    return lastFailureCategory;
  }

  var FAILURE_REASON_ALLOWLIST = [
    'missing_nonce', 'nonexistent_nonce', 'invalid_or_used_nonce', 'game_id_mismatch',
    'attempts_exceeded', 'used_token', 'missing_token', 'verification_failed', 'rate_limited', 'unknown_reason'
  ];

  function getLastFailureReason() {
    var r = lastFailureReason || '';
    if (r && FAILURE_REASON_ALLOWLIST.indexOf(r) !== -1) return r;
    return '';
  }

  function getCooldownRemainingMs() {
    if (cooldownUntil <= 0) return 0;
    return Math.max(0, cooldownUntil - Date.now());
  }

  window.BakenekoAds = {
    runRewarded: runRewarded,
    showRewardedAd: showRewardedAd,
    isRewardedAvailable: isRewardedAvailable,
    loadConfig: loadConfig,
    getPseudoLoadingMs: function () { return PSEUDO_LOADING_MS; },
    isPseudo: function () { return !USE_REAL_ADS; },
    getLastFailureCategory: getLastFailureCategory,
    getLastFailureReason: getLastFailureReason,
    getCooldownRemainingMs: getCooldownRemainingMs
  };
})();
