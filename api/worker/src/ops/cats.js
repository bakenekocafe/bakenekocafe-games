/**
 * NYAGI 猫マスター CRUD
 *
 * GET  /api/ops/cats           → 一覧（拠点フィルタ対応）
 * GET  /api/ops/cats/:id       → 詳細
 * POST /api/ops/cats           → 新規登録（認証済みスタッフ）
 * PUT  /api/ops/cats/:id       → 更新
 * PUT  /api/ops/cats/:id/alert → 警戒レベル設定
 * GET  /api/ops/cats/:id/microchip-file → マイクロチップ登録画像/PDF（最新1件）
 * POST /api/ops/cats/:id/microchip-file → multipart field: file
 * DELETE /api/ops/cats/:id/microchip-file → 添付削除
 * GET/POST /api/ops/cats/:id/intake-records — 資料レコード一覧・追加
 * PUT/DELETE /api/ops/cats/:id/intake-records/:rid
 * POST /api/ops/cats/:id/intake-records/:rid/files — multipart file（複数可）
 * GET/DELETE /api/ops/cats/:id/intake-records/:rid/files/:fileId
 * （譲渡側も同様に adoption-records）
 */

import { opsJson } from './router.js';
import { sqlStatusCondition } from './cat-status.js';
import { refreshNutritionProfile } from './nutrition.js';
import { insertCatNameDictWithSources } from './cat-name-dict-insert.js';
import { clearDictCache } from './name-resolver.js';
import * as iaRec from './cat-ia-records.js';
import {
  collectPresetIdsOrdered,
  resolvePresetDisplayNameDescription,
  fetchPresetDisplayMaps,
} from './feeding-preset-display.js';

var CAT_MICROCHIP_MIMES = {
  'image/jpeg': 1,
  'image/png': 1,
  'image/gif': 1,
  'image/webp': 1,
  'application/pdf': 1,
};

async function catMicrochipHasFile(db, catId) {
  var row = await db.prepare(
    "SELECT 1 AS x FROM files WHERE module = 'cat_microchip' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != '' LIMIT 1"
  ).bind(catId).first();
  return !!row;
}

async function serveCatMicrochipFile(env, db, catId) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'unavailable', message: 'Storage not available' }, 503);
  var fileRow = await db.prepare(
    "SELECT r2_key, original_name, mime_type FROM files WHERE module = 'cat_microchip' AND ref_id = ? AND r2_key IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).bind(catId).first();
  if (!fileRow || !fileRow.r2_key) return opsJson({ error: 'not_found', message: 'No microchip attachment' }, 404);
  var obj = await r2.get(fileRow.r2_key);
  if (!obj) return opsJson({ error: 'not_found', message: 'File not found in storage' }, 404);
  var headers = new Headers();
  headers.set('Content-Type', fileRow.mime_type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + (fileRow.original_name || 'microchip') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

async function uploadCatMicrochipFile(req, env, db, staffAuth, catId) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'service_unavailable', message: 'File storage is not configured' }, 503);

  var catRow = await db.prepare('SELECT id FROM cats WHERE id = ?').bind(catId).first();
  if (!catRow) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);

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
  if (size > 5 * 1024 * 1024) {
    return opsJson({ error: 'payload_too_large', message: 'ファイルは5MB以下にしてください' }, 413);
  }

  var mime = String(file.type || '').toLowerCase();
  if (!CAT_MICROCHIP_MIMES[mime]) {
    return opsJson({ error: 'bad_request', message: '対応形式: PDF・画像（JPEG/PNG/GIF/WebP）' }, 400);
  }

  var buf = await file.arrayBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) {
    return opsJson({ error: 'payload_too_large', message: 'ファイルは5MB以下にしてください' }, 413);
  }

  var origName = file.name || 'file';
  var safeName = String(origName).replace(/[\r\n\\/]/g, '_').slice(0, 120) || 'file';
  var r2Key = 'cat-microchip/' + catId + '/' + Date.now() + '_' + safeName;

  try {
    await r2.put(r2Key, buf, {
      httpMetadata: { contentType: mime || 'application/octet-stream' },
    });
  } catch (_) {
    return opsJson({ error: 'upload_failed', message: 'ストレージへの保存に失敗しました' }, 500);
  }

  var oldRows = await db.prepare(
    "SELECT r2_key FROM files WHERE module = 'cat_microchip' AND ref_id = ? AND r2_key IS NOT NULL"
  ).bind(catId).all();
  var olds = oldRows.results || [];
  for (var oi = 0; oi < olds.length; oi++) {
    try { await r2.delete(olds[oi].r2_key); } catch (_) {}
  }
  await db.prepare("DELETE FROM files WHERE module = 'cat_microchip' AND ref_id = ?").bind(catId).run();

  var ext = origName.indexOf('.') >= 0 ? origName.split('.').pop() : (mime === 'application/pdf' ? 'pdf' : 'bin');
  await db.prepare(
    "INSERT INTO files (r2_key, module, ref_id, file_type, original_name, mime_type, size_bytes, uploaded_by) VALUES (?, 'cat_microchip', ?, ?, ?, ?, ?, ?)"
  ).bind(r2Key, catId, ext, origName, mime, buf.byteLength, staffAuth.staffId).run();

  return opsJson({ ok: true, has_file: true });
}

async function deleteCatMicrochipFiles(db, r2, catId) {
  if (r2) {
    var fileRows = await db.prepare(
      "SELECT r2_key FROM files WHERE module = 'cat_microchip' AND ref_id = ? AND r2_key IS NOT NULL"
    ).bind(catId).all();
    var keys = fileRows.results || [];
    for (var fi = 0; fi < keys.length; fi++) {
      try { await r2.delete(keys[fi].r2_key); } catch (_) {}
    }
  }
  await db.prepare("DELETE FROM files WHERE module = 'cat_microchip' AND ref_id = ?").bind(catId).run();
}

export async function handleCats(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  // GET /api/ops/cats — 一覧
  if (method === 'GET' && (subPath === '' || subPath === '/')) {
    var locationId = url.searchParams.get('location') || staffAuth.locationId;
    var status = url.searchParams.get('status');

    var sql = 'SELECT * FROM cats WHERE 1=1';
    var params = [];

    if (locationId && locationId !== 'all' && locationId !== 'both') {
      sql += ' AND location_id = ?';
      params.push(locationId);
    }
    if (status) {
      sql += ' AND ' + sqlStatusCondition(status);
    }

    sql += ' ORDER BY name';

    var stmt = db.prepare(sql);
    if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
    var result = await stmt.all();

    return opsJson({ cats: result.results || [] });
  }

  // GET /api/ops/cats/:id/photo — R2 から猫写真をバイナリ配信
  var photoMatch = subPath.match(/^\/([^/]+)\/photo$/);
  if (method === 'GET' && photoMatch) {
    var photoCatId = decodeURIComponent(photoMatch[1]);
    var r2 = env.NYAGI_FILES;
    if (!r2) return opsJson({ error: 'unavailable', message: 'Storage not available' }, 503);
    var r2Key = 'cat-photos/' + photoCatId + '.jpg';
    var obj = await r2.get(r2Key);
    if (!obj) return opsJson({ error: 'not_found', message: 'No photo' }, 404);
    var h = new Headers();
    h.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg');
    h.set('Cache-Control', 'private, max-age=3600');
    return new Response(obj.body, { headers: h });
  }

  // GET/POST/DELETE /api/ops/cats/:id/microchip-file
  var microchipFileMatch = subPath.match(/^\/([^/]+)\/microchip-file$/);
  if (microchipFileMatch) {
    var mcCatId = decodeURIComponent(microchipFileMatch[1]);
    if (method === 'GET') {
      return serveCatMicrochipFile(env, db, mcCatId);
    }
    if (method === 'POST') {
      return uploadCatMicrochipFile(req, env, db, staffAuth, mcCatId);
    }
    if (method === 'DELETE') {
      var delCat = await db.prepare('SELECT id FROM cats WHERE id = ?').bind(mcCatId).first();
      if (!delCat) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);
      await deleteCatMicrochipFiles(db, env.NYAGI_FILES, mcCatId);
      return opsJson({ ok: true, deleted: true });
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // GET/DELETE /api/ops/cats/:id/intake-records/:rid/files/:fileId
  var irFileOne = subPath.match(/^\/([^/]+)\/intake-records\/([0-9]+)\/files\/([0-9]+)$/);
  if (irFileOne) {
    var irfCat = decodeURIComponent(irFileOne[1]);
    var irfRid = irFileOne[2];
    var irfFid = irFileOne[3];
    if (method === 'GET') {
      return iaRec.serveIntakeRecordFile(env, db, irfCat, irfRid, irfFid);
    }
    if (method === 'DELETE') {
      return iaRec.deleteIntakeRecordFile(db, env.NYAGI_FILES, irfCat, irfRid, irfFid);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // POST /api/ops/cats/:id/intake-records/:rid/files
  var irFiles = subPath.match(/^\/([^/]+)\/intake-records\/([0-9]+)\/files$/);
  if (irFiles) {
    var irFsCat = decodeURIComponent(irFiles[1]);
    var irFsRid = irFiles[2];
    if (method === 'POST') {
      return iaRec.uploadIntakeRecordFiles(req, env, db, staffAuth, irFsCat, irFsRid);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // PUT/DELETE /api/ops/cats/:id/intake-records/:rid
  var irOne = subPath.match(/^\/([^/]+)\/intake-records\/([0-9]+)$/);
  if (irOne) {
    var ir1Cat = decodeURIComponent(irOne[1]);
    var ir1Rid = irOne[2];
    if (method === 'PUT') {
      return iaRec.updateIntakeRecord(req, db, staffAuth, ir1Cat, ir1Rid);
    }
    if (method === 'DELETE') {
      return iaRec.deleteIntakeRecord(db, env.NYAGI_FILES, ir1Cat, ir1Rid);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // GET/POST /api/ops/cats/:id/intake-records
  var irList = subPath.match(/^\/([^/]+)\/intake-records$/);
  if (irList) {
    var irLCat = decodeURIComponent(irList[1]);
    if (method === 'GET') {
      return iaRec.getIntakeRecordsJson(db, irLCat);
    }
    if (method === 'POST') {
      return iaRec.createIntakeRecord(req, db, staffAuth, irLCat);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // GET/DELETE /api/ops/cats/:id/adoption-records/:rid/files/:fileId
  var arFileOne = subPath.match(/^\/([^/]+)\/adoption-records\/([0-9]+)\/files\/([0-9]+)$/);
  if (arFileOne) {
    var arfCat = decodeURIComponent(arFileOne[1]);
    var arfRid = arFileOne[2];
    var arfFid = arFileOne[3];
    if (method === 'GET') {
      return iaRec.serveAdoptionRecordFile(env, db, arfCat, arfRid, arfFid);
    }
    if (method === 'DELETE') {
      return iaRec.deleteAdoptionRecordFile(db, env.NYAGI_FILES, arfCat, arfRid, arfFid);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // POST /api/ops/cats/:id/adoption-records/:rid/files
  var arFiles = subPath.match(/^\/([^/]+)\/adoption-records\/([0-9]+)\/files$/);
  if (arFiles) {
    var arFsCat = decodeURIComponent(arFiles[1]);
    var arFsRid = arFiles[2];
    if (method === 'POST') {
      return iaRec.uploadAdoptionRecordFiles(req, env, db, staffAuth, arFsCat, arFsRid);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // PUT/DELETE /api/ops/cats/:id/adoption-records/:rid
  var arOne = subPath.match(/^\/([^/]+)\/adoption-records\/([0-9]+)$/);
  if (arOne) {
    var ar1Cat = decodeURIComponent(arOne[1]);
    var ar1Rid = arOne[2];
    if (method === 'PUT') {
      return iaRec.updateAdoptionRecord(req, db, staffAuth, ar1Cat, ar1Rid);
    }
    if (method === 'DELETE') {
      return iaRec.deleteAdoptionRecord(db, env.NYAGI_FILES, ar1Cat, ar1Rid);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // GET/POST /api/ops/cats/:id/adoption-records
  var arList = subPath.match(/^\/([^/]+)\/adoption-records$/);
  if (arList) {
    var arLCat = decodeURIComponent(arList[1]);
    if (method === 'GET') {
      return iaRec.getAdoptionRecordsJson(db, arLCat);
    }
    if (method === 'POST') {
      return iaRec.createAdoptionRecord(req, db, staffAuth, arLCat);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // GET /api/ops/cats/:id — 詳細（1セグメントのみ。/id/photo 等は上で処理済み）
  if (method === 'GET' && subPath.match(/^\/[^/]+$/)) {
    var catId = subPath.slice(1);
    var cat = await db.prepare('SELECT * FROM cats WHERE id = ?').bind(catId).first();
    if (!cat) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);

    var meds = await db.prepare(
      'SELECT m.*, med.name AS medicine_name FROM medications m JOIN medicines med ON m.medicine_id = med.id WHERE m.cat_id = ? ORDER BY m.active DESC, med.name'
    ).bind(catId).all();

    var baselines = await db.prepare(
      'SELECT * FROM cat_baselines WHERE cat_id = ?'
    ).bind(catId).all();

    var catPlanPresetRows = await db.prepare(
      'SELECT preset_id FROM feeding_plans WHERE cat_id = ? AND active = 1 AND preset_id IS NOT NULL'
    ).bind(catId).all();
    var catPresetIds = collectPresetIdsOrdered(cat.assigned_preset_id, catPlanPresetRows.results || []);
    var catPresetBind = [];
    for (var cpi = 0; cpi < catPresetIds.length; cpi++) catPresetBind.push(catPresetIds[cpi]);
    var catPresetMaps = await fetchPresetDisplayMaps(db, catPresetBind);
    var catPresetResolved = resolvePresetDisplayNameDescription(
      catPresetIds,
      catPresetMaps.presetById,
      catPresetMaps.itemNotesAgg
    );
    cat.assigned_preset_name = catPresetResolved.name;
    cat.assigned_preset_description = catPresetResolved.description;
    if (cat.assigned_medication_preset_id != null && String(cat.assigned_medication_preset_id).trim() !== '') {
      var mpNameRow = await db.prepare(
        'SELECT name FROM medication_presets WHERE id = ? AND COALESCE(active,1) = 1'
      ).bind(cat.assigned_medication_preset_id).first();
      cat.assigned_medication_preset_name = mpNameRow ? mpNameRow.name : null;
    } else {
      cat.assigned_medication_preset_name = null;
    }
    cat.has_microchip_image = (await catMicrochipHasFile(db, catId)) ? 1 : 0;
    var iaPayload = await iaRec.buildIaTimelinePayload(db, catId);
    cat.has_intake_file = iaPayload.has_intake_file;
    cat.has_adoption_file = iaPayload.has_adoption_file;
    cat.intake_records = iaPayload.intake_records;
    cat.adoption_records = iaPayload.adoption_records;
    cat.intake_record_count = iaPayload.intake_record_count;
    cat.adoption_record_count = iaPayload.adoption_record_count;
    cat.intake_file_count = iaPayload.intake_file_count;
    cat.adoption_file_count = iaPayload.adoption_file_count;

    return opsJson({
      cat: cat,
      medications: meds.results || [],
      baselines: baselines.results || [],
    });
  }

  // POST /api/ops/cats — 新規登録（認証済みスタッフなら可。internal ツールのため owner/admin 限定は撤廃）
  if (method === 'POST' && (subPath === '' || subPath === '/')) {
    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }

    if (!body.id || !body.name) {
      return opsJson({ error: 'bad_request', message: 'id and name required' }, 400);
    }

    var newSpecies = body.species === 'dog' ? 'dog' : 'cat';

    await db.prepare(
      'INSERT INTO cats (id, name, photo_url, birth_date, sex, neutered, microchip_id, location_id, status, description, internal_note, species) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      body.id, body.name, body.photo_url || null, body.birth_date || null,
      body.sex || null, body.neutered || 0, body.microchip_id || null,
      body.location_id || staffAuth.locationId, body.status || 'in_care',
      body.description || null, body.internal_note || null, newSpecies
    ).run();

    return opsJson({ ok: true, id: body.id }, 201);
  }

  // PUT /api/ops/cats/:id/alert — 警戒レベル設定
  if (method === 'PUT' && subPath.indexOf('/alert') !== -1) {
    var parts = subPath.split('/');
    var catId = parts[1];

    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }

    var level = body.alert_level;
    if (['normal', 'watch', 'critical'].indexOf(level) === -1) {
      return opsJson({ error: 'bad_request', message: 'alert_level must be normal/watch/critical' }, 400);
    }

    await db.prepare(
      'UPDATE cats SET alert_level = ?, alert_reason = ?, alert_until = ?, alert_set_by = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(
      level,
      body.alert_reason || null,
      body.alert_until || null,
      staffAuth.staffId,
      catId
    ).run();

    return opsJson({ ok: true, cat_id: catId, alert_level: level });
  }

  // PUT / PATCH /api/ops/cats/:id — 更新（1セグメントに限定。/id/foo を拾って誤更新しない）
  var putCatOnly = subPath.match(/^\/([^/]+)$/);
  if ((method === 'PUT' || method === 'PATCH') && putCatOnly) {
    var catId = decodeURIComponent(putCatOnly[1]);

    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }

    if (body.photo_url && body.photo_url.indexOf('data:') === 0 && env.NYAGI_FILES) {
      try {
        var match = body.photo_url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          var raw = atob(match[2]);
          var arr = new Uint8Array(raw.length);
          for (var bi = 0; bi < raw.length; bi++) arr[bi] = raw.charCodeAt(bi);
          var r2Key = 'cat-photos/' + catId + '.jpg';
          await env.NYAGI_FILES.put(r2Key, arr.buffer, {
            httpMetadata: { contentType: match[1] },
          });
          body.photo_url = 'r2:cat-photos/' + catId + '.jpg';
        }
      } catch (_) { /* fallback: keep data URL */ }
    }

    if (body.species !== undefined && body.species !== 'cat' && body.species !== 'dog') {
      return opsJson({ error: 'bad_request', message: 'species は cat または dog です' }, 400);
    }

    var catPutRow = await db.prepare('SELECT id FROM cats WHERE id = ?').bind(catId).first();
    if (!catPutRow) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);

    var fields = [];
    var values = [];
    var allowed = ['name', 'photo_url', 'birth_date', 'sex', 'neutered', 'microchip_id', 'location_id', 'status', 'description', 'internal_note', 'meals_per_day', 'assigned_preset_id', 'assigned_medication_preset_id', 'species', 'intake_info', 'adoption_info', 'water_tracking', 'diet_status'];

    for (var i = 0; i < allowed.length; i++) {
      var key = allowed[i];
      if (body[key] !== undefined) {
        fields.push(key + ' = ?');
        values.push(body[key]);
      }
    }

    if (fields.length === 0) {
      return opsJson({ error: 'bad_request', message: 'No fields to update' }, 400);
    }

    if (body.assigned_preset_id !== undefined) {
      var apRaw = body.assigned_preset_id;
      if (apRaw !== null && apRaw !== '' && String(apRaw) !== 'null') {
        var pidAsg = parseInt(apRaw, 10);
        if (isNaN(pidAsg) || pidAsg <= 0) {
          return opsJson({ error: 'bad_request', message: 'assigned_preset_id が不正です' }, 400);
        }
        var prAsg = await db.prepare('SELECT id, active FROM feeding_presets WHERE id = ?').bind(pidAsg).first();
        if (!prAsg || prAsg.active !== 1) {
          return opsJson({ error: 'bad_request', message: 'プリセットが見つかりません' }, 400);
        }
        var oth = await db.prepare(
          'SELECT id FROM cats WHERE assigned_preset_id = ? AND id != ?'
        ).bind(pidAsg, catId).first();
        if (oth) {
          return opsJson({ error: 'preset_conflict', message: 'プリセットがすでに割り当てられています' }, 409);
        }
      }
    }

    if (body.assigned_medication_preset_id !== undefined) {
      var apmRaw = body.assigned_medication_preset_id;
      if (apmRaw !== null && apmRaw !== '' && String(apmRaw) !== 'null') {
        var pidMed = parseInt(apmRaw, 10);
        if (isNaN(pidMed) || pidMed <= 0) {
          return opsJson({ error: 'bad_request', message: 'assigned_medication_preset_id が不正です' }, 400);
        }
        var prMed = await db.prepare('SELECT id, active FROM medication_presets WHERE id = ?').bind(pidMed).first();
        var medAct = prMed ? prMed.active : null;
        var medPresetUsable = prMed && (medAct == null || medAct === '' || Number(medAct) === 1);
        if (!medPresetUsable) {
          return opsJson({ error: 'bad_request', message: '投薬プリセットが見つかりません' }, 400);
        }
        var othM = await db.prepare(
          'SELECT id FROM cats WHERE assigned_medication_preset_id = ? AND id != ?'
        ).bind(pidMed, catId).first();
        if (othM) {
          return opsJson({ error: 'preset_conflict', message: 'この投薬プリセットは別の猫に割り当て済みです' }, 409);
        }
      }
    }

    // 名前変更時: 旧名を cat_name_dictionary に登録（音声認識用）
    if (body.name) {
      var oldCat = await db.prepare('SELECT name FROM cats WHERE id = ?').bind(catId).first();
      if (oldCat && oldCat.name && oldCat.name !== body.name) {
        var existing = await db.prepare(
          'SELECT id FROM cat_name_dictionary WHERE cat_id = ? AND variant = ?'
        ).bind(catId, oldCat.name).first();
        if (!existing) {
          await insertCatNameDictWithSources(db, {
            catId: catId,
            variant: oldCat.name,
            variantType: 'former_name',
            priority: 80,
            entrySource: 'rename',
            misrecognitionLogIds: [],
          });
          clearDictCache();
        }
      }
    }

    fields.push("updated_at = datetime('now')");
    values.push(catId);

    var updateSql = 'UPDATE cats SET ' + fields.join(', ') + ' WHERE id = ?';
    var updateStmt = db.prepare(updateSql);
    updateStmt = updateStmt.bind.apply(updateStmt, values);
    await updateStmt.run();

    if (body.species !== undefined || body.birth_date !== undefined || body.neutered !== undefined) {
      try { await refreshNutritionProfile(db, catId); } catch (_) {}
    }

    var payload = { ok: true, cat_id: catId };

    function normMedPresetCol(v) {
      if (v == null || v === '') return null;
      var n = Number(v);
      return isNaN(n) ? null : n;
    }

    if (body.assigned_medication_preset_id !== undefined) {
      var crowMp = await db.prepare('SELECT assigned_medication_preset_id FROM cats WHERE id = ?').bind(catId).first();
      var ampid = crowMp ? crowMp.assigned_medication_preset_id : null;
      var gotMp = normMedPresetCol(ampid);
      var wantMp = normMedPresetCol(body.assigned_medication_preset_id);
      if (gotMp !== wantMp) {
        return opsJson({
          error: 'server_error',
          message: '投薬プリセットの紐づけが保存されませんでした。DB に cats.assigned_medication_preset_id があるか、マイグレーションを確認してください。',
        }, 500);
      }
      var ampname = null;
      if (ampid != null && String(ampid).trim() !== '') {
        var mn = await db.prepare(
          'SELECT name FROM medication_presets WHERE id = ? AND COALESCE(active,1) = 1'
        ).bind(ampid).first();
        ampname = mn ? mn.name : null;
      }
      payload.assigned_medication_preset_id = ampid;
      payload.assigned_medication_preset_name = ampname;
      payload.cat = {
        id: catId,
        assigned_medication_preset_id: gotMp,
        assigned_medication_preset_name: ampname,
      };
    }

    return opsJson(payload);
  }

  return opsJson({ error: 'method_not_allowed' }, 405);
}
