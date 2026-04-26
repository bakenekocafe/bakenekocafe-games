/**
 * NYAGI L3 アシスト — GPT-4o-mini による軽量異常分析
 *
 * L2 で dest: 'L3' となった voice_input を GPT-4o-mini で分析し、
 * アクション提案 + routing_feedback を生成する。
 * OPENAI_API_KEY が未設定の場合はスキップ（null を返す）。
 */

import { jstCalendarYmdFromInstant, jstCalendarAddDays } from './jst-util.js';

var ROUTING_FEEDBACK_PROMPT = [
  '',
  '## routing_feedback（必須。回答 JSON に含めること）',
  '{',
  '  "was_necessary": true/false,',
  '  "actual_severity": "trivial|low|medium|high|critical",',
  '  "reason": "判断理由（1文）",',
  '  "suggested_rule": null | {',
  '    "rule_name": "...",',
  '    "condition": {...},',
  '    "action_type": "flag_only|template|escalate_l3",',
  '    "template_msg": null | "..."',
  '  },',
  '  "suggested_baseline": null | {',
  '    "cat_id": "...",',
  '    "metric": "...",',
  '    "normal_value": "...",',
  '    "note": "..."',
  '  },',
  '  "similar_to_recent": false',
  '}',
  '',
  '判断基準:',
  '- was_necessary=false: L2のルールやベースラインで処理できたはずの内容',
  '- was_necessary=true: 文脈を見ないと判断できない内容、初見のパターン',
  '- suggested_rule: L2 に追加すれば次回 LLM 不要になるルール提案',
].join('\n');

function formatRecentLogs(logs) {
  if (!logs || logs.length === 0) return '（記録なし）';
  return logs.slice(0, 10).map(function (log) {
    var line = log.record_date || (log.created_at || '').slice(0, 10);
    if (log.record_type) line += ' [' + log.record_type + ']';
    if (log.value) line += ' ' + log.value;
    if (log.details) {
      try {
        var d = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
        if (d && d.symptom) line += ' (' + d.symptom + ')';
        if (d && d.status) line += ' ' + d.status;
      } catch (_) {}
    }
    return line;
  }).join('\n');
}

async function callOpenAI(apiKey, model, systemPrompt, userMessage, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);

  try {
    var res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    var data = await res.json();
    if (!data.choices || !data.choices[0]) return null;
    var content = data.choices[0].message.content;
    return JSON.parse(content);
  } catch (e) {
    clearTimeout(timer);
    console.error('L3 OpenAI error:', e.message);
    return null;
  }
}

export async function callL3(voiceInput, catRecord, recentLogs, env) {
  var apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('OPENAI_API_KEY not set, L3 skipped');
    return null;
  }

  var systemPrompt = [
    'あなたは猫の健康管理アシスタント「NYAGI」です。',
    '猫カフェ・保護猫施設のスタッフから報告された異常を分析し、簡潔なアドバイスを提供します。',
    '',
    '## 猫の情報',
    '名前: ' + catRecord.name,
    '性別: ' + (catRecord.sex || '不明'),
    '内部メモ: ' + (catRecord.internal_note || 'なし'),
    '警戒レベル: ' + (catRecord.alert_level || 'normal'),
    '',
    '## 直近7日の記録',
    formatRecentLogs(recentLogs),
    '',
    '## 指示',
    '1. 報告内容を分析し、考えられる原因と対応策を簡潔に述べてください（3文以内）',
    '2. severity を判定してください: "low" / "medium" / "high" / "critical"',
    '3. needs_deeper: より詳細な分析（L4）が必要なら true',
    '4. action_proposal: スタッフへの具体的な次のアクション提案（1文）',
    '',
    ROUTING_FEEDBACK_PROMPT,
  ].join('\n');

  var userMessage = '報告: ' + voiceInput.raw_transcript +
    '\n構造化データ: ' + (voiceInput.parsed_data || '{}') +
    '\nL2 エスカレーション理由: ' + (voiceInput.l2_reason || '不明');

  return await callOpenAI(apiKey, 'gpt-4o-mini', systemPrompt, userMessage, 8000);
}

export async function processL3Result(db, voiceInputId, catId, l3Result, locationId) {
  if (!l3Result) return;

  await db.prepare(
    "UPDATE voice_inputs SET routing_layer = 'L3_completed', completed_data = ?, status = 'completed' WHERE id = ?"
  ).bind(JSON.stringify(l3Result), voiceInputId).run();

  if (l3Result.action_proposal) {
    await db.prepare(
      'INSERT INTO action_items (source_module, source_id, cat_id, location_id, title, priority, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      'l3_analysis', String(voiceInputId), catId, locationId,
      l3Result.action_proposal,
      (l3Result.severity === 'high' || l3Result.severity === 'critical') ? 'high' : 'normal',
      jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), 1),
      'open', 'system'
    ).run();
  }

  if (l3Result.routing_feedback) {
    var rf = l3Result.routing_feedback;
    await db.prepare(
      'INSERT INTO routing_feedback (voice_input_id, layer_called, cat_id, input_summary, was_necessary, actual_severity, reason, suggested_rule, suggested_baseline, similar_to_recent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      voiceInputId, 'L3', catId,
      (l3Result.analysis || '').slice(0, 200),
      rf.was_necessary ? 1 : 0,
      rf.actual_severity || '',
      rf.reason || '',
      rf.suggested_rule ? JSON.stringify(rf.suggested_rule) : null,
      rf.suggested_baseline ? JSON.stringify(rf.suggested_baseline) : null,
      rf.similar_to_recent ? 1 : 0
    ).run();
  }

  // L3→L4 昇格チェック（高severity / needs_deeper のとき L4_pending に昇格）
  if (l3Result.severity === 'critical' || l3Result.severity === 'high' || l3Result.needs_deeper) {
    await db.prepare(
      "UPDATE voice_inputs SET routing_layer = 'L4_pending' WHERE id = ?"
    ).bind(voiceInputId).run();
  }
}
