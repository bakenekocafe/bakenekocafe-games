/**
 * 業務終了 Slack: 固定テンプレ（buildSlackReport）の後に副店長口調の所感・ツッコミを追記。
 * OPENAI_API_KEY + CLOSE_DAY_LLM=1 で有効。失敗時はテンプレのみ（報告は崩さない）。
 */

/**
 * LLM 用のコンパクトサマリ（数値・件数中心。ツッコミの根拠付けに使う）
 */
export function summarizeCloseDayReportForLlm(report) {
  var s = report.stats || {};
  var med = report.medication_close_day || {};
  var medPendingList = med.pending_items || [];
  var medIncomplete =
    medPendingList.length > 0
      ? medPendingList.length
      : med.incomplete_count != null
        ? med.incomplete_count
        : 0;
  var feed = report.feeding_close_day || {};
  var exc = report.excretion_close_day || {};
  var careG = report.care_item_gaps_close_day || {};
  var careItems = careG.items || [];
  var vom = report.vomiting_close_day || {};
  var clin = report.clinic_close_day || {};
  var wloss = report.weight_loss_close_day || {};
  var wItems = wloss.items || [];
  var wCritical = 0;
  var wSevere = 0;
  for (var wi = 0; wi < wItems.length; wi++) {
    if (wItems[wi].severity === 'critical') wCritical++;
    else if (wItems[wi].severity === 'severe') wSevere++;
  }
  var appet = report.appetite_low_close_day || {};
  var aItems = appet.items || [];
  var aCrit = 0;
  var aSev = 0;
  for (var ai = 0; ai < aItems.length; ai++) {
    if (aItems[ai].severity === 'critical') aCrit++;
    else if (aItems[ai].severity === 'severe') aSev++;
  }
  var skippedAtClose = report.skipped_tasks || [];
  var skippedBeforeClose = report.skipped_tasks_before_close || [];
  var catSum = report.cat_summary || {};
  var pc = vom.per_cat || [];
  var vomTodayCats = 0;
  for (var vi = 0; vi < pc.length; vi++) {
    if ((pc[vi].today_count || 0) > 0) vomTodayCats++;
  }
  var streak2 = 0;
  for (var si = 0; si < skippedAtClose.length; si++) {
    if ((skippedAtClose[si].skip_streak || 0) >= 2) streak2++;
  }
  for (var sj = 0; sj < skippedBeforeClose.length; sj++) {
    if ((skippedBeforeClose[sj].skip_streak || 0) >= 2) streak2++;
  }

  var denom = s.total != null && s.total > 0 ? s.total : ((s.done || 0) + (s.skipped_before_close || 0) + (s.skipped_at_close || 0));
  return {
    location_label: report.location_label,
    date: report.date,
    closed_by: report.closed_by,
    task_done: s.done,
    task_total: s.total,
    task_skipped_before_close: s.skipped_before_close,
    task_skipped_at_close: s.skipped_at_close,
    task_carried: s.carried,
    completion_pct: denom > 0 ? Math.round(((s.done || 0) / denom) * 100) : 0,
    skipped_before_sample: skippedBeforeClose.slice(0, 12).map(function (t) {
      return String(t.title || '').slice(0, 80) + '→' + String(t.reason || '').slice(0, 40);
    }),
    skipped_at_close_sample: skippedAtClose.slice(0, 12).map(function (t) {
      return String(t.title || '').slice(0, 80) + '→' + String(t.reason || '').slice(0, 40);
    }),
    skip_streak_2plus_count: streak2,
    med_total_logs: med.total != null ? med.total : null,
    med_done: med.done != null ? med.done : null,
    med_incomplete: medIncomplete,
    feed_plan_count: feed.plan_count != null ? feed.plan_count : null,
    feed_incomplete: feed.incomplete_count != null ? feed.incomplete_count : null,
    stool_gap_count: (exc.stool_gaps || []).length,
    urine_gap_count: (exc.urine_gaps || []).length,
    care_item_gap_7d_plus_count: careItems.length,
    vomit_week_cats: pc.length,
    vomit_today_cats: vomTodayCats,
    clinic_upcoming_unbooked: clin.upcoming_without_booking_count || 0,
    clinic_no_next_due_cats: (clin.cats_without_future_due || []).length,
    weight_loss_30d_count: wloss.count != null ? wloss.count : wItems.length,
    weight_loss_severe_7pct_plus: wSevere + wCritical,
    weight_loss_critical_10pct_plus: wCritical,
    appetite_low_count: appet.count != null ? appet.count : aItems.length,
    appetite_low_severe_or_worse: aSev + aCrit,
    appetite_low_critical: aCrit,
    cat_avg_score: catSum.average_score != null ? catSum.average_score : null,
    cat_warning_count: (catSum.warnings || []).length,
    has_special_notes: !!(report.special_notes && String(report.special_notes).trim()),
    medication_logs_generated: report.medication_logs_generated,
    feeding_presets_applied: report.feeding_presets_applied,
  };
}

function buildCloseDaySystemPrompt() {
  return [
    'あなたは保護猫カフェ「BAKENEKO CAFE」の副店長猫「こはだ」の口調で、日次業務終了レポートに対する短い所感とツッコミを書く。',
    '',
    '【口調ルール】',
    '- 一人称は「ボク」。語尾は「〜にゃ」「〜にゃ！」「〜かにゃ？」など。',
    '- 少し子どもっぽく天然。軽いツッコミや冗談は可。相手や猫を傷つける表現は禁止。',
    '',
    '【絶対禁止】',
    '- 入力に無い事実の捏造、数値・猫名・日付のでっち上げ。',
    '- 「Slackレポート本文」ブロックの引用・再掲・要約のやり直し（本文は既に確定している）。',
    '',
    '【やること】',
    '- 出力は合計 120〜450 文字程度。',
    '- **改行を必ず使うこと**：話題・文節ごとに改行し、Slack で読みやすいようにする（1行が長く続かないように）。箇条書きは `•` や `-` で 3〜7 行でもよいにゃ。',
    '- ユーザーが渡す JSON サマリと Slack レポート本文を照合し、(1) 日常業務としての整合性チェック（例: タスク完了率が高いのに未完了献立やスキップ0が並ぶ違和感、注意喚起が多いのに楽観しすぎなど）(2) 気になるリスクや未完成感 (3) うまく回っていそうな点、をバランスよく。',
    '- 指摘は必ず本文またはサマリに根拠がある事柄に限定。',
    '',
    '【出力形式】',
    '- 前置き・タイトル行・「以上」等なし。所感本文のみ。必ず複数行で出力するにゃ。',
  ].join('\n');
}

var LLM_MAX_REPORT_CHARS = 14000;
/** D1 bigint や数値の安全な JSON（close-day サマリ用） */
function jsonStringifyForLlm(obj) {
  return JSON.stringify(obj, function (_k, v) {
    return typeof v === 'bigint' ? Number(v) : v;
  });
}

var OPENAI_CLOSE_DAY_TIMEOUT_MS = 20000;

/** モデルが1行に詰めたときのフォールバック: 句点・感嘆・疑問のあとに改行を補う */
function formatKohadaCommentaryLines(raw) {
  var s = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!s) return '';
  if (s.indexOf('\n') !== -1) return s;
  var out = s
    .replace(/([。！？!])\s*/g, '$1\n')
    .replace(/(にゃ[!！]?)\s+/g, '$1\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {object} env Worker env（OPENAI_API_KEY, CLOSE_DAY_LLM_MODEL 等）
 * @param {string} slackBody buildSlackReport の結果（事実のマスター）
 * @param {object} summary summarizeCloseDayReportForLlm の結果
 * @returns {Promise<string>} 空文字は呼び出し側でテンプレのみ送る
 */
export async function fetchCloseDayKohadaCommentary(env, slackBody, summary) {
  var key = env.OPENAI_API_KEY;
  if (!key || typeof key !== 'string' || !key.trim()) return '';

  var model = env.CLOSE_DAY_LLM_MODEL || 'gpt-4o-mini';
  var bodySnippet = String(slackBody || '').slice(0, LLM_MAX_REPORT_CHARS);

  var userContent;
  try {
    userContent =
      '## JSONサマリ（数値・件数の根拠用）\n```json\n' +
      jsonStringifyForLlm(summary) +
      '\n```\n\n## Slackレポート本文（事実のマスター。あなたはこれを書き換えない）\n```\n' +
      bodySnippet +
      '\n```\n\n上記に基づき、こはだ口調で所感・ツッコミだけを出力してにゃ。';
  } catch (serErr) {
    console.warn('[close-day-llm] summary stringify failed:', serErr && serErr.message);
    return '';
  }

  var ctrl = new AbortController();
  var timer = setTimeout(function () {
    try {
      ctrl.abort();
    } catch (_) {}
  }, OPENAI_CLOSE_DAY_TIMEOUT_MS);

  try {
    var res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: 'Bearer ' + key.trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: buildCloseDaySystemPrompt() },
          { role: 'user', content: userContent },
        ],
        max_tokens: 650,
        temperature: 0.65,
      }),
    });

    if (!res.ok) {
      var errText = await res.text().catch(function () {
        return '';
      });
      console.warn('[close-day-llm] OpenAI HTTP', res.status, errText.slice(0, 200));
      return '';
    }

    var data = await res.json().catch(function () {
      return null;
    });
    var choice = data && data.choices && data.choices[0];
    var text = choice && choice.message && choice.message.content;
    if (!text || typeof text !== 'string') {
      console.warn('[close-day-llm] empty completion');
      return '';
    }
    return formatKohadaCommentaryLines(text);
  } catch (e) {
    console.warn('[close-day-llm] fetch/abort:', e && e.name, e && e.message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 昼簡易レポート用のコンパクトサマリ（こはだ口調の根拠用）
 */
export function summarizeLunchReportForLlm(payload) {
  var u = payload.urine_missing_cats || [];
  var care = payload.care_item_gaps || {};
  var careItems = care.items || [];
  var sk = payload.skip_streak_tasks || [];
  var catScores = payload.cat_health_scores || [];
  var totalScore = 0;
  var scoredCount = 0;
  var warnCats = [];
  for (var i = 0; i < catScores.length; i++) {
    var cs = catScores[i];
    if (cs.score !== null && cs.score !== undefined) {
      totalScore += cs.score;
      scoredCount++;
      if (cs.score < 70) warnCats.push({ name: cs.cat_name, score: cs.score });
    }
  }
  return {
    location_label: payload.location_label,
    date: payload.reference_date,
    urine_missing_count: u.length,
    urine_missing_names: u.slice(0, 20).map(function (c) {
      return c.cat_name || c.cat_id;
    }),
    care_gap_count: careItems.length,
    care_gap_sample: careItems.slice(0, 12).map(function (it) {
      return (it.cat_name || '') + '/' + (it.item_label || '') + '/' + (it.days_since_last != null ? it.days_since_last : '');
    }),
    skip_streak_task_count: sk.length,
    skip_streak_threshold: payload.skip_streak_threshold,
    skip_streak_sample: sk.slice(0, 12).map(function (t) {
      return String(t.title || '').slice(0, 72) + ':' + (t.status || '') + ':' + (t.skip_streak != null ? t.skip_streak : '');
    }),
    health_score_average: scoredCount > 0 ? Math.round(totalScore / scoredCount) : null,
    health_score_warn_count: warnCats.length,
    health_score_warn_sample: warnCats.slice(0, 10).map(function (c) {
      return (c.name || '') + ':' + c.score;
    }),
  };
}

function buildLunchSimpleSystemPrompt() {
  return [
    'あなたは保護猫カフェ「BAKENEKO CAFE」の副店長猫「こはだ」の口調で、昼の簡易レポート（排尿未記録・ケア穴・連続スキップ）に対する短い所感とツッコミだけを書く。',
    '',
    '【口調ルール】',
    '- 一人称は「ボク」。語尾は「〜にゃ」「〜にゃ！」「〜かにゃ？」など。',
    '- 少し子どもっぽく天然。軽いツッコミは可。相手や猫を傷つける表現は禁止。',
    '',
    '【絶対禁止】',
    '- 入力に無い事実の捏造、数値・猫名・日付のでっち上げ。',
    '- Slack本文ブロックの引用・再掲・要約のやり直し（本文は既に確定している）。',
    '',
    '【やること】',
    '- 出力は合計 80〜320 文字程度。',
    '- **改行を必ず使うこと**：Slack で読みやすいように 2〜6 行程度。',
    '- JSON サマリと本文を照合し、未完成の焦り／順調そうな点のバランス。指摘は本文またはサマリに根拠がある事柄に限定。',
    '',
    '【出力形式】',
    '- 前置き・タイトル行・「以上」等なし。所感本文のみ。必ず複数行で出力するにゃ。',
  ].join('\n');
}

/**
 * 昼簡易レポート用こはだ（CLOSE_DAY_LLM と同じ有効条件）。
 */
export async function fetchLunchKohadaCommentary(env, slackBody, summary) {
  var key = env.OPENAI_API_KEY;
  if (!key || typeof key !== 'string' || !key.trim()) return '';

  var model = env.CLOSE_DAY_LLM_MODEL || 'gpt-4o-mini';
  var bodySnippet = String(slackBody || '').slice(0, LLM_MAX_REPORT_CHARS);

  var userContent;
  try {
    userContent =
      '## JSONサマリ（数値・件数の根拠用）\n```json\n' +
      jsonStringifyForLlm(summary) +
      '\n```\n\n## Slack昼レポート本文（事実のマスター。あなたはこれを書き換えない）\n```\n' +
      bodySnippet +
      '\n```\n\n上記に基づき、こはだ口調で所感・ツッコミだけを出力してにゃ。';
  } catch (serErr) {
    console.warn('[lunch-llm] summary stringify failed:', serErr && serErr.message);
    return '';
  }

  var ctrl = new AbortController();
  var timer = setTimeout(function () {
    try {
      ctrl.abort();
    } catch (_) {}
  }, OPENAI_CLOSE_DAY_TIMEOUT_MS);

  try {
    var res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: 'Bearer ' + key.trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: buildLunchSimpleSystemPrompt() },
          { role: 'user', content: userContent },
        ],
        max_tokens: 500,
        temperature: 0.65,
      }),
    });

    if (!res.ok) {
      var errText = await res.text().catch(function () {
        return '';
      });
      console.warn('[lunch-llm] OpenAI HTTP', res.status, errText.slice(0, 200));
      return '';
    }

    var data = await res.json().catch(function () {
      return null;
    });
    var choice = data && data.choices && data.choices[0];
    var text = choice && choice.message && choice.message.content;
    if (!text || typeof text !== 'string') {
      console.warn('[lunch-llm] empty completion');
      return '';
    }
    return formatKohadaCommentaryLines(text);
  } catch (e) {
    console.warn('[lunch-llm] fetch/abort:', e && e.name, e && e.message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * LLM 追記を付けるか。
 * 業務終了ボタン確定 → closeDayExecute 内の Slack 送信にのみ使用。
 * OPENAI_API_KEY があれば既定 ON。明示無効: CLOSE_DAY_LLM=0 / false / off / disabled（大文字小文字無視）
 */
export function isCloseDayLlmEnabled(env) {
  if (!env || !env.OPENAI_API_KEY) return false;
  var key = String(env.OPENAI_API_KEY || '').trim();
  if (!key) return false;
  var v = env.CLOSE_DAY_LLM;
  if (v === true) return true;
  var s = v == null || v === '' ? '' : String(v).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'off' || s === 'no' || s === 'disabled') return false;
  return true;
}
