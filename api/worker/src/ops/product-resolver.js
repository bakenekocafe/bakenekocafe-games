/**
 * NYAGI 製品名リゾルバー
 *
 * 音声テキストからフード名・薬名を検出し product_id に解決する。
 * product_name_dictionary を参照。
 */

import { normalizeSearchFold } from './search-normalize.js';

var _prodCache = null;
var _prodCacheTs = 0;
var PROD_TTL_MS = 60 * 1000;

async function loadProductDict(db) {
  var now = Date.now();
  if (_prodCache && (now - _prodCacheTs) < PROD_TTL_MS) {
    return _prodCache;
  }

  var rows = await db.prepare(
    'SELECT product_id, product_type, variant, variant_type, priority FROM product_name_dictionary ORDER BY priority DESC'
  ).all();

  var entries = (rows.results || []).map(function (r) {
    return {
      productId: r.product_id,
      productType: r.product_type,
      variant: r.variant,
      variantNorm: r.variant.replace(/\s+/g, '').toLowerCase(),
      variantType: r.variant_type,
      priority: r.priority || 50,
    };
  });

  _prodCache = entries;
  _prodCacheTs = now;
  return entries;
}

/**
 * @param {string} text - 猫名除去後のテキスト
 * @param {D1Database} db
 * @param {string} [filterType] - 'food' | 'medicine' | null (both)
 * @returns {Promise<{ productId: string|null, productType: string|null, productName: string|null, remainingText: string }>}
 */
export async function resolveProductName(text, db, filterType) {
  var dict = await loadProductDict(db);
  var textNorm = normalizeSearchFold(text);

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

  if (bestMatch) {
    var remaining = removeProductFromText(text, bestMatch.variant);
    var officialName = bestMatch.variant;
    if (bestMatch.variantType !== 'official') {
      var official = dict.filter(function (e) {
        return e.productId === bestMatch.productId && e.variantType === 'official';
      });
      if (official.length > 0) officialName = official[0].variant;
    }

    return {
      productId: bestMatch.productId,
      productType: bestMatch.productType,
      productName: officialName,
      remainingText: remaining,
    };
  }

  return {
    productId: null,
    productType: null,
    productName: null,
    remainingText: text,
  };
}

function removeProductFromText(text, variant) {
  var escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp(escaped, 'i');
  return text.replace(re, '').replace(/\s+/g, ' ').trim();
}

export function clearProductDictCache() {
  _prodCache = null;
  _prodCacheTs = 0;
}
