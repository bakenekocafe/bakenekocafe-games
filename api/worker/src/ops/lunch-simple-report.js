/**
 * NYAGI 昼（JST 14:00）簡易 Slack：排尿未記録・ケア7日穴・連続スキップ（NYAGI閾値）＋こはだツッコミ
 * 送信先は業務終了レポートと同じ resolveNyagiReportSlackChannel。
 */

import { fetchNyagiLunchReportPayload } from './dashboard.js';
import { getSlackChannel } from './tasks.js';
import { sendSlackMessage } from './slack-notify.js';
import {
  fetchLunchKohadaCommentary,
  isCloseDayLlmEnabled,
  summarizeLunchReportForLlm,
} from './close-day-llm.js';

var LUNCH_REPORT_LOCATIONS = ['cafe'];
var LUNCH_IDEM_PREFIX = 'nyagi:lunch-simple:';
var LUNCH_IDEM_TTL_SEC = 90000;

function lunchFmtMd(ymd) {
  if (!ymd || String(ymd).length < 10) return String(ymd || '—');
  var s = String(ymd).slice(0, 10);
  return s.slice(5, 7) + '/' + s.slice(8, 10);
}

function scoreEmoji(score) {
  if (score === null || score === undefined) return '⬜';
  if (score >= 85) return '🟢';
  if (score >= 70) return '🟡';
  if (score >= 50) return '🟠';
  return '🔴';
}

function buildNyagiLunchSlackBody(payload) {
  var lines = [];
  var care = payload.care_item_gaps || {};
  var th = care.threshold_days != null ? care.threshold_days : 7;
  var careItems = care.items || [];
  var urine = payload.urine_missing_cats || [];
  var skips = payload.skip_streak_tasks || [];
  var thr = payload.skip_streak_threshold != null ? payload.skip_streak_threshold : 5;

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(
    '🍱 NYAGI 昼の簡易レポート（14時時点・JST） — ' +
      (payload.location_label || payload.location_id || '') +
      ' / ' +
      (payload.reference_date || '')
  );
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  lines.push('🚽 排尿（本日の記録がまだない在籍猫）');
  if (urine.length === 0) {
    lines.push('  該当なし');
  } else {
    for (var ui = 0; ui < urine.length && ui < 40; ui++) {
      lines.push('  • ' + (urine[ui].cat_name || urine[ui].cat_id || '—'));
    }
    if (urine.length > 40) lines.push('  … 他' + (urine.length - 40) + '頭');
  }
  lines.push('');

  lines.push('🪮 ケア実施（項目別・実施から' + th + '日以上未記録）※当日基準');
  if (careItems.length === 0) {
    lines.push('  該当なし');
  } else {
    for (var ci = 0; ci < careItems.length && ci < 40; ci++) {
      var it = careItems[ci];
      if (it.no_record) {
        lines.push(
          '  • ' +
            (it.cat_name || '') +
            ' — ' +
            (it.item_label || '') +
            ' 記録なし（猫マスタ登録から' +
            (it.days_since_last != null ? it.days_since_last : '') +
            '日）'
        );
      } else {
        lines.push(
          '  • ' +
            (it.cat_name || '') +
            ' — ' +
            (it.item_label || '') +
            ' 最終 ' +
            lunchFmtMd(it.last_record_date) +
            '（経過' +
            (it.days_since_last != null ? it.days_since_last : '') +
            '日）'
        );
      }
    }
    if (careItems.length > 40) lines.push('  … 他' + (careItems.length - 40) + '件');
  }
  lines.push('');

  lines.push(
    '🔁 連続スキップ警告（NYAGI と同じ閾値：未完了で次スキップで ' +
      thr +
      ' 日連続以上になるもの、またはスキップ済で ' +
      thr +
      ' 日連続以上）'
  );
  if (skips.length === 0) {
    lines.push('  該当なし');
  } else {
    for (var si = 0; si < skips.length && si < 40; si++) {
      var st = skips[si];
      var catPart = st.cat_name ? '（' + st.cat_name + '）' : '';
      var stLabel = st.status === 'skipped' ? 'スキップ済' : '未完了';
      lines.push(
        '  • ' +
          (st.title || '（無題）') +
          catPart +
          ' — ' +
          stLabel +
          ' · 連続' +
          (st.skip_streak != null ? st.skip_streak : 0) +
          '日'
      );
    }
    if (skips.length > 40) lines.push('  … 他' + (skips.length - 40) + '件');
  }
  lines.push('');

  // 健康スコア（スコア昇順・要注意が先頭）
  var catScores = payload.cat_health_scores || [];
  lines.push('🏥 健康スコア（全頭・注意順）');
  if (catScores.length === 0) {
    lines.push('  データなし');
  } else {
    var totalScore = 0;
    var scoredCount = 0;
    var warnCount = 0;
    for (var sci = 0; sci < catScores.length; sci++) {
      var cs = catScores[sci];
      var scoreStr = cs.score !== null ? String(cs.score) + '点' : '--';
      var emoji = scoreEmoji(cs.score);
      var warn = (cs.score !== null && cs.score < 70) ? ' ⚠要観察' : '';
      lines.push('  ' + emoji + ' ' + (cs.cat_name || '—') + ': ' + scoreStr + warn);
      if (cs.score !== null) {
        totalScore += cs.score;
        scoredCount++;
        if (cs.score < 70) warnCount++;
      }
    }
    var avg = scoredCount > 0 ? Math.round(totalScore / scoredCount) : null;
    lines.push('  平均: ' + (avg !== null ? avg + '点' : '--') + '　要観察: ' + warnCount + '頭');
  }
  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  return lines.join('\n');
}

/** 拠点ごとに昼レポートを Slack 送信（Cron から呼ぶ） */
export async function runNyagiLunchSimpleReportsForAllLocations(env, db) {
  if (!db) return { ok: false, error: 'no_db' };
  var token = env.SLACK_BOT_TOKEN && String(env.SLACK_BOT_TOKEN).trim();
  if (!token) {
    console.warn('[lunch-simple-report] SLACK_BOT_TOKEN なし — 送信スキップ');
    return { ok: false, error: 'no_slack_token' };
  }

  var out = [];
  for (var li = 0; li < LUNCH_REPORT_LOCATIONS.length; li++) {
    var loc = LUNCH_REPORT_LOCATIONS[li];
    var channel = getSlackChannel(env, loc);
    if (!channel) {
      out.push(loc + ':no_channel');
      continue;
    }

    var payload = null;
    try {
      payload = await fetchNyagiLunchReportPayload(db, loc);
    } catch (e) {
      console.warn('[lunch-simple-report] payload ' + loc + ':', e && e.message);
      out.push(loc + ':payload_err');
      continue;
    }
    if (!payload) {
      out.push(loc + ':no_payload');
      continue;
    }

    var idemKey = LUNCH_IDEM_PREFIX + loc + ':' + payload.reference_date;
    if (env.IDEMPOTENCY_KV) {
      try {
        var seen = await env.IDEMPOTENCY_KV.get(idemKey);
        if (seen) {
          out.push(loc + ':already_sent');
          continue;
        }
      } catch (_) {}
    }

    var slackBody = buildNyagiLunchSlackBody(payload);
    var slackText = slackBody;
    if (isCloseDayLlmEnabled(env)) {
      try {
        var summary = summarizeLunchReportForLlm(payload);
        var commentary = await fetchLunchKohadaCommentary(env, slackBody, summary);
        if (commentary) {
          slackText =
            slackBody +
            '\n\n🐱 【副店長こはだ・昼レポート所感（自動／事実は上記ブロックがマスター）】\n' +
            commentary;
        }
      } catch (llmErr) {
        console.warn('[lunch-simple-report] llm non-fatal:', llmErr && llmErr.message);
      }
    }

    try {
      await sendSlackMessage(env, channel, slackText);
      if (env.IDEMPOTENCY_KV) {
        try {
          await env.IDEMPOTENCY_KV.put(idemKey, '1', { expirationTtl: LUNCH_IDEM_TTL_SEC });
        } catch (_) {}
      }
      out.push(loc + ':sent');
      console.log('[lunch-simple-report] sent ' + loc + ' → ' + channel);
    } catch (sendErr) {
      console.warn('[lunch-simple-report] send ' + loc + ':', sendErr && sendErr.message);
      out.push(loc + ':send_err');
    }
  }

  return { ok: true, results: out };
}
