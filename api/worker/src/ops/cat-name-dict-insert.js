/**
 * cat_name_dictionary への挿入 + misrecognition_log との紐づけ（sources テーブル）
 * name-resolver / cats / cat-name-dictionary から利用。name-resolver への依存なし。
 */

/**
 * @param {D1Database} db
 * @param {{
 *   catId: string,
 *   variant: string,
 *   variantType: string,
 *   priority: number,
 *   entrySource: string|null,
 *   misrecognitionLogIds?: number[],
 *   resolveMisrecognition?: { catId: string, attemptedName: string } | null
 * }} opts
 * @returns {Promise<number>} dictionary row id
 */
export async function insertCatNameDictWithSources(db, opts) {
  var logIds = opts.misrecognitionLogIds || [];
  var resolve = opts.resolveMisrecognition;
  var hasResolve = resolve && resolve.catId && resolve.attemptedName != null && String(resolve.attemptedName) !== '';

  if (hasResolve) {
    var stmts = [
      db.prepare(
        'INSERT INTO cat_name_dictionary (cat_id, variant, variant_type, priority, entry_source) VALUES (?, ?, ?, ?, ?) RETURNING id'
      ).bind(
        opts.catId,
        opts.variant,
        opts.variantType,
        opts.priority,
        opts.entrySource != null ? opts.entrySource : null
      ),
    ];
    for (var i = 0; i < logIds.length; i++) {
      var lid = logIds[i];
      if (lid == null || lid === '') continue;
      stmts.push(
        db.prepare(
          'INSERT OR IGNORE INTO cat_name_dictionary_sources (dictionary_id, misrecognition_log_id) ' +
            'SELECT (SELECT MAX(id) FROM cat_name_dictionary), ?'
        ).bind(lid)
      );
    }
    stmts.push(
      db.prepare(
        "UPDATE misrecognition_log SET resolved_cat = ?, auto_added = 1 WHERE attempted_name = ? AND auto_added = 0 AND (failure_type = 'cat_name' OR failure_type IS NULL)"
      ).bind(resolve.catId, resolve.attemptedName)
    );
    var batchRes = await db.batch(stmts);
    var first = batchRes[0];
    var row = first && first.results && first.results[0];
    if (!row || row.id == null) {
      throw new Error('dictionary batch insert: no RETURNING id');
    }
    return row.id;
  }

  var ins = await db.prepare(
    'INSERT INTO cat_name_dictionary (cat_id, variant, variant_type, priority, entry_source) VALUES (?, ?, ?, ?, ?) RETURNING id'
  ).bind(
    opts.catId,
    opts.variant,
    opts.variantType,
    opts.priority,
    opts.entrySource != null ? opts.entrySource : null
  ).first();
  var dictId = ins.id;
  for (var j = 0; j < logIds.length; j++) {
    var lid2 = logIds[j];
    if (lid2 == null || lid2 === '') continue;
    await db.prepare(
      'INSERT OR IGNORE INTO cat_name_dictionary_sources (dictionary_id, misrecognition_log_id) VALUES (?, ?)'
    ).bind(dictId, lid2).run();
  }
  return dictId;
}

/**
 * @returns {Promise<number[]>}
 */
export async function selectPendingMisrecognitionIdsByAttempted(db, attemptedName) {
  var rows = await db.prepare(
    'SELECT id FROM misrecognition_log WHERE attempted_name = ? AND auto_added = 0 ' +
    "AND (failure_type = 'cat_name' OR failure_type IS NULL)"
  ).bind(attemptedName).all();
  var out = [];
  var r = rows.results || [];
  for (var k = 0; k < r.length; k++) {
    if (r[k].id != null) out.push(r[k].id);
  }
  return out;
}
