/**
 * NYAGI DB 自動バックアップ
 * 全テーブルを JSON でエクスポートし R2 に保存する。
 * 30日以上前のバックアップは自動削除。
 */

var BACKUP_PREFIX = 'backups/';
var RETENTION_DAYS = 30;

var TABLES = [
  'cats', 'cat_baselines', 'cat_name_dictionary', 'cat_name_dictionary_sources', 'cat_notes',
  'cat_nutrition_profiles', 'cat_transfers', 'care_type_dictionary',
  'feeding_logs', 'feeding_plans', 'feeding_preset_items', 'feeding_presets',
  'foods', 'health_records', 'health_scores',
  'locations', 'staff',
  'medication_logs', 'medication_preset_items', 'medication_presets', 'medications', 'medicines',
  'action_items', 'anomaly_rules', 'audit_log',
  'bulletin_messages',
  'daily_closures', 'files',
  'misrecognition_log', 'product_name_dictionary',
  'project_nodes', 'projects', 'routing_feedback',
  'task_templates', 'tasks', 'voice_inputs'
];

export async function runBackup(db, r2) {
  var now = new Date();
  var dateStr = now.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/[:.]/g, '-').replace(' ', 'T').slice(0, 19);
  var key = BACKUP_PREFIX + dateStr + '.json';

  var data = {};
  var meta = { created_at: now.toISOString(), tables: {} };
  var errors = [];

  for (var i = 0; i < TABLES.length; i++) {
    var tbl = TABLES[i];
    try {
      var result = await db.prepare('SELECT * FROM ' + tbl).bind().all();
      var rows = result.results || [];
      data[tbl] = rows;
      meta.tables[tbl] = rows.length;
    } catch (e) {
      errors.push(tbl + ': ' + (e && e.message ? e.message : 'unknown'));
      data[tbl] = [];
      meta.tables[tbl] = 0;
    }
  }

  meta.errors = errors;
  meta.total_tables = TABLES.length;
  meta.total_rows = 0;
  for (var t in meta.tables) {
    if (meta.tables.hasOwnProperty(t)) meta.total_rows += meta.tables[t];
  }

  var payload = JSON.stringify({ meta: meta, data: data });

  await r2.put(key, payload, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { created_at: now.toISOString(), rows: String(meta.total_rows) }
  });

  return {
    ok: true,
    key: key,
    size_bytes: payload.length,
    total_rows: meta.total_rows,
    total_tables: TABLES.length,
    errors: errors
  };
}

export async function cleanupOldBackups(r2) {
  var cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
  var deleted = [];

  var list = await r2.list({ prefix: BACKUP_PREFIX, limit: 1000 });
  var objects = list.objects || [];

  for (var i = 0; i < objects.length; i++) {
    var obj = objects[i];
    if (obj.uploaded && obj.uploaded < cutoff) {
      await r2.delete(obj.key);
      deleted.push(obj.key);
    }
  }

  return { deleted_count: deleted.length, deleted: deleted };
}

export async function listBackups(r2) {
  var list = await r2.list({ prefix: BACKUP_PREFIX, limit: 100 });
  var objects = list.objects || [];
  var result = [];

  for (var i = 0; i < objects.length; i++) {
    var obj = objects[i];
    result.push({
      key: obj.key,
      size_bytes: obj.size,
      uploaded: obj.uploaded ? obj.uploaded.toISOString() : null,
      rows: obj.customMetadata ? obj.customMetadata.rows : null
    });
  }

  result.sort(function (a, b) {
    return a.uploaded > b.uploaded ? -1 : a.uploaded < b.uploaded ? 1 : 0;
  });

  return result;
}
