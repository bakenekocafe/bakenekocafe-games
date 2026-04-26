/**
 * NYAGI 名前リゾルバー
 *
 * 音声テキストから猫名・フード名・薬名を検出し ID に解決する。
 * cat_name_dictionary / product_name_dictionary を参照。
 * 最長一致 + レーベンシュタイン距離で照合。
 */

import { insertCatNameDictWithSources, selectPendingMisrecognitionIdsByAttempted } from './cat-name-dict-insert.js';

var _dictCache = null;
var _dictCacheTs = 0;
var _productDictCache = null;
var _productDictCacheTs = 0;
var DICT_TTL_MS = 60 * 1000;

function kataToHira(str) {
  var result = '';
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code >= 0x30A1 && code <= 0x30F6) {
      result += String.fromCharCode(code - 0x60);
    } else {
      result += str.charAt(i);
    }
  }
  return result;
}

function levenshtein(a, b) {
  var m = a.length;
  var n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  var prev = [];
  var curr = [];
  var i, j;

  for (j = 0; j <= n; j++) prev[j] = j;

  for (i = 1; i <= m; i++) {
    curr[0] = i;
    for (j = 1; j <= n; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    var tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

async function loadDictionary(db) {
  var now = Date.now();
  if (_dictCache && (now - _dictCacheTs) < DICT_TTL_MS) {
    return _dictCache;
  }

  var rows = await db.prepare(
    'SELECT cat_id, variant, variant_type, priority FROM cat_name_dictionary ORDER BY priority DESC'
  ).all();

  var entries = (rows.results || []).map(function (r) {
    return {
      catId: r.cat_id,
      variant: r.variant,
      variantNorm: r.variant.replace(/\s+/g, ''),
      variantType: r.variant_type,
      priority: r.priority || 50,
    };
  });

  _dictCache = entries;
  _dictCacheTs = now;
  return entries;
}

/**
 * フィルタ条件に合致する猫IDセットを取得
 */
async function loadAllowedCatIds(db, filterLocation, filterStatus) {
  var clauses = [];
  var params = [];
  if (filterLocation) { clauses.push('location_id = ?'); params.push(filterLocation); }
  if (filterStatus) { clauses.push('status = ?'); params.push(filterStatus); }
  if (clauses.length === 0) return null;
  var sql = 'SELECT id FROM cats WHERE ' + clauses.join(' AND ');
  var stmt = db.prepare(sql);
  if (params.length === 2) stmt = stmt.bind(params[0], params[1]);
  else stmt = stmt.bind(params[0]);
  var rows = await stmt.all();
  var ids = {};
  (rows.results || []).forEach(function (r) { ids[r.id] = true; });
  return ids;
}

/**
 * @param {string} rawText
 * @param {D1Database} db
 * @param {Object} [filterOpts] - { filterLocation, filterStatus }
 * @returns {Promise<{ catId: string|null, catName: string|null, remainingText: string, unresolved?: string }>}
 */
export async function resolveCatName(rawText, db, filterOpts) {
  var dict = await loadDictionary(db);

  var allowedIds = null;
  if (filterOpts && (filterOpts.filterLocation || filterOpts.filterStatus)) {
    allowedIds = await loadAllowedCatIds(db, filterOpts.filterLocation, filterOpts.filterStatus);
  }
  if (allowedIds) {
    dict = dict.filter(function (e) { return allowedIds[e.catId]; });
  }
  var text = rawText.trim();
  var textNorm = text.replace(/\s+/g, '');
  var textHira = kataToHira(textNorm);

  var bestMatch = null;
  var bestLen = 0;
  var bestPriority = -1;

  for (var i = 0; i < dict.length; i++) {
    var entry = dict[i];
    var vLen = entry.variantNorm.length;
    var varHira = kataToHira(entry.variantNorm);

    var headSlice = textNorm.slice(0, vLen);
    if (headSlice === entry.variantNorm || kataToHira(headSlice) === varHira) {
      if (vLen > bestLen || (vLen === bestLen && entry.priority > bestPriority)) {
        bestMatch = entry;
        bestLen = vLen;
        bestPriority = entry.priority;
      }
    }
  }

  if (!bestMatch) {
    for (var i = 0; i < dict.length; i++) {
      var entry = dict[i];
      var vLen = entry.variantNorm.length;
      var varHira = kataToHira(entry.variantNorm);

      if (textNorm.indexOf(entry.variantNorm) !== -1 || textHira.indexOf(varHira) !== -1) {
        if (vLen > bestLen || (vLen === bestLen && entry.priority > bestPriority)) {
          bestMatch = entry;
          bestLen = vLen;
          bestPriority = entry.priority;
        }
      }
    }
  }

  if (!bestMatch) {
    for (var i = 0; i < dict.length; i++) {
      var entry = dict[i];
      var vLen = entry.variantNorm.length;
      if (vLen < 2) continue;
      var varHira = kataToHira(entry.variantNorm);

      var tokens = text.split(/\s+/);
      var maxDistTok = varHira.length <= 2 ? 1 : 2;
      for (var t = 0; t < tokens.length; t++) {
        var tokenNorm = tokens[t].replace(/\s+/g, '');
        if (tokenNorm.length < 1) continue;
        var dist = levenshtein(kataToHira(tokenNorm), varHira);
        if (dist <= maxDistTok) {
          if (vLen > bestLen || (vLen === bestLen && entry.priority > bestPriority)) {
            bestMatch = entry;
            bestLen = vLen;
            bestPriority = entry.priority;
          }
          break;
        }
      }
    }
  }

  if (!bestMatch) {
    for (var i = 0; i < dict.length; i++) {
      var entry = dict[i];
      var vLen = entry.variantNorm.length;
      if (vLen < 2) continue;
      var varHira = kataToHira(entry.variantNorm);

      var maxDistHead = vLen <= 2 ? 1 : 2;
      var headSlice = textHira.slice(0, vLen);
      if (headSlice.length >= 2) {
        var dist = levenshtein(headSlice, varHira);
        if (dist <= maxDistHead) {
          if (vLen > bestLen || (vLen === bestLen && entry.priority > bestPriority)) {
            bestMatch = entry;
            bestLen = vLen;
            bestPriority = entry.priority;
          }
        }
      }
      if (!bestMatch || bestLen < vLen) {
        var probe = textHira.slice(0, vLen + 1);
        if (probe.length > vLen) {
          var d2 = levenshtein(probe.slice(0, vLen), varHira);
          if (d2 <= maxDistHead && (vLen > bestLen || (vLen === bestLen && entry.priority > bestPriority))) {
            bestMatch = entry;
            bestLen = vLen;
            bestPriority = entry.priority;
          }
        }
      }
    }
  }

  /** スペース無し連読「さよりうんち…」向け: 先頭から長さを動かして最短レーベンシュタイン（短い名前は厳しめ） */
  if (!bestMatch) {
    var bestFuzz = null;
    for (var fi = 0; fi < dict.length; fi++) {
      var ent = dict[fi];
      var vL = ent.variantNorm.length;
      if (vL < 2) continue;
      var vHr = kataToHira(ent.variantNorm);
      var maxDistF = vL <= 2 ? 1 : 2;
      var maxPl = Math.min(textHira.length, vL + 3);
      var minDf = 999;
      for (var pl = 2; pl <= maxPl; pl++) {
        var df = levenshtein(textHira.slice(0, pl), vHr);
        if (df < minDf) minDf = df;
      }
      if (minDf <= maxDistF) {
        if (!bestFuzz || minDf < bestFuzz.minDf ||
            (minDf === bestFuzz.minDf && vL > bestFuzz.vL) ||
            (minDf === bestFuzz.minDf && vL === bestFuzz.vL && ent.priority > bestFuzz.pri)) {
          bestFuzz = { entry: ent, minDf: minDf, vL: vL, pri: ent.priority };
        }
      }
    }
    if (bestFuzz) {
      bestMatch = bestFuzz.entry;
      bestLen = bestFuzz.entry.variantNorm.length;
      bestPriority = bestFuzz.entry.priority;
    }
  }

  if (bestMatch) {
    var remaining = text;
    var varEsc = bestMatch.variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp(varEsc + '\\s*');
    remaining = remaining.replace(re, '').trim();
    if (remaining === text) {
      remaining = textNorm.slice(bestLen).replace(/^\s+/, '');
    }
    var catRow = await db.prepare('SELECT name FROM cats WHERE id = ?').bind(bestMatch.catId).first();
    return {
      catId: bestMatch.catId,
      catName: catRow ? catRow.name : bestMatch.variant,
      remainingText: remaining,
    };
  }

  var firstToken = text.split(/\s+/)[0] || '';
  await logMisrecognition(db, rawText, firstToken);
  return {
    catId: null,
    catName: null,
    remainingText: text,
    unresolved: firstToken,
  };
}

function removeNameFromText(text, variant) {
  var escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp(escaped + '\\s*');
  return text.replace(re, '').trim();
}

async function logMisrecognition(db, rawText, attempted) {
  try {
    await db.prepare(
      "INSERT INTO misrecognition_log (raw_text, attempted_name, failure_type) VALUES (?, ?, 'cat_name')"
    ).bind(rawText, attempted).run();
  } catch (_) {
    // best-effort
  }
}

/**
 * テキスト内の全猫名を位置付きで検出し、猫ごとのセグメントに分割する。
 * "さよりうんこ健康だんごうんこ柔らかい" → [{catId,catName,text:"うんこ健康"},{catId,catName,text:"うんこ柔らかい"}]
 */
export async function splitMultiCatInput(rawText, db, filterOpts) {
  var dict = await loadDictionary(db);

  if (filterOpts && (filterOpts.filterLocation || filterOpts.filterStatus)) {
    var allowedIds = await loadAllowedCatIds(db, filterOpts.filterLocation, filterOpts.filterStatus);
    if (allowedIds) {
      dict = dict.filter(function (e) { return allowedIds[e.catId]; });
    }
  }
  var textNorm = rawText.replace(/\s+/g, '');

  var hits = [];
  for (var i = 0; i < dict.length; i++) {
    var entry = dict[i];
    var vLen = entry.variantNorm.length;
    if (vLen < 2) continue;
    var pos = 0;
    while (pos <= textNorm.length - vLen) {
      var slice = textNorm.slice(pos, pos + vLen);
      if (slice === entry.variantNorm) {
        var dominated = false;
        for (var h = 0; h < hits.length; h++) {
          if (hits[h].start <= pos && hits[h].end >= pos + vLen) { dominated = true; break; }
        }
        if (!dominated) {
          hits.push({ catId: entry.catId, variant: entry.variant, start: pos, end: pos + vLen, priority: entry.priority, len: vLen });
        }
        pos += vLen;
      } else {
        pos++;
      }
    }
  }

  if (hits.length <= 1) return null;

  hits.sort(function (a, b) { return a.start - b.start; });

  var deduped = [];
  for (var i = 0; i < hits.length; i++) {
    var keep = true;
    for (var j = 0; j < deduped.length; j++) {
      if (hits[i].start < deduped[j].end && hits[i].end > deduped[j].start) {
        if (hits[i].len < deduped[j].len || (hits[i].len === deduped[j].len && hits[i].priority <= deduped[j].priority)) {
          keep = false; break;
        } else {
          deduped.splice(j, 1); j--;
        }
      }
    }
    if (keep) deduped.push(hits[i]);
  }

  if (deduped.length <= 1) return null;

  var segments = [];
  for (var i = 0; i < deduped.length; i++) {
    var nextStart = (i + 1 < deduped.length) ? deduped[i + 1].start : textNorm.length;
    var segText = textNorm.slice(deduped[i].end, nextStart);
    var catRow = await db.prepare('SELECT name FROM cats WHERE id = ?').bind(deduped[i].catId).first();
    segments.push({
      catId: deduped[i].catId,
      catName: catRow ? catRow.name : deduped[i].variant,
      text: segText,
    });
  }

  return segments;
}

/**
 * 入力テキストから猫名候補を提示（レーベンシュタイン距離 <= 3）
 * @param {Object} [filterOpts] - resolveCatName と同じ filterLocation / filterStatus（一覧の拠点フィルタと一致させる）
 */
export async function suggestCatNames(rawText, db, filterOpts) {
  var dict = await loadDictionary(db);
  var allowedIds = null;
  if (filterOpts && (filterOpts.filterLocation || filterOpts.filterStatus)) {
    allowedIds = await loadAllowedCatIds(db, filterOpts.filterLocation, filterOpts.filterStatus);
  }
  if (allowedIds) {
    dict = dict.filter(function (e) { return allowedIds[e.catId]; });
  }
  var textNorm = rawText.replace(/\s+/g, '');
  var textHira = kataToHira(textNorm);
  var firstToken = rawText.split(/\s+/)[0] || textNorm;
  if (firstToken.length < 1) return [];

  var firstHira = kataToHira(firstToken.replace(/\s+/g, ''));
  var candidates = {};
  for (var i = 0; i < dict.length; i++) {
    var entry = dict[i];
    if (entry.variantNorm.length < 2) continue;
    var varHira = kataToHira(entry.variantNorm);
    var minDist = 999;
    var maxPl2 = Math.min(textHira.length, varHira.length + 3);
    for (var pl2 = 2; pl2 <= maxPl2; pl2++) {
      var d0 = levenshtein(textHira.slice(0, pl2), varHira);
      if (d0 < minDist) minDist = d0;
    }
    if (firstHira.length >= 2) {
      var maxPl3 = Math.min(firstHira.length, varHira.length + 3);
      for (var pl3 = 2; pl3 <= maxPl3; pl3++) {
        var d1 = levenshtein(firstHira.slice(0, pl3), varHira);
        if (d1 < minDist) minDist = d1;
      }
    }
    if (minDist <= 3 && !candidates[entry.catId]) {
      candidates[entry.catId] = { catId: entry.catId, variant: entry.variant, dist: minDist, priority: entry.priority };
    } else if (minDist <= 3 && candidates[entry.catId] && minDist < candidates[entry.catId].dist) {
      candidates[entry.catId] = { catId: entry.catId, variant: entry.variant, dist: minDist, priority: entry.priority };
    }
  }

  var result = [];
  var keys = Object.keys(candidates);
  for (var k = 0; k < keys.length; k++) result.push(candidates[keys[k]]);
  result.sort(function (a, b) { return a.dist - b.dist || b.priority - a.priority; });
  return result.slice(0, 5).map(function (c) { return c.variant; });
}

/**
 * 自己修復: misrecognition_log の頻出パターンを cat_name_dictionary に自動追加
 */
export async function autoRepairDictionary(db) {
  var catNameOnly = " (failure_type = 'cat_name' OR failure_type IS NULL) ";
  var rows = await db.prepare(
    'SELECT attempted_name, COUNT(*) AS cnt FROM misrecognition_log WHERE auto_added = 0 AND' +
      catNameOnly +
      'AND attempted_name IS NOT NULL AND length(attempted_name) >= 2 GROUP BY attempted_name HAVING cnt >= 3 ORDER BY cnt DESC LIMIT 20'
  ).all();

  var patterns = rows.results || [];
  if (patterns.length === 0) return { repaired: 0 };

  var cats = await db.prepare('SELECT id, name FROM cats').all();
  var catList = cats.results || [];
  var dict = await loadDictionary(db);

  var repaired = 0;
  for (var p = 0; p < patterns.length; p++) {
    var attempted = patterns[p].attempted_name;
    var attemptedNorm = attempted.replace(/\s+/g, '');

    var alreadyExists = false;
    for (var d = 0; d < dict.length; d++) {
      if (dict[d].variantNorm === attemptedNorm) { alreadyExists = true; break; }
    }
    if (alreadyExists) {
      await db.prepare(
        "UPDATE misrecognition_log SET auto_added = 1 WHERE attempted_name = ? AND auto_added = 0 AND" + catNameOnly
      ).bind(attempted).run();
      continue;
    }

    var bestCat = null;
    var bestDist = 999;
    for (var c = 0; c < catList.length; c++) {
      var catName = catList[c].name.replace(/\s+/g, '');
      var dist = levenshtein(attemptedNorm, catName);
      if (dist < bestDist) { bestDist = dist; bestCat = catList[c]; }
    }

    for (var d = 0; d < dict.length; d++) {
      var dist = levenshtein(attemptedNorm, dict[d].variantNorm);
      if (dist < bestDist) { bestDist = dist; bestCat = { id: dict[d].catId, name: dict[d].variant }; }
    }

    if (bestCat && bestDist <= 2) {
      try {
        var logIds = await selectPendingMisrecognitionIdsByAttempted(db, attempted);
        await insertCatNameDictWithSources(db, {
          catId: bestCat.id,
          variant: attempted,
          variantType: 'auto_learned',
          priority: 70,
          entrySource: 'auto_repair',
          misrecognitionLogIds: logIds,
          resolveMisrecognition: { catId: bestCat.id, attemptedName: attempted },
        });
        repaired++;
        _dictCache = null;
        _dictCacheTs = 0;
      } catch (_) {}
    }
  }

  return { repaired: repaired };
}

/**
 * misrecognition_log に構造化失敗も記録する汎用ログ関数
 */
export async function logVoiceFailure(db, rawText, attempted, failureType) {
  try {
    await db.prepare(
      'INSERT INTO misrecognition_log (raw_text, attempted_name, failure_type) VALUES (?, ?, ?)'
    ).bind(rawText, attempted, failureType).run();
  } catch (_) {}
}

export function clearDictCache() {
  _dictCache = null;
  _dictCacheTs = 0;
  _productDictCache = null;
  _productDictCacheTs = 0;
}

// ─── 製品名（フード・薬）リゾルバー ───────────────────────────────────────────

async function loadProductDictionary(db) {
  var now = Date.now();
  if (_productDictCache && (now - _productDictCacheTs) < DICT_TTL_MS) {
    return _productDictCache;
  }

  var rows = await db.prepare(
    'SELECT product_id, product_type, variant, variant_type, priority FROM product_name_dictionary ORDER BY priority DESC'
  ).all();

  var entries = (rows.results || []).map(function (r) {
    return {
      productId: r.product_id,
      productType: r.product_type,
      variant: r.variant,
      variantNorm: r.variant.replace(/\s+/g, ''),
      variantType: r.variant_type,
      priority: r.priority || 50,
    };
  });

  _productDictCache = entries;
  _productDictCacheTs = now;
  return entries;
}

/**
 * テキストからフード名 or 薬名を検出
 * @param {string} text - 猫名を除いた残りテキスト
 * @param {D1Database} db
 * @param {string} [filterType] - 'food' | 'medicine' | null(両方)
 * @returns {Promise<{ productId: string|null, productType: string|null, productName: string|null, remainingText: string }>}
 */
export async function resolveProductName(text, db, filterType) {
  var dict = await loadProductDictionary(db);
  var textNorm = text.trim().replace(/\s+/g, '');
  var textClean = text.trim();

  var bestMatch = null;
  var bestLen = 0;
  var bestPriority = -1;

  for (var i = 0; i < dict.length; i++) {
    var entry = dict[i];
    if (filterType && entry.productType !== filterType) continue;
    var vLen = entry.variantNorm.length;
    if (vLen < 2) continue;

    var idx = textNorm.indexOf(entry.variantNorm);
    if (idx !== -1) {
      if (vLen > bestLen || (vLen === bestLen && entry.priority > bestPriority)) {
        bestMatch = entry;
        bestLen = vLen;
        bestPriority = entry.priority;
      }
    }
  }

  if (!bestMatch) {
    var tokens = textClean.split(/\s+/);
    for (var i = 0; i < dict.length; i++) {
      var entry = dict[i];
      if (filterType && entry.productType !== filterType) continue;
      var vLen = entry.variantNorm.length;
      if (vLen < 3) continue;

      for (var t = 0; t < tokens.length; t++) {
        var tokenNorm = tokens[t].replace(/\s+/g, '');
        if (tokenNorm.length < 2) continue;
        var dist = levenshtein(tokenNorm, entry.variantNorm);
        if (dist <= 1) {
          if (vLen > bestLen || (vLen === bestLen && entry.priority > bestPriority)) {
            bestMatch = entry;
            bestLen = vLen;
            bestPriority = entry.priority;
          }
          break;
        }
      }
    }
  }

  if (bestMatch) {
    var remaining = removeNameFromText(textClean, bestMatch.variant);
    var table = bestMatch.productType === 'food' ? 'foods' : 'medicines';
    var row = await db.prepare('SELECT name FROM ' + table + ' WHERE id = ?').bind(bestMatch.productId).first();
    return {
      productId: bestMatch.productId,
      productType: bestMatch.productType,
      productName: row ? row.name : bestMatch.variant,
      remainingText: remaining,
    };
  }

  return {
    productId: null,
    productType: null,
    productName: null,
    remainingText: textClean,
  };
}
