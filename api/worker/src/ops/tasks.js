/**
 * NYAGI タスク管理ハンドラ（P6: 属性化 + プロジェクト）
 *
 * GET  /tasks/templates                           テンプレート一覧
 * POST /tasks/templates                           テンプレート作成
 * GET  /tasks/templates/:id                       テンプレート詳細
 * PUT  /tasks/templates/:id                       テンプレート更新
 * DELETE /tasks/templates/:id                     テンプレート削除
 * GET  /tasks/care-field-pending?location=&cat_id= 前日JSTのケア項目穴（業務終了Slackのケア実施と同ロジック）
 * GET  /tasks?date=&status=&group_by=attribute     タスク一覧
 * POST /tasks                                     アドホックタスク作成
 * POST /tasks/:id/done                            タスク完了
 * POST /tasks/:id/skip                            タスクスキップ
 * POST /tasks/:id/undo                            完了取り消し
 * PUT  /tasks/:id/assign                          タスク割当変更
 * PUT  /tasks/:id/note                            タスクメモ追記
 * PUT  /tasks/:id/status                          監視タスクのステータス変更（pending/done/skipped）
 * PUT  /tasks/:id                                 部分更新（cat_id のみ。猫の紐付け変更）
 * GET  /projects                                  プロジェクト一覧
 * POST /projects                                  プロジェクト作成
 * GET  /projects/:id                              プロジェクト詳細（ツリー）
 * PUT  /projects/:id                              プロジェクト更新
 * POST /projects/:id/nodes                        ノード追加
 * PUT  /projects/:id/nodes/:nodeId                ノード更新
 * DELETE /projects/:id/nodes/:nodeId              ノード削除
 */

import { opsJson } from './router.js';
import { sendSlackMessage, resolveNyagiReportSlackChannel } from './slack-notify.js';
import { generateAllMedLogsForDate, reapplyMedicationPresetsForLocation } from './health.js';
import { checkMorningMedicationCompleteForGuard, checkEveningMedicationCompleteForGuard } from './medication-morning-pending.js';
import { checkMorningFeedingCompleteForGuard, checkEveningFeedingCompleteForGuard } from './morning-feeding-pending.js';
import { checkHallWaterMeasurementCompleteForGuard } from './water-measurement-pending.js';
import {
  summarizeCloseDayReportForLlm,
  fetchCloseDayKohadaCommentary,
  isCloseDayLlmEnabled,
} from './close-day-llm.js';
import { replaceCatFeedingPlansFromActivePreset } from './feeding.js';
import { calculateHealthScore } from './health-score.js';
import { sqlStatusInCare, sqlStatusCondition } from './cat-status.js';
import {
  jstNowIsoTimestamp,
  jstCalendarYmdFromInstant,
  jstCalendarAddDays,
  jstCalendarDiffDays,
  jstWeekdaySUN0,
  jstCalendarYmdFromParsedIso,
} from './jst-util.js';

export {
  jstNowIsoTimestamp,
  jstCalendarYmdFromInstant,
  jstCalendarAddDays,
  jstWeekdaySUN0,
};

/** 一覧基準日 D で、未完了イベントは 期限 <= D+この日数まで表示。期限超えも一覧に残す */
export var EVENT_TASK_LIST_HORIZON_DAYS = 30;

/** SQL（エイリアス t）一覧の暦日キー: 指定実行日 → 指定期日 → 従来 due_date */
var TASK_LIST_YMD_SQL_T = 'COALESCE(t.scheduled_date, t.deadline_date, t.due_date)';
/** 暦日一致（時刻付き文字列でも当日にマッチ）。業務終了の pending / 事前スキップ集計用 */
var TASK_LIST_DAY_EQ_SQL_T = 'date(COALESCE(t.scheduled_date, t.deadline_date, t.due_date))';
/** SQL（エイリアス t）イベント期限比較: 指定期日 → 従来 due_date */
var TASK_EVENT_DUE_SQL_T = 'COALESCE(t.deadline_date, t.due_date)';

/**
 * ダッシュ朝・夕の「今日のタスク」件数・未完了上位用（tasks にエイリアスなし）。
 * 3 つの ? はすべて同一の基準暦日（JST YYYY-MM-DD）。
 * ルーティン等: date(COALESCE(scheduled_date, deadline_date, due_date)) = 基準日（一覧と同じ暦日キー）。
 * 未完了イベント: 期限が「基準日以前」のみ（未来の期限は分母・分子に含めない）。
 * 完了／スキップ済イベント: 暦日キーが基準日の行のみ。
 */
export var SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_NO_ALIAS =
  "((COALESCE(task_type, 'routine') != 'event' AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ?) OR " +
  "(task_type = 'event' AND status IN ('pending', 'in_progress') AND date(COALESCE(deadline_date, due_date)) <= ?) OR " +
  "(task_type = 'event' AND status NOT IN ('pending', 'in_progress') AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ?))";

/** 同上・JOIN 用エイリアス t */
export var SQL_WHERE_TASKS_FOR_DASHBOARD_DAY_ALIAS_T =
  "((COALESCE(t.task_type, 'routine') != 'event' AND date(" +
  TASK_LIST_YMD_SQL_T +
  ") = ?) OR " +
  "(t.task_type = 'event' AND t.status IN ('pending', 'in_progress') AND date(" +
  TASK_EVENT_DUE_SQL_T +
  ") <= ?) OR " +
  "(t.task_type = 'event' AND t.status NOT IN ('pending', 'in_progress') AND date(" +
  TASK_LIST_YMD_SQL_T +
  ") = ?))";
/**
 * 監視タスクを一覧に載せる（エイリアス t）。? は基準日（expires_at 比較用）。
 * 完了・スキップは「最近」かつ暦日キーが残っている間だけ表示（業務終了消込でキーを外すと非表示）。
 */
function taskMonitoringListSqlT(dateParam) {
  return (
    "(t.task_type = 'monitoring' AND (t.status = 'pending' OR t.expires_at IS NULL OR t.expires_at >= " +
    dateParam +
    " OR (t.status IN ('done','skipped') AND t.completed_at IS NOT NULL AND datetime(replace(substr(t.completed_at,1,19), 'T', ' ')) >= datetime('now', '-60 days') AND " +
    TASK_LIST_YMD_SQL_T +
    ' IS NOT NULL)))'
  );
}

/** skip_reason が空でも note の [スキップ理由] 行を表示用に復元 */
function resolveTaskSkipReason(row) {
  if (!row) return '';
  var r = row.skip_reason != null ? String(row.skip_reason).trim() : '';
  if (r) return r;
  var n = row.note != null ? String(row.note) : '';
  if (n.indexOf('[スキップ理由]') === -1) return '';
  var chunks = n.split('[スキップ理由]');
  var tail = chunks[chunks.length - 1] || '';
  var firstLine = tail.split('\n')[0].trim();
  return firstLine || '';
}

var ATTRIBUTE_META = {
  opening:  { label: '開店準備',   icon: '🌅', order: 1 },
  event:    { label: 'イベント',   icon: '📅', order: 2 },
  cat_care: { label: '猫のお世話', icon: '🐱', order: 3 },
  medical:  { label: '医療・投薬', icon: '💊', order: 4 },
  cleaning: { label: '清掃',       icon: '🧹', order: 5 },
  closing:  { label: '閉店作業',   icon: '🌙', order: 6 },
  project:  { label: 'プロジェクト', icon: '📁', order: 7 },
  other:    { label: 'その他',     icon: '📋', order: 8 },
};

var MAX_TREE_DEPTH = 5;

export async function handleTasks(req, env, url, staffAuth, subPath, ctx) {
  var method = req.method;
  var db = env.OPS_DB;

  // --- Projects routing ---

  // /projects/:id/nodes/:nodeId
  var nodeIdMatch = subPath.match(/^\/projects\/(\d+)\/nodes\/(\d+)$/);
  if (nodeIdMatch) {
    var projId = parseInt(nodeIdMatch[1], 10);
    var nodeId = parseInt(nodeIdMatch[2], 10);
    if (method === 'PUT') return putNode(db, req, staffAuth, projId, nodeId);
    if (method === 'DELETE') return deleteNode(db, req, staffAuth, projId, nodeId);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /projects/:id/nodes
  var nodesMatch = subPath.match(/^\/projects\/(\d+)\/nodes\/?$/);
  if (nodesMatch) {
    if (method === 'POST') return postNode(db, req, staffAuth, parseInt(nodesMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /projects/:id
  var projectIdMatch = subPath.match(/^\/projects\/(\d+)$/);
  if (projectIdMatch) {
    var pid = parseInt(projectIdMatch[1], 10);
    if (method === 'GET') return getProject(db, url, staffAuth, pid);
    if (method === 'PUT') return putProject(db, req, staffAuth, pid);
    if (method === 'DELETE') return deleteProject(db, req, staffAuth, pid);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /projects
  if (subPath === '/projects' || subPath === '/projects/') {
    if (method === 'GET') return getProjects(db, url, staffAuth);
    if (method === 'POST') return postProject(db, req, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // --- Tasks routing ---

  // /close-day/preview — 業務終了プレビュー
  if (subPath === '/close-day/preview') {
    if (method === 'GET') return closeDayPreview(db, env, url, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /close-day — 業務終了実行
  if (subPath === '/close-day') {
    if (method === 'POST') return closeDayExecute(db, env, req, staffAuth, ctx);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // GET /tasks/care-field-pending — 前日JST基準のケア項目穴（buildCloseDayCareItemGaps と同一）
  if (subPath === '/care-field-pending' || subPath === '/care-field-pending/') {
    if (method === 'GET') return getCareFieldPending(db, url, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // GET /tasks/care-reduction-check — 「実施未確認のケアを減らす」タスク完了判定
  // 昨日と今日のケア穴件数を比較し、減少していれば ok: true、そうでなければ ok: false + 詳細
  if (subPath === '/care-reduction-check' || subPath === '/care-reduction-check/') {
    if (method === 'GET') return getCareReductionCheck(db, url, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /templates/generate（:id より先に判定）
  if (subPath === '/templates/generate') {
    if (method === 'POST') return generateFromTemplates(db, req, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /templates/generate-notify — 生成結果をSlackへ共有
  if (subPath === '/templates/generate-notify') {
    if (method === 'POST') return notifyGeneratedTasksToSlack(db, req, staffAuth, env);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /notify-new — 新規タスク登録をSlackへ共有
  if (subPath === '/notify-new') {
    if (method === 'POST') return notifyNewTaskToSlack(db, req, staffAuth, env);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /templates/:id
  var templateIdMatch = subPath.match(/^\/templates\/([^/]+)$/);
  if (templateIdMatch) {
    if (method === 'GET') return getTemplate(db, templateIdMatch[1]);
    if (method === 'PUT') return putTemplate(db, req, templateIdMatch[1]);
    if (method === 'DELETE') return deleteTemplate(db, templateIdMatch[1]);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /templates
  if (subPath === '/templates' || subPath === '/templates/') {
    if (method === 'GET') return getTemplates(db, url, staffAuth);
    if (method === 'POST') return postTemplate(db, req, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks/:id/done
  var doneMatch = subPath.match(/^\/(\d+)\/done$/);
  if (doneMatch) {
    if (method === 'POST') return completeTask(db, req, staffAuth, parseInt(doneMatch[1], 10), 'done');
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks/:id/skip
  var skipMatch = subPath.match(/^\/(\d+)\/skip$/);
  if (skipMatch) {
    if (method === 'POST') return completeTask(db, req, staffAuth, parseInt(skipMatch[1], 10), 'skipped');
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks/:id/undo
  var undoMatch = subPath.match(/^\/(\d+)\/undo$/);
  if (undoMatch) {
    if (method === 'POST') return undoTask(db, req, staffAuth, parseInt(undoMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks/:id/assign
  var assignMatch = subPath.match(/^\/(\d+)\/assign$/);
  if (assignMatch) {
    if (method === 'PUT') return assignTask(db, req, staffAuth, parseInt(assignMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks/:id/note
  var noteMatch = subPath.match(/^\/(\d+)\/note$/);
  if (noteMatch) {
    if (method === 'PUT') return appendTaskNote(db, req, staffAuth, parseInt(noteMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks/:id/status  (PUT: 監視タスクのみ任意遷移)
  var taskStatusMatch = subPath.match(/^\/(\d+)\/status$/);
  if (taskStatusMatch) {
    if (method === 'PUT') return putMonitoringTaskStatus(db, req, staffAuth, parseInt(taskStatusMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks/clear-date (admin: delete all tasks for a date)
  if (subPath === '/clear-date') {
    if (method === 'POST') return clearTasksByDate(db, req, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks/:id (GET: 1件 / PUT: 部分更新 / DELETE)
  var taskIdMatch = subPath.match(/^\/(\d+)$/);
  if (taskIdMatch) {
    var tid = parseInt(taskIdMatch[1], 10);
    if (method === 'GET') return getOneTask(db, tid);
    if (method === 'PUT') return patchTask(db, req, staffAuth, tid);
    if (method === 'DELETE') return deleteTask(db, tid);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /tasks
  if (subPath === '' || subPath === '/') {
    if (method === 'GET') return getTasks(db, url, staffAuth);
    if (method === 'POST') return postTask(db, req, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  return opsJson({ error: 'not_found' }, 404);
}

// ══════════════════════════════════════════════════════════════════════════════
//  テンプレート
// ══════════════════════════════════════════════════════════════════════════════

async function getTemplates(db, url, staffAuth) {
  var locationId = url.searchParams.get('location') || staffAuth.locationId;
  var activeOnly = url.searchParams.get('active') !== '0';
  var taskType = url.searchParams.get('task_type') || '';

  var sql = 'SELECT t.*, c.name AS cat_name, s.name AS assigned_name FROM task_templates t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE 1=1';
  var params = [];
  if (locationId && locationId !== 'both' && locationId !== 'all') {
    sql += ' AND t.location_id = ?';
    params.push(locationId);
  }
  if (activeOnly) {
    sql += ' AND t.active = 1';
  }
  if (taskType) {
    sql += ' AND t.task_type = ?';
    params.push(taskType);
  }
  sql += ' ORDER BY t.task_type, t.attribute, t.sort_order, t.title';

  var stmt = db.prepare(sql);
  if (params.length > 0) { stmt = stmt.bind.apply(stmt, params); }
  var result = await stmt.all();
  return opsJson({ templates: result.results || [] });
}

async function postTemplate(db, req, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var id = body.id;
  var rawLoc = body.location_id || staffAuth.locationId;
  var locationId = (rawLoc === 'both') ? 'cafe' : rawLoc;
  var title = body.title;
  var attribute = body.attribute || body.category;
  var recurrence = body.recurrence;
  var taskType = body.task_type || 'routine';

  if (!id || !title || !attribute || !recurrence) {
    return opsJson({ error: 'missing_fields', message: 'id, title, attribute, recurrence は必須です' }, 400);
  }

  var tmplExpires = null;
  if (taskType === 'monitoring' && body.expires_at != null && String(body.expires_at).trim() !== '') {
    tmplExpires = String(body.expires_at).trim().slice(0, 10);
  }

  await db.prepare(
    'INSERT INTO task_templates (id, location_id, title, attribute, cat_id, assigned_to, recurrence, time_slot, priority, description, active, task_type, sort_order, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)'
  ).bind(id, locationId, title, attribute, body.cat_id || null, body.assigned_to || null, recurrence, body.time_slot || null, body.priority || 'normal', body.description || null, taskType, body.sort_order || 0, tmplExpires).run();

  var tmpl = await db.prepare('SELECT * FROM task_templates WHERE id = ?').bind(id).first();
  return opsJson({ template: tmpl }, 201);
}

async function putTemplate(db, req, id) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var existing = await db.prepare('SELECT id FROM task_templates WHERE id = ?').bind(id).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);

  var sets = [];
  var params = [];

  if (body.title !== undefined) { sets.push('title = ?'); params.push(body.title); }
  if (body.attribute !== undefined) { sets.push('attribute = ?'); params.push(body.attribute); }
  if (body.category !== undefined && body.attribute === undefined) { sets.push('attribute = ?'); params.push(body.category); }
  if (body.recurrence !== undefined) { sets.push('recurrence = ?'); params.push(body.recurrence); }
  if (body.time_slot !== undefined) { sets.push('time_slot = ?'); params.push(body.time_slot); }
  if (body.priority !== undefined) { sets.push('priority = ?'); params.push(body.priority); }
  if (body.description !== undefined) { sets.push('description = ?'); params.push(body.description); }
  if (body.cat_id !== undefined) { sets.push('cat_id = ?'); params.push(body.cat_id); }
  if (body.assigned_to !== undefined) { sets.push('assigned_to = ?'); params.push(body.assigned_to || null); }
  if (body.active !== undefined) { sets.push('active = ?'); params.push(body.active ? 1 : 0); }
  if (body.task_type !== undefined) { sets.push('task_type = ?'); params.push(body.task_type); }
  if (body.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(body.sort_order); }
  if (body.expires_at !== undefined) {
    var exv = body.expires_at;
    sets.push('expires_at = ?');
    params.push(exv === null || exv === '' ? null : String(exv).trim().slice(0, 10));
  }

  if (sets.length === 0) return opsJson({ error: 'no_fields' }, 400);

  params.push(id);
  var sql = 'UPDATE task_templates SET ' + sets.join(', ') + ' WHERE id = ?';
  var stmt = db.prepare(sql);
  stmt = stmt.bind.apply(stmt, params);
  await stmt.run();

  var tmpl = await db.prepare('SELECT * FROM task_templates WHERE id = ?').bind(id).first();
  /** テンプレの猫を変えたとき、未完了の生成タスクも献立プリセット同様に追随（猫一覧の関連タスクと一致） */
  if (tmpl && body.cat_id !== undefined) {
    await syncPendingTasksCatFromTemplate(db, tmpl);
  }
  return opsJson({ template: tmpl });
}

/**
 * task_templates.cat_id と、当該 template_id の pending / in_progress タスクを揃える。
 */
async function syncPendingTasksCatFromTemplate(db, tmpl) {
  if (!tmpl || !tmpl.id) return;
  var tid = tmpl.id;
  var rawCat = tmpl.cat_id;
  var newCat = rawCat != null && String(rawCat).trim() !== '' ? String(rawCat).trim() : null;
  if (newCat != null) {
    var cat = await db.prepare('SELECT id, location_id FROM cats WHERE id = ?').bind(newCat).first();
    if (!cat) {
      console.warn('[tasks] syncPendingTasksCatFromTemplate: cat not found', newCat);
      return;
    }
    if (tmpl.location_id != null && String(cat.location_id) !== String(tmpl.location_id)) {
      console.warn('[tasks] syncPendingTasksCatFromTemplate: location mismatch template', tid, tmpl.location_id, cat.location_id);
      return;
    }
  }
  await db.prepare(
    "UPDATE tasks SET cat_id = ? WHERE template_id = ? AND status IN ('pending', 'in_progress')"
  ).bind(newCat, tid).run();
}

async function getTemplate(db, id) {
  var tmpl = await db.prepare(
    'SELECT t.*, c.name AS cat_name, s.name AS assigned_name FROM task_templates t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE t.id = ?'
  ).bind(id).first();
  if (!tmpl) return opsJson({ error: 'not_found' }, 404);
  return opsJson({ template: tmpl });
}

async function deleteTemplate(db, id) {
  var existing = await db.prepare('SELECT id FROM task_templates WHERE id = ?').bind(id).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);

  await db.prepare('UPDATE tasks SET template_id = NULL WHERE template_id = ?').bind(id).run();
  await db.prepare('DELETE FROM task_templates WHERE id = ?').bind(id).run();
  return opsJson({ deleted: true });
}

// ══════════════════════════════════════════════════════════════════════════════
//  テンプレートから手動一括生成
// ══════════════════════════════════════════════════════════════════════════════

/**
 * テンプレートからタスク1件INSERT（cron 朝生成・手動一括生成の共通）。
 * 監視タスクはテンプレートの expires_at（YYYY-MM-DD）をコピー。
 */
export async function insertTaskFromTemplateRow(db, tmpl, dueDate) {
  var taskType = tmpl.task_type || 'routine';
  var expiresAt = null;
  if (taskType === 'monitoring') {
    var ex = tmpl.expires_at;
    if (ex != null && String(ex).trim() !== '') expiresAt = String(ex).trim().slice(0, 10);
  }
  var sched = taskType === 'event' ? null : dueDate;
  var deadl = taskType === 'event' ? dueDate : null;
  await db.prepare(
    'INSERT INTO tasks (template_id, location_id, title, attribute, cat_id, assigned_to, due_date, scheduled_date, deadline_date, due_time, priority, sort_order, task_type, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    tmpl.id,
    tmpl.location_id,
    tmpl.title,
    tmpl.attribute,
    tmpl.cat_id,
    tmpl.assigned_to || null,
    dueDate,
    sched,
    deadl,
    tmpl.time_slot || null,
    tmpl.priority || 'normal',
    tmpl.sort_order || 0,
    taskType,
    expiresAt
  ).run();
}

async function generateFromTemplates(db, req, staffAuth) {
  var body = {};
  try { body = await req.json(); } catch (_) {}

  var date = body.date || jstCalendarYmdFromInstant();
  var dow = jstWeekdaySUN0(date);
  var locationId = body.location_id || staffAuth.locationId;

  var tmplSql = 'SELECT * FROM task_templates WHERE active = 1';
  var tmplParams = [];
  if (locationId && locationId !== 'both' && locationId !== 'all') {
    tmplSql += ' AND location_id = ?';
    tmplParams.push(locationId);
  }
  var tmplStmt = db.prepare(tmplSql);
  if (tmplParams.length > 0) { tmplStmt = tmplStmt.bind.apply(tmplStmt, tmplParams); }
  var templates = await tmplStmt.all();

  var count = 0;
  var skipped = 0;
  var onceIds = [];
  var generatedTasks = [];

  var forceEventOnDate = body.force_event_on_date === true || body.force_event_on_date === 1 || body.force_event_on_date === '1';

  for (var i = 0; i < (templates.results || []).length; i++) {
    var tmpl = templates.results[i];
    var tmplIsEvent = (tmpl.task_type || 'routine') === 'event';
    if (!shouldGenerateForDate(tmpl.recurrence, date, dow)) {
      if (!(forceEventOnDate && tmplIsEvent)) { skipped++; continue; }
    }

    var exists = await db.prepare(
      'SELECT id FROM tasks WHERE template_id = ? AND COALESCE(scheduled_date, deadline_date, due_date) = ?'
    ).bind(tmpl.id, date).first();
    if (exists) { skipped++; continue; }

    await insertTaskFromTemplateRow(db, tmpl, date);
    count++;
    generatedTasks.push({
      title: tmpl.title,
      task_type: tmpl.task_type || 'routine',
      recurrence: tmpl.recurrence || '',
      cat_id: tmpl.cat_id || null,
    });

    if (tmpl.recurrence === 'once') onceIds.push(tmpl.id);
  }

  for (var j = 0; j < onceIds.length; j++) {
    await db.prepare('UPDATE task_templates SET active = 0 WHERE id = ?').bind(onceIds[j]).run();
  }

  return opsJson({ generated: count, skipped: skipped, date: date, tasks: generatedTasks, location_id: locationId });
}

/**
 * 新規タスク登録を Slack へ共有
 * POST /tasks/notify-new
 */
async function notifyNewTaskToSlack(db, req, staffAuth, env) {
  var body = {};
  try { body = await req.json(); } catch (_) {}

  var locationId = body.location_id || staffAuth.locationId || '';
  var channel = resolveNyagiReportSlackChannel(env, locationId);
  if (!channel) return opsJson({ ok: false, reason: 'no_slack_channel' });

  var locLabel = LOCATION_LABELS[locationId] || locationId || '';
  var attrLabels = {
    opening: '🌅 開店準備', cat_care: '🐱 猫のお世話', medical: '💊 医療・投薬',
    cleaning: '🧹 清掃', closing: '🌙 閉店作業', other: '📋 その他',
  };
  var priorityLabels = { urgent: '🔴 緊急', high: '🟠 高', normal: '🟡 通常', low: '⬇ 低' };
  var typeLabels = { routine: 'ルーティン', event: 'イベント', monitoring: '監視' };
  var isUpdate = body.is_update === true || body.is_update === 1;
  var isTemplate = body.is_template === true || body.is_template === 1;

  var title = String(body.title || '（タイトル未設定）');
  var actionLabel = isTemplate
    ? (isUpdate ? '✏️ *テンプレートを更新しました*' : '📋 *テンプレートを新規登録しました*')
    : (isUpdate ? '✏️ *タスクを更新しました*' : '📋 *新規タスクを登録しました*');
  var lines = [
    actionLabel + (locLabel ? '（' + locLabel + '）' : ''),
    '> *' + title + '*',
  ];

  var meta = [];
  if (body.attribute && attrLabels[body.attribute]) meta.push(attrLabels[body.attribute]);
  if (body.task_type && typeLabels[body.task_type]) meta.push(typeLabels[body.task_type]);
  if (body.priority && priorityLabels[body.priority]) meta.push(priorityLabels[body.priority]);
  if (body.cat_id) meta.push('対象: ' + String(body.cat_id).replace('cat_', ''));
  if (body.scheduled_date) meta.push('実行日: ' + body.scheduled_date);
  if (body.deadline_date) meta.push('期日: ' + body.deadline_date);
  if (meta.length) lines.push(meta.join('　'));

  if (body.note) lines.push('📝 ' + String(body.note));

  var staffName = staffAuth.staffId || '';
  if (staffName) lines.push('登録者: ' + staffName);

  var text = lines.join('\n');
  var slackResult = await sendSlackMessage(env, channel, text);
  if (!slackResult || !slackResult.ok) {
    return opsJson({ ok: false, reason: (slackResult && slackResult.error) || 'slack_error' });
  }
  return opsJson({ ok: true });
}

/**
 * テンプレート一括生成の結果を Slack へ共有
 * POST /tasks/templates/generate-notify
 * body: { date, generated, skipped, tasks: [{title, task_type, recurrence, cat_id}], location_id }
 */
async function notifyGeneratedTasksToSlack(db, req, staffAuth, env) {
  var body = {};
  try { body = await req.json(); } catch (_) {}

  var date = body.date || '';
  var generated = Number(body.generated) || 0;
  var skipped = Number(body.skipped) || 0;
  var tasks = Array.isArray(body.tasks) ? body.tasks : [];
  var locationId = body.location_id || staffAuth.locationId || '';

  var channel = resolveNyagiReportSlackChannel(env, locationId);
  if (!channel) {
    return opsJson({ ok: false, reason: 'no_slack_channel' });
  }

  var locLabel = (LOCATION_LABELS[locationId] || locationId || '拠点不明');
  var lines = [
    '📋 *' + date + ' タスク一括生成完了* （' + locLabel + '）',
    '> 生成: *' + generated + ' 件* ／ スキップ: ' + skipped + ' 件',
  ];

  if (tasks.length > 0) {
    lines.push('');
    lines.push('*生成されたタスク:*');
    var typeEmoji = { routine: '🔄', event: '📅', monitoring: '👁', once: '1️⃣' };
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var emoji = typeEmoji[t.task_type] || '▪️';
      var catSuffix = t.cat_id ? '（' + String(t.cat_id).replace('cat_', '') + '）' : '';
      lines.push(emoji + ' ' + String(t.title || '') + catSuffix);
    }
  } else {
    lines.push('（新規生成タスクなし）');
  }

  var text = lines.join('\n');
  var slackResult = await sendSlackMessage(env, channel, text);
  if (!slackResult || !slackResult.ok) {
    return opsJson({ ok: false, reason: (slackResult && slackResult.error) || 'slack_error' });
  }
  return opsJson({ ok: true });
}

/**
 * テンプレート recurrence と基準暦日が一致するか（週次・月次の割当）。
 * recurrence が空・未設定のときは true（手動タスク・旧データ互換）。
 */
export function shouldGenerateForDate(recurrence, date, dow) {
  if (recurrence == null || recurrence === '') return true;
  var r = String(recurrence);
  if (r === 'daily') return true;
  if (r === 'once') return true;
  if (r.indexOf('weekly:') === 0) {
    var days = r.replace('weekly:', '').split(',').map(Number);
    return days.indexOf(dow) !== -1;
  }
  if (r.indexOf('monthly:') === 0) {
    var dayOfMonth = parseInt(date.slice(8, 10), 10);
    var monthDays = r.replace('monthly:', '').split(',').map(Number);
    return monthDays.indexOf(dayOfMonth) !== -1;
  }
  return false;
}

/**
 * タスク行が一覧基準日に「テンプレ割当として該当」するか。
 * 監視は常に true。template_id なしは true。該当しない週次・月次は false（表示・集計・業務終了の対象外）。
 */
export function taskRowMatchesTemplateRecurrenceForListDate(row, listDateYmd, recurrenceByTemplateId) {
  var tt = row.task_type || 'routine';
  if (tt === 'monitoring') return true;
  var tid = row.template_id;
  if (tid == null || String(tid).trim() === '') return true;
  var key = String(tid).trim();
  var rec = recurrenceByTemplateId[key];
  if (rec == null || rec === '') return true;
  var dow = jstWeekdaySUN0(listDateYmd);
  return shouldGenerateForDate(rec, listDateYmd, dow);
}

function collectTemplateIdsFromTaskRows(rows) {
  var seen = {};
  var ids = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var tid = rows[i].template_id;
    if (tid == null || String(tid).trim() === '') continue;
    var k = String(tid).trim();
    if (seen[k]) continue;
    seen[k] = true;
    ids.push(k);
  }
  return ids;
}

/**
 * 週次・月次テンプレの割当で基準日に該当しないタスクを除く（今日のタスク・進捗・ダッシュボードと整合）。
 */
export async function filterTaskRowsByTemplateRecurrence(db, rows, listDateYmd) {
  var idList = collectTemplateIdsFromTaskRows(rows);
  var recurrenceById = {};
  if (idList.length > 0) {
    var placeholders = idList.map(function () { return '?'; }).join(',');
    var tmplRecStmt = db.prepare('SELECT id, recurrence FROM task_templates WHERE id IN (' + placeholders + ')');
    var res = await tmplRecStmt.bind.apply(tmplRecStmt, idList).all();
    var rrows = res.results || [];
    for (var j = 0; j < rrows.length; j++) {
      var rr = rrows[j];
      recurrenceById[String(rr.id)] = rr.recurrence != null ? String(rr.recurrence) : '';
    }
  }
  var out = [];
  for (var k = 0; k < (rows || []).length; k++) {
    if (taskRowMatchesTemplateRecurrenceForListDate(rows[k], listDateYmd, recurrenceById)) out.push(rows[k]);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
//  前日基準ケア穴（スキップ確認用・Slack 業務終了の「ケア実施」と同ロジック）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @returns {Promise<Response>}
 */
async function getCareFieldPending(db, url, staffAuth) {
  var today = jstCalendarYmdFromInstant();
  var yesterday = jstCalendarAddDays(today, -1);
  var rawLoc = url.searchParams.get('location');
  if (rawLoc === undefined || rawLoc === null) rawLoc = staffAuth.locationId || '';
  rawLoc = String(rawLoc).trim();
  var locationId = null;
  if (rawLoc && rawLoc !== 'both' && rawLoc !== 'all') {
    locationId = rawLoc;
  }
  var catParam = url.searchParams.get('cat_id');
  var catIdStr = catParam != null && String(catParam).trim() !== '' ? String(catParam).trim() : '';

  var care = await buildCloseDayCareItemGaps(db, locationId, yesterday, null);
  var items = care.items || [];

  if (!catIdStr) {
    return opsJson({
      reference_date: yesterday,
      threshold_days: care.threshold_days,
      has_pending: items.length > 0,
      items: items,
    });
  }

  var forCat = [];
  for (var i = 0; i < items.length; i++) {
    if (String(items[i].cat_id) === catIdStr) forCat.push(items[i]);
  }

  var slim = [];
  for (var j = 0; j < forCat.length; j++) {
    var it = forCat[j];
    slim.push({
      item_label: it.item_label,
      days_since_last: it.days_since_last,
      no_record: it.no_record,
      last_record_date: it.last_record_date,
    });
  }

  return opsJson({
    reference_date: yesterday,
    threshold_days: care.threshold_days,
    has_pending: slim.length > 0,
    items_for_cat: slim,
  });
}

/**
 * 「実施未確認のケアを減らす」タスク完了判定。
 * 昨日と今日のケア穴件数（threshold 以上未記録の項目数）を比較する。
 * ok: true → 今日の件数 < 昨日の件数（減少した）
 * ok: false → 減っていない or 増えた
 */
async function getCareReductionCheck(db, url, staffAuth) {
  var today = jstCalendarYmdFromInstant();
  var yesterday = jstCalendarAddDays(today, -1);
  var rawLoc = url.searchParams.get('location');
  if (rawLoc === undefined || rawLoc === null) rawLoc = staffAuth.locationId || '';
  rawLoc = String(rawLoc).trim();
  var locationId = null;
  if (rawLoc && rawLoc !== 'both' && rawLoc !== 'all') {
    locationId = rawLoc;
  }

  var todayCare = await buildCloseDayCareItemGaps(db, locationId, today, null);
  var yesterdayCare = await buildCloseDayCareItemGaps(db, locationId, yesterday, null);

  var todayCount = (todayCare.items || []).length;
  var yesterdayCount = (yesterdayCare.items || []).length;
  var decreased = todayCount < yesterdayCount;

  return opsJson({
    today_count: todayCount,
    yesterday_count: yesterdayCount,
    decreased: decreased,
    today_date: today,
    yesterday_date: yesterday,
    threshold_days: todayCare.threshold_days,
    today_items: (todayCare.items || []).map(function (i) {
      return { cat_name: i.cat_name, item_label: i.item_label, days_since_last: i.days_since_last };
    }),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  タスク一覧（attribute グルーピング対応）
// ══════════════════════════════════════════════════════════════════════════════

async function getTasks(db, url, staffAuth) {
  var locationId = url.searchParams.get('location') || staffAuth.locationId;
  var date = url.searchParams.get('date') || jstCalendarYmdFromInstant();
  var status = url.searchParams.get('status') || '';
  var catId = url.searchParams.get('cat_id') || '';
  var taskType = url.searchParams.get('task_type') || '';
  var assignedTo = url.searchParams.get('assigned_to') || '';
  var groupBy = url.searchParams.get('group_by') || '';

  var sql = 'SELECT t.*, c.name AS cat_name, s.name AS assigned_name FROM tasks t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE 1=1';
  var params = [];
  if (locationId && locationId !== 'both' && locationId !== 'all') {
    sql += ' AND t.location_id = ?';
    params.push(locationId);
  }

  var eventHorizonEnd = null;
  if (taskType === 'monitoring') {
    sql += ' AND ' + taskMonitoringListSqlT('?');
    params.push(date);
  } else {
    eventHorizonEnd = jstCalendarAddDays(date, EVENT_TASK_LIST_HORIZON_DAYS);
    if (taskType === 'routine') {
      sql += " AND COALESCE(t.task_type, 'routine') = 'routine' AND " + TASK_LIST_YMD_SQL_T + ' = ?';
      params.push(date);
    } else if (taskType === 'event') {
      // 未完了イベント: 期限が「基準日以前」のみ（未来に設定されたものはその日が来るまで表示しない）
      // 完了／スキップ済み: 暦日キーが基準日の行のみ
      sql +=
        " AND t.task_type = 'event' AND ((t.status IN ('pending', 'in_progress') AND date(" +
        TASK_EVENT_DUE_SQL_T +
        ") <= ?) OR (t.status NOT IN ('pending', 'in_progress') AND date(" +
        TASK_LIST_YMD_SQL_T +
        ') = ?))';
      params.push(date, date);
    } else {
      sql +=
        " AND ((COALESCE(t.task_type, 'routine') != 'event' AND date(" +
        TASK_LIST_YMD_SQL_T +
        ') = ?) OR (t.task_type = \'event\' AND ((t.status IN (\'pending\', \'in_progress\') AND date(' +
        TASK_EVENT_DUE_SQL_T +
        ') <= ?) OR (t.status NOT IN (\'pending\', \'in_progress\') AND date(' +
        TASK_LIST_YMD_SQL_T +
        ') = ?))))';
      params.push(date, date, date);
    }
    if (taskType && taskType !== 'routine' && taskType !== 'event') {
      sql += ' AND t.task_type = ?';
      params.push(taskType);
    }
  }

  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  if (catId) { sql += ' AND t.cat_id = ?'; params.push(catId); }
  if (assignedTo) { sql += ' AND t.assigned_to = ?'; params.push(assignedTo); }

  sql +=
    ' ORDER BY CASE WHEN t.task_type = \'event\' AND t.status IN (\'pending\', \'in_progress\') AND ' +
    TASK_EVENT_DUE_SQL_T +
    " < ? THEN 0 ELSE 1 END, " +
    TASK_LIST_YMD_SQL_T +
    " ASC, t.sort_order, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, c.name, t.due_time, t.title";
  params.push(date);

  var stmt = db.prepare(sql);
  stmt = stmt.bind.apply(stmt, params);
  var result = await stmt.all();
  var tasks = result.results || [];
  tasks = await filterTaskRowsByTemplateRecurrence(db, tasks, date);

  var di;
  for (di = 0; di < tasks.length; di++) {
    var tk = tasks[di];
    if (tk.task_type === 'event' && (tk.status === 'pending' || tk.status === 'in_progress')) {
      var dDueRaw = tk.deadline_date || tk.due_date;
      var dDue = dDueRaw ? String(dDueRaw).slice(0, 10) : '';
      if (dDue.length === 10) {
        var diff = jstCalendarDiffDays(dDue, date);
        tk.event_days_open = diff > 0 ? diff : 0;
      } else {
        tk.event_days_open = 0;
      }
    }
  }

  var total = 0;
  var done = 0;
  for (var i = 0; i < tasks.length; i++) {
    total++;
    if (tasks[i].status === 'done' || tasks[i].status === 'skipped') done++;
  }

  var response = {
    tasks: tasks,
    date: date,
    progress: { total: total, done: done, pct: total > 0 ? Math.round(done / total * 100) : 0 },
  };
  if (eventHorizonEnd) {
    response.event_list_horizon_days = EVENT_TASK_LIST_HORIZON_DAYS;
    response.event_horizon_end = eventHorizonEnd;
  }

  if (groupBy === 'attribute') {
    var attrMap = {};
    for (var a = 0; a < tasks.length; a++) {
      var t = tasks[a];
      if (t.task_type === 'monitoring') continue;
      var attr = t.attribute || 'other';
      if (!attrMap[attr]) attrMap[attr] = [];
      attrMap[attr].push(t);
    }

    var attrGroups = [];
    var attrKeys = Object.keys(ATTRIBUTE_META);
    for (var k = 0; k < attrKeys.length; k++) {
      var key = attrKeys[k];
      if (!attrMap[key]) continue;
      var meta = ATTRIBUTE_META[key];
      var grpTasks = attrMap[key];
      var grpDone = 0;
      for (var d = 0; d < grpTasks.length; d++) { if (grpTasks[d].status === 'done' || grpTasks[d].status === 'skipped') grpDone++; }
      attrGroups.push({
        attribute: key,
        label: meta.label,
        icon: meta.icon,
        progress: { total: grpTasks.length, done: grpDone, pct: grpTasks.length > 0 ? Math.round(grpDone / grpTasks.length * 100) : 0 },
        tasks: grpTasks,
      });
    }

    var unknownAttrs = Object.keys(attrMap);
    for (var u = 0; u < unknownAttrs.length; u++) {
      if (!ATTRIBUTE_META[unknownAttrs[u]]) {
        var uTasks = attrMap[unknownAttrs[u]];
        var uDone = 0;
        for (var ud = 0; ud < uTasks.length; ud++) { if (uTasks[ud].status === 'done' || uTasks[ud].status === 'skipped') uDone++; }
        attrGroups.push({
          attribute: unknownAttrs[u],
          label: unknownAttrs[u],
          icon: '📋',
          progress: { total: uTasks.length, done: uDone, pct: uTasks.length > 0 ? Math.round(uDone / uTasks.length * 100) : 0 },
          tasks: uTasks,
        });
      }
    }

    var monTasksForGrp = [];
    for (var mg = 0; mg < tasks.length; mg++) {
      if (tasks[mg].task_type === 'monitoring') monTasksForGrp.push(tasks[mg]);
    }
    if (monTasksForGrp.length > 0) {
      var monDone = 0;
      for (var mdi = 0; mdi < monTasksForGrp.length; mdi++) {
        if (monTasksForGrp[mdi].status === 'done' || monTasksForGrp[mdi].status === 'skipped') monDone++;
      }
      attrGroups.push({
        attribute: 'monitoring',
        label: '監視',
        icon: '🔭',
        progress: {
          total: monTasksForGrp.length,
          done: monDone,
          pct: monTasksForGrp.length > 0 ? Math.round(monDone / monTasksForGrp.length * 100) : 0,
        },
        tasks: monTasksForGrp,
      });
    }

    response.attribute_groups = attrGroups;
  }

  if (groupBy === 'cat') {
    var groups = {};
    var nocat = [];
    for (var j = 0; j < tasks.length; j++) {
      var tc = tasks[j];
      if (!tc.cat_id) { nocat.push(tc); continue; }
      if (!groups[tc.cat_id]) groups[tc.cat_id] = { cat_id: tc.cat_id, cat_name: tc.cat_name, tasks: [] };
      groups[tc.cat_id].tasks.push(tc);
    }
    var catGroups = [];
    var ckeys = Object.keys(groups);
    for (var ck = 0; ck < ckeys.length; ck++) catGroups.push(groups[ckeys[ck]]);
    catGroups.sort(function (a, b) { return (a.cat_name || '').localeCompare(b.cat_name || ''); });
    if (nocat.length > 0) catGroups.push({ cat_id: null, cat_name: '共通', tasks: nocat });
    response.cat_groups = catGroups;
  }

  return opsJson(response);
}

/** GET /tasks/:id — 編集モーダル用 1 件 */
async function getOneTask(db, taskId) {
  var row = await db
    .prepare(
      'SELECT t.*, c.name AS cat_name, s.name AS assigned_name FROM tasks t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE t.id = ?'
    )
    .bind(taskId)
    .first();
  if (!row) return opsJson({ error: 'not_found' }, 404);
  return opsJson({ task: row });
}

// ══════════════════════════════════════════════════════════════════════════════
//  タスク作成（アドホック）
// ══════════════════════════════════════════════════════════════════════════════

async function deleteTask(db, taskId) {
  await db.prepare('DELETE FROM tasks WHERE id = ?').bind(taskId).run();
  return opsJson({ deleted: taskId });
}

/** タスクの猫紐付けのみ更新（拠点不一致は拒否） */
async function patchTask(db, req, staffAuth, taskId) {
  var body = {};
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return opsJson({ error: 'not_found' }, 404);

  var sets = [];
  var params = [];

  // cat_id（従来互換）
  if (Object.prototype.hasOwnProperty.call(body, 'cat_id')) {
    var newCatId = null;
    if (body.cat_id !== null && body.cat_id !== '' && body.cat_id !== undefined) {
      newCatId = parseInt(body.cat_id, 10);
      if (isNaN(newCatId)) return opsJson({ error: 'invalid_cat_id' }, 400);
    }
    if (newCatId) {
      var cat = await db.prepare('SELECT id, location_id FROM cats WHERE id = ?').bind(newCatId).first();
      if (!cat) return opsJson({ error: 'cat_not_found' }, 404);
      if (String(cat.location_id) !== String(task.location_id)) {
        return opsJson({ error: 'location_mismatch', message: '猫の拠点とタスクの拠点が一致しません' }, 400);
      }
    }
    sets.push('cat_id = ?'); params.push(newCatId);
  }

  // 編集可能フィールド
  if (body.title !== undefined && String(body.title).trim()) {
    sets.push('title = ?'); params.push(String(body.title).trim());
  }
  if (body.priority !== undefined) {
    var validPriorities = ['urgent', 'high', 'normal', 'low'];
    if (validPriorities.indexOf(body.priority) !== -1) {
      sets.push('priority = ?'); params.push(body.priority);
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'scheduled_date')) {
    sets.push('scheduled_date = ?'); params.push(body.scheduled_date || null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'deadline_date')) {
    sets.push('deadline_date = ?'); params.push(body.deadline_date || null);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'expires_at') && (task.task_type || '') === 'monitoring') {
    sets.push('expires_at = ?');
    params.push(body.expires_at == null || body.expires_at === '' ? null : normalizeOptionalYmd(String(body.expires_at)));
  }

  if (sets.length === 0) {
    return opsJson({ error: 'missing_fields', message: '更新するフィールドがありません' }, 400);
  }

  params.push(taskId);
  await db.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?')
    .bind.apply(db.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?'), params).run();

  var updated = await db.prepare(
    'SELECT t.*, c.name AS cat_name, s.name AS assigned_name FROM tasks t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE t.id = ?'
  ).bind(taskId).first();
  return opsJson({ task: updated });
}

async function clearTasksByDate(db, req, staffAuth) {
  var body = {};
  try { body = await req.json(); } catch (_) {}
  var date = body.date || jstCalendarYmdFromInstant();
  var loc = body.location_id || staffAuth.locationId;
  if (loc === 'both') loc = null;

  var sql = 'DELETE FROM tasks WHERE COALESCE(scheduled_date, deadline_date, due_date) = ?';
  var params = [date];
  if (loc) { sql += ' AND location_id = ?'; params.push(loc); }

  var result = await db.prepare(sql).bind.apply(db.prepare(sql), params).run();
  return opsJson({ cleared: true, date: date, changes: result.meta.changes });
}

function normalizeOptionalYmd(v) {
  if (v === undefined || v === null) return null;
  var s = String(v).trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

async function postTask(db, req, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var rawLoc = body.location_id || staffAuth.locationId;
  var locationId = (rawLoc === 'both') ? 'cafe' : rawLoc;
  var title = body.title;
  var taskType = body.task_type || 'routine';
  var attribute = body.attribute || body.category || null;

  if (!title) return opsJson({ error: 'missing_fields', message: 'title は必須です' }, 400);

  var sched = normalizeOptionalYmd(body.scheduled_date);
  var deadl = normalizeOptionalYmd(body.deadline_date);
  if (!sched && !deadl && body.due_date !== undefined && body.due_date !== null && String(body.due_date).trim() !== '') {
    sched = normalizeOptionalYmd(body.due_date);
  }
  var listDate = sched || deadl || null;

  var result = await db.prepare(
    'INSERT INTO tasks (template_id, location_id, title, attribute, cat_id, assigned_to, due_date, scheduled_date, deadline_date, due_time, priority, task_type, expires_at, source_id, source_type, sort_order, project_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    body.template_id || null, locationId, title, attribute,
    body.cat_id || null, body.assigned_to || staffAuth.staffId,
    listDate, sched, deadl,
    body.due_time || null, body.priority || 'normal', taskType,
    body.expires_at || null, body.source_id || null, body.source_type || null,
    body.sort_order || 0, body.project_node_id || null
  ).run();

  var task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(result.meta.last_row_id).first();
  return opsJson({ task: task }, 201);
}

// ══════════════════════════════════════════════════════════════════════════════
//  タスク完了 / スキップ（競合防止 + プロジェクトノード同期）
// ══════════════════════════════════════════════════════════════════════════════

function taskCalendarYmdForMedicationGuard(task) {
  var raw = task.scheduled_date || task.deadline_date || task.due_date;
  if (raw) {
    var s = String(raw).slice(0, 10);
    if (s.length === 10 && s.charAt(4) === '-') return s;
  }
  return jstCalendarYmdFromInstant();
}

var HALL_MORNING_MEDICATION_TASK_TEMPLATE_ID = 'tmpl_hall_asa_touyaku';
var HALL_EVENING_MEDICATION_TASK_TEMPLATE_ID = 'tmpl_hall_yokujitsu_box';
var MORNING_FEEDING_TASK_TEMPLATE_ID = 'nekomeshiasa';
var EVENING_FEEDING_TASK_TEMPLATE_ID = 'tmpl_bw_10';
var HALL_WATER_MEASUREMENT_TASK_TEMPLATE_ID = 'tmpl_hall_mizu_koukan';
/* 飲水測定ガードの有効化開始日（JST）。これ以降のタスク実行日に対してガードを適用する。
 * 実務影響を抑えるため、明日（2026-04-20）以降のタスクにのみ適用。 */
var HALL_WATER_MEASUREMENT_GUARD_START_YMD = '2026-04-20';

async function completeTask(db, req, staffAuth, taskId, newStatus) {
  var body = {};
  try { body = await req.json(); } catch (_) {}

  var task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return opsJson({ error: 'not_found' }, 404);

  if (task.status !== 'pending') {
    return opsJson({ error: 'already_completed', completed_by: task.completed_by, completed_at: task.completed_at }, 409);
  }

  if (
    task.template_id === HALL_MORNING_MEDICATION_TASK_TEMPLATE_ID &&
    (newStatus === 'done' || newStatus === 'skipped')
  ) {
    var ymdGuard = taskCalendarYmdForMedicationGuard(task);
    var medChk = await checkMorningMedicationCompleteForGuard(db, task.location_id, ymdGuard, null);
    if (!medChk.ok) {
      return opsJson(
        {
          error: 'morning_medication_incomplete',
          message:
            '朝の投薬（朝スロット）がすべて記録済みではありません。投薬を「済」またはスキップ（必要な場合）にしてから完了／スキップしてください。',
          missing_cats: medChk.missing_cats,
          missing_lines: medChk.missing_lines,
          reference_date: ymdGuard,
        },
        409
      );
    }
  }

  if (
    task.template_id === HALL_EVENING_MEDICATION_TASK_TEMPLATE_ID &&
    (newStatus === 'done' || newStatus === 'skipped')
  ) {
    var ymdGuardEv = taskCalendarYmdForMedicationGuard(task);
    var medChkEv = await checkEveningMedicationCompleteForGuard(db, task.location_id, ymdGuardEv, null);
    if (!medChkEv.ok) {
      return opsJson(
        {
          error: 'evening_medication_incomplete',
          message:
            '夜の投薬（晩スロット）がすべて記録済みではありません。投薬を「済」またはスキップ（必要な場合）にしてから完了／スキップしてください。',
          missing_cats: medChkEv.missing_cats,
          missing_lines: medChkEv.missing_lines,
          reference_date: ymdGuardEv,
        },
        409
      );
    }
  }

  if (
    task.template_id === MORNING_FEEDING_TASK_TEMPLATE_ID &&
    (newStatus === 'done' || newStatus === 'skipped')
  ) {
    var ymdGuardFd = taskCalendarYmdForMedicationGuard(task);
    var feedChk = await checkMorningFeedingCompleteForGuard(db, task.location_id, ymdGuardFd, null);
    if (!feedChk.ok) {
      return opsJson(
        {
          error: 'morning_feeding_incomplete',
          message:
            '朝ごはんがすべて記録されていません。全ての猫の朝ごはんを記録してから完了／スキップしてください。',
          missing_cats: feedChk.missing_cats,
          missing_lines: feedChk.missing_lines,
          reference_date: ymdGuardFd,
        },
        409
      );
    }
  }

  if (
    task.template_id === EVENING_FEEDING_TASK_TEMPLATE_ID &&
    (newStatus === 'done' || newStatus === 'skipped')
  ) {
    var ymdGuardEf = taskCalendarYmdForMedicationGuard(task);
    var feedChkEv = await checkEveningFeedingCompleteForGuard(db, task.location_id, ymdGuardEf, null);
    if (!feedChkEv.ok) {
      return opsJson(
        {
          error: 'evening_feeding_incomplete',
          message:
            '夜ごはんがすべて記録されていません。全ての猫の夜ごはんを記録してから完了／スキップしてください。',
          missing_cats: feedChkEv.missing_cats,
          missing_lines: feedChkEv.missing_lines,
          reference_date: ymdGuardEf,
        },
        409
      );
    }
  }

  if (
    task.template_id === HALL_WATER_MEASUREMENT_TASK_TEMPLATE_ID &&
    (newStatus === 'done' || newStatus === 'skipped')
  ) {
    var ymdGuardWm = taskCalendarYmdForMedicationGuard(task);
    /* 明日（HALL_WATER_MEASUREMENT_GUARD_START_YMD）以降のタスクのみガード適用 */
    if (ymdGuardWm >= HALL_WATER_MEASUREMENT_GUARD_START_YMD) {
      var wmChk = await checkHallWaterMeasurementCompleteForGuard(db, task.location_id, ymdGuardWm, null);
      if (!wmChk.ok) {
        return opsJson(
          {
            error: 'water_measurement_incomplete',
            message:
              '猫一覧の飲水測定（セット・計測）がすべて終わっていません。セット・計測を済ませてから完了／スキップしてください。',
            missing_cats: wmChk.missing_cats,
            missing_lines: wmChk.missing_lines,
            reference_date: ymdGuardWm,
          },
          409
        );
      }
    }
  }

  var now = jstNowIsoTimestamp();
  var rawSkipIn = body.reason != null ? body.reason : body.skip_reason;
  var skipReason = null;
  if (newStatus === 'skipped' && rawSkipIn != null && String(rawSkipIn).trim() !== '') {
    skipReason = String(rawSkipIn).trim();
  }
  var noteValue = body.note || task.note;

  if (skipReason && !noteValue) {
    noteValue = '[スキップ理由] ' + skipReason;
  } else if (skipReason && noteValue) {
    noteValue = noteValue + '\n[スキップ理由] ' + skipReason;
  }

  await db.prepare(
    "UPDATE tasks SET status = ?, completed_by = ?, completed_at = ?, note = ?, skip_reason = ? WHERE id = ? AND status = 'pending'"
  ).bind(newStatus, staffAuth.staffId, now, noteValue, skipReason, taskId).run();

  if (task.project_node_id) {
    var nodeStatus = newStatus === 'done' ? 'done' : 'skipped';
    await db.prepare(
      "UPDATE project_nodes SET status = ?, completed_by = ?, completed_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
    ).bind(nodeStatus, staffAuth.staffId, now, now, task.project_node_id).run();
  }

  var updated = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  return opsJson({ task: updated });
}

// ══════════════════════════════════════════════════════════════════════════════
//  完了取り消し（pending に戻す）
// ══════════════════════════════════════════════════════════════════════════════

async function undoTask(db, req, staffAuth, taskId) {
  var task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return opsJson({ error: 'not_found' }, 404);

  if (task.status === 'pending') {
    return opsJson({ error: 'already_pending', message: 'まだ完了していません' }, 400);
  }

  await db.prepare(
    "UPDATE tasks SET status = 'pending', completed_by = NULL, completed_at = NULL, skip_reason = NULL WHERE id = ?"
  ).bind(taskId).run();

  if (task.project_node_id) {
    await db.prepare(
      "UPDATE project_nodes SET status = 'pending', completed_by = NULL, completed_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
    ).bind(jstNowIsoTimestamp(), task.project_node_id).run();
  }

  var updated = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  return opsJson({ task: updated });
}

// ══════════════════════════════════════════════════════════════════════════════
//  タスク割当変更 / メモ追記
// ══════════════════════════════════════════════════════════════════════════════

async function assignTask(db, req, staffAuth, taskId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return opsJson({ error: 'not_found' }, 404);

  await db.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').bind(body.assigned_to || null, taskId).run();

  var updated = await db.prepare('SELECT t.*, s.name AS assigned_name FROM tasks t LEFT JOIN staff s ON t.assigned_to = s.id WHERE t.id = ?').bind(taskId).first();
  return opsJson({ task: updated });
}

async function appendTaskNote(db, req, staffAuth, taskId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return opsJson({ error: 'not_found' }, 404);

  var text = (body.note || '').trim();
  if (!text) return opsJson({ error: 'missing_fields', message: 'note は必須です' }, 400);

  var now = jstNowIsoTimestamp();
  var stamp = '[' + now.slice(0, 16).replace('T', ' ') + ' ' + (staffAuth.name || staffAuth.staffId) + '] ' + text;
  var newNote = task.note ? task.note + '\n' + stamp : stamp;
  await db.prepare('UPDATE tasks SET note = ? WHERE id = ?').bind(newNote, taskId).run();

  if (task.cat_id && body.also_cat_note) {
    await db.prepare(
      'INSERT OR IGNORE INTO cat_notes (cat_id, staff_id, note, category, related_task_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(task.cat_id, staffAuth.staffId, text, body.category || 'task', taskId).run();
  }

  var updated = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  return opsJson({ task: updated });
}

/**
 * 監視タスクのみ: pending / done / skipped を任意に設定（解決取り消し・再スキップ等）
 */
async function putMonitoringTaskStatus(db, req, staffAuth, taskId) {
  var body = {};
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var newStatus = String(body.status || '').trim();
  if (newStatus !== 'pending' && newStatus !== 'done' && newStatus !== 'skipped') {
    return opsJson({ error: 'invalid_status', message: 'status は pending, done, skipped のいずれかです' }, 400);
  }

  var task = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return opsJson({ error: 'not_found' }, 404);
  if (task.task_type !== 'monitoring') {
    return opsJson({ error: 'forbidden', message: '監視タスクのみステータスを変更できます' }, 403);
  }

  if (task.status === newStatus) {
    var unchanged = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
    return opsJson({ task: unchanged });
  }

  var now = jstNowIsoTimestamp();

  if (newStatus === 'pending') {
    await db.prepare(
      "UPDATE tasks SET status = 'pending', completed_by = NULL, completed_at = NULL, skip_reason = NULL WHERE id = ?"
    ).bind(taskId).run();
    if (task.project_node_id) {
      await db.prepare(
        "UPDATE project_nodes SET status = 'pending', completed_by = NULL, completed_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      ).bind(now, task.project_node_id).run();
    }
  } else {
    var skipReason = null;
    if (newStatus === 'skipped') {
      var rawSkip = body.reason != null ? body.reason : body.skip_reason;
      if (rawSkip != null && String(rawSkip).trim() !== '') skipReason = String(rawSkip).trim();
    }
    var noteValue = task.note;
    if (body.note != null && String(body.note) !== '') {
      noteValue = String(body.note);
    }
    if (skipReason && !noteValue) {
      noteValue = '[スキップ理由] ' + skipReason;
    } else if (skipReason && noteValue) {
      noteValue = noteValue + '\n[スキップ理由] ' + skipReason;
    }

    await db.prepare(
      "UPDATE tasks SET status = ?, completed_by = ?, completed_at = ?, note = ?, skip_reason = ? WHERE id = ?"
    ).bind(newStatus, staffAuth.staffId, now, noteValue, newStatus === 'skipped' ? skipReason : null, taskId).run();

    if (task.project_node_id) {
      var nodeSt = newStatus === 'done' ? 'done' : 'skipped';
      await db.prepare(
        "UPDATE project_nodes SET status = ?, completed_by = ?, completed_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      ).bind(nodeSt, staffAuth.staffId, now, now, task.project_node_id).run();
    }
  }

  var updated = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  return opsJson({ task: updated });
}

// ══════════════════════════════════════════════════════════════════════════════
//  プロジェクト CRUD
// ══════════════════════════════════════════════════════════════════════════════

async function getProjects(db, url, staffAuth) {
  var locationId = url.searchParams.get('location') || staffAuth.locationId;
  var statusFilter = url.searchParams.get('status') || 'active';

  var sql = 'SELECT * FROM projects WHERE 1=1';
  var params = [];
  if (locationId && locationId !== 'both') {
    sql += ' AND location_id = ?';
    params.push(locationId);
  }
  if (statusFilter !== 'all') {
    sql += ' AND status = ?';
    params.push(statusFilter);
  }
  sql += ' ORDER BY created_at DESC';

  var stmt = db.prepare(sql);
  if (params.length > 0) { stmt = stmt.bind.apply(stmt, params); }
  var result = await stmt.all();
  var projects = result.results || [];

  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    var stats = await db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM project_nodes WHERE project_id = ? AND node_type = 'task' AND deleted_at IS NULL"
    ).bind(p.id).first();
    p.progress = {
      total: stats.total || 0,
      done: stats.done || 0,
      pct: stats.total > 0 ? Math.round((stats.done || 0) / stats.total * 100) : 0,
    };
  }

  return opsJson({ projects: projects });
}

async function postProject(db, req, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var title = body.title;
  if (!title) return opsJson({ error: 'missing_fields', message: 'title は必須です' }, 400);

  var rawLoc = body.location_id || staffAuth.locationId;
  var locationId = (rawLoc === 'both') ? 'cafe' : rawLoc;

  var result = await db.prepare(
    'INSERT INTO projects (location_id, title, description, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(locationId, title, body.description || null, body.due_date || null, 'active', staffAuth.staffId).run();

  var project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(result.meta.last_row_id).first();
  return opsJson({ project: project }, 201);
}

async function deleteProject(db, req, staffAuth, projectId) {
  var project = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return opsJson({ error: 'not_found' }, 404);

  await db.prepare(
    "UPDATE tasks SET status = 'skipped', skip_reason = 'プロジェクト削除' WHERE project_node_id IN (SELECT id FROM project_nodes WHERE project_id = ?) AND status = 'pending'"
  ).bind(projectId).run();

  await db.prepare('DELETE FROM project_nodes WHERE project_id = ?').bind(projectId).run();
  await db.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();

  return opsJson({ deleted: true });
}

async function getProject(db, url, staffAuth, projectId) {
  var project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return opsJson({ error: 'not_found' }, 404);

  var nodesResult = await db.prepare(
    'SELECT pn.*, s.name AS assigned_name, s2.name AS completed_by_name FROM project_nodes pn LEFT JOIN staff s ON pn.assigned_to = s.id LEFT JOIN staff s2 ON pn.completed_by = s2.id WHERE pn.project_id = ? AND pn.deleted_at IS NULL ORDER BY pn.sort_order, pn.created_at'
  ).bind(projectId).all();
  var flatNodes = nodesResult.results || [];

  var stats = { total: 0, done: 0 };
  for (var i = 0; i < flatNodes.length; i++) {
    if (flatNodes[i].node_type === 'task') {
      stats.total++;
      if (flatNodes[i].status === 'done') stats.done++;
    }
  }
  project.progress = {
    total: stats.total,
    done: stats.done,
    pct: stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0,
  };

  var tree = buildTree(flatNodes);

  return opsJson({ project: project, nodes: tree });
}

function buildTree(flatNodes) {
  var map = {};
  for (var i = 0; i < flatNodes.length; i++) {
    var n = flatNodes[i];
    n.children = [];
    map[n.id] = n;
  }
  var roots = [];
  for (var j = 0; j < flatNodes.length; j++) {
    var node = flatNodes[j];
    if (node.parent_id && map[node.parent_id]) {
      map[node.parent_id].children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

async function putProject(db, req, staffAuth, projectId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var existing = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);

  var sets = [];
  var params = [];

  if (body.title !== undefined) { sets.push('title = ?'); params.push(body.title); }
  if (body.description !== undefined) { sets.push('description = ?'); params.push(body.description); }
  if (body.due_date !== undefined) { sets.push('due_date = ?'); params.push(body.due_date); }
  if (body.status !== undefined) { sets.push('status = ?'); params.push(body.status); }
  if (body.slack_channel_id !== undefined) { sets.push('slack_channel_id = ?'); params.push(body.slack_channel_id); }

  if (sets.length === 0) return opsJson({ error: 'no_fields' }, 400);

  params.push(projectId);
  var sql = 'UPDATE projects SET ' + sets.join(', ') + ' WHERE id = ?';
  var stmt = db.prepare(sql);
  stmt = stmt.bind.apply(stmt, params);
  await stmt.run();

  var project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
  return opsJson({ project: project });
}

// ══════════════════════════════════════════════════════════════════════════════
//  プロジェクトノード CRUD
// ══════════════════════════════════════════════════════════════════════════════

async function postNode(db, req, staffAuth, projectId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var project = await db.prepare('SELECT id, location_id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return opsJson({ error: 'project_not_found' }, 404);

  var title = body.title;
  var nodeType = body.node_type;
  if (!title || !nodeType || (nodeType !== 'thought' && nodeType !== 'task')) {
    return opsJson({ error: 'missing_fields', message: 'title, node_type (thought|task) は必須です' }, 400);
  }

  if (body.parent_id) {
    var depth = await getNodeDepth(db, body.parent_id);
    if (depth >= MAX_TREE_DEPTH) {
      return opsJson({ error: 'max_depth_exceeded', message: '最大 ' + MAX_TREE_DEPTH + ' 階層までです' }, 400);
    }
  }

  var defaultStatus = nodeType === 'thought' ? 'open' : 'pending';

  var result = await db.prepare(
    'INSERT INTO project_nodes (project_id, parent_id, node_type, title, body, assigned_to, due_date, priority, status, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    projectId, body.parent_id || null, nodeType, title, body.body || null,
    body.assigned_to || null, body.due_date || null, body.priority || 'normal',
    defaultStatus, body.sort_order || 0, staffAuth.staffId
  ).run();

  var nodeId = result.meta.last_row_id;
  var node = await db.prepare('SELECT * FROM project_nodes WHERE id = ?').bind(nodeId).first();

  if (nodeType === 'task' && body.due_date) {
    var pDue = normalizeOptionalYmd(body.due_date);
    await db.prepare(
      'INSERT INTO tasks (location_id, title, attribute, assigned_to, due_date, scheduled_date, deadline_date, priority, task_type, project_node_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(project.location_id, title, 'project', body.assigned_to || null, pDue, null, pDue, body.priority || 'normal', 'routine', nodeId, body.sort_order || 0).run();
  }

  return opsJson({ node: node }, 201);
}

async function getNodeDepth(db, nodeId) {
  var depth = 1;
  var current = nodeId;
  while (current && depth < MAX_TREE_DEPTH + 2) {
    var row = await db.prepare('SELECT parent_id FROM project_nodes WHERE id = ? AND deleted_at IS NULL').bind(current).first();
    if (!row || !row.parent_id) break;
    current = row.parent_id;
    depth++;
  }
  return depth;
}

async function putNode(db, req, staffAuth, projectId, nodeId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var node = await db.prepare('SELECT * FROM project_nodes WHERE id = ? AND project_id = ? AND deleted_at IS NULL').bind(nodeId, projectId).first();
  if (!node) return opsJson({ error: 'not_found' }, 404);

  var now = jstNowIsoTimestamp();
  var sets = [];
  var params = [];

  if (body.title !== undefined) { sets.push('title = ?'); params.push(body.title); }
  if (body.body !== undefined) { sets.push('body = ?'); params.push(body.body); }
  if (body.assigned_to !== undefined) { sets.push('assigned_to = ?'); params.push(body.assigned_to); }
  if (body.due_date !== undefined) { sets.push('due_date = ?'); params.push(body.due_date); }
  if (body.priority !== undefined) { sets.push('priority = ?'); params.push(body.priority); }
  if (body.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(body.sort_order); }
  if (body.parent_id !== undefined) {
    if (body.parent_id) {
      var depth = await getNodeDepth(db, body.parent_id);
      if (depth >= MAX_TREE_DEPTH) {
        return opsJson({ error: 'max_depth_exceeded' }, 400);
      }
    }
    sets.push('parent_id = ?'); params.push(body.parent_id);
  }

  if (body.status !== undefined) {
    sets.push('status = ?'); params.push(body.status);
    if (body.status === 'done' || body.status === 'skipped') {
      sets.push('completed_by = ?'); params.push(staffAuth.staffId);
      sets.push('completed_at = ?'); params.push(now);
    }
  }

  sets.push('updated_at = ?'); params.push(now);

  params.push(nodeId);
  params.push(projectId);
  var sql = 'UPDATE project_nodes SET ' + sets.join(', ') + ' WHERE id = ? AND project_id = ?';
  var stmt = db.prepare(sql);
  stmt = stmt.bind.apply(stmt, params);
  await stmt.run();

  if (body.status === 'done' || body.status === 'skipped') {
    var linkedTask = await db.prepare("SELECT id FROM tasks WHERE project_node_id = ? AND status = 'pending'").bind(nodeId).first();
    if (linkedTask) {
      await db.prepare(
        "UPDATE tasks SET status = ?, completed_by = ?, completed_at = ? WHERE id = ? AND status = 'pending'"
      ).bind(body.status, staffAuth.staffId, now, linkedTask.id).run();
    }
  }

  var updated = await db.prepare('SELECT * FROM project_nodes WHERE id = ?').bind(nodeId).first();
  return opsJson({ node: updated });
}

async function deleteNode(db, req, staffAuth, projectId, nodeId) {
  var node = await db.prepare('SELECT id FROM project_nodes WHERE id = ? AND project_id = ? AND deleted_at IS NULL').bind(nodeId, projectId).first();
  if (!node) return opsJson({ error: 'not_found' }, 404);

  var now = jstNowIsoTimestamp();
  await cascadeDelete(db, nodeId, now);

  return opsJson({ deleted: true });
}

async function cascadeDelete(db, nodeId, now) {
  await db.prepare('UPDATE project_nodes SET deleted_at = ? WHERE id = ?').bind(now, nodeId).run();

  var linkedTask = await db.prepare('SELECT id FROM tasks WHERE project_node_id = ?').bind(nodeId).first();
  if (linkedTask) {
    await db.prepare("UPDATE tasks SET status = 'skipped', skip_reason = 'ノード削除' WHERE id = ? AND status = 'pending'").bind(linkedTask.id).run();
  }

  var children = await db.prepare('SELECT id FROM project_nodes WHERE parent_id = ? AND deleted_at IS NULL').bind(nodeId).all();
  var childNodes = children.results || [];
  for (var i = 0; i < childNodes.length; i++) {
    await cascadeDelete(db, childNodes[i].id, now);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  業務終了（close-day）
// ══════════════════════════════════════════════════════════════════════════════

var LOCATION_LABELS = {
  cafe: 'BAKENEKO CAFE',
  nekomata: '猫又療養所',
};

/** D1 が INTEGER を bigint で返すため raw JSON.stringify(report) が落ちるのを防ぐ（daily_closures.report_json 用） */
function closeDayReportJsonStringify(report) {
  return JSON.stringify(report, function (_key, val) {
    if (typeof val === 'bigint') return Number(val);
    if (val !== val || val === Infinity || val === -Infinity) return null;
    return val;
  });
}

/** 献立・ログの meal_slot 正規化（猫一覧 overview と同じ考え方） */
function closeDayNormMealSlot(s) {
  if (s == null || s === '') return '';
  var x = String(s).toLowerCase().trim();
  if (x === '朝' || x === 'morning' || x === 'am') return 'morning';
  if (x === '昼' || x === 'afternoon' || x === 'noon' || x === 'lunch') return 'afternoon';
  if (x === '夜' || x === 'evening' || x === 'night' || x === 'pm' || x === '夕' || x === 'dinner') return 'evening';
  return x;
}

function closeDaySlotLabelJp(mealSlot) {
  var n = closeDayNormMealSlot(mealSlot);
  if (n === 'morning') return '☀朝';
  if (n === 'afternoon') return '🌤昼';
  if (n === 'evening') return '☾夜';
  if (n === 'snack') return '🍪おやつ';
  var raw = String(mealSlot || '').trim();
  return raw || '—';
}

function closeDayMedSlotLabel(scheduledAt) {
  var tail = String(scheduledAt || '').split('T')[1] || '';
  if (!tail) return '—';
  if (tail === '朝' || tail === '昼' || tail === '晩') return tail;
  return tail.length >= 5 ? tail.slice(0, 5) : tail;
}

var CLOSE_DAY_LIST_MAX = 20;
/** 業務終了レポート: ケア項目ごとに「最終実施」からこの暦日数以上空いたら掲載（×／ー は実施扱いにしない） */
var CLOSE_DAY_CARE_GAP_MIN_DAYS = 7;
/** 猫一覧ケアメニューと同じ7項目（dashboard DASH_CARE_SLOTS_ORDER + 爪切り・肉球） */
var CLOSE_DAY_CARE_ITEM_LABELS = ['ブラシ', 'アゴ', '耳', '爪切り', '肉球', 'お尻', '目ヤニ拭き'];

/**
 * 当日・拠点の medication_logs 集計（ダッシュボードと同じ暦日窓）
 */
async function buildCloseDayMedicationReport(db, locationId, date) {
  var dayAfter = jstCalendarAddDays(date, 1);
  var sql =
    'SELECT ml.id, ml.status, ml.scheduled_at, c.name AS cat_name, med.name AS medicine_name ' +
    'FROM medication_logs ml ' +
    'JOIN cats c ON ml.cat_id = c.id ' +
    'JOIN medications m ON ml.medication_id = m.id ' +
    'JOIN medicines med ON m.medicine_id = med.id ' +
    "WHERE c.location_id = ? AND ml.scheduled_at >= ? AND ml.scheduled_at < ? AND " + sqlStatusInCare('c') + " AND m.active = 1 " +
    'AND (m.frequency IS NULL OR trim(m.frequency) != \'必要時\') ' +
    'ORDER BY c.name, ml.scheduled_at';
  var res = await db.prepare(sql).bind(locationId, date, dayAfter).all();
  var rows = res.results || [];
  var total = rows.length;
  var done = 0;
  var skipped = 0;
  var pendingItems = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var st = r.status || 'pending';
    if (st === 'done') done++;
    else if (st === 'skipped') skipped++;
    else {
      pendingItems.push({
        cat_name: r.cat_name || '—',
        slot_label: closeDayMedSlotLabel(r.scheduled_at),
        medicine_name: r.medicine_name || '—',
      });
    }
  }
  return { total: total, done: done, skipped: skipped, pending_items: pendingItems };
}

/**
 * 当日・拠点の献立に対し、あげた／残しが未完了の行（overview の fed / eaten 判定に準拠）
 */
async function buildCloseDayFeedingReport(db, locationId, date) {
  var fpRes = await db
    .prepare(
      'SELECT fp.id AS plan_id, fp.cat_id, fp.meal_slot, fp.meal_order, c.name AS cat_name FROM feeding_plans fp ' +
        'JOIN cats c ON fp.cat_id = c.id WHERE fp.active = 1 AND c.location_id = ? AND ' + sqlStatusInCare('c')
    )
    .bind(locationId)
    .all();
  var plans = fpRes.results || [];
  if (plans.length === 0) {
    return { plan_count: 0, incomplete_count: 0, incomplete_items: [] };
  }

  var flRes = await db
    .prepare(
      'SELECT fl.plan_id, fl.cat_id, fl.meal_slot, fl.eaten_pct, fl.remaining_g FROM feeding_logs fl ' +
        'JOIN cats c ON fl.cat_id = c.id WHERE fl.log_date = ? AND c.location_id = ? AND ' + sqlStatusInCare('c')
    )
    .bind(date, locationId)
    .all();
  var logs = flRes.results || [];

  var slotCountByNorm = {};
  for (var si = 0; si < plans.length; si++) {
    var pn0 = closeDayNormMealSlot(plans[si].meal_slot);
    if (pn0) slotCountByNorm[pn0] = (slotCountByNorm[pn0] || 0) + 1;
  }

  var incomplete = [];
  for (var pi = 0; pi < plans.length; pi++) {
    var fpItem = plans[pi];
    var cid = fpItem.cat_id;
    var catLogs = [];
    for (var lj = 0; lj < logs.length; lj++) {
      if (logs[lj].cat_id === cid) catLogs.push(logs[lj]);
    }
    var fedLine = false;
    var eatenPct = null;
    var remainingG = null;
    var pid = fpItem.plan_id;
    if (pid != null) {
      for (var li = 0; li < catLogs.length; li++) {
        var lg = catLogs[li];
        if (lg.plan_id != null && Number(lg.plan_id) === Number(pid)) {
          fedLine = true;
          if (lg.eaten_pct != null) eatenPct = lg.eaten_pct;
          if (lg.remaining_g != null) remainingG = lg.remaining_g;
          break;
        }
      }
    }
    if (!fedLine) {
      var pnorm = closeDayNormMealSlot(fpItem.meal_slot);
      var allowSlot = pnorm && (slotCountByNorm[pnorm] || 0) === 1;
      if (allowSlot) {
        for (var li2 = 0; li2 < catLogs.length; li2++) {
          var lg2 = catLogs[li2];
          if (closeDayNormMealSlot(lg2.meal_slot) === pnorm) {
            fedLine = true;
            if (lg2.eaten_pct != null) eatenPct = lg2.eaten_pct;
            if (lg2.remaining_g != null) remainingG = lg2.remaining_g;
            break;
          }
        }
      }
    }
    var slotLabel = closeDaySlotLabelJp(fpItem.meal_slot);
    if (!fedLine) {
      incomplete.push({ cat_name: fpItem.cat_name || '—', slot_label: slotLabel, detail: '未記録' });
      continue;
    }
    if (eatenPct == null && remainingG == null) {
      incomplete.push({
        cat_name: fpItem.cat_name || '—',
        slot_label: slotLabel,
        detail: '摂取未確認（あげた／残し未記入）',
      });
    }
  }

  return { plan_count: plans.length, incomplete_count: incomplete.length, incomplete_items: incomplete };
}

/** closingDate 基準日から見た暦日差（日）例: last=3/27, closing=3/29 → 2 */
function closeDayCalendarDiffDays(lastYmd, closingYmd) {
  if (!lastYmd || !closingYmd || lastYmd.length < 10 || closingYmd.length < 10) return 0;
  var a = new Date(lastYmd + 'T12:00:00+09:00').getTime();
  var b = new Date(closingYmd + 'T12:00:00+09:00').getTime();
  return Math.round((b - a) / 86400000);
}

function closeDayFmtMd(ymd) {
  if (!ymd || ymd.length < 10) return '';
  var m = parseInt(ymd.slice(5, 7), 10);
  var d = parseInt(ymd.slice(8, 10), 10);
  return m + '/' + d;
}

/**
 * 排便・排尿が「業務終了日」時点で2日以上入っていない猫（最終記録からの経過日数付き）
 * 経過2日 = 最終記録日の翌日・翌々日に記録なし（例: 最終3/27・終了3/29 → 経過2日）
 */
async function buildCloseDayExcretionGaps(db, locationId, closingDate) {
  var catSql =
    "SELECT id, name FROM cats WHERE location_id = ? AND " + sqlStatusInCare() + " ORDER BY name";
  var catsRes = await db.prepare(catSql).bind(locationId).all();
  var cats = catsRes.results || [];
  if (cats.length === 0) {
    return { stool_gaps: [], urine_gaps: [] };
  }

  var stoolRes = await db
    .prepare(
      "SELECT cat_id, MAX(record_date) AS last_date FROM health_records WHERE record_type = 'stool' " +
        "AND cat_id IN (SELECT id FROM cats WHERE location_id = ? AND " + sqlStatusInCare() + ") " +
        'GROUP BY cat_id'
    )
    .bind(locationId)
    .all();
  var urineRes = await db
    .prepare(
      "SELECT cat_id, MAX(record_date) AS last_date FROM health_records WHERE record_type IN ('urine', 'urination') " +
        "AND cat_id IN (SELECT id FROM cats WHERE location_id = ? AND " + sqlStatusInCare() + ") " +
        'GROUP BY cat_id'
    )
    .bind(locationId)
    .all();

  var stoolMap = {};
  var sr = stoolRes.results || [];
  for (var si = 0; si < sr.length; si++) stoolMap[sr[si].cat_id] = sr[si].last_date;
  var urineMap = {};
  var ur = urineRes.results || [];
  for (var ui = 0; ui < ur.length; ui++) urineMap[ur[ui].cat_id] = ur[ui].last_date;

  var stoolGaps = [];
  var urineGaps = [];
  for (var ci = 0; ci < cats.length; ci++) {
    var c = cats[ci];
    var ls = stoolMap[c.id];
    var gapS = ls ? closeDayCalendarDiffDays(ls, closingDate) : null;
    if (ls == null || gapS >= 2) {
      stoolGaps.push({
        cat_id: c.id,
        cat_name: c.name,
        last_record_date: ls || null,
        days_since_last: ls != null ? gapS : null,
        no_record: ls == null,
      });
    }
    var lu = urineMap[c.id];
    var gapU = lu ? closeDayCalendarDiffDays(lu, closingDate) : null;
    if (lu == null || gapU >= 2) {
      urineGaps.push({
        cat_id: c.id,
        cat_name: c.name,
        last_record_date: lu || null,
        days_since_last: lu != null ? gapU : null,
        no_record: lu == null,
      });
    }
  }

  function sortGaps(arr) {
    arr.sort(function (a, b) {
      var na = a.no_record ? 10000 : (a.days_since_last != null ? a.days_since_last : 0);
      var nb = b.no_record ? 10000 : (b.days_since_last != null ? b.days_since_last : 0);
      if (na !== nb) return nb - na;
      return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
    });
  }
  sortGaps(stoolGaps);
  sortGaps(urineGaps);

  return { stool_gaps: stoolGaps, urine_gaps: urineGaps };
}

function closeDayCareDetailLabelForSummary(details) {
  if (details == null || details === '') return '';
  var s = details;
  if (typeof s === 'string' && s.charAt(0) === '"') {
    try {
      s = JSON.parse(s);
    } catch (e) {
      /* 生テキスト */
    }
  }
  if (typeof s === 'object' && s && s.label) return String(s.label).trim();
  return String(details).trim();
}

function closeDayCareSlotKeyFromRow(recordType, details) {
  var rt = recordType || '';
  var lbl = closeDayCareDetailLabelForSummary(details);
  if (rt === 'eye_discharge' && !lbl) lbl = '目ヤニ拭き';
  return rt + '|' + lbl;
}

function closeDayCareSlotKeyForLabel(jaLabel) {
  if (jaLabel === '目ヤニ拭き') return 'eye_discharge|目ヤニ拭き';
  return 'care|' + jaLabel;
}

/**
 * ケア実施（項目別）: 各項目の「最終実施」record_date が基準日から見て {CLOSE_DAY_CARE_GAP_MIN_DAYS} 日以上前（実施のみ。×／ー除外）。
 * 一度も実施が無い項目は cats.created_at を起点に同基準。
 * @param {string|null|undefined} dashboardStatusFilter — ダッシュボード GET status= のみ渡す。未指定・null・'' は在籍（in_care）のみ（業務終了と同じ）。
 */
async function buildCloseDayCareItemGaps(db, locationId, closingDate, dashboardStatusFilter) {
  var useDashStatus =
    dashboardStatusFilter !== undefined &&
    dashboardStatusFilter !== null &&
    String(dashboardStatusFilter).trim() !== '';
  var catStatusExpr = useDashStatus ? sqlStatusCondition(dashboardStatusFilter) : sqlStatusInCare();
  var catStatusExprC = useDashStatus ? sqlStatusCondition(dashboardStatusFilter, 'c') : sqlStatusInCare('c');

  var catSql =
    'SELECT id, name, created_at FROM cats WHERE ' +
    (locationId ? 'location_id = ? AND ' : "location_id IN ('cafe','nekomata','endo','azukari') AND ") +
    catStatusExpr +
    ' ORDER BY name';
  var catsRes = locationId ? await db.prepare(catSql).bind(locationId).all() : await db.prepare(catSql).all();
  var cats = catsRes.results || [];
  if (cats.length === 0) {
    return { items: [], threshold_days: CLOSE_DAY_CARE_GAP_MIN_DAYS };
  }

  var careSql =
    'SELECT hr.cat_id, hr.record_type, hr.details, hr.record_date, hr.value ' +
    'FROM health_records hr ' +
    'JOIN cats c ON hr.cat_id = c.id ' +
    'WHERE ' +
    catStatusExprC +
    " AND hr.record_type IN ('care','eye_discharge')";
  if (locationId) {
    careSql += ' AND c.location_id = ?';
  } else {
    careSql += " AND c.location_id IN ('cafe','nekomata','endo','azukari')";
  }
  var rowsRes = locationId ? await db.prepare(careSql).bind(locationId).all() : await db.prepare(careSql).all();
  var rows = rowsRes.results || [];

  var canonMap = {};
  for (var cx = 0; cx < CLOSE_DAY_CARE_ITEM_LABELS.length; cx++) {
    canonMap[closeDayCareSlotKeyForLabel(CLOSE_DAY_CARE_ITEM_LABELS[cx])] = true;
  }

  var maxByCat = {};
  for (var ri = 0; ri < rows.length; ri++) {
    var rw = rows[ri];
    var val = rw.value != null ? String(rw.value).trim() : '';
    if (val === '×' || val === 'ー') continue;
    var sk = closeDayCareSlotKeyFromRow(rw.record_type, rw.details);
    if (!canonMap[sk]) continue;
    var ymd = rw.record_date ? String(rw.record_date).slice(0, 10) : '';
    if (ymd.length !== 10) continue;
    var cid = rw.cat_id;
    if (!maxByCat[cid]) maxByCat[cid] = {};
    var prev = maxByCat[cid][sk];
    if (!prev || ymd > prev) maxByCat[cid][sk] = ymd;
  }

  var items = [];
  for (var ki = 0; ki < cats.length; ki++) {
    var cat = cats[ki];
    var catMap = maxByCat[cat.id] || {};
    var catCreated = cat.created_at ? String(cat.created_at).slice(0, 10) : closingDate;
    if (catCreated.length !== 10) catCreated = closingDate;
    for (var li = 0; li < CLOSE_DAY_CARE_ITEM_LABELS.length; li++) {
      var label = CLOSE_DAY_CARE_ITEM_LABELS[li];
      var slotK = closeDayCareSlotKeyForLabel(label);
      var last = catMap[slotK];
      if (last && last.length === 10) {
        var gap = closeDayCalendarDiffDays(last, closingDate);
        if (gap >= CLOSE_DAY_CARE_GAP_MIN_DAYS) {
          items.push({
            cat_id: cat.id,
            cat_name: cat.name,
            item_label: label,
            last_record_date: last,
            days_since_last: gap,
            no_record: false,
          });
        }
      } else {
        var gapN = closeDayCalendarDiffDays(catCreated, closingDate);
        if (gapN >= CLOSE_DAY_CARE_GAP_MIN_DAYS) {
          items.push({
            cat_id: cat.id,
            cat_name: cat.name,
            item_label: label,
            last_record_date: null,
            days_since_last: gapN,
            no_record: true,
          });
        }
      }
    }
  }

  items.sort(function (a, b) {
    var da = a.days_since_last != null ? a.days_since_last : 0;
    var db = b.days_since_last != null ? b.days_since_last : 0;
    if (db !== da) return db - da;
    var nc = String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
    if (nc !== 0) return nc;
    return String(a.item_label || '').localeCompare(String(b.item_label || ''), 'ja');
  });

  return { items: items, threshold_days: CLOSE_DAY_CARE_GAP_MIN_DAYS };
}

/**
 * はき戻し（嘔吐）: health_records の vomiting + observation 内のはき戻し/嘔吐表現
 * 直近7暦日（終了日を含む）の猫別件数・終了日の記録・当日までの連続記録日数
 */
async function buildCloseDayVomitingReport(db, locationId, closingDate) {
  var weekStart = jstCalendarAddDays(closingDate, -6);
  var sql =
    'SELECT hr.cat_id, hr.record_date, c.name AS cat_name ' +
    'FROM health_records hr ' +
    'JOIN cats c ON hr.cat_id = c.id ' +
    "WHERE c.location_id = ? AND " + sqlStatusInCare('c') + " " +
    'AND hr.record_date >= ? AND hr.record_date <= ? ' +
    'AND (hr.record_type = \'vomiting\' OR (hr.record_type = \'observation\' AND ( ' +
    "COALESCE(hr.value, '') LIKE '%はき戻し%' OR COALESCE(hr.value, '') LIKE '%嘔吐%' OR COALESCE(hr.value, '') LIKE '%吐いた%' " +
    "OR COALESCE(hr.details, '') LIKE '%はき戻し%' OR COALESCE(hr.details, '') LIKE '%嘔吐%' OR COALESCE(hr.details, '') LIKE '%吐いた%' " +
    '))) ' +
    'ORDER BY c.name, hr.record_date, hr.id';
  var res = await db.prepare(sql).bind(locationId, weekStart, closingDate).all();
  var rows = res.results || [];

  var byCat = {};
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var cid = row.cat_id;
    if (!byCat[cid]) {
      byCat[cid] = { cat_id: cid, cat_name: row.cat_name || '—', dates: {}, todayCount: 0, weekRows: 0 };
    }
    byCat[cid].weekRows++;
    var ymd = row.record_date ? String(row.record_date).slice(0, 10) : '';
    if (ymd.length === 10) {
      byCat[cid].dates[ymd] = true;
      if (ymd === closingDate) byCat[cid].todayCount++;
    }
  }

  var perCat = [];
  for (var k in byCat) {
    if (!Object.prototype.hasOwnProperty.call(byCat, k)) continue;
    var ent = byCat[k];
    var streak = 0;
    var streakDatesAsc = [];
    var cur = closingDate;
    var guard = 0;
    while (ent.dates[cur] && guard < 400) {
      streak++;
      streakDatesAsc.push(cur);
      cur = jstCalendarAddDays(cur, -1);
      guard++;
    }
    streakDatesAsc.reverse();
    var distinctDays = 0;
    for (var dk in ent.dates) {
      if (Object.prototype.hasOwnProperty.call(ent.dates, dk)) distinctDays++;
    }
    perCat.push({
      cat_id: ent.cat_id,
      cat_name: ent.cat_name,
      week_count: ent.weekRows,
      distinct_days: distinctDays,
      today_count: ent.todayCount,
      streak_ending_close: streak,
      streak_dates_ymd: streakDatesAsc,
    });
  }
  perCat.sort(function (a, b) {
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });

  return {
    week_start: weekStart,
    week_end: closingDate,
    per_cat: perCat,
  };
}

/** 業務終了レポート用: 病院系 record_type（猫詳細「病院記録」scope=clinic に準拠） */
var CLOSE_DAY_CLINIC_TYPES_IN_SQL =
  "('vaccine','checkup','surgery','dental','emergency','test','observation','medication_start','medication_end')";

function closeDayClinicTypeLabelJp(recordType) {
  var m = {
    vaccine: 'ワクチン',
    checkup: '健康診断',
    surgery: '手術',
    dental: '歯科',
    emergency: '緊急受診',
    test: '検査',
    observation: '経過観察',
    medication_start: '投薬開始',
    medication_end: '投薬終了',
  };
  var t = recordType || '';
  return m[t] || t || '病院';
}

function closeDayOneLineText(s, maxLen) {
  if (s == null || s === '') return '';
  var x = String(s).replace(/\s+/g, ' ').trim();
  var n = maxLen || 80;
  if (x.length <= n) return x;
  return x.slice(0, n - 1) + '…';
}

async function buildCloseDayClinicReport(db, locationId, closingDate) {
  var horizonEnd = jstCalendarAddDays(closingDate, 14);

  var upcomingSql =
    'SELECT hr.id, hr.cat_id, c.name AS cat_name, hr.record_type, hr.next_due, hr.booked_date, hr.value ' +
    'FROM health_records hr JOIN cats c ON hr.cat_id = c.id ' +
    "WHERE c.location_id = ? AND " + sqlStatusInCare('c') + " " +
    'AND hr.next_due IS NOT NULL AND hr.next_due >= ? AND hr.next_due <= ? ' +
    'AND hr.record_type IN ' +
    CLOSE_DAY_CLINIC_TYPES_IN_SQL +
    ' ORDER BY hr.next_due, c.name, hr.id';
  var upRes = await db.prepare(upcomingSql).bind(locationId, closingDate, horizonEnd).all();
  var upcoming = [];
  var ur = upRes.results || [];
  for (var ui = 0; ui < ur.length; ui++) {
    var u = ur[ui];
    var nd = u.next_due ? String(u.next_due).slice(0, 10) : '';
    upcoming.push({
      cat_name: u.cat_name || '—',
      record_type: u.record_type,
      type_label: closeDayClinicTypeLabelJp(u.record_type),
      next_due: nd,
      booked_date: u.booked_date || null,
      value_short: closeDayOneLineText(u.value, 72),
      days_from_close: nd.length === 10 ? jstCalendarDiffDays(closingDate, nd) : null,
    });
  }

  var catsSql =
    "SELECT id, name FROM cats WHERE location_id = ? AND " + sqlStatusInCare() + " ORDER BY name";
  var catsRes = await db.prepare(catsSql).bind(locationId).all();
  var allCats = catsRes.results || [];

  var futureDistSql =
    'SELECT DISTINCT hr.cat_id FROM health_records hr JOIN cats c ON hr.cat_id = c.id ' +
    "WHERE c.location_id = ? AND " + sqlStatusInCare('c') + " " +
    'AND hr.next_due IS NOT NULL AND hr.next_due >= ? AND hr.record_type IN ' +
    CLOSE_DAY_CLINIC_TYPES_IN_SQL;
  var futRes = await db.prepare(futureDistSql).bind(locationId, closingDate).all();
  var hasFuture = {};
  var fr = futRes.results || [];
  for (var fi = 0; fi < fr.length; fi++) hasFuture[fr[fi].cat_id] = true;

  var cats_without_future_due = [];
  for (var ci = 0; ci < allCats.length; ci++) {
    var ac = allCats[ci];
    if (!hasFuture[ac.id]) cats_without_future_due.push({ cat_id: ac.id, cat_name: ac.name || '—' });
  }

  var todayRecSql =
    'SELECT hr.id, hr.cat_id, c.name AS cat_name, hr.record_type, hr.record_date, hr.value, hr.booked_date, hr.next_due ' +
    'FROM health_records hr JOIN cats c ON hr.cat_id = c.id ' +
    "WHERE c.location_id = ? AND " + sqlStatusInCare('c') + " " +
    'AND substr(hr.record_date,1,10) = ? AND hr.record_type IN ' +
    CLOSE_DAY_CLINIC_TYPES_IN_SQL +
    ' ORDER BY c.name, hr.id';
  var trRes = await db.prepare(todayRecSql).bind(locationId, closingDate).all();
  var clinic_records_today = [];
  var tr = trRes.results || [];
  for (var ti = 0; ti < tr.length; ti++) {
    var row = tr[ti];
    clinic_records_today.push({
      cat_name: row.cat_name || '—',
      record_type: row.record_type,
      type_label: closeDayClinicTypeLabelJp(row.record_type),
      value_short: closeDayOneLineText(row.value, 72),
      booked_date: row.booked_date || null,
      next_due: row.next_due ? String(row.next_due).slice(0, 10) : null,
    });
  }

  var dPrev = jstCalendarAddDays(closingDate, -1);
  var dNext = jstCalendarAddDays(closingDate, 1);
  var notesSql =
    'SELECT n.id, n.cat_id, c.name AS cat_name, n.note, n.category, n.created_at FROM cat_notes n ' +
    'JOIN cats c ON n.cat_id = c.id ' +
    "WHERE c.location_id = ? AND " + sqlStatusInCare('c') + " " +
    "AND n.category NOT IN ('feeding', 'nutrition') " +
    'AND substr(n.created_at, 1, 10) IN (?, ?, ?) ' +
    'ORDER BY c.name, n.created_at DESC';
  var notesRes = await db.prepare(notesSql).bind(locationId, dPrev, closingDate, dNext).all();
  var cat_notes_today = [];
  var nrows = notesRes.results || [];
  for (var ni = 0; ni < nrows.length; ni++) {
    var nw = nrows[ni];
    if (jstCalendarYmdFromParsedIso(nw.created_at) !== closingDate) continue;
    cat_notes_today.push({
      cat_name: nw.cat_name || '—',
      category: nw.category || 'general',
      note_short: closeDayOneLineText(nw.note, 100),
    });
  }

  var upcoming_without_booking = 0;
  for (var vi = 0; vi < upcoming.length; vi++) {
    if (!upcoming[vi].booked_date || String(upcoming[vi].booked_date).trim() === '') upcoming_without_booking++;
  }

  return {
    window_label_start: closingDate,
    window_label_end: horizonEnd,
    upcoming: upcoming,
    upcoming_without_booking_count: upcoming_without_booking,
    cats_without_future_due: cats_without_future_due,
    active_cat_count: allCats.length,
    clinic_records_today: clinic_records_today,
    cat_notes_today: cat_notes_today,
  };
}

async function closeDayPreview(db, env, url, staffAuth) {
  var locationId = url.searchParams.get('location') || staffAuth.locationId;
  if (locationId === 'both') return opsJson({ error: 'location_required', message: '拠点を選択してください' }, 400);

  var date = url.searchParams.get('date') || jstCalendarYmdFromInstant();

  var existing = await db.prepare(
    'SELECT id FROM daily_closures WHERE location_id = ? AND closed_date = ?'
  ).bind(locationId, date).first();
  if (existing) return opsJson({ error: 'already_closed', message: 'この拠点は本日すでに業務終了済みです' });

  var pending = await db.prepare(
    'SELECT t.*, c.name AS cat_name, s.name AS assigned_name FROM tasks t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE t.location_id = ? AND ' +
      TASK_LIST_DAY_EQ_SQL_T +
      " = ? AND t.status = 'pending' AND COALESCE(t.task_type, 'routine') != 'event' ORDER BY t.sort_order, t.title"
  ).bind(locationId, date).all();
  var pendingTasks = await filterTaskRowsByTemplateRecurrence(db, pending.results || [], date);

  var ongoingEvents = await db.prepare(
    'SELECT t.*, c.name AS cat_name, s.name AS assigned_name FROM tasks t LEFT JOIN cats c ON t.cat_id = c.id LEFT JOIN staff s ON t.assigned_to = s.id WHERE t.location_id = ? AND t.task_type = \'event\' AND t.status IN (\'pending\', \'in_progress\') AND ' +
      TASK_EVENT_DUE_SQL_T +
      ' <= ? ORDER BY ' +
      TASK_EVENT_DUE_SQL_T +
      ' ASC, t.sort_order, t.title'
  ).bind(locationId, date).all();

  /** 週次・月次の非該当タスクは分母・分子から除外（一覧と同一） */
  var statsBase = await db
    .prepare(
      "SELECT id, status, template_id, task_type FROM tasks WHERE location_id = ? AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ? AND COALESCE(task_type, 'routine') != 'event'"
    )
    .bind(locationId, date)
    .all();
  var statsRows = await filterTaskRowsByTemplateRecurrence(db, statsBase.results || [], date);
  var doneCnt = 0;
  var totalActiveCnt = 0;
  var skippedCnt = 0;
  for (var si = 0; si < statsRows.length; si++) {
    var sr = statsRows[si];
    var stt = sr.task_type || 'routine';
    if (stt === 'monitoring') {
      if (sr.status === 'skipped') skippedCnt++;
      continue;
    }
    if (sr.status === 'done') doneCnt++;
    if (sr.status === 'pending' || sr.status === 'done') totalActiveCnt++;
    if (sr.status === 'skipped') skippedCnt++;
  }

  /** 事前スキップを分母から除く: 完了率は「未スキップのうち何件完了」＝ done / (done+pending) */
  var totalActive = { cnt: totalActiveCnt };

  /** 監視タスクの事前スキップも含む（従来 monitoring 除外で 0 件化していた） */
  var skippedAlreadyCnt = { cnt: skippedCnt };

  var skippedBeforeRes = await db.prepare(
    'SELECT t.id, t.title, t.skip_reason, t.skip_streak, t.note, t.template_id, t.task_type, c.name AS cat_name FROM tasks t LEFT JOIN cats c ON t.cat_id = c.id WHERE t.location_id = ? AND ' +
      TASK_LIST_DAY_EQ_SQL_T +
      " = ? AND t.status = 'skipped' AND COALESCE(t.task_type, 'routine') != 'event' ORDER BY t.sort_order, t.title"
  ).bind(locationId, date).all();

  var done = { cnt: doneCnt };

  var skipStreakTasks = [];
  var ongoingEventRows = ongoingEvents.results || [];
  for (var oei = 0; oei < ongoingEventRows.length; oei++) {
    var oe = ongoingEventRows[oei];
    var oeDueRaw = oe.deadline_date || oe.due_date;
    var oeDue = oeDueRaw ? String(oeDueRaw).slice(0, 10) : '';
    if (oeDue.length === 10) {
      var od = jstCalendarDiffDays(oeDue, date);
      oe.event_days_open = od > 0 ? od : 0;
    } else {
      oe.event_days_open = 0;
    }
  }
  for (var i = 0; i < pendingTasks.length; i++) {
    var t = pendingTasks[i];
    if (t.skip_streak > 0) {
      skipStreakTasks.push({ id: t.id, title: t.title, skip_streak: t.skip_streak });
    }
  }

  var skippedBeforeRaw = await filterTaskRowsByTemplateRecurrence(db, skippedBeforeRes.results || [], date);
  var skippedBeforeTasks = [];
  for (var sbi = 0; sbi < skippedBeforeRaw.length; sbi++) {
    var sbr = skippedBeforeRaw[sbi];
    var reasonDisp = resolveTaskSkipReason(sbr);
    skippedBeforeTasks.push({
      id: sbr.id,
      title: sbr.title,
      skip_reason: reasonDisp || '（理由未記録）',
      skip_streak: sbr.skip_streak,
      /** 業務終了確定時に +1 される（日中スキップ分を連続カウントに含める） */
      skip_streak_after_close: (sbr.skip_streak || 0) + 1,
      cat_name: sbr.cat_name,
    });
  }

  var catSummary = await buildCatSummary(db, locationId);
  var medicationCloseDay = await buildCloseDayMedicationReport(db, locationId, date);
  var feedingCloseDay = await buildCloseDayFeedingReport(db, locationId, date);
  var excretionCloseDay = await buildCloseDayExcretionGaps(db, locationId, date);
  var careItemGapsCloseDay = await buildCloseDayCareItemGaps(db, locationId, date);
  var vomitingCloseDay = await buildCloseDayVomitingReport(db, locationId, date);
  var clinicCloseDay = await buildCloseDayClinicReport(db, locationId, date);
  var weightLossCloseDay = await buildCloseDayWeightLossReport(db, locationId);
  var appetiteLowCloseDay = await buildCloseDayLowAppetiteReport(db, locationId, date);
  var waterCloseDay = await buildCloseDayWaterReport(db, locationId, date);

  return opsJson({
    location_id: locationId,
    location_label: LOCATION_LABELS[locationId] || locationId,
    date: date,
    pending_tasks: pendingTasks,
    stats: {
      total: totalActive ? totalActive.cnt : 0,
      done: done ? done.cnt : 0,
      pending: pendingTasks.length,
      skipped_before_close: skippedAlreadyCnt ? skippedAlreadyCnt.cnt : 0,
    },
    skipped_before_tasks: skippedBeforeTasks,
    skip_streak_warnings: skipStreakTasks,
    ongoing_event_tasks: ongoingEventRows,
    event_tasks_note: 'イベントタスクは業務終了ではスキップされません。完了またはスキップするまで一覧に残ります。',
    cat_summary: catSummary,
    medication_close_day: medicationCloseDay,
    feeding_close_day: feedingCloseDay,
    excretion_close_day: excretionCloseDay,
    care_item_gaps_close_day: careItemGapsCloseDay,
    vomiting_close_day: vomitingCloseDay,
    clinic_close_day: clinicCloseDay,
    weight_loss_close_day: weightLossCloseDay,
    appetite_low_close_day: appetiteLowCloseDay,
    water_close_day: waterCloseDay,
  });
}

/**
 * 業務終了・深夜自動クローズ共通: スキップしたタスクを翌日分として 1 行 INSERT（carried_from_id 付き）。
 * cron の autoClosePendingDays と同じルール。template_id 行が翌日既にある場合はスキップ。
 * @returns {Promise<boolean>} 挿入したら true
 */
async function closeDayInsertCarryForTomorrow(db, task, streak, tomorrowYmd) {
  if (!task) return false;

  var tmplId = task.template_id != null && task.template_id !== '' ? task.template_id : null;
  if (tmplId) {
    var dupCheck = await db
      .prepare(
        'SELECT id FROM tasks WHERE template_id = ? AND COALESCE(scheduled_date, deadline_date, due_date) = ?'
      )
      .bind(tmplId, tomorrowYmd)
      .first();
    if (dupCheck) return false;
  }

  var acExpires =
    (task.task_type || 'routine') === 'monitoring' && task.expires_at ? task.expires_at : null;
  var cSched = null;
  var cDead = task.deadline_date || null;
  var cList = tomorrowYmd;
  if ((task.task_type || 'routine') === 'event') {
    cSched = task.scheduled_date || null;
    cDead = task.deadline_date || task.due_date || null;
    cList = cSched || cDead || tomorrowYmd;
  } else {
    cSched = tomorrowYmd;
  }

  await db
    .prepare(
      'INSERT INTO tasks (template_id, location_id, title, attribute, cat_id, assigned_to, due_date, scheduled_date, deadline_date, due_time, priority, sort_order, task_type, skip_streak, carried_from_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      tmplId,
      task.location_id,
      task.title,
      task.attribute,
      task.cat_id,
      task.assigned_to,
      cList,
      cSched,
      cDead,
      task.due_time,
      task.priority,
      task.sort_order || 0,
      task.task_type || 'routine',
      streak,
      task.id,
      acExpires
    )
    .run();
  return true;
}

async function closeDayExecute(db, env, req, staffAuth, ctx) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var locationId = body.location_id;
  if (!locationId || locationId === 'both') return opsJson({ error: 'location_required', message: '拠点を選択してください' }, 400);

  var date = body.date || jstCalendarYmdFromInstant();
  var skipReasons = body.skip_reasons || [];
  var specialNotes = body.special_notes || '';

  var existing = await db.prepare(
    'SELECT id FROM daily_closures WHERE location_id = ? AND closed_date = ?'
  ).bind(locationId, date).first();
  if (existing) return opsJson({ error: 'already_closed', message: '本日はすでに業務終了済みです' });

  var pendingResult = await db.prepare(
    'SELECT * FROM tasks WHERE location_id = ? AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ? AND status = \'pending\' AND COALESCE(task_type, \'routine\') != \'event\''
  ).bind(locationId, date).all();
  var pendingTasks = await filterTaskRowsByTemplateRecurrence(db, pendingResult.results || [], date);

  var skippedBeforeStart = await db.prepare(
    'SELECT * FROM tasks WHERE location_id = ? AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ? AND status = \'skipped\' AND COALESCE(task_type, \'routine\') != \'event\' ORDER BY sort_order, title'
  ).bind(locationId, date).all();
  var skippedBeforeRows = await filterTaskRowsByTemplateRecurrence(db, skippedBeforeStart.results || [], date);

  var reasonMap = {};
  for (var r = 0; r < skipReasons.length; r++) {
    reasonMap[skipReasons[r].task_id] = skipReasons[r].reason || '未入力';
  }

  var now = jstNowIsoTimestamp();
  var tomorrow = nextDate(date);
  var carriedCount = 0;
  var skippedForReport = [];

  for (var i = 0; i < pendingTasks.length; i++) {
    var task = pendingTasks[i];
    var reason = reasonMap[task.id] || '未入力';
    var streak = (task.skip_streak || 0) + 1;

    await db.prepare(
      "UPDATE tasks SET status = 'skipped', skip_reason = ?, completed_by = ?, completed_at = ?, skip_streak = ? WHERE id = ?"
    ).bind(reason, staffAuth.staffId, now, streak, task.id).run();

    skippedForReport.push({
      title: task.title,
      reason: reason && String(reason).trim() ? String(reason).trim() : '（理由未記録）',
      skip_streak: streak,
    });

    var insertedP = await closeDayInsertCarryForTomorrow(db, task, streak, tomorrow);
    if (insertedP) carriedCount++;
  }

  /** 日中に「スキップ」済みのタスクも、業務終了時に skip_streak +1 と翌日繰越を pending と同様に行う */
  var skippedBeforeReportItems = [];
  for (var sbi = 0; sbi < skippedBeforeRows.length; sbi++) {
    var sbt = skippedBeforeRows[sbi];
    var streakB = (sbt.skip_streak || 0) + 1;
    await db.prepare('UPDATE tasks SET skip_streak = ? WHERE id = ?').bind(streakB, sbt.id).run();
    var rrB = resolveTaskSkipReason(sbt);
    skippedBeforeReportItems.push({
      title: sbt.title,
      reason: rrB ? rrB : '（理由未記録）',
      skip_streak: streakB,
    });
    var insertedB = await closeDayInsertCarryForTomorrow(db, sbt, streakB, tomorrow);
    if (insertedB) carriedCount++;
  }

  await db.prepare(
    "UPDATE tasks SET scheduled_date = NULL, deadline_date = NULL, due_date = NULL WHERE location_id = ? AND task_type = 'monitoring' AND status IN ('done', 'skipped') AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ?"
  ).bind(locationId, date).run();

  var doneStatsBase = await db
    .prepare(
      "SELECT id, status, template_id, task_type FROM tasks WHERE location_id = ? AND date(COALESCE(scheduled_date, deadline_date, due_date)) = ? AND status = 'done' AND COALESCE(task_type, 'routine') != 'event' AND task_type != 'monitoring'"
    )
    .bind(locationId, date)
    .all();
  var doneStatsFilt = await filterTaskRowsByTemplateRecurrence(db, doneStatsBase.results || [], date);
  var doneClose = doneStatsFilt.length;

  var catSummary = await buildCatSummary(db, locationId);
  var medicationCloseDay = await buildCloseDayMedicationReport(db, locationId, date);
  var feedingCloseDay = await buildCloseDayFeedingReport(db, locationId, date);
  var excretionCloseDay = await buildCloseDayExcretionGaps(db, locationId, date);
  var careItemGapsCloseDay = await buildCloseDayCareItemGaps(db, locationId, date);
  var vomitingCloseDay = await buildCloseDayVomitingReport(db, locationId, date);
  var clinicCloseDay = await buildCloseDayClinicReport(db, locationId, date);
  var weightLossCloseDay = await buildCloseDayWeightLossReport(db, locationId);
  var appetiteLowCloseDay = await buildCloseDayLowAppetiteReport(db, locationId, date);
  var waterCloseDay = await buildCloseDayWaterReport(db, locationId, date);

  var skippedAtClose = pendingTasks.length;
  var skippedBeforeN = skippedBeforeRows.length;
  var dayLoadTasks = doneClose + skippedBeforeN + skippedAtClose;

  var report = {
    location_id: locationId,
    location_label: LOCATION_LABELS[locationId] || locationId,
    date: date,
    closed_by: staffAuth.name || staffAuth.staffId,
    stats: {
      total: dayLoadTasks,
      done: doneClose,
      skipped_before_close: skippedBeforeN,
      skipped_at_close: skippedAtClose,
      carried: carriedCount,
    },
    skipped_tasks_before_close: skippedBeforeReportItems,
    skipped_tasks: skippedForReport,
    cat_summary: catSummary,
    medication_close_day: medicationCloseDay,
    feeding_close_day: feedingCloseDay,
    excretion_close_day: excretionCloseDay,
    care_item_gaps_close_day: careItemGapsCloseDay,
    vomiting_close_day: vomitingCloseDay,
    clinic_close_day: clinicCloseDay,
    weight_loss_close_day: weightLossCloseDay,
    appetite_low_close_day: appetiteLowCloseDay,
    water_close_day: waterCloseDay,
    special_notes: specialNotes,
  };

  await db.prepare(
    'INSERT INTO daily_closures (location_id, closed_date, closed_by, special_notes, report_json) VALUES (?, ?, ?, ?, ?)'
  ).bind(locationId, date, staffAuth.staffId, specialNotes || null, closeDayReportJsonStringify(report)).run();

  /** 献立・投薬プリセット再適用を先に行い、その後に medication_logs を生成（古い medication_id への紐づけ防止） */
  var presetResult = { applied: 0 };
  try {
    presetResult = await reapplyFeedingPresets(db, locationId);
  } catch (e) {
    console.warn('reapplyFeedingPresets error (non-fatal):', e && e.message);
  }
  report.feeding_presets_applied = presetResult.applied;

  var medPresetResult = { applied: 0 };
  try {
    medPresetResult = await reapplyMedicationPresetsForLocation(db, locationId);
  } catch (e) {
    console.warn('reapplyMedicationPresets error (non-fatal):', e && e.message);
  }
  report.medication_presets_applied = medPresetResult.applied;

  var medLogTodayResult = { generated: 0 };
  var medLogTomorrowResult = { generated: 0 };
  try {
    medLogTodayResult = await generateAllMedLogsForDate(db, date, locationId);
  } catch (e) {
    console.warn('generateAllMedLogsForDate (close day) error (non-fatal):', e && e.message);
  }
  try {
    medLogTomorrowResult = await generateAllMedLogsForDate(db, tomorrow, locationId);
  } catch (e) {
    console.warn('generateAllMedLogsForDate (tomorrow) error (non-fatal):', e && e.message);
  }
  report.medication_logs_generated = (medLogTodayResult.generated || 0) + (medLogTomorrowResult.generated || 0);

  // NYAGI タスク画面「送信して業務終了」と同じ経路（本モーダルからの POST のみ）。プレビュー GET では送らない。
  // Slack / LLM は遅延・長時間になり得るため、HTTP 応答は先に返し waitUntil で継続（画面が「送信中」のまま止まらないようにする）。
  var slackChannel = getSlackChannel(env, locationId);
  var runSlack = null;
  if (slackChannel) {
    runSlack = async function () {
      try {
        var slackBody = buildSlackReport(report);
        var slackText = slackBody;
        if (isCloseDayLlmEnabled(env)) {
          try {
            var summaryForLlm = summarizeCloseDayReportForLlm(report);
            var commentary = await fetchCloseDayKohadaCommentary(env, slackBody, summaryForLlm);
            if (commentary) {
              slackText =
                slackBody +
                '\n\n🐱 【副店長こはだ・所感・ツッコミ（自動／事実はここまでのブロックがマスター）】\n' +
                commentary;
              console.log('[close-day] Slack: テンプレ + LLM 所感を送信（拠点 ' + locationId + '）');
            } else {
              console.log('[close-day] Slack: LLM 空のためテンプレのみ（拠点 ' + locationId + '）');
            }
          } catch (llmErr) {
            console.warn('[close-day-llm] non-fatal:', llmErr && llmErr.message);
          }
        } else if (env && env.OPENAI_API_KEY) {
          console.log('[close-day] Slack: CLOSE_DAY_LLM で LLM 無効、テンプレのみ');
        }
        await sendSlackMessage(env, slackChannel, slackText);
      } catch (slackErr) {
        console.warn('[close-day] Slack 送信失敗（業務終了は確定済）:', slackErr && slackErr.message);
      }
    };
  }
  if (runSlack) {
    if (ctx && typeof ctx.waitUntil === 'function') {
      /** 同期部分で buildSlackReport が走らないよう、応答送信後に開始する */
      var slackPromise = Promise.resolve()
        .then(function () {
          return runSlack();
        })
        .catch(function (e) {
          console.warn('[close-day] waitUntil:', e && e.message);
        });
      ctx.waitUntil(slackPromise);
    } else {
      await runSlack();
    }
  }

  /** フル report は daily_closures に保存済み。HTTP は最小限にし JSON.stringify 例外・巨大応答を避ける */
  return opsJson({
    ok: true,
    slack_dispatch_in_background: !!runSlack,
    closed: { location_id: locationId, date: date, location_label: report.location_label || '' },
  });
}

/**
 * 業務終了時: プリセット紐づけ猫ごとに、プリセットの有効メニュー行だけで献立を全面入替する。
 * プリセットが無効・削除済み、または有効メニュー0件のときはスキップ（猫の assigned_preset_id は据え置き。calc の警告でUI表示）。
 */
async function reapplyFeedingPresets(db, locationId) {
  var cats = await db.prepare(
    "SELECT id, assigned_preset_id FROM cats WHERE location_id = ? AND " + sqlStatusInCare() + " AND assigned_preset_id IS NOT NULL"
  ).bind(locationId).all();
  var catRows = cats.results || [];
  var catsSynced = 0;

  for (var c = 0; c < catRows.length; c++) {
    var cat = catRows[c];
    var pid = cat.assigned_preset_id;
    var rep = await replaceCatFeedingPlansFromActivePreset(db, cat.id, pid, { setAssigned: false });
    if (rep.ok) catsSynced++;
  }

  return { applied: catsSynced };
}

function nextDate(dateStr) {
  return jstCalendarAddDays(dateStr, 1);
}

function getSlackChannel(env, locationId) {
  return resolveNyagiReportSlackChannel(env, locationId);
}

/** 30日比で体重低下が大きい猫（栄養プロフィール）。業務終了Slack・プレビュー用 */
var CLOSE_DAY_WEIGHT_LOSS_THRESHOLD = -5;

/** 健康スコアの食欲コンポーネント。75未満＝「良好」未満（やや低下〜不振）を業務終了に掲載 */
var CLOSE_DAY_APPETITE_SCORE_LIST_BELOW = 75;

async function buildCloseDayLowAppetiteReport(db, locationId, scoreDateYmd) {
  try {
    var res = await db.prepare(
      'SELECT c.name AS cat_name, c.status AS cat_status, x.appetite_score AS appetite_score, x.score_date AS score_date, x.total_score AS total_score ' +
        'FROM cats c ' +
        'INNER JOIN ( ' +
        '  SELECT hs.cat_id, hs.appetite_score, hs.score_date, hs.total_score ' +
        '  FROM health_scores hs ' +
        '  INNER JOIN (SELECT cat_id, MAX(id) AS mid FROM health_scores GROUP BY cat_id) t ON hs.cat_id = t.cat_id AND hs.id = t.mid ' +
        ') x ON c.id = x.cat_id ' +
        "WHERE c.location_id = ? AND " + sqlStatusInCare('c') + " " +
        'AND x.appetite_score IS NOT NULL AND x.appetite_score < ? ' +
        'ORDER BY x.appetite_score ASC, c.name ASC'
    ).bind(locationId, CLOSE_DAY_APPETITE_SCORE_LIST_BELOW).all();
    var rows = res.results || [];
    var items = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var a = r.appetite_score != null ? parseInt(r.appetite_score, 10) : null;
      if (a == null || isNaN(a)) continue;
      var severity = 'moderate';
      if (a <= 10) severity = 'critical';
      else if (a <= 40) severity = 'severe';
      items.push({
        cat_name: r.cat_name || '',
        cat_status: r.cat_status || '',
        appetite_score: a,
        score_date: r.score_date || null,
        total_score: r.total_score != null ? parseInt(r.total_score, 10) : null,
        severity: severity,
      });
    }
    return {
      basis:
        '健康スコアの「食欲」項目（直近7日の給餌記録から算出・日次バッチ等で health_scores に保存）。掲載は ' +
        (CLOSE_DAY_APPETITE_SCORE_LIST_BELOW - 1) +
        ' 点以下（良好ライン75未満）',
      list_below: CLOSE_DAY_APPETITE_SCORE_LIST_BELOW,
      reference_date: scoreDateYmd || null,
      count: items.length,
      items: items,
    };
  } catch (e) {
    return {
      basis: '健康スコアの食欲項目（health_scores）',
      list_below: CLOSE_DAY_APPETITE_SCORE_LIST_BELOW,
      reference_date: scoreDateYmd || null,
      count: 0,
      items: [],
      error: e && e.message ? e.message : 'appetite_report',
    };
  }
}

/**
 * 飲水測定レポート: water_tracking=1 の猫について当日の water_measurements を集計。
 * 未計測・ほぼ飲んでいない・多飲異常を抽出して返す。
 */
async function buildCloseDayWaterReport(db, locationId, closingDate) {
  try {
    /* water_tracking 対象猫 */
    var catSql =
      'SELECT id, name FROM cats WHERE location_id = ? AND water_tracking = 1 AND ' + sqlStatusInCare() + ' ORDER BY name';
    var catRes = await db.prepare(catSql).bind(locationId).all();
    var cats = catRes.results || [];
    if (cats.length === 0) {
      return { tracked_count: 0, measured_count: 0, items: [], unmeasured: [] };
    }

    /* 当日計測行 */
    var wmSql =
      'SELECT wm.cat_id, wm.consumed_ml, wm.total_intake_ml, wm.intake_per_kg, wm.status ' +
      'FROM water_measurements wm WHERE wm.measurement_date = ? AND wm.cat_id IN (SELECT id FROM cats WHERE location_id = ? AND water_tracking = 1 AND ' + sqlStatusInCare() + ')';
    var wmRes = await db.prepare(wmSql).bind(closingDate, locationId).all();
    var wmRows = wmRes.results || [];
    var wmMap = {};
    for (var wi = 0; wi < wmRows.length; wi++) {
      wmMap[String(wmRows[wi].cat_id)] = wmRows[wi];
    }

    var items = [];
    var unmeasured = [];
    for (var ci = 0; ci < cats.length; ci++) {
      var cat = cats[ci];
      var wm = wmMap[String(cat.id)];
      if (!wm) {
        unmeasured.push({ cat_id: cat.id, cat_name: cat.name });
        continue;
      }
      var totalMl = wm.total_intake_ml != null ? wm.total_intake_ml : wm.consumed_ml;
      var perKg = wm.intake_per_kg != null ? wm.intake_per_kg : null;
      var status = wm.status || null;
      var alert = status === 'ほぼ飲んでいない' || status === '多飲異常';
      items.push({
        cat_id: cat.id,
        cat_name: cat.name,
        consumed_ml: wm.consumed_ml != null ? wm.consumed_ml : null,
        total_intake_ml: totalMl,
        intake_per_kg: perKg,
        status: status,
        alert: alert,
      });
    }
    return {
      tracked_count: cats.length,
      measured_count: items.length,
      items: items,
      unmeasured: unmeasured,
      reference_date: closingDate,
    };
  } catch (e) {
    return {
      tracked_count: 0,
      measured_count: 0,
      items: [],
      unmeasured: [],
      reference_date: closingDate,
      error: e && e.message ? e.message : 'water_report',
    };
  }
}

function appendCloseDayWaterSlack(lines, water) {
  if (!water) return;
  lines.push('💧 飲水測定（water_tracking 対象猫）');
  var tracked = water.tracked_count || 0;
  if (tracked === 0) {
    lines.push('  測定対象の猫なし');
    lines.push('');
    return;
  }
  var measured = water.measured_count || 0;
  var unmeasured = water.unmeasured || [];
  var items = water.items || [];
  var maxL = CLOSE_DAY_LIST_MAX;

  /* 計測済み猫 */
  for (var i = 0; i < items.length && i < maxL; i++) {
    var it = items[i];
    var totalStr = it.total_intake_ml != null ? Math.round(it.total_intake_ml) + 'ml' : '計算中';
    var perKgStr = it.intake_per_kg != null ? '（' + Math.round(it.intake_per_kg * 10) / 10 + 'ml/kg）' : '';
    var statusStr = it.status ? ' ' + it.status : '';
    var alertMark = it.status === 'ほぼ飲んでいない' ? ' 🚨' : it.status === '多飲異常' ? ' ⚠️多飲' : it.status === '少し飲んだ' ? ' ⚠' : '';
    lines.push('  • ' + it.cat_name + ' — 総摂取 ' + totalStr + perKgStr + statusStr + alertMark);
  }
  if (items.length > maxL) lines.push('  … 他' + (items.length - maxL) + '頭');

  /* 未計測猫 */
  if (unmeasured.length > 0) {
    var uNames = unmeasured.slice(0, 10).map(function (c) { return c.cat_name; }).join('、');
    if (unmeasured.length > 10) uNames += ' …他' + (unmeasured.length - 10) + '頭';
    lines.push('  ⬜ 未計測: ' + uNames);
  }

  lines.push('  追跡 ' + tracked + '頭 / 計測済 ' + measured + '頭' + (unmeasured.length > 0 ? ' / 未計測 ' + unmeasured.length + '頭' : ''));
  lines.push('');
}

function appendCloseDayLowAppetiteSlack(lines, appet) {
  if (!appet) return;
  var maxL = CLOSE_DAY_LIST_MAX;
  lines.push('🍽️ 食欲スコアが低い猫（健康スコア・食欲項目）');
  lines.push('  ※ ' + (appet.basis || '直近の health_scores'));
  if (appet.reference_date) {
    lines.push('  業務終了日: ' + appet.reference_date + '（各行末は猫ごとの score_date）');
  }
  var items = appet.items || [];
  if (items.length === 0) {
    lines.push('  該当なし（全頭75点以上、またはスコア未作成）');
  } else {
    for (var i = 0; i < items.length && i < maxL; i++) {
      var it = items[i];
      var tag =
        it.severity === 'critical'
          ? '【不振】'
          : it.severity === 'severe'
            ? '【低下】'
            : '【やや低下】';
      var tot = it.total_score != null && !isNaN(it.total_score) ? '／総合' + it.total_score + '点' : '';
      var d = it.score_date ? String(it.score_date).slice(0, 10) : '';
      var dpart = d ? '（スコア日 ' + d + '）' : '';
      lines.push('  • ' + it.cat_name + ' — 食欲 ' + it.appetite_score + '点 ' + tag + tot + dpart);
    }
    if (items.length > maxL) lines.push('  … 他' + (items.length - maxL) + '頭');
  }
  lines.push('');
}

async function buildCloseDayWeightLossReport(db, locationId) {
  try {
    var res = await db.prepare(
      'SELECT c.name AS cat_name, c.status AS cat_status, p.weight_trend_pct AS pct, p.weight_trend AS weight_trend, ' +
        'p.last_weight_kg AS last_kg, p.weight_30d_ago_kg AS prev_kg ' +
        'FROM cats c ' +
        'INNER JOIN cat_nutrition_profiles p ON p.cat_id = c.id ' +
        "WHERE c.location_id = ? AND " + sqlStatusInCare('c') + " " +
        'AND p.weight_trend_pct IS NOT NULL AND p.weight_trend_pct <= ? ' +
        'ORDER BY p.weight_trend_pct ASC, c.name ASC'
    ).bind(locationId, CLOSE_DAY_WEIGHT_LOSS_THRESHOLD).all();
    var rows = res.results || [];
    var items = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var pct = r.pct != null ? parseFloat(r.pct) : null;
      if (pct == null || isNaN(pct)) continue;
      var severity = 'moderate';
      if (pct <= -10) severity = 'critical';
      else if (pct <= -7) severity = 'severe';
      items.push({
        cat_name: r.cat_name || '',
        cat_status: r.cat_status || '',
        weight_trend_pct: Math.round(pct * 10) / 10,
        weight_trend: r.weight_trend || null,
        last_weight_kg: r.last_kg != null ? parseFloat(r.last_kg) : null,
        weight_30d_ago_kg: r.prev_kg != null ? parseFloat(r.prev_kg) : null,
        severity: severity,
      });
    }
    return {
      basis: '最新体重と約30日前の記録の比較（栄養プロフィール・体重登録時に更新）',
      threshold_pct: CLOSE_DAY_WEIGHT_LOSS_THRESHOLD,
      count: items.length,
      items: items,
    };
  } catch (e) {
    return {
      basis: '最新体重と約30日前の記録の比較（栄養プロフィール・体重登録時に更新）',
      threshold_pct: CLOSE_DAY_WEIGHT_LOSS_THRESHOLD,
      count: 0,
      items: [],
      error: e && e.message ? e.message : 'weight_loss_report',
    };
  }
}

function appendCloseDayWeightLossSlack(lines, wloss) {
  if (!wloss) return;
  var maxL = CLOSE_DAY_LIST_MAX;
  lines.push('⚖️ 体重低下が顕著な猫（30日比）');
  lines.push('  ※ ' + (wloss.basis || '栄養プロフィールの推移'));
  lines.push(
    '  掲載条件: 減少率 ' +
      (wloss.threshold_pct != null ? String(wloss.threshold_pct) : String(CLOSE_DAY_WEIGHT_LOSS_THRESHOLD)) +
      '% 以下（＝' + Math.abs(CLOSE_DAY_WEIGHT_LOSS_THRESHOLD) + '%以上の体重減）'
  );
  var items = wloss.items || [];
  if (items.length === 0) {
    lines.push('  該当なし');
  } else {
    for (var i = 0; i < items.length && i < maxL; i++) {
      var it = items[i];
      var pctNum = it.weight_trend_pct;
      var pctStr = pctNum + '%';
      var tag =
        it.severity === 'critical'
          ? '【急減】約10%超の低下'
          : it.severity === 'severe'
            ? '【顕著】約7〜10%の低下'
            : '【注意】約5〜7%の低下';
      var kgPart = '';
      var a = it.weight_30d_ago_kg;
      var b = it.last_weight_kg;
      if (a != null && !isNaN(a) && b != null && !isNaN(b)) {
        kgPart =
          '（' +
          (Math.round(a * 100) / 100) +
          'kg → ' +
          (Math.round(b * 100) / 100) +
          'kg）';
      } else if (b != null && !isNaN(b)) {
        kgPart = '（現在 ' + Math.round(b * 100) / 100 + 'kg）';
      }
      lines.push('  • ' + it.cat_name + ' — 30日比 ' + pctStr + ' ' + kgPart + ' ' + tag);
    }
    if (items.length > maxL) lines.push('  … 他' + (items.length - maxL) + '頭');
  }
  lines.push('');
}

async function buildCatSummary(db, locationId) {
  try {
    var today = jstCalendarYmdFromInstant(Date.now());
    var cats = await db.prepare(
      "SELECT c.id, c.name, c.status FROM cats c WHERE c.location_id = ? AND " + sqlStatusInCare('c') + " ORDER BY c.name"
    ).bind(locationId).all();
    var catList = cats.results || [];
    if (catList.length === 0) return { cats: [], average_score: null };

    // ダッシュボードと同じライブ算出でスコアを取得
    var scorePromises = catList.map(function (cat) {
      return calculateHealthScore(db, cat.id, today).catch(function () { return null; });
    });
    var scoreResults = await Promise.all(scorePromises);

    var totalScore = 0;
    var scoredCount = 0;
    var warnings = [];
    var summary = [];

    for (var i = 0; i < catList.length; i++) {
      var cat = catList[i];
      var liveScore = scoreResults[i];
      var rawScore = liveScore ? liveScore.total_score : null;
      var score = rawScore == null ? null : typeof rawScore === 'bigint' ? Number(rawScore) : Number(rawScore);
      if (score != null && !isNaN(score)) {
        totalScore += score;
        scoredCount++;
      }
      if (score != null && !isNaN(score) && score < 70) {
        warnings.push({ name: cat.name, score: score });
      }
      summary.push({ name: cat.name, score: score != null && !isNaN(score) ? score : null });
    }

    return {
      cats: summary,
      average_score: scoredCount > 0 ? Math.round(totalScore / scoredCount) : null,
      warnings: warnings,
    };
  } catch (e) {
    return { cats: [], average_score: null, error: e.message };
  }
}

function appendCloseDayMedicationSlack(lines, med) {
  if (!med) return;
  lines.push('💊 本日の投薬（未完了）');
  if (!med.total) {
    lines.push('  当日分の投薬スケジュールはありません');
    lines.push('');
    return;
  }
  var pct = med.total > 0 ? Math.round((med.done / med.total) * 100) : 0;
  lines.push('  予定: ' + med.total + '件 / 完了: ' + med.done + '件（' + pct + '%）');
  if (med.skipped > 0) lines.push('  スキップ済: ' + med.skipped + '件');
  var items = med.pending_items || [];
  var maxL = CLOSE_DAY_LIST_MAX;
  for (var i = 0; i < items.length && i < maxL; i++) {
    var it = items[i];
    lines.push('  • ' + it.cat_name + ' — ' + it.slot_label + ' ' + it.medicine_name + '（未）');
  }
  if (items.length > maxL) lines.push('  … 他' + (items.length - maxL) + '件');
  if (items.length === 0) lines.push('  未完了の投薬はありません');
  lines.push('');
}

function appendCloseDayFeedingSlack(lines, feed) {
  if (!feed) return;
  lines.push('🍚 本日のごはん（未完了・要確認）');
  if (!feed.plan_count) {
    lines.push('  有効な献立がありません');
    lines.push('');
    return;
  }
  lines.push('  献立 ' + feed.plan_count + '行のうち、未完了: ' + feed.incomplete_count + '件');
  var items = feed.incomplete_items || [];
  var maxL = CLOSE_DAY_LIST_MAX;
  for (var j = 0; j < items.length && j < maxL; j++) {
    var f = items[j];
    lines.push('  • ' + f.cat_name + ' — ' + f.slot_label + '（' + f.detail + '）');
  }
  if (items.length > maxL) lines.push('  … 他' + (items.length - maxL) + '件');
  if (items.length === 0) lines.push('  献立に対する未記録・未確認はありません');
  lines.push('');
}

function appendCloseDayExcretionSlack(lines, exc) {
  if (!exc) return;
  var maxL = CLOSE_DAY_LIST_MAX;
  lines.push('💩 排便（2日以上記録なし・遅れ）');
  var sg = exc.stool_gaps || [];
  if (sg.length === 0) {
    lines.push('  該当なし');
  } else {
    for (var i = 0; i < sg.length && i < maxL; i++) {
      var s = sg[i];
      if (s.no_record) lines.push('  • ' + s.cat_name + ' — 記録なし');
      else lines.push('  • ' + s.cat_name + ' — 最終 ' + closeDayFmtMd(s.last_record_date) + '（経過' + s.days_since_last + '日）');
    }
    if (sg.length > maxL) lines.push('  … 他' + (sg.length - maxL) + '頭');
  }
  lines.push('');
  lines.push('🚽 排尿（2日以上記録なし・遅れ）');
  var ug = exc.urine_gaps || [];
  if (ug.length === 0) {
    lines.push('  該当なし');
  } else {
    for (var u = 0; u < ug.length && u < maxL; u++) {
      var x = ug[u];
      if (x.no_record) lines.push('  • ' + x.cat_name + ' — 記録なし');
      else lines.push('  • ' + x.cat_name + ' — 最終 ' + closeDayFmtMd(x.last_record_date) + '（経過' + x.days_since_last + '日）');
    }
    if (ug.length > maxL) lines.push('  … 他' + (ug.length - maxL) + '頭');
  }
  lines.push('');
}

function appendCloseDayCareItemSlack(lines, care) {
  if (!care) return;
  var maxL = CLOSE_DAY_LIST_MAX;
  var th = care.threshold_days != null ? care.threshold_days : CLOSE_DAY_CARE_GAP_MIN_DAYS;
  lines.push('🪮 ケア実施（項目別・実施から' + th + '日以上未記録）');
  var arr = care.items || [];
  if (arr.length === 0) {
    lines.push('  該当なし');
  } else {
    for (var i = 0; i < arr.length && i < maxL; i++) {
      var it = arr[i];
      if (it.no_record) {
        lines.push(
          '  • ' +
            it.cat_name +
            ' — ' +
            it.item_label +
            ' 記録なし（猫マスタ登録から' +
            (it.days_since_last != null ? it.days_since_last : '') +
            '日）'
        );
      } else {
        lines.push(
          '  • ' +
            it.cat_name +
            ' — ' +
            it.item_label +
            ' 最終 ' +
            closeDayFmtMd(it.last_record_date) +
            '（経過' +
            it.days_since_last +
            '日）'
        );
      }
    }
    if (arr.length > maxL) lines.push('  … 他' + (arr.length - maxL) + '件');
  }
  lines.push('');
}

function appendCloseDayVomitingSlack(lines, vom) {
  if (!vom) return;
  var maxL = CLOSE_DAY_LIST_MAX;
  lines.push('🤮 はき戻し（嘔吐・関連観察）');
  var pc = vom.per_cat || [];
  var ws = vom.week_start;
  var we = vom.week_end;
  var rangeStr = '';
  if (ws && we && ws.length >= 10 && we.length >= 10) {
    rangeStr = closeDayFmtMd(ws) + '〜' + closeDayFmtMd(we);
  }
  if (pc.length === 0) {
    lines.push('  直近7日間' + (rangeStr ? '（' + rangeStr + '）' : '') + '：記録なし');
    lines.push('  本日の記録：なし');
    lines.push('');
    return;
  }
  lines.push('  直近7日間' + (rangeStr ? '（' + rangeStr + '）' : '') + ' 猫別・記録件数（同一日内の複数回は複数件）');
  for (var i = 0; i < pc.length && i < maxL; i++) {
    var c = pc[i];
    lines.push('  • ' + c.cat_name + ': ' + c.week_count + '件（' + c.distinct_days + '日に記録）');
  }
  if (pc.length > maxL) lines.push('  … 他' + (pc.length - maxL) + '頭');

  var todayParts = [];
  for (var j = 0; j < pc.length; j++) {
    var cat = pc[j];
    if (cat.today_count > 0) {
      var tn = cat.cat_name + '（' + cat.today_count + '件）';
      if (cat.streak_ending_close >= 2) {
        tn += ' — ' + cat.streak_ending_close + '日連続で記録（業務終了日まで）';
        var sdates = cat.streak_dates_ymd || [];
        if (sdates.length >= 2) {
          var r0 = closeDayFmtMd(sdates[0]);
          var r1 = closeDayFmtMd(sdates[sdates.length - 1]);
          if (r0 && r1) tn += ' ' + r0 + '〜' + r1;
        }
      }
      todayParts.push(tn);
    }
  }

  if (todayParts.length > 0) {
    lines.push('  本日はき戻し記録あり:');
    for (var t = 0; t < todayParts.length && t < maxL; t++) {
      lines.push('    • ' + todayParts[t]);
    }
    if (todayParts.length > maxL) lines.push('    … 他' + (todayParts.length - maxL) + '頭');
  } else {
    lines.push('  本日はき戻し記録あり: なし');
  }

  lines.push('');
}

function appendCloseDayClinicSlack(lines, clin) {
  if (!clin) return;
  var maxL = CLOSE_DAY_LIST_MAX;
  lines.push('🏥 病院・予定（今後14日以内の予定日 next_due）');
  if (!clin.active_cat_count) {
    lines.push('  在籍対象の猫がありません');
    lines.push('');
    return;
  }
  var ws = clin.window_label_start;
  var we = clin.window_label_end;
  var wr = '';
  if (ws && we && ws.length >= 10 && we.length >= 10) {
    wr = closeDayFmtMd(ws) + '〜' + closeDayFmtMd(we);
  }
  var up = clin.upcoming || [];
  if (up.length === 0) {
    lines.push('  ' + (wr ? '（' + wr + '）' : '') + ' 期間内に登録された予定日はありません');
  } else {
    lines.push('  予定一覧 ' + (wr || '') + '（予定日＝next_due）');
    for (var i = 0; i < up.length && i < maxL; i++) {
      var u = up[i];
      var line = '  • ' + u.cat_name + ' — ' + u.type_label + ' 予定 ' + closeDayFmtMd(u.next_due);
      if (u.days_from_close != null && u.days_from_close >= 0) line += '（あと' + u.days_from_close + '日）';
      if (!u.booked_date || String(u.booked_date).trim() === '') line += ' ⚠予約枠/受診日未記入';
      if (u.value_short) line += ' — ' + u.value_short;
      lines.push(line);
    }
    if (up.length > maxL) lines.push('  … 他' + (up.length - maxL) + '件');
    var uw = clin.upcoming_without_booking_count || 0;
    if (uw > 0) lines.push('  ※ 上記のうち ' + uw + '件は受診日/予約枠（booked_date）が空です');
  }

  var noFut = clin.cats_without_future_due || [];
  if (noFut.length > 0) {
    lines.push('  次回予定日（病院系・本日以降の next_due）が未登録の猫:');
    for (var j = 0; j < noFut.length && j < maxL; j++) {
      lines.push('    • ' + noFut[j].cat_name);
    }
    if (noFut.length > maxL) lines.push('    … 他' + (noFut.length - maxL) + '頭');
  } else {
    lines.push('  次回予定日未登録の猫: なし（全頭いずれかの行に本日以降の next_due あり）');
  }

  lines.push('  【本日の病院記録（record_date が業務終了日）】');
  var rt = clin.clinic_records_today || [];
  if (rt.length === 0) {
    lines.push('    なし');
  } else {
    for (var k = 0; k < rt.length && k < maxL; k++) {
      var r = rt[k];
      var ln = '    • ' + r.cat_name + ' — ' + r.type_label;
      if (r.value_short) ln += ' — ' + r.value_short;
      if (r.next_due) ln += ' / 次回予定 ' + closeDayFmtMd(r.next_due);
      if (!r.booked_date || String(r.booked_date).trim() === '') ln += ' （予約枠未記入）';
      lines.push(ln);
    }
    if (rt.length > maxL) lines.push('    … 他' + (rt.length - maxL) + '件');
  }

  lines.push('  【本日付けの注意事項（自動の食事・栄養メモ以外）】');
  var nt = clin.cat_notes_today || [];
  if (nt.length === 0) {
    lines.push('    なし');
  } else {
    for (var n = 0; n < nt.length && n < maxL; n++) {
      var cn = nt[n];
      lines.push('    • ' + cn.cat_name + ' — [' + (cn.category || 'general') + '] ' + cn.note_short);
    }
    if (nt.length > maxL) lines.push('    … 他' + (nt.length - maxL) + '件');
  }

  lines.push('');
}

/**
 * 業務終了 Slack 本文（100% 決定論・事実ベース）。LLM はこの外側に所感のみ追記。
 * セクション順・見出しはテンプレ固定（崩さない）。
 */
function buildSlackReport(report) {
  var lines = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('📋 ' + report.location_label + ' 日次業務レポート（システム生成・事実固定）');
  lines.push(report.date + ' 報告者: ' + report.closed_by);
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  var s = report.stats || {};
  var sb = s.skipped_before_close != null ? s.skipped_before_close : 0;
  var sa = s.skipped_at_close != null ? s.skipped_at_close : 0;
  var denom = s.total != null ? s.total : ((s.done || 0) + sb + sa);
  var pct = denom > 0 ? Math.round((s.done || 0) / denom * 100) : 0;
  lines.push('✅ タスク完了状況');
  lines.push(
    '  完了: ' + (s.done || 0) +
      '／本日ルーティン計 ' + denom +
      ' 件（' + pct + '%）'
  );
  lines.push(
    '  内訳: 事前スキップ ' + sb + ' 件・業務終了スキップ ' + sa + ' 件 → 翌日繰越生成 ' + (s.carried != null ? s.carried : 0) + ' 件'
  );
  lines.push('');

  appendCloseDayMedicationSlack(lines, report.medication_close_day);
  appendCloseDayFeedingSlack(lines, report.feeding_close_day);
  appendCloseDayExcretionSlack(lines, report.excretion_close_day);
  appendCloseDayWaterSlack(lines, report.water_close_day);
  appendCloseDayCareItemSlack(lines, report.care_item_gaps_close_day);
  appendCloseDayVomitingSlack(lines, report.vomiting_close_day);
  appendCloseDayClinicSlack(lines, report.clinic_close_day);
  appendCloseDayWeightLossSlack(lines, report.weight_loss_close_day);
  appendCloseDayLowAppetiteSlack(lines, report.appetite_low_close_day);

  var sbTasks = report.skipped_tasks_before_close || [];
  var scTasks = report.skipped_tasks || [];
  if (sbTasks.length > 0 || scTasks.length > 0) {
    lines.push('⚠ スキップされたタスク（項目名・理由）');
    if (sbTasks.length > 0) {
      lines.push('  【業務終了までにタスク画面等でスキップ済み】');
      for (var bi = 0; bi < sbTasks.length; bi++) {
        var bt = sbTasks[bi];
        var bst = bt.skip_streak >= 2 ? ' ⚠' + bt.skip_streak + '日連続' : '';
        lines.push('  • ' + bt.title + ' — 理由: ' + bt.reason + bst);
      }
    }
    if (scTasks.length > 0) {
      lines.push('  【業務終了ボタンでスキップ（翌日へ繰越）】');
      for (var i = 0; i < scTasks.length; i++) {
        var st = scTasks[i];
        var streakWarn = st.skip_streak >= 2 ? ' ⚠' + st.skip_streak + '日連続' : '';
        lines.push('  • ' + st.title + ' — 理由: ' + st.reason + streakWarn);
      }
    }
    lines.push('');

    var streakItems = scTasks.concat(sbTasks).filter(function (t) { return (t.skip_streak || 0) >= 2; });
    if (streakItems.length > 0) {
      lines.push('🔁 連続スキップ警告');
      for (var j = 0; j < streakItems.length; j++) {
        lines.push('  • ' + streakItems[j].title + ' → ' + streakItems[j].skip_streak + '日連続');
      }
      lines.push('');
    }
  }

  if (report.cat_summary && report.cat_summary.cats && report.cat_summary.cats.length > 0) {
    lines.push('🐱 猫の状態サマリー');
    if (report.cat_summary.average_score != null) {
      lines.push('  健康スコア平均: ' + report.cat_summary.average_score + '点');
    }
    if (report.cat_summary.warnings && report.cat_summary.warnings.length > 0) {
      for (var k = 0; k < report.cat_summary.warnings.length; k++) {
        var w = report.cat_summary.warnings[k];
        lines.push('  ⚠ ' + w.name + ': スコア ' + w.score + '（要観察）');
      }
    } else {
      lines.push('  全頭異常なし');
    }
    lines.push('');
  }

  if (report.special_notes) {
    lines.push('📝 特記事項');
    lines.push('  ' + report.special_notes);
    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  return lines.join('\n');
}

export {
  closeDayPreview,
  closeDayExecute,
  buildSlackReport,
  getSlackChannel,
  LOCATION_LABELS,
  reapplyFeedingPresets,
  buildCloseDayCareItemGaps,
};
