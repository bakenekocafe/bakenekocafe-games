/**
 * NYAGI 健康管理ハンドラ（P4 CRUD 完全実装）
 *
 * GET  /health/records?cat_id=xxx          → 記録一覧
 * GET  ...&scope=clinic                    → 病院9種のみ（体重・ケア・給餌・日報等は除外）。掲示板も同じ。
 * GET  /health/records/:id                 → 記録詳細
 * POST /health/records                     → 記録作成
 * POST /health/records/:id/file            → 添付追加（multipart field: file 複数可・既存は残す）
 * GET  /health/records/:id/files/:fileId   → 特定添付の配信
 * DELETE /health/records/:id/files/:fileId  → 特定添付の削除
 * GET  /health/records/:id/file            → 最新1件の配信（互換用）
 * PUT  /health/records/:id                 → 記録更新
 * GET  /health/medications?cat_id=xxx      → 投薬スケジュール一覧
 * POST /health/medications                 → 投薬スケジュール作成
 * PUT  /health/medications/:id             → 投薬スケジュール更新（終了含む）
 * GET  /health/medication-logs?cat_id=xxx&date=xxx → 投薬ログ一覧
 * POST /health/medication-logs/:id/done   → 投薬実施記録
 * POST /health/medication-logs/:id/skip  → 投薬スキップ記録
 * POST /health/medication-logs/:id/undo  → 未投与に戻す（あげた・スキップの取消）
 * POST /health/medication-logs/:id       → JSON body { "action": "done"|"skip"|"undo", ... }（上記と同等・プロキシ互換用）
 * GET  /health/medicines?species=cat        → 薬マスター一覧（species フィルタ対応）
 * POST /health/medicines                   → 薬マスター登録
 * PUT  /health/medicines/:id               → 薬マスター更新
 * GET  /health/weight-history?cat_id=xxx&months=6 → 体重履歴（グラフ用）
 */

import { opsJson } from './router.js';
import { syncProductDict, resyncProductDict } from './product-dict.js';
import { refreshNutritionProfile } from './nutrition.js';
import { sendSlackMessage, shareBinaryFileToSlack, resolveNyagiReportSlackChannel } from './slack-notify.js';
import { jstCalendarYmdFromInstant, jstCalendarAddDays, jstNowIsoTimestamp } from './jst-util.js';
import { sqlStatusInCare, sqlStatusCondition } from './cat-status.js';
import { attachThreadCommentsTo } from './thread-comments.js';

/**
 * 病院記録の編集・削除ガード。
 * 投稿者本人（health_records.recorded_by）または role=owner のみ可。
 */
function isRecordOwnerOrSelf(staffAuth, row) {
  if (!staffAuth || !row) return false;
  if (staffAuth.role === 'owner') return true;
  var rowStaffId = row.recorded_by != null ? String(row.recorded_by) : '';
  var myStaffId = staffAuth.staffId != null ? String(staffAuth.staffId) : '';
  return !!rowStaffId && rowStaffId === myStaffId;
}

/** JST の HH:mm（ケア記録の recorded_time 用） */
function formatJstTimeHm() {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

var VALID_RECORD_TYPES = [
  'weight', 'vaccine', 'checkup', 'surgery', 'medication_start', 'medication_end',
  'dental', 'emergency', 'observation', 'test',
  'care', 'eye_discharge', 'stool', 'urine', 'medication', 'vomiting',
];

var CARE_TYPES = [
  { id: 'brush', label: 'ブラシ', record_type: 'care' },
  { id: 'chin', label: 'アゴ', record_type: 'care' },
  { id: 'ear', label: '耳', record_type: 'care' },
  { id: 'nail', label: '爪切り', record_type: 'care' },
  { id: 'paw', label: '肉球', record_type: 'care' },
  { id: 'butt', label: 'お尻', record_type: 'care' },
  { id: 'eye', label: '目ヤニ拭き', record_type: 'eye_discharge' },
];

export async function handleHealth(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  // ── 薬マスター ──────────────────────────────────────────────────────────────
  if (subPath.indexOf('/medicines') === 0) {
    return handleMedicines(method, req, db, staffAuth, subPath, env);
  }

  // ── 体重履歴 ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && subPath.indexOf('/weight-history') === 0) {
    return handleWeightHistory(url, db);
  }

  // ── 投薬プリセット ─────────────────────────────────────────────────────────────
  if (subPath.indexOf('/medication-presets') === 0) {
    return handleMedicationPresets(method, req, db, staffAuth, url, subPath);
  }

  // ── 飲水測定 ─────────────────────────────────────────────────────────────────
  if (subPath.indexOf('/water') === 0) {
    return handleWater(method, req, db, staffAuth, url, subPath);
  }

  // ── 投薬ログ ─────────────────────────────────────────────────────────────────
  if (subPath.indexOf('/medication-logs') === 0) {
    return handleMedicationLogs(method, req, db, staffAuth, url, subPath);
  }

  // ── 投薬スケジュール ──────────────────────────────────────────────────────────
  if (subPath.indexOf('/medications') === 0) {
    return handleMedications(method, req, db, staffAuth, url, subPath);
  }

  // ── ケア項目マスタ ───────────────────────────────────────────────────────────
  if (method === 'GET' && (subPath === '/care-types' || subPath === '/care-types/')) {
    return opsJson({ care_types: CARE_TYPES });
  }

  // ── 排便・排尿ステータスマスタ ─────────────────────────────────────────────────
  if (method === 'GET' && subPath === '/stool-statuses') {
    return opsJson({
      statuses: [
        { value: '健康', label: '健康' },
        { value: '硬い', label: '硬い' },
        { value: '軟便', label: '軟便' },
        { value: '下痢', label: '下痢' },
        { value: '血便小', label: '血便小（いつもの程度）' },
        { value: '血便大（異常）', label: '血便大（異常）' },
      ],
    });
  }
  if (method === 'GET' && subPath === '/urine-statuses') {
    return opsJson({
      statuses: [
        { value: 'なし（異常）', label: 'なし（異常）' },
        { value: 'なし', label: 'なし' },
        { value: '少量', label: '少量' },
        { value: '普通', label: '普通' },
        { value: '多い', label: '多い' },
        { value: '血尿小', label: '血尿小' },
        { value: '血尿大（異常）', label: '血尿大（異常）' },
      ],
    });
  }

  // ── 健康記録 ─────────────────────────────────────────────────────────────────
  if (subPath.indexOf('/records') === 0) {
    return handleRecords(method, req, env, db, staffAuth, url, subPath);
  }

  return opsJson({ error: 'not_found', message: 'Health endpoint not found' }, 404);
}

// ───────────────────────────────────────────────────────────────────────────────
// 健康記録
// ───────────────────────────────────────────────────────────────────────────────

async function handleRecords(method, req, env, db, staffAuth, url, subPath) {
  var r2 = env.NYAGI_FILES;

  // /records/:id/files/:fileId — GET: 配信 / DELETE: 1件削除
  var fileByIdMatch = subPath.match(/^\/records\/(\d+)\/files\/(\d+)$/);
  if (fileByIdMatch) {
    var recIdForFile = Number(fileByIdMatch[1]);
    var filePk = Number(fileByIdMatch[2]);
    if (method === 'GET') {
      return serveHealthRecordFileById(env, db, recIdForFile, filePk);
    }
    if (method === 'DELETE') {
      return deleteOneHealthRecordFile(db, r2, recIdForFile, filePk);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /records/:id/file — GET: 最新1件配信 / POST: multipart（複数追加）
  var fileMatch = subPath.match(/^\/records\/(\d+)\/file$/);
  if (fileMatch) {
    if (method === 'GET') {
      var fileRow = await db.prepare(
        "SELECT r2_key, original_name, mime_type FROM files WHERE module = 'health_record' AND ref_id = ? ORDER BY id DESC LIMIT 1"
      ).bind(String(fileMatch[1])).first();
      if (!fileRow || !fileRow.r2_key) return opsJson({ error: 'not_found', message: 'No file attached' }, 404);

      var obj = await r2.get(fileRow.r2_key);
      if (!obj) return opsJson({ error: 'not_found', message: 'File not found in storage' }, 404);

      var headers = new Headers();
      headers.set('Content-Type', fileRow.mime_type || 'application/octet-stream');
      headers.set('Content-Disposition', 'inline; filename="' + (fileRow.original_name || 'file') + '"');
      headers.set('Cache-Control', 'private, max-age=3600');
      return new Response(obj.body, { headers: headers });
    }
    if (method === 'POST') {
      return uploadHealthRecordFile(req, env, db, staffAuth, Number(fileMatch[1]));
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /records/:id
  var idMatch = subPath.match(/^\/records\/(\d+)$/);

  if (method === 'GET' && idMatch) {
    var row = await db.prepare(
      'SELECT hr.id, hr.cat_id, hr.location_id, hr.record_type, hr.record_date, hr.recorded_time, hr.value, hr.details, hr.next_due, hr.booked_date, (hr.documents IS NOT NULL) as has_file, hr.recorded_by, hr.created_at, s.name AS recorder_name FROM health_records hr LEFT JOIN staff s ON hr.recorded_by = s.id WHERE hr.id = ?'
    ).bind(Number(idMatch[1])).first();
    if (!row) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
    await attachHealthRecordFilesToRows(db, [row]);
    return opsJson({ record: row });
  }

  if (method === 'PUT' && idMatch) {
    return updateRecord(req, env, db, staffAuth, Number(idMatch[1]));
  }

  if (method === 'DELETE' && idMatch) {
    return deleteRecord(db, r2, Number(idMatch[1]), staffAuth);
  }

  // /records（一覧 or 作成）
  if (method === 'GET') {
    var catId = url.searchParams.get('cat_id');
    var scope = url.searchParams.get('scope');
    /** 掲示板: 猫一覧と同じ拠点・ステータスで cats に絞り、最新件を取る（全猫500件だと特定猫が落ちる） */
    var matchCatsContext = url.searchParams.get('match_cats_context') === '1';
    /** 掲示板用 health 一覧（match_cats_context・猫未指定）のときだけ limit を広げる */
    var bulletinClinicWide = scope === 'clinic' && matchCatsContext && !catId;
    var limitCap = 100;
    var defaultLimit = 50;
    if (scope === 'clinic') {
      if (catId) {
        limitCap = 200;
        defaultLimit = 100;
      } else if (matchCatsContext) {
        limitCap = 800;
        defaultLimit = 400;
      } else {
        limitCap = 500;
        defaultLimit = 300;
      }
    }
    var limit = Math.min(limitCap, parseInt(url.searchParams.get('limit') || String(defaultLimit), 10) || defaultLimit);
    var type = url.searchParams.get('type');

    var sql = 'SELECT hr.id, hr.cat_id, hr.location_id, hr.record_type, hr.record_date, hr.recorded_time, hr.value, hr.details, hr.next_due, hr.booked_date, (hr.documents IS NOT NULL) as has_file, hr.recorded_by, hr.created_at, s.name AS recorder_name, c.name AS cat_name FROM health_records hr LEFT JOIN staff s ON hr.recorded_by = s.id LEFT JOIN cats c ON hr.cat_id = c.id';
    var params = [];
    var conditions = [];

    if (catId) { conditions.push('hr.cat_id = ?'); params.push(catId); }
    var locationParam = url.searchParams.get('location');
    if (locationParam && locationParam !== 'all') {
      conditions.push('hr.location_id = ?'); params.push(locationParam);
    }
    if (!catId && matchCatsContext) {
      var filterCatLoc = url.searchParams.get('filter_cat_location') || 'all';
      var filterCatStatus = url.searchParams.get('filter_cat_status') || 'active';
      var stFrag = sqlStatusCondition(filterCatStatus, 'cc');
      if (filterCatLoc && filterCatLoc !== 'all') {
        conditions.push(
          'hr.cat_id IN (SELECT cc.id FROM cats cc WHERE cc.location_id = ? AND (' + stFrag + '))'
        );
        params.push(filterCatLoc);
      } else {
        // 拠点「all」: cats/overview?location=all と同じ（拠点未設定の猫も含めず地理で落とすと掲示板の猫一覧と不整合）
        conditions.push('hr.cat_id IN (SELECT cc.id FROM cats cc WHERE (' + stFrag + '))');
      }
    }
    // scope=clinic は常に病院9種のみ（掲示板でも体重・ケア・給餌・日報等は出さない）
    if (scope === 'clinic') {
      conditions.push(
        "hr.record_type IN ('vaccine','checkup','surgery','dental','emergency','test','observation','medication_start','medication_end')"
      );
    } else if (type === 'urine') {
      conditions.push("(hr.record_type = 'urine' OR hr.record_type = 'urination')");
    } else if (type === 'medication') {
      // 日次TSV等の夜帯は medication_evening（朝は medication）
      conditions.push("(hr.record_type = 'medication' OR hr.record_type = 'medication_evening')");
    } else if (type) {
      conditions.push('hr.record_type = ?'); params.push(type);
    }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    // 病院スコープ: 予定行 (next_due) を先にし、履歴多めでも LIMIT で落ちにくくする
    var orderBy = 'hr.record_date DESC, hr.created_at DESC';
    if (scope === 'clinic' && (catId || matchCatsContext)) {
      orderBy = '(hr.next_due IS NULL) ASC, hr.next_due ASC, hr.record_date DESC, hr.created_at DESC';
    }
    sql += ' ORDER BY ' + orderBy + ' LIMIT ?';
    params.push(limit);

    var stmt = db.prepare(sql);
    if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
    var result = await stmt.all();
    var rows = result.results || [];
    await attachHealthRecordFilesToRows(db, rows);
    // 掲示板カードの追記（thread_comments, entity_type='clinic'）を同梱
    await attachThreadCommentsTo(db, 'clinic', rows, 'id');
    return opsJson({
      records: rows,
      viewer: {
        staff_id: staffAuth && staffAuth.staffId != null ? String(staffAuth.staffId) : '',
        role: staffAuth && staffAuth.role ? staffAuth.role : ''
      }
    });
  }

  if (method === 'POST') {
    return createRecord(req, env, db, staffAuth);
  }

  return opsJson({ error: 'method_not_allowed' }, 405);
}

var CLINIC_TYPES = { vaccine: 1, checkup: 1, surgery: 1, dental: 1, emergency: 1, test: 1, observation: 1, medication_start: 1, medication_end: 1 };

/** 業務終了レポート（close-day）と同一ルール（resolveNyagiReportSlackChannel） */
function slackChannelForLocation(env, locationId) {
  return resolveNyagiReportSlackChannel(env, locationId);
}

var SLACK_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
var SLACK_IMAGE_JSON_MAX_BYTES = 10 * 1024 * 1024;

var LOCATION_LABEL_JA_HEALTH = {
  cafe: 'BAKENEKO CAFE',
  nekomata: '猫又療養所',
  endo: '遠藤宅',
  azukari: '預かり隊',
};

function base64ToUint8ArrayHealth(b64) {
  var clean = String(b64).replace(/\s/g, '');
  var bin = atob(clean);
  var len = bin.length;
  var arr = new Uint8Array(len);
  for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function mimeToExtHealth(mime) {
  var m = String(mime || '').toLowerCase();
  if (m.indexOf('png') !== -1) return 'png';
  if (m.indexOf('pdf') !== -1) return 'pdf';
  if (m.indexOf('webp') !== -1) return 'webp';
  if (m.indexOf('gif') !== -1) return 'gif';
  return 'jpg';
}

function sanitizeClinicSlackBasename(name) {
  var s = String(name || 'file').split(/[/\\]/).pop() || 'file';
  s = s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  if (!s) s = 'file';
  return s;
}

/** Slack 送信用: JSON 添付（data URL / base64）、最大10MB（HEALTH_RECORD 添付と揃える） */
function parseSlackImagePayloadHealth(body) {
  if (!body || !body.slack_image || typeof body.slack_image !== 'string') return null;
  var trimmed = body.slack_image.trim();
  var mime = 'image/jpeg';
  var b64;
  if (trimmed.indexOf('data:') === 0) {
    var m = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed.replace(/\s/g, ''));
    if (!m) return null;
    mime = m[1] || mime;
    b64 = m[2];
  } else {
    b64 = trimmed;
    if (body.slack_image_mime) mime = String(body.slack_image_mime);
  }
  if (!b64) return null;
  var bytes;
  try {
    bytes = base64ToUint8ArrayHealth(b64);
  } catch (_) {
    return null;
  }
  if (!bytes || bytes.length < 32) return null;
  if (bytes.length > SLACK_IMAGE_JSON_MAX_BYTES) return { error: 'slack_image_too_large' };
  var ext = mimeToExtHealth(mime);
  var rawName = body.slack_image_name ? String(body.slack_image_name) : '';
  var filename = sanitizeClinicSlackBasename(rawName || ('nyagi-clinic.' + ext));
  if (filename.indexOf('.') === -1) filename += '.' + ext;
  return { bytes: bytes, filename: filename };
}

function extractRawNoteFromHealthDetails(detailsJson) {
  if (!detailsJson) return '';
  try {
    var d = typeof detailsJson === 'string' ? JSON.parse(detailsJson) : detailsJson;
    return (d && (d.note || d.finding)) ? String(d.note || d.finding) : '';
  } catch (_) {
    return '';
  }
}

/** 病院記録 details 内の病院名（UI・Slack 用） */
function extractClinicNameFromHealthDetails(detailsJson) {
  if (!detailsJson) return '';
  try {
    var d = typeof detailsJson === 'string' ? JSON.parse(detailsJson) : detailsJson;
    if (d && d.clinic_name != null && String(d.clinic_name).trim() !== '') {
      return String(d.clinic_name).trim().slice(0, 200);
    }
  } catch (_) {}
  return '';
}

/** クライアントから来た details オブジェクト／JSON 文字列から病院名だけ取り出す */
function clinicNameFromBodyDetails(details) {
  if (!details) return '';
  if (typeof details === 'object' && details.clinic_name != null) {
    return String(details.clinic_name).trim().slice(0, 200);
  }
  if (typeof details === 'string') {
    try {
      var o = JSON.parse(details);
      if (o && o.clinic_name != null) return String(o.clinic_name).trim().slice(0, 200);
    } catch (_) {}
  }
  return '';
}

async function fetchHealthRecordRowWithAttachments(db, recordId) {
  var row = await db
    .prepare(
      'SELECT hr.id, hr.cat_id, hr.location_id, hr.record_type, hr.record_date, hr.recorded_time, hr.value, hr.details, hr.next_due, hr.booked_date, (hr.documents IS NOT NULL) as has_file, hr.recorded_by, hr.created_at, s.name AS recorder_name FROM health_records hr LEFT JOIN staff s ON hr.recorded_by = s.id WHERE hr.id = ?'
    )
    .bind(recordId)
    .first();
  if (!row) return null;
  await attachHealthRecordFilesToRows(db, [row]);
  return row;
}

async function loadFirstHealthRecordFileBytes(env, db, recordId) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return null;
  var fileRow = await db
    .prepare(
      "SELECT r2_key, original_name, mime_type, size_bytes FROM files WHERE module = 'health_record' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != '' ORDER BY id ASC LIMIT 1"
    )
    .bind(String(recordId))
    .first();
  if (!fileRow || !fileRow.r2_key) return null;
  var maxSz = fileRow.size_bytes != null ? Number(fileRow.size_bytes) : SLACK_ATTACH_MAX_BYTES;
  if (maxSz > SLACK_ATTACH_MAX_BYTES) return { too_large: true };
  var obj = await r2.get(fileRow.r2_key);
  if (!obj) return null;
  var buf = await obj.arrayBuffer();
  var bytes = new Uint8Array(buf);
  if (bytes.byteLength > SLACK_ATTACH_MAX_BYTES) return { too_large: true };
  var mime = String(fileRow.mime_type || '').toLowerCase();
  if (!HEALTH_RECORD_FILE_MIMES[mime]) return null;
  return { bytes: bytes, filename: fileRow.original_name || 'attachment', mime: mime };
}

var CLINIC_STRUCTURE_PROMPT = [
  'あなたは動物病院の診察記録を整理するアシスタントです。',
  '入力テキストを以下のJSON形式に分類してください。該当なしの項目は空文字にしてください。',
  '必ずJSONのみを返してください。',
  '{',
  '  "diagnosis": "診断名・病名（例: 腎臓病ステージ2、歯肉炎）",',
  '  "treatment": "処方薬・治療内容（例: 点滴200ml、抗生物質○○を7日分）",',
  '  "findings": "所見・検査結果（例: 血液検査BUN 45、体重減少傾向）",',
  '  "next_steps": "次回指示・経過観察（例: 2週間後に再検査、食事を腎臓ケアに変更）",',
  '  "summary": "1行の要約（20文字以内）"',
  '}',
].join('\n');

function structureClinicRecord(env, text) {
  if (!env || !env.AI || !text || text.length < 5) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { resolve(null); }, 5000);
    env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: CLINIC_STRUCTURE_PROMPT },
        { role: 'user', content: text },
      ],
      max_tokens: 300,
      temperature: 0.1,
    }).then(function (resp) {
      clearTimeout(timer);
      var raw = (resp && resp.response) ? resp.response : '';
      var jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { resolve(null); return; }
      try {
        var info = JSON.parse(jsonMatch[0]);
        resolve({
          diagnosis: info.diagnosis || '',
          treatment: info.treatment || '',
          findings: info.findings || '',
          next_steps: info.next_steps || '',
          summary: info.summary || '',
        });
      } catch (_) { resolve(null); }
    }).catch(function () {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function dataUrlToBytes(dataUrl) {
  var match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  var raw = atob(match[2]);
  var arr = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return { mime: match[1], bytes: arr };
}

var HEALTH_RECORD_FILE_MIMES = {
  'application/pdf': 1,
  'image/jpeg': 1,
  'image/png': 1,
  'image/gif': 1,
  'image/webp': 1,
};

/** 病院記録添付の最大サイズ（multipart / JSON 経由とも R2 へ保存） */
var HEALTH_RECORD_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 1リクエストでアップロードできるファイル数の上限 */
var HEALTH_RECORD_MAX_FILES_PER_UPLOAD = 25;

/** Cloudflare D1 は1クエリあたりのバインド変数数が少ない（実測で ~100 以上でエラー）のでチャンク分割 */
var D1_IN_CHUNK = 50;

async function attachHealthRecordFilesToRows(db, rows) {
  if (!rows || rows.length === 0) return;
  var ids = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id != null) ids.push(String(rows[i].id));
  }
  if (ids.length === 0) return;

  var byRef = {};
  for (var ci = 0; ci < ids.length; ci += D1_IN_CHUNK) {
    var chunk = ids.slice(ci, ci + D1_IN_CHUNK);
    var ph = chunk.map(function () { return '?'; }).join(',');
    var q =
      'SELECT id, ref_id, original_name, mime_type, size_bytes, created_at FROM files WHERE module = \'health_record\' AND ref_id IN (' +
      ph +
      ') AND r2_key IS NOT NULL AND r2_key != \'\' ORDER BY ref_id ASC, id ASC';
    var stmt = db.prepare(q);
    stmt = stmt.bind.apply(stmt, chunk);
    var fr = await stmt.all();
    var list = fr.results || [];
    for (var j = 0; j < list.length; j++) {
      var f = list[j];
      var k = f.ref_id;
      if (!byRef[k]) byRef[k] = [];
      byRef[k].push({
        id: f.id,
        original_name: f.original_name,
        mime_type: f.mime_type,
        size_bytes: f.size_bytes,
        created_at: f.created_at,
      });
    }
  }

  for (var r = 0; r < rows.length; r++) {
    var rid = String(rows[r].id);
    rows[r].attachments = byRef[rid] || [];
    rows[r].has_file = rows[r].attachments.length > 0 ? 1 : 0;
  }
}

async function syncHealthRecordDocumentsMeta(db, recordId) {
  var cnt = await db.prepare(
    "SELECT COUNT(1) AS c FROM files WHERE module = 'health_record' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''"
  )
    .bind(String(recordId))
    .first();
  if (cnt && cnt.c > 0) {
    await db.prepare("UPDATE health_records SET documents = '1' WHERE id = ?").bind(recordId).run();
  } else {
    await db.prepare('UPDATE health_records SET documents = NULL WHERE id = ?').bind(recordId).run();
  }
}

async function serveHealthRecordFileById(env, db, recordId, filePk) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'unavailable', message: 'Storage not available' }, 503);
  var fileRow = await db.prepare(
    "SELECT r2_key, original_name, mime_type FROM files WHERE id = ? AND module = 'health_record' AND ref_id = ? AND r2_key IS NOT NULL"
  )
    .bind(filePk, String(recordId))
    .first();
  if (!fileRow || !fileRow.r2_key) return opsJson({ error: 'not_found', message: 'File not found' }, 404);
  var obj = await r2.get(fileRow.r2_key);
  if (!obj) return opsJson({ error: 'not_found', message: 'File not found in storage' }, 404);
  var headers = new Headers();
  headers.set('Content-Type', fileRow.mime_type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + (fileRow.original_name || 'file') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

async function deleteOneHealthRecordFile(db, r2, recordId, filePk) {
  var hrRow = await db.prepare('SELECT id FROM health_records WHERE id = ?').bind(recordId).first();
  if (!hrRow) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var fileRow = await db.prepare(
    "SELECT r2_key FROM files WHERE id = ? AND module = 'health_record' AND ref_id = ? AND r2_key IS NOT NULL"
  )
    .bind(filePk, String(recordId))
    .first();
  if (!fileRow) return opsJson({ error: 'not_found', message: 'File not found' }, 404);
  if (r2 && fileRow.r2_key) {
    try {
      await r2.delete(fileRow.r2_key);
    } catch (_) {}
  }
  await db.prepare('DELETE FROM files WHERE id = ?').bind(filePk).run();
  await syncHealthRecordDocumentsMeta(db, recordId);
  return opsJson({ ok: true, deleted: true });
}

/** POST multipart（field: file を複数可）。既存添付は残して追加する。 */
async function uploadHealthRecordFile(req, env, db, staffAuth, recordId) {
  var r2 = env.NYAGI_FILES;
  if (!r2) {
    return opsJson({ error: 'service_unavailable', message: 'File storage is not configured' }, 503);
  }

  var hrRow = await db.prepare('SELECT id FROM health_records WHERE id = ?').bind(recordId).first();
  if (!hrRow) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);

  var formData;
  try {
    formData = await req.formData();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Expected multipart form data' }, 400);
  }

  var rawList = formData.getAll('file');
  var files = [];
  for (var fi = 0; fi < rawList.length; fi++) {
    if (rawList[fi] && typeof rawList[fi].arrayBuffer === 'function') files.push(rawList[fi]);
  }
  if (files.length === 0) {
    var single = formData.get('file');
    if (single && typeof single.arrayBuffer === 'function') files.push(single);
  }
  if (files.length === 0) {
    return opsJson({ error: 'bad_request', message: 'Missing file field' }, 400);
  }
  if (files.length > HEALTH_RECORD_MAX_FILES_PER_UPLOAD) {
    return opsJson(
      {
        error: 'bad_request',
        message: '一度にアップロードできるのは' + HEALTH_RECORD_MAX_FILES_PER_UPLOAD + 'ファイルまでです',
      },
      400
    );
  }

  var saved = [];
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var size = file.size || 0;
    if (size < 1) {
      return opsJson({ error: 'bad_request', message: '空のファイルがあります' }, 400);
    }
    if (size > HEALTH_RECORD_MAX_FILE_BYTES) {
      return opsJson({ error: 'payload_too_large', message: '各ファイルは10MB以下にしてください' }, 413);
    }
    var mime = String(file.type || '').toLowerCase();
    if (!HEALTH_RECORD_FILE_MIMES[mime]) {
      return opsJson({ error: 'bad_request', message: '対応形式: PDF・画像（JPEG/PNG/GIF/WebP）' }, 400);
    }
    var buf = await file.arrayBuffer();
    if (buf.byteLength > HEALTH_RECORD_MAX_FILE_BYTES) {
      return opsJson({ error: 'payload_too_large', message: '各ファイルは10MB以下にしてください' }, 413);
    }
    var origName = file.name || 'file';
    var safeName = String(origName).replace(/[\r\n\\/]/g, '_').slice(0, 120) || 'file';
    var r2Key =
      'health-records/' + recordId + '/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + safeName;
    try {
      await r2.put(r2Key, buf, {
        httpMetadata: { contentType: mime || 'application/octet-stream' },
      });
    } catch (_) {
      return opsJson({ error: 'upload_failed', message: 'ストレージへの保存に失敗しました' }, 500);
    }
    var ext = origName.indexOf('.') >= 0 ? origName.split('.').pop() : mime === 'application/pdf' ? 'pdf' : 'bin';
    var ins = await db
      .prepare(
        "INSERT INTO files (r2_key, module, ref_id, file_type, original_name, mime_type, size_bytes, uploaded_by) VALUES (?, 'health_record', ?, ?, ?, ?, ?, ?) RETURNING id, created_at"
      )
      .bind(r2Key, String(recordId), ext, origName, mime, buf.byteLength, staffAuth.staffId)
      .first();
    if (ins) {
      saved.push({
        id: ins.id,
        original_name: origName,
        mime_type: mime,
        size_bytes: buf.byteLength,
        created_at: ins.created_at,
      });
    }
  }

  await syncHealthRecordDocumentsMeta(db, recordId);

  return opsJson({ ok: true, uploaded: saved.length, files: saved, record_id: recordId, has_file: 1 });
}

async function createRecord(req, env, db, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  var catId = body.cat_id;
  var recordType = body.record_type;
  var recordDate = body.record_date;

  if (!catId || !recordType || !recordDate) {
    return opsJson({ error: 'bad_request', message: 'cat_id, record_type, record_date required' }, 400);
  }
  if (VALID_RECORD_TYPES.indexOf(recordType) === -1) {
    return opsJson({ error: 'bad_request', message: 'Invalid record_type' }, 400);
  }

  var locationId = body.location_id || staffAuth.locationId;
  if (!locationId) {
    var catLocRow = await db.prepare('SELECT location_id FROM cats WHERE id = ?').bind(catId).first();
    if (catLocRow && catLocRow.location_id) locationId = catLocRow.location_id;
  }
  if (!locationId) {
    return opsJson({
      error: 'bad_request',
      message: 'location_id が空です。スタッフに拠点を割り当てるか、猫に location_id を設定してください。',
    }, 400);
  }

  var value = body.value || null;
  var careTimeEligible = value && value !== '×' && value !== 'ー';
  var rawNote = '';
  if (body.details) {
    if (typeof body.details === 'string') {
      try { var dp = JSON.parse(body.details); rawNote = dp.note || dp.finding || body.details; } catch (_) { rawNote = body.details; }
    } else {
      rawNote = body.details.note || body.details.finding || '';
    }
  }

  /** 病院「予定」（next_due あり）は AI 要約で value を上書きしない（誤って受診済み風になるのを防ぐ） */
  var nextDue = body.next_due || null;
  var notifySlack = !!body.notify_slack;

  var bookedDate = null;
  if (body.booked_date != null && String(body.booked_date).trim() !== '') {
    bookedDate = String(body.booked_date).trim().slice(0, 200);
  }

  var clinicNameIncoming = clinicNameFromBodyDetails(body.details);

  var details;
  if (CLINIC_TYPES[recordType] && rawNote && !nextDue) {
    var structured = await structureClinicRecord(env, rawNote);
    var summaryLine = '';
    if (structured && structured.summary) summaryLine = String(structured.summary).trim();
    if (!summaryLine) summaryLine = rawNote.replace(/\s+/g, ' ').trim().slice(0, 120);
    var detailCreate = { note: rawNote, summary: summaryLine };
    if (clinicNameIncoming) detailCreate.clinic_name = clinicNameIncoming;
    details = JSON.stringify(detailCreate);
    value = summaryLine.length > 100 ? summaryLine.slice(0, 100) : summaryLine;
  } else if (body.details != null) {
    details = (typeof body.details === 'string') ? body.details : JSON.stringify(body.details);
  } else {
    details = null;
  }
  var recordedTime = body.recorded_time || null;
  if (!recordedTime && careTimeEligible && (recordType === 'care' || recordType === 'eye_discharge')) {
    recordedTime = formatJstTimeHm();
  }

  var docsMeta = null;
  var fileForR2 = body.documents || null;

  var row = await db.prepare(
    'INSERT INTO health_records (cat_id, location_id, record_type, record_date, recorded_time, value, details, next_due, booked_date, documents, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, cat_id, location_id, record_type, record_date, recorded_time, value, details, next_due, booked_date, (documents IS NOT NULL) as has_file, recorded_by, created_at'
  ).bind(catId, locationId, recordType, recordDate, recordedTime, value, details, nextDue, bookedDate, null, staffAuth.staffId).first();

  if (fileForR2 && row && env.NYAGI_FILES) {
    try {
      var fileObj = typeof fileForR2 === 'string' ? JSON.parse(fileForR2) : fileForR2;
      var parsed = dataUrlToBytes(fileObj.data);
      if (parsed && parsed.bytes.byteLength <= HEALTH_RECORD_MAX_FILE_BYTES) {
        var r2KeyLegacy = 'health-records/' + row.id + '/' + Date.now() + '_' + (fileObj.name || 'file').replace(/[^\w.\-]/g, '_');
        await env.NYAGI_FILES.put(r2KeyLegacy, parsed.bytes, {
          httpMetadata: { contentType: parsed.mime },
        });
        await db.prepare(
          "INSERT INTO files (r2_key, module, ref_id, file_type, original_name, mime_type, size_bytes, uploaded_by) VALUES (?, 'health_record', ?, ?, ?, ?, ?, ?)"
        ).bind(r2KeyLegacy, String(row.id), fileObj.name ? fileObj.name.split('.').pop() : 'pdf', fileObj.name || 'file', parsed.mime, parsed.bytes.length, staffAuth.staffId).run();
        await db.prepare("UPDATE health_records SET documents = '1' WHERE id = ?").bind(row.id).run();
        row.has_file = 1;
      }
    } catch (_) { /* R2 upload failure is non-fatal */ }
  }

  if (recordType === 'weight') {
    try { await refreshNutritionProfile(db, catId); } catch (_) {}
  }

  if (notifySlack && nextDue && CLINIC_TYPES[recordType]) {
    var slackRes = await notifyVetScheduleToSlack(env, db, row, locationId, staffAuth, { is_update: false });
    return opsJson({ record: row, slack: slackRes }, 201);
  }

  return opsJson({ record: row }, 201);
}

/** 病院予定の新規／更新を、業務終了レポート（副店長こはだ）と同じ拠点 Slack チャンネルへ通知 */
async function notifyVetScheduleToSlack(env, db, row, locationId, staffAuth, opts) {
  opts = opts || {};
  var isUpdate = !!opts.is_update;
  staffAuth = staffAuth || {};
  var locId = locationId || row.location_id;
  var channel = slackChannelForLocation(env, locId);
  if (!channel) return { sent: false, reason: 'slack_channel_not_configured' };

  var catRow = await db.prepare('SELECT name FROM cats WHERE id = ?').bind(row.cat_id).first();
  var catName = (catRow && catRow.name) || row.cat_id;
  var typeLabels = { vaccine: 'ワクチン', checkup: '健康診断', surgery: '手術', dental: '歯科', emergency: '緊急受診', test: '検査', observation: '経過観察', medication_start: '投薬開始', medication_end: '投薬終了' };
  var typeEmojis = { vaccine: '💉', checkup: '🩺', surgery: '🏥', dental: '🦷', emergency: '🚨', test: '🔬', observation: '👁', medication_start: '💊', medication_end: '💊' };
  var typeLabel = typeLabels[row.record_type] || row.record_type;
  var emoji = typeEmojis[row.record_type] || '📅';
  var locLabel = LOCATION_LABEL_JA_HEALTH[locId] || locId || '';

  var note = extractRawNoteFromHealthDetails(row.details);
  if (!note && row.value) note = String(row.value);
  var clinicNameSlack = '';
  if (row.details) {
    try {
      var dSched = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
      if (dSched && dSched.clinic_name) clinicNameSlack = String(dSched.clinic_name).trim();
    } catch (_) {}
  }

  var lines = [];
  lines.push(emoji + ' *' + catName + '* の病院予定（NYAGI・' + (isUpdate ? '更新' : '新規') + '）');
  lines.push('');
  lines.push('*拠点:* ' + locLabel);
  lines.push('*種別:* ' + typeLabel);
  if (clinicNameSlack) lines.push('*病院:* ' + clinicNameSlack);
  if (row.next_due) lines.push('*予定日:* ' + String(row.next_due).slice(0, 10));
  if (row.booked_date) lines.push('*予約日時:* ' + String(row.booked_date).trim());
  if (note && String(note).trim()) {
    lines.push('');
    lines.push('📝 ' + (String(note).length > 600 ? String(note).slice(0, 600) + '…' : String(note)));
  }
  var who = staffAuth.name || staffAuth.staffId;
  if (who != null && String(who).trim() !== '') {
    lines.push('');
    lines.push('*' + (isUpdate ? '更新' : '登録') + ':* ' + String(who));
  }

  var text = lines.join('\n');
  var data = await sendSlackMessage(env, channel, text);
  if (data && data.ok) return { sent: true, channel: channel, with_file: false };
  return { sent: false, reason: (data && data.error) || 'slack_api_failed' };
}

async function notifyClinicRecordToSlack(env, db, row, rawNote, locationId, opts) {
  opts = opts || {};
  var isUpdate = !!opts.is_update;
  var typeLabels = { vaccine: 'ワクチン', checkup: '健康診断', surgery: '手術', dental: '歯科', emergency: '緊急受診', test: '検査', observation: '経過観察', medication_start: '投薬開始', medication_end: '投薬終了' };
  var typeEmojis = { vaccine: '💉', checkup: '🩺', surgery: '🏥', dental: '🦷', emergency: '🚨', test: '🔬', observation: '👁', medication_start: '💊', medication_end: '💊' };

  var locId = locationId || row.location_id;
  var channel = slackChannelForLocation(env, locId);
  if (!channel) return { sent: false, reason: 'slack_channel_not_configured' };

  var catRow = await db.prepare('SELECT name FROM cats WHERE id = ?').bind(row.cat_id).first();
  var catName = (catRow && catRow.name) || row.cat_id;
  var typeLabel = typeLabels[row.record_type] || row.record_type;
  var emoji = typeEmojis[row.record_type] || '🏥';
  var locLabel = LOCATION_LABEL_JA_HEALTH[locId] || locId || '';

  var summaryLine = '';
  if (row.details) {
    try {
      var d = JSON.parse(row.details);
      if (d.summary) summaryLine = String(d.summary).trim();
      else if (d.structured && d.structured.summary) summaryLine = String(d.structured.summary).trim();
    } catch (_) {}
  }

  var recorderName = row.recorder_name ? String(row.recorder_name) : '';

  var lines = [];
  lines.push(emoji + ' *' + catName + '* の病院記録（NYAGI）' + (isUpdate ? ' — 更新' : ' — 新規'));
  lines.push('');
  lines.push('*拠点:* ' + locLabel);
  lines.push('*種別:* ' + typeLabel + '　*日付:* ' + row.record_date);
  if (recorderName) lines.push('*記録者:* ' + recorderName);
  var clinicNm = extractClinicNameFromHealthDetails(row.details);
  if (clinicNm) lines.push('*病院:* ' + clinicNm);
  lines.push('');

  if (summaryLine) {
    lines.push('📝 *' + summaryLine + '*');
  } else if (rawNote) {
    lines.push(rawNote.length > 800 ? rawNote.slice(0, 800) + '…' : rawNote);
  }

  var attCount = row.attachments && row.attachments.length ? row.attachments.length : 0;
  if (attCount > 1) {
    lines.push('');
    lines.push('📎 添付 ' + attCount + ' 件（Slackには先頭1件を自動送信）');
  } else if (row.has_file && !attCount) {
    lines.push('');
    lines.push('📎 ファイルが添付されています');
  }

  var text = lines.join('\n');

  var img = opts.slack_image;
  if (img && img.bytes && img.bytes.byteLength) {
    var fileRes = await shareBinaryFileToSlack(env, channel, img.bytes, img.filename || 'clinic.jpg', text);
    if (fileRes && fileRes.ok) return { sent: true, channel: channel, with_file: true };
    console.warn('[health] slack file (payload) failed, fallback:', fileRes && fileRes.error);
  }

  var fromR2 = await loadFirstHealthRecordFileBytes(env, db, row.id);
  if (fromR2 && fromR2.too_large) {
    var dataLarge = await sendSlackMessage(env, channel, text + '\n\n📎 添付あり（大きいためSlackへの自動添付はスキップしました）');
    if (dataLarge && dataLarge.ok) return { sent: true, channel: channel, with_file: false };
    return { sent: false, reason: (dataLarge && dataLarge.error) || 'slack_api_failed' };
  }
  if (fromR2 && fromR2.bytes && fromR2.bytes.byteLength) {
    var fileRes2 = await shareBinaryFileToSlack(env, channel, fromR2.bytes, fromR2.filename || 'clinic-attach', text);
    if (fileRes2 && fileRes2.ok) return { sent: true, channel: channel, with_file: true };
    console.warn('[health] slack file (R2) failed, fallback:', fileRes2 && fileRes2.error);
  }

  var data = await sendSlackMessage(env, channel, text);
  if (data && data.ok) return { sent: true, channel: channel, with_file: false };
  return { sent: false, reason: (data && data.error) || 'slack_api_failed' };
}

async function updateRecord(req, env, db, staffAuth, recordId) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  var existing = await db.prepare('SELECT * FROM health_records WHERE id = ?').bind(recordId).first();
  if (!existing) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  if (!isRecordOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '編集できるのは投稿者本人または管理者のみです' }, 403);
  }

  var notifySlack = !!body.notify_slack;
  var slackImgPut = null;
  if (notifySlack) {
    slackImgPut = parseSlackImagePayloadHealth(body);
    if (slackImgPut && slackImgPut.error) {
      return opsJson({ error: slackImgPut.error, message: '添付画像は10MB以下にしてください' }, 400);
    }
  }

  var metaKeysPut = { notify_slack: 1, slack_image: 1, slack_image_name: 1, slack_image_mime: 1, clinic_slack_is_update: 1 };
  var hasOtherFieldsPut = false;
  for (var bKey in body) {
    if (Object.prototype.hasOwnProperty.call(body, bKey) && !metaKeysPut[bKey]) {
      hasOtherFieldsPut = true;
      break;
    }
  }

  if (notifySlack && !hasOtherFieldsPut) {
    if (!CLINIC_TYPES[existing.record_type]) {
      return opsJson({ error: 'bad_request', message: 'この種別は病院記録のSlack共有の対象外です' }, 400);
    }
    if (existing.next_due) {
      var rowSchedSlackOnly = await db
        .prepare(
          'SELECT hr.id, hr.cat_id, hr.location_id, hr.record_type, hr.record_date, hr.recorded_time, hr.value, hr.details, hr.next_due, hr.booked_date, (hr.documents IS NOT NULL) as has_file, hr.recorded_by, hr.created_at FROM health_records hr WHERE hr.id = ?'
        )
        .bind(recordId)
        .first();
      if (!rowSchedSlackOnly) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
      var slackSchedOnly = await notifyVetScheduleToSlack(env, db, rowSchedSlackOnly, rowSchedSlackOnly.location_id, staffAuth, { is_update: true });
      return opsJson({ record: rowSchedSlackOnly, slack: slackSchedOnly });
    }
    var rowSlackOnly = await fetchHealthRecordRowWithAttachments(db, recordId);
    if (!rowSlackOnly) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
    var rawNoteSlack = extractRawNoteFromHealthDetails(rowSlackOnly.details);
    if (!rawNoteSlack && rowSlackOnly.value) rawNoteSlack = String(rowSlackOnly.value);
    var slackIsUpdate = !!body.clinic_slack_is_update;
    var slackResultOnly = await notifyClinicRecordToSlack(env, db, rowSlackOnly, rawNoteSlack, rowSlackOnly.location_id, {
      is_update: slackIsUpdate,
      slack_image: slackImgPut || undefined,
    });
    return opsJson({ record: rowSlackOnly, slack: slackResultOnly });
  }

  var recordType = body.record_type !== undefined ? body.record_type : existing.record_type;
  if (body.record_type !== undefined && VALID_RECORD_TYPES.indexOf(recordType) === -1) {
    return opsJson({ error: 'bad_request', message: 'Invalid record_type' }, 400);
  }

  var nextDue = body.next_due !== undefined ? body.next_due : existing.next_due;
  var recordDate = body.record_date !== undefined ? body.record_date : existing.record_date;
  var bookedDate = body.booked_date !== undefined ? body.booked_date : existing.booked_date;

  var value = body.value !== undefined ? body.value : existing.value;
  var details = existing.details;

  if (body.details !== undefined) {
    var rawNote = '';
    if (typeof body.details === 'string') {
      try {
        var dp = JSON.parse(body.details);
        rawNote = dp.note || dp.finding || '';
      } catch (_) {
        rawNote = body.details;
      }
    } else if (body.details) {
      rawNote = body.details.note || body.details.finding || '';
    }
    /** next_due あり（病院予定行）は要約で details を潰さない（clinic_name 等を保持） */
    if (CLINIC_TYPES[recordType] && rawNote && !nextDue) {
      var structuredUp = await structureClinicRecord(env, rawNote);
      var sumUp = '';
      if (structuredUp && structuredUp.summary) sumUp = String(structuredUp.summary).trim();
      if (!sumUp) sumUp = rawNote.replace(/\s+/g, ' ').trim().slice(0, 120);
      var mergedDetail = { note: rawNote, summary: sumUp };
      var cnPut = '';
      if (body.details && typeof body.details === 'object' && body.details.clinic_name !== undefined) {
        cnPut = String(body.details.clinic_name || '').trim().slice(0, 200);
      } else {
        cnPut = extractClinicNameFromHealthDetails(existing.details);
      }
      if (cnPut) mergedDetail.clinic_name = cnPut;
      details = JSON.stringify(mergedDetail);
      if (body.value === undefined) {
        value = sumUp.length > 100 ? sumUp.slice(0, 100) : sumUp;
      }
    } else {
      details = (typeof body.details === 'string') ? body.details : JSON.stringify(body.details);
    }
  }

  if (body.value !== undefined) {
    value = body.value;
  }

  await db.prepare(
    "UPDATE health_records SET record_type = ?, value = ?, details = ?, next_due = ?, record_date = ?, booked_date = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(recordType, value, details, nextDue, recordDate, bookedDate, recordId).run();

  var updated = await db.prepare(
    'SELECT hr.id, hr.cat_id, hr.location_id, hr.record_type, hr.record_date, hr.recorded_time, hr.value, hr.details, hr.next_due, hr.booked_date, (hr.documents IS NOT NULL) as has_file, hr.recorded_by, hr.created_at FROM health_records hr WHERE hr.id = ?'
  ).bind(recordId).first();
  if (existing.record_type === 'weight' || recordType === 'weight') {
    try { await refreshNutritionProfile(db, existing.cat_id); } catch (_) {}
  }

  var vetSlackResult = null;
  if (notifySlack && nextDue && CLINIC_TYPES[recordType]) {
    vetSlackResult = await notifyVetScheduleToSlack(env, db, updated, updated.location_id, staffAuth, { is_update: true });
  }

  return opsJson({ record: updated, auto_created: null, slack: vetSlackResult });
}

async function deleteRecord(db, r2, recordId, staffAuth) {
  var existing = await db.prepare('SELECT * FROM health_records WHERE id = ?').bind(recordId).first();
  if (!existing) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  if (!isRecordOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '削除できるのは投稿者本人または管理者のみです' }, 403);
  }

  if (r2) {
    var fileRows = await db.prepare(
      "SELECT r2_key FROM files WHERE module = 'health_record' AND ref_id = ?"
    ).bind(String(recordId)).all();
    var keys = (fileRows.results || []);
    for (var fi = 0; fi < keys.length; fi++) {
      try { await r2.delete(keys[fi].r2_key); } catch (_) {}
    }
    await db.prepare("DELETE FROM files WHERE module = 'health_record' AND ref_id = ?").bind(String(recordId)).run();
  }

  await db.prepare("DELETE FROM thread_comments WHERE entity_type = 'clinic' AND entity_id = ?").bind(recordId).run();
  await db.prepare('DELETE FROM health_records WHERE id = ?').bind(recordId).run();
  return opsJson({ ok: true, deleted_id: recordId });
}

// ───────────────────────────────────────────────────────────────────────────────
// 投薬スケジュール
// ───────────────────────────────────────────────────────────────────────────────

async function handleMedications(method, req, db, staffAuth, url, subPath) {
  var idMatch = subPath.match(/^\/medications\/(\d+)$/);

  if (method === 'PUT' && idMatch) {
    return updateMedication(req, db, Number(idMatch[1]));
  }

  if (method === 'DELETE' && idMatch) {
    return deleteMedication(db, Number(idMatch[1]));
  }

  if (method === 'GET') {
    var catId = url.searchParams.get('cat_id');
    var activeOnly = url.searchParams.get('active') !== 'false';

    var sql = 'SELECT m.*, med.name AS medicine_name, med.category AS medicine_category FROM medications m JOIN medicines med ON m.medicine_id = med.id WHERE 1=1';
    var params = [];

    if (activeOnly) { sql += ' AND m.active = 1'; }
    if (catId) { sql += ' AND m.cat_id = ?'; params.push(catId); }
    sql += ' ORDER BY m.cat_id, m.active DESC, med.name';

    var stmt = db.prepare(sql);
    if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
    var result = await stmt.all();
    return opsJson({ medications: result.results || [] });
  }

  if (method === 'POST') {
    return createMedication(req, db, staffAuth);
  }

  return opsJson({ error: 'method_not_allowed' }, 405);
}

async function createMedication(req, db, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  if (!body.cat_id || !body.medicine_id || !body.start_date) {
    return opsJson({ error: 'bad_request', message: 'cat_id, medicine_id, start_date required' }, 400);
  }

  var timeSlots = body.time_slots || ['朝'];
  var timeSlotsJson = JSON.stringify(Array.isArray(timeSlots) ? timeSlots : [timeSlots]);

  var row = await db.prepare(
    'INSERT INTO medications (cat_id, medicine_id, dosage_amount, dosage_unit, frequency, time_slots, with_food, route, prescribed_by, purpose, start_date, end_date, taper_plan, notes, active, plan_type, preset_id, preset_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, \'staff\', NULL, NULL) RETURNING *'
  ).bind(
    body.cat_id, body.medicine_id,
    body.dosage_amount != null ? body.dosage_amount : null,
    body.dosage_unit || null,
    body.frequency || '毎日',
    timeSlotsJson,
    body.with_food ? 1 : 0,
    body.route || null,
    body.prescribed_by || null,
    body.purpose || null,
    body.start_date,
    body.end_date || null,
    body.taper_plan || null,
    body.notes || null
  ).first();

  // 当日分の medication_logs を自動生成
  // 「必要時」でも start_date=今日なら「今日あげる薬」として当日ログを1件作る
  var today = jstCalendarYmdFromInstant(Date.now());
  if (body.start_date <= today) {
    var slotsArr = Array.isArray(timeSlots) ? timeSlots : [timeSlots];
    var freq = body.frequency || '毎日';
    if (freq === '必要時') {
      // 必要時: shouldGenerateForDay は false を返すので直接 INSERT する（当日のみ）
      for (var si = 0; si < slotsArr.length; si++) {
        var sat = today + 'T' + slotsArr[si];
        var exists = await db.prepare(
          'SELECT id FROM medication_logs WHERE medication_id = ? AND scheduled_at = ?'
        ).bind(row.id, sat).first();
        if (!exists) {
          await db.prepare(
            'INSERT INTO medication_logs (medication_id, cat_id, scheduled_at, status) VALUES (?, ?, ?, ?)'
          ).bind(row.id, body.cat_id, sat, 'pending').run();
        }
      }
    } else {
      await generateLogsForDay(db, row.id, body.cat_id, today, slotsArr, freq, body.start_date);
    }
  }

  return opsJson({ medication: row }, 201);
}

async function updateMedication(req, db, medId) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  var existing = await db.prepare('SELECT * FROM medications WHERE id = ?').bind(medId).first();
  if (!existing) return opsJson({ error: 'not_found', message: 'Medication not found' }, 404);

  var active = body.active !== undefined ? (body.active ? 1 : 0) : existing.active;
  var endDate = body.end_date !== undefined ? body.end_date : existing.end_date;
  var notes = body.notes !== undefined ? body.notes : existing.notes;
  var dosageAmount = body.dosage_amount !== undefined ? body.dosage_amount : existing.dosage_amount;
  var dosageUnit = body.dosage_unit !== undefined ? body.dosage_unit : existing.dosage_unit;
  var frequency = body.frequency !== undefined ? body.frequency : existing.frequency;
  var timeSlots = body.time_slots !== undefined ? JSON.stringify(Array.isArray(body.time_slots) ? body.time_slots : [body.time_slots]) : existing.time_slots;
  var withFood = body.with_food !== undefined ? (body.with_food ? 1 : 0) : existing.with_food;
  var route = body.route !== undefined ? body.route : existing.route;
  var purpose = body.purpose !== undefined ? body.purpose : existing.purpose;
  var prescribedBy = body.prescribed_by !== undefined ? body.prescribed_by : existing.prescribed_by;

  await db.prepare(
    "UPDATE medications SET active = ?, end_date = ?, notes = ?, dosage_amount = ?, dosage_unit = ?, frequency = ?, time_slots = ?, with_food = ?, route = ?, purpose = ?, prescribed_by = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(active, endDate, notes, dosageAmount, dosageUnit, frequency, timeSlots, withFood, route, purpose, prescribedBy, medId).run();

  var updated = await db.prepare('SELECT m.*, med.name AS medicine_name FROM medications m JOIN medicines med ON m.medicine_id = med.id WHERE m.id = ?').bind(medId).first();
  return opsJson({ medication: updated });
}

async function deleteMedication(db, medId) {
  var existing = await db.prepare('SELECT * FROM medications WHERE id = ?').bind(medId).first();
  if (!existing) return opsJson({ error: 'not_found', message: 'Medication not found' }, 404);

  await db.prepare('DELETE FROM medication_logs WHERE medication_id = ?').bind(medId).run();
  await db.prepare('DELETE FROM medications WHERE id = ?').bind(medId).run();

  return opsJson({ ok: true, deleted_id: medId });
}

// ───────────────────────────────────────────────────────────────────────────────
// 投薬ログ
// ───────────────────────────────────────────────────────────────────────────────

async function handleMedicationLogs(method, req, db, staffAuth, url, subPath) {
  // /medication-logs/:id/done | skip | undo
  var doneMatch = subPath.match(/^\/medication-logs\/(\d+)\/(done|skip|undo)$/);
  if (method === 'POST' && doneMatch) {
    var bodyPath = {};
    try {
      bodyPath = await req.json();
    } catch (_) {}
    return applyMedicationLogAction(db, staffAuth, Number(doneMatch[1]), doneMatch[2], bodyPath);
  }

  // POST /medication-logs/:id  body: { "action": "done"|"skip"|"undo", ... }
  var postIdMatch = subPath.match(/^\/medication-logs\/(\d+)$/);
  if (method === 'POST' && postIdMatch) {
    var bodyPost = {};
    try {
      bodyPost = await req.json();
    } catch (_) {}
    var act = String(bodyPost.action || '').trim();
    if (act !== 'done' && act !== 'skip' && act !== 'undo') {
      return opsJson({ error: 'bad_request', message: 'action must be done, skip, or undo' }, 400);
    }
    return applyMedicationLogAction(db, staffAuth, Number(postIdMatch[1]), act, bodyPost);
  }

  if (method === 'GET') {
    var catId = url.searchParams.get('cat_id');
    var fromHist = url.searchParams.get('from');
    var toHist = url.searchParams.get('to');
    var historyList = url.searchParams.get('history') === '1';

    // 猫詳細「投薬履歴」用: 日付範囲の実施・スキップログ（当日ログ自動生成は行わない）
    if (catId && historyList && fromHist && toHist && /^\d{4}-\d{2}-\d{2}$/.test(fromHist) && /^\d{4}-\d{2}-\d{2}$/.test(toHist)) {
      var toExclusive = jstCalendarAddDays(toHist, 1);
      var histSql = [
        'SELECT ml.*, m.dosage_amount, m.dosage_unit, m.frequency, med.name AS medicine_name, med.category AS medicine_category',
        'FROM medication_logs ml',
        'LEFT JOIN medications m ON ml.medication_id = m.id',
        'LEFT JOIN medicines med ON m.medicine_id = med.id',
        'WHERE ml.cat_id = ? AND ml.scheduled_at >= ? AND ml.scheduled_at < ?',
        "AND ml.status IN ('done','skipped')",
      ].join(' ');
      histSql += ' ORDER BY ml.scheduled_at DESC, ml.id DESC';
      var histStmt = db.prepare(histSql).bind(catId, fromHist, toExclusive);
      var histRes = await histStmt.all();
      return opsJson({ logs: histRes.results || [], from: fromHist, to: toHist });
    }

    var date = url.searchParams.get('date') || jstCalendarYmdFromInstant(Date.now());

    // 投薬スケジュールを参照し、当日分のログがなければ自動作成（cron未実行時も入力可能に）
    if (catId) {
      var meds = await db.prepare(
        "SELECT * FROM medications WHERE active = 1 AND cat_id = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)"
      ).bind(catId, date, date).all();
      for (var i = 0; i < (meds.results || []).length; i++) {
        var med = meds.results[i];
        var slots = [];
        try { slots = JSON.parse(med.time_slots || '["朝"]'); } catch (_) { slots = ['朝']; }
        if (!Array.isArray(slots) || slots.length === 0) slots = ['朝'];
        if (shouldGenerateForDay(med.frequency || '毎日', date, med.start_date || date)) {
          await generateLogsForDay(db, med.id, med.cat_id, date, slots, med.frequency || '毎日', med.start_date);
        }
      }
    }

    var sql = [
      'SELECT ml.*, m.dosage_amount, m.dosage_unit, m.frequency, med.name AS medicine_name, med.category AS medicine_category',
      'FROM medication_logs ml',
      'JOIN medications m ON ml.medication_id = m.id',
      'JOIN medicines med ON m.medicine_id = med.id',
      'WHERE m.active = 1 AND ml.scheduled_at >= ? AND ml.scheduled_at < ?',
    ].join(' ');
    var nextDate = jstCalendarAddDays(date, 1);
    var params = [date, nextDate];

    if (catId) { sql += ' AND ml.cat_id = ?'; params.push(catId); }
    sql += " ORDER BY ml.cat_id, CASE WHEN ml.scheduled_at LIKE '%朝' THEN 1 WHEN ml.scheduled_at LIKE '%昼' THEN 2 WHEN ml.scheduled_at LIKE '%晩' THEN 3 ELSE 0 END, ml.scheduled_at ASC";

    var stmt = db.prepare(sql);
    if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
    var result = await stmt.all();
    return opsJson({ logs: result.results || [], date: date });
  }

  return opsJson({ error: 'method_not_allowed' }, 405);
}

async function applyMedicationLogAction(db, staffAuth, logId, action, body) {
  body = body || {};

  var log = await db.prepare('SELECT * FROM medication_logs WHERE id = ?').bind(logId).first();
  if (!log) return opsJson({ error: 'not_found', message: 'Medication log not found' }, 404);

  var now = jstNowIsoTimestamp();

  if (action === 'undo') {
    await db.prepare(
      "UPDATE medication_logs SET status = 'pending', administered_at = NULL, administered_by = NULL, skip_reason = NULL, note = NULL WHERE id = ?"
    ).bind(logId).run();
  } else if (action === 'done') {
    await db.prepare(
      "UPDATE medication_logs SET status = 'done', administered_at = ?, administered_by = ?, note = ?, skip_reason = NULL WHERE id = ?"
    ).bind(now, staffAuth.staffId, body.note || null, logId).run();
  } else if (action === 'skip') {
    await db.prepare(
      "UPDATE medication_logs SET status = 'skipped', skip_reason = ?, administered_by = ?, administered_at = NULL, note = NULL WHERE id = ?"
    ).bind(body.reason || null, staffAuth.staffId, logId).run();
  } else {
    return opsJson({ error: 'bad_request', message: 'Unknown action' }, 400);
  }

  var updated = await db.prepare('SELECT * FROM medication_logs WHERE id = ?').bind(logId).first();
  return opsJson({ log: updated });
}

// ───────────────────────────────────────────────────────────────────────────────
// 飲水測定
// ───────────────────────────────────────────────────────────────────────────────

var WATER_STATUS_LABELS = ['ほぼ飲んでいない', '少し飲んだ', '普通に飲んだ', '多飲異常'];
var DEFAULT_WET_WATER_PCT = 80;
var DEFAULT_DRY_WATER_PCT = 10;

function classifyWaterStatus(intakePerKg) {
  if (intakePerKg == null || isNaN(intakePerKg)) return null;
  if (intakePerKg < 10) return WATER_STATUS_LABELS[0];
  if (intakePerKg < 21) return WATER_STATUS_LABELS[1];
  if (intakePerKg <= 70) return WATER_STATUS_LABELS[2];
  return WATER_STATUS_LABELS[3];
}

async function calcWetFoodWater(db, catId, date) {
  var sql = "SELECT fl.offered_g, fl.eaten_pct, f.form, f.water_pct FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id WHERE fl.cat_id = ? AND fl.log_date = ? AND fl.offered_g IS NOT NULL AND fl.eaten_pct IS NOT NULL";
  var rows = (await db.prepare(sql).bind(catId, date).all()).results || [];
  var totalMl = 0;
  for (var i = 0; i < rows.length; i++) {
    var form = String(rows[i].form || 'dry').toLowerCase();
    var isDry = form === 'dry';
    var waterPct = rows[i].water_pct != null ? rows[i].water_pct : (isDry ? DEFAULT_DRY_WATER_PCT : DEFAULT_WET_WATER_PCT);
    var eatenG = (rows[i].offered_g || 0) * ((rows[i].eaten_pct || 0) / 100);
    totalMl += eatenG * (waterPct / 100);
  }
  return Math.round(totalMl * 10) / 10;
}

async function getLatestCatWeight(db, catId) {
  var row = await db.prepare(
    "SELECT CAST(value AS REAL) AS kg FROM health_records WHERE cat_id = ? AND record_type = 'weight' ORDER BY record_date DESC LIMIT 1"
  ).bind(catId).first();
  return row && row.kg > 0 ? row.kg : null;
}

async function recalcWaterMeasurement(db, row) {
  if (row.set_weight_g == null || row.measure_weight_g == null) return row;
  var consumed = Math.max(0, row.set_weight_g - row.measure_weight_g);
  var wetWater = await calcWetFoodWater(db, row.cat_id, row.measurement_date);
  var total = Math.round((consumed + wetWater) * 10) / 10;
  var wkg = await getLatestCatWeight(db, row.cat_id);
  var perKg = wkg ? Math.round(total / wkg * 10) / 10 : null;
  var status = perKg != null ? classifyWaterStatus(perKg) : null;
  await db.prepare(
    "UPDATE water_measurements SET consumed_ml = ?, wet_food_water_ml = ?, total_intake_ml = ?, cat_weight_kg = ?, intake_per_kg = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(consumed, wetWater, total, wkg, perKg, status, row.id).run();
  row.consumed_ml = consumed;
  row.wet_food_water_ml = wetWater;
  row.total_intake_ml = total;
  row.cat_weight_kg = wkg;
  row.intake_per_kg = perKg;
  row.status = status;
  return row;
}

async function handleWater(method, req, db, staffAuth, url, subPath) {
  var idMatch = subPath.match(/^\/water\/(\d+)$/);

  if (method === 'GET' && (subPath === '/water' || subPath === '/water/')) {
    var catId = url.searchParams.get('cat_id');
    if (!catId) return opsJson({ error: 'bad_request', message: 'cat_id required' }, 400);
    var days = parseInt(url.searchParams.get('days') || '14', 10) || 14;
    var since = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -days + 1);
    var rows = (await db.prepare(
      'SELECT * FROM water_measurements WHERE cat_id = ? AND measurement_date >= ? ORDER BY measurement_date DESC'
    ).bind(catId, since).all()).results || [];
    return opsJson({ measurements: rows });
  }

  if (method === 'POST' && (subPath === '/water' || subPath === '/water/')) {
    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }
    if (!body.cat_id) return opsJson({ error: 'bad_request', message: 'cat_id required' }, 400);
    var date = body.measurement_date || jstCalendarYmdFromInstant(Date.now());
    var existing = await db.prepare(
      'SELECT * FROM water_measurements WHERE cat_id = ? AND measurement_date = ?'
    ).bind(body.cat_id, date).first();

    if (existing) {
      var updates = [];
      var vals = [];
      if (body.set_weight_g != null) { updates.push('set_weight_g = ?'); vals.push(body.set_weight_g); }
      if (body.measure_weight_g != null) { updates.push('measure_weight_g = ?'); vals.push(body.measure_weight_g); }
      if (body.notes !== undefined) { updates.push('notes = ?'); vals.push(body.notes || null); }
      updates.push("updated_at = datetime('now')");
      vals.push(existing.id);
      var upsertSql = 'UPDATE water_measurements SET ' + updates.join(', ') + ' WHERE id = ?';
      var upsertStmt = db.prepare(upsertSql);
      upsertStmt = upsertStmt.bind.apply(upsertStmt, vals);
      await upsertStmt.run();
      var updated = await db.prepare('SELECT * FROM water_measurements WHERE id = ?').bind(existing.id).first();
      updated = await recalcWaterMeasurement(db, updated);
      return opsJson({ measurement: updated });
    }

    var row = await db.prepare(
      'INSERT INTO water_measurements (cat_id, measurement_date, set_weight_g, measure_weight_g, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
    ).bind(
      body.cat_id, date,
      body.set_weight_g != null ? body.set_weight_g : null,
      body.measure_weight_g != null ? body.measure_weight_g : null,
      body.notes || null,
      staffAuth.staffId
    ).first();
    row = await recalcWaterMeasurement(db, row);
    return opsJson({ measurement: row }, 201);
  }

  if (method === 'PUT' && idMatch) {
    var id = Number(idMatch[1]);
    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }
    var existing = await db.prepare('SELECT * FROM water_measurements WHERE id = ?').bind(id).first();
    if (!existing) return opsJson({ error: 'not_found' }, 404);
    var updates = [];
    var vals = [];
    if (body.set_weight_g != null) { updates.push('set_weight_g = ?'); vals.push(body.set_weight_g); }
    if (body.measure_weight_g != null) { updates.push('measure_weight_g = ?'); vals.push(body.measure_weight_g); }
    if (body.notes !== undefined) { updates.push('notes = ?'); vals.push(body.notes || null); }
    if (updates.length === 0) return opsJson({ error: 'bad_request', message: 'Nothing to update' }, 400);
    updates.push("updated_at = datetime('now')");
    vals.push(id);
    var sqlUp = 'UPDATE water_measurements SET ' + updates.join(', ') + ' WHERE id = ?';
    var putStmt = db.prepare(sqlUp);
    putStmt = putStmt.bind.apply(putStmt, vals);
    await putStmt.run();
    var updated = await db.prepare('SELECT * FROM water_measurements WHERE id = ?').bind(id).first();
    updated = await recalcWaterMeasurement(db, updated);
    return opsJson({ measurement: updated });
  }

  if (method === 'DELETE' && idMatch) {
    var id = Number(idMatch[1]);
    var existing = await db.prepare('SELECT * FROM water_measurements WHERE id = ?').bind(id).first();
    if (!existing) return opsJson({ error: 'not_found' }, 404);
    await db.prepare('DELETE FROM water_measurements WHERE id = ?').bind(id).run();
    return opsJson({ ok: true, deleted_id: id });
  }

  return opsJson({ error: 'method_not_allowed' }, 405);
}

// ───────────────────────────────────────────────────────────────────────────────
// 薬マスター
// ───────────────────────────────────────────────────────────────────────────────

/** 備考の先頭に「参考URL: …」を付与（reference_url が空なら既存の参考URL行のみ除去） */
function mergeMedicineReferenceUrl(existingNotes, refUrlRaw) {
  var u = refUrlRaw != null ? String(refUrlRaw).trim() : '';
  var lines = String(existingNotes || '').split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    if (!/^\s*参考URL:\s*/.test(lines[i])) out.push(lines[i]);
  }
  var body = out.join('\n').replace(/^\n+|\n+$/g, '').trim();
  if (u) {
    var prefix = '参考URL: ' + u;
    return body ? prefix + '\n' + body : prefix;
  }
  return body || null;
}

async function handleMedicines(method, req, db, staffAuth, subPath, env) {
  // /health/medicines/scrape (URL → 薬情報抽出)
  if (subPath === '/medicines/scrape' || subPath === '/medicines/scrape/') {
    if (method === 'POST') return scrapeMedicine(req, env);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /health/medicines/search (テキスト → Web検索 → 薬情報抽出)
  if (subPath === '/medicines/search' || subPath === '/medicines/search/') {
    if (method === 'POST') return searchMedicine(req, env);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /health/medicines/:id
  var idMatch = subPath.match(/^\/medicines\/([^/]+)$/);

  if (method === 'PUT' && idMatch) {
    return updateMedicine(req, db, idMatch[1]);
  }

  if (method === 'GET') {
    var url = new URL(req.url);
    var speciesFilter = url.searchParams.get('species');
    var sql = 'SELECT * FROM medicines';
    var params = [];
    var conditions = [];

    if (speciesFilter) {
      conditions.push("species IN (?, 'both')");
      params.push(speciesFilter);
    }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY category, name';

    var stmt = db.prepare(sql);
    if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
    var result = await stmt.all();
    return opsJson({ medicines: result.results || [] });
  }

  if (method === 'POST') {
    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }

    if (!body.name) {
      return opsJson({ error: 'bad_request', message: 'name required' }, 400);
    }

    // AI で薬情報を自動取得
    var aiInfo = null;
    if (env && env.AI && !body.category && !body.form) {
      try { aiInfo = await lookupMedicineInfo(env, body.name); } catch (_) {}
    }

    var medId = body.id || ('med_' + body.name.replace(/\s+/g, '_').toLowerCase() + '_' + Date.now());
    var category = body.category || (aiInfo && aiInfo.category) || 'other';
    var form = body.form || (aiInfo && aiInfo.form) || null;
    var unit = body.unit || (aiInfo && aiInfo.unit) || null;
    var genericName = body.generic_name || (aiInfo && aiInfo.generic_name) || null;
    var notes = body.notes || (aiInfo && aiInfo.notes) || null;
    if (body.reference_url !== undefined) {
      notes = mergeMedicineReferenceUrl(notes, body.reference_url);
    }

    var row = await db.prepare(
      'INSERT INTO medicines (id, name, generic_name, category, form, unit, species, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *'
    ).bind(
      medId,
      body.name,
      genericName,
      category,
      form,
      unit,
      body.species || 'cat',
      notes
    ).first();

    await syncProductDict(db, medId, 'medicine', body.name, null);

    return opsJson({ medicine: row, ai_enriched: !!aiInfo }, 201);
  }

  return opsJson({ error: 'method_not_allowed' }, 405);
}

var MED_LOOKUP_PROMPT = [
  'あなたは獣医薬学のエキスパートです。以下の猫用の薬名から情報を推定してJSON形式で返してください。',
  '不明な場合は null を入れてください。推測で構いませんが、確度が低い場合は null にしてください。',
  '',
  '返答はJSON のみ（説明文不要）:',
  '{',
  '  "generic_name": "一般名（わかれば）",',
  '  "category": "antibiotic|antifungal|anti_inflammatory|painkiller|cardiac|renal|gastro|hormone|supplement|eye|ear|skin|other のいずれか",',
  '  "form": "錠剤|カプセル|粉末|液剤|注射|点眼|点耳|軟膏|パッチ|その他 のいずれか",',
  '  "unit": "錠|ml|mg|滴|包|g のいずれか（投与単位）",',
  '  "notes": "簡潔な補足（用途・注意点を1行で）"',
  '}',
].join('\n');

async function lookupMedicineInfo(env, medicineName) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { resolve(null); }, 6000);

    env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: MED_LOOKUP_PROMPT },
        { role: 'user', content: medicineName },
      ],
      max_tokens: 250,
      temperature: 0.1,
    }).then(function (resp) {
      clearTimeout(timer);
      var text = (resp && resp.response) ? resp.response : '';
      var jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { resolve(null); return; }
      try {
        var info = JSON.parse(jsonMatch[0]);
        resolve({
          generic_name: info.generic_name || null,
          category: info.category || null,
          form: info.form || null,
          unit: info.unit || null,
          notes: info.notes || null,
        });
      } catch (_) { resolve(null); }
    }).catch(function () {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ── 薬情報の URL スクレイプ ─────────────────────────────────────────────────

var MED_SCRAPE_PROMPT = [
  'あなたは獣医薬学のエキスパートです。以下のWebページテキストから動物用医薬品/サプリメントの情報を抽出して JSON で返してください。',
  '不明な項目は null にしてください。推測で構いませんが、確度が低い場合は null にしてください。',
  '',
  '返答はJSONのみ（説明文不要）:',
  '{',
  '  "name": "製品名",',
  '  "generic_name": "一般名/有効成分（わかれば）",',
  '  "category": "antibiotic|antifungal|anti_inflammatory|painkiller|heart|kidney|thyroid|steroid|supplement|eye|ear|skin|gastrointestinal|antiparasitic|other のいずれか",',
  '  "form": "tablet|capsule|powder|liquid|injection|ointment|eye_drop|ear_drop|patch|other のいずれか",',
  '  "unit": "錠|ml|mg|滴|包|g のいずれか（投与単位）",',
  '  "species": "cat|dog|both のいずれか",',
  '  "notes": "用途・注意点を1行で"',
  '}',
].join('\n');

async function fetchPageText(url) {
  var res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'ja,en;q=0.5',
    },
    signal: AbortSignal.timeout(12000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  var html = await res.text();
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

async function extractMedicineFromPage(env, pageText) {
  if (!env || !env.AI) return null;
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { resolve(null); }, 10000);
    env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: MED_SCRAPE_PROMPT },
        { role: 'user', content: pageText.slice(0, 5000) },
      ],
      max_tokens: 350,
      temperature: 0.1,
    }).then(function (resp) {
      clearTimeout(timer);
      var text = (resp && resp.response) ? resp.response : '';
      var jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { resolve(null); return; }
      try { resolve(JSON.parse(jsonMatch[0])); } catch (_) { resolve(null); }
    }).catch(function () { clearTimeout(timer); resolve(null); });
  });
}

async function scrapeMedicine(req, env) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  if (!body.url) return opsJson({ error: 'missing_fields', message: 'url は必須です' }, 400);

  try {
    var pageText = await fetchPageText(body.url);
    var extracted = await extractMedicineFromPage(env, pageText);
    if (extracted && extracted.name) {
      return opsJson({ status: 'ok', extracted: extracted, url: body.url });
    }
    return opsJson({ status: 'scrape_failed', message: 'ページから薬情報を抽出できませんでした', url: body.url });
  } catch (err) {
    return opsJson({ status: 'scrape_failed', message: err.message || 'ページ取得に失敗', url: body.url });
  }
}

// ── 薬名テキスト検索 → Web検索 → スクレイプ ──────────────────────────────────

var MED_KNOWN_DOMAINS = [
  'vet.royalcanin.jp', 'vet.allergy.go.jp',
  'pmda.go.jp', 'drugs.com', 'msd-animal-health.jp',
  'zenoaq.jp', 'meiji-seika-pharma.co.jp', 'elanco.com',
  'vet-navi.com', 'petgo.jp', 'amazon.co.jp',
  'rakuten.co.jp', 'askul.co.jp',
];

async function medWebSearch(query) {
  var searchKeyword = query + ' 猫 犬 動物用医薬品';
  var searchUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(searchKeyword);

  try {
    var res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'ja,en;q=0.5',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!res.ok) return [];
    var html = await res.text();
    return parseMedSearchResults(html);
  } catch (_) {
    return [];
  }
}

function parseMedSearchResults(html) {
  var results = [];
  var seen = {};
  var re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]*)</g;
  var match;
  while ((match = re.exec(html)) !== null && results.length < 10) {
    try {
      var href = match[1].replace(/&amp;/g, '&');
      var title = match[2].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
      var uddgM = href.match(/uddg=([^&]+)/);
      if (!uddgM) continue;
      var rawUrl = decodeURIComponent(uddgM[1]);
      if (rawUrl.indexOf('duckduckgo.com') !== -1) continue;
      if (rawUrl.indexOf('google.com') !== -1) continue;
      if (seen[rawUrl]) continue;
      seen[rawUrl] = true;
      results.push({ url: rawUrl, title: title || rawUrl });
    } catch (_) {}
  }
  return results;
}

async function searchMedicine(req, env) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  if (!body.query || body.query.trim().length < 2) {
    return opsJson({ error: 'missing_fields', message: '検索テキスト(2文字以上)が必要です' }, 400);
  }

  var query = body.query.trim();

  if (query.indexOf('http') === 0) {
    try {
      var pageText = await fetchPageText(query);
      var extracted = await extractMedicineFromPage(env, pageText);
      if (extracted && extracted.name) {
        return opsJson({ status: 'ok', extracted: extracted, url: query, candidates: [], query: query });
      }
      return opsJson({ status: 'scrape_failed', message: 'URL から薬情報を抽出できませんでした', url: query, query: query });
    } catch (err) {
      return opsJson({ status: 'scrape_failed', message: err.message || 'URL取得失敗', url: query, query: query });
    }
  }

  // AI lookup (fast, name-based)
  var aiInfo = null;
  if (env && env.AI) {
    try { aiInfo = await lookupMedicineInfo(env, query); } catch (_) {}
  }

  try {
    var results = await medWebSearch(query);

    if (!results || results.length === 0) {
      if (aiInfo && aiInfo.generic_name) {
        return opsJson({ status: 'ok', extracted: Object.assign({ name: query }, aiInfo), url: null, candidates: [], query: query });
      }
      return opsJson({ status: 'no_results', query: query, message: '検索結果が見つかりません' });
    }

    var allCandidates = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var priority = 999;
      for (var d = 0; d < MED_KNOWN_DOMAINS.length; d++) {
        if (r.url.indexOf(MED_KNOWN_DOMAINS[d]) !== -1) { priority = d; break; }
      }
      allCandidates.push({ url: r.url, title: r.title, priority: priority });
    }
    allCandidates.sort(function (a, b) { return a.priority - b.priority; });

    var candidateList = [];
    for (var c = 0; c < Math.min(allCandidates.length, 5); c++) {
      candidateList.push({ url: allCandidates[c].url, title: allCandidates[c].title });
    }

    var extracted = null;
    var usedUrl = null;
    var maxTries = Math.min(allCandidates.length, 3);

    for (var t = 0; t < maxTries; t++) {
      var tryUrl = allCandidates[t].url;
      try {
        var pageText = await fetchPageText(tryUrl);
        var tryResult = await extractMedicineFromPage(env, pageText);
        if (tryResult && tryResult.name) {
          extracted = tryResult;
          usedUrl = tryUrl;
          break;
        }
      } catch (_) {}
    }

    if (!extracted && aiInfo) {
      extracted = Object.assign({ name: query }, aiInfo);
    }

    if (extracted && extracted.name) {
      return opsJson({ status: 'ok', extracted: extracted, url: usedUrl, candidates: candidateList, query: query });
    }

    return opsJson({
      status: 'partial',
      message: 'ページから薬情報を抽出できませんでした',
      candidates: candidateList,
      url: allCandidates[0] ? allCandidates[0].url : null,
      query: query,
    });
  } catch (err) {
    if (aiInfo && aiInfo.generic_name) {
      return opsJson({ status: 'ok', extracted: Object.assign({ name: query }, aiInfo), url: null, candidates: [], query: query });
    }
    return opsJson({ status: 'search_failed', message: err.message || '検索に失敗', query: query });
  }
}

// ── 薬マスター更新 ──────────────────────────────────────────────────────────

async function updateMedicine(req, db, medId) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  var existing = await db.prepare('SELECT * FROM medicines WHERE id = ?').bind(medId).first();
  if (!existing) return opsJson({ error: 'not_found', message: 'Medicine not found' }, 404);

  if (body.reference_url !== undefined) {
    body.notes = mergeMedicineReferenceUrl(
      body.notes !== undefined ? body.notes : existing.notes,
      body.reference_url
    );
  }

  var sets = [];
  var params = [];
  var fields = ['name', 'generic_name', 'category', 'form', 'unit', 'species', 'notes', 'active'];
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i];
    if (body[key] !== undefined) { sets.push(key + ' = ?'); params.push(body[key]); }
  }

  if (sets.length === 0) return opsJson({ error: 'no_fields' }, 400);
  params.push(medId);

  var sql = 'UPDATE medicines SET ' + sets.join(', ') + ' WHERE id = ?';
  await db.prepare(sql).bind.apply(db.prepare(sql), params).run();

  var updated = await db.prepare('SELECT * FROM medicines WHERE id = ?').bind(medId).first();

  if (body.name !== undefined) {
    await resyncProductDict(db, medId, 'medicine', updated.name, null);
  }

  return opsJson({ medicine: updated });
}

// ───────────────────────────────────────────────────────────────────────────────
// 体重履歴
// ───────────────────────────────────────────────────────────────────────────────

async function handleWeightHistory(url, db) {
  var catId = url.searchParams.get('cat_id');
  if (!catId) return opsJson({ error: 'bad_request', message: 'cat_id required' }, 400);

  var months = Math.min(24, parseInt(url.searchParams.get('months') || '6', 10) || 6);
  var since = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -months * 30);

  var result = await db.prepare(
    "SELECT record_date AS date, value FROM health_records WHERE cat_id = ? AND record_type = 'weight' AND record_date >= ? ORDER BY record_date ASC"
  ).bind(catId, since).all();

  var weights = (result.results || []).map(function (r) {
    return { date: r.date, value: parseFloat(r.value) || null };
  }).filter(function (r) { return r.value !== null; });

  return opsJson({ cat_id: catId, weights: weights });
}

// ───────────────────────────────────────────────────────────────────────────────
// ヘルパー: 当日分の投薬ログを生成
// ───────────────────────────────────────────────────────────────────────────────

var DOW_MAP = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };

export function shouldGenerateForDay(frequency, date, startDate) {
  if (!frequency || frequency === '毎日' || frequency === '1日1回' || frequency === '1日2回' || frequency === '1日3回') return true;
  if (frequency === '必要時') return false;

  var d = new Date(date + 'T12:00:00+09:00');

  if (frequency === '月末のみ') {
    var lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() === lastDay;
  }

  // 週:月,水,金 形式（特定曜日指定）
  if (frequency.indexOf('週:') === 0) {
    var days = frequency.slice(2).split(',');
    var dow = d.getUTCDay();
    for (var i = 0; i < days.length; i++) {
      if (DOW_MAP[days[i].trim()] === dow) return true;
    }
    return false;
  }

  // 月1:末日 or 月1:15 形式（毎月N日）
  if (frequency.indexOf('月1:') === 0) {
    var dayPart = frequency.slice(3);
    if (dayPart === '末日') {
      var lastDay2 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return d.getUTCDate() === lastDay2;
    }
    var dayOfMonth = parseInt(dayPart, 10);
    if (isNaN(dayOfMonth)) return false;
    var monthLastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() === Math.min(dayOfMonth, monthLastDay);
  }

  var t1 = new Date(date + 'T12:00:00+09:00').getTime();
  var t0 = new Date((startDate || date) + 'T12:00:00+09:00').getTime();
  var daysBetween = Math.round((t1 - t0) / 86400000);
  if (daysBetween < 0) return false;

  if (frequency === '隔日' || frequency === '隔日(A)') return daysBetween % 2 === 0;
  if (frequency === '隔日(B)') return daysBetween % 2 === 1;
  if (frequency === '2日に1回') return daysBetween % 2 === 0;
  if (frequency === '3日に1回') return daysBetween % 3 === 0;

  if (frequency === '週1回') return daysBetween % 7 === 0;
  if (frequency === '週3回') {
    var dow2 = d.getUTCDay();
    return dow2 === 1 || dow2 === 3 || dow2 === 5;
  }
  return true;
}

export async function generateLogsForDay(db, medicationId, catId, date, slots, frequency, startDate) {
  if (!shouldGenerateForDay(frequency, date, startDate || date)) return;
  for (var j = 0; j < slots.length; j++) {
    var scheduledAt = date + 'T' + slots[j];
    var exists = await db.prepare(
      'SELECT id FROM medication_logs WHERE medication_id = ? AND scheduled_at = ?'
    ).bind(medicationId, scheduledAt).first();
    if (!exists) {
      await db.prepare(
        'INSERT INTO medication_logs (medication_id, cat_id, scheduled_at, status) VALUES (?, ?, ?, ?)'
      ).bind(medicationId, catId, scheduledAt, 'pending').run();
    }
  }
}

/**
 * 指定日の全猫分の投薬ログを一括生成（業務終了 / cron から呼ばれる）
 */
export async function generateAllMedLogsForDate(db, targetDate, locationId) {
  var sql = "SELECT m.*, c.location_id FROM medications m JOIN cats c ON m.cat_id = c.id WHERE m.active = 1 AND m.start_date <= ? AND (m.end_date IS NULL OR m.end_date >= ?)";
  var params = [targetDate, targetDate];
  if (locationId) { sql += ' AND c.location_id = ?'; params.push(locationId); }

  var stmt = db.prepare(sql);
  if (params.length === 3) stmt = stmt.bind(params[0], params[1], params[2]);
  else stmt = stmt.bind(params[0], params[1]);
  var result = await stmt.all();
  var meds = result.results || [];

  var generated = 0;
  for (var i = 0; i < meds.length; i++) {
    var med = meds[i];
    var slots = [];
    try { slots = JSON.parse(med.time_slots || '["朝"]'); } catch (_) { slots = ['朝']; }
    if (!Array.isArray(slots) || slots.length === 0) slots = ['朝'];
    if (shouldGenerateForDay(med.frequency || '毎日', targetDate, med.start_date || targetDate)) {
      await generateLogsForDay(db, med.id, med.cat_id, targetDate, slots, med.frequency || '毎日', med.start_date);
      generated++;
    }
  }
  return { generated: generated };
}

/**
 * 次回投薬日を計算（カレンダー表示用）
 */
export function calcNextDoseDate(frequency, startDate, fromDate) {
  var baseYmd = fromDate || jstCalendarYmdFromInstant(Date.now());
  for (var d = 0; d < 60; d++) {
    var dateStr = jstCalendarAddDays(baseYmd, d);
    if (shouldGenerateForDay(frequency, dateStr, startDate)) return dateStr;
  }
  return null;
}

// ── 投薬プリセット ─────────────────────────────────────────────────────────────

var MAX_MEDICATIONS_PER_CAT = 32;

function isMedPresetMenuItemActive(row) {
  if (!row || row.menu_active === undefined || row.menu_active === null) return true;
  return Number(row.menu_active) === 1;
}

async function findOtherCatWithAssignedMedPreset(db, presetId, catId) {
  var row = await db.prepare(
    'SELECT id FROM cats WHERE assigned_medication_preset_id = ? AND id != ?'
  ).bind(presetId, catId).first();
  return row ? row.id : null;
}

async function handleMedicationPresets(method, req, db, staffAuth, url, subPath) {
  var applyMatch = subPath.match(/^\/medication-presets\/(\d+)\/apply$/);
  if (method === 'POST' && applyMatch) {
    return applyMedPreset(db, Number(applyMatch[1]), req);
  }

  var itemsMatch = subPath.match(/^\/medication-presets\/(\d+)\/items(?:\/(\d+))?$/);
  if (itemsMatch) {
    var presetId = Number(itemsMatch[1]);
    var itemId = itemsMatch[2] ? Number(itemsMatch[2]) : null;
    if (method === 'GET') return listMedPresetItems(db, presetId);
    if (method === 'POST') return addMedPresetItem(db, presetId, req);
    if (method === 'PUT' && itemId) return updateMedPresetItem(db, presetId, itemId, req);
    if (method === 'DELETE' && itemId) return deleteMedPresetItem(db, itemId);
  }

  var idMatch = subPath.match(/^\/medication-presets\/(\d+)$/);
  if (idMatch) {
    var pid = Number(idMatch[1]);
    if (method === 'PUT') return updateMedPreset(db, pid, req);
    if (method === 'DELETE') return deleteMedPreset(db, pid);
  }

  if (method === 'GET') return listMedPresets(db, url);
  if (method === 'POST') return createMedPreset(db, req, staffAuth);

  return opsJson({ error: 'method_not_allowed' }, 405);
}

async function listMedPresets(db, url) {
  url = url || new URL('http://local/');
  var locationId = url.searchParams.get('location_id') || '';
  var sql = [
    'SELECT p.*,',
    '(SELECT COUNT(*) FROM medication_preset_items mpi WHERE mpi.preset_id = p.id AND COALESCE(mpi.menu_active,1) = 1) AS item_count',
    'FROM medication_presets p',
    'WHERE COALESCE(p.active,1) = 1',
  ].join(' ');
  if (locationId === 'nekomata') {
    sql += " AND LOWER(TRIM(COALESCE(p.location_id,''))) = 'nekomata'";
  } else if (locationId === 'cafe') {
    sql += " AND LOWER(TRIM(COALESCE(p.location_id,''))) != 'nekomata'";
  }
  sql += ' ORDER BY p.name';
  var rows = (await db.prepare(sql).all()).results || [];

  var presetToCat = {};
  try {
    var acats = await db.prepare(
      'SELECT id, name, assigned_medication_preset_id FROM cats WHERE assigned_medication_preset_id IS NOT NULL'
    ).all();
    var acRows = acats.results || [];
    for (var ac = 0; ac < acRows.length; ac++) {
      var cr = acRows[ac];
      if (cr.assigned_medication_preset_id == null) continue;
      presetToCat[String(cr.assigned_medication_preset_id)] = { id: cr.id, name: cr.name };
    }
  } catch (eMap) {
    console.warn('listMedPresets assigned_cat', eMap && eMap.message);
  }
  for (var i = 0; i < rows.length; i++) {
    rows[i].assigned_cat = presetToCat[String(rows[i].id)] || null;
  }

  return opsJson({ presets: rows });
}

async function createMedPreset(db, req, staffAuth) {
  void staffAuth;
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  if (!body.name) return opsJson({ error: 'validation', message: 'name は必須です' }, 400);
  var loc = body.location_id === 'nekomata' ? 'nekomata' : 'cafe';
  var insRow = await db.prepare(
    'INSERT INTO medication_presets (name, description, location_id, active) VALUES (?, ?, ?, 1) RETURNING id'
  )
    .bind(body.name, body.description || null, loc)
    .first();
  var newId = insRow && insRow.id != null ? insRow.id : null;
  if (newId == null) {
    return opsJson({ error: 'server_error', message: '投薬プリセットの作成に失敗しました' }, 500);
  }
  return opsJson({ ok: true, id: newId });
}

async function updateMedPreset(db, id, req) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  if (!body.name) return opsJson({ error: 'validation', message: 'name は必須です' }, 400);
  var locClause = '';
  var locVal = null;
  if (body.location_id === 'nekomata' || body.location_id === 'cafe') {
    locClause = ', location_id = ?';
    locVal = body.location_id;
  }
  if (locVal !== null) {
    await db.prepare(
      'UPDATE medication_presets SET name = ?, description = ?' + locClause + ", updated_at = datetime('now') WHERE id = ?"
    ).bind(body.name, body.description || null, locVal, id).run();
  } else {
    await db.prepare(
      'UPDATE medication_presets SET name = ?, description = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(body.name, body.description || null, id).run();
  }
  return opsJson({ ok: true });
}

async function deleteMedPreset(db, id) {
  await db.prepare(
    'UPDATE cats SET assigned_medication_preset_id = NULL, updated_at = datetime(\'now\') WHERE assigned_medication_preset_id = ?'
  ).bind(id).run();
  await db.prepare(
    "UPDATE medication_presets SET active = 0, updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  return opsJson({ ok: true, deleted_id: id });
}

async function listMedPresetItems(db, presetId) {
  var rows = (await db.prepare(
    'SELECT mpi.*, m.name AS medicine_name, m.form AS medicine_form FROM medication_preset_items mpi LEFT JOIN medicines m ON m.id = mpi.medicine_id WHERE mpi.preset_id = ? ORDER BY mpi.sort_order, mpi.id'
  ).bind(presetId).all()).results || [];
  return opsJson({ items: rows });
}

async function addMedPresetItem(db, presetId, req) {
  var body = await req.json();
  if (!body.medicine_id) return opsJson({ error: 'validation', message: 'medicine_id は必須です' }, 400);
  var ts = body.time_slots || '["朝","晩"]';
  if (typeof ts !== 'string') ts = JSON.stringify(ts);
  var sortOrder = body.sort_order != null ? parseInt(body.sort_order, 10) : 0;
  if (isNaN(sortOrder)) sortOrder = 0;
  var menuActive = body.menu_active !== undefined && body.menu_active !== null ? (Number(body.menu_active) === 0 ? 0 : 1) : 1;
  var r = await db.prepare(
    'INSERT INTO medication_preset_items (preset_id, medicine_id, dosage_amount, dosage_unit, frequency, time_slots, route, notes, menu_active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(presetId, body.medicine_id, body.dosage_amount || null, body.dosage_unit || null, body.frequency || '毎日', ts, body.route || null, body.notes || null, menuActive, sortOrder).run();
  return opsJson({ ok: true, id: r.meta.last_row_id });
}

async function updateMedPresetItem(db, presetId, itemId, req) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  var row = await db.prepare('SELECT * FROM medication_preset_items WHERE id = ?').bind(itemId).first();
  if (!row) return opsJson({ error: 'not_found', message: 'Item not found' }, 404);
  if (Number(row.preset_id) !== presetId) return opsJson({ error: 'forbidden', message: 'Preset mismatch' }, 403);

  var medicineId = body.medicine_id !== undefined ? body.medicine_id : row.medicine_id;
  if (!medicineId) return opsJson({ error: 'validation', message: 'medicine_id は必須です' }, 400);

  var dosageAmount = body.dosage_amount !== undefined ? body.dosage_amount : row.dosage_amount;
  var dosageUnit = body.dosage_unit !== undefined ? body.dosage_unit : row.dosage_unit;
  var frequency = body.frequency !== undefined ? body.frequency : row.frequency;
  var route = body.route !== undefined ? body.route : row.route;
  var notes = body.notes !== undefined ? body.notes : row.notes;
  var sortOrder = body.sort_order !== undefined ? parseInt(body.sort_order, 10) : row.sort_order;
  if (isNaN(sortOrder)) sortOrder = row.sort_order || 0;
  var menuActive = row.menu_active;
  if (menuActive === undefined || menuActive === null) menuActive = 1;
  if (body.menu_active !== undefined && body.menu_active !== null) {
    menuActive = Number(body.menu_active) === 0 ? 0 : 1;
  }

  var ts = body.time_slots;
  if (ts !== undefined) {
    if (typeof ts !== 'string') ts = JSON.stringify(ts);
  } else {
    ts = row.time_slots || '["朝","晩"]';
  }

  await db.prepare(
    'UPDATE medication_preset_items SET medicine_id = ?, dosage_amount = ?, dosage_unit = ?, frequency = ?, time_slots = ?, route = ?, notes = ?, menu_active = ?, sort_order = ? WHERE id = ?'
  ).bind(medicineId, dosageAmount != null ? dosageAmount : null, dosageUnit || null, frequency || '毎日', ts, route || null, notes || null, menuActive, sortOrder, itemId).run();

  return opsJson({ ok: true, id: itemId });
}

async function deleteMedPresetItem(db, itemId) {
  await db.prepare('DELETE FROM medication_preset_items WHERE id = ?').bind(itemId).run();
  return opsJson({ ok: true, deleted_id: itemId });
}

async function applyMedPreset(db, presetId, req) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  var catId = body.cat_id;
  if (!catId) return opsJson({ error: 'validation', message: 'cat_id は必須です' }, 400);

  var presetRow = await db.prepare(
    'SELECT id, name FROM medication_presets WHERE id = ? AND COALESCE(active,1) = 1'
  ).bind(presetId).first();
  if (!presetRow) {
    return opsJson({ error: 'not_found', message: 'プリセットが見つかりません' }, 404);
  }

  var singleItemId = body.preset_item_id != null && body.preset_item_id !== '' ? parseInt(body.preset_item_id, 10) : null;
  if (singleItemId != null && isNaN(singleItemId)) return opsJson({ error: 'validation', message: 'preset_item_id が不正です' }, 400);

  var sql = 'SELECT * FROM medication_preset_items WHERE preset_id = ?';
  var bindArr = [presetId];
  if (singleItemId != null) {
    sql += ' AND id = ?';
    bindArr.push(singleItemId);
  }
  var stmt = db.prepare(sql);
  var items = (await stmt.bind.apply(stmt, bindArr).all()).results || [];
  if (items.length === 0) {
    return opsJson({
      error: singleItemId != null ? 'not_found' : 'empty',
      message: singleItemId != null ? '指定した薬はこのプリセットにありません' : 'プリセットにアイテムがありません',
    }, singleItemId != null ? 404 : 400);
  }

  var today = jstCalendarYmdFromInstant(Date.now());
  var created = [];

  if (singleItemId == null) {
    var otherCat = await findOtherCatWithAssignedMedPreset(db, presetId, catId);
    if (otherCat) {
      return opsJson({ error: 'preset_conflict', message: 'この投薬プリセットは別の猫に割り当て済みです' }, 409);
    }

    var activePresetItems = [];
    for (var ai = 0; ai < items.length; ai++) {
      if (isMedPresetMenuItemActive(items[ai])) activePresetItems.push(items[ai]);
    }
    if (activePresetItems.length === 0) {
      return opsJson({ error: 'empty', message: '有効な薬がありません（プリセット編集で「対象」を確認）' }, 400);
    }
    if (activePresetItems.length > MAX_MEDICATIONS_PER_CAT) {
      return opsJson({
        error: 'limit_reached',
        message: '有効プリセット行が上限（' + MAX_MEDICATIONS_PER_CAT + '件）を超えます',
      }, 400);
    }

    /** 献立と同型: プリセット全面適用時は当該猫の active 投薬をすべて無効化してから有効メニューのみ載せる */
    await db.prepare(
      "UPDATE medications SET active = 0, end_date = COALESCE(end_date, ?), updated_at = datetime('now') WHERE cat_id = ? AND active = 1"
    ).bind(today, catId).run();

    await db.prepare(
      "UPDATE cats SET assigned_medication_preset_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(presetId, catId).run();

    items = activePresetItems;
  } else {
    var one = items[0];
    if (!isMedPresetMenuItemActive(one)) {
      return opsJson({ error: 'menu_inactive', message: 'この薬行は無効のため適用できません（プリセット編集で「対象」にしてください）' }, 400);
    }
    var catRow = await db.prepare('SELECT assigned_medication_preset_id FROM cats WHERE id = ?').bind(catId).first();
    var assignedPid = catRow && catRow.assigned_medication_preset_id != null && catRow.assigned_medication_preset_id !== ''
      ? Number(catRow.assigned_medication_preset_id)
      : null;
    if (assignedPid !== Number(presetId)) {
      return opsJson({
        error: 'preset_mismatch',
        message: '1件だけ追加は、この猫に紐づいた投薬プリセットからのみ可能です（先に「全て適用」で紐づけ）',
      }, 400);
    }
    var cntAll = await db.prepare('SELECT COUNT(*) AS c FROM medications WHERE cat_id = ? AND active = 1').bind(catId).first();
    var curN = cntAll ? cntAll.c : 0;
    if (curN + 1 > MAX_MEDICATIONS_PER_CAT) {
      return opsJson({ error: 'limit_reached', message: '1匹あたり最大' + MAX_MEDICATIONS_PER_CAT + '件です' }, 400);
    }
    items = [one];
  }

  /** 1件だけ追加は staff + preset_item_id（朝の自動整合で消えない・猫詳細から削除可）。全面適用は preset。 */
  var insertPlanType = singleItemId != null ? 'staff' : 'preset';

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var ts = it.time_slots || '["朝","晩"]';
    if (typeof ts !== 'string') ts = JSON.stringify(ts);
    var r = await db.prepare(
      'INSERT INTO medications (cat_id, medicine_id, dosage_amount, dosage_unit, frequency, time_slots, with_food, route, prescribed_by, purpose, start_date, end_date, taper_plan, notes, active, plan_type, preset_id, preset_item_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, NULL, NULL, ?, 1, ?, ?, ?)'
    ).bind(
      catId, it.medicine_id, it.dosage_amount, it.dosage_unit, it.frequency || '毎日', ts,
      it.route || null, today, it.notes || null, insertPlanType, presetId, it.id
    ).run();
    var medId = r.meta.last_row_id;
    created.push(medId);

    var slots = [];
    try { slots = JSON.parse(ts); } catch (_) { slots = ['朝', '晩']; }
    await generateLogsForDay(db, medId, catId, today, slots, it.frequency || '毎日', today);
  }

  return opsJson({
    ok: true,
    created_medication_ids: created,
    count: created.length,
    preset_name: presetRow.name,
  });
}

/**
 * 投薬プリセット再適用（1拠点）。業務終了と cron から呼ばれる。
 * 献立 replaceCatFeedingPlansFromActivePreset と同型: 割当猫の active 投薬をすべて無効化し、有効メニューだけ INSERT する。
 */
export async function reapplyMedicationPresetsForLocation(db, locationId) {
  var cats = await db.prepare(
    "SELECT id, assigned_medication_preset_id FROM cats WHERE location_id = ? AND " + sqlStatusInCare() + " AND assigned_medication_preset_id IS NOT NULL"
  ).bind(locationId).all();
  var catRows = cats.results || [];
  var catsSynced = 0;
  var today = jstCalendarYmdFromInstant(Date.now());
  /** 当該猫の全投薬を止める（手動・プリセット問わず。有効メニュー0件でも残さない） */
  var deactivateAllMedsForCatSql =
    "UPDATE medications SET active = 0, end_date = COALESCE(end_date, ?), updated_at = datetime('now') " +
    "WHERE cat_id = ? AND active = 1";

  for (var c = 0; c < catRows.length; c++) {
    var cat = catRows[c];
    var pid = cat.assigned_medication_preset_id;

    var presetItems = await db.prepare(
      "SELECT * FROM medication_preset_items WHERE preset_id = ? AND COALESCE(menu_active, 1) = 1 ORDER BY sort_order, id"
    ).bind(pid).all();
    var items = presetItems.results || [];

    await db.prepare(deactivateAllMedsForCatSql).bind(today, cat.id).run();

    if (items.length === 0) {
      catsSynced++;
      continue;
    }

    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var ts = it.time_slots || '["朝","晩"]';
      if (typeof ts !== 'string') ts = JSON.stringify(ts);

      // 毎日・必要時以外の周期薬は、同じ medicine_id の既存最古の start_date を引き継ぐ。
      // 業務終了のたびに再 INSERT されることで start_date がリセットされ、投薬周期がずれるのを防ぐ。
      var freq = it.frequency || '毎日';
      var startDate = today;
      var isPeriodicFreq = freq !== '毎日' && freq !== '必要時' &&
        freq !== '1日2回' && freq !== '1日3回' &&
        freq.indexOf('週:') !== 0;
      if (isPeriodicFreq) {
        var prevRow = await db.prepare(
          "SELECT start_date FROM medications WHERE cat_id = ? AND medicine_id = ? ORDER BY id ASC LIMIT 1"
        ).bind(cat.id, it.medicine_id).first();
        if (prevRow && prevRow.start_date) startDate = prevRow.start_date;
      }

      var ins = await db.prepare(
        "INSERT INTO medications (cat_id, medicine_id, dosage_amount, dosage_unit, frequency, time_slots, with_food, route, start_date, notes, active, plan_type, preset_id, preset_item_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, 'preset', ?, ?)"
      ).bind(cat.id, it.medicine_id, it.dosage_amount, it.dosage_unit, freq, ts, it.route || null, startDate, it.notes || null, pid, it.id).run();
      var medId = ins.meta && ins.meta.last_row_id != null ? ins.meta.last_row_id : null;
      if (medId != null) {
        var slots = [];
        try { slots = JSON.parse(ts); } catch (_) { slots = ['朝', '晩']; }
        if (!Array.isArray(slots) || slots.length === 0) slots = ['朝', '晩'];
        await generateLogsForDay(db, medId, cat.id, today, slots, freq, startDate);
      }
    }
    catsSynced++;
  }

  return { applied: catsSynced };
}
