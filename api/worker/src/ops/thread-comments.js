/**
 * 汎用「追記（コメント）」API
 *
 * 掲示板に出るカード（業務連絡 / 注意事項 / 病院記録）の追記を、
 * 単一テーブル thread_comments にまとめて扱う。
 *
 *   GET    /thread-comments?entity_type=X&entity_ids=1,2,3  — まとめ取得
 *   POST   /thread-comments                                  — 追記（認証済なら誰でも）
 *   PUT    /thread-comments/:id                              — 編集（投稿者本人 or owner）
 *   DELETE /thread-comments/:id                              — 削除（投稿者本人 or owner）
 */

import { opsJson } from './router.js';

var ALLOWED_ENTITY_TYPES = { bulletin: 1, note: 1, clinic: 1 };

function isCommentOwnerOrSelf(staffAuth, row) {
  if (!staffAuth || !row) return false;
  if (staffAuth.role === 'owner') return true;
  var rowStaffId = row.staff_id != null ? String(row.staff_id) : '';
  var myStaffId = staffAuth.staffId != null ? String(staffAuth.staffId) : '';
  return !!rowStaffId && rowStaffId === myStaffId;
}

export async function handleThreadComments(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  var idMatch = subPath.match(/^\/(\d+)$/);
  if (idMatch) {
    var cid = Number(idMatch[1]);
    if (method === 'PUT') return updateComment(db, req, staffAuth, cid);
    if (method === 'DELETE') return deleteComment(db, staffAuth, cid);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  if (subPath === '' || subPath === '/') {
    if (method === 'GET') return listComments(db, url);
    if (method === 'POST') return createComment(db, req, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  return opsJson({ error: 'not_found' }, 404);
}

async function listComments(db, url) {
  var entityType = String(url.searchParams.get('entity_type') || '').trim();
  if (!ALLOWED_ENTITY_TYPES[entityType]) {
    return opsJson({ error: 'invalid_entity_type' }, 400);
  }
  var idsParam = String(url.searchParams.get('entity_ids') || '').trim();
  if (!idsParam) {
    var entityId = Number(url.searchParams.get('entity_id'));
    if (!entityId) return opsJson({ comments: [] });
    idsParam = String(entityId);
  }
  var ids = idsParam
    .split(',')
    .map(function (s) { return Number(String(s).trim()); })
    .filter(function (n) { return !isNaN(n) && n > 0; });
  if (!ids.length) return opsJson({ comments: [] });
  var placeholders = ids.map(function () { return '?'; }).join(',');
  var sql =
    'SELECT c.id, c.entity_type, c.entity_id, c.staff_id, c.body, c.created_at, c.updated_at, s.name AS staff_name ' +
    'FROM thread_comments c LEFT JOIN staff s ON c.staff_id = s.id ' +
    'WHERE c.entity_type = ? AND c.entity_id IN (' + placeholders + ') ' +
    'ORDER BY c.entity_id ASC, c.created_at ASC, c.id ASC';
  var params = [entityType].concat(ids);
  var stmt = db.prepare(sql);
  stmt = stmt.bind.apply(stmt, params);
  var res = await stmt.all();
  return opsJson({ comments: res.results || [] });
}

async function createComment(db, req, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var entityType = String(body.entity_type || '').trim();
  var entityId = Number(body.entity_id);
  var text = String(body.body != null ? body.body : '').trim();
  if (!ALLOWED_ENTITY_TYPES[entityType]) return opsJson({ error: 'invalid_entity_type' }, 400);
  if (!entityId) return opsJson({ error: 'missing_entity_id' }, 400);
  if (!text) return opsJson({ error: 'missing_fields', message: '本文は必須です' }, 400);

  // 親レコード存在チェック（なければ 404）
  var tableByType = { bulletin: 'bulletin_messages', note: 'cat_notes', clinic: 'health_records' };
  var parent = await db
    .prepare('SELECT id FROM ' + tableByType[entityType] + ' WHERE id = ?')
    .bind(entityId)
    .first();
  if (!parent) return opsJson({ error: 'parent_not_found' }, 404);

  var ins = await db
    .prepare(
      'INSERT INTO thread_comments (entity_type, entity_id, staff_id, body) VALUES (?, ?, ?, ?)'
    )
    .bind(entityType, entityId, staffAuth.staffId || null, text)
    .run();
  var newId = ins.meta && ins.meta.last_row_id ? ins.meta.last_row_id : null;
  if (!newId) return opsJson({ error: 'create_failed' }, 500);

  var created = await db
    .prepare(
      'SELECT c.id, c.entity_type, c.entity_id, c.staff_id, c.body, c.created_at, c.updated_at, s.name AS staff_name ' +
        'FROM thread_comments c LEFT JOIN staff s ON c.staff_id = s.id WHERE c.id = ?'
    )
    .bind(newId)
    .first();
  return opsJson({ comment: created });
}

async function updateComment(db, req, staffAuth, commentId) {
  var existing = await db
    .prepare('SELECT id, staff_id FROM thread_comments WHERE id = ?')
    .bind(commentId)
    .first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isCommentOwnerOrSelf(staffAuth, existing)) {
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
      'SELECT c.id, c.entity_type, c.entity_id, c.staff_id, c.body, c.created_at, c.updated_at, s.name AS staff_name ' +
        'FROM thread_comments c LEFT JOIN staff s ON c.staff_id = s.id WHERE c.id = ?'
    )
    .bind(commentId)
    .first();
  return opsJson({ comment: updated });
}

async function deleteComment(db, staffAuth, commentId) {
  var existing = await db
    .prepare('SELECT id, staff_id FROM thread_comments WHERE id = ?')
    .bind(commentId)
    .first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  if (!isCommentOwnerOrSelf(staffAuth, existing)) {
    return opsJson({ error: 'forbidden', message: '追記を削除できるのは本人または管理者のみです' }, 403);
  }
  await db.prepare('DELETE FROM thread_comments WHERE id = ?').bind(commentId).run();
  return opsJson({ deleted: true });
}

// bulletin.js / cat-notes.js / health.js から呼ぶヘルパ。
// 指定エンティティタイプ・ID群のコメントをレコードにまとめて添付する。
export async function attachThreadCommentsTo(db, entityType, rows, idField) {
  var key = idField || 'id';
  var list = rows || [];
  if (!list.length) return;
  var ids = [];
  for (var i = 0; i < list.length; i++) {
    var rid = list[i] && list[i][key] != null ? Number(list[i][key]) : NaN;
    if (!isNaN(rid)) ids.push(rid);
  }
  for (var j = 0; j < list.length; j++) list[j].comments = [];
  if (!ids.length) return;

  // D1 のステートメントパラメータ上限（100 前後）対策でチャンク化する。
  // chunk=80 にしておけば、先頭の entity_type 1つと合わせても余裕を持って収まる。
  var D1_COMMENT_CHUNK = 80;
  var out = [];
  for (var ci = 0; ci < ids.length; ci += D1_COMMENT_CHUNK) {
    var chunk = ids.slice(ci, ci + D1_COMMENT_CHUNK);
    var placeholders = chunk.map(function () { return '?'; }).join(',');
    var sql =
      'SELECT c.id, c.entity_type, c.entity_id, c.staff_id, c.body, c.created_at, c.updated_at, s.name AS staff_name ' +
      'FROM thread_comments c LEFT JOIN staff s ON c.staff_id = s.id ' +
      'WHERE c.entity_type = ? AND c.entity_id IN (' + placeholders + ') ' +
      'ORDER BY c.entity_id ASC, c.created_at ASC, c.id ASC';
    var params = [entityType].concat(chunk);
    var stmt = db.prepare(sql);
    stmt = stmt.bind.apply(stmt, params);
    var res = await stmt.all();
    out = out.concat(res.results || []);
  }

  var map = {};
  for (var k = 0; k < out.length; k++) {
    var row = out[k];
    var kk = String(row.entity_id);
    if (!map[kk]) map[kk] = [];
    map[kk].push(row);
  }
  for (var m = 0; m < list.length; m++) {
    var mid = String(list[m][key]);
    list[m].comments = map[mid] || [];
  }
}
