/**
 * NYAGI L1 構造化 — テキスト → 構造化 JSON
 *
 * 第一選択: Workers AI (Llama 3.2-3B)
 * フォールバック: OpenAI GPT-4o-mini
 */

var STRUCTURING_PROMPT = [
  'あなたは猫カフェの記録アシスタントです。',
  'スタッフの報告テキストを以下のJSON形式に変換してください。',
  '',
  '分類:',
  '- stool（排泄）: うんち/おしっこ/血便/下痢/軟便/普通/硬い',
  '- feeding（給餌）: あげた/食べた/残した/全部食べた/ごはん/ウェット/ドライ/チュール',
  '- vomiting（嘔吐）: 吐いた/嘔吐/毛玉',
  '- medication（投薬）: 薬/投薬/点眼/あげた(薬の文脈)',
  '- weight（体重）: 数字+kg/キロ/グラム/g',
  '- behavior（行動）: 元気/ぐったり/寝てる/遊んでる',
  '- general（その他）',
  '',
  '出力JSON形式:',
  '{"module":"health|feeding|medication|weight|behavior|general",',
  ' "record_type":"stool|feeding|vomiting|medication|weight|behavior|general",',
  ' "parsed":{"symptom":"...","status":"...","count":1,"amount":"...","unit":"..."},',
  ' "confidence":0.0〜1.0}',
  '',
  '必ずJSONのみを返してください。説明は不要です。',
].join('\n');

var WORKERS_AI_TIMEOUT_MS = 3000;

/**
 * @param {{ catId: string, text: string, routeHint: string }} input
 * @param {{ AI?: object, OPENAI_API_KEY?: string }} env
 * @returns {Promise<{ module: string, record_type: string, parsed: object, confidence: number, source: string }>}
 */
export async function structureText(input, env) {
  var text = input.text;

  if (env.AI) {
    try {
      var result = await callWorkersAI(text, env);
      if (result) return result;
    } catch (e) {
      console.warn('Workers AI error, falling back to OpenAI:', e && e.message);
    }
  }

  if (env.OPENAI_API_KEY) {
    try {
      var result = await callOpenAI(text, env);
      if (result) return result;
    } catch (e) {
      console.warn('OpenAI fallback error:', e && e.message);
    }
  }

  return {
    module: 'general',
    record_type: 'general',
    parsed: { raw: text },
    confidence: 0,
    source: 'none',
  };
}

function callWorkersAI(text, env) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { resolve(null); }, WORKERS_AI_TIMEOUT_MS);

    env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
      messages: [
        { role: 'system', content: STRUCTURING_PROMPT },
        { role: 'user', content: text },
      ],
      max_tokens: 200,
      temperature: 0.1,
    }).then(function (resp) {
      clearTimeout(timer);
      var parsed = extractJson(resp && resp.response ? resp.response : '');
      if (!parsed || hasUnknown(parsed)) {
        resolve(null);
        return;
      }
      parsed.source = 'workers_ai';
      resolve(normalizeParsed(parsed));
    }).catch(function () {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function callOpenAI(text, env) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 8000);

  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: STRUCTURING_PROMPT },
        { role: 'user', content: text },
      ],
      max_tokens: 200,
      temperature: 0.1,
    }),
    signal: controller.signal,
  }).then(function (res) {
    clearTimeout(timer);
    return res.json();
  }).then(function (data) {
    var content = '';
    if (data.choices && data.choices[0] && data.choices[0].message) {
      content = data.choices[0].message.content || '';
    }
    var parsed = extractJson(content);
    if (!parsed) return null;
    parsed.source = 'openai_fallback';
    return normalizeParsed(parsed);
  }).catch(function (e) {
    clearTimeout(timer);
    console.warn('OpenAI fetch error:', e && e.message);
    return null;
  });
}

function extractJson(str) {
  if (!str) return null;
  var start = str.indexOf('{');
  var end = str.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(str.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function hasUnknown(obj) {
  var unknownCount = 0;
  var total = 0;
  var keys = Object.keys(obj.parsed || obj);
  for (var i = 0; i < keys.length; i++) {
    total++;
    var val = (obj.parsed || obj)[keys[i]];
    if (val === 'unknown' || val === 'Unknown' || val === '') unknownCount++;
  }
  return total > 0 && unknownCount / total > 0.5;
}

function normalizeParsed(raw) {
  return {
    module: raw.module || 'general',
    record_type: raw.record_type || raw.module || 'general',
    parsed: raw.parsed || {},
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.8,
    source: raw.source || 'unknown',
  };
}
