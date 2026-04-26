/**
 * 朝スロット（朝）／夜スロット（晩）の投薬が当日分すべて記録済みか（タスク完了／スキップガード用）
 */
import { shouldGenerateForDay } from './health.js';
import { jstCalendarAddDays } from './jst-util.js';
import { sqlStatusCondition } from './cat-status.js';

function medGuardSlotTailFromScheduledAt(scheduledAt) {
  var t = String(scheduledAt || '');
  var i = t.indexOf('T');
  if (i === -1) return '';
  return t.slice(i + 1);
}

function medGuardNormSlotLabel(s) {
  if (!s) return '';
  var x = String(s);
  if (x === 'morning' || x === '朝') return '朝';
  if (x === 'afternoon' || x === '昼') return '昼';
  if (x === 'evening' || x === '晩' || x === '夜') return '晩';
  return x;
}

/**
 * @param {string|null} locationId cafe 等。both/all は全拠点集約。
 * @param {string} ymdDate YYYY-MM-DD（タスクの実行日）
 * @param {string|null} statusFilter cats の sqlStatusCondition に渡す（null → in_care）
 * @returns {{ ok: boolean, incomplete: Array, missing_cats: Array, missing_lines: string[] }}
 */
export async function checkMorningMedicationCompleteForGuard(db, locationId, ymdDate, statusFilter) {
  var stCond = sqlStatusCondition(statusFilter || 'in_care', 'c');
  var stCondNoAlias = sqlStatusCondition(statusFilter || 'in_care', '');
  var medSql =
    'SELECT m.id AS medication_id, m.cat_id, m.time_slots, m.frequency, m.start_date, c.name AS cat_name, med.name AS medicine_name ' +
    'FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id ' +
    "WHERE m.active = 1 AND (m.frequency IS NULL OR trim(m.frequency) != '必要時') AND (" +
    stCond +
    ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    medSql += ' AND c.location_id = ?';
  }
  var medStmt = db.prepare(medSql);
  var medRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await medStmt.bind(locationId).all()
      : await medStmt.all();
  var meds = medRes.results || [];
  if (meds.length === 0) {
    return { ok: true, incomplete: [], missing_cats: [], missing_lines: [] };
  }

  var nextDay = jstCalendarAddDays(ymdDate, 1);
  var mlSql =
    'SELECT ml.medication_id, ml.cat_id, ml.scheduled_at, ml.status FROM medication_logs ml ' +
    'INNER JOIN medications m ON ml.medication_id = m.id AND m.active = 1 ' +
    'WHERE ml.scheduled_at >= ? AND ml.scheduled_at < ? AND ml.cat_id IN (SELECT id FROM cats WHERE ' +
    stCondNoAlias +
    ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    mlSql += ' AND ml.cat_id IN (SELECT id FROM cats WHERE location_id = ?)';
  }
  var mlStmt = db.prepare(mlSql);
  var mlRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await mlStmt.bind(ymdDate, nextDay, locationId).all()
      : await mlStmt.bind(ymdDate, nextDay).all();
  var logs = mlRes.results || [];

  var logDone = {};
  for (var li = 0; li < logs.length; li++) {
    var lg = logs[li];
    var st = lg.status || '';
    if (st !== 'done' && st !== 'administered' && st !== 'skipped') continue;
    var tail = medGuardSlotTailFromScheduledAt(lg.scheduled_at);
    var lSlot = medGuardNormSlotLabel(tail);
    logDone[String(lg.medication_id) + '_' + lSlot] = true;
  }

  var incomplete = [];
  for (var mi = 0; mi < meds.length; mi++) {
    var m = meds[mi];
    if (!shouldGenerateForDay(m.frequency || '毎日', ymdDate, m.start_date || ymdDate)) continue;
    var slots = [];
    try {
      slots = JSON.parse(m.time_slots);
    } catch (_) {}
    if (!Array.isArray(slots)) slots = [m.time_slots || '朝'];
    for (var si = 0; si < slots.length; si++) {
      var slotNorm = medGuardNormSlotLabel(slots[si]);
      if (slotNorm !== '朝') continue;
      var key = String(m.medication_id) + '_' + slotNorm;
      if (!logDone[key]) {
        incomplete.push({
          cat_id: m.cat_id,
          cat_name: m.cat_name || '',
          medicine_name: m.medicine_name || '',
        });
      }
    }
  }

  var seen = {};
  var missingCats = [];
  for (var ci = 0; ci < incomplete.length; ci++) {
    var idk = String(incomplete[ci].cat_id);
    if (seen[idk]) continue;
    seen[idk] = true;
    missingCats.push({ cat_id: incomplete[ci].cat_id, cat_name: incomplete[ci].cat_name });
  }
  missingCats.sort(function (a, b) {
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });

  var lines = [];
  for (var ii = 0; ii < incomplete.length; ii++) {
    var row = incomplete[ii];
    lines.push(String(row.cat_name || '（名前なし）') + ': ' + String(row.medicine_name || 'お薬'));
  }
  lines.sort(function (a, b) {
    return a.localeCompare(b, 'ja');
  });

  return {
    ok: incomplete.length === 0,
    incomplete: incomplete,
    missing_cats: missingCats,
    missing_lines: lines,
  };
}

/**
 * 夜スロット（晩）の投薬が当日分すべて記録済みか（ホール夜タスクの完了／スキップガード用）
 * @param {string|null} locationId
 * @param {string} ymdDate YYYY-MM-DD
 * @param {string|null} statusFilter
 * @returns {{ ok: boolean, incomplete: Array, missing_cats: Array, missing_lines: string[] }}
 */
export async function checkEveningMedicationCompleteForGuard(db, locationId, ymdDate, statusFilter) {
  var stCond = sqlStatusCondition(statusFilter || 'in_care', 'c');
  var stCondNoAlias = sqlStatusCondition(statusFilter || 'in_care', '');
  var medSql =
    'SELECT m.id AS medication_id, m.cat_id, m.time_slots, m.frequency, m.start_date, c.name AS cat_name, med.name AS medicine_name ' +
    'FROM medications m JOIN cats c ON m.cat_id = c.id JOIN medicines med ON m.medicine_id = med.id ' +
    "WHERE m.active = 1 AND (m.frequency IS NULL OR trim(m.frequency) != '必要時') AND (" +
    stCond +
    ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    medSql += ' AND c.location_id = ?';
  }
  var medStmt = db.prepare(medSql);
  var medRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await medStmt.bind(locationId).all()
      : await medStmt.all();
  var meds = medRes.results || [];
  if (meds.length === 0) {
    return { ok: true, incomplete: [], missing_cats: [], missing_lines: [] };
  }

  var nextDay = jstCalendarAddDays(ymdDate, 1);
  var mlSql =
    'SELECT ml.medication_id, ml.cat_id, ml.scheduled_at, ml.status FROM medication_logs ml ' +
    'INNER JOIN medications m ON ml.medication_id = m.id AND m.active = 1 ' +
    'WHERE ml.scheduled_at >= ? AND ml.scheduled_at < ? AND ml.cat_id IN (SELECT id FROM cats WHERE ' +
    stCondNoAlias +
    ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    mlSql += ' AND ml.cat_id IN (SELECT id FROM cats WHERE location_id = ?)';
  }
  var mlStmt = db.prepare(mlSql);
  var mlRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await mlStmt.bind(ymdDate, nextDay, locationId).all()
      : await mlStmt.bind(ymdDate, nextDay).all();
  var logs = mlRes.results || [];

  var logDone = {};
  for (var li = 0; li < logs.length; li++) {
    var lg = logs[li];
    var st = lg.status || '';
    if (st !== 'done' && st !== 'administered' && st !== 'skipped') continue;
    var tail = medGuardSlotTailFromScheduledAt(lg.scheduled_at);
    var lSlot = medGuardNormSlotLabel(tail);
    logDone[String(lg.medication_id) + '_' + lSlot] = true;
  }

  var incomplete = [];
  for (var mi = 0; mi < meds.length; mi++) {
    var m = meds[mi];
    if (!shouldGenerateForDay(m.frequency || '毎日', ymdDate, m.start_date || ymdDate)) continue;
    var slots = [];
    try {
      slots = JSON.parse(m.time_slots);
    } catch (_) {}
    if (!Array.isArray(slots)) slots = [m.time_slots || '朝'];
    for (var si = 0; si < slots.length; si++) {
      var slotNorm = medGuardNormSlotLabel(slots[si]);
      if (slotNorm !== '晩') continue;
      var key = String(m.medication_id) + '_' + slotNorm;
      if (!logDone[key]) {
        incomplete.push({
          cat_id: m.cat_id,
          cat_name: m.cat_name || '',
          medicine_name: m.medicine_name || '',
        });
      }
    }
  }

  var seen = {};
  var missingCats = [];
  for (var ci = 0; ci < incomplete.length; ci++) {
    var idk = String(incomplete[ci].cat_id);
    if (seen[idk]) continue;
    seen[idk] = true;
    missingCats.push({ cat_id: incomplete[ci].cat_id, cat_name: incomplete[ci].cat_name });
  }
  missingCats.sort(function (a, b) {
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });

  var lines = [];
  for (var ii = 0; ii < incomplete.length; ii++) {
    var row = incomplete[ii];
    lines.push(String(row.cat_name || '（名前なし）') + ': ' + String(row.medicine_name || 'お薬'));
  }
  lines.sort(function (a, b) {
    return a.localeCompare(b, 'ja');
  });

  return {
    ok: incomplete.length === 0,
    incomplete: incomplete,
    missing_cats: missingCats,
    missing_lines: lines,
  };
}
