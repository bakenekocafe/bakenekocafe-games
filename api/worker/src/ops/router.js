/**
 * NYAGI ops ルーター
 *
 * /api/ops/* へのリクエストをモジュール別ハンドラに振り分ける。
 * 全リクエストで ADMIN_KEY + staff 認証を要求。
 */

import { authenticateStaff, loginByPassword } from './auth.js';
import { handleIntakePublic } from './intake-public.js';
import { handleIntakeAdmin } from './intake-admin.js';
import { handleInquiryPublic } from './inquiry-public.js';
import { handleInquiryAdmin } from './inquiry-admin.js';
import { handleCats } from './cats.js';
import { handleHealth } from './health.js';
import { handleVoice } from './voice.js';
import { handleDashboard, handleCatTimeline, handleCatsOverview } from './dashboard.js';
import { handleTasks } from './tasks.js';
import { handleFeeding } from './feeding.js';
import { handleHealthScores } from './health-score.js';
import { handleCatNotes, handleSignedCatNoteAttachment } from './cat-notes.js';
import { handleStaff } from './staff.js';
import { handleBulletin } from './bulletin.js';
import { handleThreadComments } from './thread-comments.js';
import { generateDailyMedicationLogs, checkVaccineDue, resetExpiredAlerts, generateDailyTasks, calculateDailyScores, reapplyFeedingPresetsAllLocations } from './cron.js';
import { runBackup, cleanupOldBackups, listBackups } from './backup.js';
import { runNyagiLunchSimpleReportsForAllLocations } from './lunch-simple-report.js';

/**
 * @param {Request} req
 * @param {object} env
 * @param {URL} url
 * @param {ExecutionContext} [ctx] — waitUntil 用（業務終了の Slack を HTTP 応答後に継続する等）
 * @returns {Promise<Response>}
 */
export async function handleOps(req, env, url, ctx) {
  var method = req.method;
  var path = url.pathname;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  var subPath = path.replace('/api/ops', '');

  // ログイン: 4桁パスワードのみ（Admin Key はクライアント設定から送信）
  if (subPath === '/auth/login' && method === 'POST') {
    var loginResult = await loginByPassword(req, env);
    if (!loginResult) {
      return opsJson({ error: 'unauthorized', message: 'パスワードが正しくありません' }, 401);
    }
    return opsJson({
      staffId: loginResult.staffId,
      name: loginResult.name,
      role: loginResult.role,
      locationId: loginResult.locationId,
    });
  }

  // 引き受け申請: 外部ユーザー向け（スタッフ認証不要）
  if (subPath.indexOf('/intake-public') === 0) {
    var intakePublicSub = subPath.replace('/intake-public', '') || '/';
    return await handleIntakePublic(req, env, url, intakePublicSub);
  }

  // 問い合わせ管理: 外部ユーザー向け（スタッフ認証不要）
  if (subPath.indexOf('/inquiry-public') === 0) {
    return await handleInquiryPublic(req, env, url, subPath.replace('/inquiry-public', '') || '/');
  }

  // 署名付き添付配信（Slack unfurl 用・認証不要・署名で検証）
  if (subPath === '/signed-attachment' && method === 'GET') {
    return await handleSignedCatNoteAttachment(env, url);
  }

  var staffAuth = await authenticateStaff(req, env);
  if (!staffAuth) {
    return opsJson({ error: 'unauthorized', message: 'Invalid credentials' }, 401);
  }

  try {
    // /api/ops/cats/overview → 項目別全猫横断カードビュー
    if (subPath === '/cats/overview') {
      return await handleCatsOverview(req, env, url, staffAuth);
    }

    // /api/ops/cats/:id/timeline → 猫詳細タイムライン（dashboard.js）
    var timelineMatch = subPath.match(/^\/cats\/([^/]+)\/timeline$/);
    if (timelineMatch) {
      return await handleCatTimeline(req, env, url, staffAuth, decodeURIComponent(timelineMatch[1]));
    }

    if (subPath.indexOf('/cats') === 0) {
      var catsSubPath = subPath.replace('/cats', '');
      try { catsSubPath = decodeURIComponent(catsSubPath); } catch (_) {}
      return await handleCats(req, env, url, staffAuth, catsSubPath);
    }
    if (subPath.indexOf('/health-scores') === 0) {
      return await handleHealthScores(req, env, url, staffAuth, subPath.replace('/health-scores', ''));
    }
    if (subPath.indexOf('/health') === 0) {
      return await handleHealth(req, env, url, staffAuth, subPath.replace('/health', ''));
    }
    if (subPath.indexOf('/voice') === 0) {
      return await handleVoice(req, env, url, staffAuth, subPath.replace('/voice', ''));
    }
    if (subPath.indexOf('/dashboard') === 0) {
      return await handleDashboard(req, env, url, staffAuth, subPath.replace('/dashboard', ''));
    }
    if (subPath.indexOf('/tasks') === 0) {
      return await handleTasks(req, env, url, staffAuth, subPath.replace('/tasks', ''), ctx);
    }
    if (subPath.indexOf('/feeding') === 0) {
      return await handleFeeding(req, env, url, staffAuth, subPath.replace('/feeding', ''));
    }
    if (subPath.indexOf('/cat-notes') === 0) {
      return await handleCatNotes(req, env, url, staffAuth, subPath.replace('/cat-notes', ''));
    }
    if (subPath.indexOf('/bulletin') === 0) {
      return await handleBulletin(req, env, url, staffAuth, subPath.replace('/bulletin', '') || '/');
    }
    if (subPath.indexOf('/thread-comments') === 0) {
      return await handleThreadComments(req, env, url, staffAuth, subPath.replace('/thread-comments', '') || '/');
    }
    if (subPath.indexOf('/staff') === 0) {
      return await handleStaff(req, env, url, staffAuth, subPath.replace('/staff', '') || '/');
    }
    if (subPath.indexOf('/intake-admin') === 0) {
      return await handleIntakeAdmin(req, env, url, staffAuth, subPath.replace('/intake-admin', '') || '/');
    }
    if (subPath.indexOf('/inquiry-admin') === 0) {
      return await handleInquiryAdmin(req, env, url, staffAuth, subPath.replace('/inquiry-admin', '') || '/');
    }

    if (subPath === '/backup' && method === 'POST' && env.NYAGI_FILES) {
      var bk = await runBackup(env.OPS_DB, env.NYAGI_FILES);
      var cl = await cleanupOldBackups(env.NYAGI_FILES);
      return opsJson({ ok: true, backup: bk, cleanup: cl });
    }
    if (subPath === '/backup' && method === 'GET' && env.NYAGI_FILES) {
      var backups = await listBackups(env.NYAGI_FILES);
      return opsJson({ ok: true, backups: backups, count: backups.length });
    }

    /** 手動検証用: 昼簡易 Slack を即時実行（本番 Cron と同じ処理・IDEMPOTENCY_KV で同日再送は抑止） */
    if ((subPath === '/lunch-simple-report/trigger' || subPath === '/lunch-simple-report/trigger/') && method === 'POST') {
      if (!env.OPS_DB) return opsJson({ error: 'no_ops_db', message: 'OPS_DB not bound' }, 503);
      var lunchRes = await runNyagiLunchSimpleReportsForAllLocations(env, env.OPS_DB);
      return opsJson(lunchRes);
    }

    if (subPath === '/run-cron' && method === 'POST') {
      var db = env.OPS_DB;
      var results = [];
      try { await generateDailyMedicationLogs(db); results.push('medication_logs: ok'); } catch (e) { results.push('medication_logs: ' + (e.message || 'error')); }
      try { await checkVaccineDue(db, env); results.push('vaccine_check: ok'); } catch (e) { results.push('vaccine_check: ' + (e.message || 'error')); }
      try { await resetExpiredAlerts(db); results.push('reset_alerts: ok'); } catch (e) { results.push('reset_alerts: ' + (e.message || 'error')); }
      try { await generateDailyTasks(db); results.push('daily_tasks: ok'); } catch (e) { results.push('daily_tasks: ' + (e.message || 'error')); }
      try { var cnt = await calculateDailyScores(db, env); results.push('health_scores: ok (' + cnt + ' cats)'); } catch (e) { results.push('health_scores: ' + (e.message || 'error')); }
      try {
        var pr = await reapplyFeedingPresetsAllLocations(db);
        results.push('feeding_preset_reapply: ok (' + (pr.applied || 0) + ' cats)');
      } catch (e) {
        results.push('feeding_preset_reapply: ' + (e.message || 'error'));
      }
      return opsJson({ ok: true, results: results });
    }

    return opsJson({ error: 'not_found', message: 'Unknown ops endpoint' }, 404);
  } catch (e) {
    console.error('ops handler error:', path, e?.message, e?.stack);
    // デバッグ用: 開発環境ではエラー詳細を返す
    if (env.ENV === 'dev' || env.PSEUDO_VERIFY_MODE === 'true') {
      return opsJson({ error: 'internal', message: 'Internal error', debug: e?.message, stack: e?.stack?.slice(0, 500) }, 500);
    }
    return opsJson({ error: 'internal', message: 'Internal error' }, 500);
  }
}

export function opsJson(body, status) {
  /** ブラウザのヒューリスティックキャッシュで古い JSON が返るのを防ぐ（NYAGI 管理画面の「反映されない」対策） */
  /** D1 が INTEGER を bigint で返すことがあり、JSON.stringify が例外→500 になるのを防ぐ */
  var json;
  try {
    json = JSON.stringify(body, function (_k, v) {
      if (typeof v === 'bigint') return Number(v);
      if (v !== v || v === Infinity || v === -Infinity) return null;
      return v;
    });
  } catch (serErr) {
    console.error('opsJson stringify failed:', serErr && serErr.message);
    json = JSON.stringify({
      error: 'internal',
      message: 'Internal error',
      debug: serErr && serErr.message ? String(serErr.message) : 'serialize',
    });
    status = 500;
  }
  return new Response(json, {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'CDN-Cache-Control': 'no-store',
    },
  });
}
