/**
 * Cloudflare Worker エントリポイント
 * bakeneko-api — ゲーム公開 API + NYAGI 管理 API
 */

import { handleOps } from './ops/router.js';
import {
  generateDailyMedicationLogs,
  checkVaccineDue,
  resetExpiredAlerts,
  generateDailyTasks,
  calculateDailyScores,
  reapplyFeedingPresetsAllLocations,
  autoSkipJstYesterdayRoutinePendingTasks,
  autoClosePendingDays,
  expireNonPresetFeedingPlans,
  ensureFeedingPresets,
} from './ops/cron.js';
import { runNyagiLunchSimpleReportsForAllLocations } from './ops/lunch-simple-report.js';
import { runBackup, cleanupOldBackups } from './ops/backup.js';
import { jstRateLimitMinuteKeyFromInstant, jstAnalyticsHourBucketFromInstant } from './ops/jst-util.js';

var ROUTES = {
  'GET:/api/ads-config': 60,
  'POST:/api/analytics/event': 120,
  'GET:/api/public-stats': 60,
  'POST:/api/support/increment': 30,
  'GET:/api/ranking/leaderboard': 60,
  'POST:/api/ranking/submit': 30,
  'POST:/api/reward/nonce': 30,
  'POST:/api/reward/verify': 60,
  'POST:/api/internal/recompute-public-stats': 10,
};

function getOrigin(req) {
  var o = req.headers.get('Origin');
  if (o) return o;
  var ref = req.headers.get('Referer');
  if (ref) try { return new URL(ref).origin; } catch (_) {}
  return null;
}

function isPrivateOrigin(origin) {
  if (!origin) return false;
  try {
    var u = new URL(origin);
    var h = u.hostname;
    return h === 'localhost' || h === '127.0.0.1' || /^192\.168\./.test(h) || /^10\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[0-2][0-7])\./.test(h);
  } catch (_) { return false; }
}

function isCloudflarePagesPreview(origin) {
  if (!origin) return false;
  try {
    var h = new URL(origin).hostname;
    return h === 'pages.dev' || h.slice(-10) === '.pages.dev';
  } catch (_) {
    return false;
  }
}

function corsHeaders(req, env) {
  var origin = getOrigin(req);
  var allowed = (env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var isAllowed =
    origin && (allowed.includes(origin) || isPrivateOrigin(origin) || isCloudflarePagesPreview(origin));
  var allow = isAllowed ? origin : (allowed[0] || '*');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Staff-Id',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  });
}

function getClientIp(req) {
  return req.headers.get('CF-Connecting-IP') || (req.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || 'unknown';
}

function rateLimitMinuteBucket() {
  return jstRateLimitMinuteKeyFromInstant(Date.now());
}

async function rateLimit(env, ip, routeKey) {
  var limit = ROUTES[routeKey];
  if (!limit || !env.RATE_LIMIT_KV) return { ok: true };
  var bucket = rateLimitMinuteBucket();
  var key = 'rl:' + routeKey + ':' + ip + ':' + bucket;
  var count = parseInt(await env.RATE_LIMIT_KV.get(key) || '0', 10);
  if (count >= limit) return { ok: false };
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 120 });
  return { ok: true };
}

function bucketTs(ts) {
  var ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (isNaN(ms)) ms = Date.now();
  return jstAnalyticsHourBucketFromInstant(ms);
}

function round10(n) {
  if (n <= 0) return 0;
  return Math.max(10, Math.round(n / 10) * 10);
}

async function sha256Hex(str) {
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function callExternalVerification(env, token) {
  var url = (env.REWARD_VERIFY_URL || '').trim();
  if (!url) return false;
  try {
    var c = new AbortController();
    var t = setTimeout(function () { c.abort(); }, VERIFY_EXTERNAL_TIMEOUT_MS);
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token }),
      signal: c.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch (_) { return false; }
}

var IDEMPOTENCY_KV_PREFIX = 'idem:';
var IDEMPOTENCY_TTL = 86400;
var NONCE_TTL = 600;
var NONCE_MAX_ATTEMPTS = 3;
var TOKEN_KV_PREFIX = 't:';
var TOKEN_KV_TTL = 86400;
var VERIFY_EXTERNAL_TIMEOUT_MS = 5000;

var REWARD_VERIFY_REASONS = {
  missing_nonce: 1, nonexistent_nonce: 1, invalid_or_used_nonce: 1,
  game_id_mismatch: 1, attempts_exceeded: 1, used_token: 1,
  missing_token: 1, verification_failed: 1, unknown_reason: 1,
};

function logRewardVerifyOutcome(outcome, reason) {
  var safeReason = outcome === 'success' ? '' : (typeof reason === 'string' && REWARD_VERIFY_REASONS[reason] ? reason : 'unknown_reason');
  console.warn(JSON.stringify({ event: 'reward_verify', outcome: outcome, reason: safeReason }));
}

export default {
  async scheduled(event, env, ctx) {
    try {
      var adminKey = (env.ADMIN_KEY || '').trim();
      // ADMIN_KEY は再計算専用。未設定でも return しない（14時昼レポート等の他 Cron が止まるため）。
      if (adminKey) {
        var req = new Request('https://api.bakenekocafe.studio/api/internal/recompute-public-stats', {
          method: 'POST',
          headers: { 'X-Admin-Key': adminKey },
        });
        var url = new URL(req.url);
        await handleRecomputePublicStats(req, env, url);
      }
    } catch (e) {
      console.warn('scheduled recompute error:', e && e.message);
    }

    /** JST 14:00（UTC 05:00）— NYAGI 昼の簡易 Slack（排尿・ケア穴・連続スキップ＋こはだ） */
    if (event.cron === '0 5 * * *' && env.OPS_DB) {
      try {
        console.log(JSON.stringify({ event: 'scheduled_nyagi_lunch_cron', cron: event.cron }));
        await runNyagiLunchSimpleReportsForAllLocations(env, env.OPS_DB);
      } catch (e) {
        console.warn('runNyagiLunchSimpleReportsForAllLocations:', e && e.message);
      }
    }

    if (event.cron === '0 20 * * *' && env.OPS_DB) {
      try { await expireNonPresetFeedingPlans(env.OPS_DB); } catch (e) { console.warn('expireNonPresetFeedingPlans (morning) error:', e && e.message); }
      try { await autoSkipJstYesterdayRoutinePendingTasks(env.OPS_DB); } catch (e) { console.warn('autoSkipJstYesterdayRoutinePendingTasks error:', e && e.message); }
      try { await generateDailyTasks(env.OPS_DB); } catch (e) { console.warn('generateDailyTasks error:', e && e.message); }
      try { await generateDailyMedicationLogs(env.OPS_DB); } catch (e) { console.warn('generateDailyMedicationLogs error:', e && e.message); }
      try { await ensureFeedingPresets(env.OPS_DB); } catch (e) { console.warn('ensureFeedingPresets error:', e && e.message); }
      if (env.NYAGI_FILES) {
        try {
          var bkResult = await runBackup(env.OPS_DB, env.NYAGI_FILES);
          console.log('daily backup: ' + bkResult.key + ' (' + bkResult.total_rows + ' rows, ' + bkResult.size_bytes + ' bytes)');
          var cleanup = await cleanupOldBackups(env.NYAGI_FILES);
          if (cleanup.deleted_count > 0) console.log('backup cleanup: deleted ' + cleanup.deleted_count + ' old backups');
        } catch (e) { console.warn('daily backup error:', e && e.message); }
      }
    }

    if (event.cron === '0 15 * * *' && env.OPS_DB) {
      try { await expireNonPresetFeedingPlans(env.OPS_DB); } catch (e) { console.warn('expireNonPresetFeedingPlans error:', e && e.message); }
      try { await autoClosePendingDays(env.OPS_DB, env); } catch (e) { console.warn('autoClosePendingDays error:', e && e.message); }
    }

    if (event.cron === '0 23 * * *' && env.OPS_DB) {
      try { await checkVaccineDue(env.OPS_DB, env); } catch (e) { console.warn('checkVaccineDue error:', e && e.message); }
      try { await resetExpiredAlerts(env.OPS_DB); } catch (e) { console.warn('resetExpiredAlerts error:', e && e.message); }
      try { await calculateDailyScores(env.OPS_DB, env); } catch (e) { console.warn('calculateDailyScores error:', e && e.message); }
    }
  },

  async fetch(req, env, ctx) {
    try {
      var url = new URL(req.url);
      var path = url.pathname;
      var method = req.method;

      if (method === 'OPTIONS') {
        if (path === '/api/internal/recompute-public-stats') {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 204, headers: corsHeaders(req, env) });
      }

      if (path === '/favicon.ico' || path === '/robots.txt' || path === '/' || path === '/index.html') {
        if (path === '/robots.txt') {
          return new Response('User-agent: *\nDisallow: /\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
        return new Response(null, { status: 204 });
      }

      if (path.indexOf('/api/ops') === 0) {
        var opsRes = await handleOps(req, env, url, ctx);
        var opsHeaders = Object.assign({}, corsHeaders(req, env), Object.fromEntries(opsRes.headers));
        return new Response(opsRes.body, { status: opsRes.status, headers: opsHeaders });
      }

      var routeKey = method + ':' + path;
      var ip = getClientIp(req);
      var rl = { ok: true };
      try { rl = await rateLimit(env, ip, routeKey); } catch (rlErr) { console.warn('rateLimit error (skipped):', rlErr && rlErr.message); }
      if (!rl.ok) {
        console.warn(JSON.stringify({ event: 'rate_limit', route: routeKey }));
        return json({ ok: false, error: 'rate_limited' }, 429, corsHeaders(req, env));
      }

      var res;
      try {
        if (method === 'GET' && path === '/api/ads-config') {
          res = await handleAdsConfig(req, env, url);
        } else if (method === 'POST' && path === '/api/analytics/event') {
          res = await handleAnalyticsEvent(req, env);
        } else if (method === 'GET' && path === '/api/public-stats') {
          res = await handlePublicStats(req, env, url);
        } else if (method === 'POST' && path === '/api/support/increment') {
          res = await handleSupportIncrement(req, env);
        } else if (method === 'POST' && path === '/api/reward/nonce') {
          res = await handleRewardNonce(req, env);
        } else if (method === 'POST' && path === '/api/reward/verify') {
          res = await handleRewardVerify(req, env);
        } else if (method === 'GET' && path === '/api/ranking/leaderboard') {
          res = await handleRankingLeaderboard(req, env, url);
        } else if (method === 'POST' && path === '/api/ranking/submit') {
          res = await handleRankingSubmit(req, env);
        } else if (method === 'POST' && path === '/api/internal/recompute-public-stats') {
          res = await handleRecomputePublicStats(req, env, url);
        } else {
          res = json({ error: 'not_found', message: 'Not Found' }, 404);
        }
      } catch (e) {
        console.warn('handler_error', path, e && e.message, e && e.stack);
        res = json({ error: 'internal', message: 'Internal error' }, 500);
      }

      var resHeaders = Object.fromEntries(res.headers);
      var outHeaders = (path === '/api/internal/recompute-public-stats') ? resHeaders : Object.assign({}, corsHeaders(req, env), resHeaders);
      return new Response(res.body, { status: res.status, headers: outHeaders });
    } catch (fatal) {
      console.error('FATAL:', fatal && fatal.message, fatal && fatal.stack);
      return new Response(JSON.stringify({ error: 'fatal', message: (fatal && fatal.message) || 'Unknown' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};

async function handleAdsConfig(req, env, url) {
  var gameId = url.searchParams.get('game') || url.searchParams.get('gameId') || '';
  if (!gameId) return json({ error: 'bad_request', message: 'game required' }, 400);
  var config = { banner: 'off', rewarded: 'off', placements: {} };
  if (env.ADS_CONFIG_KV) {
    var raw = await env.ADS_CONFIG_KV.get('ads:' + gameId);
    if (raw) try { config = Object.assign({}, config, JSON.parse(raw)); } catch (_) {}
  }
  return json(config, 200, { 'Cache-Control': 'public, max-age=60' });
}

async function handleAnalyticsEvent(req, env) {
  var body;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request', message: 'Invalid JSON' }, 400); }
  var game_id = body && body.game_id;
  var session_id = body && body.session_id;
  var event_name = body && body.event_name;
  var ts = body && body.ts;
  var props = body && body.props;
  if (!game_id || !event_name) return json({ error: 'bad_request', message: 'game_id and event_name required' }, 400);
  var ip = getClientIp(req);
  var t = typeof ts === 'number' ? ts : Date.now();
  var bucket = bucketTs(t);
  var dedupKey = 'ev:' + (session_id || ip) + ':' + event_name + ':' + bucket;
  if (env.DB) {
    var dedupRow = await env.DB.prepare('SELECT 1 FROM analytics_dedup WHERE dedup_key = ?').bind(dedupKey).first();
    if (dedupRow) return json({ ok: true });
    await env.DB.prepare('INSERT INTO analytics_dedup (dedup_key, created_at) VALUES (?, ?)').bind(dedupKey, new Date().toISOString()).run();
    await env.DB.prepare(
      'INSERT INTO analytics_buckets (game_id, event_name, bucket_ts, count) VALUES (?, ?, ?, 1) ON CONFLICT(game_id, event_name, bucket_ts) DO UPDATE SET count = count + 1'
    ).bind(game_id, event_name, bucket).run();
    try {
      var eventId = crypto.randomUUID();
      var propsJson = (typeof props === 'object' && props !== null) ? JSON.stringify(props) : '{}';
      await env.DB.prepare(
        'INSERT INTO analytics_events (id, ts, game_id, session_id, event_name, props_json) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(eventId, t, game_id, session_id || '', event_name, propsJson).run();
    } catch (_) {}
  }
  return json({ ok: true });
}

async function handlePublicStats(req, env, url) {
  var gameId = (url.searchParams.get('game') || url.searchParams.get('gameId') || '').trim();
  var safe = { todaySupportCount: 0, totalSupportCount: 0, totalPv: 0, todayPv: 0, totalPlays: 0, totalRewards: 0, totalBannerClicks: 0 };
  if (env.DB) {
    var rows;
    if (gameId) {
      rows = await env.DB.prepare('SELECT metric, value FROM public_stats WHERE game_id = ?').bind(gameId).all();
    } else {
      rows = await env.DB.prepare('SELECT metric, SUM(value) AS value FROM public_stats GROUP BY metric').all();
    }
    for (var ri = 0; ri < (rows.results || []).length; ri++) {
      var row = rows.results[ri];
      var v = row.value != null ? Number(row.value) : 0;
      if (row.metric === 'todaySupportCount') safe.todaySupportCount = Math.max(0, Math.round(v));
      else if (row.metric === 'totalSupportCount') safe.totalSupportCount = Math.max(0, Math.round(v));
      else if (row.metric === 'totalPv') safe.totalPv = Math.max(0, Math.round(v));
      else if (row.metric === 'todayPv') safe.todayPv = Math.max(0, Math.round(v));
      else if (row.metric === 'totalPlays') safe.totalPlays = round10(v);
      else if (row.metric === 'totalRewards') safe.totalRewards = round10(v);
      else if (row.metric === 'totalBannerClicks') safe.totalBannerClicks = round10(v);
    }
    if (gameId) {
      try {
        var countRow = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM ranking WHERE game_id = ?').bind(gameId).first();
        if (countRow && Number(countRow.cnt) > safe.totalPlays) safe.totalPlays = Number(countRow.cnt);
      } catch (_) {}
    }
  }
  return json(safe, 200, { 'Cache-Control': 'public, max-age=300' });
}

async function handleSupportIncrement(req, env) {
  var body;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request', message: 'Invalid JSON' }, 400, corsHeaders(req, env)); }
  var gameId = (body && body.gameId || '').trim();
  var idempotencyKey = (body && body.idempotency_key || '').trim();
  if (!gameId) return json({ error: 'bad_request', message: 'gameId required' }, 400, corsHeaders(req, env));
  if (idempotencyKey && env.IDEMPOTENCY_KV) {
    var kvKey = IDEMPOTENCY_KV_PREFIX + idempotencyKey;
    var stored = await env.IDEMPOTENCY_KV.get(kvKey);
    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'support_increment_replay', gameId: gameId }));
        return json(Object.assign({}, parsed, { idempotency_replay: true }), 200, corsHeaders(req, env));
      } catch (_) {}
    }
  }
  if (!env.DB) {
    var resp2 = { todaySupportCount: 0, totalSupportCount: 0 };
    if (idempotencyKey && env.IDEMPOTENCY_KV) {
      await env.IDEMPOTENCY_KV.put(IDEMPOTENCY_KV_PREFIX + idempotencyKey, JSON.stringify(resp2), { expirationTtl: IDEMPOTENCY_TTL });
    }
    return json(resp2, 200, corsHeaders(req, env));
  }
  var now = new Date();
  var todayInt = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  var updatedAt = now.toISOString();
  var pRows = await env.DB.prepare('SELECT metric, value FROM public_stats WHERE game_id = ?').bind(gameId).all();
  var todaySupportCount = 0, totalSupportCount = 0, supportDate = 0;
  for (var si = 0; si < (pRows.results || []).length; si++) {
    var sr = pRows.results[si];
    var sv = Number(sr.value) || 0;
    if (sr.metric === 'todaySupportCount') todaySupportCount = Math.max(0, Math.round(sv));
    else if (sr.metric === 'totalSupportCount') totalSupportCount = Math.max(0, Math.round(sv));
    else if (sr.metric === 'supportDate') supportDate = Math.round(sv);
  }
  if (supportDate < todayInt) todaySupportCount = 0;
  todaySupportCount += 1;
  totalSupportCount += 1;
  var upsert = 'INSERT INTO public_stats (game_id, metric, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(game_id, metric) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
  await env.DB.prepare(upsert).bind(gameId, 'todaySupportCount', todaySupportCount, updatedAt).run();
  await env.DB.prepare(upsert).bind(gameId, 'totalSupportCount', totalSupportCount, updatedAt).run();
  await env.DB.prepare(upsert).bind(gameId, 'supportDate', todayInt, updatedAt).run();
  var resp = { todaySupportCount: todaySupportCount, totalSupportCount: totalSupportCount };
  if (idempotencyKey && env.IDEMPOTENCY_KV) {
    await env.IDEMPOTENCY_KV.put(IDEMPOTENCY_KV_PREFIX + idempotencyKey, JSON.stringify(resp), { expirationTtl: IDEMPOTENCY_TTL });
  }
  return json(resp, 200, corsHeaders(req, env));
}

async function handleRankingLeaderboard(req, env, url) {
  var gameId = (url.searchParams.get('gameId') || url.searchParams.get('game') || '').trim();
  if (!gameId) return json({ error: 'bad_request', message: 'gameId required' }, 400);
  var limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  var offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  if (!env.DB) return json({ entries: [] }, 200);
  var rows = await env.DB.prepare(
    'SELECT nickname, score, submitted_at FROM ranking WHERE game_id = ? ORDER BY score DESC LIMIT ? OFFSET ?'
  ).bind(gameId, limit, offset).all();
  var entries = (rows.results || []).map(function (row, i) {
    return { rank: offset + i + 1, nickname: row.nickname || '', score: Number(row.score) || 0, submitted_at: row.submitted_at || '' };
  });
  return json({ entries: entries }, 200, { 'Cache-Control': 'public, max-age=30' });
}

async function handleRankingSubmit(req, env) {
  var body;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request', message: 'Invalid JSON' }, 400); }
  var gameId = (body && body.gameId) || '';
  var nickname = (body && body.nickname) || '';
  var score = typeof (body && body.score) === 'number' ? body.score : parseInt(body && body.score, 10);
  if (!gameId) return json({ error: 'bad_request', message: 'gameId required' }, 400);
  if (!Number.isFinite(score) || score < 0 || score > 999999999) return json({ error: 'bad_request', message: 'score must be 0..999999999' }, 400);
  var safeNickname = String(nickname).slice(0, 32).trim() || 'anonymous';
  var submittedAt = new Date().toISOString();
  if (!env.DB) return json({ ok: true, rank: 1 }, 200);
  var cutoff = new Date(Date.now() - 60000).toISOString();
  var dup = await env.DB.prepare(
    'SELECT id FROM ranking WHERE game_id = ? AND nickname = ? AND score = ? AND submitted_at > ? LIMIT 1'
  ).bind(gameId, safeNickname, score, cutoff).first();
  if (dup) {
    var rankRow2 = await env.DB.prepare('SELECT COUNT(*) + 1 AS r FROM ranking WHERE game_id = ? AND score > ?').bind(gameId, score).first();
    var rank2 = (rankRow2 && Number.isFinite(rankRow2.r)) ? Number(rankRow2.r) : 1;
    return json({ ok: true, rank: rank2, deduplicated: true }, 200);
  }
  var id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO ranking (id, game_id, nickname, score, submitted_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, gameId, safeNickname, score, submittedAt).run();
  var rankRow = await env.DB.prepare('SELECT COUNT(*) + 1 AS r FROM ranking WHERE game_id = ? AND score > ?').bind(gameId, score).first();
  var rank = (rankRow && Number.isFinite(rankRow.r)) ? Number(rankRow.r) : 1;
  return json({ ok: true, rank: rank }, 200);
}

async function handleRecomputePublicStats(req, env, url) {
  var expected = (env.ADMIN_KEY || '').trim();
  var headerKey = (req.headers.get('X-Admin-Key') || '').trim();
  var queryKey = (url.searchParams.get('key') || '').trim();
  var isDev = env.ENV === 'dev' || expected.startsWith('dev-');
  var provided = headerKey || (isDev ? queryKey : '');
  if (!expected || provided !== expected) return json({ error: 'unauthorized', message: 'Invalid or missing admin key' }, 401);
  if (!env.DB) return json({ ok: false, message: 'DB not bound' }, 503);
  try {
    var byGame = {};
    function ensure(gameId) {
      if (!byGame[gameId]) byGame[gameId] = { totalPv: 0, todayPv: 0, totalPlays: 0, totalRewards: 0, totalBannerClicks: 0 };
      return byGame[gameId];
    }
    function addAll(gameId, eventName, total) {
      var g = ensure(gameId);
      if (eventName === 'game_start' || eventName === 'page_view') g.totalPv += total;
      if (eventName === 'game_start') g.totalPlays += total;
      if (eventName === 'reward_granted') g.totalRewards += total;
      if (eventName === 'banner_click') g.totalBannerClicks += total;
    }
    function addToday(gameId, eventName, total) {
      var g = ensure(gameId);
      if (eventName === 'game_start' || eventName === 'page_view') g.todayPv += total;
    }
    var now = new Date();
    var bucket24hAgo = bucketTs(now.getTime() - 24 * 60 * 60 * 1000);
    var allRows = await env.DB.prepare('SELECT game_id, event_name, SUM(count) AS total FROM analytics_buckets GROUP BY game_id, event_name').all();
    var last24Rows = await env.DB.prepare('SELECT game_id, event_name, SUM(count) AS total FROM analytics_buckets WHERE bucket_ts >= ? GROUP BY game_id, event_name').bind(bucket24hAgo).all();
    for (var ai = 0; ai < (allRows.results || []).length; ai++) {
      var ar = allRows.results[ai];
      addAll(ar.game_id, ar.event_name, Number(ar.total) || 0);
    }
    for (var ti = 0; ti < (last24Rows.results || []).length; ti++) {
      var tr2 = last24Rows.results[ti];
      addToday(tr2.game_id, tr2.event_name, Number(tr2.total) || 0);
    }
    var updatedAt = now.toISOString();
    var upsertSql = 'INSERT INTO public_stats (game_id, metric, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(game_id, metric) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
    var gameIds = Object.keys(byGame);
    for (var gi = 0; gi < gameIds.length; gi++) {
      var gid = gameIds[gi];
      var g = byGame[gid];
      await env.DB.prepare(upsertSql).bind(gid, 'totalPv', Math.max(0, Math.round(g.totalPv)), updatedAt).run();
      await env.DB.prepare(upsertSql).bind(gid, 'todayPv', Math.max(0, Math.round(g.todayPv)), updatedAt).run();
      await env.DB.prepare(upsertSql).bind(gid, 'totalPlays', round10(g.totalPlays), updatedAt).run();
      await env.DB.prepare(upsertSql).bind(gid, 'totalRewards', round10(g.totalRewards), updatedAt).run();
      await env.DB.prepare(upsertSql).bind(gid, 'totalBannerClicks', round10(g.totalBannerClicks), updatedAt).run();
    }
    return json({ ok: true, updated: gameIds.length }, 200);
  } catch (e) {
    if (!env.LOG_PII) console.warn('recompute_error', e && e.message);
    return json({ error: 'internal', message: 'Recompute failed' }, 500);
  }
}

async function handleRewardNonce(req, env) {
  var body;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request', message: 'Invalid JSON' }, 400); }
  var gameId = (body && body.gameId) || '';
  if (!gameId) return json({ error: 'bad_request', message: 'gameId required' }, 400);
  var nonce = crypto.randomUUID();
  if (env.NONCE_KV) {
    var value = { gameId: gameId, createdAt: new Date().toISOString(), attempts: 0 };
    await env.NONCE_KV.put(nonce, JSON.stringify(value), { expirationTtl: NONCE_TTL });
  }
  return json({ nonce: nonce, ttl: NONCE_TTL });
}

async function handleRewardVerify(req, env) {
  var body;
  try { body = await req.json(); } catch (_) { return json({ error: 'bad_request', message: 'Invalid JSON' }, 400); }
  var gameId = ((body && body.gameId) || '').trim();
  var nonce = ((body && body.nonce) || '').trim();
  var token = (typeof (body && body.token) === 'string') ? body.token : '';
  if (!nonce) {
    if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'fail', reason: 'missing_nonce' }));
    logRewardVerifyOutcome('fail', 'missing_nonce');
    return json({ granted: false, reason: 'missing_nonce' }, 200);
  }
  if (!env.NONCE_KV) {
    var granted = env.PSEUDO_VERIFY_MODE === 'true' || !!env.PSEUDO_VERIFY_MODE;
    logRewardVerifyOutcome(granted ? 'success' : 'fail', granted ? undefined : 'missing_nonce');
    return json({ granted: granted, reason: granted ? undefined : 'missing_nonce' }, 200);
  }
  var raw = await env.NONCE_KV.get(nonce);
  if (!raw) {
    if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'fail', reason: 'nonexistent_nonce' }));
    logRewardVerifyOutcome('fail', 'nonexistent_nonce');
    return json({ granted: false, reason: 'nonexistent_nonce' }, 200);
  }
  var data;
  try { data = JSON.parse(raw); } catch (_) {
    if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'fail', reason: 'invalid_nonce' }));
    logRewardVerifyOutcome('fail', 'invalid_or_used_nonce');
    return json({ granted: false, reason: 'invalid_or_used_nonce' }, 200);
  }
  if (data.gameId !== gameId) {
    if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'fail', reason: 'game_id_mismatch' }));
    logRewardVerifyOutcome('fail', 'game_id_mismatch');
    return json({ granted: false, reason: 'game_id_mismatch' }, 200);
  }
  var attempts = (typeof data.attempts === 'number') ? data.attempts : 0;
  if (attempts >= NONCE_MAX_ATTEMPTS) {
    if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'fail', reason: 'attempts_exceeded' }));
    logRewardVerifyOutcome('fail', 'attempts_exceeded');
    return json({ granted: false, reason: 'attempts_exceeded' }, 200);
  }
  var pseudoMode = env.PSEUDO_VERIFY_MODE === 'true' || !!env.PSEUDO_VERIFY_MODE;
  if (token && env.TOKEN_KV) {
    var tokenHash = await sha256Hex(token);
    var tokenKey = TOKEN_KV_PREFIX + tokenHash;
    var used = await env.TOKEN_KV.get(tokenKey);
    if (used) {
      if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'fail', reason: 'used_token' }));
      logRewardVerifyOutcome('fail', 'used_token');
      return json({ granted: false, reason: 'used_token' }, 200);
    }
  }
  var verificationOk = false;
  if (pseudoMode) {
    verificationOk = true;
  } else {
    if (!token) {
      if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'fail', reason: 'missing_token' }));
      logRewardVerifyOutcome('fail', 'missing_token');
      return json({ granted: false, reason: 'missing_token' }, 200);
    }
    verificationOk = await callExternalVerification(env, token);
    if (!verificationOk) {
      var elapsed = Math.floor((Date.now() - new Date(data.createdAt).getTime()) / 1000);
      var remainingTtl = Math.max(60, NONCE_TTL - elapsed);
      data.attempts = attempts + 1;
      await env.NONCE_KV.put(nonce, JSON.stringify(data), { expirationTtl: remainingTtl });
      if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'fail', reason: 'verification_failed' }));
      logRewardVerifyOutcome('fail', 'verification_failed');
      return json({ granted: false, reason: 'verification_failed' }, 200);
    }
  }
  await env.NONCE_KV.delete(nonce);
  if (token && env.TOKEN_KV) {
    var tokenHash2 = await sha256Hex(token);
    await env.TOKEN_KV.put(TOKEN_KV_PREFIX + tokenHash2, '1', { expirationTtl: TOKEN_KV_TTL });
  }
  if (!env.LOG_PII) console.warn(JSON.stringify({ event: 'verify', outcome: 'success' }));
  logRewardVerifyOutcome('success', undefined);
  return json({ granted: true }, 200);
}
