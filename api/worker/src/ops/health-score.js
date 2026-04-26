/**
 * NYAGI 健康スコアリングエンジン（P5）
 *
 * 6指標の重み付きスコアを算出:
 *   体重トレンド (20%) / 食欲 (20%) / はき戻し (10%) / 投薬遵守 (10%) / 通院・検査 (10%) / 食事形態 (30%)
 *   投薬なし猫: 投薬分を体重・検査に分配 → 25 / 20 / 10 / 0 / 15 / 30
 *
 *  食事形態ステータス (diet_status):
 *   normal       = 通常食          → 100
 *   therapeutic  = 療法食のみ       → 70
 *   liquid       = 液体食・流動食   → 35
 *   force_feeding = 強制給餌        → 10
 */

import { opsJson } from './router.js';
import { jstCalendarAddDays, jstCalendarYmdFromInstant } from './jst-util.js';

/** JST 暦日文字列（YYYY-MM-DD）から n 暦日前の YYYY-MM-DD（ログ日付・ダッシュボードの today と整合） */
function calendarDaysBeforeYmd(ymd, daysBack) {
  if (!ymd || ymd.length < 10) return ymd;
  return jstCalendarAddDays(ymd, -daysBack);
}

function jstTodayYmd() {
  return jstCalendarYmdFromInstant(Date.now());
}

/**
 * 猫1匹の健康スコアを算出して返す
 */
export async function calculateHealthScore(db, catId, today) {
  var weightResult = await calcWeightScore(db, catId);
  var appetiteResult = await calcAppetiteScore(db, catId, today);
  var vomitResult = await calcVomitScore(db, catId, today);
  var medResult = await calcMedicationScore(db, catId, today);
  var vetResult = await calcVetScore(db, catId, today);
  var dietResult = await calcDietStatusScore(db, catId);

  var weights, scores;
  if (medResult.hasMeds) {
    // 体重20 / 食欲20 / はき戻し10 / 投薬10 / 検査10 / 食事形態30
    weights = [20, 20, 10, 10, 10, 30];
    scores = [weightResult.score, appetiteResult.score, vomitResult.score, medResult.score, vetResult.score, dietResult.score];
  } else {
    // 投薬なし: 体重25 / 食欲20 / はき戻し10 / 投薬0 / 検査15 / 食事形態30
    weights = [25, 20, 10, 0, 15, 30];
    scores = [weightResult.score, appetiteResult.score, vomitResult.score, 0, vetResult.score, dietResult.score];
  }

  var total = 0;
  var totalWeight = 0;
  for (var i = 0; i < weights.length; i++) {
    total += scores[i] * weights[i];
    totalWeight += weights[i];
  }
  var totalScore = Math.round(total / totalWeight);

  var comments = [];
  if (weightResult.score < 100) comments.push(weightResult.comment);
  if (appetiteResult.score < 100) comments.push(appetiteResult.comment);
  if (vomitResult.score < 100) comments.push(vomitResult.comment);
  if (medResult.hasMeds && medResult.score < 100) comments.push(medResult.comment);
  if (vetResult.score < 100) comments.push(vetResult.comment);
  if (dietResult.score < 100) comments.push(dietResult.comment);

  return {
    total_score: totalScore,
    weight_score: weightResult.score,
    appetite_score: appetiteResult.score,
    vomit_score: vomitResult.score,
    medication_score: medResult.hasMeds ? medResult.score : null,
    vet_score: vetResult.score,
    diet_status_score: dietResult.score,
    diet_status: dietResult.status,
    comments: comments,
  };
}

/**
 * GET /health-scores?cat_id=xxx&limit=30 — スコア履歴参照
 */
export async function handleHealthScores(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  if (method !== 'GET') return opsJson({ error: 'method_not_allowed' }, 405);

  var catId = url.searchParams.get('cat_id');
  if (!catId) return opsJson({ error: 'missing_params', message: 'cat_id は必須です' }, 400);

  var live = url.searchParams.get('live') === 'true';
  var limit = Math.min(90, parseInt(url.searchParams.get('limit') || '30', 10) || 30);

  if (live) {
    var today = jstTodayYmd();
    var score = await calculateHealthScore(db, catId, today);

    var prev = await db.prepare(
      'SELECT total_score FROM health_scores WHERE cat_id = ? AND score_date < ? ORDER BY score_date DESC LIMIT 1'
    ).bind(catId, today).first();

    var liveResult = {
      cat_id: catId,
      score_date: today,
      total_score: score.total_score,
      weight_score: score.weight_score,
      appetite_score: score.appetite_score,
      vomit_score: score.vomit_score,
      medication_score: score.medication_score,
      vet_score: score.vet_score,
      behavior_score: score.behavior_score,
      detail: JSON.stringify(score),
      prev_total: prev ? prev.total_score : null,
    };
    return opsJson({ scores: [liveResult] });
  }

  var result = await db.prepare(
    'SELECT * FROM health_scores WHERE cat_id = ? ORDER BY score_date DESC LIMIT ?'
  ).bind(catId, limit).all();

  return opsJson({ scores: result.results || [] });
}

// ── 1. 体重トレンド ────────────────────────────────────────────────────────────
//
// 「直近4件だけ安定している」フォールスポジティブを防ぐため:
//   A) 全記録の最古→最新（長期トレンド）
//   B) 直近30日の最大値→最新（急落検知）
// 両方を計算し、変化率が大きい（悪い）方でスコアリングする。

async function calcWeightScore(db, catId) {
  var today = jstTodayYmd();
  var thirtyDaysAgo = calendarDaysBeforeYmd(today, 30);

  var allResult = await db.prepare(
    "SELECT value, record_date FROM health_records WHERE cat_id = ? AND record_type = 'weight' AND value IS NOT NULL ORDER BY record_date ASC"
  ).bind(catId).all();

  var allRows = allResult.results || [];
  if (allRows.length < 2) {
    return { score: 50, comment: { area: '体重', reason: '測定データ不足（2件未満）', advice: '定期的に体重を測定してください' } };
  }

  var latest = parseFloat(allRows[allRows.length - 1].value);
  var oldest = parseFloat(allRows[0].value);
  if (!oldest || oldest === 0) {
    return { score: 50, comment: { area: '体重', reason: '基準値なし', advice: '体重を記録してください' } };
  }

  // A: 全期間変化率（最古→最新）
  var longChangePct = Math.abs((latest - oldest) / oldest * 100);
  var longDirection = latest > oldest ? '増加' : '減少';

  // B: 直近30日の最大→最新（急落を検知）
  var recentMax = latest;
  for (var ri = 0; ri < allRows.length; ri++) {
    if (allRows[ri].record_date >= thirtyDaysAgo) {
      var v = parseFloat(allRows[ri].value);
      if (!isNaN(v) && v > recentMax) recentMax = v;
    }
  }
  var recentDropPct = recentMax > 0 ? (recentMax - latest) / recentMax * 100 : 0;

  // 悪い方（変化率が大きい方）を採用
  var worstPct;
  var worstDirection;
  var worstLabel;
  if (recentDropPct > longChangePct) {
    worstPct = recentDropPct;
    worstDirection = '減少';
    worstLabel = '直近30日で' + worstPct.toFixed(1) + '%減（' + recentMax.toFixed(2) + '→' + latest.toFixed(2) + 'kg）';
  } else {
    worstPct = longChangePct;
    worstDirection = longDirection;
    worstLabel = '全期間' + worstPct.toFixed(1) + '% ' + longDirection + '（' + oldest.toFixed(2) + '→' + latest.toFixed(2) + 'kg）';
  }

  if (worstPct <= 3) return { score: 100, comment: { area: '体重', reason: '安定（' + worstLabel + '）', advice: '' } };
  if (worstPct <= 5) return { score: 70, comment: { area: '体重', reason: '軽度変動（' + worstLabel + '）', advice: '食事量と体調を注意して観察' } };
  if (worstPct <= 10) return { score: 40, comment: { area: '体重', reason: '体重変動注意（' + worstLabel + '）', advice: '獣医師への相談を検討' } };
  return { score: 20, comment: { area: '体重', reason: '急激な変化（' + worstLabel + '）', advice: '早急に獣医師へ相談してください' } };
}

// ── 2. 食欲 ───────────────────────────────────────────────────────────────────

async function calcAppetiteScore(db, catId, today) {
  var sevenDaysAgo = calendarDaysBeforeYmd(today, 7);

  var result = await db.prepare(
    'SELECT eaten_pct FROM feeding_logs WHERE cat_id = ? AND log_date >= ? AND log_date <= ? AND eaten_pct IS NOT NULL'
  ).bind(catId, sevenDaysAgo, today).all();

  var rows = result.results || [];
  if (rows.length === 0) {
    var yesterday = calendarDaysBeforeYmd(today, 1);
    var prev = await db.prepare(
      'SELECT appetite_score FROM health_scores WHERE cat_id = ? AND score_date = ?'
    ).bind(catId, yesterday).first();
    var fallback = (prev && prev.appetite_score !== null) ? prev.appetite_score : 70;
    return { score: fallback, comment: { area: '食欲', reason: '直近7日の給餌記録なし（前日スコア継続）', advice: '給餌記録をつけてください' } };
  }

  var sum = 0;
  for (var i = 0; i < rows.length; i++) { sum += rows[i].eaten_pct; }
  var avg = sum / rows.length;
  var avgStr = Math.round(avg) + '%';

  if (avg >= 90) return { score: 100, comment: { area: '食欲', reason: '良好（平均摂取率 ' + avgStr + '）', advice: '' } };
  if (avg >= 70) return { score: 75, comment: { area: '食欲', reason: 'やや低下（平均摂取率 ' + avgStr + '）', advice: '嗜好性の高いフードを試す' } };
  if (avg >= 50) return { score: 40, comment: { area: '食欲', reason: '食欲低下（平均摂取率 ' + avgStr + '）', advice: 'ウェットフード追加・フード変更を検討' } };
  return { score: 10, comment: { area: '食欲', reason: '食欲不振（平均摂取率 ' + avgStr + '）', advice: '獣医師へ相談。強制給餌の必要性も検討' } };
}

// ── 3. 投薬遵守 ───────────────────────────────────────────────────────────────

async function calcMedicationScore(db, catId, today) {
  var activeMeds = await db.prepare(
    "SELECT id, frequency FROM medications WHERE cat_id = ? AND active = 1 AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)"
  ).bind(catId, today, today).all();

  if (!activeMeds.results || activeMeds.results.length === 0) {
    return { hasMeds: false, score: 0, comment: null };
  }

  var anyNonPrn = false;
  for (var mi = 0; mi < activeMeds.results.length; mi++) {
    var fq = activeMeds.results[mi].frequency;
    if (fq == null || String(fq).trim() !== '必要時') {
      anyNonPrn = true;
      break;
    }
  }
  if (!anyNonPrn) {
    return { hasMeds: false, score: 0, comment: null };
  }

  var sevenDaysAgo = calendarDaysBeforeYmd(today, 7);

  var totalLogs = await db.prepare(
    "SELECT COUNT(*) AS cnt FROM medication_logs ml JOIN medications m ON ml.medication_id = m.id " +
      "WHERE m.active = 1 AND ml.cat_id = ? AND ml.scheduled_at >= ? AND ml.scheduled_at <= ? AND (m.frequency IS NULL OR trim(m.frequency) != '必要時')"
  ).bind(catId, sevenDaysAgo, today + 'T23:59:59').first();

  var doneLogs = await db.prepare(
    "SELECT COUNT(*) AS cnt FROM medication_logs ml JOIN medications m ON ml.medication_id = m.id " +
      "WHERE m.active = 1 AND ml.cat_id = ? AND ml.scheduled_at >= ? AND ml.scheduled_at <= ? AND ml.status = 'done' AND (m.frequency IS NULL OR trim(m.frequency) != '必要時')"
  ).bind(catId, sevenDaysAgo, today + 'T23:59:59').first();

  var total = totalLogs ? (totalLogs.cnt || 0) : 0;
  var done = doneLogs ? (doneLogs.cnt || 0) : 0;

  if (total === 0) return { hasMeds: true, score: 70, comment: { area: '投薬', reason: '直近7日の投薬ログなし', advice: '投薬記録をつけてください' } };

  var rate = done / total * 100;
  var rateStr = Math.round(rate) + '%（' + done + '/' + total + '）';

  if (rate >= 100) return { hasMeds: true, score: 100, comment: { area: '投薬', reason: '遵守率 ' + rateStr, advice: '' } };
  if (rate >= 80) return { hasMeds: true, score: 75, comment: { area: '投薬', reason: '遵守率 ' + rateStr, advice: '飲み忘れに注意' } };
  if (rate >= 50) return { hasMeds: true, score: 40, comment: { area: '投薬', reason: '遵守率低下（' + rateStr + '）', advice: '投薬時間のリマインドを設定' } };
  return { hasMeds: true, score: 10, comment: { area: '投薬', reason: '遵守率不足（' + rateStr + '）', advice: '投薬方法の見直しを検討' } };
}

// ── 4. 通院・検査 ─────────────────────────────────────────────────────────────

var CLINIC_RECORD_TYPES = ['vaccine', 'checkup', 'surgery', 'dental', 'emergency', 'test', 'observation'];
var CLINIC_IN_SQL = "('vaccine','checkup','surgery','dental','emergency','test','observation')";

async function calcVetScore(db, catId, today) {
  var futureResult = await db.prepare(
    'SELECT next_due FROM health_records WHERE cat_id = ? AND record_type IN ' + CLINIC_IN_SQL + ' AND next_due IS NOT NULL AND next_due >= ? ORDER BY next_due ASC LIMIT 1'
  ).bind(catId, today).first();

  if (futureResult && futureResult.next_due) {
    var diffMs = new Date(futureResult.next_due) - new Date(today);
    var diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    if (diffDays > 30) return { score: 100, comment: { area: '検査', reason: '次回予定まで ' + diffDays + ' 日', advice: '' } };
    return { score: 70, comment: { area: '検査', reason: '次回予定まで ' + diffDays + ' 日', advice: '予約を確認してください' } };
  }

  var lastVisit = await db.prepare(
    'SELECT record_date FROM health_records WHERE cat_id = ? AND record_type IN ' + CLINIC_IN_SQL + ' AND next_due IS NULL ORDER BY record_date DESC LIMIT 1'
  ).bind(catId).first();

  if (!lastVisit) return { score: 50, comment: { area: '検査', reason: '通院・検査の記録なし', advice: '定期健診の予定を登録してください' } };

  var visitDiffMs = new Date(today) - new Date(lastVisit.record_date);
  var monthsSince = Math.floor(visitDiffMs / (30.44 * 86400000));
  if (monthsSince <= 6) return { score: 90, comment: { area: '検査', reason: monthsSince + 'ヶ月前に受診', advice: '' } };
  if (monthsSince <= 12) return { score: 60, comment: { area: '検査', reason: monthsSince + 'ヶ月前に受診', advice: '次回の予定を登録してください' } };
  return { score: 30, comment: { area: '検査', reason: monthsSince + 'ヶ月間未受診', advice: '定期健診の予定を登録してください' } };
}

// ── 5. はき戻し ──────────────────────────────────────────────────────────────

async function calcVomitScore(db, catId, today) {
  var sevenDaysAgo = calendarDaysBeforeYmd(today, 7);

  var result = await db.prepare(
    "SELECT record_date, value, details FROM health_records WHERE cat_id = ? AND record_date >= ? AND record_date <= ? AND (record_type = 'vomiting' OR (record_type = 'observation' AND (value LIKE '%はき戻し%' OR value LIKE '%嘔吐%' OR value LIKE '%吐いた%' OR details LIKE '%はき戻し%' OR details LIKE '%嘔吐%')))"
  ).bind(catId, sevenDaysAgo, today).all();

  var rows = result.results || [];
  var totalCount = 0;
  for (var i = 0; i < rows.length; i++) {
    var cnt = 1;
    var txt = (rows[i].value || '') + ' ' + (rows[i].details || '');
    var m = txt.match(/(\d+)\s*回/);
    if (m) cnt = parseInt(m[1], 10) || 1;
    totalCount += cnt;
  }

  var cntStr = totalCount + '回/7日';

  if (totalCount === 0) return { score: 100, comment: { area: 'はき戻し', reason: '7日間の記録なし', advice: '' } };
  if (totalCount === 1) return { score: 80, comment: { area: 'はき戻し', reason: cntStr, advice: '単発なら経過観察。毛玉の可能性あり' } };
  if (totalCount === 2) return { score: 60, comment: { area: 'はき戻し', reason: cntStr, advice: 'フードの変更やペースを確認。続くなら受診検討' } };
  if (totalCount <= 4) return { score: 35, comment: { area: 'はき戻し', reason: cntStr + '（頻発）', advice: 'フード・給餌方法を見直し。獣医師への相談推奨' } };
  return { score: 10, comment: { area: 'はき戻し', reason: cntStr + '（多発）', advice: '早急に獣医師へ相談してください' } };
}

// ── 6. 食事形態ステータス ─────────────────────────────────────────────────────
//
//  cats.diet_status の値に基づいてスコアリング。手動設定のみ（自動変更なし）。
//    normal        = 通常食          → 100
//    therapeutic   = 療法食のみ       → 70
//    liquid        = 液体食・流動食   → 35
//    force_feeding = 強制給餌        → 10

var DIET_STATUS_MAP = {
  normal:        { score: 100, label: '通常食',        emoji: '🍚' },
  therapeutic:   { score: 70,  label: '療法食のみ',    emoji: '💊' },
  liquid:        { score: 35,  label: '液体食・流動食', emoji: '🥤' },
  force_feeding: { score: 10,  label: '強制給餌',      emoji: '💉' },
};

async function calcDietStatusScore(db, catId) {
  var row = await db.prepare('SELECT diet_status FROM cats WHERE id = ?').bind(catId).first();
  var status = (row && row.diet_status) ? String(row.diet_status).trim() : 'normal';
  var info = DIET_STATUS_MAP[status] || DIET_STATUS_MAP['normal'];

  if (info.score >= 100) {
    return { score: 100, status: status, comment: { area: '食事形態', reason: info.emoji + ' ' + info.label, advice: '' } };
  }
  var adviceMap = {
    therapeutic:   '療法食への移行を継続。食欲の変化を記録してください',
    liquid:        '固形物への移行タイミングを獣医師と相談してください',
    force_feeding: '強制給餌中。体重・水分摂取量を毎日記録してください',
  };
  return {
    score: info.score,
    status: status,
    comment: {
      area: '食事形態',
      reason: info.emoji + ' ' + info.label + '（通常食に戻れていない）',
      advice: adviceMap[status] || '',
    },
  };
}
