/**
 * NYAGI 栄養管理モジュール
 *
 * - RER/MER 自動計算（子猫月齢対応）
 * - 複数ステータスタグによる係数調整
 * - 体重推移からの段階的MER自動調整
 * - 日次カロリーサマリ（残り摂取必要カロリー含む）
 * - フード傾向分析
 */

import {
  jstCalendarYmdFromInstant,
  jstCalendarAddDays,
  jstCalendarHourFromInstant,
  jstCalendarMinuteFromInstant,
} from './jst-util.js';

// ─── 子猫は月齢で係数が変わる ────────────────────
var KITTEN_MER_BY_MONTH = [
  { max: 4,  factor: 3.0 },
  { max: 6,  factor: 2.5 },
  { max: 9,  factor: 2.0 },
  { max: 12, factor: 1.8 },
];

var PUPPY_MER_BY_MONTH = [
  { max: 4,  factor: 3.0 },
  { max: 8,  factor: 2.5 },
  { max: 12, factor: 2.0 },
  { max: 18, factor: 1.8 },
];

var BASE_MER = {
  cat: { adult_neutered: 1.0, adult_intact: 1.4, senior: 1.1 },
  dog: { adult_neutered: 1.6, adult_intact: 1.8, senior: 1.4 },
};

// ─── 複数ステータスタグ（複合可能） ──────────────
var STATUS_MODIFIERS = {
  dieting:       { adj: -0.2,  label: 'ダイエット中' },
  low_activity:  { adj: -0.1,  label: '運動量少ない' },
  cage_rest:     { adj: -0.15, label: 'ケージ安静' },
  high_activity: { adj: +0.1,  label: '活発' },
  renal:         { adj: +0.1,  label: '腎臓病（体重維持）' },
  hyperthyroid:  { adj: +0.2,  label: '甲状腺機能亢進' },
  post_surgery:  { adj: +0.15, label: '術後回復中' },
  pregnant:      { adj: +0.4,  label: '妊娠中' },
  lactating:     { adj: +0.6,  label: '授乳中' },
  underweight:   { adj: +0.15, label: '低体重改善' },
};

// ─── 体重推移の段階的閾値 ────────────────────────
var WEIGHT_TREND_LEVELS = [
  { min: -Infinity, max: -10, trend: 'critical_loss', adj: +0.25, severity: 'critical', label: '危険な減少' },
  { min: -10,       max: -5,  trend: 'major_loss',    adj: +0.15, severity: 'major',    label: '明確な減少' },
  { min: -5,        max: -2,  trend: 'minor_loss',    adj: +0.10, severity: 'minor',    label: 'やや減少' },
  { min: -2,        max: -1,  trend: 'slight_loss',   adj: +0.05, severity: 'watch',    label: '微減' },
  { min: -1,        max: +1,  trend: 'stable',        adj: 0,     severity: 'none',     label: '安定' },
  { min: +1,        max: +3,  trend: 'slight_gain',   adj: -0.03, severity: 'watch',    label: '微増' },
  { min: +3,        max: +5,  trend: 'minor_gain',    adj: -0.05, severity: 'minor',    label: 'やや増加' },
  { min: +5,        max: +10, trend: 'major_gain',    adj: -0.10, severity: 'major',    label: '明確な増加' },
  { min: +10,       max: Infinity, trend: 'critical_gain', adj: -0.15, severity: 'critical', label: '急激な増加' },
];

function ageMonthsFromBirth(birthDate) {
  if (!birthDate) return null;
  var ms = Date.now() - new Date(birthDate).getTime();
  return ms / (30.44 * 86400000);
}

/**
 * birth_date からライフステージを判定
 */
export function detectLifeStage(birthDate, species) {
  if (!birthDate) return 'adult';
  var months = ageMonthsFromBirth(birthDate);
  if (months === null) return 'adult';
  if (species === 'dog') {
    if (months < 18) return 'puppy';
    if (months >= 96) return 'senior';
    return 'adult';
  }
  if (months < 12) return 'kitten';
  if (months >= 132) return 'senior';
  return 'adult';
}

/**
 * 安静時代謝量 RER（kcal/日）
 * - 猫: 70 × (体重kg)^0.75（WSAVA 等で一般的）
 * - 犬: 30 × 体重kg + 70（臨床・フード袋の目安表でよく使われる線形式。猫と同じ指数式だと中型〜大型で目安が低めになりやすい）
 *   極小個体（~2kg未満）は指数式を併用して過小を防ぐ
 */
export function calcRER(weightKg, species) {
  if (!weightKg || weightKg <= 0) return 0;
  species = species || 'cat';
  if (species === 'dog') {
    var linear = 30 * weightKg + 70;
    var allo = 70 * Math.pow(weightKg, 0.75);
    if (weightKg < 2) {
      return Math.round(Math.max(linear, allo));
    }
    return Math.round(linear);
  }
  return Math.round(70 * Math.pow(weightKg, 0.75));
}

/**
 * 基本 MER 係数（ライフステージ + 避妊/去勢 + 子猫月齢）
 */
export function determineBaseMER(birthDate, neutered, species) {
  species = species || 'cat';
  var stage = detectLifeStage(birthDate, species);
  var mer = BASE_MER[species] || BASE_MER.cat;

  if (stage === 'kitten') {
    var months = ageMonthsFromBirth(birthDate) || 6;
    for (var i = 0; i < KITTEN_MER_BY_MONTH.length; i++) {
      if (months < KITTEN_MER_BY_MONTH[i].max) return { factor: KITTEN_MER_BY_MONTH[i].factor, stage: stage, months: Math.round(months) };
    }
    return { factor: 1.8, stage: stage, months: Math.round(months) };
  }

  if (stage === 'puppy') {
    var months = ageMonthsFromBirth(birthDate) || 8;
    for (var i = 0; i < PUPPY_MER_BY_MONTH.length; i++) {
      if (months < PUPPY_MER_BY_MONTH[i].max) return { factor: PUPPY_MER_BY_MONTH[i].factor, stage: stage, months: Math.round(months) };
    }
    return { factor: 1.8, stage: stage, months: Math.round(months) };
  }

  if (stage === 'senior') return { factor: mer.senior, stage: stage };
  return { factor: neutered ? mer.adult_neutered : mer.adult_intact, stage: stage };
}

/**
 * ステータスタグ配列 → 合計調整値
 */
export function calcStatusAdj(tags) {
  if (!tags || !tags.length) return { adj: 0, applied: [] };
  var adj = 0;
  var applied = [];
  for (var i = 0; i < tags.length; i++) {
    var mod = STATUS_MODIFIERS[tags[i]];
    if (mod) {
      adj += mod.adj;
      applied.push({ tag: tags[i], label: mod.label, adj: mod.adj });
    }
  }
  return { adj: Math.round(adj * 100) / 100, applied: applied };
}

/**
 * BCS → 調整値
 */
export function calcBCSAdj(bcs) {
  if (!bcs) return 0;
  if (bcs <= 3) return +0.1;
  if (bcs >= 8) return -0.3;
  if (bcs >= 7) return -0.2;
  if (bcs >= 6) return -0.1;
  return 0;
}

/**
 * 体重推移 → 段階的な調整値（猫は-2%/月から要注意）
 */
export function calcWeightTrendAdj(currentKg, thirtyDaysAgoKg) {
  if (!currentKg || !thirtyDaysAgoKg || thirtyDaysAgoKg <= 0) {
    return { adj: 0, trend: 'unknown', severity: 'none', pct: 0, label: 'データ不足' };
  }
  var pct = (currentKg - thirtyDaysAgoKg) / thirtyDaysAgoKg * 100;
  var rounded = Math.round(pct * 10) / 10;

  for (var i = 0; i < WEIGHT_TREND_LEVELS.length; i++) {
    var lv = WEIGHT_TREND_LEVELS[i];
    if (pct > lv.min && pct <= lv.max) {
      return { adj: lv.adj, trend: lv.trend, severity: lv.severity, pct: rounded, label: lv.label };
    }
  }

  return { adj: 0, trend: 'stable', severity: 'none', pct: rounded, label: '安定' };
}

/**
 * 全調整値を統合して最終係数を算出
 */
export function calcEffectiveFactor(baseFactor, weightTrendAdj, statusAdj, bcsAdj) {
  var total = baseFactor + (weightTrendAdj || 0) + (statusAdj || 0) + (bcsAdj || 0);
  return Math.max(0.5, Math.round(total * 100) / 100);
}

/**
 * DB から最新体重と30日前体重を取得
 */
async function fetchWeightData(db, catId) {
  var latest = await db.prepare(
    "SELECT value, record_date FROM health_records WHERE cat_id = ? AND record_type = 'weight' AND value IS NOT NULL ORDER BY record_date DESC LIMIT 1"
  ).bind(catId).first();

  var cutoff = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -30);
  var older = await db.prepare(
    "SELECT value, record_date FROM health_records WHERE cat_id = ? AND record_type = 'weight' AND record_date <= ? AND value IS NOT NULL ORDER BY record_date DESC LIMIT 1"
  ).bind(catId, cutoff).first();

  var currentKg = latest ? parseFloat(latest.value) : null;
  var olderKg = older ? parseFloat(older.value) : null;

  return {
    current_kg: currentKg,
    current_date: latest ? latest.record_date : null,
    older_kg: olderKg,
    older_date: older ? older.record_date : null,
  };
}

/**
 * cat_nutrition_profiles を最新データで更新（体重記録時に呼ぶ）
 */
export async function refreshNutritionProfile(db, catId) {
  var cat = await db.prepare(
    'SELECT birth_date, neutered, species FROM cats WHERE id = ?'
  ).bind(catId).first();
  if (!cat) return null;

  var weights = await fetchWeightData(db, catId);
  if (!weights.current_kg) return null;

  var baseInfo = determineBaseMER(cat.birth_date, !!cat.neutered, cat.species || 'cat');
  var rer = calcRER(weights.current_kg, cat.species || 'cat');

  var existing = await db.prepare(
    'SELECT body_condition_score, target_kcal_vet, dietary_notes, status_tags FROM cat_nutrition_profiles WHERE cat_id = ?'
  ).bind(catId).first();

  var bcs = existing ? existing.body_condition_score : null;
  var bcsAdj = calcBCSAdj(bcs);

  var tags = [];
  if (existing && existing.status_tags) {
    try { tags = JSON.parse(existing.status_tags); } catch (_) {}
  }
  var statusResult = calcStatusAdj(tags);

  var trendData = calcWeightTrendAdj(weights.current_kg, weights.older_kg);
  var totalAdj = trendData.adj + statusResult.adj + bcsAdj;
  var effectiveFactor = calcEffectiveFactor(baseInfo.factor, trendData.adj, statusResult.adj, bcsAdj);
  var targetAuto = Math.round(rer * effectiveFactor);

  await db.prepare(
    'INSERT INTO cat_nutrition_profiles (cat_id, life_stage, last_weight_kg, weight_30d_ago_kg, weight_trend, weight_trend_pct, rer, mer_factor, mer_factor_auto_adj, target_kcal_auto, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\')) ON CONFLICT(cat_id) DO UPDATE SET life_stage = excluded.life_stage, last_weight_kg = excluded.last_weight_kg, weight_30d_ago_kg = excluded.weight_30d_ago_kg, weight_trend = excluded.weight_trend, weight_trend_pct = excluded.weight_trend_pct, rer = excluded.rer, mer_factor = excluded.mer_factor, mer_factor_auto_adj = excluded.mer_factor_auto_adj, target_kcal_auto = excluded.target_kcal_auto, updated_at = datetime(\'now\')'
  ).bind(
    catId, baseInfo.stage, weights.current_kg, weights.older_kg,
    trendData.trend, trendData.pct, rer, baseInfo.factor, totalAdj, targetAuto
  ).run();

  return {
    cat_id: catId,
    life_stage: baseInfo.stage,
    kitten_months: baseInfo.months || null,
    weight_kg: weights.current_kg,
    weight_trend: trendData.trend,
    weight_trend_pct: trendData.pct,
    weight_severity: trendData.severity,
    rer: rer,
    mer_base: baseInfo.factor,
    mer_effective: effectiveFactor,
    adjustments: {
      weight_trend: trendData.adj,
      status_tags: statusResult,
      bcs: bcsAdj,
    },
    target_kcal: (existing && existing.target_kcal_vet) || targetAuto,
    target_kcal_auto: targetAuto,
    target_kcal_vet: existing ? existing.target_kcal_vet : null,
    active_tags: tags,
  };
}

/**
 * 猫の1日の必要カロリーを取得（profile があればそこから、なければ即時計算）
 */
export async function getDailyTarget(db, catId) {
  var profile = await db.prepare(
    'SELECT target_kcal_vet, target_kcal_auto, last_weight_kg, life_stage, weight_trend, weight_trend_pct, rer, mer_factor, mer_factor_auto_adj FROM cat_nutrition_profiles WHERE cat_id = ?'
  ).bind(catId).first();

  if (profile) {
    var target = profile.target_kcal_vet || profile.target_kcal_auto || 0;
    return {
      target_kcal: Math.round(target),
      source: profile.target_kcal_vet ? 'vet' : 'auto',
      weight_kg: profile.last_weight_kg,
      life_stage: profile.life_stage,
      weight_trend: profile.weight_trend,
      rer: profile.rer,
      factor: Math.round((profile.mer_factor + (profile.mer_factor_auto_adj || 0)) * 100) / 100,
    };
  }

  var fresh = await refreshNutritionProfile(db, catId);
  if (fresh) {
    return {
      target_kcal: fresh.target_kcal,
      source: fresh.target_kcal_vet ? 'vet' : 'auto',
      weight_kg: fresh.weight_kg,
      life_stage: fresh.life_stage,
      weight_trend: fresh.weight_trend,
      rer: fresh.rer,
      factor: fresh.mer_effective || fresh.mer_base || null,
    };
  }

  return { target_kcal: 0, source: 'none', weight_kg: null };
}

// ─── 暦日ベースのカロリー集計 ──────────────────────
// 「今日の摂取」= 当日の食事記録（feeding_logs または health_records）
// feeding_prev_evening は前日の夕食なので当日集計に含めない

function jstToday() {
  return jstCalendarYmdFromInstant(Date.now());
}

var FEEDING_VALUE_TO_PCT = {
  '完食': 100,
  '完食に近い': 90,
  '少し残し': 80,
  '半分は残している': 50,
  '7割ぐらい残している': 30,
  '全残しに近い': 5,
};

function feedingValueToPct(value) {
  if (!value) return null;
  if (FEEDING_VALUE_TO_PCT[value] !== undefined) return FEEDING_VALUE_TO_PCT[value];
  if (value.indexOf('完食') !== -1) return 95;
  if (value.indexOf('残し') !== -1) return 50;
  return 70;
}

/**
 * health_records の定性的な食事記録からカロリーを推定
 * feeding_morning / feeding_evening のみ集計（feeding_prev_evening は前日分なので除外）
 */
async function estimateFromHealthRecords(db, catId, today) {
  var planRows = await db.prepare(
    'SELECT meal_slot, kcal_calc, amount_g FROM feeding_plans WHERE cat_id = ? AND active = 1'
  ).bind(catId).all();
  var plans = planRows.results || [];

  var planKcalBySlot = {};
  for (var p = 0; p < plans.length; p++) {
    var ps = plans[p].meal_slot || 'other';
    planKcalBySlot[ps] = (planKcalBySlot[ps] || 0) + (plans[p].kcal_calc || 0);
  }

  var hrRows = await db.prepare(
    "SELECT record_type, value FROM health_records WHERE cat_id = ? AND record_date = ? AND record_type IN ('feeding_morning', 'feeding_evening')"
  ).bind(catId, today).all();
  var hrs = hrRows.results || [];

  var eatenTotal = 0;
  var eatenCount = 0;
  var openCount = 0;
  var bySlot = {};
  var servedSlots = {};

  for (var i = 0; i < hrs.length; i++) {
    var hr = hrs[i];
    var slot = hr.record_type === 'feeding_morning' ? 'morning' : 'evening';
    var pct = feedingValueToPct(hr.value);

    if (pct !== null) {
      var slotKcal = planKcalBySlot[slot] || 0;
      var estimated = Math.round(slotKcal * pct / 100);
      eatenTotal += estimated;
      eatenCount++;
      bySlot[slot] = estimated;
      servedSlots[slot] = true;
    } else {
      openCount++;
    }
  }

  return {
    eatenTotal: eatenTotal,
    eatenCount: eatenCount,
    openCount: openCount,
    bySlot: bySlot,
    servedSlots: servedSlots,
    source: 'health_records',
  };
}

/**
 * 日次カロリーサマリ（暦日ベース）
 * 1. feeding_logs があればそこから集計
 * 2. なければ health_records の定性データ（feeding_morning/evening）からカロリー推定
 */
export async function getDailyNutritionSummary(db, catId, date) {
  var target = await getDailyTarget(db, catId);
  var today = date || jstToday();

  var allRows = await db.prepare(
    'SELECT eaten_kcal, meal_slot, remaining_g FROM feeding_logs WHERE cat_id = ? AND log_date = ?'
  ).bind(catId, today).all();

  var all = allRows.results || [];

  var eatenTotal = 0;
  var eatenCount = 0;
  var openCount = 0;
  var bySlot = {};
  var servedSlots = {};
  var dataSource = 'feeding_logs';

  if (all.length > 0) {
    for (var i = 0; i < all.length; i++) {
      var row = all[i];
      var slot = row.meal_slot || 'other';
      if (row.eaten_kcal !== null && row.eaten_kcal !== undefined) {
        var kcal = row.eaten_kcal || 0;
        eatenTotal += kcal;
        eatenCount++;
        bySlot[slot] = (bySlot[slot] || 0) + kcal;
      } else {
        openCount++;
      }
    }
    for (var j = 0; j < all.length; j++) {
      if (all[j].meal_slot) servedSlots[all[j].meal_slot] = true;
    }
  } else {
    var hrEstimate = await estimateFromHealthRecords(db, catId, today);
    eatenTotal = hrEstimate.eatenTotal;
    eatenCount = hrEstimate.eatenCount;
    openCount = hrEstimate.openCount;
    bySlot = hrEstimate.bySlot;
    servedSlots = hrEstimate.servedSlots;
    dataSource = 'health_records';
  }

  var plannedResult = await db.prepare(
    'SELECT COUNT(*) AS count FROM feeding_plans WHERE cat_id = ? AND active = 1'
  ).bind(catId).first();
  var plannedMeals = plannedResult ? (plannedResult.count || 0) : 0;

  var eatenKcal = Math.round(eatenTotal * 10) / 10;
  var remainingKcal = Math.max(0, Math.round((target.target_kcal - eatenKcal) * 10) / 10);
  var pct = target.target_kcal > 0 ? Math.round(eatenKcal / target.target_kcal * 100) : 0;

  var nowHour = jstCalendarHourFromInstant(Date.now());
  var status = 'on_track';
  if (pct >= 100) status = 'reached';
  else if (pct < 30 && nowHour >= 15) status = 'behind';

  return {
    target_kcal: target.target_kcal,
    target_source: target.source,
    eaten_kcal: eatenKcal,
    remaining_kcal: remainingKcal,
    pct: pct,
    status: status,
    breakdown: { by_slot: bySlot },
    checked_meals: eatenCount,
    unchecked_meals: openCount,
    planned_meals: plannedMeals,
    served_slots: Object.keys(servedSlots),
    data_source: dataSource,
    weight_kg: target.weight_kg,
    weight_trend: target.weight_trend,
    life_stage: target.life_stage,
    date: today,
  };
}

/** 食いつき集計の最大遡及日数（30日窓だけだと確認済みログがまばらな猫で空になりやすいため広めに取る） */
export var FOOD_PREF_LOOKBACK_DAYS = 90;

/**
 * フード傾向分析（既定: FOOD_PREF_LOOKBACK_DAYS 遡及・摂取率が記録済みのログ対象）
 */
export async function analyzeFoodPreference(db, catId, days) {
  days = days == null || days === '' ? FOOD_PREF_LOOKBACK_DAYS : days;
  var cutoff = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -days);

  var rows = await db.prepare(
    'SELECT f.id AS food_id, f.name, f.brand, f.form, f.flavor, f.kcal_per_100g, COUNT(*) AS times, AVG(fl.eaten_pct) AS avg_pct, SUM(fl.eaten_g) AS total_eaten_g, SUM(fl.eaten_kcal) AS total_kcal FROM feeding_logs fl JOIN foods f ON fl.food_id = f.id WHERE fl.cat_id = ? AND fl.log_date >= ? AND (fl.remaining_g IS NOT NULL OR fl.eaten_pct IS NOT NULL) GROUP BY fl.food_id ORDER BY avg_pct DESC'
  ).bind(catId, cutoff).all();

  return (rows.results || []).map(function(r) {
    return {
      food_id: r.food_id,
      name: r.name,
      brand: r.brand,
      form: r.form,
      flavor: r.flavor,
      times_served: r.times,
      avg_eaten_pct: Math.round(r.avg_pct || 0),
      total_eaten_g: Math.round((r.total_eaten_g || 0) * 10) / 10,
      total_kcal: Math.round((r.total_kcal || 0) * 10) / 10,
    };
  });
}

/**
 * 猫ごと・期間内の「残量確認済み」献立が載る暦日数（UI 用）
 */
export async function fetchFoodPreferenceCoverageBatch(db, catIds, cutoffYmd) {
  var map = {};
  if (!catIds || catIds.length === 0 || !cutoffYmd) return map;
  var ph = catIds.map(function () {
    return '?';
  }).join(',');
  var sql =
    'SELECT cat_id, MIN(log_date) AS dmin, MAX(log_date) AS dmax, COUNT(DISTINCT log_date) AS dcnt FROM feeding_logs WHERE cat_id IN (' +
    ph +
    ") AND log_date >= ? AND (remaining_g IS NOT NULL OR eaten_pct IS NOT NULL) GROUP BY cat_id";
  var stmt = db.prepare(sql);
  var bindArgs = catIds.slice();
  bindArgs.push(cutoffYmd);
  var res = await stmt.bind.apply(stmt, bindArgs).all();
  var rows = res.results || [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    map[String(r.cat_id)] = {
      min_log_date: r.dmin,
      max_log_date: r.dmax,
      distinct_day_count: r.dcnt != null ? Number(r.dcnt) : 0,
    };
  }
  return map;
}

/**
 * 複数猫のフード傾向を1クエリで取得（一覧用）
 */
export async function batchAnalyzeFoodPreference(db, catIds, days) {
  days = days == null || days === '' ? FOOD_PREF_LOOKBACK_DAYS : days;
  var byCat = {};
  if (!catIds || catIds.length === 0) return byCat;
  for (var ci = 0; ci < catIds.length; ci++) {
    byCat[String(catIds[ci])] = [];
  }
  var cutoff = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -days);
  var ph = catIds.map(function () { return '?'; }).join(',');
  var sql =
    'SELECT fl.cat_id, fl.food_id, MAX(f.name) AS name, MAX(f.brand) AS brand, MAX(f.form) AS form, MAX(f.flavor) AS flavor, MAX(f.kcal_per_100g) AS kcal_per_100g, ' +
    'COUNT(*) AS times, AVG(fl.eaten_pct) AS avg_pct, SUM(fl.eaten_g) AS total_eaten_g, SUM(fl.eaten_kcal) AS total_kcal ' +
    'FROM feeding_logs fl JOIN foods f ON fl.food_id = f.id WHERE fl.cat_id IN (' +
    ph +
    ") AND fl.log_date >= ? AND (fl.remaining_g IS NOT NULL OR fl.eaten_pct IS NOT NULL) GROUP BY fl.cat_id, fl.food_id";
  var stmt = db.prepare(sql);
  var bindArgs = catIds.slice();
  bindArgs.push(cutoff);
  var res = await stmt.bind.apply(stmt, bindArgs).all();
  var all = res.results || [];
  for (var ri = 0; ri < all.length; ri++) {
    var r = all[ri];
    var cid = String(r.cat_id);
    if (!byCat[cid]) byCat[cid] = [];
    byCat[cid].push({
      food_id: r.food_id,
      name: r.name,
      brand: r.brand,
      form: r.form,
      flavor: r.flavor,
      times_served: r.times,
      avg_eaten_pct: Math.round(r.avg_pct || 0),
      total_eaten_g: Math.round((r.total_eaten_g || 0) * 10) / 10,
      total_kcal: Math.round((r.total_kcal || 0) * 10) / 10,
    });
  }
  for (var key in byCat) {
    if (!Object.prototype.hasOwnProperty.call(byCat, key)) continue;
    byCat[key].sort(function (a, b) {
      return (b.avg_eaten_pct || 0) - (a.avg_eaten_pct || 0);
    });
  }
  return byCat;
}

/**
 * analyzeFoodPreference の配列 → UI用サマリ（加重平均・スプレッド・段階・上位5件）
 * @param coverage fetchFoodPreferenceCoverageBatch の1猫分（暦日・件数）
 */
export function summarizeFoodPreferences(items, periodDays, coverage) {
  periodDays = periodDays == null || periodDays === '' ? FOOD_PREF_LOOKBACK_DAYS : periodDays;
  var spanDays = coverage && coverage.distinct_day_count != null ? Number(coverage.distinct_day_count) : null;
  if (!items || !items.length) {
    return {
      period_days: periodDays,
      period_days_max: periodDays,
      record_span_days: spanDays,
      record_first_date: coverage ? coverage.min_log_date || null : null,
      record_last_date: coverage ? coverage.max_log_date || null : null,
      has_data: false,
      weighted_avg_pct: null,
      spread_pct: null,
      tiers: { high: 0, mid: 0, low: 0 },
      top_foods: [],
      summary_line: null,
    };
  }
  var totalW = 0;
  var sumWp = 0;
  for (var i = 0; i < items.length; i++) {
    var t = items[i].times_served || 0;
    var p = items[i].avg_eaten_pct || 0;
    totalW += t;
    sumWp += p * t;
  }
  var wAvg = totalW > 0 ? Math.round(sumWp / totalW) : null;

  var spreadList = items.filter(function (x) {
    return (x.times_served || 0) >= 2;
  });
  var spreadSource = spreadList.length >= 2 ? spreadList : items;
  var pcts = spreadSource.map(function (x) {
    return x.avg_eaten_pct || 0;
  });
  var spread = null;
  if (pcts.length >= 2) {
    var mx = Math.max.apply(null, pcts);
    var mn = Math.min.apply(null, pcts);
    spread = mx - mn;
  }

  var tiers = { high: 0, mid: 0, low: 0 };
  for (var j = 0; j < items.length; j++) {
    var ap = items[j].avg_eaten_pct || 0;
    if (ap >= 80) tiers.high++;
    else if (ap >= 40) tiers.mid++;
    else tiers.low++;
  }

  var sorted = items.slice().sort(function (a, b) {
    return (b.avg_eaten_pct || 0) - (a.avg_eaten_pct || 0);
  });
  var top5 = sorted.slice(0, 5);
  var topFoods = [];
  for (var k = 0; k < top5.length; k++) {
    var it = top5[k];
    var delta = wAvg != null ? Math.round((it.avg_eaten_pct || 0) - wAvg) : null;
    var ts = it.times_served || 0;
    var rel = ts >= 3 ? 'ok' : ts >= 2 ? 'mid' : 'low';
    topFoods.push({
      name: it.name,
      avg_eaten_pct: it.avg_eaten_pct,
      times_served: ts,
      delta_vs_weighted_avg: delta,
      reliability: rel,
    });
  }

  var summaryLine = null;
  if (wAvg != null && spread != null) {
    summaryLine = '平均約' + wAvg + '%。フード間の差は' + spread + 'pt。';
  } else if (wAvg != null) {
    summaryLine = '平均約' + wAvg + '%。';
  }

  return {
    period_days: periodDays,
    period_days_max: periodDays,
    record_span_days: spanDays,
    record_first_date: coverage ? coverage.min_log_date || null : null,
    record_last_date: coverage ? coverage.max_log_date || null : null,
    has_data: true,
    weighted_avg_pct: wAvg,
    spread_pct: spread,
    tiers: tiers,
    top_foods: topFoods,
    summary_line: summaryLine,
  };
}

/**
 * カロリー欠損検出（直近7日で70%未満が3日以上）
 */
export async function detectCalorieDeficit(db, catId) {
  var target = await getDailyTarget(db, catId);
  if (!target.target_kcal) return { alert: false, reason: 'no_target' };

  var sevenDaysAgo = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -7);

  var rows = await db.prepare(
    'SELECT log_date, SUM(eaten_kcal) AS daily_kcal FROM feeding_logs WHERE cat_id = ? AND log_date >= ? AND remaining_g IS NOT NULL GROUP BY log_date'
  ).bind(catId, sevenDaysAgo).all();

  var dailyData = rows.results || [];
  var deficitDays = 0;
  for (var i = 0; i < dailyData.length; i++) {
    if ((dailyData[i].daily_kcal || 0) < target.target_kcal * 0.7) {
      deficitDays++;
    }
  }

  return {
    alert: deficitDays >= 3,
    deficit_days: deficitDays,
    total_days_with_data: dailyData.length,
    target_kcal: target.target_kcal,
    threshold_pct: 70,
  };
}

/**
 * サマリ文字列を生成（UIチャット用）
 */
export function formatNutritionSummary(summary) {
  var parts = [];
  parts.push('📊 本日: ' + summary.eaten_kcal + '/' + summary.target_kcal + 'kcal（' + summary.pct + '%）');

  if (summary.breakdown && summary.breakdown.by_slot) {
    var bs = summary.breakdown.by_slot;
    parts.push('☀️' + (bs.morning || 0) + ' + 🌙' + (bs.evening || 0) + 'kcal');
  }

  if (summary.remaining_kcal > 0) {
    parts.push('残り ' + summary.remaining_kcal + 'kcal');
  }

  if (summary.unchecked_meals > 0) {
    parts.push('未確認 ' + summary.unchecked_meals + '食');
  }

  if (summary.status === 'behind') {
    parts.push('⚠️ 摂取ペースが遅れています');
  } else if (summary.status === 'reached') {
    parts.push('✅ 本日の目標達成');
  }

  return parts.join(' | ');
}

// ─── 残量未記録の検出（シフト対応） ──────────────

// 朝ごはん(~13:59提供) → 当日16:30までに確認
// 夕ごはん(14:00~提供)  → 翌日11:30までに確認
// 夜間(22:00-07:00)はアラートを出さない

var CHECK_DEADLINES = {
  morning: { hour: 16, minute: 30 },
  evening: { nextDay: true, hour: 11, minute: 30 },
};

var QUIET_HOURS = { start: 22, end: 7 };

function isQuietHours() {
  var h = jstCalendarHourFromInstant(Date.now());
  return h >= QUIET_HOURS.start || h < QUIET_HOURS.end;
}

function classifyMealSlot(servedTime) {
  if (!servedTime) return 'morning';
  var h = parseInt(servedTime.slice(11, 13), 10);
  return h >= 14 ? 'evening' : 'morning';
}

function isOverdue(servedTime, logDate) {
  if (!servedTime) return false;
  var slot = classifyMealSlot(servedTime);
  var deadline = CHECK_DEADLINES[slot];
  var nowH = jstCalendarHourFromInstant(Date.now());
  var nowM = jstCalendarMinuteFromInstant(Date.now());

  if (deadline.nextDay) {
    var today = jstCalendarYmdFromInstant(Date.now());
    if (logDate === today) return false;
    return nowH > deadline.hour || (nowH === deadline.hour && nowM >= deadline.minute);
  }

  return nowH > deadline.hour || (nowH === deadline.hour && nowM >= deadline.minute);
}

function deadlineLabel(servedTime) {
  var slot = classifyMealSlot(servedTime);
  var dl = CHECK_DEADLINES[slot];
  var h = dl.hour;
  var m = dl.minute;
  var prefix = dl.nextDay ? '翌' : '本日';
  return prefix + h + ':' + (m < 10 ? '0' : '') + m;
}

function buildOverdueItem(r) {
  var servedAt = r.served_time ? r.served_time.slice(11, 16) : '';
  var dl = deadlineLabel(r.served_time);
  var slot = classifyMealSlot(r.served_time);
  return {
    feeding_log_id: r.id,
    cat_id: r.cat_id,
    cat_name: r.cat_name || null,
    food_name: r.food_name || null,
    offered_g: r.offered_g,
    meal_order: r.meal_order,
    served_time: servedAt,
    meal_period: slot === 'evening' ? '夕' : '朝',
    deadline: dl,
    message: '🕐 ' + (r.cat_name || '') + ' ' + (r.food_name || 'ごはん') + ' ' + (r.offered_g || '?') + 'g（' + servedAt + '提供 / 期限' + dl + '）→ 残量確認してください',
  };
}

/**
 * 拠点内の全猫の未確認ごはんを検出（シフト対応）
 */
export async function findOverdueFeedingChecks(db, locationId) {
  if (isQuietHours()) return [];

  var today = jstCalendarYmdFromInstant(Date.now());
  var yesterday = jstCalendarAddDays(today, -1);

  var rows = await db.prepare(
    'SELECT fl.id, fl.cat_id, fl.meal_order, fl.offered_g, fl.served_time, fl.log_date, fl.meal_slot, c.name AS cat_name, f.name AS food_name FROM feeding_logs fl JOIN cats c ON fl.cat_id = c.id LEFT JOIN foods f ON fl.food_id = f.id WHERE fl.log_date IN (?, ?) AND fl.remaining_g IS NULL AND fl.served_time IS NOT NULL AND c.location_id = ? ORDER BY fl.served_time ASC'
  ).bind(today, yesterday, locationId).all();

  var results = [];
  var all = rows.results || [];
  for (var i = 0; i < all.length; i++) {
    if (isOverdue(all[i].served_time, all[i].log_date)) {
      results.push(buildOverdueItem(all[i]));
    }
  }
  return results;
}

/**
 * 特定の猫の未確認ごはんを検出（シフト対応）
 */
export async function findOverdueForCat(db, catId) {
  if (isQuietHours()) return [];

  var today = jstCalendarYmdFromInstant(Date.now());
  var yesterday = jstCalendarAddDays(today, -1);

  var rows = await db.prepare(
    'SELECT fl.id, fl.meal_order, fl.offered_g, fl.served_time, fl.log_date, f.name AS food_name FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id WHERE fl.cat_id = ? AND fl.log_date IN (?, ?) AND fl.remaining_g IS NULL AND fl.served_time IS NOT NULL ORDER BY fl.served_time ASC'
  ).bind(catId, today, yesterday).all();

  var results = [];
  var all = rows.results || [];
  for (var i = 0; i < all.length; i++) {
    if (isOverdue(all[i].served_time, all[i].log_date)) {
      results.push(all[i]);
    }
  }
  return results;
}

// ─── 猫カード: 1猫の全データ集約 ─────────────────

/**
 * 猫の全情報を1レスポンスに集約（UIカード用）
 */
export async function buildCatCard(db, catId) {
  var cat = await db.prepare(
    'SELECT id, name, photo_url, birth_date, sex, neutered, status, alert_level, alert_reason, description, internal_note FROM cats WHERE id = ?'
  ).bind(catId).first();
  if (!cat) return null;

  var months = ageMonthsFromBirth(cat.birth_date);
  var ageLabel = '';
  if (months !== null) {
    if (months < 12) {
      ageLabel = Math.round(months) + 'ヶ月';
    } else {
      ageLabel = Math.round(months / 12 * 10) / 10 + '歳';
    }
  }

  // --- 栄養プロファイル ---
  var profile = await db.prepare(
    'SELECT * FROM cat_nutrition_profiles WHERE cat_id = ?'
  ).bind(catId).first();

  var statusTags = [];
  if (profile && profile.status_tags) {
    try { statusTags = JSON.parse(profile.status_tags); } catch (_) {}
  }

  // --- 今日のカロリーサマリ（暦日ベース） ---
  var today = jstToday();
  var nutrition = null;
  try { nutrition = await getDailyNutritionSummary(db, catId, today); } catch (_) {}

  // --- 今日の食事ログ（暦日ベース: 当日分のみ） ---
  var feedingRows = await db.prepare(
    'SELECT fl.id, fl.meal_order, fl.offered_g, fl.remaining_g, fl.eaten_g, fl.eaten_pct, fl.eaten_kcal, fl.served_time, fl.checked_time, fl.meal_slot, fl.log_date, f.name AS food_name FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id WHERE fl.cat_id = ? AND fl.log_date = ? ORDER BY fl.meal_slot ASC, fl.served_time ASC'
  ).bind(catId, today).all();

  var todayMeals = [];
  var allFeeding = feedingRows.results || [];
  for (var i = 0; i < allFeeding.length; i++) {
    var fl = allFeeding[i];
    todayMeals.push({
      meal_period: fl.meal_slot || 'other',
      meal_order: fl.meal_order,
      food_name: fl.food_name,
      offered_g: fl.offered_g,
      served_time: fl.served_time ? fl.served_time.slice(11, 16) : null,
      checked: fl.remaining_g !== null,
      remaining_g: fl.remaining_g,
      eaten_g: fl.eaten_g,
      eaten_pct: fl.eaten_pct,
      eaten_kcal: fl.eaten_kcal,
      checked_time: fl.checked_time ? fl.checked_time.slice(11, 16) : null,
    });
  }

  // --- フードプラン ---
  var planRows = await db.prepare(
    'SELECT fp.meal_order, fp.scheduled_time, fp.amount_g, f.name AS food_name FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.cat_id = ? AND fp.active = 1 ORDER BY fp.meal_order'
  ).bind(catId).all();
  var feedingPlan = (planRows.results || []).map(function(p) {
    var served = false;
    for (var i = 0; i < todayMeals.length; i++) {
      if (todayMeals[i].meal_order === p.meal_order) { served = true; break; }
    }
    return {
      meal_order: p.meal_order,
      scheduled_time: p.scheduled_time,
      food_name: p.food_name,
      amount_g: p.amount_g,
      served_today: served,
    };
  });

  // --- 体重推移（直近5回） ---
  var weightRows = await db.prepare(
    "SELECT record_date, value, recorded_time FROM health_records WHERE cat_id = ? AND record_type = 'weight' AND value IS NOT NULL ORDER BY record_date DESC LIMIT 5"
  ).bind(catId).all();
  var weightHistory = (weightRows.results || []).map(function(w) {
    return { date: w.record_date, g: parseFloat(w.value), kg: Math.round(parseFloat(w.value) / 10) / 100 };
  }).reverse();

  // --- 投薬中の薬 ---
  var medRows = await db.prepare(
    'SELECT m.id, m.dosage_amount, m.dosage_unit, m.time_slots, m.frequency, m.purpose, med.name AS medicine_name FROM medications m JOIN medicines med ON m.medicine_id = med.id WHERE m.cat_id = ? AND m.active = 1 ORDER BY m.time_slots'
  ).bind(catId).all();
  var activeMeds = (medRows.results || []).map(function(m) {
    return {
      name: m.medicine_name,
      dosage: m.dosage_amount ? m.dosage_amount + (m.dosage_unit || '') : null,
      time_slots: m.time_slots,
      frequency: m.frequency,
      purpose: m.purpose,
    };
  });

  // --- 今日の投薬ログ ---
  var medLogRows = await db.prepare(
    "SELECT ml.medication_id, ml.status, ml.administered_at, ml.skip_reason, med.name AS medicine_name FROM medication_logs ml JOIN medications m ON ml.medication_id = m.id AND m.active = 1 JOIN medicines med ON m.medicine_id = med.id WHERE ml.cat_id = ? AND ml.administered_at >= ? ORDER BY ml.administered_at"
  ).bind(catId, today).all();
  var todayMedLogs = (medLogRows.results || []).map(function(ml) {
    return {
      medicine: ml.medicine_name,
      status: ml.status,
      time: ml.administered_at ? ml.administered_at.slice(11, 16) : null,
      skip_reason: ml.skip_reason,
    };
  });

  // --- 直近の健康イベント（7日） ---
  var sevenDaysAgo = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -7);
  var healthRows = await db.prepare(
    "SELECT record_type, record_date, recorded_time, value, details FROM health_records WHERE cat_id = ? AND record_date >= ? AND record_type != 'weight' ORDER BY record_date DESC, recorded_time DESC LIMIT 15"
  ).bind(catId, sevenDaysAgo).all();
  var recentHealth = (healthRows.results || []).map(function(h) {
    var det = {};
    try { det = JSON.parse(h.details || '{}'); } catch (_) {}
    return {
      type: h.record_type,
      date: h.record_date,
      time: h.recorded_time ? h.recorded_time.slice(11, 16) : null,
      value: h.value,
      details: det,
    };
  });

  // --- フード傾向（最大遡及日 FOOD_PREF_LOOKBACK_DAYS） ---
  var foodPref = null;
  try { foodPref = await analyzeFoodPreference(db, catId); } catch (_) {}

  // --- フード推薦 ---
  var foodSuggestion = null;
  try { foodSuggestion = await buildFoodSuggestion(db, catId); } catch (_) {}

  // --- カロリー欠損 ---
  var deficit = null;
  try { deficit = await detectCalorieDeficit(db, catId); } catch (_) {}

  // --- 未確認ごはんアラート ---
  var overdue = [];
  try { overdue = await findOverdueForCat(db, catId); } catch (_) {}

  // --- アラート集約 ---
  var alerts = [];
  if (cat.alert_level && cat.alert_level !== 'normal') {
    alerts.push({ type: 'health', level: cat.alert_level, message: cat.alert_reason || '健康注意' });
  }
  if (deficit && deficit.alert) {
    alerts.push({ type: 'calorie_deficit', level: 'warning', message: '直近7日中' + deficit.deficit_days + '日がカロリー不足（<70%）' });
  }
  if (profile && profile.weight_trend_pct && profile.weight_trend_pct <= -5) {
    alerts.push({ type: 'weight_loss', level: 'warning', message: '体重' + profile.weight_trend_pct + '%減少（30日間）' });
  }
  if (profile && profile.weight_trend_pct && profile.weight_trend_pct <= -10) {
    alerts[alerts.length - 1].level = 'critical';
  }
  if (overdue.length > 0) {
    alerts.push({ type: 'overdue_check', level: 'info', message: overdue.length + '食の残量確認が期限超過', items: overdue });
  }

  return {
    cat: {
      id: cat.id,
      name: cat.name,
      photo_url: cat.photo_url,
      age: ageLabel,
      age_months: months ? Math.round(months) : null,
      sex: cat.sex,
      neutered: !!cat.neutered,
      status: cat.status,
      description: cat.description,
    },
    nutrition: {
      profile: profile ? {
        weight_kg: profile.last_weight_kg,
        life_stage: profile.life_stage,
        rer: profile.rer,
        mer_base: profile.mer_factor,
        mer_effective: Math.round((profile.mer_factor + (profile.mer_factor_auto_adj || 0)) * 100) / 100,
        target_kcal: profile.target_kcal_vet || profile.target_kcal_auto,
        target_source: profile.target_kcal_vet ? 'vet' : 'auto',
        weight_trend: profile.weight_trend,
        weight_trend_pct: profile.weight_trend_pct,
        bcs: profile.body_condition_score,
        status_tags: statusTags,
      } : null,
      today: nutrition,
    },
    feeding: {
      plan: feedingPlan,
      today_meals: todayMeals,
      overdue_checks: overdue.map(function(o) {
        return { food_name: o.food_name, offered_g: o.offered_g, served_time: o.served_time ? o.served_time.slice(11, 16) : null };
      }),
    },
    weight_history: weightHistory,
    medications: {
      active: activeMeds,
      today_logs: todayMedLogs,
    },
    recent_health: recentHealth,
    food_preferences: foodPref,
    food_suggestion: foodSuggestion,
    alerts: alerts,
  };
}

// ─── フード推薦エンジン ─────────────────────────────

var FOOD_HEALTH_RULES = [
  {
    id: 'blood_stool',
    match: function(ctx) {
      var hits = filterRecent(ctx.health, ['blood_stool', 'blood_urine']);
      if (!hits.length) return null;
      var daysAgo = daysSince(hits[0].record_date);
      return { detected: hits[0].record_date, days_ago: daysAgo, severity: daysAgo <= 3 ? 'strong' : 'mild' };
    },
    label: function(m) { return '血便/血尿（' + m.days_ago + '日前）'; },
    prefer_form: ['wet', 'liquid'],
    avoid_form: ['dry'],
    reduce: ['fiber'],
    amount_adj: 1.0,
  },
  {
    id: 'vomiting_frequent',
    match: function(ctx) {
      var hits = filterRecent(ctx.health, ['vomiting'], 3);
      if (hits.length < 2) return null;
      return { count: hits.length, severity: 'strong' };
    },
    label: function(m) { return '頻回嘔吐（3日間で' + m.count + '回）'; },
    prefer_form: ['wet', 'liquid'],
    avoid_form: ['dry'],
    reduce: [],
    amount_adj: 0.7,
  },
  {
    id: 'vomiting_recent',
    match: function(ctx) {
      var hits = filterRecent(ctx.health, ['vomiting'], 7);
      if (!hits.length) return null;
      var freq = filterRecent(ctx.health, ['vomiting'], 3);
      if (freq.length >= 2) return null;
      return { days_ago: daysSince(hits[0].record_date), severity: 'mild' };
    },
    label: function(m) { return '嘔吐あり（' + m.days_ago + '日前）'; },
    prefer_form: ['wet'],
    avoid_form: [],
    reduce: [],
    amount_adj: 0.85,
  },
  {
    id: 'diarrhea',
    match: function(ctx) {
      var hits = filterRecent(ctx.health, ['diarrhea']);
      if (!hits.length) return null;
      return { days_ago: daysSince(hits[0].record_date), severity: daysSince(hits[0].record_date) <= 3 ? 'strong' : 'mild' };
    },
    label: function(m) { return '下痢（' + m.days_ago + '日前）'; },
    prefer_form: ['wet'],
    avoid_form: ['dry'],
    reduce: ['fiber'],
    increase: ['water'],
    amount_adj: 1.0,
  },
  {
    id: 'constipation',
    match: function(ctx) {
      var hits = filterRecent(ctx.health, ['constipation']);
      if (!hits.length) return null;
      return { days_ago: daysSince(hits[0].record_date), severity: 'mild' };
    },
    label: function(m) { return '便秘（' + m.days_ago + '日前）'; },
    prefer_form: ['wet'],
    avoid_form: [],
    reduce: [],
    increase: ['fiber', 'water'],
    amount_adj: 1.0,
  },
  {
    id: 'renal',
    match: function(ctx) {
      if (!hasTag(ctx.tags, 'renal')) return null;
      return { severity: 'strong' };
    },
    label: function() { return '腎臓ケア中'; },
    prefer_form: [],
    avoid_form: [],
    reduce: [],
    filters: { phosphorus_mg_per_100g: 250, sodium_mg_per_100g: 100 },
    prefer_purpose: ['renal', '腎臓'],
    amount_adj: 1.0,
  },
  {
    id: 'weight_loss',
    match: function(ctx) {
      if (!ctx.profile) return null;
      var t = ctx.profile.weight_trend;
      if (t !== 'minor_loss' && t !== 'major_loss' && t !== 'critical_loss') return null;
      return { trend: t, pct: ctx.profile.weight_trend_pct, severity: t === 'critical_loss' ? 'strong' : 'mild' };
    },
    label: function(m) { return '体重減少（' + m.pct + '%）'; },
    prefer_form: [],
    avoid_form: [],
    reduce: [],
    prefer_high_kcal: true,
    amount_adj: 1.15,
  },
  {
    id: 'dieting',
    match: function(ctx) {
      if (!hasTag(ctx.tags, 'dieting')) return null;
      return { severity: 'mild' };
    },
    label: function() { return 'ダイエット中'; },
    prefer_form: ['wet'],
    avoid_form: [],
    reduce: [],
    prefer_low_kcal: true,
    amount_adj: 0.9,
  },
  {
    id: 'kitten',
    match: function(ctx) {
      if (!ctx.profile || ctx.profile.life_stage !== 'kitten') return null;
      return { severity: 'mild' };
    },
    label: function() { return '子猫'; },
    prefer_form: [],
    avoid_form: [],
    reduce: [],
    prefer_purpose: ['kitten', '子猫', '成長'],
    prefer_high_kcal: true,
    amount_adj: 1.0,
  },
  {
    id: 'senior',
    match: function(ctx) {
      if (!ctx.profile || ctx.profile.life_stage !== 'senior') return null;
      return { severity: 'mild' };
    },
    label: function() { return 'シニア'; },
    prefer_form: ['wet'],
    avoid_form: [],
    reduce: [],
    prefer_purpose: ['senior', 'シニア'],
    filters: { phosphorus_mg_per_100g: 300 },
    amount_adj: 1.0,
  },
];

function filterRecent(healthRecords, types, withinDays) {
  withinDays = withinDays || 7;
  var cutoff = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -withinDays);
  var results = [];
  for (var i = 0; i < healthRecords.length; i++) {
    var r = healthRecords[i];
    if (r.record_date >= cutoff && types.indexOf(r.record_type) !== -1) {
      results.push(r);
    }
  }
  return results;
}

function daysSince(dateStr) {
  var today = jstCalendarYmdFromInstant(Date.now());
  return Math.round((new Date(today).getTime() - new Date(dateStr).getTime()) / 86400000);
}

function hasTag(tags, tag) {
  return tags && tags.indexOf(tag) !== -1;
}

// ─── ルーティン検出 ─────────────────────────────────

/**
 * 直近7日の給餌パターンから「いつもの」メニューを検出
 */
export async function detectFeedingRoutine(db, catId) {
  var cutoff = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -7);

  var rows = await db.prepare(
    'SELECT fl.meal_order, fl.food_id, f.name AS food_name, f.brand, f.form, f.kcal_per_100g, COUNT(*) AS times, AVG(fl.offered_g) AS avg_offered, AVG(fl.eaten_pct) AS avg_eaten_pct FROM feeding_logs fl JOIN foods f ON fl.food_id = f.id WHERE fl.cat_id = ? AND fl.log_date >= ? AND fl.food_id IS NOT NULL GROUP BY fl.meal_order, fl.food_id ORDER BY fl.meal_order ASC, times DESC'
  ).bind(catId, cutoff).all();

  var all = rows.results || [];

  var plans = await db.prepare(
    'SELECT fp.meal_order, fp.food_id, fp.amount_g, fp.scheduled_time, f.name AS food_name, f.brand, f.form, f.kcal_per_100g FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.cat_id = ? AND fp.active = 1 ORDER BY fp.meal_order'
  ).bind(catId).all();
  var planList = plans.results || [];

  var slotMap = {};
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    var key = r.meal_order || 1;
    if (!slotMap[key]) slotMap[key] = [];
    slotMap[key].push(r);
  }

  var planMap = {};
  for (var j = 0; j < planList.length; j++) {
    planMap[planList[j].meal_order || 1] = planList[j];
  }

  var allSlots = {};
  var k;
  for (k in slotMap) allSlots[k] = true;
  for (k in planMap) allSlots[k] = true;

  var routine = [];
  for (k in allSlots) {
    var slot = parseInt(k, 10);
    var plan = planMap[slot] || null;
    var patterns = slotMap[slot] || [];
    var top = patterns[0] || null;

    if (plan) {
      var patternNote = null;
      if (top && top.food_id === plan.food_id) {
        patternNote = '直近7日: ' + top.times + '回提供、平均食べた率' + Math.round(top.avg_eaten_pct || 0) + '%';
      } else if (top) {
        patternNote = '実績では ' + top.food_name + ' ' + Math.round(top.avg_offered) + 'g が多い（' + top.times + '回）';
      }
      routine.push({
        meal_order: slot,
        food_id: plan.food_id,
        food_name: plan.food_name,
        brand: plan.brand,
        form: plan.form,
        kcal_per_100g: plan.kcal_per_100g,
        suggested_g: plan.amount_g,
        scheduled_time: plan.scheduled_time,
        source: 'plan',
        pattern_note: patternNote,
        low_appetite_flag: top ? (top.avg_eaten_pct || 100) < 60 : false,
      });
    } else if (top) {
      routine.push({
        meal_order: slot,
        food_id: top.food_id,
        food_name: top.food_name,
        brand: top.brand,
        form: top.form,
        kcal_per_100g: top.kcal_per_100g,
        suggested_g: Math.round(top.avg_offered),
        scheduled_time: null,
        source: 'pattern',
        pattern_note: '直近7日: ' + top.times + '回提供、平均食べた率' + Math.round(top.avg_eaten_pct || 0) + '%',
        low_appetite_flag: (top.avg_eaten_pct || 100) < 60,
      });
    }
  }

  routine.sort(function(a, b) { return a.meal_order - b.meal_order; });
  return routine;
}

// ─── 健康ルール評価 ─────────────────────────────────

/**
 * 直近の健康記録 + ステータスタグ + 体重推移からフード関連ルールを評価
 */
export async function evaluateHealthRules(db, catId) {
  var sevenDaysAgo = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -7);
  var healthRows = await db.prepare(
    'SELECT record_type, record_date, value, details FROM health_records WHERE cat_id = ? AND record_date >= ? ORDER BY record_date DESC'
  ).bind(catId, sevenDaysAgo).all();

  var profile = await db.prepare(
    'SELECT life_stage, weight_trend, weight_trend_pct, status_tags, body_condition_score FROM cat_nutrition_profiles WHERE cat_id = ?'
  ).bind(catId).first();

  var tags = [];
  if (profile && profile.status_tags) {
    try { tags = JSON.parse(profile.status_tags); } catch (_) {}
  }

  var ctx = {
    health: healthRows.results || [],
    profile: profile,
    tags: tags,
  };

  var active = [];
  var allPreferForm = [];
  var allAvoidForm = [];
  var allReduce = [];
  var allIncrease = [];
  var allFilters = {};
  var allPreferPurpose = [];
  var combinedAmountAdj = 1.0;
  var preferHighKcal = false;
  var preferLowKcal = false;

  for (var i = 0; i < FOOD_HEALTH_RULES.length; i++) {
    var rule = FOOD_HEALTH_RULES[i];
    var matchResult = rule.match(ctx);
    if (!matchResult) continue;

    active.push({
      condition: rule.id,
      label: rule.label(matchResult),
      severity: matchResult.severity,
      rules: buildRuleLabels(rule),
    });

    mergeUnique(allPreferForm, rule.prefer_form || []);
    mergeUnique(allAvoidForm, rule.avoid_form || []);
    mergeUnique(allReduce, rule.reduce || []);
    mergeUnique(allIncrease, rule.increase || []);
    if (rule.prefer_purpose) mergeUnique(allPreferPurpose, rule.prefer_purpose);
    if (rule.prefer_high_kcal) preferHighKcal = true;
    if (rule.prefer_low_kcal) preferLowKcal = true;

    if (rule.filters) {
      for (var fk in rule.filters) {
        if (!allFilters[fk] || rule.filters[fk] < allFilters[fk]) {
          allFilters[fk] = rule.filters[fk];
        }
      }
    }

    if (rule.amount_adj !== 1.0) {
      combinedAmountAdj *= rule.amount_adj;
    }
  }

  combinedAmountAdj = Math.round(combinedAmountAdj * 100) / 100;

  return {
    active_rules: active,
    aggregated: {
      prefer_form: allPreferForm,
      avoid_form: allAvoidForm,
      reduce: allReduce,
      increase: allIncrease,
      filters: allFilters,
      prefer_purpose: allPreferPurpose,
      prefer_high_kcal: preferHighKcal,
      prefer_low_kcal: preferLowKcal,
      amount_adj: combinedAmountAdj,
    },
  };
}

function buildRuleLabels(rule) {
  var labels = [];
  if (rule.prefer_form && rule.prefer_form.length) {
    labels.push({ action: 'prefer_form', label: formLabel(rule.prefer_form) + '推奨' });
  }
  if (rule.avoid_form && rule.avoid_form.length) {
    labels.push({ action: 'avoid_form', label: formLabel(rule.avoid_form) + 'は控える' });
  }
  if (rule.reduce && rule.reduce.length) {
    labels.push({ action: 'reduce', label: nutrientLabel(rule.reduce) + '控えめ推奨' });
  }
  if (rule.increase && rule.increase.length) {
    labels.push({ action: 'increase', label: nutrientLabel(rule.increase) + '多め推奨' });
  }
  if (rule.prefer_high_kcal) labels.push({ action: 'prefer_high_kcal', label: '高カロリー推奨' });
  if (rule.prefer_low_kcal) labels.push({ action: 'prefer_low_kcal', label: '低カロリー推奨' });
  if (rule.amount_adj && rule.amount_adj !== 1.0) {
    var pct = Math.round((rule.amount_adj - 1) * 100);
    labels.push({ action: 'amount_adj', label: '量を' + (pct > 0 ? '+' : '') + pct + '%調整' });
  }
  return labels;
}

function formLabel(forms) {
  var map = { wet: 'ウェット', dry: 'ドライ', liquid: 'リキッド', semi_moist: 'セミモイスト', treat: 'おやつ' };
  return forms.map(function(f) { return map[f] || f; }).join('/');
}

function nutrientLabel(nutrients) {
  var map = { fiber: '繊維', water: '水分', protein: 'タンパク質', fat: '脂質' };
  return nutrients.map(function(n) { return map[n] || n; }).join('・');
}

function mergeUnique(target, source) {
  for (var i = 0; i < source.length; i++) {
    if (target.indexOf(source[i]) === -1) target.push(source[i]);
  }
}

// ─── フードマッチング ───────────────────────────────

/**
 * 全アクティブフードをスコアリングし、上位を返す
 */
export async function rankFoods(db, healthResult, routine, preferences, limit) {
  limit = limit || 5;

  var foodRows = await db.prepare(
    'SELECT id, name, brand, category, purpose, form, kcal_per_100g, protein_pct, fat_pct, fiber_pct, phosphorus_mg_per_100g, sodium_mg_per_100g, water_pct, serving_size_g, flavor FROM foods WHERE active = 1'
  ).all();
  var foods = foodRows.results || [];

  var agg = healthResult.aggregated;

  var routineFoodIds = {};
  for (var i = 0; i < routine.length; i++) {
    routineFoodIds[routine[i].food_id] = routine[i];
  }

  var prefMap = {};
  if (preferences) {
    for (var p = 0; p < preferences.length; p++) {
      prefMap[preferences[p].food_id] = preferences[p];
    }
  }

  var scored = [];
  for (var fi = 0; fi < foods.length; fi++) {
    var food = foods[fi];
    var score = 50;
    var reasons = [];
    var penalty = false;

    if (routineFoodIds[food.id]) {
      score += 30;
      reasons.push('いつもの');
    }

    if (agg.prefer_form.length && food.form && agg.prefer_form.indexOf(food.form) !== -1) {
      score += 20;
      reasons.push(formLabel([food.form]) + '推奨合致');
    }
    if (agg.avoid_form.length && food.form && agg.avoid_form.indexOf(food.form) !== -1) {
      score -= 40;
      penalty = true;
      reasons.push(formLabel([food.form]) + '非推奨');
    }

    var filterPass = true;
    if (agg.filters) {
      if (agg.filters.phosphorus_mg_per_100g && food.phosphorus_mg_per_100g != null) {
        if (food.phosphorus_mg_per_100g <= agg.filters.phosphorus_mg_per_100g) {
          score += 15;
          reasons.push('低リン');
        } else {
          score -= 20;
          filterPass = false;
        }
      }
      if (agg.filters.sodium_mg_per_100g && food.sodium_mg_per_100g != null) {
        if (food.sodium_mg_per_100g <= agg.filters.sodium_mg_per_100g) {
          score += 15;
          reasons.push('低ナトリウム');
        } else {
          score -= 20;
          filterPass = false;
        }
      }
    }

    if (agg.reduce.indexOf('fiber') !== -1 && food.fiber_pct != null) {
      if (food.fiber_pct < 1) { score += 10; reasons.push('低繊維'); }
      else if (food.fiber_pct > 3) { score -= 10; }
    }
    if (agg.increase.indexOf('fiber') !== -1 && food.fiber_pct != null) {
      if (food.fiber_pct >= 3) { score += 10; reasons.push('高繊維'); }
    }
    if (agg.increase.indexOf('water') !== -1 && food.water_pct != null) {
      if (food.water_pct >= 75) { score += 10; reasons.push('高水分'); }
    }

    if (agg.prefer_purpose.length) {
      var purposeMatch = matchesPurpose(food, agg.prefer_purpose);
      if (purposeMatch) { score += 20; reasons.push(purposeMatch); }
    }

    if (agg.prefer_high_kcal && food.kcal_per_100g) {
      if (food.kcal_per_100g >= 120) { score += 10; reasons.push('高カロリー'); }
    }
    if (agg.prefer_low_kcal && food.kcal_per_100g) {
      if (food.kcal_per_100g <= 80) { score += 10; reasons.push('低カロリー'); }
    }

    if (prefMap[food.id]) {
      var pref = prefMap[food.id];
      if (pref.avg_eaten_pct >= 80) { score += 10; reasons.push('よく食べる'); }
      else if (pref.avg_eaten_pct < 40) { score -= 15; reasons.push('食べ残し多い'); }
    }

    scored.push({
      food_id: food.id,
      name: food.name,
      brand: food.brand,
      form: food.form,
      kcal_per_100g: food.kcal_per_100g,
      match_score: Math.max(0, score),
      reasons: reasons,
      suggested_g: calcSuggestedG(food, routineFoodIds[food.id], agg.amount_adj),
      penalty: penalty,
      filter_pass: filterPass,
    });
  }

  scored.sort(function(a, b) { return b.match_score - a.match_score; });
  return scored.slice(0, limit);
}

function matchesPurpose(food, purposes) {
  var text = ((food.purpose || '') + ' ' + (food.category || '')).toLowerCase();
  for (var i = 0; i < purposes.length; i++) {
    if (text.indexOf(purposes[i].toLowerCase()) !== -1) return purposes[i] + '対応';
  }
  return null;
}

function calcSuggestedG(food, routineEntry, amountAdj) {
  var base = null;
  if (routineEntry) base = routineEntry.suggested_g;
  if (!base && food.serving_size_g) base = food.serving_size_g;
  if (!base) base = food.form === 'dry' ? 20 : 60;
  return Math.round(base * (amountAdj || 1));
}

// ─── 矛盾チェック ───────────────────────────────────

/**
 * feeding_plans のフードと健康ルールの矛盾を検出
 */
export function checkPlanConflicts(routine, healthResult, allFoods) {
  var agg = healthResult.aggregated;
  var warnings = [];

  var foodMap = {};
  if (allFoods) {
    for (var i = 0; i < allFoods.length; i++) {
      foodMap[allFoods[i].food_id || allFoods[i].id] = allFoods[i];
    }
  }

  for (var r = 0; r < routine.length; r++) {
    var item = routine[r];
    if (item.source !== 'plan') continue;
    var food = foodMap[item.food_id] || item;

    if (agg.avoid_form.length && food.form && agg.avoid_form.indexOf(food.form) !== -1) {
      warnings.push({
        level: 'caution',
        message: 'プラン（食事' + item.meal_order + '）は' + formLabel([food.form]) + 'ですが、' + agg.avoid_form.map(function(f) { return formLabel([f]); }).join('/') + 'は現在控えたほうが良い状態です',
        meal_order: item.meal_order,
        source: 'health_rule',
      });
    }

    if (agg.filters.phosphorus_mg_per_100g && food.phosphorus_mg_per_100g != null) {
      if (food.phosphorus_mg_per_100g > agg.filters.phosphorus_mg_per_100g) {
        warnings.push({
          level: 'caution',
          message: 'プラン（食事' + item.meal_order + '）の' + item.food_name + 'はリン含有量が高め（' + food.phosphorus_mg_per_100g + 'mg、上限' + agg.filters.phosphorus_mg_per_100g + 'mg）',
          meal_order: item.meal_order,
          source: 'health_rule',
        });
      }
    }

    if (agg.filters.sodium_mg_per_100g && food.sodium_mg_per_100g != null) {
      if (food.sodium_mg_per_100g > agg.filters.sodium_mg_per_100g) {
        warnings.push({
          level: 'caution',
          message: 'プラン（食事' + item.meal_order + '）の' + item.food_name + 'はナトリウム含有量が高め（' + food.sodium_mg_per_100g + 'mg、上限' + agg.filters.sodium_mg_per_100g + 'mg）',
          meal_order: item.meal_order,
          source: 'health_rule',
        });
      }
    }

    if (item.low_appetite_flag) {
      warnings.push({
        level: 'info',
        message: '食事' + item.meal_order + 'の' + item.food_name + 'は食べ残し傾向があります（直近の食べた率60%未満）',
        meal_order: item.meal_order,
        source: 'appetite',
      });
    }
  }

  return warnings;
}

// ─── 統合: フード推薦 ───────────────────────────────

/**
 * 猫のフード推薦を一括生成
 */
export async function buildFoodSuggestion(db, catId) {
  var routine = await detectFeedingRoutine(db, catId);
  var healthResult = await evaluateHealthRules(db, catId);
  var preferences = await analyzeFoodPreference(db, catId);
  var ranked = await rankFoods(db, healthResult, routine, preferences, 5);

  var warnings = checkPlanConflicts(routine, healthResult, ranked);

  var nutrition = null;
  try { nutrition = await getDailyNutritionSummary(db, catId); } catch (_) {}

  var remainingKcal = nutrition ? nutrition.remaining_kcal : null;
  var servedSlots = nutrition ? (nutrition.served_slots || []) : [];
  var remainingMeals = 0;
  for (var ri = 0; ri < routine.length; ri++) {
    var rSlot = routine[ri].meal_order || ri + 1;
    var rSlotName = rSlot <= 1 ? 'morning' : 'evening';
    if (servedSlots.indexOf(rSlotName) === -1) remainingMeals++;
  }

  var perMealKcal = null;
  if (remainingKcal !== null && remainingMeals > 0) {
    perMealKcal = Math.round(remainingKcal / remainingMeals);
  }

  var note = null;
  if (remainingKcal !== null && routine.length > 0) {
    if (remainingMeals > 0) {
      note = '本日残り' + remainingKcal + 'kcal（残り' + remainingMeals + '食、1食あたり約' + (perMealKcal || 0) + 'kcal目安）。';
    } else if (remainingKcal > 0) {
      note = '本日残り' + remainingKcal + 'kcal。全食提供済み。';
    } else {
      note = '本日の目標カロリー達成。';
    }
  }

  return {
    routine: routine,
    health_adjustments: healthResult.active_rules,
    recommended_foods: ranked,
    warnings: warnings,
    remaining_kcal: remainingKcal,
    remaining_meals: remainingMeals,
    per_meal_kcal: perMealKcal,
    note: note,
  };
}
