/**
 * NYAGI L2 ルールエンジン
 *
 * L1 構造化後に呼ばれる。ベースライン照合 / anomaly_rules / 連続カウンタ で
 * 保存 or L3-L5 エスカレーション or Slack 通知テンプレート を決定する。
 */

import {
  jstCalendarYmdFromInstant,
  jstCalendarAddDays,
  jstCalendarYmFromInstant,
  jstCalendarYmdFromParsedIso,
} from './jst-util.js';

/**
 * @param {object} parsed  L1 で構造化された結果
 * @param {object|null} catRecord  cats テーブルのレコード
 * @param {object} env  Cloudflare Worker env
 * @returns {Promise<{ dest: string, reason?: string, flag?: string, slack_msg?: string, auto_action?: object }>}
 */
export async function postCheck(parsed, catRecord, env) {
  var db = env.OPS_DB;
  var catId = parsed.cat_id || (catRecord && catRecord.id) || null;
  if (!catId) return { dest: 'save' };

  var baselines = await db.prepare(
    'SELECT metric, normal_value, note FROM cat_baselines WHERE cat_id = ?'
  ).bind(catId).all();
  var baselineRows = baselines.results || [];

  var recentLogs = await db.prepare(
    'SELECT * FROM voice_inputs WHERE target_cat_id = ? AND created_at >= datetime("now", "-7 days") ORDER BY created_at DESC'
  ).bind(catId).all();
  var recentRows = recentLogs.results || [];

  var anomalyRules = await db.prepare(
    'SELECT * FROM anomaly_rules WHERE active = 1 ORDER BY priority DESC'
  ).bind().all();
  var ruleRows = anomalyRules.results || [];

  var todayStr = jstCalendarYmdFromInstant(Date.now());
  var p = parsed.parsed || {};
  var mod = parsed.module || '';
  var recordType = parsed.record_type || '';

  // ── STEP A: 危険な組み合わせ → L5/L4 直行 ──
  var internalNote = (catRecord && catRecord.internal_note) || '';

  if (internalNote.indexOf('結石予備軍') !== -1 && isVomiting(mod, recordType, p)) {
    return { dest: 'L5', reason: '持病×嘔吐', slack_msg: buildSlackMsg(catRecord, '嘔吐+結石予備軍 → 要判断') };
  }

  if (internalNote.indexOf('FIV') !== -1 && isAppetiteLoss(mod, recordType, p)) {
    return { dest: 'L5', reason: 'FIV×食欲不振', slack_msg: buildSlackMsg(catRecord, 'FIV×食欲不振 → 要判断') };
  }

  var todayAnomalies = countTodayAnomalies(recentRows, todayStr);
  if (todayAnomalies >= 2) {
    return { dest: 'L4', reason: '同日複数異常', slack_msg: buildSlackMsg(catRecord, '同日' + todayAnomalies + '件異常') };
  }

  // ── STEP A2: 出血の3段階判定（いつものやつ / 軽度 / 重度） ──
  var rawText = parsed.raw_transcript || '';
  var bloodStatus = p.status || p.symptom || '';
  var hasBloodKeyword = bloodStatus.indexOf('血便') !== -1 || bloodStatus.indexOf('血尿') !== -1 ||
    rawText.indexOf('血便') !== -1 || rawText.indexOf('血尿') !== -1;

  if (hasBloodKeyword) {
    var severityAmplifiers = ['大量', '止まらない', 'ひどい', '激しい'];
    var isSevere = false;
    for (var sa = 0; sa < severityAmplifiers.length; sa++) {
      if (rawText.indexOf(severityAmplifiers[sa]) !== -1) { isSevere = true; break; }
    }

    var hasSeverityDetail = isSevere ||
      rawText.indexOf('少量') !== -1 || rawText.indexOf('少し') !== -1 ||
      rawText.indexOf('多い') !== -1 || rawText.indexOf('黒い') !== -1 ||
      rawText.indexOf('気味') !== -1 || rawText.indexOf('なし') !== -1;
    var catName = (catRecord && catRecord.name) || '不明';

    // 重度出血 → L5
    if (isSevere) {
      return { dest: 'L5', reason: '重度出血', slack_msg: buildSlackMsg(catRecord, '🔴 重度出血 → 至急受診') };
    }

    // いつものやつ（慢性出血猫） → save
    var isChronic = false;
    for (var bi = 0; bi < baselineRows.length; bi++) {
      if (baselineRows[bi].metric === 'blood_is_chronic' && baselineRows[bi].normal_value === 'true') {
        isChronic = true;
        break;
      }
    }
    if (isChronic) {
      var chronicMsg = hasSeverityDetail ? null :
        '✅ ' + catName + '血便 記録しました（いつもの）\n' +
        '⚠️ いつもと違う場合だけ返信:\n' +
        '→ 量が多い → 「' + catName + ' 血便 多い」\n' +
        '→ 色が黒い → 「' + catName + ' 血便 黒い」';
      return { dest: 'save', flag: 'chronic_blood', slack_msg: chronicMsg };
    }

    // 軽度出血 → L3（初回）, L4（反復）
    var recentBloodCount = countRecentBlood(recentRows, 7);
    if (recentBloodCount >= 3) {
      return { dest: 'L4', reason: '軽度出血が7日で' + (recentBloodCount + 1) + '回', slack_msg: buildSlackMsg(catRecord, '⚠️ 出血が反復 → 受診推奨。慢性なら blood_is_chronic を設定') };
    }

    var followupMsg = null;
    if (!hasSeverityDetail) {
      followupMsg = '⚠️ ' + catName + '血便 記録しました\n' +
        '🔍 確認お願いします（番号で返信OK）:\n' +
        '① いつも通りの少量 → 「1」\n' +
        '② 普通〜やや多め → 「2」\n' +
        '③ 明らかに多い/黒い → 「3」';
    } else {
      followupMsg = buildSlackMsg(catRecord, '軽度出血あり。経過観察し再発時は受診検討');
    }

    return {
      dest: 'L3', reason: '軽度出血',
      slack_msg: followupMsg,
      auto_action: hasSeverityDetail ? null : { create_action_item: { title: catName + ' 血便フォローアップ', due_minutes: 30 } },
    };
  }

  // ── STEP B: ベースライン照合 ──
  var baselineMap = {};
  for (var i = 0; i < baselineRows.length; i++) {
    baselineMap[baselineRows[i].metric] = baselineRows[i];
  }

  if (recordType === 'stool' || mod === 'stool') {
    var stoolStatus = p.status || p.symptom || '';
    if ((stoolStatus === '軟便' || stoolStatus === 'soft') && baselineMap.stool && baselineMap.stool.normal_value === 'soft') {
      return { dest: 'save', flag: 'baseline_normal' };
    }
  }

  if (isVomiting(mod, recordType, p)) {
    var hairball = isHairballVomit(p);
    if (hairball && baselineMap.hairball_vomit_monthly_limit) {
      var limit = parseInt(baselineMap.hairball_vomit_monthly_limit.normal_value, 10) || 3;
      var monthVomitCount = countMonthlyHairballVomit(recentRows);
      if (monthVomitCount < limit) {
        return { dest: 'save' };
      } else {
        return { dest: 'L3', reason: '毛玉嘔吐月上限超え(' + monthVomitCount + '/' + limit + ')' };
      }
    }
  }

  if (mod === 'weight' || recordType === 'weight') {
    var weightVal = parseFloat(p.amount || p.value || p.weight || '0');
    if (weightVal > 0 && baselineMap.weight_range) {
      var range = parseWeightRange(baselineMap.weight_range.normal_value);
      if (range && (weightVal >= range.min && weightVal <= range.max)) {
        return { dest: 'save' };
      }
    }
  }

  // ── STEP C: anomaly_rules テーブル照合 ──
  for (var r = 0; r < ruleRows.length; r++) {
    var rule = ruleRows[r];
    var condition = safeParseJson(rule.condition);
    if (!condition) continue;

    if (matchCondition(condition, parsed, p)) {
      var actionType = rule.action_type || 'flag_only';

      if (actionType === 'template') {
        var tmpl = safeParseJson(rule.action_config) || {};
        var autoAction = tmpl.auto_action || null;
        return {
          dest: 'save',
          flag: 'template_action',
          slack_msg: tmpl.message || rule.message_template || buildSlackMsg(catRecord, rule.name || 'ルール該当'),
          auto_action: autoAction,
        };
      }

      if (actionType === 'flag_only') {
        return { dest: 'save', flag: rule.name || 'anomaly_rule_match' };
      }

      if (actionType === 'escalate_l3') return { dest: 'L3', reason: rule.name || 'anomaly_rule' };
      if (actionType === 'escalate_l4') return { dest: 'L4', reason: rule.name || 'anomaly_rule' };
      if (actionType === 'escalate_l5') return { dest: 'L5', reason: rule.name || 'anomaly_rule', slack_msg: buildSlackMsg(catRecord, rule.name || 'ルール該当') };
    }
  }

  // ── STEP D: 閾値チェック（連続カウンタ） ──
  if (recordType === 'stool' || mod === 'stool') {
    var stoolStatus = p.status || p.symptom || '';
    if (stoolStatus === '軟便' || stoolStatus === 'soft' || stoolStatus === '下痢' || stoolStatus === 'diarrhea') {
      var softCount = countRecentSoftStool(recentRows, 3);
      if (softCount >= 2) {
        return { dest: 'L3', reason: '軟便3日で' + softCount + '回' };
      }
      return { dest: 'save', flag: 'soft_stool_first' };
    }
  }

  if (mod === 'weight' || recordType === 'weight') {
    var weightVal = parseFloat(p.amount || p.value || p.weight || '0');
    if (weightVal > 0) {
      var prevWeight = findPreviousWeight(recentRows);
      if (prevWeight > 0) {
        var pctChange = Math.abs(weightVal - prevWeight) / prevWeight * 100;
        if (pctChange > 10) return { dest: 'L4', reason: '体重変動>' + Math.round(pctChange) + '%' };
        if (pctChange > 5) return { dest: 'L3', reason: '体重変動>' + Math.round(pctChange) + '%' };
        if (pctChange > 3) return { dest: 'save', flag: 'weight_change_' + Math.round(pctChange) + 'pct' };
      }
    }
  }

  if (mod === 'feeding' || recordType === 'feeding') {
    var leftover = p.leftover_pct || p.leftover || null;
    if (leftover !== null) {
      var leftoverPct = parseInt(leftover, 10);
      if (leftoverPct > 50) {
        var consecutiveLeftover = countConsecutiveLeftover(recentRows, 3);
        if (consecutiveLeftover >= 3) {
          return { dest: 'L3', reason: '食べ残し>50% 3日連続' };
        }
        return { dest: 'save', flag: 'high_leftover' };
      }
    }
  }

  if (mod === 'medication' || recordType === 'medication') {
    var medStatus = p.status || '';
    if (medStatus === '拒否' || medStatus === 'refused' || medStatus === '嘔吐' || medStatus === 'vomited') {
      var hasRemedyInRules = findMedRemedyInRules(ruleRows, catId);
      if (hasRemedyInRules) {
        return {
          dest: 'save',
          flag: 'med_refused_with_remedy',
          slack_msg: buildSlackMsg(catRecord, (p.medicine_name || '投薬') + '拒否。' + (hasRemedyInRules.tip || '')),
          auto_action: { create_action_item: { title: '再投薬確認', due_minutes: 30 } },
        };
      }
      return { dest: 'L3', reason: '投薬拒否/嘔吐（対処法なし）' };
    }
  }

  // ── 正常 ──
  return { dest: 'save' };
}

/**
 * postCheck の結果に基づいて cats.alert_level を自動昇格
 */
export async function autoEscalateAlertLevel(db, catId, l2Result) {
  if (!catId || !l2Result) return;

  var dest = l2Result.dest;
  if (dest === 'L4' || dest === 'L5') {
    var until = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), 3);
    await db.prepare(
      "UPDATE cats SET alert_level = 'critical', alert_reason = ?, alert_until = ?, alert_set_by = 'system', updated_at = datetime('now') WHERE id = ? AND alert_level != 'critical'"
    ).bind(l2Result.reason || dest, until, catId).run();
    return;
  }

  if (dest === 'L3') {
    var cat = await db.prepare('SELECT alert_level FROM cats WHERE id = ?').bind(catId).first();
    if (cat && cat.alert_level === 'normal') {
      var until = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), 2);
      await db.prepare(
        "UPDATE cats SET alert_level = 'watch', alert_reason = ?, alert_until = ?, alert_set_by = 'system', updated_at = datetime('now') WHERE id = ?"
      ).bind(l2Result.reason || dest, until, catId).run();
    }
  }
}

// ── ヘルパー関数 ──

function isVomiting(mod, recordType, p) {
  return mod === 'vomiting' || recordType === 'vomiting' ||
    (p.symptom && (p.symptom.indexOf('嘔吐') !== -1 || p.symptom.indexOf('吐') !== -1));
}

function isAppetiteLoss(mod, recordType, p) {
  return (p.symptom && (p.symptom.indexOf('食欲不振') !== -1 || p.symptom.indexOf('食べない') !== -1)) ||
    (p.status && (p.status.indexOf('食欲不振') !== -1 || p.status.indexOf('食べない') !== -1));
}

function isHairballVomit(p) {
  var s = (p.symptom || '') + ' ' + (p.status || '') + ' ' + (p.note || '');
  return s.indexOf('毛玉') !== -1;
}

function countTodayAnomalies(recentRows, todayStr) {
  var count = 0;
  for (var i = 0; i < recentRows.length; i++) {
    var row = recentRows[i];
    var createdDate = jstCalendarYmdFromParsedIso(row.created_at || '');
    if (createdDate !== todayStr) continue;
    var layer = row.routing_layer || '';
    if (layer === 'L1_with_anomaly_flag' || layer === 'L3' || layer === 'L4' || layer === 'L5') {
      count++;
    }
  }
  return count;
}

function countMonthlyHairballVomit(recentRows) {
  var monthStart = jstCalendarYmFromInstant(Date.now());
  var count = 0;
  for (var i = 0; i < recentRows.length; i++) {
    var row = recentRows[i];
    if (jstCalendarYmdFromParsedIso(row.created_at || '').slice(0, 7) !== monthStart) continue;
    var parsed = safeParseJson(row.parsed_data);
    if (parsed && isHairballVomit(parsed.parsed || parsed)) count++;
  }
  return count;
}

function parseWeightRange(rangeStr) {
  if (!rangeStr) return null;
  var parts = String(rangeStr).split('-');
  if (parts.length !== 2) return null;
  var min = parseFloat(parts[0]);
  var max = parseFloat(parts[1]);
  if (isNaN(min) || isNaN(max)) return null;
  return { min: min, max: max };
}

function countRecentBlood(recentRows, days) {
  var cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  var count = 0;
  for (var i = 0; i < recentRows.length; i++) {
    var row = recentRows[i];
    var rowMs = Date.parse(String(row.created_at || '').replace(' ', 'T'));
    if (isNaN(rowMs) || rowMs < cutoffMs) continue;
    var raw = row.raw_transcript || '';
    var pd = safeParseJson(row.parsed_data);
    var pp = (pd && pd.parsed) || pd || {};
    var st = (pp.status || '') + ' ' + (pp.symptom || '') + ' ' + raw;
    if (st.indexOf('血便') !== -1 || st.indexOf('血尿') !== -1) count++;
  }
  return count;
}

function countRecentSoftStool(recentRows, days) {
  var cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  var count = 0;
  for (var i = 0; i < recentRows.length; i++) {
    var row = recentRows[i];
    var rowMs = Date.parse(String(row.created_at || '').replace(' ', 'T'));
    if (isNaN(rowMs) || rowMs < cutoffMs) continue;
    var parsed = safeParseJson(row.parsed_data);
    if (!parsed) continue;
    var p = parsed.parsed || parsed;
    var rt = parsed.record_type || parsed.module || '';
    if (rt === 'stool' || parsed.module === 'stool') {
      var st = p.status || p.symptom || '';
      if (st === '軟便' || st === 'soft' || st === '下痢' || st === 'diarrhea') count++;
    }
  }
  return count;
}

function findPreviousWeight(recentRows) {
  for (var i = 0; i < recentRows.length; i++) {
    var row = recentRows[i];
    var parsed = safeParseJson(row.parsed_data);
    if (!parsed) continue;
    if (parsed.module === 'weight' || parsed.record_type === 'weight') {
      var p = parsed.parsed || parsed;
      var w = parseFloat(p.amount || p.value || p.weight || '0');
      if (w > 0) return w;
    }
  }
  return 0;
}

function countConsecutiveLeftover(recentRows, threshold) {
  var count = 0;
  for (var i = 0; i < recentRows.length; i++) {
    var row = recentRows[i];
    var parsed = safeParseJson(row.parsed_data);
    if (!parsed) continue;
    if (parsed.module !== 'feeding' && parsed.record_type !== 'feeding') continue;
    var p = parsed.parsed || parsed;
    var lo = parseInt(p.leftover_pct || p.leftover || '0', 10);
    if (lo > 50) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function findMedRemedyInRules(ruleRows, catId) {
  for (var i = 0; i < ruleRows.length; i++) {
    var rule = ruleRows[i];
    if (rule.action_type !== 'template') continue;
    var cond = safeParseJson(rule.condition);
    if (!cond) continue;
    if (cond.module === 'medication' && (cond.status === '拒否' || cond.status === 'refused')) {
      var cfg = safeParseJson(rule.action_config);
      return cfg || { tip: '' };
    }
  }
  return null;
}

function matchCondition(condition, parsed, p) {
  if (condition.module && parsed.module !== condition.module) return false;
  if (condition.record_type && parsed.record_type !== condition.record_type) return false;
  if (condition.symptom && (p.symptom || '') !== condition.symptom) return false;
  if (condition.status && (p.status || '') !== condition.status) return false;
  return true;
}

function buildSlackMsg(catRecord, detail) {
  var name = (catRecord && catRecord.name) || '不明';
  return name + ': ' + detail;
}

function safeParseJson(str) {
  if (!str) return null;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (_) { return null; }
}
