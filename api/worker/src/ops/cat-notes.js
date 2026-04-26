/**
 * NYAGI 猫注意事項ハンドラ（P5.7）
 *
 * GET  /cat-notes?cat_id=&category=&pinned=  注意事項一覧
 * POST /cat-notes                            注意事項追加（note_image で R2 保存・notify_slack 可）
 * PUT  /cat-notes/:id                        注意事項編集（clear_attachment・note_image・notify_slack 可）
 * GET  /cat-notes/:id/attachment             保存済みのうち最新1件の配信（後方互換）
 * GET  /cat-notes/:id/attachments/:fileId    特定添付ファイルの配信
 * DELETE /cat-notes/:id/attachments/:fileId  特定添付のみ削除
 * DELETE /cat-notes/:id                      注意事項削除（添付も全削除）
 * GET  /signed-attachment?n=&f=&exp=&sig=    署名付き公開添付（Slack unfurl 用・認証不要）
 */

import { opsJson } from './router.js';
import { sendSlackMessage, shareBinaryFileToSlack, resolveNyagiReportSlackChannel } from './slack-notify.js';
import { attachThreadCommentsTo } from './thread-comments.js';

/**
 * 注意事項の編集・削除ガード。
 * 投稿者本人（cat_notes.staff_id）または role=owner のみ可。
 */
function isNoteOwnerOrSelf(staffAuth, row) {
  if (!staffAuth || !row) return false;
  if (staffAuth.role === 'owner') return true;
  var rowStaffId = row.staff_id != null ? String(row.staff_id) : '';
  var myStaffId = staffAuth.staffId != null ? String(staffAuth.staffId) : '';
  return !!rowStaffId && rowStaffId === myStaffId;
}

var SIGNED_URL_TTL_SEC = 7 * 24 * 3600;

async function hmacSign(secret, message) {
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  var sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function hmacVerify(secret, message, sigHex) {
  var expected = await hmacSign(secret, message);
  if (expected.length !== sigHex.length) return false;
  var ok = true;
  for (var i = 0; i < expected.length; i++) {
    if (expected[i] !== sigHex[i]) ok = false;
  }
  return ok;
}

export async function generateSignedAttachmentUrl(env, noteId, fileId, ttlSec) {
  var exp = Math.floor(Date.now() / 1000) + (ttlSec || SIGNED_URL_TTL_SEC);
  var msg = String(noteId) + ':' + String(fileId) + ':' + exp;
  var sig = await hmacSign(env.ADMIN_KEY || '', msg);
  return 'https://api.bakenekocafe.studio/api/ops/signed-attachment?n=' +
    encodeURIComponent(noteId) + '&f=' + encodeURIComponent(fileId) +
    '&exp=' + exp + '&sig=' + sig;
}

export async function handleSignedCatNoteAttachment(env, url) {
  var noteId = url.searchParams.get('n');
  var fileId = url.searchParams.get('f');
  var exp = url.searchParams.get('exp');
  var sig = url.searchParams.get('sig');
  if (!noteId || !fileId || !exp || !sig) return opsJson({ error: 'bad_request' }, 400);
  var now = Math.floor(Date.now() / 1000);
  if (now > parseInt(exp, 10)) return opsJson({ error: 'expired' }, 403);
  var msg = String(noteId) + ':' + String(fileId) + ':' + exp;
  var valid = await hmacVerify(env.ADMIN_KEY || '', msg, sig);
  if (!valid) return opsJson({ error: 'forbidden' }, 403);
  return serveCatNoteAttachmentByFileId(env, env.OPS_DB, parseInt(noteId, 10), parseInt(fileId, 10));
}

var NOTE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
var MAX_CAT_NOTE_ATTACHMENTS = 20;

var CAT_NOTE_ATTACHMENT_MIMES = {
  'image/jpeg': 1,
  'image/png': 1,
  'image/gif': 1,
  'image/webp': 1,
  'image/heic': 1,
  'image/heif': 1,
  'image/avif': 1,
  'application/pdf': 1,
};

function normalizeCatNoteMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

function guessCatNoteMimeFromFilename(name) {
  var n = String(name || '').toLowerCase();
  var m = n.match(/\.([a-z0-9]+)$/);
  var ext = m ? m[1] : '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'pdf') return 'application/pdf';
  return '';
}

function enrichCatNoteListMime(mime, name) {
  var mm = normalizeCatNoteMime(mime);
  if (mm && mm !== 'application/octet-stream') return mm;
  var g = guessCatNoteMimeFromFilename(name);
  return g || mm;
}

function sniffCatNoteMimeFromMagic(u8) {
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
  }
  if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'application/pdf';
  return '';
}

function isImageMime(mime) {
  return /^image\//.test(String(mime || ''));
}

function base64ToUint8Array(b64) {
  var clean = String(b64).replace(/\s/g, '');
  var bin = atob(clean);
  var len = bin.length;
  var arr = new Uint8Array(len);
  for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function mimeToExt(mime) {
  var m = String(mime || '').toLowerCase();
  if (m.indexOf('pdf') !== -1) return 'pdf';
  if (m.indexOf('png') !== -1) return 'png';
  if (m.indexOf('webp') !== -1) return 'webp';
  if (m.indexOf('gif') !== -1) return 'gif';
  if (m.indexOf('heic') !== -1 || m.indexOf('heif') !== -1) return 'heic';
  if (m.indexOf('avif') !== -1) return 'avif';
  return 'jpg';
}

function sanitizeUploadBasename(name) {
  var s = String(name || 'image').split(/[/\\]/).pop() || 'image';
  s = s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  if (!s) s = 'image';
  return s;
}

/** body.note_image または body.slack_image（data URL / base64）。無ければ null。 */
function parseNoteImagePayload(body) {
  if (!body) return null;
  var trimmedSource = body.note_image || body.slack_image;
  if (!trimmedSource || typeof trimmedSource !== 'string') return null;
  var trimmed = trimmedSource.trim();
  var mime = 'image/jpeg';
  var b64;
  if (trimmed.indexOf('data:') === 0) {
    var m = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed.replace(/\s/g, ''));
    if (!m) return null;
    mime = m[1] || mime;
    b64 = m[2];
  } else {
    b64 = trimmed;
    if (body.note_image_mime) mime = String(body.note_image_mime);
    else if (body.slack_image_mime) mime = String(body.slack_image_mime);
  }
  if (!b64) return null;
  var mimeKey = String(mime).split(';')[0].trim().toLowerCase();
  if (!CAT_NOTE_ATTACHMENT_MIMES[mimeKey]) return { error: 'invalid_attachment_type' };
  var bytes;
  try {
    bytes = base64ToUint8Array(b64);
  } catch (_) {
    return null;
  }
  if (!bytes || bytes.length < 8) return null;
  if (bytes.length > NOTE_ATTACHMENT_MAX_BYTES) return { error: 'note_attachment_too_large' };
  var ext = mimeToExt(mimeKey);
  var rawName = (body.note_image_name || body.slack_image_name) ? String(body.note_image_name || body.slack_image_name) : '';
  var filename = sanitizeUploadBasename(rawName || ('nyagi-cat-note.' + ext));
  if (filename.indexOf('.') === -1) filename += '.' + ext;
  return { bytes: bytes, filename: filename, mime: mimeKey, isImage: isImageMime(mimeKey) };
}

/** note_images: [{ data|note_image, name? }] 優先。無ければ単一 note_image。 */
function collectNewNoteImagePayloads(body) {
  if (!body) return { items: [] };
  if (body.note_images && Array.isArray(body.note_images) && body.note_images.length > 0) {
    var items = [];
    for (var i = 0; i < body.note_images.length; i++) {
      var it = body.note_images[i];
      if (!it || typeof it !== 'object') continue;
      var fake = { note_image: it.data || it.note_image, note_image_name: it.name || it.note_image_name };
      var p = parseNoteImagePayload(fake);
      if (p && p.error) return p;
      if (p && p.bytes) items.push(p);
    }
    return { items: items };
  }
  var single = parseNoteImagePayload(body);
  if (single && single.error) return single;
  if (single && single.bytes) return { items: [single] };
  return { items: [] };
}

async function countCatNoteAttachments(db, noteId) {
  var row = await db
    .prepare("SELECT COUNT(*) AS c FROM files WHERE module = 'cat_note' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''")
    .bind(String(noteId))
    .first();
  return row && row.c != null ? parseInt(row.c, 10) : 0;
}

/** D1 のバインド変数上限を超えないようチャンク分割 */
var D1_NOTE_CHUNK = 50;

async function attachAttachmentsForNotes(db, notes) {
  if (!notes || notes.length === 0) return;
  var ids = [];
  for (var ni = 0; ni < notes.length; ni++) ids.push(String(notes[ni].id));
  var rows = [];
  for (var ci = 0; ci < ids.length; ci += D1_NOTE_CHUNK) {
    var chunk = ids.slice(ci, ci + D1_NOTE_CHUNK);
    var placeholders = chunk.map(function () { return '?'; }).join(',');
    var stmt = db.prepare(
      "SELECT id, ref_id, original_name, mime_type FROM files WHERE module = 'cat_note' AND ref_id IN (" +
        placeholders +
        ") AND r2_key IS NOT NULL AND r2_key != '' ORDER BY id ASC"
    );
    stmt = stmt.bind.apply(stmt, chunk);
    var fr = await stmt.all();
    rows = rows.concat(fr.results || []);
  }
  var byRef = {};
  for (var ri = 0; ri < rows.length; ri++) {
    var r = rows[ri];
    var rk = String(r.ref_id);
    if (!byRef[rk]) byRef[rk] = [];
    byRef[rk].push({
      id: r.id,
      original_name: r.original_name,
      mime_type: enrichCatNoteListMime(r.mime_type, r.original_name),
    });
  }
  for (var j = 0; j < notes.length; j++) {
    var note = notes[j];
    var att = byRef[String(note.id)] || [];
    note.attachments = att;
    if (att.length) {
      var last = att[att.length - 1];
      note.attachment_file_id = last.id;
      note.attachment_mime = last.mime_type;
    } else {
      note.attachment_file_id = null;
      note.attachment_mime = null;
    }
  }
}

async function deleteCatNoteAttachments(env, db, noteId) {
  var r2 = env.NYAGI_FILES;
  var ref = String(noteId);
  var fr = await db.prepare("SELECT id, r2_key FROM files WHERE module = 'cat_note' AND ref_id = ?").bind(ref).all();
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

async function appendCatNoteAttachment(env, db, staffId, noteId, parsed) {
  if (!parsed || !parsed.bytes || !parsed.bytes.byteLength) return;
  if (!env.NYAGI_FILES) throw new Error('storage_not_configured');
  var mimeKey = String(parsed.mime || 'image/jpeg').split(';')[0].trim().toLowerCase();
  if (!CAT_NOTE_ATTACHMENT_MIMES[mimeKey]) mimeKey = 'image/jpeg';
  var safeName = sanitizeUploadBasename(parsed.filename || 'note.jpg');
  var r2Key = 'cat-notes/' + noteId + '/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + safeName;
  await env.NYAGI_FILES.put(r2Key, parsed.bytes, { httpMetadata: { contentType: mimeKey } });
  var ext = safeName.indexOf('.') >= 0 ? safeName.split('.').pop() : 'jpg';
  await db
    .prepare(
      "INSERT INTO files (r2_key, module, ref_id, file_type, original_name, mime_type, size_bytes, uploaded_by) VALUES (?, 'cat_note', ?, ?, ?, ?, ?, ?)"
    )
    .bind(r2Key, String(noteId), ext, safeName, mimeKey, parsed.bytes.byteLength, staffId)
    .run();
}

async function deleteOneCatNoteAttachment(env, db, noteId, fileId) {
  var row = await db
    .prepare("SELECT id, r2_key FROM files WHERE id = ? AND module = 'cat_note' AND ref_id = ?")
    .bind(fileId, String(noteId))
    .first();
  if (!row) return false;
  if (env.NYAGI_FILES && row.r2_key) {
    try {
      await env.NYAGI_FILES.delete(row.r2_key);
    } catch (_) {}
  }
  await db.prepare('DELETE FROM files WHERE id = ?').bind(row.id).run();
  return true;
}

async function loadFirstCatNoteFileBytes(env, db, noteId) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return null;
  var fileRow = await db
    .prepare(
      "SELECT r2_key, original_name, mime_type FROM files WHERE module = 'cat_note' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != '' ORDER BY id DESC LIMIT 1"
    )
    .bind(String(noteId))
    .first();
  if (!fileRow || !fileRow.r2_key) return null;
  var mimeKey = String(fileRow.mime_type || '').split(';')[0].trim().toLowerCase();
  if (!CAT_NOTE_ATTACHMENT_MIMES[mimeKey]) return null;
  var obj = await r2.get(fileRow.r2_key);
  if (!obj) return null;
  var buf = await obj.arrayBuffer();
  var bytes = new Uint8Array(buf);
  return { bytes: bytes, filename: fileRow.original_name || 'image.jpg', mime: mimeKey };
}

async function loadAllCatNoteFileBytes(env, db, noteId) {
  var r2 = env.NYAGI_FILES;
  if (!r2) return [];
  var fr = await db
    .prepare(
      "SELECT r2_key, original_name, mime_type FROM files WHERE module = 'cat_note' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != '' ORDER BY id ASC"
    )
    .bind(String(noteId))
    .all();
  var rows = fr.results || [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var fileRow = rows[i];
    var mimeKey = String(fileRow.mime_type || '').split(';')[0].trim().toLowerCase();
    if (!CAT_NOTE_ATTACHMENT_MIMES[mimeKey]) continue;
    var obj = await r2.get(fileRow.r2_key);
    if (!obj) continue;
    var buf = await obj.arrayBuffer();
    out.push({ bytes: new Uint8Array(buf), filename: fileRow.original_name || 'file', mime: mimeKey });
  }
  return out;
}

async function serveCatNoteAttachment(env, db, noteId) {
  var fileRow = await db
    .prepare(
      "SELECT r2_key, original_name, mime_type FROM files WHERE module = 'cat_note' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != '' ORDER BY id DESC LIMIT 1"
    )
    .bind(String(noteId))
    .first();
  if (!fileRow || !fileRow.r2_key || !env.NYAGI_FILES) return opsJson({ error: 'not_found' }, 404);
  var mimeKey = String(fileRow.mime_type || '').split(';')[0].trim().toLowerCase();
  if (!CAT_NOTE_ATTACHMENT_MIMES[mimeKey]) return opsJson({ error: 'not_found' }, 404);
  var obj = await env.NYAGI_FILES.get(fileRow.r2_key);
  if (!obj) return opsJson({ error: 'not_found' }, 404);
  var headers = new Headers();
  headers.set('Content-Type', mimeKey);
  headers.set('Content-Disposition', 'inline; filename="' + String(fileRow.original_name || 'image').replace(/"/g, '') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

async function serveCatNoteAttachmentByFileId(env, db, noteId, fileId) {
  var fileRow = await db
    .prepare(
      "SELECT r2_key, original_name, mime_type FROM files WHERE id = ? AND module = 'cat_note' AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''"
    )
    .bind(fileId, String(noteId))
    .first();
  if (!fileRow || !fileRow.r2_key || !env.NYAGI_FILES) return opsJson({ error: 'not_found' }, 404);
  var mimeKey = normalizeCatNoteMime(fileRow.mime_type);
  var oct = mimeKey === 'application/octet-stream';
  if (!CAT_NOTE_ATTACHMENT_MIMES[mimeKey] || !mimeKey || oct) {
    var guessed = guessCatNoteMimeFromFilename(fileRow.original_name);
    if (CAT_NOTE_ATTACHMENT_MIMES[guessed]) mimeKey = guessed;
  }
  if (!CAT_NOTE_ATTACHMENT_MIMES[mimeKey]) {
    var peek = await env.NYAGI_FILES.get(fileRow.r2_key, { range: { offset: 0, length: 96 } });
    if (peek) {
      try {
        var u8peek = new Uint8Array(await peek.arrayBuffer());
        var sniffed = sniffCatNoteMimeFromMagic(u8peek);
        if (CAT_NOTE_ATTACHMENT_MIMES[sniffed]) mimeKey = sniffed;
      } catch (_) {}
    }
  }
  if (!CAT_NOTE_ATTACHMENT_MIMES[mimeKey]) return opsJson({ error: 'not_found' }, 404);
  var obj = await env.NYAGI_FILES.get(fileRow.r2_key);
  if (!obj) return opsJson({ error: 'not_found' }, 404);
  var headers = new Headers();
  headers.set('Content-Type', mimeKey);
  headers.set('Content-Disposition', 'inline; filename="' + String(fileRow.original_name || 'file').replace(/"/g, '') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

async function fetchCatNoteRow(db, noteId) {
  var row = await db
    .prepare('SELECT n.*, s.name AS staff_name FROM cat_notes n LEFT JOIN staff s ON n.staff_id = s.id WHERE n.id = ?')
    .bind(noteId)
    .first();
  if (!row) return null;
  await attachAttachmentsForNotes(db, [row]);
  return row;
}

var NOTE_CATEGORY_JA = {
  general: '一般',
  health: '健康',
  behavior: '行動',
  feeding: '食事',
  medication: '投薬',
  task: 'タスク関連',
  warning: '警告',
  nutrition: '栄養',
};

var LOCATION_LABEL_JA = {
  cafe: 'BAKENEKO CAFE',
  nekomata: '猫又療養所',
  endo: '遠藤宅',
  azukari: '預かり隊',
};

async function notifyCatNoteToSlack(env, db, noteRow, opts) {
  opts = opts || {};
  var isUpdate = !!opts.is_update;
  var cat = await db.prepare('SELECT id, name, location_id FROM cats WHERE id = ?').bind(noteRow.cat_id).first();
  if (!cat) return { sent: false, reason: 'cat_not_found' };

  var channel = resolveNyagiReportSlackChannel(env, cat.location_id);
  if (!channel) return { sent: false, reason: 'slack_channel_not_configured' };

  var catName = (cat && cat.name) || noteRow.cat_id;
  var locLabel = LOCATION_LABEL_JA[cat.location_id] || cat.location_id || '';
  var catJa = NOTE_CATEGORY_JA[noteRow.category] || noteRow.category || '一般';
  var staffName = noteRow.staff_name ? String(noteRow.staff_name) : '';

  var lines = [];
  lines.push((isUpdate ? '✏️ ' : '📝 ') + '*猫の注意事項*（NYAGI）' + (isUpdate ? ' — 更新' : ' — 新規'));
  lines.push('');
  lines.push('*拠点:* ' + locLabel);
  lines.push('*猫:* ' + catName + ' (`' + noteRow.cat_id + '`)');
  lines.push('*カテゴリ:* ' + catJa);
  if (staffName) lines.push('*記録者:* ' + staffName);
  lines.push('');
  lines.push(noteRow.note || '');

  var attachments = opts.attachment_rows || [];
  if (attachments.length) {
    lines.push('');
    lines.push('📎 *添付ファイル（' + attachments.length + '件）*');
    for (var ai = 0; ai < attachments.length; ai++) {
      var att = attachments[ai];
      try {
        var signedUrl = await generateSignedAttachmentUrl(env, noteRow.id, att.id, SIGNED_URL_TTL_SEC);
        var isPdf = att.mime_type && att.mime_type.indexOf('pdf') !== -1;
        var fname = att.original_name || (isPdf ? 'document.pdf' : 'image');
        lines.push((isPdf ? '📄 ' : '🖼️ ') + '<' + signedUrl + '|' + fname + '>');
      } catch (e) {
        console.warn('[cat-notes] signed url generation failed:', e && e.message);
      }
    }
  }

  var text = lines.join('\n');
  var data = await sendSlackMessage(env, channel, text);
  if (data && data.ok) return { sent: true, channel: channel, with_file: attachments.length > 0, file_count: attachments.length };
  return { sent: false, reason: (data && data.error) || 'slack_api_failed' };
}

export async function handleCatNotes(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  var attByIdMatch = subPath.match(/^\/(\d+)\/attachments\/(\d+)$/);
  if (attByIdMatch) {
    var nid = parseInt(attByIdMatch[1], 10);
    var fid = parseInt(attByIdMatch[2], 10);
    if (method === 'GET') return serveCatNoteAttachmentByFileId(env, db, nid, fid);
    if (method === 'DELETE') {
      var okDel = await deleteOneCatNoteAttachment(env, db, nid, fid);
      if (!okDel) return opsJson({ error: 'not_found' }, 404);
      return opsJson({ deleted: true });
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  var attMatch = subPath.match(/^\/(\d+)\/attachment$/);
  if (attMatch && method === 'GET') {
    return serveCatNoteAttachment(env, db, parseInt(attMatch[1], 10));
  }

  var idMatch = subPath.match(/^\/(\d+)$/);
  if (idMatch) {
    var noteId = parseInt(idMatch[1], 10);
    if (method === 'PUT') return putNote(db, req, noteId, env, staffAuth);
    if (method === 'DELETE') return deleteNote(db, env, noteId, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  if (subPath === '' || subPath === '/') {
    if (method === 'GET') return getNotes(db, url, staffAuth);
    if (method === 'POST') return postNote(db, req, staffAuth, env);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  return opsJson({ error: 'not_found' }, 404);
}

async function getNotes(db, url, staffAuth) {
  var catId = url.searchParams.get('cat_id');
  var locationId = url.searchParams.get('location');
  if (!catId && !locationId) return opsJson({ error: 'missing_fields', message: 'cat_id または location は必須です' }, 400);

  var category = url.searchParams.get('category') || '';
  var excludeCategories = url.searchParams.get('exclude_categories') || '';
  var pinned = url.searchParams.get('pinned') || '';
  var limit = parseInt(url.searchParams.get('limit') || '50', 10);

  var sql, params = [];
  if (locationId && !catId) {
    sql = 'SELECT n.*, s.name AS staff_name, c.name AS cat_name, c.location_id FROM cat_notes n LEFT JOIN staff s ON n.staff_id = s.id JOIN cats c ON n.cat_id = c.id WHERE c.location_id = ?';
    params.push(locationId);
  } else {
    sql = 'SELECT n.*, s.name AS staff_name FROM cat_notes n LEFT JOIN staff s ON n.staff_id = s.id WHERE n.cat_id = ?';
    params.push(catId);
  }

  if (category) {
    var cats = category.split(',');
    sql += ' AND n.category IN (' + cats.map(function () { return '?'; }).join(',') + ')';
    for (var ci = 0; ci < cats.length; ci++) params.push(cats[ci]);
  }
  if (excludeCategories) {
    var exCats = excludeCategories.split(',');
    sql += ' AND n.category NOT IN (' + exCats.map(function () { return '?'; }).join(',') + ')';
    for (var ei = 0; ei < exCats.length; ei++) params.push(exCats[ei]);
  }
  if (pinned === '1') { sql += ' AND n.pinned = 1'; }

  // 並び順: order=created_at 指定時は純粋な時系列。
  // それ以外（既定）は pinned を先頭に寄せる従来挙動を維持。
  // 掲示板など「最新順にN件取りたい」用途で pinned が枠を占有して最新が落ちるのを避けるため。
  var orderParam = (url.searchParams.get('order') || '').toLowerCase();
  if (orderParam === 'created_at') {
    sql += ' ORDER BY n.created_at DESC LIMIT ?';
  } else {
    sql += ' ORDER BY n.pinned DESC, n.created_at DESC LIMIT ?';
  }
  params.push(limit);

  var stmt = db.prepare(sql);
  stmt = stmt.bind.apply(stmt, params);
  var result = await stmt.all();
  var notes = result.results || [];
  await attachAttachmentsForNotes(db, notes);
  await attachThreadCommentsTo(db, 'note', notes, 'id');
  return opsJson({
    notes: notes,
    viewer: {
      staff_id: staffAuth && staffAuth.staffId != null ? String(staffAuth.staffId) : '',
      role: staffAuth && staffAuth.role ? staffAuth.role : ''
    }
  });
}

async function postNote(db, req, staffAuth, env) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var catId = body.cat_id;
  var note = (body.note || '').trim();
  if (!catId || !note) return opsJson({ error: 'missing_fields', message: 'cat_id, note は必須です' }, 400);

  var notifySlack = !!body.notify_slack;

  var multi = collectNewNoteImagePayloads(body);
  if (multi && multi.error) {
    var imgMsg =
      multi.error === 'note_attachment_too_large'
        ? '添付ファイルは10MB以下にしてください'
        : 'ファイル形式は JPEG / PNG / GIF / WebP / HEIC / PDF にしてください';
    return opsJson({ error: multi.error, message: imgMsg }, 400);
  }
  if (multi.items.length > MAX_CAT_NOTE_ATTACHMENTS) {
    return opsJson(
      { error: 'too_many_attachments', message: '1件の注意事項に付けられるファイルは最大' + MAX_CAT_NOTE_ATTACHMENTS + '件です' },
      400
    );
  }

  var result = await db.prepare(
    'INSERT OR IGNORE INTO cat_notes (cat_id, staff_id, note, category, related_task_id, pinned) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(catId, staffAuth.staffId, note, body.category || 'general', body.related_task_id || null, body.pinned ? 1 : 0).run();

  var newId = result.meta.last_row_id;
  if (!newId) return opsJson({ error: 'create_failed', message: '注意事項の作成に失敗しました' }, 500);
  var created = await fetchCatNoteRow(db, newId);
  if (!created) return opsJson({ error: 'create_failed', message: '注意事項の作成に失敗しました' }, 500);

  if (multi.items.length) {
    try {
      for (var ai = 0; ai < multi.items.length; ai++) {
        await appendCatNoteAttachment(env, db, staffAuth.staffId, newId, multi.items[ai]);
      }
      created = await fetchCatNoteRow(db, newId);
    } catch (e) {
      console.warn('[cat-notes] attachment save failed:', e && e.message);
      var amsg =
        e && e.message === 'storage_not_configured'
          ? 'ファイルストレージが利用できません'
          : '添付の保存に失敗しました';
      return opsJson({ error: 'attachment_failed', message: amsg }, 500);
    }
  }

  var slackResult = null;
  if (notifySlack && created) {
    var attRows = (created.attachments && created.attachments.length) ? created.attachments : [];
    slackResult = await notifyCatNoteToSlack(env, db, created, { is_update: false, attachment_rows: attRows });
  }

  return opsJson({ note: created, slack: slackResult }, 201);
}

async function putNote(db, req, noteId, env, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var existing = await db.prepare('SELECT id, staff_id FROM cat_notes WHERE id = ?').bind(noteId).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isNoteOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '編集できるのは投稿者本人または管理者のみです' }, 403);
  }

  var notifySlack = !!body.notify_slack;
  var clearAttachment = !!body.clear_attachment;

  var multi = collectNewNoteImagePayloads(body);
  if (multi && multi.error) {
    var imgMsg2 =
      multi.error === 'note_attachment_too_large'
        ? '添付ファイルは10MB以下にしてください'
        : 'ファイル形式は JPEG / PNG / GIF / WebP / HEIC / PDF にしてください';
    return opsJson({ error: multi.error, message: imgMsg2 }, 400);
  }

  var deleteIdsRaw = body.delete_attachment_ids;
  var hasDeleteIds = deleteIdsRaw && Array.isArray(deleteIdsRaw) && deleteIdsRaw.length > 0;

  var sets = [];
  var params = [];
  if (body.note !== undefined) { sets.push('note = ?'); params.push(body.note); }
  if (body.category !== undefined) { sets.push('category = ?'); params.push(body.category); }
  if (body.pinned !== undefined) { sets.push('pinned = ?'); params.push(body.pinned ? 1 : 0); }

  if (clearAttachment) {
    await deleteCatNoteAttachments(env, db, noteId);
  }

  if (hasDeleteIds) {
    for (var di = 0; di < deleteIdsRaw.length; di++) {
      var did = parseInt(deleteIdsRaw[di], 10);
      if (did > 0) await deleteOneCatNoteAttachment(env, db, noteId, did);
    }
  }

  var afterDeleteCount = await countCatNoteAttachments(db, noteId);
  if (afterDeleteCount + multi.items.length > MAX_CAT_NOTE_ATTACHMENTS) {
    return opsJson(
      { error: 'too_many_attachments', message: '添付の合計が最大' + MAX_CAT_NOTE_ATTACHMENTS + '件を超えます（既存を削除するか、枚数を減らしてください）' },
      400
    );
  }

  if (
    sets.length === 0 &&
    !notifySlack &&
    !clearAttachment &&
    multi.items.length === 0 &&
    !hasDeleteIds
  ) {
    return opsJson({ error: 'no_fields' }, 400);
  }

  if (sets.length > 0) {
    params.push(noteId);
    var stmt = db.prepare('UPDATE cat_notes SET ' + sets.join(', ') + ' WHERE id = ?');
    stmt = stmt.bind.apply(stmt, params);
    await stmt.run();
  }

  if (multi.items.length) {
    try {
      for (var aj = 0; aj < multi.items.length; aj++) {
        await appendCatNoteAttachment(env, db, staffAuth.staffId, noteId, multi.items[aj]);
      }
    } catch (e) {
      console.warn('[cat-notes] attachment save failed:', e && e.message);
      var amsg2 =
        e && e.message === 'storage_not_configured'
          ? 'ファイルストレージが利用できません'
          : '添付の保存に失敗しました';
      return opsJson({ error: 'attachment_failed', message: amsg2 }, 500);
    }
  }

  var updated = await fetchCatNoteRow(db, noteId);

  var slackResult = null;
  if (notifySlack && updated) {
    var attRows2 = (updated.attachments && updated.attachments.length) ? updated.attachments : [];
    slackResult = await notifyCatNoteToSlack(env, db, updated, { is_update: true, attachment_rows: attRows2 });
  }

  return opsJson({ note: updated, slack: slackResult });
}

async function deleteNote(db, env, noteId, staffAuth) {
  var existing = await db.prepare('SELECT id, staff_id FROM cat_notes WHERE id = ?').bind(noteId).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isNoteOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '削除できるのは投稿者本人または管理者のみです' }, 403);
  }

  try {
    await deleteCatNoteAttachments(env, db, noteId);
  } catch (_) {}
  await db.prepare("DELETE FROM thread_comments WHERE entity_type = 'note' AND entity_id = ?").bind(noteId).run();
  await db.prepare('DELETE FROM cat_notes WHERE id = ?').bind(noteId).run();
  return opsJson({ deleted: true });
}
