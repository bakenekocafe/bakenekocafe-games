/**
 * 引き受け申請: 外部ユーザーの申請・猫・メッセージ・ファイル API
 * handleIntakePublic から applicant 行（セッション検証済み）を渡して呼ぶ。
 */

import { opsJson } from './router.js';

var MODULE_CAT_PHOTO = 'intake_app_cat_photo';
var MODULE_CAT_DOC = 'intake_app_cat_doc';
var MODULE_APP_MSG = 'intake_app_msg';
var FILE_MAX_BYTES = 10 * 1024 * 1024;
var MAX_PHOTOS_PER_CAT = 20;
var PHOTO_MIMES = { 'image/jpeg': 1, 'image/png': 1, 'image/gif': 1, 'image/webp': 1 };
var DOC_MIMES = { 'image/jpeg': 1, 'image/png': 1, 'image/gif': 1, 'image/webp': 1, 'application/pdf': 1 };

function isNonEmpty(v) {
  return v != null && String(v).trim() !== '';
}

/**
 * @param {object} cat — intake_application_cats row
 * @param {number} photoCount
 */
export function computeCatCompletion(cat, photoCount) {
  var fields = [];
  var done = 0;
  var total = 0;
  function add(key, label, group, required, filled) {
    total++;
    if (filled) done++;
    fields.push({ key: key, label: label, group: group, required: required, filled: filled });
  }

  add('name', '名前', 'basic', true, isNonEmpty(cat.name));
  add('breed', '品種', 'basic', true, isNonEmpty(cat.breed));
  add('estimated_birth_date', '推定生年月日', 'basic', true, isNonEmpty(cat.estimated_birth_date));
  add('sex', '性別', 'basic', true, isNonEmpty(cat.sex));
  add('color_markings', '毛色・特徴', 'basic', false, isNonEmpty(cat.color_markings));
  add('microchip_id', 'マイクロチップ番号', 'basic', false, isNonEmpty(cat.microchip_id));
  add('neutered', '不妊去勢', 'basic', false, cat.neutered === 1 || cat.neutered === 0);
  add('weight_kg', '体重', 'basic', false, cat.weight_kg != null && cat.weight_kg !== '');

  add('rescue_date', '保護した日', 'rescue', true, isNonEmpty(cat.rescue_date));
  add('rescue_location', '保護した場所', 'rescue', true, isNonEmpty(cat.rescue_location));
  add('rescue_situation', '保護時の状況', 'rescue', true, isNonEmpty(cat.rescue_situation));
  add('story', '保護のストーリー', 'rescue', true, isNonEmpty(cat.story));
  add('living_environment', '飼育環境', 'rescue', false, isNonEmpty(cat.living_environment));
  add('personality', '性格・行動', 'rescue', false, isNonEmpty(cat.personality));
  add('special_needs', '特別なケア', 'rescue', false, isNonEmpty(cat.special_needs));

  add('health_summary', '健康状態概要', 'health', true, isNonEmpty(cat.health_summary));
  add('health_detail', '健康詳細', 'health', false, isNonEmpty(cat.health_detail));
  add('fiv_status', 'FIV', 'health', false, isNonEmpty(cat.fiv_status));
  add('felv_status', 'FeLV', 'health', false, isNonEmpty(cat.felv_status));
  add('vaccination_info', 'ワクチン', 'health', false, isNonEmpty(cat.vaccination_info));

  var breederOk =
    cat.breeder_known === 1
      ? isNonEmpty(cat.breeder_name) || isNonEmpty(cat.breeder_address) || isNonEmpty(cat.breeder_reg_no)
      : cat.breeder_known === 0;
  add('source_type', '保護経緯の分類', 'legal', true, isNonEmpty(cat.source_type));
  add('breeder_info', '繁殖者情報または不明', 'legal', true, breederOk);
  add('previous_owner', '前所有者', 'legal', false, true);
  add('ownership_start_date', '所有開始日', 'legal', true, isNonEmpty(cat.ownership_start_date));

  add('photos', '写真（最低1枚）', 'docs', true, photoCount >= 1);

  var requiredTotal = 0;
  var requiredDone = 0;
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].required) {
      requiredTotal++;
      if (fields[i].filled) requiredDone++;
    }
  }

  return {
    total: total,
    done: done,
    required_total: requiredTotal,
    required_done: requiredDone,
    pct: requiredTotal ? Math.round((100 * requiredDone) / requiredTotal) : 0,
    fields: fields,
  };
}

async function assertAppOwned(db, appId, applicantId) {
  var row = await db
    .prepare('SELECT * FROM intake_applications WHERE id = ? AND applicant_id = ?')
    .bind(appId, applicantId)
    .first();
  return row || null;
}

async function countCatPhotos(db, catId) {
  var r = await db
    .prepare(
      "SELECT COUNT(1) AS c FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''"
    )
    .bind(MODULE_CAT_PHOTO, String(catId))
    .first();
  return r && r.c ? Number(r.c) : 0;
}

async function listFilesForCat(db, catId) {
  var res = await db
    .prepare(
      'SELECT id, original_name, mime_type, size_bytes, module, created_at FROM files WHERE ref_id = ? AND module IN (?, ?) AND r2_key IS NOT NULL ORDER BY id ASC'
    )
    .bind(String(catId), MODULE_CAT_PHOTO, MODULE_CAT_DOC)
    .all();
  return res.results || [];
}

async function refreshCatCount(db, applicationId) {
  var r = await db
    .prepare('SELECT COUNT(1) AS c FROM intake_application_cats WHERE application_id = ?')
    .bind(applicationId)
    .first();
  var c = r && r.c ? Number(r.c) : 0;
  await db
    .prepare("UPDATE intake_applications SET cat_count = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(c, applicationId)
    .run();
}

function editableAppStatus(status) {
  return status === 'draft' || status === 'info_requested';
}

async function listApplications(db, applicant) {
  var res = await db
    .prepare(
      'SELECT id, applicant_id, status, location_id, reason, cat_count, submitted_at, created_at, updated_at ' +
        'FROM intake_applications WHERE applicant_id = ? ORDER BY id DESC'
    )
    .bind(applicant.id)
    .all();
  var rows = res.results || [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var a = rows[i];
    var catsRes = await db
      .prepare('SELECT * FROM intake_application_cats WHERE application_id = ? ORDER BY id ASC')
      .bind(a.id)
      .all();
    var cats = catsRes.results || [];
    var catPayloads = [];
    var allSubmit = true;
    for (var j = 0; j < cats.length; j++) {
      var pc = await countCatPhotos(db, cats[j].id);
      var comp = computeCatCompletion(cats[j], pc);
      catPayloads.push({
        id: cats[j].id,
        name: cats[j].name || null,
        completion: comp,
      });
      if (comp.required_done < comp.required_total) allSubmit = false;
    }
    out.push({
      id: a.id,
      status: a.status,
      location_id: a.location_id,
      reason: a.reason,
      cat_count: a.cat_count,
      submitted_at: a.submitted_at,
      created_at: a.created_at,
      updated_at: a.updated_at,
      cats: catPayloads,
      can_submit: editableAppStatus(a.status) && cats.length > 0 && allSubmit && isNonEmpty(a.reason),
    });
  }
  return out;
}

async function createApplication(req, db, applicant) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed' }, 405);
  var row = await db
    .prepare(
      "INSERT INTO intake_applications (applicant_id, status) VALUES (?, 'draft') RETURNING id, created_at"
    )
    .bind(applicant.id)
    .first();
  if (!row) return opsJson({ error: 'server_error' }, 500);
  await db
    .prepare("UPDATE intake_applicants SET phase = 'draft', updated_at = datetime('now') WHERE id = ? AND phase IN ('active', 'draft')")
    .bind(applicant.id)
    .run();
  return opsJson(
    {
      ok: true,
      application: {
        id: row.id,
        applicant_id: applicant.id,
        status: 'draft',
        cat_count: 0,
        created_at: row.created_at,
      },
    },
    201
  );
}

async function getApplicationDetail(db, appId, applicant) {
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  var catsRes = await db
    .prepare('SELECT * FROM intake_application_cats WHERE application_id = ? ORDER BY id ASC')
    .bind(appId)
    .all();
  var cats = catsRes.results || [];
  var catsOut = [];
  for (var i = 0; i < cats.length; i++) {
    var pc = await countCatPhotos(db, cats[i].id);
    catsOut.push({ cat: cats[i], completion: computeCatCompletion(cats[i], pc) });
  }
  var msgsRes = await db
    .prepare('SELECT id, application_id, sender_type, sender_id, body, created_at FROM intake_application_messages WHERE application_id = ? ORDER BY id ASC')
    .bind(appId)
    .all();
  return opsJson({
    ok: true,
    application: app,
    cats: catsOut,
    messages: msgsRes.results || [],
  });
}

async function updateApplication(req, db, appId, applicant) {
  if (req.method !== 'PUT') return opsJson({ error: 'method_not_allowed' }, 405);
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (!editableAppStatus(app.status)) return opsJson({ error: 'forbidden', message: 'Cannot edit' }, 403);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request' }, 400);
  }
  var reason = body.reason !== undefined ? (body.reason == null ? null : String(body.reason).trim() || null) : undefined;
  var locationId = body.location_id !== undefined ? (body.location_id == null ? null : String(body.location_id).trim() || null) : undefined;
  if (reason === undefined && locationId === undefined) {
    return opsJson({ error: 'bad_request', message: 'no fields' }, 400);
  }
  if (reason !== undefined && locationId !== undefined) {
    await db
      .prepare("UPDATE intake_applications SET reason = ?, location_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(reason, locationId, appId)
      .run();
  } else if (reason !== undefined) {
    await db
      .prepare("UPDATE intake_applications SET reason = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(reason, appId)
      .run();
  } else if (locationId !== undefined) {
    await db
      .prepare("UPDATE intake_applications SET location_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(locationId, appId)
      .run();
  }
  var fresh = await assertAppOwned(db, appId, applicant.id);
  return opsJson({ ok: true, application: fresh });
}

async function submitApplication(req, db, appId, applicant) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed' }, 405);
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (!editableAppStatus(app.status)) return opsJson({ error: 'forbidden', message: 'Cannot submit' }, 403);
  if (!isNonEmpty(app.reason)) {
    return opsJson({ error: 'bad_request', message: 'reason required' }, 400);
  }
  var catsRes = await db.prepare('SELECT * FROM intake_application_cats WHERE application_id = ?').bind(appId).all();
  var cats = catsRes.results || [];
  if (cats.length === 0) {
    return opsJson({ error: 'bad_request', message: 'Add at least one cat' }, 400);
  }
  for (var i = 0; i < cats.length; i++) {
    var pc = await countCatPhotos(db, cats[i].id);
    var comp = computeCatCompletion(cats[i], pc);
    if (comp.required_done < comp.required_total) {
      return opsJson({ error: 'bad_request', message: 'Incomplete cat data', cat_id: cats[i].id, completion: comp }, 400);
    }
  }
  var subAt = new Date().toISOString();
  await db
    .prepare(
      "UPDATE intake_applications SET status = 'submitted', submitted_at = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(subAt, appId)
    .run();
  await db
    .prepare("UPDATE intake_applicants SET phase = 'submitted', updated_at = datetime('now') WHERE id = ?")
    .bind(applicant.id)
    .run();
  await db
    .prepare(
      "INSERT INTO intake_application_messages (application_id, sender_type, sender_id, body) VALUES (?, 'system', NULL, ?)"
    )
    .bind(appId, '申請が送信されました。')
    .run();
  return opsJson({ ok: true, submitted_at: subAt });
}

async function withdrawApplication(req, db, appId, applicant) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed' }, 405);
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (app.status !== 'draft') {
    return opsJson({ error: 'forbidden', message: '取り下げは下書きのみ可能です' }, 403);
  }
  await db
    .prepare("UPDATE intake_applications SET status = 'withdrawn', updated_at = datetime('now') WHERE id = ?")
    .bind(appId)
    .run();
  await db
    .prepare(
      "INSERT INTO intake_application_messages (application_id, sender_type, sender_id, body) VALUES (?, 'system', NULL, ?)"
    )
    .bind(appId, '申請者が下書きを取り下げました。')
    .run();
  var cnt = await db
    .prepare(
      "SELECT COUNT(1) AS c FROM intake_applications WHERE applicant_id = ? AND id != ? " +
        "AND status IN ('draft','submitted','under_review','info_requested')"
    )
    .bind(applicant.id, appId)
    .first();
  var c = cnt && cnt.c ? Number(cnt.c) : 0;
  if (c === 0) {
    await db
      .prepare("UPDATE intake_applicants SET phase = 'active', updated_at = datetime('now') WHERE id = ?")
      .bind(applicant.id)
      .run();
  }
  return opsJson({ ok: true, withdrawn: true });
}

var CAT_STRING_FIELDS = [
  'name',
  'breed',
  'estimated_birth_date',
  'sex',
  'microchip_id',
  'color_markings',
  'rescue_date',
  'rescue_location',
  'rescue_situation',
  'story',
  'living_environment',
  'personality',
  'special_needs',
  'health_summary',
  'health_detail',
  'fiv_status',
  'felv_status',
  'vaccination_info',
  'source_type',
  'source_detail',
  'breeder_name',
  'breeder_address',
  'breeder_reg_no',
  'previous_owner_name',
  'previous_owner_address',
  'ownership_start_date',
  'notes',
];

async function addCat(req, db, appId, applicant) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed' }, 405);
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (!editableAppStatus(app.status)) return opsJson({ error: 'forbidden' }, 403);
  var row = await db
    .prepare('INSERT INTO intake_application_cats (application_id) VALUES (?) RETURNING id, created_at')
    .bind(appId)
    .first();
  if (!row) return opsJson({ error: 'server_error' }, 500);
  await refreshCatCount(db, appId);
  return opsJson({ ok: true, cat: { id: row.id, application_id: appId, created_at: row.created_at } }, 201);
}

async function getCat(db, appId, catId, applicant) {
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  var cat = await db
    .prepare('SELECT * FROM intake_application_cats WHERE id = ? AND application_id = ?')
    .bind(catId, appId)
    .first();
  if (!cat) return opsJson({ error: 'not_found' }, 404);
  var pc = await countCatPhotos(db, catId);
  var fileList = await listFilesForCat(db, catId);
  return opsJson({ ok: true, cat: cat, completion: computeCatCompletion(cat, pc), files: fileList });
}

async function updateCat(req, db, appId, catId, applicant) {
  if (req.method !== 'PUT') return opsJson({ error: 'method_not_allowed' }, 405);
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (!editableAppStatus(app.status)) return opsJson({ error: 'forbidden' }, 403);
  var cat = await db
    .prepare('SELECT * FROM intake_application_cats WHERE id = ? AND application_id = ?')
    .bind(catId, appId)
    .first();
  if (!cat) return opsJson({ error: 'not_found' }, 404);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request' }, 400);
  }
  var sets = [];
  var vals = [];
  for (var i = 0; i < CAT_STRING_FIELDS.length; i++) {
    var k = CAT_STRING_FIELDS[i];
    if (body[k] !== undefined) {
      sets.push(k + ' = ?');
      vals.push(body[k] == null ? null : String(body[k]).trim() || null);
    }
  }
  if (body.neutered !== undefined) {
    sets.push('neutered = ?');
    vals.push(body.neutered ? 1 : 0);
  }
  if (body.weight_kg !== undefined) {
    sets.push('weight_kg = ?');
    vals.push(body.weight_kg == null || body.weight_kg === '' ? null : Number(body.weight_kg));
  }
  if (body.breeder_known !== undefined) {
    sets.push('breeder_known = ?');
    vals.push(body.breeder_known ? 1 : 0);
  }
  if (sets.length === 0) return opsJson({ error: 'bad_request', message: 'no fields' }, 400);
  sets.push("updated_at = datetime('now')");
  vals.push(catId);
  var sql = 'UPDATE intake_application_cats SET ' + sets.join(', ') + ' WHERE id = ?';
  var stmt = db.prepare(sql);
  await stmt.bind.apply(stmt, vals).run();
  var fresh = await db.prepare('SELECT * FROM intake_application_cats WHERE id = ?').bind(catId).first();
  var pc = await countCatPhotos(db, catId);
  return opsJson({ ok: true, cat: fresh, completion: computeCatCompletion(fresh, pc) });
}

async function deleteCat(env, db, appId, catId, applicant) {
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (app.status !== 'draft') return opsJson({ error: 'forbidden', message: 'Only draft' }, 403);
  var cat = await db
    .prepare('SELECT id FROM intake_application_cats WHERE id = ? AND application_id = ?')
    .bind(catId, appId)
    .first();
  if (!cat) return opsJson({ error: 'not_found' }, 404);
  var r2 = env.NYAGI_FILES;
  var fileRows = await db
    .prepare('SELECT r2_key FROM files WHERE module IN (?, ?) AND ref_id = ? AND r2_key IS NOT NULL')
    .bind(MODULE_CAT_PHOTO, MODULE_CAT_DOC, String(catId))
    .all();
  var fr = fileRows.results || [];
  for (var fi = 0; fi < fr.length; fi++) {
    if (r2 && fr[fi].r2_key) {
      try {
        await r2.delete(fr[fi].r2_key);
      } catch (_) {}
    }
  }
  await db.prepare('DELETE FROM files WHERE module IN (?, ?) AND ref_id = ?').bind(MODULE_CAT_PHOTO, MODULE_CAT_DOC, String(catId)).run();
  await db.prepare('DELETE FROM intake_application_cats WHERE id = ?').bind(catId).run();
  await refreshCatCount(db, appId);
  return opsJson({ ok: true, deleted: true });
}

async function listMessages(db, appId, applicant) {
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  var res = await db
    .prepare('SELECT * FROM intake_application_messages WHERE application_id = ? ORDER BY id ASC')
    .bind(appId)
    .all();
  return opsJson({ ok: true, messages: res.results || [] });
}

async function postMessage(req, db, appId, applicant) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed' }, 405);
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (
    app.status !== 'draft' &&
    app.status !== 'submitted' &&
    app.status !== 'under_review' &&
    app.status !== 'info_requested'
  ) {
    return opsJson({ error: 'forbidden', message: 'この状態ではメッセージを送信できません' }, 403);
  }
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request' }, 400);
  }
  var text = body && body.body != null ? String(body.body).trim() : '';
  if (!text) return opsJson({ error: 'bad_request', message: 'body required' }, 400);
  var row = await db
    .prepare(
      "INSERT INTO intake_application_messages (application_id, sender_type, sender_id, body) VALUES (?, 'applicant', ?, ?) RETURNING id, created_at"
    )
    .bind(appId, applicant.id, text)
    .first();
  return opsJson({ ok: true, message: row }, 201);
}

async function uploadCatFile(req, env, db, appId, catId, applicant, isPhoto) {
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (!editableAppStatus(app.status)) return opsJson({ error: 'forbidden' }, 403);
  var cat = await db
    .prepare('SELECT id FROM intake_application_cats WHERE id = ? AND application_id = ?')
    .bind(catId, appId)
    .first();
  if (!cat) return opsJson({ error: 'not_found' }, 404);
  if (isPhoto) {
    var currentCount = await countCatPhotos(db, catId);
    if (currentCount >= MAX_PHOTOS_PER_CAT) {
      return opsJson({ error: 'bad_request', message: '写真は1頭あたり最大' + MAX_PHOTOS_PER_CAT + '枚です' }, 400);
    }
  }
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'service_unavailable', message: 'File storage not configured' }, 503);
  var formData;
  try {
    formData = await req.formData();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Expected multipart' }, 400);
  }
  var file = formData.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    return opsJson({ error: 'bad_request', message: 'Missing file' }, 400);
  }
  var size = file.size || 0;
  if (size < 1 || size > FILE_MAX_BYTES) return opsJson({ error: 'bad_request', message: 'File too large' }, 400);
  var mime = String(file.type || '').toLowerCase();
  var mod = isPhoto ? MODULE_CAT_PHOTO : MODULE_CAT_DOC;
  var mimes = isPhoto ? PHOTO_MIMES : DOC_MIMES;
  if (!mimes[mime]) return opsJson({ error: 'bad_request', message: 'Unsupported file type' }, 400);
  var buf = await file.arrayBuffer();
  if (buf.byteLength > FILE_MAX_BYTES) return opsJson({ error: 'bad_request', message: 'File too large' }, 400);
  var origName = file.name || 'file';
  var safeName = String(origName).replace(/[\r\n\\/]/g, '_').slice(0, 120) || 'file';
  var prefix = isPhoto ? 'intake-apply/' + appId + '/cat-' + catId + '/photos/' : 'intake-apply/' + appId + '/cat-' + catId + '/docs/';
  var r2Key = prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + safeName;
  try {
    await r2.put(r2Key, buf, { httpMetadata: { contentType: mime || 'application/octet-stream' } });
  } catch (_) {
    return opsJson({ error: 'server_error', message: 'Storage failed' }, 500);
  }
  var ext = origName.indexOf('.') >= 0 ? origName.split('.').pop() : 'bin';
  var ins = await db
    .prepare(
      'INSERT INTO files (r2_key, module, ref_id, file_type, original_name, mime_type, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at'
    )
    .bind(r2Key, mod, String(catId), ext, origName, mime, buf.byteLength, applicant.id)
    .first();
  return opsJson({ ok: true, file: ins });
}

async function deleteCatFile(env, db, appId, catId, fileId, applicant) {
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (!editableAppStatus(app.status)) return opsJson({ error: 'forbidden' }, 403);
  var fid = parseInt(fileId, 10);
  if (isNaN(fid)) return opsJson({ error: 'bad_request' }, 400);
  var row = await db
    .prepare(
      'SELECT id, r2_key, module FROM files WHERE id = ? AND ref_id = ? AND module IN (?, ?)'
    )
    .bind(fid, String(catId), MODULE_CAT_PHOTO, MODULE_CAT_DOC)
    .first();
  if (!row) return opsJson({ error: 'not_found' }, 404);
  if (env.NYAGI_FILES && row.r2_key) {
    try {
      await env.NYAGI_FILES.delete(row.r2_key);
    } catch (_) {}
  }
  await db.prepare('DELETE FROM files WHERE id = ?').bind(fid).run();
  return opsJson({ ok: true, deleted: true });
}

async function serveCatFile(env, db, appId, catId, fileId, applicant) {
  var app = await assertAppOwned(db, appId, applicant.id);
  if (!app) return opsJson({ error: 'not_found' }, 404);
  var fid = parseInt(fileId, 10);
  if (isNaN(fid)) return opsJson({ error: 'bad_request' }, 400);
  var row = await db
    .prepare(
      'SELECT r2_key, original_name, mime_type FROM files WHERE id = ? AND ref_id = ? AND module IN (?, ?) AND r2_key IS NOT NULL'
    )
    .bind(fid, String(catId), MODULE_CAT_PHOTO, MODULE_CAT_DOC)
    .first();
  if (!row || !row.r2_key) return opsJson({ error: 'not_found' }, 404);
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'unavailable' }, 503);
  var obj = await r2.get(row.r2_key);
  if (!obj) return opsJson({ error: 'not_found' }, 404);
  var headers = new Headers();
  headers.set('Content-Type', row.mime_type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + (row.original_name || 'file') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

/**
 * @param {Request} req
 * @param {object} env
 * @param {D1Database} db
 * @param {object} applicant — intake_applicants row (session valid)
 * @param {string} path — e.g. applications, applications/1/submit
 * @param {string} method
 */
export async function handleIntakeApplicantRoutes(req, env, db, applicant, path, method) {
  if (path === 'applications' && method === 'GET') {
    var list = await listApplications(db, applicant);
    return opsJson({ ok: true, applications: list });
  }
  if (path === 'applications' && method === 'POST') {
    return await createApplication(req, db, applicant);
  }

  var mApp = path.match(/^applications\/(\d+)$/);
  if (mApp) {
    var aid = parseInt(mApp[1], 10);
    if (method === 'GET') return await getApplicationDetail(db, aid, applicant);
    if (method === 'PUT') return await updateApplication(req, db, aid, applicant);
  }

  var mSub = path.match(/^applications\/(\d+)\/submit$/);
  if (mSub && method === 'POST') {
    return await submitApplication(req, db, parseInt(mSub[1], 10), applicant);
  }

  var mWd = path.match(/^applications\/(\d+)\/withdraw$/);
  if (mWd && method === 'POST') {
    return await withdrawApplication(req, db, parseInt(mWd[1], 10), applicant);
  }

  var mMsg = path.match(/^applications\/(\d+)\/messages$/);
  if (mMsg) {
    var appIdM = parseInt(mMsg[1], 10);
    if (method === 'GET') return await listMessages(db, appIdM, applicant);
    if (method === 'POST') return await postMessage(req, db, appIdM, applicant);
  }

  var mCats = path.match(/^applications\/(\d+)\/cats$/);
  if (mCats && method === 'POST') {
    return await addCat(req, db, parseInt(mCats[1], 10), applicant);
  }

  var mCatOne = path.match(/^applications\/(\d+)\/cats\/(\d+)$/);
  if (mCatOne) {
    var appIdC = parseInt(mCatOne[1], 10);
    var cid = parseInt(mCatOne[2], 10);
    if (method === 'GET') return await getCat(db, appIdC, cid, applicant);
    if (method === 'PUT') return await updateCat(req, db, appIdC, cid, applicant);
    if (method === 'DELETE') return await deleteCat(env, db, appIdC, cid, applicant);
  }

  var mCatFiles = path.match(/^applications\/(\d+)\/cats\/(\d+)\/files$/);
  if (mCatFiles && method === 'POST') {
    return await uploadCatFile(req, env, db, parseInt(mCatFiles[1], 10), parseInt(mCatFiles[2], 10), applicant, true);
  }

  var mCatDocs = path.match(/^applications\/(\d+)\/cats\/(\d+)\/docs$/);
  if (mCatDocs && method === 'POST') {
    return await uploadCatFile(req, env, db, parseInt(mCatDocs[1], 10), parseInt(mCatDocs[2], 10), applicant, false);
  }

  var mCatFileOne = path.match(/^applications\/(\d+)\/cats\/(\d+)\/files\/(\d+)$/);
  if (mCatFileOne) {
    var aF = parseInt(mCatFileOne[1], 10);
    var cF = parseInt(mCatFileOne[2], 10);
    var fF = mCatFileOne[3];
    if (method === 'GET') return await serveCatFile(env, db, aF, cF, fF, applicant);
    if (method === 'DELETE') return await deleteCatFile(env, db, aF, cF, fF, applicant);
  }

  return opsJson({ error: 'not_found', message: 'Unknown route' }, 404);
}
