/**
 * NYAGI ケア項目リゾルバー
 *
 * 音声テキストからケア項目（ブラシ、爪切り等）を検出し、
 * { record_type, details } に解決する。
 */

var _careCache = null;
var _careCacheTs = 0;
var CARE_TTL_MS = 60 * 1000;

async function loadCareDict(db) {
  var now = Date.now();
  if (_careCache && (now - _careCacheTs) < CARE_TTL_MS) {
    return _careCache;
  }

  var rows = await db.prepare(
    'SELECT id, variant, label, record_type, priority FROM care_type_dictionary ORDER BY priority DESC'
  ).all();

  var entries = (rows.results || []).map(function (r) {
    return {
      id: r.id,
      variant: r.variant,
      variantNorm: r.variant.replace(/\s+/g, ''),
      label: r.label,
      recordType: r.record_type,
      priority: r.priority || 50,
    };
  });

  _careCache = entries;
  _careCacheTs = now;
  return entries;
}

/**
 * @param {string} text - 猫名・製品名除去後のテキスト
 * @param {D1Database} db
 * @returns {Promise<{ recordType: string, details: string, label: string, remainingText: string }|null>}
 */
export async function resolveCareType(text, db) {
  var dict = await loadCareDict(db);
  var textNorm = text.replace(/\s+/g, '');

  var bestMatch = null;
  var bestLen = 0;
  var bestPriority = -1;

  for (var i = 0; i < dict.length; i++) {
    var entry = dict[i];
    var idx = textNorm.indexOf(entry.variantNorm);
    if (idx !== -1) {
      var vLen = entry.variantNorm.length;
      if (vLen > bestLen || (vLen === bestLen && entry.priority > bestPriority)) {
        bestMatch = entry;
        bestLen = vLen;
        bestPriority = entry.priority;
      }
    }
  }

  if (bestMatch) {
    var escaped = bestMatch.variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp(escaped, 'g');
    var remaining = text.replace(re, '').replace(/\s+/g, ' ').trim();

    return {
      recordType: bestMatch.recordType,
      details: bestMatch.label,
      label: bestMatch.label,
      remainingText: remaining,
    };
  }

  return null;
}

export function clearCareDictCache() {
  _careCache = null;
  _careCacheTs = 0;
}
