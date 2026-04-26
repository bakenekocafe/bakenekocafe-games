/**
 * 水交換＋飲水量確認タスク（tmpl_hall_mizu_koukan）の完了／スキップ前ガード。
 *
 * 「猫一覧の飲水測定」と同じ判定:
 *   - 対象: 拠点内で water_tracking = 1 の在籍猫
 *   - その日の「セット」(= water_measurements[measurement_date = ymdDate].set_weight_g NOT NULL)
 *     と、前日の「計測」(= water_measurements[measurement_date = ymdDate-1].measure_weight_g NOT NULL)
 *     が両方終わっている必要あり。
 *   - 前日に「セット」がなかった猫は、当日の「セット」だけ必須。
 *
 * @param {D1Database} db
 * @param {string|null} locationId
 * @param {string}      ymdDate         YYYY-MM-DD （タスク実行日）
 * @param {string|null} statusFilter    cats.status フィルタ
 * @returns {{
 *   ok: boolean,
 *   missing_cats: Array<{ cat_id:any, cat_name:string, need_set:boolean, need_measure:boolean }>,
 *   missing_lines: string[],
 * }}
 */
import { jstCalendarAddDays } from './jst-util.js';
import { sqlStatusCondition } from './cat-status.js';

export async function checkHallWaterMeasurementCompleteForGuard(db, locationId, ymdDate, statusFilter) {
  var stCond = sqlStatusCondition(statusFilter || 'in_care', 'c');

  /* 1. water_tracking 対象猫を取得 */
  var catSql =
    'SELECT c.id AS cat_id, c.name AS cat_name FROM cats c ' +
    'WHERE c.water_tracking = 1 AND (' + stCond + ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    catSql += ' AND c.location_id = ?';
  }
  catSql += ' ORDER BY c.name';
  var catStmt = db.prepare(catSql);
  var catRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await catStmt.bind(locationId).all()
      : await catStmt.all();
  var cats = catRes.results || [];
  if (cats.length === 0) {
    return { ok: true, missing_cats: [], missing_lines: [] };
  }

  var yesterday = jstCalendarAddDays(ymdDate, -1);

  /* 2. 当日 + 前日の water_measurements をまとめて取得 */
  var wmSql =
    'SELECT wm.cat_id, wm.measurement_date, wm.set_weight_g, wm.measure_weight_g ' +
    'FROM water_measurements wm ' +
    'WHERE wm.measurement_date IN (?, ?) AND wm.cat_id IN ' +
    '(SELECT id FROM cats c WHERE c.water_tracking = 1 AND (' + stCond + ')';
  if (locationId && locationId !== 'all' && locationId !== 'both') {
    wmSql += ' AND c.location_id = ?';
  }
  wmSql += ')';
  var wmStmt = db.prepare(wmSql);
  var wmRes =
    locationId && locationId !== 'all' && locationId !== 'both'
      ? await wmStmt.bind(ymdDate, yesterday, locationId).all()
      : await wmStmt.bind(ymdDate, yesterday).all();
  var wmRows = wmRes.results || [];

  /* cat_id → { today: row|null, yesterday: row|null } */
  var wmByCat = {};
  for (var i = 0; i < wmRows.length; i++) {
    var r = wmRows[i];
    var key = String(r.cat_id);
    if (!wmByCat[key]) wmByCat[key] = { today: null, yesterday: null };
    if (r.measurement_date === ymdDate) wmByCat[key].today = r;
    else if (r.measurement_date === yesterday) wmByCat[key].yesterday = r;
  }

  var missing = [];
  for (var j = 0; j < cats.length; j++) {
    var c = cats[j];
    var ent = wmByCat[String(c.cat_id)] || { today: null, yesterday: null };

    var todaySet = ent.today && ent.today.set_weight_g != null;
    var needSet = !todaySet;

    /* 前日に「セットのみ」の行が残っていたら計測が必要 */
    var yHasSet = ent.yesterday && ent.yesterday.set_weight_g != null;
    var yHasMeas = ent.yesterday && ent.yesterday.measure_weight_g != null;
    var needMeasure = !!(yHasSet && !yHasMeas);

    if (needSet || needMeasure) {
      missing.push({
        cat_id: c.cat_id,
        cat_name: c.cat_name || '',
        need_set: needSet,
        need_measure: needMeasure,
      });
    }
  }

  missing.sort(function (a, b) {
    return String(a.cat_name || '').localeCompare(String(b.cat_name || ''), 'ja');
  });

  var missingLines = missing.map(function (m) {
    var parts = [];
    if (m.need_measure) parts.push('前日計測');
    if (m.need_set) parts.push('当日セット');
    return String(m.cat_name || '（名前なし）') + '（' + parts.join('・') + '未完了）';
  });

  return {
    ok: missing.length === 0,
    missing_cats: missing,
    missing_lines: missingLines,
  };
}
