/**
 * 朝ごはん（morning スロット）・夜ごはん（evening スロット）が当日分すべて記録済みか（タスク完了／スキップガード用）
 * feeding_plans と feeding_logs を突き合わせ、未記録（eaten_pct / remaining_g 未入力）の猫を返す。
 */
import { jstCalendarAddDays } from './jst-util.js';
import { sqlStatusCondition } from './cat-status.js';

/** ダッシュと同じスロット正規化 */
function feedNormSlot(s) {
  if (s == null || s === '') return '';
  var x = String(s).toLowerCase().trim();
  if (x === '朝' || x === 'morning' || x === 'am') return 'morning';
  if (x === '昼' || x === 'afternoon' || x === 'noon' || x === 'lunch') return 'afternoon';
  if (x === '夜' || x === 'evening' || x === 'night' || x === 'pm' || x === '夕' || x === 'dinner') return 'evening';
  return x;
}

/**
 * @param {D1Database} db
 * @param {string|null} locationId  cafe 等。null/both/all は全拠点。
 * @param {string}      ymdDate     YYYY-MM-DD（タスクの実行日）
 * @param {string|null} statusFilter cats の status フィルタ（null → in_care）
 * @returns {{ ok: boolean, missing_cats: Array<{cat_id,cat_name}>, missing_lines: string[] }}
 */
export async function checkMorningFeedingCompleteForGuard(db, locationId, ymdDate, statusFilter) {
  var stCond = sqlStatusCondition(statusFilter || 'in_care', 'c');

  /* ── 1. 朝献立プランを取得 ── */
  var fpSql =
    'SELECT fp.id AS plan_id, fp.cat_id, fp.meal_slot, c.name AS cat_name ' +
    'FROM feeding_plans fp JOIN cats c ON fp.cat_id = c.id ' +
    'WHERE fp.active = 1 AND (' + stCond + ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    fpSql += ' AND c.location_id = ?';
  }
  var fpStmt = db.prepare(fpSql);
  var fpRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await fpStmt.bind(locationId).all()
      : await fpStmt.all();
  var allPlans = fpRes.results || [];

  /* 朝スロットだけ絞る */
  var morningPlans = allPlans.filter(function (p) {
    return feedNormSlot(p.meal_slot) === 'morning';
  });

  if (morningPlans.length === 0) {
    return { ok: true, missing_cats: [], missing_lines: [] };
  }

  /* ── 2. 当日の給餌ログを取得 ── */
  var flSql =
    'SELECT fl.id AS log_id, fl.plan_id, fl.cat_id, fl.meal_slot, fl.eaten_pct, fl.remaining_g ' +
    'FROM feeding_logs fl JOIN cats c ON fl.cat_id = c.id ' +
    'WHERE fl.log_date = ? AND (' + stCond + ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    flSql += ' AND c.location_id = ?';
  }
  var flStmt = db.prepare(flSql);
  var flRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await flStmt.bind(ymdDate, locationId).all()
      : await flStmt.bind(ymdDate).all();
  var logs = flRes.results || [];

  /* plan_id → log のマップ（eaten_pct or remaining_g が入っているもの） */
  var doneByPlanId = {};
  /* cat_id → morning スロットの記録済みログがあるか */
  var doneBySlotCat = {};
  for (var li = 0; li < logs.length; li++) {
    var lg = logs[li];
    var hasValue = (lg.eaten_pct != null || lg.remaining_g != null);
    if (lg.plan_id != null && hasValue) {
      doneByPlanId[String(lg.plan_id)] = true;
    }
    if (feedNormSlot(lg.meal_slot) === 'morning' && hasValue) {
      doneBySlotCat[String(lg.cat_id)] = true;
    }
  }

  /* 朝スロットのプラン数（猫 × slot ごと）: plan_id のない重複照合用 */
  var morningPlanCountByCat = {};
  for (var pi2 = 0; pi2 < morningPlans.length; pi2++) {
    var cid2 = String(morningPlans[pi2].cat_id);
    morningPlanCountByCat[cid2] = (morningPlanCountByCat[cid2] || 0) + 1;
  }

  /* ── 3. 未完了プランを洗い出す ── */
  var incomplete = [];
  for (var pi = 0; pi < morningPlans.length; pi++) {
    var plan = morningPlans[pi];
    var pid = plan.plan_id != null ? String(plan.plan_id) : null;
    var catId = String(plan.cat_id);

    /* plan_id マッチ優先 */
    if (pid && doneByPlanId[pid]) continue;

    /* plan_id マッチなし & 猫のプランがその朝に 1 件だけなら slot マッチも OK */
    if (!pid || (morningPlanCountByCat[catId] || 0) <= 1) {
      if (doneBySlotCat[catId]) continue;
    }

    incomplete.push({ cat_id: plan.cat_id, cat_name: plan.cat_name || '' });
  }

  /* 猫単位で重複除去 */
  var seen = {};
  var missingCats = [];
  for (var ci = 0; ci < incomplete.length; ci++) {
    var key = String(incomplete[ci].cat_id);
    if (seen[key]) continue;
    seen[key] = true;
    missingCats.push({ cat_id: incomplete[ci].cat_id, cat_name: incomplete[ci].cat_name });
  }
  missingCats.sort(function (a, b) {
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });

  var missingLines = missingCats.map(function (c) { return String(c.cat_name || '（名前なし）'); });

  return {
    ok: incomplete.length === 0,
    missing_cats: missingCats,
    missing_lines: missingLines,
  };
}

/**
 * 夜ごはん（evening スロット）が当日分すべて記録済みか（tmpl_bw_10 タスクの完了／スキップガード用）
 * @param {D1Database} db
 * @param {string|null} locationId
 * @param {string}      ymdDate     YYYY-MM-DD
 * @param {string|null} statusFilter
 * @returns {{ ok: boolean, missing_cats: Array<{cat_id,cat_name}>, missing_lines: string[] }}
 */
export async function checkEveningFeedingCompleteForGuard(db, locationId, ymdDate, statusFilter) {
  var stCond = sqlStatusCondition(statusFilter || 'in_care', 'c');

  /* ── 1. 夜献立プランを取得 ── */
  var fpSql =
    'SELECT fp.id AS plan_id, fp.cat_id, fp.meal_slot, c.name AS cat_name ' +
    'FROM feeding_plans fp JOIN cats c ON fp.cat_id = c.id ' +
    'WHERE fp.active = 1 AND (' + stCond + ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    fpSql += ' AND c.location_id = ?';
  }
  var fpStmt = db.prepare(fpSql);
  var fpRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await fpStmt.bind(locationId).all()
      : await fpStmt.all();
  var allPlans = fpRes.results || [];

  /* 夜スロットだけ絞る */
  var eveningPlans = allPlans.filter(function (p) {
    return feedNormSlot(p.meal_slot) === 'evening';
  });

  if (eveningPlans.length === 0) {
    return { ok: true, missing_cats: [], missing_lines: [] };
  }

  /* ── 2. 当日の給餌ログを取得 ── */
  var flSql =
    'SELECT fl.id AS log_id, fl.plan_id, fl.cat_id, fl.meal_slot, fl.eaten_pct, fl.remaining_g ' +
    'FROM feeding_logs fl JOIN cats c ON fl.cat_id = c.id ' +
    'WHERE fl.log_date = ? AND (' + stCond + ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    flSql += ' AND c.location_id = ?';
  }
  var flStmt = db.prepare(flSql);
  var flRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await flStmt.bind(ymdDate, locationId).all()
      : await flStmt.bind(ymdDate).all();
  var logs = flRes.results || [];

  var doneByPlanId = {};
  var doneBySlotCat = {};
  for (var li = 0; li < logs.length; li++) {
    var lg = logs[li];
    var hasValue = (lg.eaten_pct != null || lg.remaining_g != null);
    if (lg.plan_id != null && hasValue) {
      doneByPlanId[String(lg.plan_id)] = true;
    }
    if (feedNormSlot(lg.meal_slot) === 'evening' && hasValue) {
      doneBySlotCat[String(lg.cat_id)] = true;
    }
  }

  var eveningPlanCountByCat = {};
  for (var pi2 = 0; pi2 < eveningPlans.length; pi2++) {
    var cid2 = String(eveningPlans[pi2].cat_id);
    eveningPlanCountByCat[cid2] = (eveningPlanCountByCat[cid2] || 0) + 1;
  }

  /* ── 3. 未完了プランを洗い出す ── */
  var incomplete = [];
  for (var pi = 0; pi < eveningPlans.length; pi++) {
    var plan = eveningPlans[pi];
    var pid = plan.plan_id != null ? String(plan.plan_id) : null;
    var catId = String(plan.cat_id);

    if (pid && doneByPlanId[pid]) continue;
    if (!pid || (eveningPlanCountByCat[catId] || 0) <= 1) {
      if (doneBySlotCat[catId]) continue;
    }
    incomplete.push({ cat_id: plan.cat_id, cat_name: plan.cat_name || '' });
  }

  var seen = {};
  var missingCats = [];
  for (var ci = 0; ci < incomplete.length; ci++) {
    var key = String(incomplete[ci].cat_id);
    if (seen[key]) continue;
    seen[key] = true;
    missingCats.push({ cat_id: incomplete[ci].cat_id, cat_name: incomplete[ci].cat_name });
  }
  missingCats.sort(function (a, b) {
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });

  var missingLines = missingCats.map(function (c) { return String(c.cat_name || '（名前なし）'); });

  return {
    ok: incomplete.length === 0,
    missing_cats: missingCats,
    missing_lines: missingLines,
  };
}
