/**
 * NYAGI 業務連絡掲示板ハンドラ
 *
 * GET    /bulletin/meta/display-catalog    → 注意事項カテゴリ・健康記録種別の表示名一覧（選別用・認証必須）
 * GET    /bulletin?location=cafe&limit=30  → 業務連絡一覧（attachments 付き）
 * POST   /bulletin                         → 業務連絡作成（JSON または multipart: title, body, location_id, pinned, files[]）
 * POST   /bulletin/:id/files               → 既存メッセージへファイル追加（multipart: files[]）
 * GET    /bulletin/:id/files/:fileId       → 添付バイナリ（認証必須）
 * DELETE /bulletin/:id/files/:fileId      → 添付1件削除
 * PUT    /bulletin/:id                     → 業務連絡更新
 * DELETE /bulletin/:id                     → 業務連絡削除（添付・R2 も削除）
 *
 * 添付 MIME: 画像・動画（video/*）・PDF/Office 等。掲示板 UI は動画を inline 再生。
 */

import { opsJson } from './router.js';
import { buildDisplayCatalogPayload } from './display-catalog.js';
import { attachThreadCommentsTo } from './thread-comments.js';

/** 1ファイルあたり（Worker の実運用を踏まえ 32MB） */
var BULLETIN_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** 1メッセージあたりの添付数 */
var BULLETIN_MAX_FILES_PER_MESSAGE = 25;
/** 1メッセージの添付合計サイズ上限 */
var BULLETIN_TOTAL_MAX_BYTES = 200 * 1024 * 1024;

var BULLETIN_EXTRA_MIMES = {
  'application/pdf': 1,
  'text/plain': 1,
  'text/csv': 1,
  'application/msword': 1,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 1,
  'application/vnd.ms-excel': 1,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 1,
  'application/vnd.ms-powerpoint': 1,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 1,
  'application/zip': 1,
};

/** R2 キー用（ASCII のみ） */
function bulletinSafeKeyPart(name) {
  var s = String(name || 'file').split(/[/\\]/).pop() || 'file';
  s = s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  if (!s) s = 'file';
  return s;
}

/** DB 表示用（元ファイル名を保持・長さのみ制限） */
function bulletinOriginalName(name) {
  var s = String(name || 'file').split(/[/\\]/).pop() || 'file';
  return s.slice(0, 200);
}

function normalizeMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function isBulletinMimeAllowed(mime) {
  var m = normalizeMime(mime);
  if (!m) return false;
  if (/^image\//.test(m)) return true;
  if (/^video\//.test(m)) return true;
  return !!BULLETIN_EXTRA_MIMES[m];
}

/**
 * DB の mime が空・octet-stream 等のとき、配信・許可判定用に拡張子から推定。
 * 一覧 API の mime と GET の Content-Type を揃える用途。
 */
function guessBulletinMimeFromFilename(name) {
  var n = String(name || '').toLowerCase();
  var m = n.match(/\.([a-z0-9]+)$/);
  var ext = m ? m[1] : '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'ogv') return 'video/ogg';
  if (ext === 'mkv') return 'video/x-matroska';
  if (ext === 'avi') return 'video/x-msvideo';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'txt') return 'text/plain';
  if (ext === 'csv') return 'text/csv';
  if (ext === 'zip') return 'application/zip';
  if (ext === 'doc') return 'application/msword';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'ppt') return 'application/vnd.ms-powerpoint';
  if (ext === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return '';
}

/** 先頭バイトから MIME 推定（DB / ファイル名が不正な掲示板添付の GET 用） */
function sniffBulletinMimeFromMagic(u8) {
  if (!u8 || u8.length < 4) return '';
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  if (u8.length >= 6 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return 'image/gif';
  if (
    u8.length >= 12 &&
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x45 &&
    u8[10] === 0x42 &&
    u8[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (u8.length >= 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
    var b8 = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
    if (b8 === 'heic' || b8 === 'heix' || b8 === 'hevc' || b8 === 'mif1') return 'image/heic';
    if (b8 === 'avif' || b8 === 'avis') return 'image/avif';
    if (b8 === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'application/pdf';
  if (u8[0] === 0x50 && u8[1] === 0x4b) return 'application/zip';
  return '';
}

/** 一覧 JSON 用: 空・octet-stream は拡張子で補う（カードで img/video 分岐するため） */
function enrichBulletinListMime(mime, name) {
  var m = normalizeMime(mime);
  if (m && m !== 'application/octet-stream') return m;
  var g = guessBulletinMimeFromFilename(name);
  return g || m;
}

function extFromMime(mime) {
  var m = normalizeMime(mime);
  if (m.indexOf('pdf') !== -1) return 'pdf';
  if (m.indexOf('png') !== -1) return 'png';
  if (m.indexOf('webp') !== -1) return 'webp';
  if (m.indexOf('gif') !== -1) return 'gif';
  if (m.indexOf('csv') !== -1) return 'csv';
  if (m.indexOf('plain') !== -1) return 'txt';
  if (m.indexOf('zip') !== -1) return 'zip';
  if (m.indexOf('spreadsheet') !== -1 || m.indexOf('excel') !== -1) return 'xlsx';
  if (m.indexOf('word') !== -1) return 'docx';
  if (m.indexOf('presentation') !== -1 || m.indexOf('powerpoint') !== -1) return 'pptx';
  if (m.indexOf('heic') !== -1 || m.indexOf('heif') !== -1) return 'heic';
  if (m.indexOf('avif') !== -1) return 'avif';
  if (m.indexOf('tiff') !== -1) return 'tiff';
  if (m.indexOf('mp4') !== -1 || m.indexOf('mpeg') !== -1) return 'mp4';
  if (m.indexOf('webm') !== -1) return 'webm';
  if (m.indexOf('quicktime') !== -1) return 'mov';
  if (m.indexOf('ogg') !== -1) return 'ogv';
  return 'bin';
}

/**
 * 編集・削除・ピン留め変更は「投稿者本人」または「role=owner」のみに限定。
 * 追記（bulletin_comments）は認証済みスタッフなら誰でも可能。
 */
function isBulletinOwnerOrSelf(staffAuth, row) {
  if (!staffAuth || !row) return false;
  if (staffAuth.role === 'owner') return true;
  var rowStaffId = row.staff_id != null ? String(row.staff_id) : '';
  var myStaffId = staffAuth.staffId != null ? String(staffAuth.staffId) : '';
  return !!rowStaffId && rowStaffId === myStaffId;
}

export async function handleBulletin(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  if (method === 'GET' && subPath === '/meta/display-catalog') {
    return opsJson(buildDisplayCatalogPayload());
  }

  var fileMatch = subPath.match(/^\/(\d+)\/files\/(\d+)$/);
  if (fileMatch) {
    var bid = Number(fileMatch[1]);
    var fid = Number(fileMatch[2]);
    if (method === 'GET') return serveBulletinFile(env, db, bid, fid);
    if (method === 'DELETE') return deleteBulletinOneFile(env, db, bid, fid, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  var filesPostMatch = subPath.match(/^\/(\d+)\/files$/);
  if (filesPostMatch && method === 'POST') {
    return appendBulletinFilesMultipart(env, db, req, staffAuth, Number(filesPostMatch[1]));
  }

  var commentIdMatch = subPath.match(/^\/(\d+)\/comments\/(\d+)$/);
  if (commentIdMatch) {
    var cbid = Number(commentIdMatch[1]);
    var ccid = Number(commentIdMatch[2]);
    if (method === 'PUT') return updateComment(db, req, staffAuth, cbid, ccid);
    if (method === 'DELETE') return deleteComment(db, staffAuth, cbid, ccid);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  var commentsMatch = subPath.match(/^\/(\d+)\/comments$/);
  if (commentsMatch) {
    var bbid = Number(commentsMatch[1]);
    if (method === 'GET') return listComments(db, bbid);
    if (method === 'POST') return createComment(db, req, staffAuth, bbid);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  var idMatch = subPath.match(/^\/(\d+)$/);
  if (idMatch) {
    var id = Number(idMatch[1]);
    if (method === 'PUT') return updateMessage(db, req, staffAuth, id);
    if (method === 'DELETE') return deleteMessage(env, db, staffAuth, id);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  if (subPath === '' || subPath === '/') {
    if (method === 'GET') return getMessages(db, url, staffAuth);
    if (method === 'POST') {
      var ct = (req.headers.get('Content-Type') || '').toLowerCase();
      if (ct.indexOf('multipart/form-data') !== -1) {
        return createMessageWithFiles(env, db, req, staffAuth);
      }
      return createMessage(db, req, staffAuth);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  return opsJson({ error: 'not_found' }, 404);
}

async function attachBulletinCommentsMeta(db, messages) {
  await attachThreadCommentsTo(db, 'bulletin', messages, 'id');
}

async function attachBulletinFilesMeta(db, messages) {
  var rows = messages || [];
  if (!rows.length) return;
  var ids = [];
  for (var i = 0; i < rows.length; i++) ids.push(String(rows[i].id));
  var placeholders = ids.map(function () {
    return '?';
  }).join(',');
  var sql =
    'SELECT id, ref_id, original_name, mime_type, size_bytes FROM files WHERE module = ? AND ref_id IN (' +
    placeholders +
    ') AND r2_key IS NOT NULL AND r2_key != ? ORDER BY id ASC';
  var bindArgs = ['bulletin'].concat(ids).concat(['']);
  var stmt = db.prepare(sql);
  stmt = stmt.bind.apply(stmt, bindArgs);
  var res = await stmt.all();
  var atts = res.results || [];
  var map = {};
  for (var j = 0; j < atts.length; j++) {
    var a = atts[j];
    var rid = String(a.ref_id);
    if (!map[rid]) map[rid] = [];
    map[rid].push({
      id: a.id,
      original_name: a.original_name,
      mime_type: enrichBulletinListMime(a.mime_type, a.original_name),
      size_bytes: a.size_bytes,
    });
  }
  for (var k = 0; k < rows.length; k++) {
    rows[k].attachments = map[String(rows[k].id)] || [];
  }
}

async function getMessages(db, url, staffAuth) {
  var locationId = url.searchParams.get('location') || staffAuth.locationId || 'all';
  var limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10) || 50);

  var sql = 'SELECT b.*, s.name AS staff_name FROM bulletin_messages b LEFT JOIN staff s ON b.staff_id = s.id';
  var params = [];

  if (locationId && locationId !== 'all') {
    sql += ' WHERE b.location_id = ?';
    params.push(locationId);
  }

  sql += ' ORDER BY b.pinned DESC, b.created_at DESC LIMIT ?';
  params.push(limit);

  var stmt = db.prepare(sql);
  if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
  var result = await stmt.all();
  var list = result.results || [];
  await attachBulletinFilesMeta(db, list);
  await attachBulletinCommentsMeta(db, list);
  return opsJson({
    messages: list,
    viewer: {
      staff_id: staffAuth && staffAuth.staffId != null ? String(staffAuth.staffId) : '',
      role: staffAuth && staffAuth.role ? staffAuth.role : ''
    }
  });
}

async function createMessage(db, req, staffAuth) {
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'invalid_json' }, 400);
  }

  var title = (body.title || '').trim();
  var text = (body.body || '').trim();
  var locationId = body.location_id || staffAuth.locationId || 'cafe';
  var pinned = body.pinned ? 1 : 0;

  if (!title || !text) {
    return opsJson({ error: 'missing_fields', message: 'title, body は必須です' }, 400);
  }

  var result = await db
    .prepare('INSERT INTO bulletin_messages (location_id, staff_id, title, body, pinned) VALUES (?, ?, ?, ?, ?)')
    .bind(locationId, staffAuth.staffId, title, text, pinned)
    .run();

  var newId = result.meta.last_row_id;
  if (!newId) return opsJson({ error: 'create_failed' }, 500);

  var created = await db
    .prepare(
      'SELECT b.*, s.name AS staff_name FROM bulletin_messages b LEFT JOIN staff s ON b.staff_id = s.id WHERE b.id = ?'
    )
    .bind(newId)
    .first();

  await attachBulletinFilesMeta(db, [created]);
  return opsJson({ message: created });
}

async function countAndSizeBulletinAttachments(db, bulletinId) {
  var ref = String(bulletinId);
  var rows = await db
    .prepare(
      "SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS total FROM files WHERE module = 'bulletin' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''"
    )
    .bind(ref)
    .first();
  var c = rows && rows.c != null ? parseInt(rows.c, 10) : 0;
  var t = rows && rows.total != null ? parseInt(rows.total, 10) : 0;
  return { count: c, totalBytes: t };
}

async function storeBulletinFile(env, db, bulletinId, staffId, file) {
  if (!file || typeof file.arrayBuffer !== 'function') return { error: 'invalid_file' };
  var buf = await file.arrayBuffer();
  var bytes = new Uint8Array(buf);
  var len = bytes.byteLength;
  if (!len) return { error: 'empty_file' };
  if (len > BULLETIN_FILE_MAX_BYTES) {
    return { error: 'file_too_large', message: '1ファイルは最大32MBまでです' };
  }
  var rawMime = file.type || 'application/octet-stream';
  var mimeKey = normalizeMime(rawMime);
  if (!isBulletinMimeAllowed(mimeKey)) {
    return { error: 'unsupported_mime', message: '画像・PDF・Office・zip・テキスト等のみ対応です' };
  }
  if (!env.NYAGI_FILES) return { error: 'storage_not_configured' };

  var origName = bulletinOriginalName(file.name);
  var keyPart = bulletinSafeKeyPart(file.name);
  var ext = extFromMime(mimeKey);
  if (keyPart.indexOf('.') === -1) keyPart += '.' + ext;

  var r2Key =
    'bulletin/' +
    bulletinId +
    '/' +
    Date.now() +
    '_' +
    Math.random().toString(36).slice(2, 8) +
    '_' +
    keyPart;
  await env.NYAGI_FILES.put(r2Key, bytes, { httpMetadata: { contentType: mimeKey } });
  var fileExt = origName.indexOf('.') >= 0 ? origName.split('.').pop() : ext;
  var ins = await db
    .prepare(
      "INSERT INTO files (r2_key, module, ref_id, file_type, original_name, mime_type, size_bytes, uploaded_by) VALUES (?, 'bulletin', ?, ?, ?, ?, ?, ?)"
    )
    .bind(r2Key, String(bulletinId), fileExt, origName, mimeKey, len, staffId)
    .run();
  var fid = ins.meta && ins.meta.last_row_id ? ins.meta.last_row_id : null;
  return { ok: true, size: len, fileId: fid };
}

async function rollbackBulletinFileIds(env, db, fileIds) {
  if (!fileIds || !fileIds.length) return;
  for (var ri = 0; ri < fileIds.length; ri++) {
    var fid = fileIds[ri];
    if (!fid) continue;
    var row = await db.prepare("SELECT r2_key FROM files WHERE id = ? AND module = 'bulletin'").bind(fid).first();
    if (env.NYAGI_FILES && row && row.r2_key) {
      try {
        await env.NYAGI_FILES.delete(row.r2_key);
      } catch (_) {}
    }
    await db.prepare('DELETE FROM files WHERE id = ? AND module = ?').bind(fid, 'bulletin').run();
  }
}

async function processUploadedFiles(env, db, bulletinId, staffId, fileList) {
  var stat = await countAndSizeBulletinAttachments(db, bulletinId);
  var totalSoFar = stat.totalBytes;
  var countSoFar = stat.count;
  var addedThisBatch = [];

  for (var i = 0; i < fileList.length; i++) {
    var f = fileList[i];
    if (countSoFar >= BULLETIN_MAX_FILES_PER_MESSAGE) {
      await rollbackBulletinFileIds(env, db, addedThisBatch);
      return { error: 'too_many_files', message: '添付は最大25件までです' };
    }
    var predicted = typeof f.size === 'number' ? f.size : 0;
    if (predicted > BULLETIN_FILE_MAX_BYTES) {
      await rollbackBulletinFileIds(env, db, addedThisBatch);
      return { error: 'file_too_large', message: '1ファイルは最大32MBまでです' };
    }
    if (totalSoFar + predicted > BULLETIN_TOTAL_MAX_BYTES && predicted > 0) {
      await rollbackBulletinFileIds(env, db, addedThisBatch);
      return { error: 'total_too_large', message: '添付の合計は最大約200MBまでです' };
    }
    var r = await storeBulletinFile(env, db, bulletinId, staffId, f);
    if (r.error) {
      await rollbackBulletinFileIds(env, db, addedThisBatch);
      return r;
    }
    if (r.fileId) addedThisBatch.push(r.fileId);
    totalSoFar += r.size;
    countSoFar += 1;
    if (totalSoFar > BULLETIN_TOTAL_MAX_BYTES) {
      await rollbackBulletinFileIds(env, db, addedThisBatch);
      return { error: 'total_too_large', message: '添付の合計は最大約200MBまでです' };
    }
  }
  return { ok: true };
}

async function createMessageWithFiles(env, db, req, staffAuth) {
  if (!env.NYAGI_FILES) return opsJson({ error: 'storage_not_configured' }, 503);

  var form;
  try {
    form = await req.formData();
  } catch (_) {
    return opsJson({ error: 'invalid_multipart' }, 400);
  }

  var title = String(form.get('title') || '').trim();
  var text = String(form.get('body') || '').trim();
  var locationId = String(form.get('location_id') || staffAuth.locationId || 'cafe').trim();
  var pinnedRaw = form.get('pinned');
  var pinned = pinnedRaw === '1' || pinnedRaw === 'true' || pinnedRaw === true ? 1 : 0;

  if (!title || !text) {
    return opsJson({ error: 'missing_fields', message: 'title, body は必須です' }, 400);
  }

  var fileList = form.getAll('files');
  var files = [];
  for (var fi = 0; fi < fileList.length; fi++) {
    if (fileList[fi] && typeof fileList[fi].arrayBuffer === 'function') files.push(fileList[fi]);
  }

  var result = await db
    .prepare('INSERT INTO bulletin_messages (location_id, staff_id, title, body, pinned) VALUES (?, ?, ?, ?, ?)')
    .bind(locationId, staffAuth.staffId, title, text, pinned)
    .run();

  var newId = result.meta.last_row_id;
  if (!newId) return opsJson({ error: 'create_failed' }, 500);

  if (files.length) {
    var up = await processUploadedFiles(env, db, newId, staffAuth.staffId, files);
    if (up.error) {
      await deleteBulletinAttachments(env, db, newId);
      await db.prepare('DELETE FROM bulletin_messages WHERE id = ?').bind(newId).run();
      return opsJson({ error: up.error, message: up.message || up.error }, 400);
    }
  }

  var created = await db
    .prepare(
      'SELECT b.*, s.name AS staff_name FROM bulletin_messages b LEFT JOIN staff s ON b.staff_id = s.id WHERE b.id = ?'
    )
    .bind(newId)
    .first();

  await attachBulletinFilesMeta(db, [created]);
  return opsJson({ message: created });
}

async function appendBulletinFilesMultipart(env, db, req, staffAuth, bulletinId) {
  if (!env.NYAGI_FILES) return opsJson({ error: 'storage_not_configured' }, 503);

  var existing = await db
    .prepare('SELECT id, staff_id FROM bulletin_messages WHERE id = ?')
    .bind(bulletinId)
    .first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isBulletinOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '添付の追加は投稿者本人または管理者のみです' }, 403);
  }

  var form;
  try {
    form = await req.formData();
  } catch (_) {
    return opsJson({ error: 'invalid_multipart' }, 400);
  }

  var fileList = form.getAll('files');
  var files = [];
  for (var fi = 0; fi < fileList.length; fi++) {
    if (fileList[fi] && typeof fileList[fi].arrayBuffer === 'function') files.push(fileList[fi]);
  }
  if (!files.length) return opsJson({ error: 'no_files' }, 400);

  var up = await processUploadedFiles(env, db, bulletinId, staffAuth.staffId, files);
  if (up.error) return opsJson({ error: up.error, message: up.message || up.error }, 400);

  var updated = await db
    .prepare(
      'SELECT b.*, s.name AS staff_name FROM bulletin_messages b LEFT JOIN staff s ON b.staff_id = s.id WHERE b.id = ?'
    )
    .bind(bulletinId)
    .first();

  await attachBulletinFilesMeta(db, [updated]);
  return opsJson({ message: updated });
}

async function serveBulletinFile(env, db, bulletinId, fileId) {
  var fileRow = await db
    .prepare(
      "SELECT r2_key, original_name, mime_type FROM files WHERE id = ? AND module = 'bulletin' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''"
    )
    .bind(fileId, String(bulletinId))
    .first();
  if (!fileRow || !fileRow.r2_key || !env.NYAGI_FILES) return opsJson({ error: 'not_found' }, 404);
  var mimeKey = normalizeMime(fileRow.mime_type);
  var oct = mimeKey === 'application/octet-stream';
  var effectiveMime = mimeKey;
  if (!isBulletinMimeAllowed(effectiveMime) || !effectiveMime || oct) {
    var guessed = guessBulletinMimeFromFilename(fileRow.original_name);
    if (isBulletinMimeAllowed(guessed)) effectiveMime = guessed;
  }
  if (!isBulletinMimeAllowed(effectiveMime)) {
    var peek = await env.NYAGI_FILES.get(fileRow.r2_key, { range: { offset: 0, length: 96 } });
    if (peek) {
      try {
        var u8peek = new Uint8Array(await peek.arrayBuffer());
        var sniffed = sniffBulletinMimeFromMagic(u8peek);
        if (isBulletinMimeAllowed(sniffed)) effectiveMime = sniffed;
      } catch (_) {}
    }
  }
  if (!isBulletinMimeAllowed(effectiveMime)) return opsJson({ error: 'not_found' }, 404);
  var obj = await env.NYAGI_FILES.get(fileRow.r2_key);
  if (!obj) return opsJson({ error: 'not_found' }, 404);
  var headers = new Headers();
  headers.set('Content-Type', effectiveMime || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + String(fileRow.original_name || 'file').replace(/"/g, '') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

async function deleteBulletinAttachments(env, db, bulletinId) {
  var r2 = env.NYAGI_FILES;
  var ref = String(bulletinId);
  var fr = await db.prepare("SELECT id, r2_key FROM files WHERE module = 'bulletin' AND ref_id = ?").bind(ref).all();
  var rows = fr.results || [];
  for (var i = 0; i < rows.length; i++) {
    if (r2 && rows[i].r2_key) {
      try {
        await r2.delete(rows[i].r2_key);
      } catch (_) {}
    }
    await db.prepare('DELETE FROM files WHERE id = ?').bind(rows[i].id).run();
  }
}

async function deleteBulletinOneFile(env, db, bulletinId, fileId, staffAuth) {
  var parent = await db
    .prepare('SELECT id, staff_id FROM bulletin_messages WHERE id = ?')
    .bind(bulletinId)
    .first();
  if (!parent) return opsJson({ error: 'not_found' }, 404);
  if (!isBulletinOwnerOrSelf(staffAuth, parent)) {
    return opsJson({ error: 'forbidden', message: '添付の削除は投稿者本人または管理者のみです' }, 403);
  }
  var row = await db
    .prepare("SELECT id, r2_key FROM files WHERE id = ? AND module = 'bulletin' AND ref_id = ?")
    .bind(fileId, String(bulletinId))
    .first();
  if (!row) return opsJson({ error: 'not_found' }, 404);
  if (env.NYAGI_FILES && row.r2_key) {
    try {
      await env.NYAGI_FILES.delete(row.r2_key);
    } catch (_) {}
  }
  await db.prepare('DELETE FROM files WHERE id = ?').bind(row.id).run();
  return opsJson({ deleted: true });
}

async function updateMessage(db, req, staffAuth, id) {
  var existing = await db
    .prepare('SELECT id, staff_id FROM bulletin_messages WHERE id = ?')
    .bind(id)
    .first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isBulletinOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '編集できるのは投稿者本人または管理者のみです' }, 403);
  }

  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'invalid_json' }, 400);
  }

  var sets = [];
  var params = [];

  if (body.title !== undefined) {
    sets.push('title = ?');
    params.push(String(body.title).trim());
  }
  if (body.body !== undefined) {
    sets.push('body = ?');
    params.push(String(body.body).trim());
  }
  if (body.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(body.pinned ? 1 : 0);
  }
  if (body.location_id !== undefined) {
    sets.push('location_id = ?');
    params.push(body.location_id);
  }

  if (sets.length === 0) return opsJson({ error: 'no_changes' }, 400);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  var sql = 'UPDATE bulletin_messages SET ' + sets.join(', ') + ' WHERE id = ?';
  var stmt = db.prepare(sql);
  stmt = stmt.bind.apply(stmt, params);
  await stmt.run();

  var updated = await db
    .prepare(
      'SELECT b.*, s.name AS staff_name FROM bulletin_messages b LEFT JOIN staff s ON b.staff_id = s.id WHERE b.id = ?'
    )
    .bind(id)
    .first();

  await attachBulletinFilesMeta(db, [updated]);
  return opsJson({ message: updated });
}

async function deleteMessage(env, db, staffAuth, id) {
  var existing = await db
    .prepare('SELECT id, staff_id FROM bulletin_messages WHERE id = ?')
    .bind(id)
    .first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isBulletinOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '削除できるのは投稿者本人または管理者のみです' }, 403);
  }

  await deleteBulletinAttachments(env, db, id);
  await db.prepare("DELETE FROM thread_comments WHERE entity_type = 'bulletin' AND entity_id = ?").bind(id).run();
  await db.prepare('DELETE FROM bulletin_messages WHERE id = ?').bind(id).run();
  return opsJson({ deleted: true });
}

// ── 追記（thread_comments, entity_type='bulletin'）──────────────────

async function listComments(db, bulletinId) {
  var parent = await db.prepare('SELECT id FROM bulletin_messages WHERE id = ?').bind(bulletinId).first();
  if (!parent) return opsJson({ error: 'not_found' }, 404);
  var res = await db
    .prepare(
      'SELECT c.id, c.entity_id AS bulletin_id, c.staff_id, c.body, c.created_at, c.updated_at, s.name AS staff_name ' +
        'FROM thread_comments c LEFT JOIN staff s ON c.staff_id = s.id ' +
        "WHERE c.entity_type = 'bulletin' AND c.entity_id = ? ORDER BY c.created_at ASC, c.id ASC"
    )
    .bind(bulletinId)
    .all();
  return opsJson({ comments: res.results || [] });
}

async function createComment(db, req, staffAuth, bulletinId) {
  var parent = await db.prepare('SELECT id FROM bulletin_messages WHERE id = ?').bind(bulletinId).first();
  if (!parent) return opsJson({ error: 'not_found' }, 404);
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var text = String(body && body.body != null ? body.body : '').trim();
  if (!text) return opsJson({ error: 'missing_fields', message: '本文は必須です' }, 400);
  var ins = await db
    .prepare("INSERT INTO thread_comments (entity_type, entity_id, staff_id, body) VALUES ('bulletin', ?, ?, ?)")
    .bind(bulletinId, staffAuth.staffId || null, text)
    .run();
  var newId = ins.meta && ins.meta.last_row_id ? ins.meta.last_row_id : null;
  if (!newId) return opsJson({ error: 'create_failed' }, 500);
  var created = await db
    .prepare(
      'SELECT c.id, c.entity_id AS bulletin_id, c.staff_id, c.body, c.created_at, c.updated_at, s.name AS staff_name ' +
        'FROM thread_comments c LEFT JOIN staff s ON c.staff_id = s.id WHERE c.id = ?'
    )
    .bind(newId)
    .first();
  return opsJson({ comment: created });
}

async function updateComment(db, req, staffAuth, bulletinId, commentId) {
  var existing = await db
    .prepare("SELECT id, staff_id FROM thread_comments WHERE id = ? AND entity_type = 'bulletin' AND entity_id = ?")
    .bind(commentId, bulletinId)
    .first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isBulletinOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '追記を編集できるのは本人または管理者のみです' }, 403);
  }
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var text = String(body && body.body != null ? body.body : '').trim();
  if (!text) return opsJson({ error: 'missing_fields', message: '本文は必須です' }, 400);
  await db
    .prepare("UPDATE thread_comments SET body = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(text, commentId)
    .run();
  var updated = await db
    .prepare(
      'SELECT c.id, c.entity_id AS bulletin_id, c.staff_id, c.body, c.created_at, c.updated_at, s.name AS staff_name ' +
        'FROM thread_comments c LEFT JOIN staff s ON c.staff_id = s.id WHERE c.id = ?'
    )
    .bind(commentId)
    .first();
  return opsJson({ comment: updated });
}

async function deleteComment(db, staffAuth, bulletinId, commentId) {
  var existing = await db
    .prepare("SELECT id, staff_id FROM thread_comments WHERE id = ? AND entity_type = 'bulletin' AND entity_id = ?")
    .bind(commentId, bulletinId)
    .first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isBulletinOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '追記を削除できるのは本人または管理者のみです' }, 403);
  }
  await db.prepare('DELETE FROM thread_comments WHERE id = ?').bind(commentId).run();
  return opsJson({ deleted: true });
}
