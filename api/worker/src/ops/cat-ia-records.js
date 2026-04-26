/**
 * 引き受け・譲渡: 複数レコード × 各レコードに複数ファイル（files テーブル）
 */

import { opsJson } from './router.js';

var MODULE_LEGACY_INTAKE = 'cat_intake_doc';
var MODULE_LEGACY_ADOPTION = 'cat_adoption_doc';
var MODULE_INTAKE_RECORD_FILE = 'cat_intake_record';
var MODULE_ADOPTION_RECORD_FILE = 'cat_adoption_record';

var IA_FILE_MAX_BYTES = 10 * 1024 * 1024;
var IA_MAX_FILES_PER_UPLOAD = 25;

var IA_MIMES = {
  'image/jpeg': 1,
  'image/png': 1,
  'image/gif': 1,
  'image/webp': 1,
  'application/pdf': 1,
};

async function migrateLegacyIntakeDocs(db, catId) {
  var cnt = await db.prepare(
    "SELECT COUNT(1) AS c FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''"
  ).bind(MODULE_LEGACY_INTAKE, catId).first();
  if (!cnt || !cnt.c || cnt.c < 1) return;
  var row = await db.prepare(
    "INSERT INTO cat_intake_records (cat_id, note, created_by) VALUES (?, ?, NULL) RETURNING id"
  ).bind(catId, '（移行）以前の一括添付をこのレコードにまとめました').first();
  if (!row || row.id == null) return;
  var newId = String(row.id);
  await db.prepare(
    'UPDATE files SET module = ?, ref_id = ? WHERE module = ? AND ref_id = ?'
  ).bind(MODULE_INTAKE_RECORD_FILE, newId, MODULE_LEGACY_INTAKE, catId).run();
}

async function migrateLegacyAdoptionDocs(db, catId) {
  var cnt = await db.prepare(
    "SELECT COUNT(1) AS c FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''"
  ).bind(MODULE_LEGACY_ADOPTION, catId).first();
  if (!cnt || !cnt.c || cnt.c < 1) return;
  var row = await db.prepare(
    "INSERT INTO cat_adoption_records (cat_id, note, created_by) VALUES (?, ?, NULL) RETURNING id"
  ).bind(catId, '（移行）以前の一括添付をこのレコードにまとめました').first();
  if (!row || row.id == null) return;
  var newId = String(row.id);
  await db.prepare(
    'UPDATE files SET module = ?, ref_id = ? WHERE module = ? AND ref_id = ?'
  ).bind(MODULE_ADOPTION_RECORD_FILE, newId, MODULE_LEGACY_ADOPTION, catId).run();
}

async function fetchFilesForRecord(db, module, recordIdStr) {
  var res = await db.prepare(
    'SELECT id, original_name, mime_type, size_bytes, created_at FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL ORDER BY id ASC'
  ).bind(module, recordIdStr).all();
  return res.results || [];
}

async function listIntakeRecordsPayload(db, catId) {
  await migrateLegacyIntakeDocs(db, catId);
  var recs = await db.prepare(
    'SELECT id, cat_id, note, created_at, created_by FROM cat_intake_records WHERE cat_id = ? ORDER BY id DESC'
  ).bind(catId).all();
  var out = [];
  var rows = recs.results || [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var rid = String(r.id);
    var files = await fetchFilesForRecord(db, MODULE_INTAKE_RECORD_FILE, rid);
    out.push({
      id: r.id,
      cat_id: r.cat_id,
      note: r.note,
      created_at: r.created_at,
      created_by: r.created_by,
      files: files,
    });
  }
  return out;
}

async function listAdoptionRecordsPayload(db, catId) {
  await migrateLegacyAdoptionDocs(db, catId);
  var recs = await db.prepare(
    'SELECT id, cat_id, note, created_at, created_by FROM cat_adoption_records WHERE cat_id = ? ORDER BY id DESC'
  ).bind(catId).all();
  var out = [];
  var rows = recs.results || [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var rid = String(r.id);
    var files = await fetchFilesForRecord(db, MODULE_ADOPTION_RECORD_FILE, rid);
    out.push({
      id: r.id,
      cat_id: r.cat_id,
      note: r.note,
      created_at: r.created_at,
      created_by: r.created_by,
      files: files,
    });
  }
  return out;
}

export async function buildIaTimelinePayload(db, catId) {
  var intake = await listIntakeRecordsPayload(db, catId);
  var adoption = await listAdoptionRecordsPayload(db, catId);
  var ic = 0;
  var ac = 0;
  for (var a = 0; a < intake.length; a++) ic += (intake[a].files && intake[a].files.length) || 0;
  for (var b = 0; b < adoption.length; b++) ac += (adoption[b].files && adoption[b].files.length) || 0;
  return {
    intake_records: intake,
    adoption_records: adoption,
    intake_record_count: intake.length,
    adoption_record_count: adoption.length,
    intake_file_count: ic,
    adoption_file_count: ac,
    has_intake_file: ic > 0 ? 1 : 0,
    has_adoption_file: ac > 0 ? 1 : 0,
  };
}

function verifyIntakeRecord(db, catId, recordId) {
  return db.prepare('SELECT id FROM cat_intake_records WHERE id = ? AND cat_id = ?').bind(recordId, catId).first();
}

function verifyAdoptionRecord(db, catId, recordId) {
  return db.prepare('SELECT id FROM cat_adoption_records WHERE id = ? AND cat_id = ?').bind(recordId, catId).first();
}

export async function getIntakeRecordsJson(db, catId) {
  var catRow = await db.prepare('SELECT id FROM cats WHERE id = ?').bind(catId).first();
  if (!catRow) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);
  var list = await listIntakeRecordsPayload(db, catId);
  return opsJson({ records: list });
}

export async function getAdoptionRecordsJson(db, catId) {
  var catRow = await db.prepare('SELECT id FROM cats WHERE id = ?').bind(catId).first();
  if (!catRow) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);
  var list = await listAdoptionRecordsPayload(db, catId);
  return opsJson({ records: list });
}

export async function createIntakeRecord(req, db, staffAuth, catId) {
  var catRow = await db.prepare('SELECT id FROM cats WHERE id = ?').bind(catId).first();
  if (!catRow) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);
  var note = null;
  try {
    var body = await req.json();
    if (body && body.note != null) note = String(body.note).trim() || null;
  } catch (_) {}
  var row = await db.prepare(
    'INSERT INTO cat_intake_records (cat_id, note, created_by) VALUES (?, ?, ?) RETURNING id, created_at'
  ).bind(catId, note, staffAuth.staffId || null).first();
  if (!row) return opsJson({ error: 'server_error', message: 'Failed to create record' }, 500);
  return opsJson({ ok: true, record: { id: row.id, cat_id: catId, note: note, created_at: row.created_at, files: [] } }, 201);
}

export async function createAdoptionRecord(req, db, staffAuth, catId) {
  var catRow = await db.prepare('SELECT id FROM cats WHERE id = ?').bind(catId).first();
  if (!catRow) return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);
  var note = null;
  try {
    var body = await req.json();
    if (body && body.note != null) note = String(body.note).trim() || null;
  } catch (_) {}
  var row = await db.prepare(
    'INSERT INTO cat_adoption_records (cat_id, note, created_by) VALUES (?, ?, ?) RETURNING id, created_at'
  ).bind(catId, note, staffAuth.staffId || null).first();
  if (!row) return opsJson({ error: 'server_error', message: 'Failed to create record' }, 500);
  return opsJson({ ok: true, record: { id: row.id, cat_id: catId, note: note, created_at: row.created_at, files: [] } }, 201);
}

export async function updateIntakeRecord(req, db, staffAuth, catId, recordId) {
  var rid = parseInt(recordId, 10);
  if (isNaN(rid)) return opsJson({ error: 'bad_request', message: 'Invalid record id' }, 400);
  var rec = await verifyIntakeRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  if (body.note === undefined) {
    return opsJson({ error: 'bad_request', message: 'note required' }, 400);
  }
  var note = body.note == null ? null : String(body.note).trim() || null;
  await db.prepare('UPDATE cat_intake_records SET note = ? WHERE id = ? AND cat_id = ?').bind(note, rid, catId).run();
  return opsJson({ ok: true, id: rid, note: note });
}

export async function updateAdoptionRecord(req, db, staffAuth, catId, recordId) {
  var rid = parseInt(recordId, 10);
  if (isNaN(rid)) return opsJson({ error: 'bad_request', message: 'Invalid record id' }, 400);
  var rec = await verifyAdoptionRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  if (body.note === undefined) {
    return opsJson({ error: 'bad_request', message: 'note required' }, 400);
  }
  var note = body.note == null ? null : String(body.note).trim() || null;
  await db.prepare('UPDATE cat_adoption_records SET note = ? WHERE id = ? AND cat_id = ?').bind(note, rid, catId).run();
  return opsJson({ ok: true, id: rid, note: note });
}

async function deleteFilesByModuleRef(db, r2, module, refIdStr) {
  if (r2) {
    var fileRows = await db.prepare(
      'SELECT r2_key FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL'
    ).bind(module, refIdStr).all();
    var keys = fileRows.results || [];
    for (var fi = 0; fi < keys.length; fi++) {
      try {
        await r2.delete(keys[fi].r2_key);
      } catch (_) {}
    }
  }
  await db.prepare('DELETE FROM files WHERE module = ? AND ref_id = ?').bind(module, refIdStr).run();
}

export async function deleteIntakeRecord(db, r2, catId, recordId) {
  var rid = parseInt(recordId, 10);
  if (isNaN(rid)) return opsJson({ error: 'bad_request', message: 'Invalid record id' }, 400);
  var rec = await verifyIntakeRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var refStr = String(rid);
  await deleteFilesByModuleRef(db, r2, MODULE_INTAKE_RECORD_FILE, refStr);
  await db.prepare('DELETE FROM cat_intake_records WHERE id = ? AND cat_id = ?').bind(rid, catId).run();
  return opsJson({ ok: true, deleted: true });
}

export async function deleteAdoptionRecord(db, r2, catId, recordId) {
  var rid = parseInt(recordId, 10);
  if (isNaN(rid)) return opsJson({ error: 'bad_request', message: 'Invalid record id' }, 400);
  var rec = await verifyAdoptionRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var refStr = String(rid);
  await deleteFilesByModuleRef(db, r2, MODULE_ADOPTION_RECORD_FILE, refStr);
  await db.prepare('DELETE FROM cat_adoption_records WHERE id = ? AND cat_id = ?').bind(rid, catId).run();
  return opsJson({ ok: true, deleted: true });
}

async function uploadOneFileToRecord(file, env, db, staffAuth, catId, recordId, module, r2Prefix) {
  var r2 = env.NYAGI_FILES;
  var size = file.size || 0;
  if (size < 1) return { error: 'Empty file' };
  if (size > IA_FILE_MAX_BYTES) return { error: '各ファイルは10MB以下にしてください' };
  var mime = String(file.type || '').toLowerCase();
  if (!IA_MIMES[mime]) return { error: '対応形式: PDF・画像（JPEG/PNG/GIF/WebP）' };
  var buf = await file.arrayBuffer();
  if (buf.byteLength > IA_FILE_MAX_BYTES) return { error: '各ファイルは10MB以下にしてください' };
  var origName = file.name || 'file';
  var safeName = String(origName).replace(/[\r\n\\/]/g, '_').slice(0, 120) || 'file';
  var r2Key = r2Prefix + catId + '/r' + recordId + '/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + safeName;
  try {
    await r2.put(r2Key, buf, {
      httpMetadata: { contentType: mime || 'application/octet-stream' },
    });
  } catch (_) {
    return { error: 'ストレージへの保存に失敗しました' };
  }
  var ext = origName.indexOf('.') >= 0 ? origName.split('.').pop() : mime === 'application/pdf' ? 'pdf' : 'bin';
  var ins = await db.prepare(
    'INSERT INTO files (r2_key, module, ref_id, file_type, original_name, mime_type, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at'
  )
    .bind(r2Key, module, String(recordId), ext, origName, mime, buf.byteLength, staffAuth.staffId)
    .first();
  return { row: ins };
}

export async function uploadIntakeRecordFiles(req, env, db, staffAuth, catId, recordId) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'service_unavailable', message: 'File storage is not configured' }, 503);
  var rid = parseInt(recordId, 10);
  if (isNaN(rid)) return opsJson({ error: 'bad_request', message: 'Invalid record id' }, 400);
  var rec = await verifyIntakeRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var formData;
  try {
    formData = await req.formData();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Expected multipart form data' }, 400);
  }
  var rawList = formData.getAll('file');
  var files = [];
  for (var i = 0; i < rawList.length; i++) {
    if (rawList[i] && typeof rawList[i].arrayBuffer === 'function') files.push(rawList[i]);
  }
  if (files.length === 0) {
    var single = formData.get('file');
    if (single && typeof single.arrayBuffer === 'function') files.push(single);
  }
  if (files.length === 0) return opsJson({ error: 'bad_request', message: 'Missing file field' }, 400);
  if (files.length > IA_MAX_FILES_PER_UPLOAD) {
    return opsJson({ error: 'bad_request', message: '一度にアップロードできるのは' + IA_MAX_FILES_PER_UPLOAD + 'ファイルまでです' }, 400);
  }
  var saved = [];
  for (var j = 0; j < files.length; j++) {
    var up = await uploadOneFileToRecord(files[j], env, db, staffAuth, catId, rid, MODULE_INTAKE_RECORD_FILE, 'cat-intake/');
    if (up.error) {
      return opsJson({ error: 'bad_request', message: up.error }, 400);
    }
    if (up.row) {
      saved.push({
        id: up.row.id,
        original_name: files[j].name || 'file',
        mime_type: String(files[j].type || '').toLowerCase(),
        size_bytes: files[j].size || 0,
        created_at: up.row.created_at,
      });
    }
  }
  return opsJson({ ok: true, uploaded: saved.length, files: saved });
}

export async function uploadAdoptionRecordFiles(req, env, db, staffAuth, catId, recordId) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'service_unavailable', message: 'File storage is not configured' }, 503);
  var rid = parseInt(recordId, 10);
  if (isNaN(rid)) return opsJson({ error: 'bad_request', message: 'Invalid record id' }, 400);
  var rec = await verifyAdoptionRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var formData;
  try {
    formData = await req.formData();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Expected multipart form data' }, 400);
  }
  var rawList = formData.getAll('file');
  var files = [];
  for (var i = 0; i < rawList.length; i++) {
    if (rawList[i] && typeof rawList[i].arrayBuffer === 'function') files.push(rawList[i]);
  }
  if (files.length === 0) {
    var single = formData.get('file');
    if (single && typeof single.arrayBuffer === 'function') files.push(single);
  }
  if (files.length === 0) return opsJson({ error: 'bad_request', message: 'Missing file field' }, 400);
  if (files.length > IA_MAX_FILES_PER_UPLOAD) {
    return opsJson({ error: 'bad_request', message: '一度にアップロードできるのは' + IA_MAX_FILES_PER_UPLOAD + 'ファイルまでです' }, 400);
  }
  var saved = [];
  for (var j = 0; j < files.length; j++) {
    var up = await uploadOneFileToRecord(files[j], env, db, staffAuth, catId, rid, MODULE_ADOPTION_RECORD_FILE, 'cat-adoption/');
    if (up.error) {
      return opsJson({ error: 'bad_request', message: up.error }, 400);
    }
    if (up.row) {
      saved.push({
        id: up.row.id,
        original_name: files[j].name || 'file',
        mime_type: String(files[j].type || '').toLowerCase(),
        size_bytes: files[j].size || 0,
        created_at: up.row.created_at,
      });
    }
  }
  return opsJson({ ok: true, uploaded: saved.length, files: saved });
}

export async function serveIntakeRecordFile(env, db, catId, recordId, fileId) {
  var rid = parseInt(recordId, 10);
  var fid = parseInt(fileId, 10);
  if (isNaN(rid) || isNaN(fid)) return opsJson({ error: 'bad_request', message: 'Invalid id' }, 400);
  var rec = await verifyIntakeRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var fileRow = await db.prepare(
    'SELECT r2_key, original_name, mime_type FROM files WHERE id = ? AND module = ? AND ref_id = ? AND r2_key IS NOT NULL'
  ).bind(fid, MODULE_INTAKE_RECORD_FILE, String(rid)).first();
  if (!fileRow || !fileRow.r2_key) return opsJson({ error: 'not_found', message: 'File not found' }, 404);
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'unavailable', message: 'Storage not available' }, 503);
  var obj = await r2.get(fileRow.r2_key);
  if (!obj) return opsJson({ error: 'not_found', message: 'File missing in storage' }, 404);
  var headers = new Headers();
  headers.set('Content-Type', fileRow.mime_type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + (fileRow.original_name || 'file') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

export async function serveAdoptionRecordFile(env, db, catId, recordId, fileId) {
  var rid = parseInt(recordId, 10);
  var fid = parseInt(fileId, 10);
  if (isNaN(rid) || isNaN(fid)) return opsJson({ error: 'bad_request', message: 'Invalid id' }, 400);
  var rec = await verifyAdoptionRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var fileRow = await db.prepare(
    'SELECT r2_key, original_name, mime_type FROM files WHERE id = ? AND module = ? AND ref_id = ? AND r2_key IS NOT NULL'
  ).bind(fid, MODULE_ADOPTION_RECORD_FILE, String(rid)).first();
  if (!fileRow || !fileRow.r2_key) return opsJson({ error: 'not_found', message: 'File not found' }, 404);
  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'unavailable', message: 'Storage not available' }, 503);
  var obj = await r2.get(fileRow.r2_key);
  if (!obj) return opsJson({ error: 'not_found', message: 'File missing in storage' }, 404);
  var headers = new Headers();
  headers.set('Content-Type', fileRow.mime_type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + (fileRow.original_name || 'file') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

export async function deleteIntakeRecordFile(db, r2, catId, recordId, fileId) {
  var rid = parseInt(recordId, 10);
  var fid = parseInt(fileId, 10);
  if (isNaN(rid) || isNaN(fid)) return opsJson({ error: 'bad_request', message: 'Invalid id' }, 400);
  var rec = await verifyIntakeRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var fileRow = await db.prepare(
    'SELECT r2_key FROM files WHERE id = ? AND module = ? AND ref_id = ? AND r2_key IS NOT NULL'
  ).bind(fid, MODULE_INTAKE_RECORD_FILE, String(rid)).first();
  if (!fileRow) return opsJson({ error: 'not_found', message: 'File not found' }, 404);
  if (r2 && fileRow.r2_key) {
    try {
      await r2.delete(fileRow.r2_key);
    } catch (_) {}
  }
  await db.prepare('DELETE FROM files WHERE id = ?').bind(fid).run();
  return opsJson({ ok: true, deleted: true });
}

export async function deleteAdoptionRecordFile(db, r2, catId, recordId, fileId) {
  var rid = parseInt(recordId, 10);
  var fid = parseInt(fileId, 10);
  if (isNaN(rid) || isNaN(fid)) return opsJson({ error: 'bad_request', message: 'Invalid id' }, 400);
  var rec = await verifyAdoptionRecord(db, catId, rid);
  if (!rec) return opsJson({ error: 'not_found', message: 'Record not found' }, 404);
  var fileRow = await db.prepare(
    'SELECT r2_key FROM files WHERE id = ? AND module = ? AND ref_id = ? AND r2_key IS NOT NULL'
  ).bind(fid, MODULE_ADOPTION_RECORD_FILE, String(rid)).first();
  if (!fileRow) return opsJson({ error: 'not_found', message: 'File not found' }, 404);
  if (r2 && fileRow.r2_key) {
    try {
      await r2.delete(fileRow.r2_key);
    } catch (_) {}
  }
  await db.prepare('DELETE FROM files WHERE id = ?').bind(fid).run();
  return opsJson({ ok: true, deleted: true });
}
