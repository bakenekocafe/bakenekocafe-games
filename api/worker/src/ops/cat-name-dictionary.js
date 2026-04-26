/**
 * 猫名辞書・誤認識ログの管理 API（NYAGI 管理画面用）
 *
 * GET    /api/ops/voice/cat-name-dictionary
 * POST   /api/ops/voice/cat-name-dictionary
 * GET    /api/ops/voice/cat-name-dictionary/:id/sources
 * DELETE /api/ops/voice/cat-name-dictionary/:id
 * POST   /api/ops/voice/cat-name-dictionary/auto-repair
 * GET    /api/ops/voice/misrecognition-log
 * POST   /api/ops/voice/misrecognition-log/promote
 */

import { opsJson } from './router.js';
import { hasPermission } from './auth.js';
import { clearDictCache, autoRepairDictionary } from './name-resolver.js';
import { insertCatNameDictWithSources, selectPendingMisrecognitionIdsByAttempted } from './cat-name-dict-insert.js';

function locFilterForList(url, staffAuth) {
  var q = url.searchParams.get('location');
  if (q === 'all' || q === '') return null;
  if (q) return q;
  return staffAuth.locationId || null;
}

async function verifyCatInScope(db, staffAuth, catId) {
  var row = await db.prepare('SELECT id, location_id, name FROM cats WHERE id = ?').bind(catId).first();
  if (!row) return { ok: false, error: 'cat_not_found' };
  if (
    staffAuth.locationId &&
    row.location_id !== staffAuth.locationId &&
    !hasPermission(staffAuth, 'admin')
  ) {
    return { ok: false, error: 'forbidden_location' };
  }
  return { ok: true, row: row };
}

async function verifyDictRowInScope(db, staffAuth, rowId) {
  var row = await db.prepare(
    'SELECT d.id, d.cat_id, d.variant, c.location_id FROM cat_name_dictionary d ' +
    'JOIN cats c ON c.id = d.cat_id WHERE d.id = ?'
  ).bind(rowId).first();
  if (!row) return { ok: false, error: 'not_found' };
  if (
    staffAuth.locationId &&
    row.location_id !== staffAuth.locationId &&
    !hasPermission(staffAuth, 'admin')
  ) {
    return { ok: false, error: 'forbidden_location' };
  }
  return { ok: true, row: row };
}

async function listDict(db, staffAuth, url) {
  var loc = locFilterForList(url, staffAuth);
  var sql =
    'SELECT d.id, d.cat_id, d.variant, d.variant_type, d.priority, d.created_at, d.entry_source, ' +
    '(SELECT COUNT(*) FROM cat_name_dictionary_sources s WHERE s.dictionary_id = d.id) AS source_count, ' +
    'c.name AS cat_name, c.location_id ' +
    'FROM cat_name_dictionary d ' +
    'JOIN cats c ON c.id = d.cat_id ';
  if (loc) {
    sql += 'WHERE c.location_id = ? ';
    sql += 'ORDER BY c.name, d.priority DESC, d.variant';
    var r = await db.prepare(sql).bind(loc).all();
    return opsJson({ entries: r.results || [] });
  }
  sql += 'ORDER BY c.name, d.priority DESC, d.variant';
  var r2 = await db.prepare(sql).all();
  return opsJson({ entries: r2.results || [] });
}

async function postDict(req, db, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  var catId = body.cat_id;
  var variant = body.variant != null ? String(body.variant).trim() : '';
  if (!catId || !variant) {
    return opsJson({ error: 'bad_request', message: 'cat_id と variant は必須です' }, 400);
  }
  var vchk = await verifyCatInScope(db, staffAuth, catId);
  if (!vchk.ok) {
    return opsJson({ error: vchk.error, message: '猫が見つからないか、拠点が一致しません' }, 403);
  }
  var variantType = body.variant_type ? String(body.variant_type) : 'manual_ui';
  var priority = body.priority != null ? parseInt(body.priority, 10) : 88;
  if (isNaN(priority)) priority = 88;

  var dup = await db.prepare(
    'SELECT id FROM cat_name_dictionary WHERE cat_id = ? AND variant = ?'
  ).bind(catId, variant).first();
  if (dup) {
    return opsJson({ error: 'duplicate', message: '同じ猫に同じ variant が既にあります', id: dup.id }, 409);
  }

  try {
    var newId = await insertCatNameDictWithSources(db, {
      catId: catId,
      variant: variant,
      variantType: variantType,
      priority: priority,
      entrySource: 'manual_ui',
      misrecognitionLogIds: [],
    });
    clearDictCache();
    return opsJson({ ok: true, id: newId }, 201);
  } catch (e) {
    return opsJson({ error: 'db_error', message: e.message || 'insert failed' }, 500);
  }
}

async function deleteDictRow(db, staffAuth, rowId) {
  var v = await verifyDictRowInScope(db, staffAuth, rowId);
  if (!v.ok) return opsJson({ error: v.error }, v.error === 'not_found' ? 404 : 403);
  // マイグレで FK 無しの環境でも孤児 sources が残らないよう先に削除
  await db.prepare('DELETE FROM cat_name_dictionary_sources WHERE dictionary_id = ?').bind(rowId).run();
  await db.prepare('DELETE FROM cat_name_dictionary WHERE id = ?').bind(rowId).run();
  clearDictCache();
  return opsJson({ ok: true });
}

async function listMisrecognition(db, staffAuth, url) {
  var limit = parseInt(url.searchParams.get('limit') || '60', 10);
  if (isNaN(limit) || limit < 1) limit = 60;
  if (limit > 200) limit = 200;

  var rows = await db.prepare(
    'SELECT attempted_name AS token, COUNT(*) AS cnt, MAX(created_at) AS last_at ' +
    'FROM misrecognition_log WHERE attempted_name IS NOT NULL AND TRIM(attempted_name) != \'\' ' +
    'GROUP BY attempted_name ORDER BY cnt DESC, last_at DESC LIMIT ?'
  ).bind(limit).all();

  return opsJson({ aggregates: rows.results || [] });
}

async function promoteDict(req, db, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  var attempted = body.attempted_name != null ? String(body.attempted_name).trim() : '';
  var catId = body.cat_id;
  if (!attempted || !catId) {
    return opsJson({ error: 'bad_request', message: 'attempted_name と cat_id は必須です' }, 400);
  }
  var vchk = await verifyCatInScope(db, staffAuth, catId);
  if (!vchk.ok) {
    return opsJson({ error: vchk.error, message: '猫が見つからないか、拠点が一致しません' }, 403);
  }

  var dup = await db.prepare(
    'SELECT id FROM cat_name_dictionary WHERE cat_id = ? AND variant = ?'
  ).bind(catId, attempted).first();
  if (dup) {
    return opsJson({ error: 'duplicate', message: '既に辞書にあります', id: dup.id }, 409);
  }

  var pri = body.priority != null ? parseInt(body.priority, 10) : 88;
  if (isNaN(pri)) pri = 88;
  var vtype = body.variant_type ? String(body.variant_type) : 'manual_promoted';

  try {
    var pendingIds = await selectPendingMisrecognitionIdsByAttempted(db, attempted);
    var newId = await insertCatNameDictWithSources(db, {
      catId: catId,
      variant: attempted,
      variantType: vtype,
      priority: pri,
      entrySource: 'manual_promoted',
      misrecognitionLogIds: pendingIds,
      resolveMisrecognition: { catId: catId, attemptedName: attempted },
    });
    clearDictCache();
    return opsJson({ ok: true, id: newId }, 201);
  } catch (e) {
    return opsJson({ error: 'db_error', message: e.message || 'promote failed' }, 500);
  }
}

async function getDictSources(db, staffAuth, rowId) {
  var v = await verifyDictRowInScope(db, staffAuth, rowId);
  if (!v.ok) return opsJson({ error: v.error }, v.error === 'not_found' ? 404 : 403);
  var r = await db.prepare(
    'SELECT l.id, l.raw_text, l.attempted_name, l.failure_type, l.resolved_cat, l.auto_added, l.created_at ' +
    'FROM cat_name_dictionary_sources s ' +
    'JOIN misrecognition_log l ON l.id = s.misrecognition_log_id ' +
    'WHERE s.dictionary_id = ? ORDER BY l.created_at DESC'
  ).bind(rowId).all();
  return opsJson({ entries: r.results || [] });
}

async function runAutoRepair(db) {
  var r = await autoRepairDictionary(db);
  clearDictCache();
  return opsJson({ ok: true, repaired: r.repaired });
}

/**
 * @returns {Promise<Response|null>}
 */
export async function handleCatNameDictionaryRoutes(req, env, url, staffAuth, subPath, db) {
  var method = req.method;
  var pathBase = subPath.split('?')[0];

  if (pathBase === '/cat-name-dictionary' || subPath.indexOf('/cat-name-dictionary?') === 0) {
    if (method === 'GET') return listDict(db, staffAuth, url);
    if (method === 'POST') return postDict(req, db, staffAuth);
  }

  var srcM = pathBase.match(/^\/cat-name-dictionary\/(\d+)\/sources$/);
  if (srcM && method === 'GET') {
    return getDictSources(db, staffAuth, parseInt(srcM[1], 10));
  }

  var delM = pathBase.match(/^\/cat-name-dictionary\/(\d+)$/);
  if (delM && method === 'DELETE') {
    return deleteDictRow(db, staffAuth, parseInt(delM[1], 10));
  }

  if (pathBase === '/cat-name-dictionary/auto-repair' && method === 'POST') {
    return runAutoRepair(db);
  }

  if (pathBase === '/misrecognition-log' || subPath.indexOf('/misrecognition-log?') === 0) {
    if (method === 'GET') return listMisrecognition(db, staffAuth, url);
  }

  if (pathBase === '/misrecognition-log/promote' && method === 'POST') {
    return promoteDict(req, db, staffAuth);
  }

  return null;
}
