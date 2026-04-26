/**
 * NYAGI ダッシュボードハンドラ（P3 + P5 + P5.5 実装）
 *
 * GET /api/ops/dashboard/morning-urine-pending?location=cafe → 本日JST・排尿未記録の在籍猫（朝ダッシュと同一集計・タスク画面ガード用）
 * GET /api/ops/dashboard/morning?location=cafe  → 朝チェック用データ
 * GET /api/ops/dashboard/evening?location=cafe  → 夕チェック用データ
 * GET /api/ops/dashboard/actions               → 未完了アクション一覧
 * GET /api/ops/cats/:id/timeline?limit=50      → 猫詳細タイムライン
 * GET /api/ops/cats/overview?location=cafe     → 項目別全猫横断カードビュー
 */

import { opsJson } from './router.js';
import {
  collectPresetIdsOrdered,
  resolvePresetDisplayNameDescription,
  fetchPresetDisplayMaps,
} from './feeding-preset-display.js';
import { calculateHealthScore } from './health-score.js';
import {
  buildCloseDayCareItemGaps,
  LOCATION_LABELS,
  filterTaskRowsByTemplateRecurrence,
  SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_NO_ALIAS,
  SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_ALIAS_T,
} from './tasks.js';
import {
  jstCalendarAddDays,
  jstCalendarYmdFromInstant,
  jstCalendarYmdFromParsedIso,
  jstHmFromParsedIso,
} from './jst-util.js';
import { buildIaTimelinePayload } from './cat-ia-records.js';
import {
  batchAnalyzeFoodPreference,
  summarizeFoodPreferences,
  fetchFoodPreferenceCoverageBatch,
  FOOD_PREF_LOOKBACK_DAYS,
} from './nutrition.js';
import { shouldGenerateForDay } from './health.js';
import { sqlStatusCondition, sqlStatusInCare } from './cat-status.js';
import { checkMorningMedicationCompleteForGuard, checkEveningMedicationCompleteForGuard } from './medication-morning-pending.js';
import { checkMorningFeedingCompleteForGuard, checkEveningFeedingCompleteForGuard } from './morning-feeding-pending.js';
import { checkHallWaterMeasurementCompleteForGuard } from './water-measurement-pending.js';

var DASH_VET_SHEET_MODULE = 'dash_vet_schedule_sheet';
var DASH_VET_SHEET_MAX_BYTES = 10 * 1024 * 1024;
var DASH_VET_SHEET_MIMES = {
  'application/pdf': 1,
  'image/jpeg': 1,
  'image/png': 1,
  'image/gif': 1,
  'image/webp': 1,
};

function vetScheduleSheetRefId(url, staffAuth) {
  var loc = url.searchParams.get('location') || staffAuth.locationId || 'all';
  if (loc === 'all' || loc === 'cafe' || loc === 'nekomata' || loc === 'endo' || loc === 'azukari') return loc;
  return null;
}

async function fetchVetScheduleSheetMeta(db, locationId) {
  var refId = locationId || 'all';
  var row = await db.prepare(
    "SELECT id, original_name, mime_type FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != '' ORDER BY id DESC LIMIT 1"
  ).bind(DASH_VET_SHEET_MODULE, refId).first();
  if (!row) return null;
  return { id: row.id, name: row.original_name, mime_type: row.mime_type };
}

async function uploadVetScheduleSheet(req, env, db, staffAuth, url) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'service_unavailable', message: 'File storage is not configured' }, 503);
  var refId = vetScheduleSheetRefId(url, staffAuth);
  if (!refId) return opsJson({ error: 'bad_request', message: 'Invalid location' }, 400);

  var formData;
  try {
    formData = await req.formData();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Expected multipart form data' }, 400);
  }
  var file = formData.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return opsJson({ error: 'bad_request', message: 'Missing file field' }, 400);
  }
  var size = file.size || 0;
  if (size < 1) return opsJson({ error: 'bad_request', message: 'Empty file' }, 400);
  if (size > DASH_VET_SHEET_MAX_BYTES) {
    return opsJson({ error: 'payload_too_large', message: 'ファイルは10MB以下にしてください' }, 413);
  }
  var mime = String(file.type || '').toLowerCase();
  if (!DASH_VET_SHEET_MIMES[mime]) {
    return opsJson({ error: 'bad_request', message: '対応形式: PDF・画像（JPEG/PNG/GIF/WebP）' }, 400);
  }
  var buf = await file.arrayBuffer();
  if (buf.byteLength > DASH_VET_SHEET_MAX_BYTES) {
    return opsJson({ error: 'payload_too_large', message: 'ファイルは10MB以下にしてください' }, 413);
  }
  var origName = file.name || 'file';
  var safeName = String(origName).replace(/[\r\n\\/]/g, '_').slice(0, 120) || 'file';
  var r2Key = 'dashboard/vet-schedule/' + refId + '/' + Date.now() + '_' + safeName;

  try {
    await r2.put(r2Key, buf, {
      httpMetadata: { contentType: mime || 'application/octet-stream' },
    });
  } catch (_) {
    return opsJson({ error: 'upload_failed', message: 'ストレージへの保存に失敗しました' }, 500);
  }

  var oldRows = await db.prepare(
    "SELECT r2_key FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL"
  ).bind(DASH_VET_SHEET_MODULE, refId).all();
  var olds = oldRows.results || [];
  for (var oi = 0; oi < olds.length; oi++) {
    try { await r2.delete(olds[oi].r2_key); } catch (_) {}
  }
  await db.prepare("DELETE FROM files WHERE module = ? AND ref_id = ?").bind(DASH_VET_SHEET_MODULE, refId).run();

  var ext = origName.indexOf('.') >= 0 ? origName.split('.').pop() : (mime === 'application/pdf' ? 'pdf' : 'bin');
  await db.prepare(
    "INSERT INTO files (r2_key, module, ref_id, file_type, original_name, mime_type, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(r2Key, DASH_VET_SHEET_MODULE, refId, ext, origName, mime, buf.byteLength, staffAuth.staffId).run();

  return opsJson({ ok: true, ref_id: refId });
}

async function serveVetScheduleSheet(env, db, staffAuth, url) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'service_unavailable', message: 'File storage is not configured' }, 503);
  var refId = vetScheduleSheetRefId(url, staffAuth);
  if (!refId) return opsJson({ error: 'bad_request', message: 'Invalid location' }, 400);

  var fileRow = await db.prepare(
    "SELECT r2_key, original_name, mime_type FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).bind(DASH_VET_SHEET_MODULE, refId).first();
  if (!fileRow || !fileRow.r2_key) return opsJson({ error: 'not_found', message: 'No file' }, 404);

  var obj = await r2.get(fileRow.r2_key);
  if (!obj) return opsJson({ error: 'not_found', message: 'File not found in storage' }, 404);

  var headers = new Headers();
  headers.set('Content-Type', fileRow.mime_type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + String(fileRow.original_name || 'file').replace(/"/g, '') + '"');
  headers.set('Cache-Control', 'private, max-age=60');
  return new Response(obj.body, { headers: headers });
}

async function deleteVetScheduleSheet(env, db, staffAuth, url) {
  var r2 = env.NYAGI_FILES;
  var refId = vetScheduleSheetRefId(url, staffAuth);
  if (!refId) return opsJson({ error: 'bad_request', message: 'Invalid location' }, 400);

  var oldRows = await db.prepare(
    "SELECT r2_key FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL"
  ).bind(DASH_VET_SHEET_MODULE, refId).all();
  var olds = oldRows.results || [];
  if (r2) {
    for (var oi = 0; oi < olds.length; oi++) {
      try { await r2.delete(olds[oi].r2_key); } catch (_) {}
    }
  }
  await db.prepare("DELETE FROM files WHERE module = ? AND ref_id = ?").bind(DASH_VET_SHEET_MODULE, refId).run();
  return opsJson({ ok: true, deleted: true });
}

export async function handleDashboard(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  if (subPath === '/vet-schedule-sheet' || subPath.indexOf('/vet-schedule-sheet') === 0) {
    if (method === 'POST') return uploadVetScheduleSheet(req, env, db, staffAuth, url);
    if (method === 'GET') return serveVetScheduleSheet(env, db, staffAuth, url);
    if (method === 'DELETE') return deleteVetScheduleSheet(env, db, staffAuth, url);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  if (method !== 'GET') {
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  var locationId = url.searchParams.get('location') || staffAuth.locationId;
  var statusFilter = url.searchParams.get('status') || null;

  if (subPath.indexOf('/actions') === 0) {
    return handleActions(db, url, resolveLocationId(locationId));
  }

  if (subPath === '/morning-urine-pending' || subPath === '/morning-urine-pending/') {
    return getMorningUrinePending(db, locationId, statusFilter);
  }

  if (subPath === '/morning-medication-pending' || subPath === '/morning-medication-pending/') {
    return getMorningMedicationPending(db, url, locationId, statusFilter);
  }

  if (subPath === '/evening-medication-pending' || subPath === '/evening-medication-pending/') {
    return getEveningMedicationPending(db, url, locationId, statusFilter);
  }

  if (subPath === '/morning-feeding-pending' || subPath === '/morning-feeding-pending/') {
    return getMorningFeedingPending(db, url, locationId, statusFilter);
  }

  if (subPath === '/evening-feeding-pending' || subPath === '/evening-feeding-pending/') {
    return getEveningFeedingPending(db, url, locationId, statusFilter);
  }

  if (subPath === '/water-measurement-pending' || subPath === '/water-measurement-pending/') {
    return getHallWaterMeasurementPending(db, url, locationId, statusFilter);
  }

  if (subPath.indexOf('/morning') === 0) {
    return handleMorning(db, locationId, statusFilter);
  }

  if (subPath.indexOf('/evening') === 0) {
    return handleEvening(db, locationId, statusFilter);
  }

  return opsJson({ error: 'not_found', message: 'Dashboard endpoint not found' }, 404);
}

/**
 * 猫詳細タイムライン — router.js から呼ばれる
 */
export async function handleCatTimeline(req, env, url, staffAuth, catId) {
  var db = env.OPS_DB;
  var limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10) || 50);

  var cat = await db.prepare('SELECT * FROM cats WHERE id = ?').bind(catId).first();
  if (!cat) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);

  var medications = await db.prepare(
    "SELECT m.*, med.name AS medicine_name, med.category AS medicine_category FROM medications m JOIN medicines med ON m.medicine_id = med.id WHERE m.cat_id = ? AND m.active = 1 ORDER BY med.name"
  ).bind(catId).all();

  var baselines = await db.prepare(
    'SELECT * FROM cat_baselines WHERE cat_id = ?'
  ).bind(catId).all();

  var voiceInputs = await db.prepare(
    'SELECT id, raw_transcript, parsed_data, routing_layer, status, created_at FROM voice_inputs WHERE target_cat_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(catId, limit).all();

  var healthRecords = await db.prepare(
    'SELECT id, record_type, record_date, value, details, recorded_by, created_at FROM health_records WHERE cat_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(catId, limit).all();

  var medLogs = await db.prepare(
    "SELECT ml.id, ml.scheduled_at, ml.administered_at, ml.status, ml.administered_by, ml.note, ml.created_at, med.name AS medicine_name FROM medication_logs ml LEFT JOIN medications m ON ml.medication_id = m.id LEFT JOIN medicines med ON m.medicine_id = med.id WHERE ml.cat_id = ? ORDER BY ml.created_at DESC LIMIT ?"
  ).bind(catId, limit).all();

  var timeline = buildTimeline(
    voiceInputs.results || [],
    healthRecords.results || [],
    medLogs.results || []
  );

  var openActions = await db.prepare(
    "SELECT * FROM action_items WHERE cat_id = ? AND status IN ('open', 'in_progress') ORDER BY due_date"
  ).bind(catId).all();

  var nutritionProfile = await db.prepare(
    'SELECT body_condition_score, weight_trend, weight_trend_pct FROM cat_nutrition_profiles WHERE cat_id = ?'
  ).bind(catId).first();

  var planPresetRows = await db.prepare(
    'SELECT preset_id FROM feeding_plans WHERE cat_id = ? AND active = 1 AND preset_id IS NOT NULL'
  ).bind(catId).all();
  var timelinePresetIds = collectPresetIdsOrdered(cat.assigned_preset_id, planPresetRows.results || []);
  var timelineBindList = [];
  for (var tbi = 0; tbi < timelinePresetIds.length; tbi++) timelineBindList.push(timelinePresetIds[tbi]);
  var timelinePresetMaps = await fetchPresetDisplayMaps(db, timelineBindList);
  var timelinePresetResolved = resolvePresetDisplayNameDescription(
    timelinePresetIds,
    timelinePresetMaps.presetById,
    timelinePresetMaps.itemNotesAgg
  );

  var mcFileRow = await db.prepare(
    "SELECT 1 AS x FROM files WHERE module = 'cat_microchip' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != '' LIMIT 1"
  ).bind(catId).first();

  var iaPayload = await buildIaTimelinePayload(db, catId);

  var assignedMedPresetName = null;
  if (cat.assigned_medication_preset_id != null && String(cat.assigned_medication_preset_id).trim() !== '') {
    var mpNameRow = await db.prepare(
      'SELECT name FROM medication_presets WHERE id = ? AND COALESCE(active,1) = 1'
    ).bind(cat.assigned_medication_preset_id).first();
    assignedMedPresetName = mpNameRow ? mpNameRow.name : null;
  }

  var catWithExtras = Object.assign({}, cat, {
    body_condition_score: nutritionProfile ? nutritionProfile.body_condition_score : null,
    weight_trend: nutritionProfile ? nutritionProfile.weight_trend : null,
    weight_trend_pct: nutritionProfile ? nutritionProfile.weight_trend_pct : null,
    assigned_medication_preset_name: assignedMedPresetName,
    assigned_preset_name: timelinePresetResolved.name,
    assigned_preset_description: timelinePresetResolved.description,
    has_microchip_image: mcFileRow ? 1 : 0,
    has_intake_file: iaPayload.has_intake_file,
    has_adoption_file: iaPayload.has_adoption_file,
    intake_records: iaPayload.intake_records,
    adoption_records: iaPayload.adoption_records,
    intake_record_count: iaPayload.intake_record_count,
    adoption_record_count: iaPayload.adoption_record_count,
    intake_file_count: iaPayload.intake_file_count,
    adoption_file_count: iaPayload.adoption_file_count,
  });

  return opsJson({
    cat: catWithExtras,
    medications: medications.results || [],
    baselines: baselines.results || [],
    timeline: timeline,
    open_actions: openActions.results || [],
  });
}

// ── 拠点（all の場合は null、both は廃止）────────────────────────────────────
function resolveLocationId(locationId) {
  if (!locationId || locationId === 'all') return null;
  if (locationId === 'both') return 'cafe';
  return locationId;
}


// ── 朝チェック ──

function statusCondition(statusFilter) {
  return sqlStatusCondition(statusFilter);
}

/** ダッシュ・業務終了と同じ献立↔ログ突き合わせ用スロット正規化 */
function dashFeedNormSlot(s) {
  if (s == null || s === '') return '';
  var x = String(s).toLowerCase().trim();
  if (x === '朝' || x === 'morning' || x === 'am') return 'morning';
  if (x === '昼' || x === 'afternoon' || x === 'noon' || x === 'lunch') return 'afternoon';
  if (x === '夜' || x === 'evening' || x === 'night' || x === 'pm' || x === '夕' || x === 'dinner') return 'evening';
  return x;
}

/**
 * 当日・フィルタ内の投薬について、未完了（pending or ログなし）の行数と対象猫一覧（ダッシュボード用）
 * medications.time_slots を展開し medication_logs と突き合わせる
 */
async function computeMedIncompleteForDash(db, locId, date, statusFilter) {
  var stCond = statusCondition(statusFilter);
  var medSql =
    'SELECT m.id AS medication_id, m.cat_id, m.time_slots, c.name AS cat_name, med.name AS medicine_name ' +
    'FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id ' +
    'WHERE m.active = 1 AND (' + stCond + ')';
  if (locId) {
    medSql += ' AND c.location_id = ?';
  } else {
    medSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var medStmt = db.prepare(medSql);
  var medRes = locId ? await medStmt.bind(locId).all() : await medStmt.all();
  var meds = medRes.results || [];

  if (meds.length === 0) {
    return { plan_rows: 0, incomplete_rows: 0, complete_rows: 0, cats: [], cats_overflow: 0 };
  }

  var nextDay = jstCalendarAddDays(date, 1);
  var mlSql =
    'SELECT ml.medication_id, ml.cat_id, ml.scheduled_at, ml.status FROM medication_logs ml ' +
    'INNER JOIN medications m ON ml.medication_id = m.id AND m.active = 1 ' +
    'WHERE ml.scheduled_at >= ? AND ml.scheduled_at < ? AND ml.cat_id IN (SELECT id FROM cats WHERE ' + stCond + ')';
  if (locId) {
    mlSql += ' AND ml.cat_id IN (SELECT id FROM cats WHERE location_id = ?)';
  }
  var mlStmt = db.prepare(mlSql);
  var mlRes = locId ? await mlStmt.bind(date, nextDay, locId).all() : await mlStmt.bind(date, nextDay).all();
  var logs = mlRes.results || [];

  var logDone = {};
  for (var li = 0; li < logs.length; li++) {
    var lg = logs[li];
    if (lg.status === 'done' || lg.status === 'administered' || lg.status === 'skipped') {
      var lSlot = normSlot((lg.scheduled_at || '').split('T')[1] || '');
      logDone[lg.medication_id + '_' + lSlot] = true;
    }
  }

  var planCount = 0;
  var incomplete = [];
  for (var mi = 0; mi < meds.length; mi++) {
    var m = meds[mi];
    if (!shouldGenerateForDay(m.frequency || '毎日', date, m.start_date || date)) continue;
    var slots = [];
    try { slots = JSON.parse(m.time_slots); } catch (_) {}
    if (!Array.isArray(slots)) slots = [m.time_slots || '朝'];
    for (var si = 0; si < slots.length; si++) {
      planCount++;
      var slotNorm = normSlot(slots[si]);
      var key = m.medication_id + '_' + slotNorm;
      if (!logDone[key]) {
        incomplete.push({ cat_id: m.cat_id, cat_name: m.cat_name, medicine_name: m.medicine_name });
      }
    }
  }

  var seen = {};
  var catList = [];
  for (var ii = 0; ii < incomplete.length; ii++) {
    var row = incomplete[ii];
    var idk = String(row.cat_id);
    if (seen[idk]) continue;
    seen[idk] = true;
    catList.push({ id: row.cat_id, name: row.cat_name });
  }
  catList.sort(function (a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });

  var maxCats = 24;
  var overflow = catList.length > maxCats ? catList.length - maxCats : 0;
  var catsOut = catList.slice(0, maxCats);

  return {
    plan_rows: planCount,
    incomplete_rows: incomplete.length,
    complete_rows: planCount - incomplete.length,
    cats: catsOut,
    cats_overflow: overflow,
  };
}

/** 投薬スロット（normSlot 後の 朝/昼/晩）を給餌サマリーと同じく「朝」「夜（昼・晩等）」に振り分け */
function dashMedMorningEveningBucket(slotNorm) {
  return slotNorm === '朝' ? 'morning' : 'evening';
}

/**
 * 朝ダッシュ「お薬サマリー」: 当日スケジュール行ごとに「あげた」（medication_logs が done/administered）のみカウント
 * スキップは未実施扱い。朝／夜（昼・晩等）の内訳は給餌サマリーと同じ。
 */
async function computeMedicationGivenSummaryForDash(db, locId, date, statusFilter) {
  var stCond = statusCondition(statusFilter);
  var medSql =
    'SELECT m.id AS medication_id, m.cat_id, m.time_slots, m.frequency, m.start_date, c.name AS cat_name ' +
    'FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id ' +
    "WHERE m.active = 1 AND (m.frequency IS NULL OR trim(m.frequency) != '必要時') AND (" +
    stCond +
    ')';
  if (locId) {
    medSql += ' AND c.location_id = ?';
  } else {
    medSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var medStmt = db.prepare(medSql);
  var medRes = locId ? await medStmt.bind(locId).all() : await medStmt.all();
  var meds = medRes.results || [];

  if (meds.length === 0) return [];

  var nextDay = jstCalendarAddDays(date, 1);
  var mlSqlGiven =
    'SELECT ml.medication_id, ml.cat_id, ml.scheduled_at, ml.status FROM medication_logs ml ' +
    'INNER JOIN medications m ON ml.medication_id = m.id AND m.active = 1 ' +
    'WHERE ml.scheduled_at >= ? AND ml.scheduled_at < ? AND ml.cat_id IN (SELECT id FROM cats WHERE ' +
    stCond +
    ')';
  if (locId) {
    mlSqlGiven += ' AND ml.cat_id IN (SELECT id FROM cats WHERE location_id = ?)';
  }
  var mlStmtGiven = db.prepare(mlSqlGiven);
  var mlResGiven = locId ? await mlStmtGiven.bind(date, nextDay, locId).all() : await mlStmtGiven.bind(date, nextDay).all();
  var logs = mlResGiven.results || [];

  var logGiven = {};
  for (var li = 0; li < logs.length; li++) {
    var lg = logs[li];
    var st = lg.status || '';
    if (st !== 'done' && st !== 'administered') continue;
    var lSlot = normSlot((lg.scheduled_at || '').split('T')[1] || '');
    logGiven[lg.medication_id + '_' + lSlot] = true;
  }

  var byCat = {};
  for (var mi = 0; mi < meds.length; mi++) {
    var m = meds[mi];
    if (!shouldGenerateForDay(m.frequency || '毎日', date, m.start_date || date)) continue;
    var cid = m.cat_id;
    if (!byCat[cid]) {
      byCat[cid] = {
        cat_id: cid,
        cat_name: m.cat_name || '',
        plans: 0,
        given: 0,
        m_plans: 0,
        m_given: 0,
        e_plans: 0,
        e_given: 0,
      };
    }
    var slots = [];
    try {
      slots = JSON.parse(m.time_slots);
    } catch (_) {}
    if (!Array.isArray(slots)) slots = [m.time_slots || '朝'];
    for (var si = 0; si < slots.length; si++) {
      var slotNorm = normSlot(slots[si]);
      var key = m.medication_id + '_' + slotNorm;
      var given = !!logGiven[key];
      byCat[cid].plans++;
      if (given) byCat[cid].given++;
      var bucket = dashMedMorningEveningBucket(slotNorm);
      if (bucket === 'morning') {
        byCat[cid].m_plans++;
        if (given) byCat[cid].m_given++;
      } else {
        byCat[cid].e_plans++;
        if (given) byCat[cid].e_given++;
      }
    }
  }

  var out = [];
  for (var k in byCat) {
    if (!Object.prototype.hasOwnProperty.call(byCat, k)) continue;
    var b = byCat[k];
    if (b.plans === 0) continue;
    var pct = b.plans > 0 ? Math.round((b.given / b.plans) * 100) : 0;
    var mPl = b.m_plans || 0;
    var mGv = b.m_given || 0;
    var ePl = b.e_plans || 0;
    var eGv = b.e_given || 0;
    var mPct = mPl > 0 ? Math.round((mGv / mPl) * 100) : null;
    var ePct = ePl > 0 ? Math.round((eGv / ePl) * 100) : null;
    out.push({
      cat_id: b.cat_id,
      cat_name: b.cat_name,
      plans_total: b.plans,
      fed_count: b.given,
      fed_pct: pct,
      morning: { plans_total: mPl, fed_count: mGv, fed_pct: mPct },
      evening: { plans_total: ePl, fed_count: eGv, fed_pct: ePct },
    });
  }
  out.sort(function (a, b) {
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });
  return out;
}

/**
 * 当日・フィルタ内の献立について、未記録／摂取未確認の行数と対象猫一覧（ダッシュボード用）
 */
async function computeFeedingIncompleteForDash(db, locId, date, statusFilter) {
  var stCond = statusCondition(statusFilter);
  var fpSql =
    'SELECT fp.id AS plan_id, fp.cat_id, fp.meal_slot, fp.meal_order, c.name AS cat_name FROM feeding_plans fp ' +
    'JOIN cats c ON fp.cat_id = c.id WHERE fp.active = 1 AND (' +
    stCond +
    ')';
  if (locId) {
    fpSql += ' AND c.location_id = ?';
  } else {
    fpSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var fpStmt = db.prepare(fpSql);
  var fpRes = locId ? await fpStmt.bind(locId).all() : await fpStmt.all();
  var plans = fpRes.results || [];

  if (plans.length === 0) {
    return { plan_rows: 0, incomplete_rows: 0, complete_rows: 0, cats: [], cats_overflow: 0 };
  }

  var flSql =
    'SELECT fl.plan_id, fl.cat_id, fl.meal_slot, fl.eaten_pct, fl.remaining_g FROM feeding_logs fl ' +
    'JOIN cats c ON fl.cat_id = c.id WHERE fl.log_date = ? AND (' +
    stCond +
    ')';
  if (locId) {
    flSql += ' AND c.location_id = ?';
  } else {
    flSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var flStmt = db.prepare(flSql);
  var flRes = locId ? await flStmt.bind(date, locId).all() : await flStmt.bind(date).all();
  var logs = flRes.results || [];

  var slotCountByNorm = {};
  for (var si = 0; si < plans.length; si++) {
    var pn0 = dashFeedNormSlot(plans[si].meal_slot);
    if (pn0) slotCountByNorm[pn0] = (slotCountByNorm[pn0] || 0) + 1;
  }

  var incomplete = [];
  for (var pi = 0; pi < plans.length; pi++) {
    var fpItem = plans[pi];
    var cid = fpItem.cat_id;
    var catLogs = [];
    for (var lj = 0; lj < logs.length; lj++) {
      if (logs[lj].cat_id === cid) catLogs.push(logs[lj]);
    }
    var fedLine = false;
    var eatenPct = null;
    var remainingG = null;
    var pid = fpItem.plan_id;
    if (pid != null) {
      for (var li = 0; li < catLogs.length; li++) {
        var lg = catLogs[li];
        if (lg.plan_id != null && Number(lg.plan_id) === Number(pid)) {
          fedLine = true;
          if (lg.eaten_pct != null) eatenPct = lg.eaten_pct;
          if (lg.remaining_g != null) remainingG = lg.remaining_g;
          break;
        }
      }
    }
    if (!fedLine) {
      var pnorm = dashFeedNormSlot(fpItem.meal_slot);
      var allowSlot = pnorm && (slotCountByNorm[pnorm] || 0) === 1;
      if (allowSlot) {
        for (var li2 = 0; li2 < catLogs.length; li2++) {
          var lg2 = catLogs[li2];
          if (dashFeedNormSlot(lg2.meal_slot) === pnorm) {
            fedLine = true;
            if (lg2.eaten_pct != null) eatenPct = lg2.eaten_pct;
            if (lg2.remaining_g != null) remainingG = lg2.remaining_g;
            break;
          }
        }
      }
    }
    if (!fedLine) {
      incomplete.push({ cat_id: cid, cat_name: fpItem.cat_name || '—' });
      continue;
    }
    if (eatenPct == null && remainingG == null) {
      incomplete.push({ cat_id: cid, cat_name: fpItem.cat_name || '—' });
    }
  }

  var seen = {};
  var catList = [];
  for (var ii = 0; ii < incomplete.length; ii++) {
    var row = incomplete[ii];
    var idk = String(row.cat_id);
    if (seen[idk]) continue;
    seen[idk] = true;
    catList.push({ id: row.cat_id, name: row.cat_name });
  }
  catList.sort(function (a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });

  var maxCats = 24;
  var overflow = catList.length > maxCats ? catList.length - maxCats : 0;
  var catsOut = catList.slice(0, maxCats);

  return {
    plan_rows: plans.length,
    incomplete_rows: incomplete.length,
    complete_rows: plans.length - incomplete.length,
    cats: catsOut,
    cats_overflow: overflow,
  };
}

/** 献立スロットを朝列 / 夜分列（朝以外＝晩・昼・おやつ等）に振り分け */
function dashFeedMorningEveningBucket(mealSlot) {
  return dashFeedNormSlot(mealSlot) === 'morning' ? 'morning' : 'evening';
}

/**
 * 猫一覧「本日の食欲%」（feeding_today_pct）:
 * 当日の給餌ログを全件平均しない。**朝分**の eaten_pct 平均と、**夜分（朝以外）かつ全汁相当（foods.form が wet / liquid）**の平均の
 * **2 系統だけ**を用意し、両方あれば算術平均。片方だけならその片方。どちらも無ければ null。
 * （業務終了・こはだレポートの文脈では「朝ドライ＋夜ウェット」指数に揃える）
 */
function computeOverviewTodayAppetitePct(catLogsToday, feedingPlan, slotCountByNorm) {
  var morningSum = 0;
  var morningN = 0;
  var eveWetSum = 0;
  var eveWetN = 0;
  for (var i = 0; i < catLogsToday.length; i++) {
    var lg = catLogsToday[i];
    if (lg.eaten_pct == null) continue;
    var slotN = dashFeedNormSlot(lg.meal_slot);
    if (slotN === 'morning') {
      morningSum += lg.eaten_pct;
      morningN++;
      continue;
    }
    var form = null;
    if (lg.plan_id != null) {
      for (var fp = 0; fp < feedingPlan.length; fp++) {
        if (feedingPlan[fp].plan_id != null && Number(feedingPlan[fp].plan_id) === Number(lg.plan_id)) {
          form = feedingPlan[fp].food_form || null;
          break;
        }
      }
    }
    if (!form && lg.log_food_form) {
      form = lg.log_food_form;
    }
    if (!form) {
      var pnormL = normMealSlotForOverview(lg.meal_slot);
      if (pnormL && (slotCountByNorm[pnormL] || 0) === 1) {
        for (var fp2 = 0; fp2 < feedingPlan.length; fp2++) {
          if (normMealSlotForOverview(feedingPlan[fp2].meal_slot) === pnormL) {
            form = feedingPlan[fp2].food_form || null;
            break;
          }
        }
      }
    }
    if (form === 'wet' || form === 'liquid') {
      eveWetSum += lg.eaten_pct;
      eveWetN++;
    }
  }
  if (morningN > 0 && eveWetN > 0) {
    return Math.round((morningSum / morningN + eveWetSum / eveWetN) / 2);
  }
  if (morningN > 0) return Math.round(morningSum / morningN);
  if (eveWetN > 0) return Math.round(eveWetSum / eveWetN);
  return null;
}

/**
 * 夕方ダッシュ「給餌サマリー」: 献立行ごとに当日「あげた」（feeding_logs が plan / スロットで突合）の割合
 * 朝分・夜分（非朝は夜欄に集約）の2列用フィールドを付与
 */
async function computeFeedingFedSummaryForDash(db, locId, date, statusFilter) {
  var stCond = statusCondition(statusFilter);
  var fpSql =
    'SELECT fp.id AS plan_id, fp.cat_id, fp.meal_slot, fp.meal_order, c.name AS cat_name FROM feeding_plans fp ' +
    'JOIN cats c ON fp.cat_id = c.id WHERE fp.active = 1 AND (' +
    stCond +
    ')';
  if (locId) {
    fpSql += ' AND c.location_id = ?';
  } else {
    fpSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var fpStmt = db.prepare(fpSql);
  var fpRes = locId ? await fpStmt.bind(locId).all() : await fpStmt.all();
  var plans = fpRes.results || [];

  if (plans.length === 0) return [];

  var flSql =
    'SELECT fl.plan_id, fl.cat_id, fl.meal_slot, fl.eaten_pct, fl.remaining_g FROM feeding_logs fl ' +
    'JOIN cats c ON fl.cat_id = c.id WHERE fl.log_date = ? AND (' +
    stCond +
    ')';
  if (locId) {
    flSql += ' AND c.location_id = ?';
  } else {
    flSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var flStmt = db.prepare(flSql);
  var flRes = locId ? await flStmt.bind(date, locId).all() : await flStmt.bind(date).all();
  var logs = flRes.results || [];

  var slotCountByNorm = {};
  for (var si = 0; si < plans.length; si++) {
    var pn0 = dashFeedNormSlot(plans[si].meal_slot);
    if (pn0) slotCountByNorm[pn0] = (slotCountByNorm[pn0] || 0) + 1;
  }

  var byCat = {};
  for (var pi = 0; pi < plans.length; pi++) {
    var fpItem = plans[pi];
    var cid = fpItem.cat_id;
    if (!byCat[cid]) {
      byCat[cid] = {
        cat_id: cid,
        cat_name: fpItem.cat_name || '',
        plans: 0,
        fed: 0,
        m_plans: 0,
        m_fed: 0,
        e_plans: 0,
        e_fed: 0,
      };
    }
    byCat[cid].plans++;

    var catLogs = [];
    for (var lj = 0; lj < logs.length; lj++) {
      if (logs[lj].cat_id === cid) catLogs.push(logs[lj]);
    }
    var fedLine = false;
    var pid = fpItem.plan_id;
    if (pid != null) {
      for (var li = 0; li < catLogs.length; li++) {
        var lg = catLogs[li];
        if (lg.plan_id != null && Number(lg.plan_id) === Number(pid)) {
          fedLine = true;
          break;
        }
      }
    }
    if (!fedLine) {
      var pnorm = dashFeedNormSlot(fpItem.meal_slot);
      var allowSlot = pnorm && (slotCountByNorm[pnorm] || 0) === 1;
      if (allowSlot) {
        for (var li2 = 0; li2 < catLogs.length; li2++) {
          var lg2 = catLogs[li2];
          if (dashFeedNormSlot(lg2.meal_slot) === pnorm) {
            fedLine = true;
            break;
          }
        }
      }
    }
    var bucket = dashFeedMorningEveningBucket(fpItem.meal_slot);
    if (bucket === 'morning') {
      byCat[cid].m_plans++;
      if (fedLine) byCat[cid].m_fed++;
    } else {
      byCat[cid].e_plans++;
      if (fedLine) byCat[cid].e_fed++;
    }
    if (fedLine) byCat[cid].fed++;
  }

  var out = [];
  for (var k in byCat) {
    if (!Object.prototype.hasOwnProperty.call(byCat, k)) continue;
    var b = byCat[k];
    var pct = b.plans > 0 ? Math.round((b.fed / b.plans) * 100) : 0;
    var mPl = b.m_plans || 0;
    var mFd = b.m_fed || 0;
    var ePl = b.e_plans || 0;
    var eFd = b.e_fed || 0;
    var mPct = mPl > 0 ? Math.round((mFd / mPl) * 100) : null;
    var ePct = ePl > 0 ? Math.round((eFd / ePl) * 100) : null;
    out.push({
      cat_id: b.cat_id,
      cat_name: b.cat_name,
      plans_total: b.plans,
      fed_count: b.fed,
      fed_pct: pct,
      morning: { plans_total: mPl, fed_count: mFd, fed_pct: mPct },
      evening: { plans_total: ePl, fed_count: eFd, fed_pct: ePct },
    });
  }
  out.sort(function (a, b) {
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });
  return out;
}

/** 猫一覧「5項目まとめて記録」と同じ5項目（爪切り・肉球は除外） */
var DASH_CARE_SLOTS_ORDER = ['ブラシ', 'アゴ', '耳', 'お尻', '目ヤニ拭き'];

function dashCareDetailLabelForSummary(details) {
  if (details == null || details === '') return '';
  var s = details;
  if (typeof s === 'string' && s.charAt(0) === '"') {
    try {
      s = JSON.parse(s);
    } catch (e) {
      /* 生テキストのまま */
    }
  }
  if (typeof s === 'object' && s && s.label) return String(s.label).trim();
  return String(details).trim();
}

function dashCareSlotKeyFromRow(recordType, details) {
  var rt = recordType || '';
  var lbl = dashCareDetailLabelForSummary(details);
  if (rt === 'eye_discharge' && !lbl) lbl = '目ヤニ拭き';
  return rt + '|' + lbl;
}

function dashCareSlotKeyForLabel(jaLabel) {
  if (jaLabel === '目ヤニ拭き') return 'eye_discharge|目ヤニ拭き';
  return 'care|' + jaLabel;
}

/**
 * 当日ケア進捗（health_records・同一項目は created_at 最新を採用。実施＝ value が × / ー 以外）
 */
async function computeCareDailySummaryForDash(db, locId, date, statusFilter, catRows) {
  if (!catRows || catRows.length === 0) return [];

  var stCond = statusCondition(statusFilter);
  var sql =
    'SELECT hr.cat_id, hr.record_type, hr.details, hr.value, hr.created_at FROM health_records hr ' +
    'JOIN cats c ON hr.cat_id = c.id WHERE hr.record_date = ? AND hr.record_type IN (\'care\',\'eye_discharge\') AND (' +
    stCond +
    ')';
  if (locId) {
    sql += ' AND c.location_id = ?';
  } else {
    sql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  sql += ' ORDER BY hr.created_at ASC';

  var stmt = db.prepare(sql);
  var res = locId ? await stmt.bind(date, locId).all() : await stmt.bind(date).all();
  var rows = res.results || [];

  var canonMap = {};
  for (var ci = 0; ci < DASH_CARE_SLOTS_ORDER.length; ci++) {
    canonMap[dashCareSlotKeyForLabel(DASH_CARE_SLOTS_ORDER[ci])] = true;
  }

  var slotStateByCat = {};
  for (var ri = 0; ri < rows.length; ri++) {
    var rw = rows[ri];
    var sk = dashCareSlotKeyFromRow(rw.record_type, rw.details);
    if (!canonMap[sk]) continue;
    var cid = rw.cat_id;
    if (!slotStateByCat[cid]) slotStateByCat[cid] = {};
    slotStateByCat[cid][sk] = { value: rw.value };
  }

  var out = [];
  for (var cj = 0; cj < catRows.length; cj++) {
    var cat = catRows[cj];
    var cid2 = cat.id;
    var stMap = slotStateByCat[cid2] || {};
    var done = 0;
    var missing = [];
    var total = DASH_CARE_SLOTS_ORDER.length;
    for (var ki = 0; ki < total; ki++) {
      var label = DASH_CARE_SLOTS_ORDER[ki];
      var fullK = dashCareSlotKeyForLabel(label);
      var st = stMap[fullK];
      var isDone = st && st.value !== '×' && st.value !== 'ー';
      if (isDone) {
        done++;
      } else {
        missing.push(label);
      }
    }
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    out.push({
      cat_id: cid2,
      cat_name: cat.name || '',
      items_total: total,
      items_done: done,
      items_pct: pct,
      missing_labels: missing,
    });
  }

  out.sort(function (a, b) {
    if (a.items_done !== b.items_done) return a.items_done - b.items_done;
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });
  return out;
}

/**
 * 当日（JST）の排尿記録を猫ごとに集計（フィルタ内の全猫を含む。未記録は has_today_record: false）
 * health_records の尿行＋当日入力の音声排尿。HR に紐づく音声は二重にしない
 */
async function computeUrineTodaySummaryForDash(db, locId, today, statusFilter, catRows) {
  if (!catRows || catRows.length === 0) return [];

  var stCond = sqlStatusCondition(statusFilter, 'c');
  var hrSql =
    'SELECT hr.id, hr.cat_id, c.name AS cat_name, hr.value, hr.details, hr.recorded_time, hr.record_date ' +
    'FROM health_records hr JOIN cats c ON hr.cat_id = c.id ' +
    "WHERE hr.record_type IN ('urine','urination') AND hr.record_date = ? AND (" +
    stCond +
    ')';
  if (locId) {
    hrSql += ' AND c.location_id = ?';
  } else {
    hrSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  hrSql += ' ORDER BY c.name, hr.id';
  var hrRes = locId ? await db.prepare(hrSql).bind(today, locId).all() : await db.prepare(hrSql).bind(today).all();
  var hrRows = hrRes.results || [];

  var hrIdSet = {};
  var byCat = {};
  for (var hi = 0; hi < hrRows.length; hi++) {
    var r = hrRows[hi];
    hrIdSet[String(r.id)] = true;
    var cid = r.cat_id;
    if (!byCat[cid]) {
      byCat[cid] = { cat_id: cid, cat_name: r.cat_name || '', entries: [] };
    }
    byCat[cid].entries.push({
      source: 'health_record',
      record_id: r.id,
      status_label: toJaStatus(r.value, true),
      time: extractExcretionTimeLabel(r),
      slot: detailsToSlot(r.details),
      value_raw: r.value || '',
    });
  }

  var viSql =
    'SELECT vi.id, vi.target_cat_id, vi.target_module, vi.parsed_data, vi.created_records, c.name AS cat_name, vi.created_at ' +
    'FROM voice_inputs vi JOIN cats c ON vi.target_cat_id = c.id ' +
    'WHERE ' +
    (locId ? 'vi.location_id = ? AND ' : "vi.location_id IN ('cafe','nekomata','endo','azukari') AND ") +
    "date(vi.created_at, '+9 hours') = ? AND (" +
    stCond +
    ')';
  if (locId) {
    viSql += ' AND c.location_id = ?';
  } else {
    viSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var viRes = locId ? await db.prepare(viSql).bind(locId, today, locId).all() : await db.prepare(viSql).bind(today).all();
  var viRows = viRes.results || [];

  for (var vi = 0; vi < viRows.length; vi++) {
    var inp = viRows[vi];
    if (inp.target_module !== 'stool' && inp.target_module !== 'health') continue;
    var pd = safeParseJson(inp.parsed_data);
    if (!pd) continue;
    var pp = pd.parsed || pd;
    var rt = pd.record_type || '';
    if (rt !== 'urination' && rt !== 'urine') continue;
    var linkedHr = linkedHealthRecordId(inp.created_records);
    if (linkedHr != null && hrIdSet[String(linkedHr)]) continue;
    var cid2 = inp.target_cat_id;
    if (!byCat[cid2]) {
      byCat[cid2] = { cat_id: cid2, cat_name: inp.cat_name || '', entries: [] };
    }
    var vTime = String(pp.slot || pp.time_slot || '').trim();
    if (!vTime) vTime = isoToJstHm(inp.created_at);
    var vSlot = String(pp.slot || pp.time_slot || '').trim();
    byCat[cid2].entries.push({
      source: 'voice',
      voice_input_id: inp.id,
      status_label: toJaStatus(pp.status || pp.consistency, true),
      time: vTime,
      slot: vSlot,
      value_raw: String(pp.status || pp.consistency || pp.symptom || ''),
    });
  }

  var withRecords = [];
  for (var key in byCat) {
    if (!Object.prototype.hasOwnProperty.call(byCat, key)) continue;
    var block = byCat[key];
    if (!block.entries || block.entries.length === 0) continue;
    block.entries.sort(function (a, b) {
      var ta = a.time || '';
      var tb = b.time || '';
      if (ta !== tb) return tb.localeCompare(ta);
      return 0;
    });
    var parts = [];
    for (var ei = 0; ei < block.entries.length; ei++) {
      var e = block.entries[ei];
      var piece = (e.slot ? e.slot + ' ' : '') + (e.time ? e.time + ' ' : '') + (e.status_label || '');
      parts.push(String(piece).trim().replace(/\s+/g, ' '));
    }
    withRecords.push({
      cat_id: block.cat_id,
      cat_name: block.cat_name,
      record_count: block.entries.length,
      summary_line: parts.join(' / '),
      entries: block.entries,
      has_today_record: true,
    });
  }

  var byId = {};
  for (var wi = 0; wi < withRecords.length; wi++) {
    byId[withRecords[wi].cat_id] = withRecords[wi];
  }

  var out = [];
  for (var cj = 0; cj < catRows.length; cj++) {
    var cat = catRows[cj];
    var cid = cat.id;
    var hit = byId[cid];
    if (hit) {
      out.push(hit);
    } else {
      out.push({
        cat_id: cid,
        cat_name: cat.name || '',
        record_count: 0,
        summary_line: '',
        entries: [],
        has_today_record: false,
      });
    }
  }

  out.sort(function (a, b) {
    var ma = a.has_today_record ? 1 : 0;
    var mb = b.has_today_record ? 1 : 0;
    if (ma !== mb) return ma - mb;
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });
  return out;
}

/** フード形態: フードDBの form が **wet または liquid**（リキッドも水分補給系としてウェットと同じ 80% 換算）。未設定/NULL/空は含めない。 */
function dashIsWetFoodForWaterDisplay(form) {
  if (form == null || String(form).trim() === '') return false;
  var f = String(form).toLowerCase();
  return f === 'wet' || f === 'liquid';
}

/** 給餌ログから摂取量(g)。eaten_g 優先、なければ offered_g×摂取率。 */
function dashEatenGFromLog(row) {
  if (row.eaten_g != null && !isNaN(row.eaten_g) && row.eaten_g >= 0) return row.eaten_g;
  if (row.offered_g != null && row.eaten_pct != null && !isNaN(row.offered_g) && !isNaN(row.eaten_pct)) {
    return Math.max(0, Number(row.offered_g) * (Number(row.eaten_pct) / 100));
  }
  return 0;
}

/**
 * ウェット・リキッド給餌からの推定水分。JST の「当日」は含まず、**3日前・2日前・前日（昨日）**の暦3日を集計する。
 * `dates` / 猫別 `by_day` / `by_day_summary` は**日付の新しい順**（前日→3日前）。
 * 摂取量(g)は feeding_logs の **eaten_g を優先**、無いときのみ **offered_g × (eaten_pct/100)**（記録上の食べた量扱い）。
 * **form が wet または liquid** の行の g × 一律 80% ≒ 水分 mL。フィルタ内の全猫を行に含む（0 の日は 0）。
 * さらに `cats.water_tracking = 1` の猫は、同日の `water_measurements.consumed_ml`（器の飲水量）を**合算**し `combined_*` として返す（フード推定と二重にならないよう器だけ足す）。
 */
function dashCatWaterTrackingOn(wtr) {
  return wtr === 1 || wtr === '1' || wtr === true;
}

function dashRound1(x) {
  if (x == null || isNaN(x)) return 0;
  return Math.round(Number(x) * 10) / 10;
}

async function computeWetFoodWaterForDash(db, locId, todayYmd, statusFilter) {
  var DASH_WET_PCT = 0.8;
  var lookback = 3;
  var dNewest = jstCalendarAddDays(todayYmd, -1);
  var dMid = jstCalendarAddDays(todayYmd, -2);
  var dOldest = jstCalendarAddDays(todayYmd, -3);
  var dateList = [dNewest, dMid, dOldest];

  var stCondC = sqlStatusCondition(statusFilter, 'c');
  var catSql = 'SELECT id, name, water_tracking FROM cats WHERE (' + statusCondition(statusFilter) + ')';
  if (locId) catSql += ' AND location_id = ?';
  else catSql += " AND location_id IN ('cafe','nekomata','endo','azukari')";
  catSql += ' ORDER BY name';
  var catRes = locId ? await db.prepare(catSql).bind(locId).all() : await db.prepare(catSql).all();
  var catRows = catRes.results || [];

  var sql =
    'SELECT fl.cat_id, c.name AS cat_name, fl.log_date, fl.eaten_g, fl.offered_g, fl.eaten_pct, f.form ' +
    'FROM feeding_logs fl ' +
    'INNER JOIN cats c ON c.id = fl.cat_id ' +
    'LEFT JOIN foods f ON f.id = fl.food_id ' +
    "WHERE fl.log_date IN (?, ?, ?) AND (" +
    stCondC +
    ')';
  if (locId) {
    sql += ' AND c.location_id = ?';
  } else {
    sql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var res = locId
    ? await db.prepare(sql).bind(dOldest, dMid, dNewest, locId).all()
    : await db.prepare(sql).bind(dOldest, dMid, dNewest).all();
  var rows = res.results || [];

  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var rw = rows[i];
    if (!dashIsWetFoodForWaterDisplay(rw.form)) continue;
    var g0 = dashEatenGFromLog(rw);
    if (g0 <= 0) continue;
    var cid = rw.cat_id;
    var ld = rw.log_date;
    if (!map[cid]) map[cid] = {};
    if (!map[cid][ld]) map[cid][ld] = { eaten_wet_g: 0, water_ml: 0 };
    map[cid][ld].eaten_wet_g += g0;
    map[cid][ld].water_ml += g0 * DASH_WET_PCT;
  }

  var bowlSql =
    'SELECT wm.cat_id, wm.measurement_date, wm.consumed_ml ' +
    'FROM water_measurements wm ' +
    'INNER JOIN cats c ON c.id = wm.cat_id ' +
    "WHERE wm.measurement_date IN (?, ?, ?) AND c.water_tracking = 1 AND (" +
    stCondC +
    ')';
  if (locId) {
    bowlSql += ' AND c.location_id = ?';
  } else {
    bowlSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var bowlRes = locId
    ? await db.prepare(bowlSql).bind(dOldest, dMid, dNewest, locId).all()
    : await db.prepare(bowlSql).bind(dOldest, dMid, dNewest).all();
  var bowlRows = bowlRes.results || [];
  var bowlByCat = {};
  for (var bi = 0; bi < bowlRows.length; bi++) {
    var br = bowlRows[bi];
    if (br.consumed_ml == null || isNaN(br.consumed_ml)) continue;
    var bcat = br.cat_id;
    var bdt = br.measurement_date;
    if (!bowlByCat[bcat]) bowlByCat[bcat] = {};
    var prev = bowlByCat[bcat][bdt];
    var add = Number(br.consumed_ml);
    bowlByCat[bcat][bdt] = (prev != null ? prev : 0) + add;
  }
  for (var bk in bowlByCat) {
    if (!Object.prototype.hasOwnProperty.call(bowlByCat, bk)) continue;
    var bdm = bowlByCat[bk];
    for (var bdt2 in bdm) {
      if (Object.prototype.hasOwnProperty.call(bdm, bdt2)) bdm[bdt2] = dashRound1(bdm[bdt2]);
    }
  }

  var byDayAgg = {};
  for (var di = 0; di < dateList.length; di++) {
    byDayAgg[dateList[di]] = {
      total_eaten_wet_g: 0,
      food_water_ml: 0,
      bowl_consumed_ml: 0,
      combined_water_ml: 0,
    };
  }

  var byCat = [];
  var totGAll = 0;
  var totFoodMl = 0;
  var totBowlMl = 0;
  for (var ci = 0; ci < catRows.length; ci++) {
    var c = catRows[ci];
    var cid2 = c.id;
    var tracksW = dashCatWaterTrackingOn(c.water_tracking);
    var byDay = [];
    var catG = 0;
    var catFood = 0;
    var catBowl = 0;
    for (var dj = 0; dj < dateList.length; dj++) {
      var dStr = dateList[dj];
      var cell = map[cid2] && map[cid2][dStr] ? map[cid2][dStr] : { eaten_wet_g: 0, water_ml: 0 };
      var eg = Math.round(cell.eaten_wet_g * 10) / 10;
      var wFood = Math.round(cell.water_ml * 10) / 10;
      var wBowl = 0;
      if (tracksW && bowlByCat[cid2] && bowlByCat[cid2][dStr] != null) {
        wBowl = bowlByCat[cid2][dStr];
      }
      var wComb = dashRound1((wFood || 0) + (wBowl || 0));
      byDay.push({
        date: dStr,
        eaten_wet_g: eg,
        water_ml: wFood,
        bowl_consumed_ml: tracksW && (bowlByCat[cid2] && bowlByCat[cid2][dStr] != null) ? wBowl : null,
        combined_water_ml: wComb,
      });
      catG += eg;
      catFood += wFood;
      if (tracksW) catBowl += wBowl || 0;
      byDayAgg[dStr].total_eaten_wet_g += eg;
      byDayAgg[dStr].food_water_ml += wFood;
      if (tracksW) {
        byDayAgg[dStr].bowl_consumed_ml += wBowl || 0;
      }
      byDayAgg[dStr].combined_water_ml += wComb;
    }
    var catRowOut = {
      cat_id: cid2,
      cat_name: c.name || '',
      water_tracking: tracksW ? 1 : 0,
      by_day: byDay,
      total_eaten_wet_g: Math.round(catG * 10) / 10,
      total_food_water_ml: Math.round(catFood * 10) / 10,
      total_bowl_consumed_ml: tracksW ? Math.round(catBowl * 10) / 10 : null,
      total_combined_water_ml: Math.round((catFood + (tracksW ? catBowl : 0)) * 10) / 10,
      total_water_ml: Math.round((catFood + (tracksW ? catBowl : 0)) * 10) / 10,
    };
    byCat.push(catRowOut);
    totGAll += catG;
    totFoodMl += catFood;
    if (tracksW) totBowlMl += catBowl;
  }

  for (var dfx = 0; dfx < dateList.length; dfx++) {
    var dfix = dateList[dfx];
    var a = byDayAgg[dfix];
    a.food_water_ml = dashRound1(a.food_water_ml);
    a.bowl_consumed_ml = dashRound1(a.bowl_consumed_ml);
    a.combined_water_ml = dashRound1(a.combined_water_ml);
  }

  var byDaySummary = [];
  for (var dk = 0; dk < dateList.length; dk++) {
    var ds = dateList[dk];
    var b = byDayAgg[ds];
    byDaySummary.push({
      date: ds,
      total_eaten_wet_g: Math.round(b.total_eaten_wet_g * 10) / 10,
      food_water_ml: b.food_water_ml,
      bowl_consumed_ml: b.bowl_consumed_ml,
      combined_water_ml: b.combined_water_ml,
      total_water_ml: b.combined_water_ml,
    });
  }

  var totCombined = dashRound1(totFoodMl + totBowlMl);
  return {
    reference_today: todayYmd,
    as_of_date: todayYmd,
    window_excludes_today: true,
    window_start: dOldest,
    window_end: dNewest,
    lookback_days: lookback,
    dates: dateList,
    water_assumption_pct: 80,
    intake_from_logs:
      'eaten_g if set; else offered_g * eaten_pct/100 (feeding_logs, form wet or liquid only)',
    water_bowl_from: 'water_measurements.consumed_ml for cats with water_tracking=1, same dates',
    total_eaten_wet_g: Math.round(totGAll * 10) / 10,
    total_food_water_ml: dashRound1(totFoodMl),
    total_bowl_consumed_ml: dashRound1(totBowlMl),
    total_combined_water_ml: totCombined,
    total_water_ml: totCombined,
    by_day_summary: byDaySummary,
    by_cat: byCat,
  };
}

/**
 * 「お薬BOX投薬…」（tmpl_hall_asa_touyaku）タスクの完了／スキップ前ガード用。
 * 朝スロットの投薬プランが当日分すべて done / administered / skipped か。
 */
async function getMorningMedicationPending(db, url, locationId, statusFilter) {
  var locId = resolveLocationId(locationId);
  var date = url.searchParams.get('date') || jstToday();
  if (statusFilter === 'adopted') {
    return opsJson({
      reference_date: date,
      has_pending: false,
      missing_count: 0,
      missing_cats: [],
      missing_lines: [],
    });
  }
  var chk = await checkMorningMedicationCompleteForGuard(db, locId, date, statusFilter);
  return opsJson({
    reference_date: date,
    has_pending: !chk.ok,
    missing_count: chk.incomplete.length,
    missing_cats: chk.missing_cats,
    missing_lines: chk.missing_lines,
  });
}

/**
 * 「ニャギ投薬欄チェック、翌日のお薬BOX作り」（tmpl_hall_yokujitsu_box）タスクの完了／スキップ前ガード用。
 * 夜スロット（晩）の投薬プランが当日分すべて done / administered / skipped か。
 */
async function getEveningMedicationPending(db, url, locationId, statusFilter) {
  var locId = resolveLocationId(locationId);
  var date = url.searchParams.get('date') || jstToday();
  if (statusFilter === 'adopted') {
    return opsJson({
      reference_date: date,
      has_pending: false,
      missing_count: 0,
      missing_cats: [],
      missing_lines: [],
    });
  }
  var chk = await checkEveningMedicationCompleteForGuard(db, locId, date, statusFilter);
  return opsJson({
    reference_date: date,
    has_pending: !chk.ok,
    missing_count: chk.incomplete.length,
    missing_cats: chk.missing_cats,
    missing_lines: chk.missing_lines,
  });
}

/**
 * 「nekomeshiasa」（朝ごはん記録タスク）の完了／スキップ前ガード用。
 * 朝スロットの feeding_plans が当日分すべて記録済みか。
 */
async function getMorningFeedingPending(db, url, locationId, statusFilter) {
  var locId = resolveLocationId(locationId);
  var date = url.searchParams.get('date') || jstToday();
  if (statusFilter === 'adopted') {
    return opsJson({ reference_date: date, has_pending: false, missing_count: 0, missing_cats: [], missing_lines: [] });
  }
  var chk = await checkMorningFeedingCompleteForGuard(db, locId, date, statusFilter);
  return opsJson({
    reference_date: date,
    has_pending: !chk.ok,
    missing_count: chk.missing_cats.length,
    missing_cats: chk.missing_cats,
    missing_lines: chk.missing_lines,
  });
}

/**
 * 「tmpl_bw_10」（夜ごはんタスク）の完了／スキップ前ガード用。
 */
async function getEveningFeedingPending(db, url, locationId, statusFilter) {
  var locId = resolveLocationId(locationId);
  var date = url.searchParams.get('date') || jstToday();
  if (statusFilter === 'adopted') {
    return opsJson({ reference_date: date, has_pending: false, missing_count: 0, missing_cats: [], missing_lines: [] });
  }
  var chk = await checkEveningFeedingCompleteForGuard(db, locId, date, statusFilter);
  return opsJson({
    reference_date: date,
    has_pending: !chk.ok,
    missing_count: chk.missing_cats.length,
    missing_cats: chk.missing_cats,
    missing_lines: chk.missing_lines,
  });
}

/**
 * 「tmpl_hall_mizu_koukan」（ホール猫の水交換／飲水量確認）タスクの完了／スキップ前ガード用。
 * water_tracking = 1 の在籍猫について、当日の「セット」と前日の「計測」がすべて済んでいるかを返す。
 */
async function getHallWaterMeasurementPending(db, url, locationId, statusFilter) {
  var locId = resolveLocationId(locationId);
  var date = url.searchParams.get('date') || jstToday();
  if (statusFilter === 'adopted') {
    return opsJson({ reference_date: date, has_pending: false, missing_count: 0, missing_cats: [], missing_lines: [] });
  }
  var chk = await checkHallWaterMeasurementCompleteForGuard(db, locId, date, statusFilter);
  return opsJson({
    reference_date: date,
    has_pending: !chk.ok,
    missing_count: chk.missing_cats.length,
    missing_cats: chk.missing_cats,
    missing_lines: chk.missing_lines,
  });
}

/**
 * 「朝の排尿チェック」タスクの完了／スキップ前ガード用。
 * 本日 JST・在籍猫それぞれについて computeUrineTodaySummaryForDash と同じ基準で has_today_record が false の猫を返す。
 */
async function getMorningUrinePending(db, locationId, statusFilter) {
  var locId = resolveLocationId(locationId);
  var today = jstToday();

  if (statusFilter === 'adopted') {
    return opsJson({
      reference_date: today,
      has_pending: false,
      missing_count: 0,
      missing_cats: [],
    });
  }

  var catSql =
    'SELECT id, name, status, alert_level, alert_reason, alert_until, location_id, species FROM cats WHERE ' +
    statusCondition(statusFilter);
  if (locId) catSql += ' AND location_id = ?';
  catSql += ' ORDER BY name';
  var stmt = db.prepare(catSql);
  if (locId) stmt = stmt.bind(locId);
  var cats = await stmt.all();
  var catRows = cats.results || [];
  if (catRows.length === 0) {
    return opsJson({
      reference_date: today,
      has_pending: false,
      missing_count: 0,
      missing_cats: [],
    });
  }

  var summary = await computeUrineTodaySummaryForDash(db, locId, today, statusFilter, catRows);
  var missing = [];
  for (var i = 0; i < summary.length; i++) {
    if (!summary[i].has_today_record) {
      missing.push({ cat_id: summary[i].cat_id, cat_name: summary[i].cat_name || '' });
    }
  }

  return opsJson({
    reference_date: today,
    has_pending: missing.length > 0,
    missing_count: missing.length,
    missing_cats: missing,
  });
}

/** NYAGI タスク画面の連続スキップ確認モーダル（SKIP_STREAK_CONFIRM_FROM=5）と揃える */
var NYAGI_SKIP_STREAK_CONFIRM_FROM = 5;

async function queryNyagiLunchSkipStreakWarnings(db, locationId, todayYmd) {
  var minPend = NYAGI_SKIP_STREAK_CONFIRM_FROM - 1;
  var minSkip = NYAGI_SKIP_STREAK_CONFIRM_FROM;
  var sql =
    'SELECT t.id, t.title, t.status, t.skip_streak, t.template_id, COALESCE(t.task_type, \'routine\') AS task_type, c.name AS cat_name FROM tasks t ' +
    'LEFT JOIN cats c ON t.cat_id = c.id WHERE t.location_id = ? AND date(COALESCE(t.scheduled_date, t.deadline_date, t.due_date)) = ? ' +
    "AND COALESCE(t.task_type, 'routine') != 'event' AND (" +
    "(t.status = 'pending' AND COALESCE(t.skip_streak, 0) >= ?) OR " +
    '(t.status = \'skipped\' AND COALESCE(t.skip_streak, 0) >= ?)' +
    ') ORDER BY t.sort_order, t.title';
  var res = await db.prepare(sql).bind(locationId, todayYmd, minPend, minSkip).all();
  return await filterTaskRowsByTemplateRecurrence(db, res.results || [], todayYmd);
}

/**
 * 14時 JST 簡易 Slack 用のデータ束（拠点単位: cafe / nekomata / endo / azukari）。
 * 排尿は本日暦日で未記録の在籍猫、ケア穴は当日基準の buildCloseDayCareItemGaps、スキップは NYAGI 閾値に合わせた連続のみ。
 */
export async function fetchNyagiLunchReportPayload(db, locationId) {
  var locId = resolveLocationId(locationId);
  if (!locId) {
    return null;
  }
  var today = jstToday();
  var statusFilter = null;
  var catSql =
    'SELECT id, name, status, alert_level, alert_reason, alert_until, location_id, species FROM cats WHERE ' +
    statusCondition(statusFilter) +
    ' AND location_id = ? ORDER BY name';
  var cats = await db.prepare(catSql).bind(locId).all();
  var catRows = cats.results || [];

  var urineMissing = [];
  if (catRows.length > 0) {
    var urineSummary = await computeUrineTodaySummaryForDash(db, locId, today, statusFilter, catRows);
    for (var ui = 0; ui < urineSummary.length; ui++) {
      if (!urineSummary[ui].has_today_record) {
        urineMissing.push({ cat_id: urineSummary[ui].cat_id, cat_name: urineSummary[ui].cat_name || '' });
      }
    }
  }

  var care = await buildCloseDayCareItemGaps(db, locId, today, null);
  var skipStreakTasks = await queryNyagiLunchSkipStreakWarnings(db, locId, today);

  // 健康スコア: ダッシュボードと同じライブ算出
  var catHealthScores = [];
  if (catRows.length > 0) {
    var lunchScorePromises = catRows.map(function (cat) {
      return calculateHealthScore(db, cat.id, today).catch(function () { return null; });
    });
    var lunchScoreResults = await Promise.all(lunchScorePromises);
    for (var lsi = 0; lsi < catRows.length; lsi++) {
      var lsResult = lunchScoreResults[lsi];
      catHealthScores.push({
        cat_id: catRows[lsi].id,
        cat_name: catRows[lsi].name || '',
        score: lsResult ? lsResult.total_score : null,
      });
    }
    // スコア昇順（低い＝要注意が先頭）
    catHealthScores.sort(function (a, b) {
      var sa = a.score !== null ? a.score : 999;
      var sb = b.score !== null ? b.score : 999;
      return sa - sb;
    });
  }

  return {
    reference_date: today,
    location_id: locId,
    location_label: LOCATION_LABELS[locId] || locId,
    urine_missing_cats: urineMissing,
    care_item_gaps: care,
    skip_streak_tasks: skipStreakTasks,
    skip_streak_threshold: NYAGI_SKIP_STREAK_CONFIRM_FROM,
    cat_health_scores: catHealthScores,
  };
}

async function handleMorning(db, locationId, statusFilter) {
  var today = jstToday();
  var yesterday = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -1);
  var locId = resolveLocationId(locationId);

  if (statusFilter === 'adopted') {
    return handleAdoptedView(db, today, locId);
  }

  var catSql = "SELECT id, name, status, alert_level, alert_reason, alert_until, location_id, species FROM cats WHERE " + statusCondition(statusFilter);
  if (locId) catSql += " AND location_id = ?";
  catSql += " ORDER BY name";
  var stmt = db.prepare(catSql);
  if (locId) stmt = stmt.bind(locId);
  var cats = await stmt.all();
  var catRows = cats.results || [];

  var criticalCats = [];
  var watchCats = [];
  var catsSummary = [];

  for (var i = 0; i < catRows.length; i++) {
    var c = catRows[i];
    if (c.alert_level === 'critical') {
      criticalCats.push({ id: c.id, name: c.name, alert_level: 'critical', alert_reason: c.alert_reason || '' });
    }
    if (c.alert_level === 'watch') {
      watchCats.push({ id: c.id, name: c.name, alert_level: 'watch', alert_reason: c.alert_reason || '', alert_until: c.alert_until || '' });
    }
  }

  var viSql = "SELECT target_cat_id, COUNT(*) AS cnt FROM voice_inputs WHERE " + (locId ? "location_id = ? AND" : "location_id IN ('cafe','nekomata','endo','azukari') AND") + " created_at >= ? GROUP BY target_cat_id";
  var viStmt = db.prepare(viSql);
  var todayInputs = locId ? await viStmt.bind(locId, today).all() : await viStmt.bind(today).all();
  var inputCountMap = {};
  var inputRows = todayInputs.results || [];
  for (var i = 0; i < inputRows.length; i++) {
    inputCountMap[inputRows[i].target_cat_id] = inputRows[i].cnt;
  }

  // 健康スコアは health_scores 保存行ではなく当日ライブ算出（給餌・投薬等の直近入力を即反映）
  var scoreMap = {};
  var scoreDetailMap = {};
  if (catRows.length > 0) {
    var morningLivePromises = [];
    for (var mli = 0; mli < catRows.length; mli++) {
      morningLivePromises.push(calculateHealthScore(db, catRows[mli].id, today));
    }
    var morningLiveResults = await Promise.all(morningLivePromises);
    for (var mlj = 0; mlj < catRows.length; mlj++) {
      var mCatId = catRows[mlj].id;
      var mScore = morningLiveResults[mlj];
      scoreMap[mCatId] = mScore.total_score;
      scoreDetailMap[mCatId] = {
        weight: mScore.weight_score,
        appetite: mScore.appetite_score,
        medication: mScore.medication_score,
        vet: mScore.vet_score,
        behavior: mScore.behavior_score,
        detail: JSON.stringify(mScore),
      };
    }
  }

  var d7ago = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -7);
  var vomitRows = (await db.prepare(
    "SELECT cat_id, record_date, value FROM health_records WHERE record_date >= ? AND (record_type = 'vomiting' OR (record_type = 'observation' AND (value LIKE '%はき戻し%' OR value LIKE '%嘔吐%' OR details LIKE '%はき戻し%')))"
  ).bind(d7ago).all()).results || [];
  var vomitMap = {};
  for (var vi = 0; vi < vomitRows.length; vi++) {
    var vr = vomitRows[vi];
    var cnt = 1;
    var vm = (vr.value || '').match(/(\d+)\s*回/);
    if (vm) cnt = parseInt(vm[1], 10) || 1;
    vomitMap[vr.cat_id] = (vomitMap[vr.cat_id] || 0) + cnt;
  }

  for (var i = 0; i < catRows.length; i++) {
    var c = catRows[i];
    var healthScore = scoreMap[c.id] !== undefined ? scoreMap[c.id] : null;
    var scoreColor = scoreColorFromValue(healthScore);
    var sd = scoreDetailMap[c.id] || {};
    catsSummary.push({
      id: c.id,
      name: c.name,
      species: c.species || 'cat',
      alert_level: c.alert_level || 'normal',
      location_id: c.location_id,
      status: c.status,
      today_input_count: inputCountMap[c.id] || 0,
      health_score: healthScore,
      score_color: scoreColor,
      score_detail: sd.detail || null,
      vomit_7d: vomitMap[c.id] || 0,
    });
  }

  // 当日タスク進捗（週次・月次テンプレは「その日に該当する行」のみ）
  var taskLoc = locId ? "location_id = ?" : "location_id IN ('cafe','nekomata','endo','azukari')";
  var todayTasks = locId
    ? await db
        .prepare("SELECT id, status, template_id, task_type FROM tasks WHERE " + taskLoc + " AND " + SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_NO_ALIAS)
        .bind(locId, today, today, today)
        .all()
    : await db
        .prepare("SELECT id, status, template_id, task_type FROM tasks WHERE " + taskLoc + " AND " + SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_NO_ALIAS)
        .bind(today, today, today)
        .all();
  var taskRows = await filterTaskRowsByTemplateRecurrence(db, todayTasks.results || [], today);
  var taskTotal = taskRows.length;
  var taskDone = 0;
  for (var i = 0; i < taskRows.length; i++) {
    if (taskRows[i].status === 'done') taskDone++;
  }

  // 未完了タスク（pending / in_progress）の上位10件
  var pendingTasksRaw = locId
    ? await db
        .prepare(
          "SELECT t.id, t.title, t.attribute, t.priority, t.due_time, t.cat_id, t.assigned_to, t.template_id, t.task_type, c.name AS cat_name, s.name AS assigned_name FROM tasks t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE t.location_id = ? AND " +
            SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_ALIAS_T +
            " AND t.status IN ('pending', 'in_progress') ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, t.due_time LIMIT 30"
        )
        .bind(locId, today, today, today)
        .all()
    : await db
        .prepare(
          "SELECT t.id, t.title, t.attribute, t.priority, t.due_time, t.cat_id, t.assigned_to, t.template_id, t.task_type, c.name AS cat_name, s.name AS assigned_name FROM tasks t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE t.location_id IN ('cafe','nekomata','endo','azukari') AND " +
            SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_ALIAS_T +
            " AND t.status IN ('pending', 'in_progress') ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, t.due_time LIMIT 30"
        )
        .bind(today, today, today)
        .all();
  var pendingFiltered = await filterTaskRowsByTemplateRecurrence(db, pendingTasksRaw.results || [], today);
  var pendingTasks = { results: pendingFiltered.slice(0, 10) };

  var medLoc = locId ? "c.location_id = ?" : "c.location_id IN ('cafe','nekomata','endo','azukari')";
  var medicationsToday = locId
    ? await db.prepare("SELECT m.id AS medication_id, m.cat_id, c.name AS cat_name, med.name AS medicine_name, m.dosage_amount, m.dosage_unit, m.time_slots, m.notes, m.frequency, m.start_date FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id WHERE m.active = 1 AND " + medLoc + " AND " + sqlStatusInCare('c') + " ORDER BY m.time_slots, c.name").bind(locId).all()
    : await db.prepare("SELECT m.id AS medication_id, m.cat_id, c.name AS cat_name, med.name AS medicine_name, m.dosage_amount, m.dosage_unit, m.time_slots, m.notes, m.frequency, m.start_date FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id WHERE m.active = 1 AND " + medLoc + " AND " + sqlStatusInCare('c') + " ORDER BY m.time_slots, c.name").all();

  var nextDay = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), 1);
  var medLogLoc = locId ? "location_id = ?" : "location_id IN ('cafe','nekomata','endo','azukari')";
  var dashMedSql =
    "SELECT ml.id AS log_id, ml.medication_id, ml.cat_id, ml.scheduled_at, ml.status FROM medication_logs ml " +
    "JOIN medications m ON ml.medication_id = m.id AND m.active = 1 " +
    "WHERE ml.scheduled_at >= ? AND ml.scheduled_at < ? AND (m.frequency IS NULL OR trim(m.frequency) != '必要時') " +
    "AND ml.cat_id IN (SELECT id FROM cats WHERE " + medLogLoc + ")";
  var dashMedLogs = locId
    ? await db.prepare(dashMedSql).bind(today, nextDay, locId).all()
    : await db.prepare(dashMedSql).bind(today, nextDay).all();
  var dashMedLogRows = dashMedLogs.results || [];

  var actLoc = locId ? "location_id = ?" : "location_id IN ('cafe','nekomata','endo','azukari')";
  var overdueActions = locId
    ? await db.prepare("SELECT * FROM action_items WHERE " + actLoc + " AND status IN ('open', 'in_progress') AND due_date < ? ORDER BY due_date").bind(locId, today).all()
    : await db.prepare("SELECT * FROM action_items WHERE " + actLoc + " AND status IN ('open', 'in_progress') AND due_date < ? ORDER BY due_date").bind(today).all();

  var todayActions = locId
    ? await db.prepare("SELECT * FROM action_items WHERE " + actLoc + " AND status IN ('open', 'in_progress') AND due_date >= ? AND due_date < ? ORDER BY due_date").bind(locId, today, today + 'T23:59:59').all()
    : await db.prepare("SELECT * FROM action_items WHERE " + actLoc + " AND status IN ('open', 'in_progress') AND due_date >= ? AND due_date < ? ORDER BY due_date").bind(today, today + 'T23:59:59').all();

  var yesterdayAnomalies = locId
    ? await db.prepare("SELECT vi.*, c.name AS cat_name FROM voice_inputs vi LEFT JOIN cats c ON vi.target_cat_id = c.id WHERE vi.location_id = ? AND vi.created_at >= ? AND vi.created_at < ? AND vi.routing_layer IN ('L1_with_anomaly_flag', 'L3', 'L4', 'L5') ORDER BY vi.created_at DESC").bind(locId, yesterday, today).all()
    : await db.prepare("SELECT vi.*, c.name AS cat_name FROM voice_inputs vi LEFT JOIN cats c ON vi.target_cat_id = c.id WHERE vi.location_id IN ('cafe','nekomata','endo','azukari') AND vi.created_at >= ? AND vi.created_at < ? AND vi.routing_layer IN ('L1_with_anomaly_flag', 'L3', 'L4', 'L5') ORDER BY vi.created_at DESC").bind(yesterday, today).all();

  var feedingIncomplete = await computeFeedingIncompleteForDash(db, locId, today, statusFilter);
  var medIncomplete = await computeMedIncompleteForDash(db, locId, today, statusFilter);
  var medicationSummaryList = await computeMedicationGivenSummaryForDash(db, locId, today, statusFilter);
  var careDailySummary = await computeCareDailySummaryForDash(db, locId, today, statusFilter, catRows);
  var urineTodaySummary = await computeUrineTodaySummaryForDash(db, locId, today, statusFilter, catRows);
  var careGapsRaw = await buildCloseDayCareItemGaps(db, locId, today, statusFilter);
  var care_item_gaps_7d = {
    items: careGapsRaw.items || [],
    threshold_days: careGapsRaw.threshold_days,
    as_of_date: today,
  };

  var wetFoodWater = await computeWetFoodWaterForDash(db, locId, today, statusFilter);

  return opsJson({
    date: today,
    type: 'morning',
    critical_cats: criticalCats,
    watch_cats: watchCats,
    medications_today: formatMedications(medicationsToday.results || [], dashMedLogRows),
    overdue_actions: overdueActions.results || [],
    today_actions: todayActions.results || [],
    yesterday_anomalies: yesterdayAnomalies.results || [],
    cats_summary: catsSummary,
    task_progress: { total: taskTotal, done: taskDone, pct: taskTotal > 0 ? Math.round(taskDone / taskTotal * 100) : 0 },
    pending_tasks: pendingTasks.results || [],
    feeding_incomplete: feedingIncomplete,
    medication_incomplete: medIncomplete,
    medication_summary: medicationSummaryList,
    care_daily_summary: careDailySummary,
    care_item_gaps_7d: care_item_gaps_7d,
    urine_today_summary: urineTodaySummary,
    wet_food_water: wetFoodWater,
  });
}

// ── 夕方チェック ──

async function handleEvening(db, locationId, statusFilter) {
  var locId = resolveLocationId(locationId);
  var today = jstToday();
  var tomorrow = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), 1);

  if (statusFilter === 'adopted') {
    return handleAdoptedView(db, today, locId);
  }

  var eveningCatSql = "SELECT id, name, status, location_id, species FROM cats WHERE " + statusCondition(statusFilter);
  if (locId) eveningCatSql += " AND location_id = ?";
  eveningCatSql += " ORDER BY name";
  var eveningStmt = db.prepare(eveningCatSql);
  if (locId) eveningStmt = eveningStmt.bind(locId);
  var cats = await eveningStmt.all();
  var catRows = cats.results || [];

  var evViSql = locId
    ? "SELECT target_cat_id, target_module FROM voice_inputs WHERE location_id = ? AND created_at >= ?"
    : "SELECT target_cat_id, target_module FROM voice_inputs WHERE location_id IN ('cafe','nekomata','endo','azukari') AND created_at >= ?";
  var todayInputs = locId ? await db.prepare(evViSql).bind(locId, today).all() : await db.prepare(evViSql).bind(today).all();
  var inputsByModule = {};
  var catsWithInput = {};
  var totalInputs = 0;
  var byCat = {};
  var byCategory = { stool: 0, feeding: 0, medication: 0, weight: 0, other: 0 };
  var anomalyCount = 0;
  var l3Calls = 0;
  var l4l5Calls = 0;

  var allTodayInputRows = todayInputs.results || [];
  for (var i = 0; i < allTodayInputRows.length; i++) {
    totalInputs++;
    var row = allTodayInputRows[i];
    if (row.target_cat_id) {
      catsWithInput[row.target_cat_id] = true;
      if (!byCat[row.target_cat_id]) byCat[row.target_cat_id] = {};
      if (row.target_module) byCat[row.target_cat_id][row.target_module] = true;
    }
    var mod = row.target_module || 'other';
    if (byCategory[mod] !== undefined) {
      byCategory[mod]++;
    } else {
      byCategory.other++;
    }
  }

  var evAnomSql = locId
    ? "SELECT vi.id, vi.raw_transcript, vi.routing_layer, vi.target_cat_id, vi.created_at, c.name AS cat_name FROM voice_inputs vi LEFT JOIN cats c ON vi.target_cat_id = c.id WHERE vi.location_id = ? AND vi.created_at >= ? AND vi.routing_layer IN ('L1_with_anomaly_flag', 'L3', 'L4', 'L5') ORDER BY vi.created_at DESC"
    : "SELECT vi.id, vi.raw_transcript, vi.routing_layer, vi.target_cat_id, vi.created_at, c.name AS cat_name FROM voice_inputs vi LEFT JOIN cats c ON vi.target_cat_id = c.id WHERE vi.location_id IN ('cafe','nekomata','endo','azukari') AND vi.created_at >= ? AND vi.routing_layer IN ('L1_with_anomaly_flag', 'L3', 'L4', 'L5') ORDER BY vi.created_at DESC";
  var todayAnomalyInputs = locId ? await db.prepare(evAnomSql).bind(locId, today).all() : await db.prepare(evAnomSql).bind(today).all();
  var anomalyRows = todayAnomalyInputs.results || [];
  anomalyCount = anomalyRows.length;
  for (var i = 0; i < anomalyRows.length; i++) {
    if (anomalyRows[i].routing_layer === 'L3') l3Calls++;
    if (anomalyRows[i].routing_layer === 'L4' || anomalyRows[i].routing_layer === 'L5') l4l5Calls++;
  }

  var unreportedCats = [];
  var expectedModules = ['stool', 'feeding', 'weight'];
  for (var i = 0; i < catRows.length; i++) {
    var c = catRows[i];
    if (!catsWithInput[c.id]) {
      unreportedCats.push({ id: c.id, name: c.name, species: c.species || 'cat', missing: expectedModules.slice() });
    } else {
      var missing = [];
      var recorded = byCat[c.id] || {};
      for (var m = 0; m < expectedModules.length; m++) {
        if (!recorded[expectedModules[m]] && !recorded['health']) {
          missing.push(expectedModules[m]);
        }
      }
      if (missing.length > 0) {
        unreportedCats.push({ id: c.id, name: c.name, species: c.species || 'cat', missing: missing });
      }
    }
  }

  var evMedLoc = locId ? "c.location_id = ?" : "c.location_id IN ('cafe','nekomata','endo','azukari')";
  var pendingMedications = locId
    ? await db.prepare("SELECT m.cat_id, c.name AS cat_name, med.name AS medicine_name, m.time_slots, m.dosage_amount, m.dosage_unit FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id WHERE m.active = 1 AND " + evMedLoc + " AND " + sqlStatusInCare('c') + " AND (m.time_slots LIKE '%晩%' OR m.time_slots LIKE '%evening%') ORDER BY c.name").bind(locId).all()
    : await db.prepare("SELECT m.cat_id, c.name AS cat_name, med.name AS medicine_name, m.time_slots, m.dosage_amount, m.dosage_unit FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id WHERE m.active = 1 AND " + evMedLoc + " AND " + sqlStatusInCare('c') + " AND (m.time_slots LIKE '%晩%' OR m.time_slots LIKE '%evening%') ORDER BY c.name").all();

  var pendingMedRows = pendingMedications.results || [];
  var pendingMedResult = [];
  for (var i = 0; i < pendingMedRows.length; i++) {
    var pm = pendingMedRows[i];
    var administered = await db.prepare(
      "SELECT id FROM medication_logs WHERE cat_id = ? AND medication_id IN (SELECT id FROM medications WHERE cat_id = ? AND active = 1) AND status = 'done' AND administered_at >= ?"
    ).bind(pm.cat_id, pm.cat_id, today).first();
    if (!administered) {
      pendingMedResult.push({
        cat_name: pm.cat_name,
        medicine_name: pm.medicine_name,
        time_slot: '18:00',
        status: 'pending',
      });
    }
  }

  var evActLoc = locId ? "ai.location_id = ?" : "ai.location_id IN ('cafe','nekomata','endo','azukari')";
  var tomorrowEvents = locId
    ? await db.prepare("SELECT ai.cat_id, c.name AS cat_name, ai.title AS event, ai.description AS action_needed FROM action_items ai JOIN cats c ON ai.cat_id = c.id WHERE " + evActLoc + " AND ai.due_date >= ? AND ai.due_date < ? AND ai.status IN ('open', 'in_progress') ORDER BY ai.due_date").bind(locId, tomorrow, tomorrow + 'T23:59:59').all()
    : await db.prepare("SELECT ai.cat_id, c.name AS cat_name, ai.title AS event, ai.description AS action_needed FROM action_items ai JOIN cats c ON ai.cat_id = c.id WHERE " + evActLoc + " AND ai.due_date >= ? AND ai.due_date < ? AND ai.status IN ('open', 'in_progress') ORDER BY ai.due_date").bind(tomorrow, tomorrow + 'T23:59:59').all();

  var evMedEndLoc = locId ? "c.location_id = ?" : "c.location_id IN ('cafe','nekomata','endo','azukari')";
  var medEndingSoon = locId
    ? await db.prepare("SELECT m.cat_id, c.name AS cat_name, med.name AS medicine_name, m.end_date FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id WHERE m.active = 1 AND " + evMedEndLoc + " AND m.end_date = ? ORDER BY c.name").bind(locId, tomorrow).all()
    : await db.prepare("SELECT m.cat_id, c.name AS cat_name, med.name AS medicine_name, m.end_date FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id WHERE m.active = 1 AND " + evMedEndLoc + " AND m.end_date = ? ORDER BY c.name").bind(tomorrow).all();

  var tomorrowEventsResult = (tomorrowEvents.results || []).slice();
  var medEnding = medEndingSoon.results || [];
  for (var i = 0; i < medEnding.length; i++) {
    tomorrowEventsResult.push({
      cat_name: medEnding[i].cat_name,
      event: '処方終了日（' + medEnding[i].medicine_name + '）',
      action_needed: '再検の判断',
    });
  }

  // 病院予定（過去30日分 + 今後全て）
  var vetSchedFrom = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -30);
  var vetSchedLoc = locId ? "c.location_id = ?" : "c.location_id IN ('cafe','nekomata','endo','azukari')";
  var vetSchedSql = "SELECT hr.id, hr.cat_id, c.name AS cat_name, hr.record_type, hr.next_due, hr.booked_date, hr.value FROM health_records hr JOIN cats c ON hr.cat_id = c.id WHERE hr.next_due IS NOT NULL AND hr.next_due >= ? AND " + vetSchedLoc + " AND " + sqlStatusInCare('c') + " ORDER BY hr.next_due";
  var vetSchedRows = locId
    ? await db.prepare(vetSchedSql).bind(vetSchedFrom, locId).all()
    : await db.prepare(vetSchedSql).bind(vetSchedFrom).all();
  var vetSchedules = (vetSchedRows.results || []).map(function (r) {
    var diffDays = Math.ceil((new Date(r.next_due) - new Date(today)) / 86400000);
    return { id: r.id, cat_id: r.cat_id, cat_name: r.cat_name, record_type: r.record_type, next_due: r.next_due, booked_date: r.booked_date || null, value: r.value, days_left: diffDays };
  });

  var vetScheduleSheet = await fetchVetScheduleSheetMeta(db, locId);

  // タスク完了率（週次・月次は該当日のみ）
  var evTaskLoc = locId ? "location_id = ?" : "location_id IN ('cafe','nekomata','endo','azukari')";
  var allTodayTasks = locId
    ? await db
        .prepare("SELECT id, status, template_id, task_type FROM tasks WHERE " + evTaskLoc + " AND " + SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_NO_ALIAS)
        .bind(locId, today, today, today)
        .all()
    : await db
        .prepare("SELECT id, status, template_id, task_type FROM tasks WHERE " + evTaskLoc + " AND " + SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_NO_ALIAS)
        .bind(today, today, today)
        .all();
  var allTaskRows = await filterTaskRowsByTemplateRecurrence(db, allTodayTasks.results || [], today);
  var taskTotal = allTaskRows.length;
  var taskDone = 0;
  for (var i = 0; i < allTaskRows.length; i++) {
    if (allTaskRows[i].status === 'done') taskDone++;
  }

  var feedingSummaryList = await computeFeedingFedSummaryForDash(db, locId, today, statusFilter);
  var wetFoodWaterEvening = await computeWetFoodWaterForDash(db, locId, today, statusFilter);

  return opsJson({
    date: today,
    type: 'evening',
    unreported_cats: unreportedCats,
    today_summary: {
      total_inputs: totalInputs,
      by_category: byCategory,
      anomalies: anomalyCount,
      today_anomaly_items: anomalyRows,
      l3_calls: l3Calls,
      l4_l5_calls: l4l5Calls,
    },
    pending_medications: pendingMedResult,
    tomorrow_events: tomorrowEventsResult,
    vet_schedules: vetSchedules,
    vet_schedule_sheet: vetScheduleSheet,
    task_completion: { total: taskTotal, done: taskDone, pct: taskTotal > 0 ? Math.round(taskDone / taskTotal * 100) : 0 },
    feeding_summary: feedingSummaryList,
    wet_food_water: wetFoodWaterEvening,
  });
}

// ── アクション一覧 ──

async function handleActions(db, url, locationId) {
  var status = url.searchParams.get('status') || 'open';

  var sql = 'SELECT * FROM action_items WHERE status = ?';
  var params = [status];

  if (locationId && locationId !== 'all' && locationId !== 'both') {
    sql += ' AND location_id = ?';
    params.push(locationId);
  }
  sql += " ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, due_date";

  var stmt = db.prepare(sql);
  if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
  var result = await stmt.all();

  return opsJson({ actions: result.results || [] });
}

// ── ヘルパー ──

function normSlot(s) {
  if (!s) return '';
  if (s === 'morning' || s === '朝') return '朝';
  if (s === 'afternoon' || s === '昼') return '昼';
  if (s === 'evening' || s === '晩') return '晩';
  return s;
}

function formatMedications(rows, logRows, ymdDate) {
  var dateRef = ymdDate || jstCalendarYmdFromInstant(Date.now());
  var logMap = {};
  if (logRows) {
    for (var i = 0; i < logRows.length; i++) {
      var lr = logRows[i];
      var lSlot = normSlot((lr.scheduled_at || '').split('T')[1] || '');
      var key = (lr.medication_id || lr.cat_id) + '_' + lSlot;
      logMap[key] = { status: lr.status, log_id: lr.log_id };
    }
  }
  var result = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!shouldGenerateForDay(r.frequency || '毎日', dateRef, r.start_date || dateRef)) continue;
    var slots = [];
    try { slots = JSON.parse(r.time_slots); } catch (_) {}
    if (!Array.isArray(slots)) slots = [r.time_slots || '朝'];
    for (var s = 0; s < slots.length; s++) {
      var slot = slots[s];
      if (slot === 'morning') slot = '朝';
      else if (slot === 'afternoon') slot = '昼';
      else if (slot === 'evening') slot = '晩';
      var logKey = (r.medication_id || r.cat_id) + '_' + slot;
      var logEntry = logMap[logKey] || { status: 'pending', log_id: null };
      result.push({
        medication_id: r.medication_id,
        cat_name: r.cat_name,
        cat_id: r.cat_id,
        medicine_name: r.medicine_name,
        dosage: (r.dosage_amount || '') + (r.dosage_unit || ''),
        time_slot: slot,
        status: logEntry.status,
        log_id: logEntry.log_id,
        notes: r.notes || '',
      });
    }
  }
  return result;
}

function buildTimeline(voiceInputs, healthRecords, medLogs) {
  var items = [];

  for (var i = 0; i < voiceInputs.length; i++) {
    var vi = voiceInputs[i];
    items.push({
      type: 'voice_input',
      created_at: vi.created_at,
      raw_transcript: vi.raw_transcript,
      parsed_data: safeParseJson(vi.parsed_data),
      routing_layer: vi.routing_layer,
    });
  }

  for (var i = 0; i < healthRecords.length; i++) {
    var hr = healthRecords[i];
    items.push({
      type: 'health_record',
      created_at: hr.created_at || hr.record_date,
      record_type: hr.record_type,
      value: hr.value,
      details: safeParseJson(hr.details),
    });
  }

  for (var i = 0; i < medLogs.length; i++) {
    var ml = medLogs[i];
    items.push({
      type: 'medication_log',
      created_at: ml.created_at || ml.administered_at,
      medicine_name: ml.medicine_name,
      status: ml.status,
      note: ml.note,
    });
  }

  items.sort(function (a, b) {
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  return items;
}

async function handleAdoptedView(db, today, locId) {
  var adoptedSql = "SELECT id, name, status, location_id FROM cats WHERE status = 'adopted'";
  if (locId) adoptedSql += " AND location_id = ?";
  adoptedSql += " ORDER BY name";
  var stmt = db.prepare(adoptedSql);
  if (locId) stmt = stmt.bind(locId);
  var cats = await stmt.all();
  var catRows = cats.results || [];

  var vetScheduleSheetAdopted = await fetchVetScheduleSheetMeta(db, locId);

  var catsSummary = [];
  for (var i = 0; i < catRows.length; i++) {
    var c = catRows[i];
    catsSummary.push({
      id: c.id,
      name: c.name,
      alert_level: 'normal',
      location_id: c.location_id,
      status: c.status,
      today_input_count: 0,
      health_score: null,
      score_color: 'gray',
    });
  }

  var urineTodaySummaryAdopted = await computeUrineTodaySummaryForDash(db, locId, today, 'adopted', catRows);
  var wetFoodWaterAdopted = await computeWetFoodWaterForDash(db, locId, today, 'adopted');

  return opsJson({
    date: today,
    type: 'adopted',
    critical_cats: [],
    watch_cats: [],
    medications_today: [],
    overdue_actions: [],
    today_actions: [],
    yesterday_anomalies: [],
    cats_summary: catsSummary,
    task_progress: { total: 0, done: 0, pct: 0 },
    pending_tasks: [],
    unreported_cats: [],
    today_summary: { total_inputs: 0, anomalies: 0, today_anomaly_items: [], l3_calls: 0, l4_l5_calls: 0, by_category: {} },
    pending_medications: [],
    tomorrow_events: [],
    task_completion: { total: 0, done: 0, pct: 0 },
    feeding_summary: [],
    feeding_incomplete: { plan_rows: 0, incomplete_rows: 0, complete_rows: 0, cats: [], cats_overflow: 0 },
    medication_incomplete: { plan_rows: 0, incomplete_rows: 0, complete_rows: 0, cats: [], cats_overflow: 0 },
    vet_schedules: [],
    vet_schedule_sheet: vetScheduleSheetAdopted,
    medication_summary: [],
    care_daily_summary: [],
    care_item_gaps_7d: { items: [], threshold_days: 7, as_of_date: today },
    urine_today_summary: urineTodaySummaryAdopted,
    wet_food_water: wetFoodWaterAdopted,
  });
}

async function handleOverviewAdopted(db, locId) {
  var adoptedOverviewSql = "SELECT id, name, sex, status, alert_level, location_id, microchip_id, internal_note, species FROM cats WHERE status = 'adopted'";
  if (locId) adoptedOverviewSql += " AND location_id = ?";
  adoptedOverviewSql += " ORDER BY name";
  var stmt = db.prepare(adoptedOverviewSql);
  if (locId) stmt = stmt.bind(locId);
  var cats = await stmt.all();
  var catRows = cats.results || [];
  var result = [];
  for (var i = 0; i < catRows.length; i++) {
    var c = catRows[i];
    result.push({
      id: c.id, name: c.name, sex: c.sex, status: c.status,
      species: c.species || 'cat',
      alert_level: c.alert_level || 'normal', location_id: c.location_id,
      microchip: c.microchip_id ? 'registered' : 'none',
      health_score: null, score_color: 'gray',
      weight_latest: null, weight_previous: null, weight_trend: null,
      weight_record_date: null, weight_recorded_at: null, weight_recorded_today: false,
      feeding_today_pct: null, feeding_today_kcal: null, stool_today: [], urine_today: [], meds_today: { done: 0, total: 0, items: [] },
      tasks_today: { done: 0, total: 0, items: [] }, care_latest: [], care_date: null,
      anomalies_7d: [], feeding_plan: [], feeding_logs_yesterday: [],
      vaccine_next_due: null, checkup_next_due: null,
    });
  }
  return opsJson({ cats: result });
}

var STOOL_JA = { normal: '健康', hard: '硬い', soft: '軟便', liquid: '下痢', recorded: '記録あり' };
var URINE_JA = { normal: '普通', hard: '多い', soft: '少量', liquid: 'なし（異常）', recorded: '記録あり' };
function toJaStatus(val, isUrine) {
  if (!val) return '記録あり';
  var map = isUrine ? URINE_JA : STOOL_JA;
  return map[val] || val;
}

function extractRecordTime(row) {
  if (row.recorded_time) {
    var t = row.recorded_time;
    if (t.length >= 16 && t.charAt(10) === 'T') return t.slice(11, 16);
    if (t.length >= 5 && t.indexOf(':') !== -1) return t.slice(0, 5);
    return t;
  }
  var d = row.details;
  if (d && d.charAt(0) !== '{' && d.charAt(0) !== '[') return d;
  return row.record_date ? row.record_date.slice(5) : '';
}

/** 猫一覧排泄行: 日付は別フィールドで出すため、ここでは時刻・帯のみ（MM-DD に落ちない） */
function extractExcretionTimeLabel(row) {
  if (row.recorded_time) {
    var t = row.recorded_time;
    if (t.length >= 16 && t.charAt(10) === 'T') return t.slice(11, 16);
    if (t.length >= 5 && t.indexOf(':') !== -1) return t.slice(0, 5);
    return t;
  }
  var d = row.details;
  if (d && typeof d === 'string' && d.charAt(0) !== '{' && d.charAt(0) !== '[') return d;
  return '';
}

function isoToJstYmd(iso) {
  return jstCalendarYmdFromParsedIso(iso);
}

function isoToJstHm(iso) {
  return jstHmFromParsedIso(iso);
}

/** JST 暦日から n 日前の YYYY-MM-DD（n=2 で直近3暦日の開始日） */
function jstCalendarDaysBefore(jstYmd, daysBack) {
  if (!jstYmd || jstYmd.length < 10) return jstYmd;
  return jstCalendarAddDays(jstYmd, -daysBack);
}

function sortOverviewExcretionEntries(a, b) {
  var da = a.record_date || '';
  var db = b.record_date || '';
  if (da !== db) return db.localeCompare(da);
  var ta = a.time || '';
  var tb = b.time || '';
  if (ta !== tb) return tb.localeCompare(ta);
  var ida = a.record_id != null ? Number(a.record_id) : 0;
  var idb = b.record_id != null ? Number(b.record_id) : 0;
  if (ida !== idb) return idb - ida;
  var via = a.voice_input_id != null ? Number(a.voice_input_id) : 0;
  var vib = b.voice_input_id != null ? Number(b.voice_input_id) : 0;
  return vib - via;
}

/** health_records.details を時間帯セレクト用の文字列に */
function detailsToSlot(details) {
  if (details == null || details === '') return '';
  var s = details;
  if (typeof s !== 'string') return '';
  var c0 = s.charAt(0);
  if (c0 === '{' || c0 === '[') {
    try {
      var o = JSON.parse(s);
      if (o && typeof o === 'object') {
        return String(o.slot || o.time_slot || o.details || '');
      }
    } catch (_) {}
    return '';
  }
  return s;
}

/** voice_inputs.created_records から最初の health_records:id を取得 */
function linkedHealthRecordId(createdRecordsJson) {
  if (!createdRecordsJson) return null;
  try {
    var arr = JSON.parse(createdRecordsJson);
    if (!Array.isArray(arr)) return null;
    for (var i = 0; i < arr.length; i++) {
      var s = String(arr[i] || '');
      if (s.indexOf('health_records:') === 0) {
        var id = parseInt(s.split(':')[1], 10);
        if (!isNaN(id)) return id;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * 猫一覧「猫関連付けタスク」用: テンプレの当日インスタンスのみ。
 * 手動タスク・過日の未完了イベント（ホライズンで残るもの）・監視の古い表示対象は載せない。
 * 監視タスクは完了時に基準日がクリアされるため、当日完了なら completed_at の JST 暦日で一致させる。
 */
function overviewTaskAnchorYmd(t) {
  var raw = t.scheduled_date || t.deadline_date || t.due_date;
  if (raw == null || raw === '') return '';
  return String(raw).slice(0, 10);
}

function isOverviewCatLinkedTemplateTaskForToday(t, todayYmd) {
  if (!t.template_id || String(t.template_id).trim() === '') return false;
  var a = overviewTaskAnchorYmd(t);
  if (a === todayYmd) return true;
  if (a !== '') return false;
  if ((t.status === 'done' || t.status === 'skipped') && t.completed_at) {
    return jstCalendarYmdFromParsedIso(t.completed_at) === todayYmd;
  }
  return false;
}

function jstToday() {
  return jstCalendarYmdFromInstant(Date.now());
}

function scoreColorFromValue(score) {
  if (score === null || score === undefined) return 'gray';
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  if (score >= 40) return 'orange';
  return 'red';
}

function safeParseJson(str) {
  if (!str) return null;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (_) { return null; }
}

// ── 猫一覧 項目別カードビュー ──

/** 献立行と給餌ログの meal_slot を突き合わせるための正規化（英語キーに寄せる） */
function normMealSlotForOverview(s) {
  if (s == null || s === '') return '';
  var x = String(s).toLowerCase().trim();
  if (x === '朝' || x === 'morning' || x === 'am') return 'morning';
  if (x === '昼' || x === 'afternoon' || x === 'noon' || x === 'lunch') return 'afternoon';
  if (x === '夜' || x === 'evening' || x === 'night' || x === 'pm' || x === '夕' || x === 'dinner') return 'evening';
  return x;
}

/** 献立行の表示順（朝→昼→夜）。meal_order 同値・未設定時の第2キーに使う */
function mealSlotChronologicalRankForOverview(s) {
  var n = normMealSlotForOverview(s);
  if (n === 'morning') return 1;
  if (n === 'afternoon') return 2;
  if (n === 'evening') return 3;
  if (n === 'snack') return 4;
  return 99;
}

export async function handleCatsOverview(req, env, url, staffAuth) {
  var db = env.OPS_DB;
  var locationId = url.searchParams.get('location') || staffAuth.locationId;
  var locId = resolveLocationId(locationId);
  var today = jstToday();
  var sevenDaysAgo = jstCalendarAddDays(today, -7);
  /** 排便・排尿: 猫ごと 直近3暦日（今日含む） */
  var excretionWindowStart = jstCalendarDaysBefore(today, 2);

  var statusFilter = url.searchParams.get('status') || 'active';

  if (statusFilter === 'adopted') {
    return handleOverviewAdopted(db, locId);
  }

  var catSql = "SELECT id, name, sex, status, alert_level, location_id, microchip_id, internal_note, species, meals_per_day, assigned_preset_id, water_tracking, diet_status FROM cats WHERE " + statusCondition(statusFilter);
  if (locId) catSql += " AND location_id = ?";
  catSql += " ORDER BY name";
  var overviewStmt = db.prepare(catSql);
  if (locId) overviewStmt = overviewStmt.bind(locId);
  var cats = await overviewStmt.all();
  var catRows = cats.results || [];
  if (catRows.length === 0) return opsJson({ cats: [] });

  var catIds = catRows.map(function (c) { return c.id; });

  var feedingNotesByCat = {};
  if (catIds.length > 0) {
    var cin = catIds.map(function () { return '?'; }).join(',');
    var fnSt = db.prepare("SELECT id, cat_id, note, pinned, created_at FROM cat_notes WHERE cat_id IN (" + cin + ") AND category = 'feeding' ORDER BY cat_id, pinned DESC, created_at DESC");
    fnSt = fnSt.bind.apply(fnSt, catIds);
    var fnRes = await fnSt.all();
    var fnRows = fnRes.results || [];
    for (var fni = 0; fni < fnRows.length; fni++) {
      var frow = fnRows[fni];
      var nt = String(frow.note || '').trim();
      if (!nt) continue;
      var fcid = String(frow.cat_id);
      if (!feedingNotesByCat[fcid]) feedingNotesByCat[fcid] = [];
      feedingNotesByCat[fcid].push({ id: frow.id, note: nt });
    }
  }

  var ovViSql = "SELECT id, target_cat_id, target_module, parsed_data, routing_layer, created_at, created_records FROM voice_inputs WHERE " + (locId ? "location_id = ? AND" : "location_id IN ('cafe','nekomata','endo','azukari') AND") + " date(created_at, '+9 hours') >= ? ORDER BY created_at DESC";
  var todayInputs = locId ? await db.prepare(ovViSql).bind(locId, excretionWindowStart).all() : await db.prepare(ovViSql).bind(excretionWindowStart).all();
  var todayInputRows = todayInputs.results || [];

  var ovWeekSql = "SELECT target_cat_id, routing_layer, parsed_data, target_module, created_at FROM voice_inputs WHERE " + (locId ? "location_id = ? AND" : "location_id IN ('cafe','nekomata','endo','azukari') AND") + " created_at >= ? AND routing_layer IN ('L1_with_anomaly_flag', 'L3', 'L3_completed', 'L4', 'L4_pending', 'L5') ORDER BY created_at DESC";
  var weekInputs = locId ? await db.prepare(ovWeekSql).bind(locId, sevenDaysAgo).all() : await db.prepare(ovWeekSql).bind(sevenDaysAgo).all();
  var weekAnomalyRows = weekInputs.results || [];

  var nextDay = jstCalendarAddDays(today, 1);
  /* 必要時でも当日ログが存在する（指導追加等）場合は表示する。
     定期スケジュールの日次カウントからは除外しないが、一覧上は「指導」として識別できる */
  var ovMedLogSql = "SELECT ml.id AS log_id, ml.cat_id, ml.status, ml.scheduled_at, med.name AS medicine_name, m.dosage_amount, m.dosage_unit, m.route, m.frequency AS med_frequency FROM medication_logs ml INNER JOIN medications m ON ml.medication_id = m.id AND m.active = 1 LEFT JOIN medicines med ON m.medicine_id = med.id WHERE ml.scheduled_at >= ? AND ml.scheduled_at < ? AND ml.cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ")";
  var todayMedLogs = locId ? await db.prepare(ovMedLogSql).bind(today, nextDay, locId).all() : await db.prepare(ovMedLogSql).bind(today, nextDay).all();
  var todayMedLogRows = todayMedLogs.results || [];

  // ルーティン: 暦日キーが基準日。未完了イベント: 期限が基準日以前のみ（未来期限は「今日のタスク」に含めない）。完了／スキップは暦日キーが基準日。
  var ovTaskNonMonClause =
    "((COALESCE(task_type, 'routine') != 'event' AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ?) OR (task_type = 'event' AND ((status IN ('pending', 'in_progress') AND date(COALESCE(deadline_date, due_date)) <= ?) OR (status NOT IN ('pending', 'in_progress') AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ?))))";
  var ovTaskRoutineSql = locId
    ? "SELECT id, template_id, cat_id, title, status, due_time, due_date, scheduled_date, deadline_date, task_type, completed_at, skip_streak FROM tasks WHERE location_id = ? AND (task_type IS NULL OR task_type != 'monitoring') AND (" +
      ovTaskNonMonClause +
      ')'
    : "SELECT id, template_id, cat_id, title, status, due_time, due_date, scheduled_date, deadline_date, task_type, completed_at, skip_streak FROM tasks WHERE location_id IN ('cafe','nekomata','endo','azukari') AND (task_type IS NULL OR task_type != 'monitoring') AND (" +
      ovTaskNonMonClause +
      ')';
  var ovTaskMonSql = locId
    ? "SELECT id, template_id, cat_id, title, status, due_time, task_type, due_date, scheduled_date, deadline_date, completed_at, skip_streak FROM tasks WHERE location_id = ? AND task_type = 'monitoring' AND (status = 'pending' OR expires_at IS NULL OR expires_at >= ? OR (status IN ('done','skipped') AND completed_at IS NOT NULL AND datetime(replace(substr(completed_at,1,19), 'T', ' ')) >= datetime('now', '-60 days') AND COALESCE(scheduled_date, deadline_date, due_date) IS NOT NULL))"
    : "SELECT id, template_id, cat_id, title, status, due_time, task_type, due_date, scheduled_date, deadline_date, completed_at, skip_streak FROM tasks WHERE location_id IN ('cafe','nekomata','endo','azukari') AND task_type = 'monitoring' AND (status = 'pending' OR expires_at IS NULL OR expires_at >= ? OR (status IN ('done','skipped') AND completed_at IS NOT NULL AND datetime(replace(substr(completed_at,1,19), 'T', ' ')) >= datetime('now', '-60 days') AND COALESCE(scheduled_date, deadline_date, due_date) IS NOT NULL))";
  var routineRes = locId
    ? await db.prepare(ovTaskRoutineSql).bind(locId, today, today, today).all()
    : await db.prepare(ovTaskRoutineSql).bind(today, today, today).all();
  var monRes = locId ? await db.prepare(ovTaskMonSql).bind(locId, today).all() : await db.prepare(ovTaskMonSql).bind(today).all();
  var todayTaskRows = await filterTaskRowsByTemplateRecurrence(
    db,
    (routineRes.results || []).concat(monRes.results || []),
    today
  );

  /** 猫未紐付け（共通・イベント準備など）は従来どおり各猫行に載せず、一覧用にまとめる */
  var locationTasksToday = { done: 0, total: 0, items: [] };
  for (var lti = 0; lti < todayTaskRows.length; lti++) {
    var ltt = todayTaskRows[lti];
    if (ltt.cat_id != null && String(ltt.cat_id).trim() !== '') continue;
    if (!isOverviewCatLinkedTemplateTaskForToday(ltt, today)) continue;
    locationTasksToday.total++;
    if (ltt.status === 'done') locationTasksToday.done++;
    if (ltt.status === 'pending' || ltt.status === 'in_progress') {
      locationTasksToday.items.push({
        id: ltt.id,
        title: ltt.title || 'タスク',
        status: ltt.status,
        due_time: ltt.due_time || null,
        due_date: ltt.due_date || null,
        scheduled_date: ltt.scheduled_date || null,
        deadline_date: ltt.deadline_date || null,
        task_type: ltt.task_type || null,
        skip_streak: ltt.skip_streak != null ? ltt.skip_streak : 0,
      });
    }
  }

  var ovFpSql = "SELECT fp.id AS plan_id, fp.cat_id, fp.food_id, fp.meal_slot, fp.meal_order, fp.amount_g, fp.kcal_calc, fp.notes, fp.preset_id, f.name AS food_name, f.form AS food_form FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.active = 1 AND fp.cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ")";
  var feedingPlans = locId ? await db.prepare(ovFpSql).bind(locId).all() : await db.prepare(ovFpSql).all();
  var feedingPlanRows = feedingPlans.results || [];

  var overviewPresetIdSeen = {};
  var overviewPresetIdList = [];
  function overviewAddPresetIdForBatch(v) {
    if (v == null || v === '') return;
    var k = String(v);
    if (overviewPresetIdSeen[k]) return;
    overviewPresetIdSeen[k] = true;
    overviewPresetIdList.push(v);
  }
  for (var pux0 = 0; pux0 < catRows.length; pux0++) {
    overviewAddPresetIdForBatch(catRows[pux0].assigned_preset_id);
  }
  for (var fpx0 = 0; fpx0 < feedingPlanRows.length; fpx0++) {
    overviewAddPresetIdForBatch(feedingPlanRows[fpx0].preset_id);
  }
  var overviewPresetMaps = await fetchPresetDisplayMaps(db, overviewPresetIdList);
  var overviewPresetById = overviewPresetMaps.presetById;
  var overviewItemNotesAgg = overviewPresetMaps.itemNotesAgg;
  var overviewItemNotesByPlanKey = overviewPresetMaps.itemNotesByPlanKey || {};

  var overviewFoodPrefByCat = {};
  var overviewFoodPrefCov = {};
  try {
    var fpLookback = FOOD_PREF_LOOKBACK_DAYS;
    var fpCutoff = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -fpLookback);
    overviewFoodPrefByCat = await batchAnalyzeFoodPreference(db, catIds, fpLookback);
    overviewFoodPrefCov = await fetchFoodPreferenceCoverageBatch(db, catIds, fpCutoff);
  } catch (prefErr) {
    console.warn('batchAnalyzeFoodPreference overview:', prefErr && prefErr.message);
  }

  var ovFlSql = "SELECT fl.id AS log_id, fl.cat_id, fl.eaten_pct, fl.eaten_kcal, fl.meal_slot, fl.plan_id, fl.food_id, fl.offered_g, fl.served_time, lf.form AS log_food_form FROM feeding_logs fl LEFT JOIN foods lf ON fl.food_id = lf.id WHERE fl.log_date = ? AND fl.cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ")";
  var todayFeedingLogs = locId ? await db.prepare(ovFlSql).bind(today, locId).all() : await db.prepare(ovFlSql).bind(today).all();
  var todayFeedingLogRows = todayFeedingLogs.results || [];

  /** 一覧から「昨日の誤ったあげた記録」を取り消すため（当日分は feeding_plan 側の log_id で取消可能） */
  var yesterdayYmd = jstCalendarDaysBefore(today, 1);
  var ovFlYestSql = "SELECT fl.id AS log_id, fl.cat_id, fl.eaten_pct, fl.meal_slot, fl.plan_id, fl.offered_g, fl.served_time, COALESCE(f.name, pf.name) AS food_name FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id LEFT JOIN feeding_plans fp ON fl.plan_id = fp.id LEFT JOIN foods pf ON fp.food_id = pf.id WHERE fl.log_date = ? AND fl.cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ") ORDER BY fl.meal_slot, fl.id";
  var yestFeedingLogs = locId ? await db.prepare(ovFlYestSql).bind(yesterdayYmd, locId).all() : await db.prepare(ovFlYestSql).bind(yesterdayYmd).all();
  var yestFeedingLogRows = yestFeedingLogs.results || [];

  var ovHrSql = "SELECT hr.cat_id, hr.record_type, hr.next_due FROM health_records hr WHERE hr.record_type IN ('vaccine', 'checkup') AND hr.next_due IS NOT NULL AND hr.cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ") ORDER BY hr.record_date DESC";
  var healthDue = locId ? await db.prepare(ovHrSql).bind(locId).all() : await db.prepare(ovHrSql).all();
  var healthDueRows = healthDue.results || [];

  var liveHealthByCatId = {};
  if (catRows.length > 0) {
    var ovLivePromises = [];
    for (var ovi = 0; ovi < catRows.length; ovi++) {
      ovLivePromises.push(calculateHealthScore(db, catRows[ovi].id, today));
    }
    var ovLiveResults = await Promise.all(ovLivePromises);
    for (var ovj = 0; ovj < catRows.length; ovj++) {
      liveHealthByCatId[catRows[ovj].id] = ovLiveResults[ovj];
    }
  }

  // 飲水測定: 直近2日（昨日のステータスを一覧に表示）
  var ovWaterSql = "SELECT wm.id, wm.cat_id, wm.measurement_date, wm.set_weight_g, wm.measure_weight_g, wm.consumed_ml, wm.total_intake_ml, wm.status, wm.intake_per_kg FROM water_measurements wm WHERE wm.measurement_date >= ? AND wm.cat_id IN (SELECT id FROM cats WHERE water_tracking = 1 AND " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ") ORDER BY wm.measurement_date DESC";
  var waterFrom = jstCalendarDaysBefore(today, 1);
  var waterRows = locId ? (await db.prepare(ovWaterSql).bind(waterFrom, locId).all()).results || [] : (await db.prepare(ovWaterSql).bind(waterFrom).all()).results || [];

  var ovWeightSql = "SELECT id, cat_id, value, record_date, created_at FROM health_records WHERE record_type = 'weight' AND cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ") ORDER BY record_date DESC";
  var weightRecords = locId ? await db.prepare(ovWeightSql).bind(locId).all() : await db.prepare(ovWeightSql).all();
  var weightRows = weightRecords.results || [];

  var ovStoolSql = "SELECT id, cat_id, record_type, value, details, record_date, recorded_time, created_at FROM health_records WHERE record_type IN ('stool', 'urination', 'urine') AND record_date >= ? AND cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ") ORDER BY record_date DESC, id DESC";
  var stoolRecords = locId ? await db.prepare(ovStoolSql).bind(excretionWindowStart, locId).all() : await db.prepare(ovStoolSql).bind(excretionWindowStart).all();
  var stoolRows = stoolRecords.results || [];

  var ovMedRecSql = "SELECT cat_id, value, details, record_date FROM health_records WHERE record_type = 'medication' AND record_date >= ? AND cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ") ORDER BY record_date DESC";
  var medRecords = locId ? await db.prepare(ovMedRecSql).bind(sevenDaysAgo, locId).all() : await db.prepare(ovMedRecSql).bind(sevenDaysAgo).all();
  var medRecordRows = medRecords.results || [];

  /** はき戻し: 直近7暦日（嘔吐専用 + 経過観察内のはき戻し表現）。猫一覧で全頭サマリ・入力導線用 */
  var ovVomitSql =
    "SELECT cat_id, record_date, value FROM health_records WHERE record_date >= ? AND cat_id IN (SELECT id FROM cats WHERE " +
    statusCondition(statusFilter) +
    (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") +
    ") AND (record_type = 'vomiting' OR (record_type = 'observation' AND (COALESCE(value,'') LIKE '%はき戻し%' OR COALESCE(value,'') LIKE '%嘔吐%' OR COALESCE(value,'') LIKE '%吐いた%' OR COALESCE(details,'') LIKE '%はき戻し%' OR COALESCE(details,'') LIKE '%嘔吐%' OR COALESCE(details,'') LIKE '%吐いた%')))";
  var vomitRecords = locId ? await db.prepare(ovVomitSql).bind(sevenDaysAgo, locId).all() : await db.prepare(ovVomitSql).bind(sevenDaysAgo).all();
  var vomitRecordRows = vomitRecords.results || [];
  var vomit7dMap = {};
  var vomitTodayMap = {};
  for (var vomi = 0; vomi < vomitRecordRows.length; vomi++) {
    var vrow = vomitRecordRows[vomi];
    var vcnt = 1;
    var vmatch = (vrow.value || '').match(/(\d+)\s*回/);
    if (vmatch) vcnt = parseInt(vmatch[1], 10) || 1;
    var vCatId = vrow.cat_id;
    vomit7dMap[vCatId] = (vomit7dMap[vCatId] || 0) + vcnt;
    if ((vrow.record_date || '') === today) {
      vomitTodayMap[vCatId] = (vomitTodayMap[vCatId] || 0) + vcnt;
    }
  }

  var ovCareSql = "SELECT id, cat_id, value, details, record_type, record_date, created_at FROM health_records WHERE record_type IN ('care', 'eye_discharge') AND record_date = ? AND cat_id IN (SELECT id FROM cats WHERE " + statusCondition(statusFilter) + (locId ? " AND location_id = ?" : " AND location_id IN ('cafe','nekomata','endo','azukari')") + ") ORDER BY record_date DESC";
  var careRecords = locId ? await db.prepare(ovCareSql).bind(today, locId).all() : await db.prepare(ovCareSql).bind(today).all();
  var careRows = careRecords.results || [];

  /** cats.water_tracking（D1 の型ブレ対策。truthy 汎用は "0" 文字列等で誤判定するため禁止） */
  function catRowWaterTrackingOn(catRow) {
    var v = catRow.water_tracking;
    return v === 1 || v === true || String(v) === '1';
  }

  var result = [];
  for (var i = 0; i < catRows.length; i++) {
    var cat = catRows[i];
    var cid = cat.id;

    var stoolToday = [];
    var urineToday = [];

    // 排便: health_records（猫ごと 直近3暦日の全件）→ 一覧から編集可能（record_id）
    for (var js1 = 0; js1 < stoolRows.length; js1++) {
      if (stoolRows[js1].cat_id !== cid) continue;
      if (stoolRows[js1].record_type === 'urination' || stoolRows[js1].record_type === 'urine') continue;
      var sd = stoolRows[js1].record_date || '';
      if (sd < excretionWindowStart) continue;
      stoolToday.push({
        record_id: stoolRows[js1].id,
        source: 'health_record',
        status: toJaStatus(stoolRows[js1].value, false),
        time: extractExcretionTimeLabel(stoolRows[js1]),
        record_date: stoolRows[js1].record_date,
        value_raw: stoolRows[js1].value,
        details_slot: detailsToSlot(stoolRows[js1].details),
      });
    }
    // 排尿: health_records（猫ごと 直近3暦日の全件）
    for (var ju1 = 0; ju1 < stoolRows.length; ju1++) {
      if (stoolRows[ju1].cat_id !== cid) continue;
      if (stoolRows[ju1].record_type !== 'urination' && stoolRows[ju1].record_type !== 'urine') continue;
      var ud = stoolRows[ju1].record_date || '';
      if (ud < excretionWindowStart) continue;
      urineToday.push({
        record_id: stoolRows[ju1].id,
        source: 'health_record',
        status: toJaStatus(stoolRows[ju1].value, true),
        time: extractExcretionTimeLabel(stoolRows[ju1]),
        record_date: stoolRows[ju1].record_date,
        value_raw: stoolRows[ju1].value,
        details_slot: detailsToSlot(stoolRows[ju1].details),
      });
    }

    var stoolHrIdSet = {};
    for (var sh = 0; sh < stoolToday.length; sh++) {
      if (stoolToday[sh].record_id) stoolHrIdSet[stoolToday[sh].record_id] = true;
    }
    var urineHrIdSet = {};
    for (var uh = 0; uh < urineToday.length; uh++) {
      if (urineToday[uh].record_id) urineHrIdSet[urineToday[uh].record_id] = true;
    }

    var hrIdToVoiceInputId = {};
    for (var vix = 0; vix < todayInputRows.length; vix++) {
      var vrow = todayInputRows[vix];
      var lid = linkedHealthRecordId(vrow.created_records);
      if (lid) hrIdToVoiceInputId[lid] = vrow.id;
    }
    for (var se = 0; se < stoolToday.length; se++) {
      if (stoolToday[se].record_id && hrIdToVoiceInputId[stoolToday[se].record_id]) {
        stoolToday[se].voice_input_id = hrIdToVoiceInputId[stoolToday[se].record_id];
      }
    }
    for (var ue = 0; ue < urineToday.length; ue++) {
      if (urineToday[ue].record_id && hrIdToVoiceInputId[urineToday[ue].record_id]) {
        urineToday[ue].voice_input_id = hrIdToVoiceInputId[urineToday[ue].record_id];
      }
    }

    // voice_inputs（直近3暦日・JST）— 健康記録と重複する行は省略（編集は health 行で可能・音声バッジ表示）
    for (var j = 0; j < todayInputRows.length; j++) {
      var inp = todayInputRows[j];
      if (inp.target_cat_id !== cid) continue;
      if (inp.target_module !== 'stool' && inp.target_module !== 'health') continue;
      var pd = safeParseJson(inp.parsed_data);
      var pp = pd ? (pd.parsed || pd) : {};
      if (!pd) continue;
      var rt = pd.record_type || '';
      var linkedHr = linkedHealthRecordId(inp.created_records);
      var vRecDate = (pp.record_date && String(pp.record_date).length >= 10) ? String(pp.record_date).slice(0, 10) : isoToJstYmd(inp.created_at);
      if (!vRecDate || vRecDate < excretionWindowStart) continue;
      var vTime = String(pp.slot || pp.time_slot || '').trim();
      if (!vTime) vTime = isoToJstHm(inp.created_at);
      if (rt === 'urination' || rt === 'urine') {
        if (linkedHr && urineHrIdSet[linkedHr]) continue;
        urineToday.push({
          source: 'voice',
          voice_input_id: inp.id,
          voice_linked_record_id: linkedHr,
          status: toJaStatus(pp.status || pp.consistency, true),
          value_raw: pp.status || pp.consistency || pp.symptom || '',
          details_slot: String(pp.slot || pp.time_slot || ''),
          record_date: vRecDate,
          time: vTime,
        });
      } else if (rt === 'stool' || pd.module === 'stool' || inp.target_module === 'stool') {
        if (linkedHr && stoolHrIdSet[linkedHr]) continue;
        stoolToday.push({
          source: 'voice',
          voice_input_id: inp.id,
          voice_linked_record_id: linkedHr,
          status: toJaStatus(pp.status || pp.symptom || pp.consistency, false),
          value_raw: pp.status || pp.symptom || pp.consistency || '',
          details_slot: String(pp.slot || pp.time_slot || ''),
          record_date: vRecDate,
          time: vTime,
        });
      }
    }

    stoolToday.sort(sortOverviewExcretionEntries);
    urineToday.sort(sortOverviewExcretionEntries);

    // medication_logs からの投薬（詳細配列）
    var medsDone = 0; var medsTotal = 0; var medsItems = [];
    for (var j = 0; j < todayMedLogRows.length; j++) {
      if (todayMedLogRows[j].cat_id !== cid) continue;
      medsTotal++;
      var mlRow = todayMedLogRows[j];
      if (mlRow.status === 'done') medsDone++;
      var slotRaw = (mlRow.scheduled_at || '').split('T')[1] || '';
      var slotLabel = slotRaw === '朝' || slotRaw === '昼' || slotRaw === '晩' ? slotRaw : slotRaw.slice(0, 5);
      var dosageStr = '';
      if (mlRow.dosage_amount) {
        dosageStr = mlRow.dosage_amount + (mlRow.dosage_unit || '');
      }
      medsItems.push({
        log_id: mlRow.log_id,
        name: mlRow.medicine_name || '不明',
        slot: slotLabel,
        status: mlRow.status || 'pending',
        dosage: dosageStr,
        route: mlRow.route || '',
        is_prn: mlRow.med_frequency === '必要時',  /* 必要時（指導）フラグ */
      });
    }

    var tasksDone = 0; var tasksTotal = 0; var tasksItems = [];
    for (var j = 0; j < todayTaskRows.length; j++) {
      var t = todayTaskRows[j];
      if (t.cat_id == null || t.cat_id === '' || String(t.cat_id) !== String(cid)) continue;
      if (!isOverviewCatLinkedTemplateTaskForToday(t, today)) continue;
      tasksTotal++;
      if (t.status === 'done') tasksDone++;
      if (t.status === 'pending' || t.status === 'in_progress') {
        tasksItems.push({
          id: t.id,
          title: t.title || 'タスク',
          status: t.status,
          due_time: t.due_time || null,
          due_date: t.due_date || null,
          scheduled_date: t.scheduled_date || null,
          deadline_date: t.deadline_date || null,
          task_type: t.task_type || null,
          skip_streak: t.skip_streak != null ? t.skip_streak : 0,
        });
      }
    }

    var anomalies7d = [];
    var anomalyMap = {};
    for (var j = 0; j < weekAnomalyRows.length; j++) {
      var wa = weekAnomalyRows[j];
      if (wa.target_cat_id !== cid) continue;
      var pd = safeParseJson(wa.parsed_data);
      var pp = pd ? (pd.parsed || pd) : {};
      var aType = pp.symptom || pp.status || wa.target_module || '異常';
      if (!anomalyMap[aType]) anomalyMap[aType] = { type: aType, count: 0, note: '' };
      anomalyMap[aType].count++;
    }
    for (var key in anomalyMap) {
      anomalies7d.push(anomalyMap[key]);
    }

    var feedingPlan = [];
    for (var j = 0; j < feedingPlanRows.length; j++) {
      if (feedingPlanRows[j].cat_id !== cid) continue;
      var rowPid = feedingPlanRows[j].preset_id != null ? feedingPlanRows[j].preset_id : null;
      var rowFid = feedingPlanRows[j].food_id != null ? feedingPlanRows[j].food_id : null;
      var pinLookupKey =
        rowPid != null && rowFid != null
          ? String(rowPid) + '|' + String(rowFid) + '|' + normMealSlotForOverview(feedingPlanRows[j].meal_slot)
          : null;
      var presetItemNotes =
        pinLookupKey && overviewItemNotesByPlanKey[pinLookupKey] ? overviewItemNotesByPlanKey[pinLookupKey] : null;
      feedingPlan.push({
        plan_id: feedingPlanRows[j].plan_id != null ? feedingPlanRows[j].plan_id : null,
        food_id: rowFid,
        meal_order: feedingPlanRows[j].meal_order != null ? feedingPlanRows[j].meal_order : null,
        food_name: feedingPlanRows[j].food_name,
        meal_slot: feedingPlanRows[j].meal_slot,
        amount_g: feedingPlanRows[j].amount_g,
        notes: feedingPlanRows[j].notes || null,
        preset_id: rowPid,
        preset_item_notes: presetItemNotes && String(presetItemNotes).trim() !== '' ? String(presetItemNotes).trim() : null
      });
    }

    var slotCountByNorm = {};
    for (var sc = 0; sc < feedingPlan.length; sc++) {
      var sn = normMealSlotForOverview(feedingPlan[sc].meal_slot);
      if (!sn) continue;
      slotCountByNorm[sn] = (slotCountByNorm[sn] || 0) + 1;
    }

    var catLogsToday = [];
    for (var jl0 = 0; jl0 < todayFeedingLogRows.length; jl0++) {
      if (todayFeedingLogRows[jl0].cat_id === cid) catLogsToday.push(todayFeedingLogRows[jl0]);
    }

    var feedingLogsYesterday = [];
    for (var jly = 0; jly < yestFeedingLogRows.length; jly++) {
      if (yestFeedingLogRows[jly].cat_id !== cid) continue;
      var yr = yestFeedingLogRows[jly];
      feedingLogsYesterday.push({
        log_id: yr.log_id != null ? yr.log_id : null,
        meal_slot: yr.meal_slot || null,
        food_name: yr.food_name || null,
        eaten_pct: yr.eaten_pct != null ? yr.eaten_pct : null,
        offered_g: yr.offered_g != null ? yr.offered_g : null,
        served_time: yr.served_time || null,
        plan_id: yr.plan_id != null ? yr.plan_id : null,
      });
    }

    for (var fpi = 0; fpi < feedingPlan.length; fpi++) {
      var fpItem = feedingPlan[fpi];
      var fedLine = false;
      var eatenLine = null;
      var logIdLine = null;
      var logIdsCsv = '';
      var offeredGLog = null;
      var servedTimeLine = null;
      var pid = fpItem.plan_id;
      var matchedLogs = [];

      function applyMatchedFeedingLogs(arr) {
        if (!arr || arr.length === 0) return;
        arr = arr.slice().sort(function (a, b) {
          return (Number(a.log_id) || 0) - (Number(b.log_id) || 0);
        });
        var lastLg = arr[arr.length - 1];
        fedLine = true;
        if (lastLg.eaten_pct != null) eatenLine = lastLg.eaten_pct;
        if (lastLg.log_id != null) logIdLine = lastLg.log_id;
        var idParts = [];
        for (var idi = 0; idi < arr.length; idi++) {
          if (arr[idi].log_id != null) idParts.push(String(arr[idi].log_id));
        }
        logIdsCsv = idParts.join(',');
        if (lastLg.offered_g != null) offeredGLog = lastLg.offered_g;
        if (lastLg.served_time != null && lastLg.served_time !== '') servedTimeLine = lastLg.served_time;
      }

      if (pid != null) {
        for (var li = 0; li < catLogsToday.length; li++) {
          var lg = catLogsToday[li];
          if (lg.plan_id != null && Number(lg.plan_id) === Number(pid)) {
            matchedLogs.push(lg);
          }
        }
      }
      if (matchedLogs.length > 0) {
        applyMatchedFeedingLogs(matchedLogs);
      } else {
        var pnorm = normMealSlotForOverview(fpItem.meal_slot);
        var allowSlotFallback = pnorm && (slotCountByNorm[pnorm] || 0) === 1;
        if (allowSlotFallback) {
          matchedLogs = [];
          for (var li2 = 0; li2 < catLogsToday.length; li2++) {
            var lg2 = catLogsToday[li2];
            if (normMealSlotForOverview(lg2.meal_slot) === pnorm) {
              matchedLogs.push(lg2);
            }
          }
          if (matchedLogs.length > 0) applyMatchedFeedingLogs(matchedLogs);
        }
      }
      fpItem.fed_today = fedLine;
      fpItem.eaten_pct_today = eatenLine;
      fpItem.log_id = logIdLine;
      fpItem.log_ids_csv = logIdsCsv;
      fpItem.offered_g_log = offeredGLog;
      fpItem.fed_served_time = servedTimeLine;
    }

    feedingPlan.sort(function (a, b) {
      var oa = a.meal_order != null ? Number(a.meal_order) : null;
      var ob = b.meal_order != null ? Number(b.meal_order) : null;
      if (oa !== null && ob !== null && oa !== ob) return oa - ob;
      if (oa !== null && ob === null) return -1;
      if (oa === null && ob !== null) return 1;
      var ra = mealSlotChronologicalRankForOverview(a.meal_slot);
      var rb = mealSlotChronologicalRankForOverview(b.meal_slot);
      if (ra !== rb) return ra - rb;
      var pa = a.plan_id != null ? Number(a.plan_id) : 0;
      var pb = b.plan_id != null ? Number(b.plan_id) : 0;
      return pa - pb;
    });

    var feedingTodayTotal = 0; var feedingTodayCount = 0; var feedingTodayKcal = 0;
    for (var j = 0; j < todayFeedingLogRows.length; j++) {
      if (todayFeedingLogRows[j].cat_id !== cid) continue;
      if (todayFeedingLogRows[j].eaten_pct != null) {
        feedingTodayTotal += todayFeedingLogRows[j].eaten_pct;
        feedingTodayCount++;
      }
      feedingTodayKcal += (todayFeedingLogRows[j].eaten_kcal || 0);
    }
    var feedingTodayPct = feedingTodayCount > 0 ? Math.round(feedingTodayTotal / feedingTodayCount) : null;

    var fedSlots = {};
    for (var j = 0; j < todayFeedingLogRows.length; j++) {
      if (todayFeedingLogRows[j].cat_id === cid && todayFeedingLogRows[j].meal_slot) {
        fedSlots[todayFeedingLogRows[j].meal_slot] = true;
      }
    }
    var fedCount = Object.keys(fedSlots).length;

    var vaccineDue = null; var checkupDue = null;
    var seenVaccine = false; var seenCheckup = false;
    for (var j = 0; j < healthDueRows.length; j++) {
      var hd = healthDueRows[j];
      if (hd.cat_id !== cid) continue;
      if (hd.record_type === 'vaccine' && !seenVaccine) { vaccineDue = hd.next_due; seenVaccine = true; }
      if (hd.record_type === 'checkup' && !seenCheckup) { checkupDue = hd.next_due; seenCheckup = true; }
    }

    var healthScore = null;
    var healthComments = [];
    var liveOv = liveHealthByCatId[cid];
    if (liveOv) {
      healthScore = liveOv.total_score;
      healthComments = liveOv.comments || [];
    }

    var weightLatest = null; var weightPrevious = null; var weightTrend = 'stable';
    var weightRecordDate = null;
    var weightRecordedAt = null;
    var weightRecordedToday = false;
    var wRows = [];
    for (var jw = 0; jw < weightRows.length; jw++) {
      if (weightRows[jw].cat_id !== cid) continue;
      wRows.push(weightRows[jw]);
    }
    wRows.sort(function (a, b) {
      var da = a.record_date || '';
      var db = b.record_date || '';
      if (da !== db) return db.localeCompare(da);
      var ca = (a.created_at || '');
      var cb = (b.created_at || '');
      if (ca !== cb) return cb.localeCompare(ca);
      return (b.id || 0) - (a.id || 0);
    });
    if (wRows.length > 0) {
      weightLatest = parseFloat(wRows[0].value);
      weightRecordDate = wRows[0].record_date || null;
      weightRecordedAt = wRows[0].created_at || null;
      weightRecordedToday = weightRecordDate === today;
    }
    if (wRows.length > 1) weightPrevious = parseFloat(wRows[1].value);
    if (weightLatest !== null && weightPrevious !== null) {
      var diff = weightLatest - weightPrevious;
      if (diff > 0.05) weightTrend = 'up';
      else if (diff < -0.05) weightTrend = 'down';
      else weightTrend = 'stable';
    }

    // ケアデータ（その猫の最新暦日＋同日は項目ごとに created_at 最新）
    var careLatest = [];
    var latestCareDate = null;
    var cRows = [];
    for (var jc = 0; jc < careRows.length; jc++) {
      if (careRows[jc].cat_id !== cid) continue;
      cRows.push(careRows[jc]);
    }
    for (var k0 = 0; k0 < cRows.length; k0++) {
      var rd0 = cRows[k0].record_date || '';
      if (!latestCareDate || rd0 > latestCareDate) latestCareDate = rd0;
    }
    var byCareKey = {};
    for (var k1 = 0; k1 < cRows.length; k1++) {
      var cr = cRows[k1];
      if (cr.record_date !== latestCareDate) continue;
      var careType = cr.record_type === 'eye_discharge' ? '目ヤニ拭き' : (cr.details || '');
      var ckey = (cr.record_type || '') + '|' + String(careType);
      var cAt = cr.created_at || '';
      var prevCare = byCareKey[ckey];
      if (!prevCare || cAt >= (prevCare.created_at || '')) {
        byCareKey[ckey] = { created_at: cAt, row: cr, careType: careType };
      }
    }
    for (var ck in byCareKey) {
      if (!Object.prototype.hasOwnProperty.call(byCareKey, ck)) continue;
      var br = byCareKey[ck].row;
      var ct = byCareKey[ck].careType;
      careLatest.push({
        id: br.id,
        type: ct,
        by: br.value || '',
        done: br.value !== '×' && br.value !== 'ー'
      });
    }

    // 飲水測定（一覧インライン入力用に id・セット重量・本日行も付与）
    var waterToday = null;
    var waterSetToday = null;
    if (catRowWaterTrackingOn(cat)) {
      for (var wri = 0; wri < waterRows.length; wri++) {
        if (waterRows[wri].cat_id !== cid) continue;
        if (waterRows[wri].measurement_date === yesterdayYmd) {
          var wSet = waterRows[wri].set_weight_g;
          var wMeas = waterRows[wri].measure_weight_g;
          waterToday = {
            id: waterRows[wri].id,
            date: waterRows[wri].measurement_date,
            status: waterRows[wri].status || null,
            total_ml: waterRows[wri].total_intake_ml != null ? waterRows[wri].total_intake_ml : null,
            intake_per_kg: waterRows[wri].intake_per_kg != null ? waterRows[wri].intake_per_kg : null,
            pending: wSet != null && wMeas == null,
            set_weight_g: wSet != null ? wSet : null,
            measure_weight_g: wMeas != null ? wMeas : null,
          };
        }
        if (waterRows[wri].measurement_date === today) {
          waterSetToday = {
            id: waterRows[wri].id,
            set_weight_g: waterRows[wri].set_weight_g != null ? waterRows[wri].set_weight_g : null,
            measure_weight_g: waterRows[wri].measure_weight_g != null ? waterRows[wri].measure_weight_g : null,
          };
        }
      }
    }

    var presetIdsForCat = collectPresetIdsOrdered(cat.assigned_preset_id, feedingPlan);
    var presetResolved = resolvePresetDisplayNameDescription(
      presetIdsForCat,
      overviewPresetById,
      overviewItemNotesAgg
    );

    result.push({
      id: cid,
      name: cat.name,
      species: cat.species || 'cat',
      status: cat.status,
      location_id: cat.location_id || null,
      alert_level: cat.alert_level || 'normal',
      health_score: healthScore,
      score_color: healthScore !== null ? scoreColorFromValue(healthScore) : 'gray',
      weight_latest: weightLatest,
      weight_previous: weightPrevious,
      weight_trend: weightTrend,
      weight_record_date: weightRecordDate,
      weight_recorded_at: weightRecordedAt,
      weight_recorded_today: weightRecordedToday,
      stool_today: stoolToday,
      urine_today: urineToday,
      meds_today: { done: medsDone, total: medsTotal, items: medsItems },
      tasks_today: { done: tasksDone, total: tasksTotal, items: tasksItems },
      anomalies_7d: anomalies7d,
      feeding_plan: feedingPlan,
      feeding_today_pct: feedingTodayPct,
      feeding_today_kcal: feedingTodayKcal > 0 ? Math.round(feedingTodayKcal * 10) / 10 : null,
      vaccine_next_due: vaccineDue,
      checkup_next_due: checkupDue,
      microchip: cat.microchip_id ? 'registered' : 'none',
      care_latest: careLatest,
      care_date: latestCareDate,
      health_comments: healthComments,
      meals_per_day: cat.meals_per_day || null,
      fed_count: fedCount,
      assigned_preset_id: cat.assigned_preset_id != null ? cat.assigned_preset_id : null,
      assigned_preset_name: presetResolved.name,
      assigned_preset_description: presetResolved.description,
      feeding_cat_notes: feedingNotesByCat[String(cid)] || [],
      diet_status: cat.diet_status || 'normal',
      water_tracking: catRowWaterTrackingOn(cat),
      water_today: waterToday,
      water_set_today: waterSetToday,
      feeding_logs_yesterday: feedingLogsYesterday,
      food_preference_summary: summarizeFoodPreferences(
        overviewFoodPrefByCat[String(cid)] || [],
        FOOD_PREF_LOOKBACK_DAYS,
        overviewFoodPrefCov[String(cid)]
      ),
      vomit_7d: vomit7dMap[cid] || 0,
      vomit_today: vomitTodayMap[cid] || 0,
    });
  }

  result.sort(function (a, b) {
    var sa = a.health_score !== null ? a.health_score : 999;
    var sb = b.health_score !== null ? b.health_score : 999;
    return sa - sb;
  });

  return opsJson({ cats: result, location_tasks_today: locationTasksToday });
}
