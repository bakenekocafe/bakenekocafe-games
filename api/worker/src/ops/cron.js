/**
 * NYAGI Cron ジョブ
 *
 * UTC 20:00（JST 05:00）: 献立リセット後、プリセット全面入替（全拠点）→ JST 前日の routine pending を自動スキップ → テンプレから JST 当日分を生成、投薬ログ・プリセット穴埋め等
 * UTC 23:00（JST 08:00）に実行:
 *   4a: （朝ジョブ側で実行されることあり）投薬ログ自動生成
 *   4b: ワクチン/健康診断期限チェック → action_items 自動登録
 *   4c: alert_until 期限切れ猫の alert_level を normal に戻す
 *   5a: タスクテンプレートから当日タスクを自動生成（JST 暦・P5）
 *   5b: 健康スコアを日次算出・急落アラート（P5）
 */

import { calculateHealthScore } from './health-score.js';
import { sendSlackMessage } from './slack-notify.js';
import { generateAllMedLogsForDate, reapplyMedicationPresetsForLocation, generateLogsForDay } from './health.js';
import {
  reapplyFeedingPresets,
  jstNowIsoTimestamp,
  insertTaskFromTemplateRow,
  jstCalendarYmdFromInstant,
  jstCalendarAddDays,
  jstWeekdaySUN0,
  filterTaskRowsByTemplateRecurrence,
} from './tasks.js';
import { sqlStatusInCare } from './cat-status.js';

/**
 * UTC 20:00（JST 05:00）のテンプレ一括生成の直前に実行。
 * JST の「昨日」締めの pending routine を自動スキップし、当日の新規生成と二重表示しない。
 * monitoring / プロジェクト紐づけは除外。
 */
export async function autoSkipJstYesterdayRoutinePendingTasks(db) {
  var jstToday = jstCalendarYmdFromInstant(Date.now());
  var jstYesterday = jstCalendarAddDays(jstToday, -1);
  var now = jstNowIsoTimestamp();
  var reason = '自動スキップ（JST前日締め・朝一括生成前）';

  var result = await db.prepare(
    "UPDATE tasks SET status = 'skipped', skip_reason = ?, completed_by = 'system', completed_at = ?, skip_streak = COALESCE(skip_streak, 0) + 1 WHERE COALESCE(scheduled_date, deadline_date, due_date) = ? AND status = 'pending' AND (task_type IS NULL OR task_type = 'routine') AND project_node_id IS NULL"
  ).bind(reason, now, jstYesterday).run();

  var n = result.meta && result.meta.changes !== undefined ? result.meta.changes : 0;
  console.log('autoSkipJstYesterdayRoutinePendingTasks: jstYesterday=' + jstYesterday + ' skipped=' + n);
  return n;
}

/**
 * 4a: 毎朝、active な medications の当日分 medication_logs を生成
 */
export async function generateDailyMedicationLogs(db) {
  var today = jstCalendarYmdFromInstant(Date.now());
  var meds = await db.prepare(
    "SELECT * FROM medications WHERE active = 1 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)"
  ).bind(today, today).all();

  var count = 0;
  for (var i = 0; i < (meds.results || []).length; i++) {
    var med = meds.results[i];
    var slots = [];
    try { slots = JSON.parse(med.time_slots || '["朝"]'); } catch (_) { slots = ['朝']; }
    if (!Array.isArray(slots) || slots.length === 0) slots = ['朝'];

    var frequency = med.frequency || '毎日';
    if (!shouldRunOnDate(frequency, today, med.start_date)) continue;

    for (var j = 0; j < slots.length; j++) {
      var scheduledAt = today + 'T' + slots[j];
      var exists = await db.prepare(
        'SELECT id FROM medication_logs WHERE medication_id = ? AND scheduled_at = ?'
      ).bind(med.id, scheduledAt).first();
      if (!exists) {
        await db.prepare(
          'INSERT INTO medication_logs (medication_id, cat_id, scheduled_at, status) VALUES (?, ?, ?, ?)'
        ).bind(med.id, med.cat_id, scheduledAt, 'pending').run();
        count++;
      }
    }
  }

  console.log('generateDailyMedicationLogs: created ' + count + ' logs for ' + today);
  return count;
}

/**
 * 4b: 1ヶ月以内にワクチン/健康診断の期限が来る猫を検索して action_items に登録
 *     CatHealthCheck.gs の置き換え
 */
export async function checkVaccineDue(db, env) {
  var today = jstCalendarYmdFromInstant(Date.now());
  var oneMonthLater = jstCalendarAddDays(today, 30);

  var dueRecords = await db.prepare(
    "SELECT hr.*, c.name AS cat_name, c.location_id FROM health_records hr JOIN cats c ON hr.cat_id = c.id WHERE hr.record_type IN ('vaccine', 'checkup') AND hr.next_due IS NOT NULL AND hr.next_due <= ? AND hr.next_due >= ? AND " + sqlStatusInCare('c')
  ).bind(oneMonthLater, today).all();

  var count = 0;
  for (var i = 0; i < (dueRecords.results || []).length; i++) {
    var rec = dueRecords.results[i];
    var existingAction = await db.prepare(
      "SELECT id FROM action_items WHERE cat_id = ? AND source_module = 'vaccine_due' AND status = 'open'"
    ).bind(rec.cat_id).first();

    if (!existingAction) {
      var title = rec.cat_name + ': ' + (rec.record_type === 'vaccine' ? 'ワクチン' : '健康診断') + '（' + rec.next_due + '）';
      await db.prepare(
        'INSERT INTO action_items (source_module, source_id, cat_id, location_id, title, priority, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind('vaccine_due', String(rec.id), rec.cat_id, rec.location_id, title, 'normal', rec.next_due, 'open', 'system').run();
      count++;
    }
  }

  console.log('checkVaccineDue: created ' + count + ' action_items');
  return count;
}

/**
 * 5a: タスクテンプレートから当日タスクを自動生成（due_date・曜日は JST 暦）
 *     繰越タスク（carried_from_id != NULL）がすでに存在する場合はスキップ
 */
export async function generateDailyTasks(db) {
  var today = jstCalendarYmdFromInstant(Date.now());
  var dow = jstWeekdaySUN0(today);

  var templates = await db.prepare(
    'SELECT * FROM task_templates WHERE active = 1'
  ).bind().all();

  var count = 0;
  var skippedCarried = 0;
  var onceIds = [];
  for (var i = 0; i < (templates.results || []).length; i++) {
    var tmpl = templates.results[i];
    if (!shouldGenerateToday(tmpl.recurrence, today, dow)) continue;

    var exists = await db.prepare(
      'SELECT id, carried_from_id FROM tasks WHERE template_id = ? AND COALESCE(scheduled_date, deadline_date, due_date) = ?'
    ).bind(tmpl.id, today).first();
    if (exists) {
      if (exists.carried_from_id) skippedCarried++;
      continue;
    }

    await insertTaskFromTemplateRow(db, tmpl, today);
    count++;

    if (tmpl.recurrence === 'once') onceIds.push(tmpl.id);
  }

  for (var j = 0; j < onceIds.length; j++) {
    await db.prepare('UPDATE task_templates SET active = 0 WHERE id = ?').bind(onceIds[j]).run();
  }

  console.log('generateDailyTasks: created ' + count + ' tasks for ' + today + (skippedCarried ? ', skipped ' + skippedCarried + ' (carried over)' : '') + (onceIds.length ? ', deactivated ' + onceIds.length + ' once-templates' : ''));
  return count;
}

/**
 * 5c: 業務未終了フォールバック（深夜0時 JST）
 *     前日の未クローズ拠点の未完了タスクを自動スキップ+繰越
 */
export async function autoClosePendingDays(db, env) {
  var today = jstCalendarYmdFromInstant(Date.now());
  var yesterday = jstCalendarAddDays(today, -1);
  var locations = ['cafe', 'nekomata'];
  var totalCarried = 0;

  for (var loc = 0; loc < locations.length; loc++) {
    var locationId = locations[loc];
    var closed = await db.prepare(
      'SELECT id FROM daily_closures WHERE location_id = ? AND closed_date = ?'
    ).bind(locationId, yesterday).first();
    if (closed) continue;

    var pending = await db.prepare(
      "SELECT * FROM tasks WHERE location_id = ? AND COALESCE(scheduled_date, deadline_date, due_date) = ? AND status = 'pending' AND COALESCE(task_type, 'routine') != 'event'"
    ).bind(locationId, yesterday).all();
    var pendingTasks = await filterTaskRowsByTemplateRecurrence(db, pending.results || [], yesterday);

    var now = jstNowIsoTimestamp();
    var carried = 0;
    for (var i = 0; i < pendingTasks.length; i++) {
      var task = pendingTasks[i];
      var streak = (task.skip_streak || 0) + 1;

      await db.prepare(
        "UPDATE tasks SET status = 'skipped', skip_reason = '自動スキップ（業務終了未実行）', completed_by = 'system', completed_at = ?, skip_streak = ? WHERE id = ?"
      ).bind(now, streak, task.id).run();

      var dupCheck = await db.prepare(
        'SELECT id FROM tasks WHERE template_id = ? AND COALESCE(scheduled_date, deadline_date, due_date) = ?'
      ).bind(task.template_id, today).first();
      if (task.template_id && dupCheck) continue;

      var acExpires = (task.task_type || 'routine') === 'monitoring' && task.expires_at ? task.expires_at : null;
      var cSched = null;
      var cDead = task.deadline_date || null;
      var cList = today;
      if ((task.task_type || 'routine') === 'event') {
        cSched = task.scheduled_date || null;
        cDead = task.deadline_date || task.due_date || null;
        cList = cSched || cDead || today;
      } else {
        cSched = today;
      }
      await db.prepare(
        'INSERT INTO tasks (template_id, location_id, title, attribute, cat_id, assigned_to, due_date, scheduled_date, deadline_date, due_time, priority, sort_order, task_type, skip_streak, carried_from_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        task.template_id, task.location_id, task.title, task.attribute,
        task.cat_id, task.assigned_to, cList, cSched, cDead, task.due_time,
        task.priority, task.sort_order || 0, task.task_type || 'routine',
        streak, task.id,
        acExpires
      ).run();
      carried++;
    }

    await db.prepare(
      'INSERT INTO daily_closures (location_id, closed_date, closed_by, special_notes) VALUES (?, ?, ?, ?)'
    ).bind(locationId, yesterday, 'system', '自動クローズ（業務終了ボタン未押下）').run();

    // 当日分の投薬ログも生成
    try {
      await generateAllMedLogsForDate(db, today, locationId);
    } catch (e) {
      console.warn('autoClose med logs error:', e && e.message);
    }

    // プリセット紐づけ猫の給餌プラン再生成
    try {
      var presetResult = await reapplyFeedingPresets(db, locationId);
      if (presetResult.applied > 0) {
        console.log('autoClose presets: ' + locationId + ' — applied ' + presetResult.applied);
      }
    } catch (e) {
      console.warn('autoClose preset reapply error:', e && e.message);
    }

    totalCarried += carried;
    console.log('autoClosePendingDays: ' + locationId + ' — skipped ' + pendingTasks.length + ', carried ' + carried);
  }

  return totalCarried;
}

function shouldRunOnDate(frequency, date, startDate) {
  if (!frequency || frequency === '毎日' || frequency === '1日1回' || frequency === '1日2回' || frequency === '1日3回') return true;
  if (frequency === '必要時') return false;

  var y = parseInt(date.slice(0, 4), 10);
  var mo = parseInt(date.slice(5, 7), 10);
  var dom = parseInt(date.slice(8, 10), 10);
  var dowJst = jstWeekdaySUN0(date);

  if (frequency === '月末のみ') {
    var lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return dom === lastDay;
  }

  if (frequency.indexOf('週:') === 0) {
    var DOW_MAP = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
    var days = frequency.slice(2).split(',');
    for (var wi = 0; wi < days.length; wi++) {
      if (DOW_MAP[days[wi].trim()] === dowJst) return true;
    }
    return false;
  }

  if (frequency.indexOf('月1:') === 0) {
    var dayPart = frequency.slice(3);
    if (dayPart === '末日') {
      var lastDay2 = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      return dom === lastDay2;
    }
    var dayOfMonth = parseInt(dayPart, 10);
    if (isNaN(dayOfMonth)) return false;
    var monthLastDay2 = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return dom === Math.min(dayOfMonth, monthLastDay2);
  }

  var t0 = new Date((startDate || date) + 'T12:00:00+09:00').getTime();
  var t1 = new Date(date + 'T12:00:00+09:00').getTime();
  var daysBetween = Math.round((t1 - t0) / 86400000);
  if (daysBetween < 0) return false;
  if (frequency === '隔日' || frequency === '隔日(A)') return daysBetween % 2 === 0;
  if (frequency === '隔日(B)') return daysBetween % 2 === 1;
  if (frequency === '2日に1回') return daysBetween % 2 === 0;
  if (frequency === '3日に1回') return daysBetween % 3 === 0;
  if (frequency === '週1回') return daysBetween % 7 === 0;
  if (frequency === '週3回') {
    return dowJst === 1 || dowJst === 3 || dowJst === 5;
  }
  return true;
}

function shouldGenerateToday(recurrence, today, dow) {
  if (recurrence === 'daily') return true;
  if (recurrence === 'once') return true;
  if (recurrence.indexOf('weekly:') === 0) {
    var days = recurrence.replace('weekly:', '').split(',').map(Number);
    return days.indexOf(dow) !== -1;
  }
  if (recurrence.indexOf('monthly:') === 0) {
    var dayOfMonth = parseInt(today.slice(8, 10), 10);
    var monthDays = recurrence.replace('monthly:', '').split(',').map(Number);
    return monthDays.indexOf(dayOfMonth) !== -1;
  }
  return false;
}

/**
 * 5b: 健康スコアを日次算出し、急落時は Slack 通知
 */
export async function calculateDailyScores(db, env) {
  var today = jstCalendarYmdFromInstant(Date.now());
  var yesterday = jstCalendarAddDays(today, -1);

  var cats = await db.prepare(
    "SELECT id, name FROM cats WHERE " + sqlStatusInCare()
  ).bind().all();

  var count = 0;
  for (var i = 0; i < (cats.results || []).length; i++) {
    var catId = cats.results[i].id;
    var catName = cats.results[i].name;

    var score = await calculateHealthScore(db, catId, today);

    await db.prepare(
      'INSERT OR REPLACE INTO health_scores (cat_id, score_date, total_score, weight_score, appetite_score, vomit_score, medication_score, vet_score, behavior_score, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(catId, today, score.total_score, score.weight_score, score.appetite_score, score.vomit_score || null, score.medication_score, score.vet_score, score.behavior_score, JSON.stringify(score)).run();

    // 急落チェック: 前日比 -15pt 以上
    var prevScore = await db.prepare(
      'SELECT total_score FROM health_scores WHERE cat_id = ? AND score_date = ?'
    ).bind(catId, yesterday).first();

    if (prevScore && (prevScore.total_score - score.total_score) >= 15) {
      var alertChannel = (env && env.SLACK_ALERT_CHANNEL) ? env.SLACK_ALERT_CHANNEL : '';
      var reasons = [];
      if (score.comments) {
        for (var ci = 0; ci < score.comments.length; ci++) {
          var c = score.comments[ci];
          if (c && c.reason) reasons.push(c.area + ': ' + c.reason);
        }
      }
      var reasonText = reasons.length > 0 ? '\n' + reasons.join('\n') : '';
      var msg = '⚠ ' + catName + ' の健康スコアが ' + prevScore.total_score + ' → ' + score.total_score + ' に急落' + reasonText;
      if (env) await sendSlackMessage(env, alertChannel, msg);
    }

    count++;
  }

  console.log('calculateDailyScores: scored ' + count + ' cats for ' + today);
  return count;
}

/**
 * 4c: alert_until が過ぎた猫の alert_level を normal に戻す
 */
export async function resetExpiredAlerts(db) {
  var today = jstCalendarYmdFromInstant(Date.now());
  var result = await db.prepare(
    "UPDATE cats SET alert_level = 'normal', alert_reason = NULL, alert_until = NULL, alert_set_by = NULL, updated_at = datetime('now') WHERE alert_level != 'normal' AND alert_until IS NOT NULL AND alert_until < ?"
  ).bind(today).run();

  var changed = result.meta && result.meta.changes !== undefined ? result.meta.changes : 0;
  console.log('resetExpiredAlerts: reset ' + changed + ' cats');
  return changed;
}

/**
 * JST 日付切替後: 献立のうち「プリセット適用で作った行」以外を無効化する。
 * - plan_type が 'preset' でない行（手動追加・デフォルト staff 等）は翌日には表示されない。
 * - plan_type='preset' でも、猫の assigned_preset_id と preset_id が一致しない行は無効化（プリセット切替後の残り）。
 * - 紐づけプリセット未設定の猫に残った plan_type='preset' 行も無効化。
 * feeding_logs は参照用に残る（plan_id は履歴のまま）。
 */
export async function expireNonPresetFeedingPlans(db) {
  var r1 = await db.prepare(
    "UPDATE feeding_plans SET active = 0, updated_at = datetime('now') WHERE active = 1 AND (plan_type IS NULL OR plan_type != 'preset')"
  ).run();
  var n1 = r1.meta && r1.meta.changes !== undefined ? r1.meta.changes : 0;

  var r2 = await db.prepare(
    "UPDATE feeding_plans SET active = 0, updated_at = datetime('now') WHERE active = 1 AND plan_type = 'preset' AND preset_id IS NOT NULL AND EXISTS (SELECT 1 FROM cats c WHERE c.id = feeding_plans.cat_id AND c.assigned_preset_id IS NOT NULL AND feeding_plans.preset_id != c.assigned_preset_id)"
  ).run();
  var n2 = r2.meta && r2.meta.changes !== undefined ? r2.meta.changes : 0;

  var r3 = await db.prepare(
    "UPDATE feeding_plans SET active = 0, updated_at = datetime('now') WHERE active = 1 AND plan_type = 'preset' AND EXISTS (SELECT 1 FROM cats c WHERE c.id = feeding_plans.cat_id AND c.assigned_preset_id IS NULL)"
  ).run();
  var n3 = r3.meta && r3.meta.changes !== undefined ? r3.meta.changes : 0;

  console.log('expireNonPresetFeedingPlans: non_preset=' + n1 + ', preset_id_mismatch=' + n2 + ', preset_orphan=' + n3);
  return { non_preset: n1, preset_id_mismatch: n2, preset_orphan: n3 };
}

var NYAGI_PRESET_REAPPLY_LOCATIONS = ['cafe', 'nekomata', 'endo', 'azukari'];

/**
 * 拠点ごとに reapplyFeedingPresets（業務終了・close-day と同じ献立全面入替）。
 * 朝 JST 05:00 ジョブと POST /api/ops/run-cron から実行する。
 */
export async function reapplyFeedingPresetsAllLocations(db) {
  var total = 0;
  var details = [];
  for (var i = 0; i < NYAGI_PRESET_REAPPLY_LOCATIONS.length; i++) {
    var lid = NYAGI_PRESET_REAPPLY_LOCATIONS[i];
    try {
      var r = await reapplyFeedingPresets(db, lid);
      var n = r && r.applied != null ? r.applied : 0;
      total += n;
      details.push(lid + ':' + n);
    } catch (e) {
      console.warn('reapplyFeedingPresetsAllLocations ' + lid + ':', e && e.message);
      details.push(lid + ':err');
    }
  }
  console.log('reapplyFeedingPresetsAllLocations: total=' + total + ' (' + details.join(', ') + ')');
  return { applied: total, by_location: details };
}

// ── 投薬プリセット: 日次リセット＋再適用（フードと同型） ────────────────────

/**
 * JST 日付切替後: 投薬プリセットまわりの整合（フードの expire + 再適用の前処理に相当）。
 * - 投薬プリセット割当がある猫の「純手動」（plan_type≠preset かつ preset_item_id 無し）のみ終了。プリセット「1件追加」(staff+preset_item_id) は残す。
 * - plan_type='preset' で preset_id が猫の assigned_medication_preset_id と不一致 → 終了
 * - 猫の assigned_medication_preset_id が NULL なのにプリセット行が残っている → 終了
 */
export async function expireOrphanMedicationPresetRows(db) {
  var today = jstCalendarYmdFromInstant(Date.now());
  var r0 = await db.prepare(
    "UPDATE medications SET active = 0, end_date = COALESCE(end_date, ?), updated_at = datetime('now') WHERE active = 1 AND COALESCE(plan_type, 'staff') != 'preset' AND (medications.preset_item_id IS NULL) AND EXISTS (SELECT 1 FROM cats c WHERE c.id = medications.cat_id AND c.assigned_medication_preset_id IS NOT NULL)"
  ).bind(today).run();
  var n0 = r0.meta && r0.meta.changes !== undefined ? r0.meta.changes : 0;

  var r1 = await db.prepare(
    "UPDATE medications SET active = 0, end_date = COALESCE(end_date, ?), updated_at = datetime('now') WHERE active = 1 AND plan_type = 'preset' AND preset_id IS NOT NULL AND EXISTS (SELECT 1 FROM cats c WHERE c.id = medications.cat_id AND c.assigned_medication_preset_id IS NOT NULL AND medications.preset_id != c.assigned_medication_preset_id)"
  ).bind(today).run();
  var n1 = r1.meta && r1.meta.changes !== undefined ? r1.meta.changes : 0;

  var r2 = await db.prepare(
    "UPDATE medications SET active = 0, end_date = COALESCE(end_date, ?), updated_at = datetime('now') WHERE active = 1 AND plan_type = 'preset' AND EXISTS (SELECT 1 FROM cats c WHERE c.id = medications.cat_id AND c.assigned_medication_preset_id IS NULL)"
  ).bind(today).run();
  var n2 = r2.meta && r2.meta.changes !== undefined ? r2.meta.changes : 0;

  console.log('expireOrphanMedicationPresetRows: non_preset_on_assigned=' + n0 + ', mismatch=' + n1 + ', orphan=' + n2);
  return { non_preset_on_assigned: n0, mismatch: n1, orphan: n2 };
}

/**
 * 拠点ごとに投薬プリセット再適用。assigned_medication_preset_id がある猫の
 * プリセット由来行を有効メニューで入れ替える（フード reapplyFeedingPresetsAllLocations と同型）。
 */
export async function reapplyMedicationPresetsAllLocations(db) {
  var total = 0;
  var details = [];
  for (var i = 0; i < NYAGI_PRESET_REAPPLY_LOCATIONS.length; i++) {
    var lid = NYAGI_PRESET_REAPPLY_LOCATIONS[i];
    try {
      var r = await reapplyMedicationPresets(db, lid);
      var n = r && r.applied != null ? r.applied : 0;
      total += n;
      details.push(lid + ':' + n);
    } catch (e) {
      console.warn('reapplyMedicationPresetsAllLocations ' + lid + ':', e && e.message);
      details.push(lid + ':err');
    }
  }
  console.log('reapplyMedicationPresetsAllLocations: total=' + total + ' (' + details.join(', ') + ')');
  return { applied: total, by_location: details };
}

/**
 * 投薬プリセット再適用（1拠点）。ロジックは health.js に委譲。
 */
export async function reapplyMedicationPresets(db, locationId) {
  return reapplyMedicationPresetsForLocation(db, locationId);
}

/**
 * 投薬プリセット穴埋め（毎朝フォールバック）
 * assigned_medication_preset_id がある && active のプリセット行 0 件 → 再生成
 */
export async function ensureMedicationPresets(db) {
  var cats = await db.prepare(
    "SELECT id, assigned_medication_preset_id FROM cats WHERE " + sqlStatusInCare() + " AND assigned_medication_preset_id IS NOT NULL"
  ).bind().all();
  var catRows = cats.results || [];
  var applied = 0;
  var today = jstCalendarYmdFromInstant(Date.now());

  for (var c = 0; c < catRows.length; c++) {
    var cat = catRows[c];
    var cnt = await db.prepare(
      "SELECT COUNT(*) AS n FROM medications WHERE cat_id = ? AND active = 1 AND plan_type = 'preset'"
    ).bind(cat.id).first();
    if (cnt && cnt.n > 0) continue;

    var presetItems = await db.prepare(
      "SELECT * FROM medication_preset_items WHERE preset_id = ? AND COALESCE(menu_active, 1) = 1 ORDER BY sort_order, id"
    ).bind(cat.assigned_medication_preset_id).all();
    var items = presetItems.results || [];
    if (items.length === 0) continue;

    /** 穴埋め時も献立同型: 手動のみ残っている場合は捨ててからプリセット行だけ載せる */
    await db.prepare(
      "UPDATE medications SET active = 0, end_date = COALESCE(end_date, ?), updated_at = datetime('now') WHERE cat_id = ? AND active = 1"
    ).bind(today, cat.id).run();

    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var ts = it.time_slots || '["朝","晩"]';
      if (typeof ts !== 'string') ts = JSON.stringify(ts);

      var freqEns = it.frequency || '毎日';
      var startDateEns = today;
      var isPeriodicEns = freqEns !== '毎日' && freqEns !== '必要時' &&
        freqEns !== '1日2回' && freqEns !== '1日3回' &&
        freqEns.indexOf('週:') !== 0;
      if (isPeriodicEns) {
        var prevRowEns = await db.prepare(
          "SELECT start_date FROM medications WHERE cat_id = ? AND medicine_id = ? ORDER BY id ASC LIMIT 1"
        ).bind(cat.id, it.medicine_id).first();
        if (prevRowEns && prevRowEns.start_date) startDateEns = prevRowEns.start_date;
      }

      var insEns = await db.prepare(
        "INSERT INTO medications (cat_id, medicine_id, dosage_amount, dosage_unit, frequency, time_slots, with_food, route, start_date, notes, active, plan_type, preset_id, preset_item_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, 'preset', ?, ?)"
      ).bind(cat.id, it.medicine_id, it.dosage_amount, it.dosage_unit, freqEns, ts, it.route || null, startDateEns, it.notes || null, cat.assigned_medication_preset_id, it.id).run();
      var medIdEns = insEns.meta && insEns.meta.last_row_id != null ? insEns.meta.last_row_id : null;
      if (medIdEns != null) {
        var slotsEns = [];
        try { slotsEns = JSON.parse(ts); } catch (_) { slotsEns = ['朝', '晩']; }
        if (!Array.isArray(slotsEns) || slotsEns.length === 0) slotsEns = ['朝', '晩'];
        await generateLogsForDay(db, medIdEns, cat.id, today, slotsEns, freqEns, startDateEns);
      }
    }
    applied++;
    console.log('ensureMedicationPresets: applied preset ' + cat.assigned_medication_preset_id + ' to cat ' + cat.id);
  }

  return applied;
}

/**
 * 給餌プリセット再適用（毎朝フォールバック）
 * プラン未生成の猫（assigned_preset_id あり && active プラン 0 件）にプリセットを再適用
 */
export async function ensureFeedingPresets(db) {
  var cats = await db.prepare(
    "SELECT id, assigned_preset_id, location_id FROM cats WHERE " + sqlStatusInCare() + " AND assigned_preset_id IS NOT NULL"
  ).bind().all();
  var catRows = cats.results || [];
  var applied = 0;

  for (var c = 0; c < catRows.length; c++) {
    var cat = catRows[c];
    var planCount = await db.prepare(
      'SELECT COUNT(*) AS cnt FROM feeding_plans WHERE cat_id = ? AND active = 1'
    ).bind(cat.id).first();
    if (planCount && planCount.cnt > 0) continue;

    var presetItems = await db.prepare(
      'SELECT pi.*, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.preset_id = ? ORDER BY pi.sort_order'
    ).bind(cat.assigned_preset_id).all();
    var items = presetItems.results || [];
    if (items.length === 0) continue;

    for (var j = 0; j < items.length; j++) {
      var pi = items[j];
      var kcal = pi.amount_g * pi.kcal_per_100g / 100;
      await db.prepare(
        "INSERT INTO feeding_plans (cat_id, food_id, meal_slot, amount_g, kcal_calc, notes, active, plan_type, preset_id, scheduled_time, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'preset', ?, ?, datetime('now'))"
      ).bind(cat.id, pi.food_id, pi.meal_slot, pi.amount_g, kcal, pi.notes || null, cat.assigned_preset_id, pi.scheduled_time || null).run();
    }
    applied++;
    console.log('ensureFeedingPresets: applied preset ' + cat.assigned_preset_id + ' to cat ' + cat.id);
  }

  return applied;
}
