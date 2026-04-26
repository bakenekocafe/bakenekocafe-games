/**
 * NYAGI 給餌管理ハンドラ（P5）
 *
 * GET  /feeding/foods?q=&search=            フード一覧（部分一致・複数語AND）
 * GET  /feeding/foods/:id/dictionary        製品辞書一覧
 * POST /feeding/foods/:id/dictionary       辞書エントリ追加（manual 等）
 * PUT  /feeding/foods/:id/dictionary        辞書エントリ更新
 * DELETE /feeding/foods/:id/dictionary      辞書エントリ削除（official 不可）
 * POST /feeding/foods                       フード登録
 * PUT  /feeding/foods/:id                   フード更新
 * POST /feeding/foods/scrape                URL → 栄養データ抽出(プレビュー)
 * POST /feeding/foods/search                テキスト → Web検索 → 栄養データ抽出
 * POST /feeding/foods/import                重複チェック + DB登録
 * GET  /feeding/plans?cat_id=xxx            猫の給餌プラン
 * POST /feeding/plans                       プラン作成（カロリー自動算出）
 * PUT  /feeding/plans/:id                   プラン更新
 * GET  /feeding/logs?cat_id=xxx&date=xxx    給餌ログ
 * POST /feeding/logs                        給餌ログ記録
 * GET  /feeding/calc?cat_id=xxx             カロリー計算結果
 */

import { opsJson } from './router.js';
import {
  getDailyTarget,
  refreshNutritionProfile,
  getDailyNutritionSummary,
  analyzeFoodPreference,
  summarizeFoodPreferences,
  fetchFoodPreferenceCoverageBatch,
  FOOD_PREF_LOOKBACK_DAYS,
} from './nutrition.js';
import { syncProductDict, resyncProductDict } from './product-dict.js';
import { jstCalendarAddDays, jstCalendarYmdFromInstant } from './jst-util.js';

/** 日本（JST）の暦日 YYYY-MM-DD（給餌 log_date の既定・一覧の日付ずれ防止） */
function jstYmdString() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** JST の HH:mm（あげた記録の served_time） */
function jstHmString() {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** HH:mm または HH:mm:ss → HH:mm。無効なら null */
function normalizeServedTimeHm(raw) {
  if (raw == null || raw === '') return null;
  var s = String(raw).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  var h = parseInt(m[1], 10);
  var mi = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
}

/** リクエストの served_time があれば採用、なければ現在 JST */
function resolveServedTimeForLogBody(body) {
  var fromBody = normalizeServedTimeHm(body && body.served_time);
  if (fromBody) return fromBody;
  return jstHmString();
}

export async function handleFeeding(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  // /feeding/foods/import
  if (subPath === '/foods/import' || subPath === '/foods/import/') {
    if (method === 'POST') return importFood(db, req);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/foods/scrape  (URL だけ渡してプレビュー、DB保存なし)
  if (subPath === '/foods/scrape' || subPath === '/foods/scrape/') {
    if (method === 'POST') return scrapeFood(req);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/foods/search  (テキスト → Web検索 → スクレイプ)
  if (subPath === '/foods/search' || subPath === '/foods/search/') {
    if (method === 'POST') return searchFood(req);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/foods/:id/dictionary
  var foodDictMatch = subPath.match(/^\/foods\/([^/]+)\/dictionary\/?$/);
  if (foodDictMatch) {
    var dictFoodId = decodeURIComponent(foodDictMatch[1]);
    if (method === 'GET') return listFoodDictionary(db, dictFoodId);
    if (method === 'POST') return addFoodDictionaryEntry(db, req, dictFoodId);
    if (method === 'PUT') return updateFoodDictionaryEntry(db, req, dictFoodId);
    if (method === 'DELETE') return deleteFoodDictionaryEntry(db, req, dictFoodId);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/foods/:id
  var foodIdMatch = subPath.match(/^\/foods\/([^/]+)$/);
  if (foodIdMatch) {
    var decodedFoodId = decodeURIComponent(foodIdMatch[1]);
    if (method === 'GET') return getFoodById(db, decodedFoodId);
    if (method === 'PUT') return putFood(db, req, decodedFoodId);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/foods
  if (subPath === '/foods' || subPath === '/foods/') {
    if (method === 'GET') return getFoods(db, url);
    if (method === 'POST') return postFood(db, req);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/presets/:id/apply  (POST: プリセットを猫に適用)
  var applyMatch = subPath.match(/^\/presets\/(\d+)\/apply$/);
  if (applyMatch) {
    if (method === 'POST') return applyPreset(db, req, staffAuth, parseInt(applyMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/presets/:id/items  (GET/POST)
  var presetItemsMatch = subPath.match(/^\/presets\/(\d+)\/items$/);
  if (presetItemsMatch) {
    var pid = parseInt(presetItemsMatch[1], 10);
    if (method === 'GET') return getPresetItems(db, pid);
    if (method === 'POST') return addPresetItem(db, req, pid);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/presets/:id/items/:itemId  (PUT/DELETE)
  var presetItemIdMatch = subPath.match(/^\/presets\/(\d+)\/items\/(\d+)$/);
  if (presetItemIdMatch) {
    var iid = parseInt(presetItemIdMatch[2], 10);
    if (method === 'PUT') return updatePresetItem(db, req, iid);
    if (method === 'DELETE') return deletePresetItem(db, iid);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/presets/:id  (GET/PUT/DELETE)
  var presetIdMatch = subPath.match(/^\/presets\/(\d+)$/);
  if (presetIdMatch) {
    var psid = parseInt(presetIdMatch[1], 10);
    if (method === 'GET') return getPreset(db, psid);
    if (method === 'PUT') return updatePreset(db, req, psid);
    if (method === 'DELETE') return deletePreset(db, psid);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/presets  (GET/POST)
  if (subPath === '/presets' || subPath === '/presets/') {
    if (method === 'GET') return listPresets(db, url);
    if (method === 'POST') return createPreset(db, req, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/plans/:id/fed  (POST: ワンクリック「あげた」)
  var fedMatch = subPath.match(/^\/plans\/(\d+)\/fed$/);
  if (fedMatch) {
    if (method === 'POST') return quickFed(db, req, staffAuth, parseInt(fedMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/plans/:id
  var planIdMatch = subPath.match(/^\/plans\/(\d+)$/);
  if (planIdMatch) {
    if (method === 'PUT') return putPlan(db, req, parseInt(planIdMatch[1], 10));
    if (method === 'DELETE') return deletePlan(db, parseInt(planIdMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/plans
  if (subPath === '/plans' || subPath === '/plans/') {
    if (method === 'GET') return getPlans(db, url);
    if (method === 'POST') return postPlan(db, req);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/logs/history?cat_id=xxx&from=YYYY-MM-DD&to=YYYY-MM-DD&days=N
  if (subPath === '/logs/history' || subPath === '/logs/history/') {
    if (method === 'GET') return getFeedingHistory(db, url);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/logs/:id
  var logIdMatch = subPath.match(/^\/logs\/(\d+)$/);
  if (logIdMatch) {
    if (method === 'PUT') return putLog(db, req, staffAuth, parseInt(logIdMatch[1], 10));
    if (method === 'DELETE') return deleteLog(db, parseInt(logIdMatch[1], 10));
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/logs
  if (subPath === '/logs' || subPath === '/logs/') {
    if (method === 'GET') return getLogs(db, url);
    if (method === 'POST') return postLog(db, req, staffAuth);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/calc
  if (subPath === '/calc' || subPath === '/calc/') {
    if (method === 'GET') return calcFeeding(db, url);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  // /feeding/nutrition-profile?cat_id=xxx  GET=取得 PATCH=BCS更新
  if (subPath === '/nutrition-profile' || subPath === '/nutrition-profile/') {
    if (method === 'GET') return getNutritionProfile(db, url);
    if (method === 'PATCH') return patchNutritionProfile(db, req, url);
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  return opsJson({ error: 'not_found' }, 404);
}

// ── フード一覧 ────────────────────────────────────────────────────────────────

async function getFoods(db, url) {
  var activeOnly = url.searchParams.get('active') !== '0';
  var category = url.searchParams.get('category') || '';
  var speciesFilter = url.searchParams.get('species') || '';
  var qRaw = (url.searchParams.get('q') || url.searchParams.get('search') || '').trim();

  var sql = 'SELECT * FROM foods';
  var params = [];
  var conditions = [];

  if (activeOnly) conditions.push('active = 1');
  if (category) { conditions.push('category = ?'); params.push(category); }
  if (speciesFilter) { conditions.push('species = ?'); params.push(speciesFilter); }

  if (qRaw) {
    var words = qRaw.replace(/\u3000/g, ' ').split(/\s+/).filter(function (w) { return w.length > 0; });
    for (var wi = 0; wi < words.length; wi++) {
      var lw = String(words[wi]).toLowerCase();
      conditions.push(
        '(' +
          'INSTR(LOWER(COALESCE(name,\'\')), ?) > 0 OR ' +
          'INSTR(LOWER(COALESCE(brand,\'\')), ?) > 0 OR ' +
          'INSTR(LOWER(COALESCE(flavor,\'\')), ?) > 0 OR ' +
          'INSTR(LOWER(COALESCE(purpose,\'\')), ?) > 0 OR ' +
          'INSTR(LOWER(COALESCE(notes,\'\')), ?) > 0 OR ' +
          'INSTR(LOWER(COALESCE(id,\'\')), ?) > 0 OR ' +
          'INSTR(LOWER(COALESCE(category,\'\')), ?) > 0' +
          ')'
      );
      for (var bj = 0; bj < 7; bj++) params.push(lw);
    }
  }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY category, brand, name';

  var stmt = db.prepare(sql);
  if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
  var result = await stmt.all();
  return opsJson({ foods: result.results || [] });
}

async function listFoodDictionary(db, foodId) {
  var food = await db.prepare('SELECT id FROM foods WHERE id = ?').bind(foodId).first();
  if (!food) return opsJson({ error: 'not_found' }, 404);

  var res = await db
    .prepare(
      'SELECT variant, variant_type, priority FROM product_name_dictionary WHERE product_id = ? AND product_type = ? ORDER BY priority DESC, variant ASC'
    )
    .bind(foodId, 'food')
    .all();
  return opsJson({ entries: res.results || [] });
}

async function addFoodDictionaryEntry(db, req, foodId) {
  var food = await db.prepare('SELECT id FROM foods WHERE id = ?').bind(foodId).first();
  if (!food) return opsJson({ error: 'not_found' }, 404);

  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var variant = body.variant != null ? String(body.variant).trim() : '';
  if (!variant) return opsJson({ error: 'missing_fields', message: 'variant は必須です' }, 400);

  var vType = body.variant_type != null ? String(body.variant_type).trim() : 'manual';
  if (vType === 'official') return opsJson({ error: 'invalid_variant_type', message: 'official はフード名変更で同期されます' }, 400);

  var pri = body.priority != null ? parseInt(body.priority, 10) : 95;
  if (isNaN(pri)) pri = 95;

  try {
    await db
      .prepare(
        'INSERT INTO product_name_dictionary (product_id, product_type, variant, variant_type, priority) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(foodId, 'food', variant, vType, pri)
      .run();
  } catch (e) {
    if (e && String(e.message || '').indexOf('UNIQUE') !== -1) {
      return opsJson({ error: 'duplicate', message: '同じ variant / variant_type の行があります' }, 409);
    }
    throw e;
  }

  return listFoodDictionary(db, foodId);
}

async function updateFoodDictionaryEntry(db, req, foodId) {
  var food = await db.prepare('SELECT id FROM foods WHERE id = ?').bind(foodId).first();
  if (!food) return opsJson({ error: 'not_found' }, 404);

  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var oldVar = body.old_variant != null ? String(body.old_variant).trim() : '';
  var oldType = body.old_variant_type != null ? String(body.old_variant_type).trim() : '';
  if (!oldVar || !oldType) return opsJson({ error: 'missing_fields', message: 'old_variant, old_variant_type は必須です' }, 400);
  if (oldType === 'official') {
    var np = body.priority != null ? parseInt(body.priority, 10) : null;
    if (np == null || isNaN(np)) return opsJson({ error: 'missing_fields', message: 'official は priority のみ更新（priority 必須）' }, 400);
    await db
      .prepare(
        'UPDATE product_name_dictionary SET priority = ? WHERE product_id = ? AND product_type = ? AND variant = ? AND variant_type = ?'
      )
      .bind(np, foodId, 'food', oldVar, oldType)
      .run();
    return listFoodDictionary(db, foodId);
  }

  var newVar = body.variant != null ? String(body.variant).trim() : oldVar;
  var newType = body.variant_type != null ? String(body.variant_type).trim() : oldType;
  if (newType === 'official') return opsJson({ error: 'invalid_variant_type' }, 400);

  var newPri = body.priority != null ? parseInt(body.priority, 10) : null;
  var row = await db
    .prepare(
      'SELECT variant, variant_type, priority FROM product_name_dictionary WHERE product_id = ? AND product_type = ? AND variant = ? AND variant_type = ?'
    )
    .bind(foodId, 'food', oldVar, oldType)
    .first();
  if (!row) return opsJson({ error: 'not_found', message: '辞書行が見つかりません' }, 404);

  var inheritedPri = row.priority != null && !isNaN(parseInt(row.priority, 10)) ? parseInt(row.priority, 10) : 95;

  if (newVar === oldVar && newType === oldType && newPri == null) {
    return opsJson({ error: 'no_fields' }, 400);
  }

  if (newVar !== oldVar || newType !== oldType) {
    var finalPri = newPri != null && !isNaN(newPri) ? newPri : inheritedPri;
    try {
      await db.batch([
        db
          .prepare(
            'DELETE FROM product_name_dictionary WHERE product_id = ? AND product_type = ? AND variant = ? AND variant_type = ?'
          )
          .bind(foodId, 'food', oldVar, oldType),
        db
          .prepare(
            'INSERT INTO product_name_dictionary (product_id, product_type, variant, variant_type, priority) VALUES (?, ?, ?, ?, ?)'
          )
          .bind(foodId, 'food', newVar, newType, finalPri),
      ]);
    } catch (e) {
      if (e && String(e.message || '').indexOf('UNIQUE') !== -1) {
        return opsJson({ error: 'duplicate', message: '更新後の variant が既に存在します' }, 409);
      }
      throw e;
    }
  } else if (newPri != null && !isNaN(newPri)) {
    await db
      .prepare(
        'UPDATE product_name_dictionary SET priority = ? WHERE product_id = ? AND product_type = ? AND variant = ? AND variant_type = ?'
      )
      .bind(newPri, foodId, 'food', oldVar, oldType)
      .run();
  }

  return listFoodDictionary(db, foodId);
}

async function deleteFoodDictionaryEntry(db, req, foodId) {
  var food = await db.prepare('SELECT id FROM foods WHERE id = ?').bind(foodId).first();
  if (!food) return opsJson({ error: 'not_found' }, 404);

  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var variant = body.variant != null ? String(body.variant).trim() : '';
  var vType = body.variant_type != null ? String(body.variant_type).trim() : '';
  if (!variant || !vType) return opsJson({ error: 'missing_fields', message: 'variant, variant_type は必須です' }, 400);
  if (vType === 'official') return opsJson({ error: 'forbidden', message: 'official は削除できません' }, 403);

  await db
    .prepare(
      'DELETE FROM product_name_dictionary WHERE product_id = ? AND product_type = ? AND variant = ? AND variant_type = ?'
    )
    .bind(foodId, 'food', variant, vType)
    .run();

  return listFoodDictionary(db, foodId);
}

// ── フード登録（全カラム対応） ────────────────────────────────────────────────

var ALL_FOOD_COLS = 'id, brand, name, category, purpose, kcal_per_100g, protein_pct, fat_pct, notes, active, flavor, form, water_pct, fiber_pct, phosphorus_mg_per_100g, sodium_mg_per_100g, serving_size_g, product_url, food_type, species';

async function postFood(db, req) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  if (!body.id || !body.name || !body.category || body.kcal_per_100g === undefined) {
    return opsJson({ error: 'missing_fields', message: 'id, name, category, kcal_per_100g は必須です' }, 400);
  }

  await db.prepare(
    'INSERT INTO foods (' + ALL_FOOD_COLS + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    body.id, body.brand || null, body.name, body.category, body.purpose || null,
    body.kcal_per_100g, body.protein_pct || null, body.fat_pct || null, body.notes || null,
    body.flavor || null, body.form || 'dry', body.water_pct || null, body.fiber_pct || null,
    body.phosphorus_mg_per_100g || null, body.sodium_mg_per_100g || null,
    body.serving_size_g || null, body.product_url || null, body.food_type || 'complete',
    body.species || 'cat'
  ).run();

  await syncProductDict(db, body.id, 'food', body.name, body.brand);

  var food = await db.prepare('SELECT * FROM foods WHERE id = ?').bind(body.id).first();
  return opsJson({ food: food }, 201);
}

// ── URL スクレイピング（プレビュー用、DB保存なし） ─────────────────────────────

async function scrapeFood(req) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  if (!body.url) return opsJson({ error: 'missing_fields', message: 'url は必須です' }, 400);

  try {
    var extracted = await fetchAndParse(body.url);
    return opsJson({ status: 'ok', extracted: extracted, url: body.url });
  } catch (err) {
    return opsJson({ status: 'scrape_failed', message: err.message || 'ページ取得に失敗', url: body.url });
  }
}

// ── テキスト検索 → Web検索 → スクレイプ ─────────────────────────────────────

var KNOWN_DOMAINS = [
  'petline.co.jp',
  'royalcanin.com', 'vet.royalcanin.jp',
  'hills.co.jp',
  'inaba-petfood.co.jp',
  'specific.co.jp', 'jpd.co.jp',
  'petgo.jp', 'hp.petemo.jp', 'petmirai.com',
  'wannyan-care.net', 'petets.com',
  'irisplaza.co.jp',
  'amazon.co.jp', 'rakuten.co.jp',
  'shopping-charm.jp', 'askul.co.jp',
];

async function searchFood(req) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  if (!body.query || body.query.trim().length < 2) {
    return opsJson({ error: 'missing_fields', message: '検索テキスト(2文字以上)が必要です' }, 400);
  }

  var query = body.query.trim();
  var species = body.species || 'cat';
  var speciesLabel = species === 'dog' ? '犬' : '猫';

  if (query.indexOf('http') === 0) {
    try {
      var extracted = await fetchAndParse(query);
      return opsJson({ status: 'ok', extracted: extracted, url: query, candidates: [], query: query });
    } catch (err) {
      return opsJson({ status: 'scrape_failed', message: err.message || 'URL取得失敗', url: query, query: query });
    }
  }

  var searchQuery = query + ' ' + speciesLabel + ' フード カロリー';

  try {
    var results = await webSearch(query, species);

    if (!results || results.length === 0) {
      return opsJson({ status: 'no_results', query: query, message: '検索結果が見つかりません' });
    }

    var bestUrl = null;
    var allCandidates = [];

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var priority = 999;
      for (var d = 0; d < KNOWN_DOMAINS.length; d++) {
        if (r.url.indexOf(KNOWN_DOMAINS[d]) !== -1) {
          priority = d;
          break;
        }
      }
      allCandidates.push({ url: r.url, title: r.title, priority: priority });
    }

    allCandidates.sort(function(a, b) { return a.priority - b.priority; });

    var candidateList = [];
    for (var c = 0; c < Math.min(allCandidates.length, 5); c++) {
      candidateList.push({ url: allCandidates[c].url, title: allCandidates[c].title });
    }

    var extracted = null;
    var usedUrl = null;
    var scrapeError = null;
    var bestPartial = null;
    var bestPartialUrl = null;
    var maxTries = Math.min(allCandidates.length, 4);

    for (var t = 0; t < maxTries; t++) {
      var tryUrl = allCandidates[t].url;
      try {
        var tryResult = await fetchAndParse(tryUrl);
        if (tryResult && tryResult.kcal_per_100g && tryResult.protein_pct) {
          extracted = tryResult;
          usedUrl = tryUrl;
          break;
        }
        if (tryResult && tryResult.kcal_per_100g && !bestPartial) {
          bestPartial = tryResult;
          bestPartialUrl = tryUrl;
        }
        if (!bestPartial && tryResult && tryResult.name) {
          bestPartial = tryResult;
          bestPartialUrl = tryUrl;
        }
      } catch (err) {
        if (!scrapeError) scrapeError = err.message;
      }
    }

    if (!extracted && bestPartial) {
      extracted = bestPartial;
      usedUrl = bestPartialUrl;
    }

    if (extracted && extracted.kcal_per_100g) {
      return opsJson({
        status: 'ok',
        extracted: extracted,
        url: usedUrl,
        candidates: candidateList,
        query: query
      });
    }

    if (extracted && extracted.name) {
      return opsJson({
        status: 'ok',
        extracted: extracted,
        url: usedUrl,
        candidates: candidateList,
        query: query
      });
    }

    return opsJson({
      status: 'partial',
      message: scrapeError || 'ページからデータ抽出できず',
      candidates: candidateList,
      url: allCandidates[0].url,
      query: query
    });
  } catch (err) {
    return opsJson({ status: 'search_failed', message: err.message || '検索に失敗', query: query });
  }
}

// ── Web検索（DuckDuckGo HTML） ───────────────────────────────────────────────

async function webSearch(query, species) {
  species = species || 'cat';
  var speciesLabel = species === 'dog' ? '犬' : '猫';
  var searchKeyword = query + ' ' + speciesLabel + ' フード カロリー 栄養';

  var searchUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(searchKeyword);

  try {
    var res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'ja,en;q=0.5',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow'
    });
    if (!res.ok) return [];
    var html = await res.text();
    return parseDuckDuckGoResults(html);
  } catch (_) {
    return [];
  }
}

function parseDuckDuckGoResults(html) {
  var results = [];
  var seen = {};

  var re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]*)</g;
  var match;
  while ((match = re.exec(html)) !== null && results.length < 10) {
    try {
      var href = match[1].replace(/&amp;/g, '&');
      var title = match[2].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

      var uddgM = href.match(/uddg=([^&]+)/);
      if (!uddgM) continue;

      var rawUrl = decodeURIComponent(uddgM[1]);
      if (rawUrl.indexOf('duckduckgo.com') !== -1) continue;
      if (rawUrl.indexOf('google.com') !== -1) continue;
      if (seen[rawUrl]) continue;
      seen[rawUrl] = true;

      results.push({ url: rawUrl, title: title || rawUrl });
    } catch (_) {}
  }

  return results;
}

// ── フードインポート（スクレイピング + 重複チェック + DB保存） ──────────────────

async function importFood(db, req) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  if (!body.name || !body.category || body.kcal_per_100g === undefined) {
    return opsJson({ error: 'missing_fields', message: 'name, category, kcal_per_100g は必須' }, 400);
  }

  var dupByUrl = null;
  var dupByName = null;

  if (body.product_url) {
    dupByUrl = await db.prepare(
      'SELECT * FROM foods WHERE product_url = ? LIMIT 1'
    ).bind(body.product_url).first();
  }

  if (!dupByUrl) {
    dupByName = await db.prepare(
      'SELECT * FROM foods WHERE brand = ? AND name = ? LIMIT 1'
    ).bind(body.brand || '', body.name).first();
  }

  var dup = dupByUrl || dupByName;
  if (dup) {
    var enrichCols = ['kcal_per_100g','protein_pct','fat_pct','fiber_pct','water_pct','brand','species','product_url','form','purpose','flavor','food_type'];
    var setClauses = [];
    for (var ei = 0; ei < enrichCols.length; ei++) {
      var col = enrichCols[ei];
      var newVal = body[col];
      if (newVal != null && newVal !== '' && (dup[col] == null || dup[col] === '' || dup[col] === 0)) {
        setClauses.push({ col: col, val: newVal });
      }
    }
    if (setClauses.length > 0) {
      for (var si = 0; si < setClauses.length; si++) {
        await db.prepare('UPDATE foods SET ' + setClauses[si].col + ' = ? WHERE id = ?')
          .bind(setClauses[si].val, dup.id).run();
      }
      var enriched = await db.prepare('SELECT * FROM foods WHERE id = ?').bind(dup.id).first();
      return opsJson({ status: 'duplicate', reason: dupByUrl ? 'url' : 'name', existing: enriched, enriched: true, enriched_fields: setClauses.length });
    }
    return opsJson({ status: 'duplicate', reason: dupByUrl ? 'url' : 'name', existing: dup });
  }

  var foodId = body.id || generateFoodId(body.brand, body.name);

  var existingId = await db.prepare('SELECT id FROM foods WHERE id = ?').bind(foodId).first();
  if (existingId) {
    foodId = foodId + '-' + Date.now().toString(36);
  }

  await db.prepare(
    'INSERT INTO foods (' + ALL_FOOD_COLS + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    foodId, body.brand || null, body.name, body.category, body.purpose || null,
    body.kcal_per_100g, body.protein_pct || null, body.fat_pct || null, body.notes || null,
    body.flavor || null, body.form || 'dry', body.water_pct || null, body.fiber_pct || null,
    body.phosphorus_mg_per_100g || null, body.sodium_mg_per_100g || null,
    body.serving_size_g || null, body.product_url || null, body.food_type || 'complete',
    body.species || 'cat'
  ).run();

  await syncProductDict(db, foodId, 'food', body.name, body.brand);

  var food = await db.prepare('SELECT * FROM foods WHERE id = ?').bind(foodId).first();
  return opsJson({ status: 'created', food: food }, 201);
}

function generateFoodId(brand, name) {
  var slug = (brand || '').replace(/[^a-zA-Zぁ-ん一-龥]/g, '').slice(0, 6);
  var nSlug = (name || '').replace(/[^a-zA-Zぁ-ん一-龥0-9/]/g, '').slice(0, 20);
  return (slug + '-' + nSlug).toLowerCase().replace(/\s+/g, '-') || 'food-' + Date.now().toString(36);
}

// ── ページ取得 + パース ──────────────────────────────────────────────────────────

var SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'ja,en;q=0.5'
};

async function fetchAndParse(url) {
  var res = await fetch(url, { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  var html = await decodeResponse(res);

  var result;
  if (url.indexOf('royalcanin.com') !== -1 || url.indexOf('royalcanin.jp') !== -1) result = parseRoyalCanin(html, url);
  else if (url.indexOf('hills.co.jp') !== -1) result = parseHills(html, url);
  else if (url.indexOf('wannyan-care.net') !== -1) result = parseWanNyanProduct(html, url);
  else result = parseGeneric(html, url);

  if (!result.kcal_per_100g || !result.protein_pct) {
    _enrichFromEmbeddedData(html, result);
  }

  if ((!result.kcal_per_100g || !result.protein_pct) && url.indexOf('petline.co.jp') !== -1) {
    var productLink = _findFirstProductLink(html, url);
    if (productLink) {
      try {
        var subRes = await fetch(productLink, { headers: SCRAPE_HEADERS, signal: AbortSignal.timeout(8000) });
        if (subRes.ok) {
          var subHtml = await decodeResponse(subRes);
          var subResult = parseGeneric(subHtml, productLink);
          if (subResult.kcal_per_100g) {
            if (!result.name && subResult.name) result.name = subResult.name;
            result.kcal_per_100g = subResult.kcal_per_100g;
            if (subResult.protein_pct) result.protein_pct = subResult.protein_pct;
            if (subResult.fat_pct) result.fat_pct = subResult.fat_pct;
            if (subResult.fiber_pct) result.fiber_pct = subResult.fiber_pct;
            if (subResult.water_pct) result.water_pct = subResult.water_pct;
            if (subResult.species) result.species = subResult.species;
            if (subResult.category) result.category = subResult.category;
            result.product_url = productLink;
          }
        }
      } catch (_) {}
    }
  }

  return result;
}

function _findFirstProductLink(html, baseUrl) {
  var absRe = /href="(https?:\/\/[^"]*petline\.co\.jp\/(?:dog|cat)\/[A-Z]+\/U\d{3,}[^"]*)"/g;
  var m = absRe.exec(html);
  if (m) return m[1].replace(/\/\/$/, '/');

  var relRe = /href="(\/(?:dog|cat)\/[A-Z]+\/U\d{3,}\/?[^"]*)"/g;
  m = relRe.exec(html);
  if (m) {
    try { return new URL(m[1], baseUrl).href; } catch (_) {}
  }

  var dotRe = /href="([^"]*\/(?:dog|cat)\/[A-Z]+\/U\d{3,}[^"]*)"/g;
  m = dotRe.exec(html);
  if (m) {
    try { return new URL(m[1], baseUrl).href; } catch (_) {}
  }

  return null;
}

function _enrichFromEmbeddedData(html, result) {
  var nextDataMatch = html.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/);
  var jsonText = nextDataMatch ? nextDataMatch[1] : '';

  if (!jsonText) {
    var scriptBlocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (var si = 0; si < scriptBlocks.length; si++) {
      var inner = scriptBlocks[si].replace(/<\/?script[^>]*>/gi, '');
      if (inner.indexOf('kcal') !== -1 && inner.length > 100) {
        jsonText = inner;
        break;
      }
    }
  }

  if (!jsonText) return;

  if (!result.kcal_per_100g) {
    var kcalPats = [
      /(\d{2,4}(?:\.\d+)?)\s*kcal\s*\/\s*100\s*g/i,
      /100\s*g[^\d]{0,20}(\d{2,4}(?:\.\d+)?)\s*kcal/i,
      /"kcal_per_100g"\s*:\s*(\d+(?:\.\d+)?)/,
      /"caloric_value_per_weight"\s*:\s*\{\s*"amount"\s*:\s*(\d+)/,
    ];
    for (var ki = 0; ki < kcalPats.length; ki++) {
      var km = jsonText.match(kcalPats[ki]);
      if (km) {
        var val = parseFloat(km[1]);
        if (kcalPats[ki].source.indexOf('caloric_value') !== -1 && val > 1000) val = Math.round(val / 10);
        if (val > 10 && val < 1000) { result.kcal_per_100g = val; break; }
      }
    }
  }

  if (!result.protein_pct) {
    var protPats = [
      /(?:\\u305F\\u3093\\u3071\\u304F\\u8CEA|たんぱく質|粗たん白質|タンパク質)[^0-9]{0,10}(\d+(?:\.\d+)?)\s*[%％]/,
      /"protein[_"]?\s*[":]\s*["{]?\s*(\d+(?:\.\d+)?)/i,
    ];
    for (var pi = 0; pi < protPats.length; pi++) {
      var pm = jsonText.match(protPats[pi]);
      if (pm) { result.protein_pct = parseFloat(pm[1]); break; }
    }
  }

  if (!result.fat_pct) {
    var fatPats = [
      /(?:\\u8102\\u8CEA|脂質|粗脂肪)[^0-9]{0,10}(\d+(?:\.\d+)?)\s*[%％]/,
      /"fat[_"]?\s*[":]\s*["{]?\s*(\d+(?:\.\d+)?)/i,
    ];
    for (var fi = 0; fi < fatPats.length; fi++) {
      var fm = jsonText.match(fatPats[fi]);
      if (fm) { result.fat_pct = parseFloat(fm[1]); break; }
    }
  }

  if (!result.fiber_pct) {
    var fiberM = jsonText.match(/(?:粗繊維|食物繊維|繊維)[^0-9]{0,10}(\d+(?:\.\d+)?)\s*[%％]/);
    if (fiberM) result.fiber_pct = parseFloat(fiberM[1]);
  }

  if (!result.water_pct) {
    var waterM = jsonText.match(/水分[^0-9]{0,10}(\d+(?:\.\d+)?)\s*[%％]/);
    if (waterM) result.water_pct = parseFloat(waterM[1]);
  }

  if (!result.name) {
    var nameM = jsonText.match(/"(?:product_?name|name|title)"\s*:\s*"([^"]{3,80})"/i);
    if (nameM) result.name = nameM[1].replace(/\\u[\da-fA-F]{4}/g, function (m) { return String.fromCharCode(parseInt(m.slice(2), 16)); });
  }
}

var LEGACY_ENCODINGS = {
  'shift_jis': 'shift_jis', 'sjis': 'shift_jis', 'shift-jis': 'shift_jis',
  'windows-31j': 'shift_jis', 'x-sjis': 'shift_jis',
  'euc-jp': 'euc-jp', 'eucjp': 'euc-jp', 'x-euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr', 'gb2312': 'gb2312', 'gbk': 'gbk', 'big5': 'big5'
};

async function decodeResponse(res) {
  var ct = res.headers.get('content-type') || '';
  var charsetMatch = ct.match(/charset=([^\s;]+)/i);
  var charset = charsetMatch ? charsetMatch[1].toLowerCase().replace(/['"]/g, '') : '';

  var buf = await res.arrayBuffer();
  var encoding = LEGACY_ENCODINGS[charset];

  if (encoding) {
    try { return new TextDecoder(encoding).decode(buf); } catch (_) {}
  }

  var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);

  if (!encoding) {
    var metaMatch = utf8.match(/<meta[^>]*charset=["']?([^"';\s>]+)/i);
    if (metaMatch) {
      var mc = metaMatch[1].toLowerCase();
      var metaEnc = LEGACY_ENCODINGS[mc];
      if (metaEnc) {
        try { return new TextDecoder(metaEnc).decode(buf); } catch (_) {}
      }
    }
  }

  return utf8;
}

function parseRoyalCanin(html, url) {
  var result = { source: 'royalcanin', product_url: url };

  var titleMatch = html.match(/<h1[^>]*>([^<]+)</i);
  if (titleMatch) result.name = titleMatch[1].trim();

  var kcalPatterns = [
    /(\d{2,4}(?:\.\d+)?)\s*kcal\s*\/\s*100\s*g/i,
    /100\s*g[^\d]{0,20}(\d{2,4}(?:\.\d+)?)\s*kcal/i,
    /caloric_value_per_weight[^}]*"amount"\s*:\s*(\d+)/,
  ];
  for (var ki = 0; ki < kcalPatterns.length; ki++) {
    var km = html.match(kcalPatterns[ki]);
    if (km) {
      var kval = parseFloat(km[1]);
      if (ki === 2 && kval > 1000) kval = Math.round(kval / 10);
      if (kval > 10 && kval < 1000) { result.kcal_per_100g = kval; break; }
    }
  }

  var protPats = [
    /たんぱく質[^0-9]{0,15}(\d+(?:\.\d+)?)\s*[%％]/,
    /粗たん白質[^0-9]{0,15}(\d+(?:\.\d+)?)\s*[%％]/,
  ];
  for (var pi = 0; pi < protPats.length; pi++) {
    var pm = html.match(protPats[pi]);
    if (pm) { result.protein_pct = parseFloat(pm[1]); break; }
  }

  var fatPats = [/脂質[^0-9]{0,15}(\d+(?:\.\d+)?)\s*[%％]/, /粗脂肪[^0-9]{0,15}(\d+(?:\.\d+)?)\s*[%％]/];
  for (var fi = 0; fi < fatPats.length; fi++) {
    var fm = html.match(fatPats[fi]);
    if (fm) { result.fat_pct = parseFloat(fm[1]); break; }
  }

  var fiberMatch = html.match(/粗繊維[^0-9]{0,15}(\d+(?:\.\d+)?)\s*[%％]/);
  if (fiberMatch) result.fiber_pct = parseFloat(fiberMatch[1]);

  var waterMatch = html.match(/水分[^0-9]{0,15}(\d+(?:\.\d+)?)\s*[%％]/);
  if (waterMatch) result.water_pct = parseFloat(waterMatch[1]);

  result.brand = 'ロイヤルカナン';
  if (html.indexOf('療法食') !== -1 || html.indexOf('食事療法食') !== -1) {
    result.category = '療法食';
  }
  if (result.name) {
    if (result.name.indexOf('ドライ') !== -1) result.form = 'dry';
    else if (result.name.indexOf('ウェット') !== -1 || result.name.indexOf('パウチ') !== -1 || result.name.indexOf('缶') !== -1) result.form = 'wet';
    else if (result.name.indexOf('リキッド') !== -1) result.form = 'liquid';
  }

  return result;
}

function parseHills(html, url) {
  var result = { source: 'hills', product_url: url };

  var titleMatch = html.match(/<h1[^>]*>([^<]+)</i);
  if (titleMatch) result.name = titleMatch[1].trim();

  var stripped = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

  var kcalPats = [
    /(\d{2,4}(?:\.\d+)?)\s*kcal\s*\/\s*100\s*g/i,
    /100\s*g[^\d]{0,20}(\d{2,4}(?:\.\d+)?)\s*kcal/i,
    /カロリー[^\d]{0,30}(\d{2,4}(?:\.\d+)?)\s*kcal/i,
    /エネルギー[^\d]{0,30}(\d{2,4}(?:\.\d+)?)\s*kcal/i,
  ];
  for (var ki = 0; ki < kcalPats.length; ki++) {
    var km = stripped.match(kcalPats[ki]);
    if (km) { result.kcal_per_100g = parseFloat(km[1]); break; }
  }

  var proteinMatch = stripped.match(/(?:たんぱく質|粗たん白質|タンパク質)[^0-9]{0,30}(\d+(?:\.\d+)?)\s*[%％]/);
  if (proteinMatch) result.protein_pct = parseFloat(proteinMatch[1]);

  var fatMatch = stripped.match(/(?:脂質|粗脂肪)[^0-9]{0,30}(\d+(?:\.\d+)?)\s*[%％]/);
  if (fatMatch) result.fat_pct = parseFloat(fatMatch[1]);

  var fiberMatch = stripped.match(/(?:粗繊維|食物繊維)[^0-9]{0,30}(\d+(?:\.\d+)?)\s*[%％]/);
  if (fiberMatch) result.fiber_pct = parseFloat(fiberMatch[1]);

  var waterMatch = stripped.match(/水分[^0-9]{0,30}(\d+(?:\.\d+)?)\s*[%％]/);
  if (waterMatch) result.water_pct = parseFloat(waterMatch[1]);

  result.brand = 'ヒルズ';
  if (html.indexOf('療法食') !== -1 || url.indexOf('prescription') !== -1) {
    result.category = '療法食';
  }
  if (result.name) {
    if (result.name.indexOf('ドライ') !== -1) result.form = 'dry';
    else if (result.name.indexOf('缶') !== -1 || result.name.indexOf('シチュー') !== -1 || result.name.indexOf('ウェット') !== -1) result.form = 'wet';
  }

  return result;
}

function parseGeneric(html, url) {
  var result = { source: 'generic', product_url: url };

  var titleMatch = html.match(/<h1[^>]*>([^<]+)</i);
  if (titleMatch) result.name = titleMatch[1].trim();
  if (!result.name) {
    var ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (ogTitle) result.name = ogTitle[1].trim();
  }
  if (!result.name) {
    var tTitle = html.match(/<title>([^<]+)</i);
    if (tTitle) result.name = tTitle[1].replace(/\s*[\|｜\-–—].*/,'').trim();
  }

  var stripped = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

  var kcalPatterns = [
    /(\d{2,4}(?:\.\d+)?)\s*kcal\s*\/\s*100\s*g/i,
    /100\s*g\s*(?:あたり|当(?:た)?り)[^\d]*(\d{2,4}(?:\.\d+)?)\s*kcal/i,
    /代謝(?:エネルギー|カロリー)[^\d]*(\d{2,4}(?:\.\d+)?)\s*kcal/i,
    /カロリー[^\d]{0,30}(\d{2,4}(?:\.\d+)?)\s*kcal/i,
    /(\d{2,4}(?:\.\d+)?)\s*kcal\s*[\(（]\s*100\s*g/i,
    /エネルギー[^\d]{0,30}(\d{2,4}(?:\.\d+)?)\s*kcal/i,
  ];
  for (var ki = 0; ki < kcalPatterns.length; ki++) {
    var km = stripped.match(kcalPatterns[ki]);
    if (km) { result.kcal_per_100g = parseFloat(km[1]); break; }
  }

  var proteinPatterns = [
    /(?:たんぱく質|粗たん白質|タンパク質|粗蛋白質|protein)[^0-9]{0,30}(\d+(?:\.\d+)?)\s*[%％](?!\s*(?:カット|削減|減|ダウン|オフ|OFF|off))/i,
  ];
  for (var pi = 0; pi < proteinPatterns.length; pi++) {
    var pm = stripped.match(proteinPatterns[pi]);
    if (pm) { result.protein_pct = parseFloat(pm[1]); break; }
  }

  var fatPatterns = [
    /(?:粗脂肪|脂質|脂肪|fat)[^0-9]{0,30}(\d+(?:\.\d+)?)\s*[%％](?!\s*(?:カット|削減|減|ダウン|オフ|OFF|off))/i,
  ];
  for (var fi = 0; fi < fatPatterns.length; fi++) {
    var fm = stripped.match(fatPatterns[fi]);
    if (fm) { result.fat_pct = parseFloat(fm[1]); break; }
  }

  var fiberMatch = stripped.match(/(?:粗繊維|食物繊維|繊維|fiber)[^0-9]{0,30}(\d+(?:\.\d+)?)\s*[%％](?!\s*(?:カット|削減|減|ダウン|オフ|OFF|off))/i);
  if (fiberMatch) result.fiber_pct = parseFloat(fiberMatch[1]);

  var waterMatch = stripped.match(/水分[^0-9]{0,30}(\d+(?:\.\d+)?)\s*[%％](?!\s*(?:カット|削減|減|ダウン|オフ|OFF|off))/i);
  if (waterMatch) result.water_pct = parseFloat(waterMatch[1]);

  var brands = [
    ['ロイヤルカナン', 'Royal Canin'],
    ['ヒルズ', 'Hills', "Hill's"],
    ['スペシフィック', 'SPECIFIC'],
    ['ピュリナ', 'Purina'],
    ['アイムス', 'IAMS'],
    ['ニュートロ', 'Nutro'],
    ['メディコート', 'Medycoat'],
    ['ペットライン', 'Petline'],
    ['いなば', 'INABA', 'CIAOちゅ～る'],
    ['ユニ・チャーム', 'ユニチャーム', 'AllWell', 'オールウェル', '銀のスプーン'],
    ['カルカン', 'Kalkan'],
    ['モンプチ', 'Mon Petit'],
    ['シーバ', 'Sheba'],
    ['ファーストチョイス', '1st Choice'],
    ['ナチュラルバランス', 'Natural Balance'],
    ['アカナ', 'ACANA'],
    ['オリジン', 'ORIJEN'],
    ['ブルーバッファロー', 'Blue Buffalo'],
    ['ウェルネス', 'Wellness'],
    ['フォルツァ10', 'FORZA10'],
    ['ジェーピースタイル', 'JPスタイル', 'JP STYLE'],
    ['ビューティープロ', 'Beauty Pro'],
    ['ミャウミャウ', 'MiawMiaw'],
    ['懐石', 'KAISEKI'],
  ];
  for (var bi = 0; bi < brands.length; bi++) {
    for (var bj = 0; bj < brands[bi].length; bj++) {
      if (html.indexOf(brands[bi][bj]) !== -1) { result.brand = brands[bi][0]; break; }
    }
    if (result.brand) break;
  }

  if (html.indexOf('療法食') !== -1 || html.indexOf('プリスクリプション') !== -1 || html.indexOf('ベテリナリー') !== -1) {
    result.category = '療法食';
  } else if (html.indexOf('総合栄養食') !== -1) {
    result.category = '総合栄養食';
  } else if (html.indexOf('一般食') !== -1) {
    result.category = '一般食';
  } else if (html.indexOf('おやつ') !== -1 || html.indexOf('間食') !== -1) {
    result.category = 'おやつ';
  }

  result.species = _detectSpecies(url, stripped, result.name || '');

  if (result.name) {
    if (result.name.indexOf('ドライ') !== -1) result.form = 'dry';
    else if (result.name.indexOf('ウェット') !== -1 || result.name.indexOf('缶') !== -1 || result.name.indexOf('パウチ') !== -1) result.form = 'wet';
    else if (result.name.indexOf('リキッド') !== -1 || result.name.indexOf('ちゅ～る') !== -1) result.form = 'liquid';
  }

  return result;
}

function _detectSpecies(url, stripped, name) {
  var urlLower = url.toLowerCase();
  if (urlLower.indexOf('/cat') !== -1 || urlLower.indexOf('cat-food') !== -1 || urlLower.indexOf('feline') !== -1) return 'cat';
  if (urlLower.indexOf('/dog') !== -1 || urlLower.indexOf('dog-food') !== -1 || urlLower.indexOf('canine') !== -1) return 'dog';

  var nameAndTitle = name;
  if (nameAndTitle.indexOf('キャットフード') !== -1 || nameAndTitle.indexOf('猫用') !== -1) return 'cat';
  if (nameAndTitle.indexOf('ドッグフード') !== -1 || nameAndTitle.indexOf('犬用') !== -1) return 'dog';

  var catScore = 0;
  var dogScore = 0;
  var catWords = ['猫用', 'キャットフード', '愛猫', '成猫', '子猫', '猫（', 'for cats', 'feline'];
  var dogWords = ['犬用', 'ドッグフード', '愛犬', '成犬', '子犬', '犬（', 'for dogs', 'canine'];

  for (var ci = 0; ci < catWords.length; ci++) {
    var cIdx = stripped.indexOf(catWords[ci]);
    while (cIdx !== -1) { catScore++; cIdx = stripped.indexOf(catWords[ci], cIdx + 1); }
  }
  for (var di = 0; di < dogWords.length; di++) {
    var dIdx = stripped.indexOf(dogWords[di]);
    while (dIdx !== -1) { dogScore++; dIdx = stripped.indexOf(dogWords[di], dIdx + 1); }
  }

  if (catScore > dogScore && catScore >= 2) return 'cat';
  if (dogScore > catScore && dogScore >= 2) return 'dog';
  return 'unknown';
}

function parseWanNyanProduct(html, url) {
  var result = { source: 'wannyan-care', product_url: url };

  var titleMatch = html.match(/<title>([^<]+)/i);
  if (titleMatch) {
    var t = titleMatch[1].replace(/\s*-\s*獣医の.*$/, '').trim();
    result.name = t;
  }

  var kcalMatch = html.match(/代謝エネルギー[^\d]*(\d{2,4}(?:\.\d+)?)\s*kcal\s*\/\s*100\s*g/i);
  if (kcalMatch) {
    result.kcal_per_100g = parseFloat(kcalMatch[1]);
  } else {
    var kcalAlt = html.match(/(\d{2,4}(?:\.\d+)?)\s*kcal\s*\/\s*100\s*g/i);
    if (kcalAlt) {
      result.kcal_per_100g = parseFloat(kcalAlt[1]);
    } else {
      var kcalCan = html.match(/(\d{2,4}(?:\.\d+)?)\s*kcal\s*\/\s*缶/i);
      if (kcalCan) {
        var canKcal = parseFloat(kcalCan[1]);
        var canGMatch = html.match(/(\d{2,3})\s*g/);
        if (canGMatch) {
          var canG = parseFloat(canGMatch[1]);
          result.kcal_per_100g = Math.round(canKcal / canG * 100 * 10) / 10;
          result.serving_size_g = canG;
          result.notes = canKcal + 'kcal/缶(' + canG + 'g)';
        }
      }
    }
  }

  var proteinMatch = html.match(/たんぱく質\s*(\d+(?:\.\d+)?)\s*[%％]/);
  if (proteinMatch) result.protein_pct = parseFloat(proteinMatch[1]);

  var fatMatch = html.match(/脂質\s*(\d+(?:\.\d+)?)\s*[%％]/);
  if (fatMatch) result.fat_pct = parseFloat(fatMatch[1]);

  var fiberMatch = html.match(/粗繊維\s*(\d+(?:\.\d+)?)\s*[%％]/);
  if (fiberMatch) result.fiber_pct = parseFloat(fiberMatch[1]);

  var waterMatch = html.match(/水分\s*(\d+(?:\.\d+)?)\s*[%％]/);
  if (waterMatch) result.water_pct = parseFloat(waterMatch[1]);

  if (html.indexOf('ロイヤルカナン') !== -1 || html.indexOf('Royal Canin') !== -1) {
    result.brand = 'ロイヤルカナン';
  } else if (html.indexOf('ヒルズ') !== -1 || html.indexOf('Hills') !== -1) {
    result.brand = 'ヒルズ';
  } else if (html.indexOf('スペシフィック') !== -1) {
    result.brand = 'スペシフィック';
  }

  if (html.indexOf('療法食') !== -1 || html.indexOf('プリスクリプション') !== -1 || html.indexOf('ベテリナリー') !== -1) {
    result.category = '療法食';
  } else if (html.indexOf('総合栄養食') !== -1) {
    result.category = '総合栄養食';
  }

  if (result.name) {
    if (result.name.indexOf('ドライ') !== -1) result.form = 'dry';
    else if (result.name.indexOf('ウェット') !== -1 || result.name.indexOf('缶') !== -1) result.form = 'wet';
    else if (result.name.indexOf('パウチ') !== -1) result.form = 'wet';
  }

  return result;
}

// ── フード更新 ────────────────────────────────────────────────────────────────

async function getFoodById(db, id) {
  var food = await db.prepare('SELECT * FROM foods WHERE id = ?').bind(id).first();
  if (!food) return opsJson({ error: 'not_found' }, 404);
  return opsJson({ food: food });
}

async function putFood(db, req, id) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var existing = await db.prepare('SELECT id, kcal_per_100g FROM foods WHERE id = ?').bind(id).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);

  var sets = [];
  var params = [];
  var fields = ['brand', 'name', 'category', 'purpose', 'kcal_per_100g', 'protein_pct', 'fat_pct', 'notes', 'active', 'flavor', 'form', 'water_pct', 'fiber_pct', 'phosphorus_mg_per_100g', 'sodium_mg_per_100g', 'serving_size_g', 'product_url', 'food_type', 'species'];
  for (var f = 0; f < fields.length; f++) {
    var key = fields[f];
    if (body[key] !== undefined) { sets.push(key + ' = ?'); params.push(body[key]); }
  }

  if (sets.length === 0) return opsJson({ error: 'no_fields' }, 400);
  params.push(id);

  var sql = 'UPDATE foods SET ' + sets.join(', ') + ' WHERE id = ?';
  await db.prepare(sql).bind.apply(db.prepare(sql), params).run();

  var food = await db.prepare('SELECT * FROM foods WHERE id = ?').bind(id).first();

  if (body.name !== undefined) {
    await resyncProductDict(db, id, 'food', food.name, food.brand);
  }

  // kcal_per_100g が変更されたとき: このフードを参照する feeding_plans の kcal_calc を再計算
  var newKcal = parseFloat(body.kcal_per_100g);
  if (!isNaN(newKcal) && newKcal !== parseFloat(existing.kcal_per_100g)) {
    await db.prepare(
      "UPDATE feeding_plans SET kcal_calc = ROUND(amount_g * ? / 100, 2), updated_at = datetime('now') WHERE food_id = ? AND active = 1"
    ).bind(newKcal, id).run();
  }

  return opsJson({ food: food });
}

// ── 給餌プラン一覧 ────────────────────────────────────────────────────────────

async function getPlans(db, url) {
  var catId = url.searchParams.get('cat_id');
  if (!catId) return opsJson({ error: 'missing_params', message: 'cat_id は必須です' }, 400);

  var result = await db.prepare(
    'SELECT fp.*, f.name AS food_name, f.brand, f.kcal_per_100g, f.category AS food_category FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.cat_id = ? AND fp.active = 1 ORDER BY fp.meal_slot'
  ).bind(catId).all();

  var rows = result.results || [];
  // kcal_calc を最新の kcal_per_100g で上書き
  for (var ri = 0; ri < rows.length; ri++) {
    if (rows[ri].kcal_per_100g != null && rows[ri].amount_g != null) {
      rows[ri].kcal_calc = Math.round(rows[ri].amount_g * rows[ri].kcal_per_100g / 100 * 100) / 100;
    }
  }
  return opsJson({ plans: rows });
}

// ── 給餌プラン作成 ────────────────────────────────────────────────────────────

var MAX_PLANS_PER_CAT = 16;

function isPresetMenuItemActive(row) {
  if (!row || row.menu_active === undefined || row.menu_active === null) return true;
  return Number(row.menu_active) === 1;
}

async function findOtherCatWithAssignedPreset(db, presetId, catId) {
  var row = await db.prepare(
    'SELECT id FROM cats WHERE assigned_preset_id = ? AND id != ?'
  ).bind(presetId, catId).first();
  return row ? row.id : null;
}

/**
 * 献立をプリセットの有効行のみで全面置換（既存 active=1 のプランはすべて無効化）。
 * @param {object} opts setAssigned: 真なら cats.assigned_preset_id を更新
 */
export async function replaceCatFeedingPlansFromActivePreset(db, catId, presetId, opts) {
  opts = opts || {};
  var setAssigned = opts.setAssigned === true;

  var pr = await db.prepare('SELECT id, active FROM feeding_presets WHERE id = ?').bind(presetId).first();
  if (!pr || pr.active !== 1) {
    return { ok: false, reason: 'no_preset' };
  }

  var itemsRes = await db.prepare(
    'SELECT pi.*, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.preset_id = ? AND COALESCE(pi.menu_active, 1) = 1 ORDER BY pi.sort_order, pi.meal_slot'
  ).bind(presetId).all();
  var presetItems = itemsRes.results || [];
  if (presetItems.length === 0) {
    return { ok: false, reason: 'no_active_items' };
  }
  if (presetItems.length > MAX_PLANS_PER_CAT) {
    return { ok: false, reason: 'too_many_items' };
  }

  await db.prepare(
    "UPDATE feeding_plans SET active = 0, updated_at = datetime('now') WHERE cat_id = ? AND active = 1"
  ).bind(catId).run();

  for (var i = 0; i < presetItems.length; i++) {
    var pi = presetItems[i];
    var kcal = pi.amount_g * pi.kcal_per_100g / 100;
    await db.prepare(
      "INSERT INTO feeding_plans (cat_id, food_id, meal_slot, amount_g, kcal_calc, notes, active, plan_type, preset_id, scheduled_time, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'preset', ?, ?, datetime('now'))"
    ).bind(catId, pi.food_id, pi.meal_slot, pi.amount_g, kcal, pi.notes || null, presetId, pi.scheduled_time || null).run();
  }

  if (setAssigned) {
    await db.prepare(
      "UPDATE cats SET assigned_preset_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(presetId, catId).run();
  }

  return { ok: true, count: presetItems.length };
}

async function postPlan(db, req) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  if (!body.cat_id || !body.food_id || !body.meal_slot || body.amount_g === undefined) {
    return opsJson({ error: 'missing_fields', message: 'cat_id, food_id, meal_slot, amount_g は必須です' }, 400);
  }

  var countRow = await db.prepare('SELECT COUNT(*) AS cnt FROM feeding_plans WHERE cat_id = ? AND active = 1').bind(body.cat_id).first();
  if (countRow && countRow.cnt >= MAX_PLANS_PER_CAT) {
    return opsJson({ error: 'limit_reached', message: '1匹あたり最大' + MAX_PLANS_PER_CAT + '件です' }, 400);
  }

  var food = await db.prepare('SELECT kcal_per_100g FROM foods WHERE id = ?').bind(body.food_id).first();
  if (!food) return opsJson({ error: 'not_found', message: 'フードが見つかりません' }, 404);

  var kcalCalc = body.amount_g * food.kcal_per_100g / 100;

  var result = await db.prepare(
    "INSERT INTO feeding_plans (cat_id, food_id, meal_slot, amount_g, kcal_calc, notes, active, plan_type, preset_id, scheduled_time, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'))"
  ).bind(
    body.cat_id, body.food_id, body.meal_slot, body.amount_g, kcalCalc,
    body.notes || null, body.plan_type || 'staff', body.preset_id || null,
    body.scheduled_time || null
  ).run();

  var plan = await db.prepare(
    'SELECT fp.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.id = ?'
  ).bind(result.meta.last_row_id).first();
  return opsJson({ plan: plan }, 201);
}

async function deletePlan(db, id) {
  var existing = await db.prepare('SELECT id FROM feeding_plans WHERE id = ?').bind(id).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  await db.prepare("UPDATE feeding_plans SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
  return opsJson({ deleted: true });
}

// ── 給餌プラン更新 ────────────────────────────────────────────────────────────

async function putPlan(db, req, id) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var existing = await db.prepare('SELECT * FROM feeding_plans WHERE id = ?').bind(id).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);

  var sets = ["updated_at = datetime('now')"];
  var params = [];

  if (body.meal_slot !== undefined) { sets.push('meal_slot = ?'); params.push(body.meal_slot); }
  if (body.notes !== undefined) { sets.push('notes = ?'); params.push(body.notes); }
  if (body.active !== undefined) { sets.push('active = ?'); params.push(body.active ? 1 : 0); }
  if (body.scheduled_time !== undefined) { sets.push('scheduled_time = ?'); params.push(body.scheduled_time); }

  if (body.amount_g !== undefined || body.food_id !== undefined) {
    var newAmountG = body.amount_g !== undefined ? body.amount_g : existing.amount_g;
    var newFoodId = body.food_id !== undefined ? body.food_id : existing.food_id;
    var food = await db.prepare('SELECT kcal_per_100g FROM foods WHERE id = ?').bind(newFoodId).first();
    if (!food) return opsJson({ error: 'not_found', message: 'フードが見つかりません' }, 404);

    sets.push('amount_g = ?'); params.push(newAmountG);
    sets.push('food_id = ?'); params.push(newFoodId);
    sets.push('kcal_calc = ?'); params.push(newAmountG * food.kcal_per_100g / 100);
  }

  params.push(id);
  var sql = 'UPDATE feeding_plans SET ' + sets.join(', ') + ' WHERE id = ?';
  await db.prepare(sql).bind.apply(db.prepare(sql), params).run();

  var plan = await db.prepare(
    'SELECT fp.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.id = ?'
  ).bind(id).first();
  return opsJson({ plan: plan });
}

// ── 給餌履歴（複数日サマリ＋明細） ────────────────────────────────────────────

var DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

async function getFeedingHistory(db, url) {
  var catId = url.searchParams.get('cat_id');
  if (!catId) return opsJson({ error: 'missing_params', message: 'cat_id は必須です' }, 400);

  var toDate = url.searchParams.get('to') || jstYmdString();
  var days = Math.min(parseInt(url.searchParams.get('days') || '14', 10), 90);
  var fromDate = url.searchParams.get('from');
  if (!fromDate) {
    var t = new Date(toDate + 'T12:00:00+09:00');
    t.setDate(t.getDate() - (days - 1));
    fromDate = t.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  var rows = await db.prepare(
    'SELECT fl.id, fl.log_date, fl.meal_slot, fl.offered_g, fl.eaten_g, fl.remaining_g, fl.eaten_pct, fl.eaten_kcal, fl.served_time, fl.note, f.name AS food_name, f.brand AS food_brand, f.form AS food_form ' +
    'FROM feeding_logs fl ' +
    'LEFT JOIN foods f ON fl.food_id = f.id ' +
    'WHERE fl.cat_id = ? AND fl.log_date >= ? AND fl.log_date <= ? ' +
    'ORDER BY fl.log_date DESC, fl.meal_slot ASC, fl.served_time ASC'
  ).bind(catId, fromDate, toDate).all();

  var allRows = rows.results || [];

  // 日別にグループ化
  var byDate = {};
  for (var i = 0; i < allRows.length; i++) {
    var r = allRows[i];
    if (!byDate[r.log_date]) byDate[r.log_date] = [];
    byDate[r.log_date].push(r);
  }

  // 日付リストを降順に生成（ログがない日も含める）
  var history = [];
  var cur = new Date(toDate + 'T12:00:00+09:00');
  var from = new Date(fromDate + 'T12:00:00+09:00');
  while (cur >= from) {
    var ymd = cur.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    var meals = byDate[ymd] || [];

    var totalOffered = 0;
    var totalEaten = 0;
    var totalRemaining = 0;
    var totalKcal = 0;
    var hasAnyRecord = meals.length > 0;

    for (var j = 0; j < meals.length; j++) {
      var m = meals[j];
      if (m.offered_g != null) totalOffered += m.offered_g;
      if (m.eaten_g != null) totalEaten += m.eaten_g;
      else if (m.offered_g != null && m.eaten_pct != null) totalEaten += m.offered_g * m.eaten_pct / 100;
      if (m.remaining_g != null) totalRemaining += m.remaining_g;
      if (m.eaten_kcal != null) totalKcal += m.eaten_kcal;
    }

    var dt = new Date(ymd + 'T12:00:00+09:00');
    var dow = DOW_JA[dt.getDay()];
    var mm = dt.getMonth() + 1;
    var dd = dt.getDate();

    history.push({
      log_date: ymd,
      day_label: mm + '/' + dd + '(' + dow + ')',
      has_record: hasAnyRecord,
      total_offered_g: Math.round(totalOffered * 10) / 10,
      total_eaten_g: Math.round(totalEaten * 10) / 10,
      total_remaining_g: Math.round(totalRemaining * 10) / 10,
      total_eaten_kcal: Math.round(totalKcal * 10) / 10,
      eat_pct: totalOffered > 0 ? Math.round(totalEaten / totalOffered * 100) : null,
      meals: meals.map(function(ml) {
        return {
          id: ml.id,
          meal_slot: ml.meal_slot,
          food_name: ml.food_name || null,
          food_brand: ml.food_brand || null,
          offered_g: ml.offered_g,
          eaten_g: ml.eaten_g,
          remaining_g: ml.remaining_g,
          eaten_pct: ml.eaten_pct,
          eaten_kcal: ml.eaten_kcal,
          served_time: ml.served_time,
          note: ml.note || null,
        };
      }),
    });

    cur.setDate(cur.getDate() - 1);
  }

  return opsJson({ history: history, from: fromDate, to: toDate, cat_id: catId });
}

// ── 給餌ログ一覧 ──────────────────────────────────────────────────────────────

async function getLogs(db, url) {
  var catId = url.searchParams.get('cat_id');
  var date = url.searchParams.get('date') || jstYmdString();

  if (!catId) return opsJson({ error: 'missing_params', message: 'cat_id は必須です' }, 400);

  var result = await db.prepare(
    'SELECT fl.*, f.name AS food_name, s.name AS recorder_name FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id LEFT JOIN staff s ON fl.recorded_by = s.id WHERE fl.cat_id = ? AND fl.log_date = ? ORDER BY fl.meal_slot'
  ).bind(catId, date).all();

  return opsJson({ logs: result.results || [], date: date });
}

// ── 給餌ログ記録 ──────────────────────────────────────────────────────────────

async function postLog(db, req, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  if (!body.cat_id || !body.meal_slot) {
    return opsJson({ error: 'missing_fields', message: 'cat_id, meal_slot は必須です' }, 400);
  }

  var logDate = body.log_date || jstYmdString();

  var servedTime = resolveServedTimeForLogBody(body);
  var offeredGVal = body.offered_g || null;

  /** 摂取率未指定は 0%（まだ何も食べていない）— 旧挙動の「kcal だけ満タン」は誤解を招くため廃止 */
  var eatenPctVal = 0;
  if (body.eaten_pct !== undefined && body.eaten_pct !== null && String(body.eaten_pct).trim() !== '') {
    var epIn = Number(body.eaten_pct);
    if (!isNaN(epIn)) eatenPctVal = Math.max(0, Math.min(100, Math.round(epIn)));
  }

  var eatenKcal = null;
  if (body.kcal) {
    eatenKcal = body.kcal;
  } else if (body.food_id && body.offered_g) {
    var food = await db.prepare('SELECT kcal_per_100g FROM foods WHERE id = ?').bind(body.food_id).first();
    if (food && food.kcal_per_100g) {
      var kcalTotal = food.kcal_per_100g * body.offered_g / 100;
      eatenKcal = Math.round(kcalTotal * eatenPctVal / 100);
    }
  }

  var eatenG = offeredGVal && offeredGVal > 0 ? Math.round(offeredGVal * eatenPctVal / 100 * 10) / 10 : null;

  var result = await db.prepare(
    "INSERT INTO feeding_logs (cat_id, log_date, meal_slot, food_id, offered_g, eaten_pct, eaten_g, eaten_kcal, note, served_time, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    body.cat_id, logDate, body.meal_slot, body.food_id || null,
    offeredGVal, eatenPctVal, eatenG, eatenKcal, body.note || null, servedTime,
    body.recorded_by || staffAuth.staffId
  ).run();

  var log = await db.prepare('SELECT * FROM feeding_logs WHERE id = ?').bind(result.meta.last_row_id).first();
  return opsJson({ log: log }, 201);
}

// ── 給餌ログ削除（あげた取り消し） ────────────────────────────────────────────

async function deleteLog(db, logId) {
  var existing = await db.prepare('SELECT id FROM feeding_logs WHERE id = ?').bind(logId).first();
  if (!existing) return opsJson({ error: 'not_found', message: 'ログが見つかりません' }, 404);
  await db.prepare('DELETE FROM feeding_logs WHERE id = ?').bind(logId).run();
  return opsJson({ ok: true, deleted_id: logId });
}

// ── 給餌ログ更新 ──────────────────────────────────────────────────────────────

async function putLog(db, req, staffAuth, logId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }

  var existing = await db.prepare('SELECT * FROM feeding_logs WHERE id = ?').bind(logId).first();
  if (!existing) return opsJson({ error: 'not_found', message: '給餌ログが見つかりません' }, 404);

  var mealSlot = body.meal_slot !== undefined ? body.meal_slot : existing.meal_slot;
  var foodId = body.food_id !== undefined ? body.food_id : existing.food_id;
  var offeredG = body.offered_g !== undefined ? body.offered_g : existing.offered_g;
  var eatenPct = body.eaten_pct !== undefined ? body.eaten_pct : existing.eaten_pct;
  var note = body.note !== undefined ? body.note : existing.note;
  var eatenG = (offeredG && eatenPct != null) ? Math.round(offeredG * eatenPct / 100 * 10) / 10 : null;

  var servedTime = existing.served_time;
  if (body.served_time !== undefined) {
    if (body.served_time === null || String(body.served_time).trim() === '') {
      servedTime = jstHmString();
    } else {
      servedTime = normalizeServedTimeHm(body.served_time) || jstHmString();
    }
  }

  var eatenKcal = existing.eaten_kcal;
  if (body.kcal !== undefined && body.kcal !== null) {
    eatenKcal = body.kcal;
  } else if (foodId && offeredG) {
    var food = await db.prepare('SELECT kcal_per_100g FROM foods WHERE id = ?').bind(foodId).first();
    if (food && food.kcal_per_100g) {
      var kcalTotal = food.kcal_per_100g * offeredG / 100;
      eatenKcal = eatenPct != null ? Math.round(kcalTotal * eatenPct / 100) : null;
    }
  }

  await db.prepare(
    "UPDATE feeding_logs SET meal_slot = ?, food_id = ?, offered_g = ?, eaten_g = ?, eaten_pct = ?, eaten_kcal = ?, note = ?, served_time = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(mealSlot, foodId || null, offeredG || null, eatenG, eatenPct, eatenKcal, note || null, servedTime, logId).run();

  var updated = await db.prepare('SELECT * FROM feeding_logs WHERE id = ?').bind(logId).first();
  return opsJson({ log: updated });
}

// ── カロリー計算 ──────────────────────────────────────────────────────────────

async function calcFeeding(db, url) {
  var catId = url.searchParams.get('cat_id');
  if (!catId) return opsJson({ error: 'missing_params', message: 'cat_id は必須です' }, 400);

  try {
    var cat = await db.prepare('SELECT * FROM cats WHERE id = ?').bind(catId).first();
    if (!cat) return opsJson({ error: 'not_found' }, 404);

    // 犬は RER 式が猫と異なるため、表示のたびに栄養プロフィールを再計算（古い target_kcal_auto のまま残らないようにする）
    if ((cat.species || 'cat') === 'dog') {
      try { await refreshNutritionProfile(db, catId); } catch (_) {}
    }

    var daily = await getDailyTarget(db, catId);
    var requiredKcal = daily.target_kcal || null;
    var weightKg = daily.weight_kg || null;
    var lifeStage = daily.life_stage || 'adult';

    // fp.* は foods 側の同名カラムと混同される環境があるため、給餌プランのメモは fp.notes AS plan_notes で明示する
    var plans = await db.prepare(
      'SELECT fp.id, fp.cat_id, fp.food_id, fp.meal_slot, fp.amount_g, fp.kcal_calc, fp.notes AS plan_notes, fp.active, fp.updated_at, fp.meal_order, fp.scheduled_time, fp.target_kcal, fp.plan_type, fp.preset_id, f.name AS food_name, f.kcal_per_100g FROM feeding_plans fp LEFT JOIN foods f ON fp.food_id = f.id WHERE fp.cat_id = ? AND fp.active = 1 ORDER BY fp.meal_slot'
    ).bind(catId).all();

    var planRows = plans.results || [];
    for (var pr = 0; pr < planRows.length; pr++) {
      var prow = planRows[pr];
      prow.notes = prow.plan_notes != null ? prow.plan_notes : null;
      delete prow.plan_notes;
      // kcal_calc を JOIN した最新の kcal_per_100g で上書き（フードDB更新が即反映されるように）
      if (prow.kcal_per_100g != null && prow.amount_g != null) {
        prow.kcal_calc = Math.round(prow.amount_g * prow.kcal_per_100g / 100 * 100) / 100;
      }
    }
    var totalPlanKcal = 0;
    for (var i = 0; i < planRows.length; i++) {
      totalPlanKcal += planRows[i].kcal_calc || 0;
    }

    var context = await buildFeedingContext(db, catId, cat);

    var profile = await db.prepare(
      'SELECT body_condition_score, weight_trend, weight_trend_pct FROM cat_nutrition_profiles WHERE cat_id = ?'
    ).bind(catId).first();

    var todayNutrition = null;
    try { todayNutrition = await getDailyNutritionSummary(db, catId); } catch (_) {}

    var eatenToday = (todayNutrition && todayNutrition.eaten_kcal) ? todayNutrition.eaten_kcal : 0;
    var remainingKcal = requiredKcal ? Math.max(0, Math.round(requiredKcal - eatenToday)) : null;

    var mealsPerDay = cat.meals_per_day || null;
    var servedSlots = (todayNutrition && todayNutrition.served_slots) ? todayNutrition.served_slots : [];
    var fedCount = servedSlots.length;
    var remainingMeals = mealsPerDay ? Math.max(0, mealsPerDay - fedCount) : null;
    var kcalPerMeal = (remainingMeals && remainingKcal) ? Math.round(remainingKcal / remainingMeals) : null;

    var suggestion = null;
    if (requiredKcal && remainingKcal > 10) {
      try {
        suggestion = await buildPlanSuggestion(db, catId, requiredKcal, requiredKcal - remainingKcal, planRows, context, cat.species || 'cat', cat);
      } catch (sugErr) {
        console.warn('buildPlanSuggestion error:', sugErr && sugErr.message);
      }
    }

    var foodPreferenceSummary = null;
    try {
      var lookback = FOOD_PREF_LOOKBACK_DAYS;
      var prefCutoff = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -lookback);
      var prefRows = await analyzeFoodPreference(db, catId, lookback);
      var prefCov = await fetchFoodPreferenceCoverageBatch(db, [catId], prefCutoff);
      foodPreferenceSummary = summarizeFoodPreferences(prefRows, lookback, prefCov[String(catId)]);
    } catch (prefErr) {
      console.warn('food preference summary:', prefErr && prefErr.message);
    }

    var feedingPresetAlert = null;
    if (cat.assigned_preset_id != null && cat.assigned_preset_id !== '') {
      var pidAlert = cat.assigned_preset_id;
      var prAlert = await db.prepare('SELECT id, active FROM feeding_presets WHERE id = ?').bind(pidAlert).first();
      if (!prAlert || prAlert.active !== 1) {
        feedingPresetAlert = { code: 'preset_invalid', message: '無効なプリセットが関連付けされています' };
      } else {
        var cntAct = await db.prepare(
          'SELECT COUNT(*) AS c FROM feeding_preset_items WHERE preset_id = ? AND COALESCE(menu_active, 1) = 1'
        ).bind(pidAlert).first();
        var cAct = cntAct && cntAct.c != null ? Number(cntAct.c) : 0;
        if (!cAct) {
          feedingPresetAlert = { code: 'no_active_menus', message: '有効なメニューがありません' };
        }
      }
    }

    return opsJson({
    cat_id: catId,
    cat_name: cat.name,
    species: cat.species || 'cat',
    weight_kg: weightKg,
    life_stage: lifeStage,
    required_kcal: requiredKcal ? Math.round(requiredKcal) : null,
    plan_total_kcal: Math.round(totalPlanKcal),
    plans: planRows,
    rer: daily.rer || null,
    mer_factor: daily.factor || null,
    kcal_source: daily.source || 'none',
    body_condition_score: profile ? profile.body_condition_score : null,
    weight_trend: profile ? profile.weight_trend : null,
    weight_trend_pct: profile ? profile.weight_trend_pct : null,
    context: context,
    suggestion: suggestion,
    meals_per_day: mealsPerDay,
    fed_count: fedCount,
    remaining_meals: remainingMeals,
    remaining_kcal: remainingKcal,
    kcal_per_meal: kcalPerMeal,
    today: todayNutrition ? {
      date: todayNutrition.date,
      eaten_kcal: todayNutrition.eaten_kcal,
      remaining_kcal: todayNutrition.remaining_kcal,
      pct: todayNutrition.pct,
      status: todayNutrition.status,
      checked_meals: todayNutrition.checked_meals,
      unchecked_meals: todayNutrition.unchecked_meals,
      planned_meals: todayNutrition.planned_meals,
      served_slots: todayNutrition.served_slots,
      breakdown: todayNutrition.breakdown,
      data_source: todayNutrition.data_source || 'feeding_logs',
    } : null,
    food_preference_summary: foodPreferenceSummary,
    feeding_preset_alert: feedingPresetAlert,
  });
  } catch (e) {
    console.error('calcFeeding error:', e && e.message, e && e.stack);
    return opsJson({
      error: 'calc_failed',
      message: e && e.message ? String(e.message).slice(0, 200) : 'calc error',
      cat_id: catId,
      plans: [],
      plan_total_kcal: 0,
      required_kcal: null,
      today: null,
      food_preference_summary: null,
      feeding_preset_alert: null,
    });
  }
}

async function getNutritionProfile(db, url) {
  var catId = url.searchParams.get('cat_id');
  if (!catId) return opsJson({ error: 'missing_params', message: 'cat_id は必須です' }, 400);
  var row = await db.prepare(
    'SELECT body_condition_score, weight_trend, weight_trend_pct, last_weight_kg, target_kcal_auto, target_kcal_vet FROM cat_nutrition_profiles WHERE cat_id = ?'
  ).bind(catId).first();
  return opsJson({ profile: row || {} });
}

async function patchNutritionProfile(db, req, url) {
  var catId = url.searchParams.get('cat_id');
  if (!catId) return opsJson({ error: 'missing_params', message: 'cat_id は必須です' }, 400);
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  var bcs = body.body_condition_score;
  if (bcs !== undefined && bcs !== null) {
    var bcsNum = parseInt(bcs, 10);
    if (isNaN(bcsNum) || bcsNum < 1 || bcsNum > 9) {
      return opsJson({ error: 'bad_request', message: 'body_condition_score は 1-9 の整数です' }, 400);
    }
    await db.prepare(
      'INSERT INTO cat_nutrition_profiles (cat_id, body_condition_score, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(cat_id) DO UPDATE SET body_condition_score = excluded.body_condition_score, updated_at = datetime(\'now\')'
    ).bind(catId, bcsNum).run();
    try { await refreshNutritionProfile(db, catId); } catch (_) {}
    var updated = await db.prepare(
      'SELECT body_condition_score, weight_trend, weight_trend_pct FROM cat_nutrition_profiles WHERE cat_id = ?'
    ).bind(catId).first();
    return opsJson({ profile: updated || {} });
  }
  return opsJson({ error: 'bad_request', message: 'body_condition_score を指定してください' }, 400);
}

// ── 内部ヘルパー ──────────────────────────────────────────────────────────────

async function buildFeedingContext(db, catId, catRow) {
  var threeDaysAgo = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -3);

  var stoolRows = await db.prepare(
    "SELECT value, details, record_date FROM health_records WHERE cat_id = ? AND record_type = 'stool' AND record_date >= ? ORDER BY record_date DESC LIMIT 10"
  ).bind(catId, threeDaysAgo).all();

  var urineRows = await db.prepare(
    "SELECT value, details, record_date FROM health_records WHERE cat_id = ? AND record_type = 'urine' AND record_date >= ? ORDER BY record_date DESC LIMIT 10"
  ).bind(catId, threeDaysAgo).all();

  var vomitRows = await db.prepare(
    "SELECT value, details, record_date FROM health_records WHERE cat_id = ? AND record_type = 'vomiting' AND record_date >= ? ORDER BY record_date DESC LIMIT 5"
  ).bind(catId, threeDaysAgo).all();

  var stools = stoolRows.results || [];
  var urines = urineRows.results || [];
  var vomits = vomitRows.results || [];

  var stoolIssue = false;
  var urineIssue = false;
  var vomitRecent = vomits.length > 0;

  var stoolNormal = ['健康', '血便小', '普通'];
  var urineNormal = ['なし', '少量', '普通', '多い', '血尿小', '正常', '健康', 'あり'];
  for (var i = 0; i < stools.length; i++) {
    var sv = stools[i].value || '';
    if (stoolNormal.indexOf(sv) === -1) stoolIssue = true;
  }
  for (var j = 0; j < urines.length; j++) {
    var uv = urines[j].value || '';
    if (urineNormal.indexOf(uv) === -1) urineIssue = true;
  }

  var waterTrack = !!(catRow && catRow.water_tracking);

  var preferWet = stoolIssue || urineIssue || vomitRecent || waterTrack;

  var reasonParts = [];
  if (stoolIssue) reasonParts.push('排便異常あり');
  if (urineIssue) reasonParts.push('排尿異常あり');
  if (vomitRecent) reasonParts.push('嘔吐あり');
  if (waterTrack && !(stoolIssue || urineIssue || vomitRecent)) reasonParts.push('水分管理対象');

  return {
    stool_recent: stools.length,
    stool_issue: stoolIssue,
    urine_recent: urines.length,
    urine_issue: urineIssue,
    vomit_recent: vomitRecent,
    water_tracking: waterTrack,
    prefer_wet: preferWet,
    reason: reasonParts.length ? reasonParts.join(' ') : null,
  };
}

/**
 * purpose フィールド（英語キーと日本語フリーテキストが混在）を
 * 正規化タグに畳み込む。スコアリングの主鍵として使う。
 */
function normalizePurposeTag(purposeText) {
  if (!purposeText) return null;
  var t = String(purposeText).toLowerCase();
  if (/renal|腎/.test(t))                   return 'renal';
  if (/urinary|結石|尿|s\/o|ストルバイト/.test(t)) return 'urinary';
  if (/digestive|消化|gi|腸/.test(t))        return 'digestive';
  if (/hepatic|肝/.test(t))                  return 'hepatic';
  if (/diabet|糖尿/.test(t))                 return 'diabetic';
  if (/hypoaller|アレル|皮膚|skin/.test(t))  return 'allergy';
  if (/kitten|子猫/.test(t))                 return 'kitten';
  if (/senior|老齢|シニア|高齢|aim30/.test(t)) return 'senior';
  if (/diet|減量|weight/.test(t))            return 'diet';
  if (/general|一般|総合|complete|維持/.test(t)) return 'general';
  return 'general';
}

/**
 * internal_note の自由記述から推定タグ・嗜好ヒントを抽出
 */
function extractNoteTags(noteText) {
  var out = { tags: [], preferHighKcal: false, waterHint: false };
  if (!noteText) return out;
  var s = String(noteText);
  if (/老体|シニア|高齢/.test(s))               out.tags.push('senior');
  if (/腎(?!炎)|腎不全|腎臓/.test(s))            out.tags.push('renal');
  if (/結石|ストルバイト|s\/o|膀胱|血尿/i.test(s)) out.tags.push('urinary');
  if (/消化|下痢|軟便|gi|腸炎/i.test(s))         out.tags.push('digestive');
  if (/肝/.test(s))                             out.tags.push('hepatic');
  if (/糖尿/.test(s))                           out.tags.push('diabetic');
  if (/アレル|皮膚|かゆ/.test(s))               out.tags.push('allergy');
  if (/減量|肥満|太り/.test(s))                 out.tags.push('diet');
  if (/食が細い|食欲.*(不振|低下|ない|少)|痩せ/.test(s)) out.preferHighKcal = true;
  if (/水分|脱水|尿(?!道).*量/.test(s))         out.waterHint = true;
  return out;
}

async function buildPlanSuggestion(db, catId, requiredKcal, currentKcal, currentPlans, context, catSpecies, catRow) {
  var deficit = requiredKcal - currentKcal;
  if (deficit <= 0) return null;
  catSpecies = catSpecies || 'cat';

  var planFoodIds = {};
  for (var i = 0; i < currentPlans.length; i++) {
    planFoodIds[currentPlans[i].food_id] = true;
  }

  // ── ① diet_status=therapeutic の猫は療法食のみ候補に含める ──
  var dietStatus = catRow && catRow.diet_status;
  var onlyTherapeutic = dietStatus === 'therapeutic';

  var typeClause = onlyTherapeutic
    ? "AND food_type = 'therapeutic' "
    : "AND food_type IN ('complete', 'therapeutic') ";
  var candidates = await db.prepare(
    "SELECT id, name, brand, category, purpose, kcal_per_100g, form, food_type, species "
      + "FROM foods WHERE active = 1 " + typeClause + "AND species = ? "
      + "ORDER BY kcal_per_100g DESC"
  ).bind(catSpecies).all();
  var foods = candidates.results || [];

  // ── ② therapeutic だけで空になった場合は complete も含めてフォールバック ──
  if (onlyTherapeutic && foods.length === 0) {
    var fb = await db.prepare(
      "SELECT id, name, brand, category, purpose, kcal_per_100g, form, food_type, species "
        + "FROM foods WHERE active = 1 AND food_type IN ('complete', 'therapeutic') AND species = ? "
        + "ORDER BY kcal_per_100g DESC"
    ).bind(catSpecies).all();
    foods = fb.results || [];
    onlyTherapeutic = false;
  }

  var knownFoodNames = await detectKnownFoods(db, catId, foods);

  var wetFoods = [];
  var dryFoods = [];
  for (var fi = 0; fi < foods.length; fi++) {
    if (foods[fi].form === 'wet' || foods[fi].form === 'liquid') {
      if (foods[fi].purpose !== 'treat') wetFoods.push(foods[fi]);
    } else {
      dryFoods.push(foods[fi]);
    }
  }

  var suggestions = [];
  var remaining = deficit;

  // ── ③ catTag を「全プランの purpose 多数決」で決める ──
  var tagVotes = {};
  var planFoodIdList = [];
  for (var ip = 0; ip < currentPlans.length; ip++) {
    if (currentPlans[ip].food_id) planFoodIdList.push(currentPlans[ip].food_id);
  }
  if (planFoodIdList.length > 0) {
    var placeholders = planFoodIdList.map(function () { return '?'; }).join(',');
    var pStmt = db.prepare('SELECT id, purpose FROM foods WHERE id IN (' + placeholders + ')');
    var pRows = await pStmt.bind.apply(pStmt, planFoodIdList).all();
    var purposeByFood = {};
    var prs = (pRows && pRows.results) || [];
    for (var pi = 0; pi < prs.length; pi++) {
      purposeByFood[prs[pi].id] = prs[pi].purpose;
    }
    for (var ip2 = 0; ip2 < currentPlans.length; ip2++) {
      var fid = currentPlans[ip2].food_id;
      if (!fid) continue;
      var tag = normalizePurposeTag(purposeByFood[fid]);
      if (!tag || tag === 'general') continue;
      // amount_g 重みで票を加算（量の多いフード = 主食）
      var weight = currentPlans[ip2].amount_g || 1;
      tagVotes[tag] = (tagVotes[tag] || 0) + weight;
    }
  }

  // ── ④ internal_note からの補助タグも得票に加算 ──
  var noteInfo = extractNoteTags(catRow && catRow.internal_note);
  for (var ni = 0; ni < noteInfo.tags.length; ni++) {
    var nt = noteInfo.tags[ni];
    tagVotes[nt] = (tagVotes[nt] || 0) + 30; // 自由記述の明示タグは強め
  }

  // ── 最多得票タグを catTag とする（無ければ null） ──
  var catTag = null;
  var catTagVotes = 0;
  for (var tk in tagVotes) {
    if (tagVotes[tk] > catTagVotes) {
      catTag = tk;
      catTagVotes = tagVotes[tk];
    }
  }

  // 食欲ヒントがあれば高カロリー優先
  var preferHighKcal = !!noteInfo.preferHighKcal;

  var preferWet = context.prefer_wet;
  if (noteInfo.waterHint) preferWet = true;

  // preferWet でも wet 候補が無ければ dry も含める（療法食で wet が 0 件のケース）
  var primaryPool;
  if (preferWet && wetFoods.length > 0) {
    primaryPool = wetFoods;
  } else {
    primaryPool = wetFoods.concat(dryFoods);
  }
  var scored = [];
  for (var si = 0; si < primaryPool.length; si++) {
    var f = primaryPool[si];
    if (planFoodIds[f.id]) continue;
    var score = 0;
    var foodTag = normalizePurposeTag(f.purpose);

    if (catTag) {
      if (foodTag === catTag)                                           score += 10;
      // senior は特別扱い: kitten/diet 以外の病態とは両立しやすい
      else if (foodTag === 'senior' && catTag !== 'kitten' && catTag !== 'diet') score += 3;
      else if (foodTag === 'general')                                   score += 2;
      else                                                              score -= 5;
    } else {
      if (foodTag === 'general') score += 3;
    }

    // 療法食/総合栄養食の type で軽くボーナス
    if (onlyTherapeutic && f.food_type === 'therapeutic') score += 2;

    if (knownFoodNames[f.id]) score += 7;
    if (f.form === 'wet' && preferWet) score += 8;
    if (f.form === 'wet') score += 3;

    if (preferHighKcal && f.kcal_per_100g != null) {
      if (f.form === 'wet' && f.kcal_per_100g >= 90)   score += 4;
      if (f.form === 'dry' && f.kcal_per_100g >= 380)  score += 4;
    }

    scored.push({ food: f, score: score, food_tag: foodTag });
  }
  scored.sort(function (a, b) { return b.score - a.score; });

  for (var ri = 0; ri < scored.length && remaining > 5; ri++) {
    var pick = scored[ri].food;
    var kcalPer100 = pick.kcal_per_100g || 70;
    var neededG = Math.round(remaining / kcalPer100 * 100);
    var maxG = (pick.form === 'wet' || pick.form === 'liquid') ? 80 : 30;
    var sugG = Math.min(neededG, maxG);
    var sugKcal = Math.round(sugG * kcalPer100 / 100);

    suggestions.push({
      food_id: pick.id,
      food_name: pick.name,
      brand: pick.brand,
      form: pick.form,
      amount_g: sugG,
      kcal: sugKcal,
      reason: preferWet && pick.form === 'wet' ? String(context.reason || '').trim() || null : null,
    });
    remaining -= sugKcal;
  }

  return {
    deficit_kcal: Math.round(deficit),
    prefer_wet: preferWet,
    reason: context.reason,
    cat_tag: catTag,
    cat_tag_votes: tagVotes,
    only_therapeutic: onlyTherapeutic,
    prefer_high_kcal: preferHighKcal,
    items: suggestions,
    suggested_total_kcal: Math.round(deficit - remaining),
  };
}

async function detectKnownFoods(db, catId, allFoods) {
  var notes = await db.prepare(
    "SELECT note FROM cat_notes WHERE cat_id = ? AND category = 'feeding' AND note LIKE '前日残り%' ORDER BY created_at DESC LIMIT 30"
  ).bind(catId).all();
  var rows = notes.results || [];

  var matched = {};
  for (var i = 0; i < rows.length; i++) {
    var text = rows[i].note || '';
    for (var j = 0; j < allFoods.length; j++) {
      var f = allFoods[j];
      var nameShort = (f.name || '').replace(/[（()）\s]/g, '');
      if (text.indexOf(nameShort) !== -1 || (f.brand && text.indexOf(f.brand) !== -1)) {
        matched[f.id] = true;
      }
    }
  }
  return matched;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  プリセット CRUD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 表示・フィルタ用: nekomata 以外はすべて cafe（NULL・空・旧データ含む） */
function normalizeFeedingPresetLocation(locationId) {
  return locationId === 'nekomata' ? 'nekomata' : 'cafe';
}

/** 化け猫カフェ一覧用: 名前一文字が A–Z（半角）ならその文字、それ以外は other */
function feedingPresetAlphaBucketFromName(name) {
  var s = String(name || '').trim();
  if (!s) return 'other';
  var c = s.charAt(0);
  var cu = c.toUpperCase();
  if (cu >= 'A' && cu <= 'Z') return cu;
  return 'other';
}

function feedingPresetAlphaBucketLabel(bucket) {
  if (!bucket || bucket === 'other') return 'その他（和名・記号など）';
  return bucket;
}

function feedingPresetAlphaSortRank(bucket) {
  if (bucket && bucket >= 'A' && bucket <= 'Z') return bucket.charCodeAt(0);
  return 999;
}

/** レスポンス用: location 正規化 + cafe は A–Z／その他でソート */
function enrichFeedingPresetForResponse(p) {
  if (!p) return p;
  p.location_id = normalizeFeedingPresetLocation(p.location_id);
  if (p.location_id === 'cafe') {
    var b = feedingPresetAlphaBucketFromName(p.name);
    p.alpha_bucket = b;
    p.alpha_bucket_label = feedingPresetAlphaBucketLabel(b);
  } else {
    p.alpha_bucket = null;
    p.alpha_bucket_label = null;
  }
  return p;
}

/** D1 の last_row_id が bigint の場合があるため数値化（meta の形はランタイムで差がある） */
function d1LastInsertRowId(result) {
  if (!result) return NaN;
  var v = null;
  if (result.meta) {
    if (result.meta.last_row_id != null) v = result.meta.last_row_id;
    else if (result.meta.lastInsertRowid != null) v = result.meta.lastInsertRowid;
  }
  if (v == null && result.lastRowId != null) v = result.lastRowId;
  if (v == null) return NaN;
  if (typeof v === 'bigint') return Number(v);
  var n = Number(v);
  return isNaN(n) ? NaN : n;
}

/** run() の meta に last_row_id が無い環境向けに SQLite の last_insert_rowid() でフォールバック */
async function d1LastInsertIdOrFallback(db, runResult) {
  var id = d1LastInsertRowId(runResult);
  if (id > 0 && !isNaN(id)) return id;
  try {
    var row = await db.prepare('SELECT last_insert_rowid() AS lid').first();
    if (row && row.lid != null) {
      var n = typeof row.lid === 'bigint' ? Number(row.lid) : Number(row.lid);
      if (!isNaN(n) && n > 0) return n;
    }
  } catch (e) {
    console.error('d1LastInsertIdOrFallback', e && e.message);
  }
  return NaN;
}

/**
 * feeding_presets.created_by は staff(id) を参照する。
 * 認証ヘッダと DB が不整合のとき FK 違反になるため、staff に存在する id のみ入れる。
 */
async function resolveStaffIdForCreatedBy(db, staffAuth) {
  if (!staffAuth || staffAuth.staffId == null || staffAuth.staffId === '') return null;
  var sid = String(staffAuth.staffId).trim();
  if (!sid) return null;
  var row = await db.prepare('SELECT id FROM staff WHERE id = ? AND active = 1').bind(sid).first();
  return row ? sid : null;
}

function enrichAndSortFeedingPresets(presets) {
  for (var i = 0; i < presets.length; i++) {
    enrichFeedingPresetForResponse(presets[i]);
  }
  presets.sort(function (a, b) {
    var la = a.location_id;
    var lb = b.location_id;
    if (la !== lb) return la === 'cafe' ? -1 : 1;
    if (la === 'cafe') {
      var ra = feedingPresetAlphaSortRank(a.alpha_bucket);
      var rb = feedingPresetAlphaSortRank(b.alpha_bucket);
      if (ra !== rb) return ra - rb;
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
  return presets;
}

async function listPresets(db, url) {
  var species = url.searchParams.get('species') || '';
  var locationId = url.searchParams.get('location_id') || '';
  var sql = 'SELECT * FROM feeding_presets WHERE active = 1';
  var params = [];
  if (species) { sql += ' AND species = ?'; params.push(species); }
  if (locationId === 'nekomata') {
    sql += " AND LOWER(TRIM(COALESCE(location_id,''))) = 'nekomata'";
  } else if (locationId === 'cafe') {
    sql += " AND LOWER(TRIM(COALESCE(location_id,''))) != 'nekomata'";
  }
  var stmt = db.prepare(sql);
  if (params.length > 0) stmt = stmt.bind.apply(stmt, params);
  var result = await stmt.all();
  var presets = result.results || [];

  var presetToCat = {};
  try {
    var acats = await db.prepare(
      'SELECT id, name, assigned_preset_id FROM cats WHERE assigned_preset_id IS NOT NULL'
    ).all();
    var acRows = acats.results || [];
    for (var ac = 0; ac < acRows.length; ac++) {
      var cr = acRows[ac];
      if (cr.assigned_preset_id == null) continue;
      presetToCat[String(cr.assigned_preset_id)] = { id: cr.id, name: cr.name };
    }
  } catch (eMap) {
    console.warn('listPresets assigned_cat', eMap && eMap.message);
  }

  for (var i = 0; i < presets.length; i++) {
    var items = await db.prepare(
      'SELECT pi.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.preset_id = ? ORDER BY pi.sort_order, pi.meal_slot'
    ).bind(presets[i].id).all();
    presets[i].items = items.results || [];
    presets[i].assigned_cat = presetToCat[String(presets[i].id)] || null;
    var totalKcal = 0;
    for (var j = 0; j < presets[i].items.length; j++) {
      if (!isPresetMenuItemActive(presets[i].items[j])) continue;
      totalKcal += (presets[i].items[j].amount_g || 0) * (presets[i].items[j].kcal_per_100g || 0) / 100;
    }
    presets[i].total_kcal = Math.round(totalKcal);
  }
  enrichAndSortFeedingPresets(presets);
  return opsJson({ presets: presets });
}

async function getPreset(db, id) {
  var preset = await db.prepare('SELECT * FROM feeding_presets WHERE id = ? AND active = 1').bind(id).first();
  if (!preset) return opsJson({ error: 'not_found' }, 404);
  var items = await db.prepare(
    'SELECT pi.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.preset_id = ? ORDER BY pi.sort_order, pi.meal_slot'
  ).bind(id).all();
  preset.items = items.results || [];
  enrichFeedingPresetForResponse(preset);
  return opsJson({ preset: preset });
}

async function createPreset(db, req, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var rawName = body.name != null ? String(body.name) : '';
  var nameTrim = rawName.trim();
  if (!nameTrim) return opsJson({ error: 'missing_fields', message: 'name は必須です' }, 400);

  var presetLoc = body.location_id === 'nekomata' ? 'nekomata' : 'cafe';
  var descVal = body.description != null ? String(body.description).trim() : '';
  var createdBy = null;
  try {
    createdBy = await resolveStaffIdForCreatedBy(db, staffAuth);
  } catch (e) {
    console.error('createPreset resolveStaffIdForCreatedBy', e && e.message);
  }

  var insertSql =
    'INSERT INTO feeding_presets (name, description, species, life_stage, purpose, location_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)';
  var bindSpecies = body.species || 'cat';
  var bindDesc = descVal !== '' ? descVal : null;
  var bindLife = body.life_stage || null;
  var bindPurpose = body.purpose || null;

  var presetId = NaN;
  try {
    var insRet = await db.prepare(insertSql + ' RETURNING id').bind(
      nameTrim,
      bindDesc,
      bindSpecies,
      bindLife,
      bindPurpose,
      presetLoc,
      createdBy
    ).all();
    var rIns = insRet.results && insRet.results[0];
    if (rIns && rIns.id != null) {
      presetId = typeof rIns.id === 'bigint' ? Number(rIns.id) : Number(rIns.id);
    }
  } catch (eRet) {
    console.error('createPreset INSERT RETURNING', eRet && eRet.message);
  }

  var result;
  if (!presetId || isNaN(presetId) || presetId <= 0) {
    try {
      result = await db.prepare(insertSql).bind(
        nameTrim,
        bindDesc,
        bindSpecies,
        bindLife,
        bindPurpose,
        presetLoc,
        createdBy
      ).run();
    } catch (e) {
      console.error('createPreset INSERT', e && e.message);
      return opsJson({
        error: 'db_error',
        message: e && e.message ? e.message : 'プリセットの保存に失敗しました',
      }, 500);
    }

    if (result && result.success === false) {
      return opsJson({ error: 'db_error', message: 'プリセットの保存に失敗しました' }, 500);
    }

    presetId = await d1LastInsertIdOrFallback(db, result);
    if (!presetId || isNaN(presetId)) {
      return opsJson({ error: 'db_error', message: 'プリセットIDの取得に失敗しました' }, 500);
    }
  }

  var items = body.items || [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it.food_id || !it.meal_slot || !it.amount_g) continue;
    var menuAct = it.menu_active !== undefined && it.menu_active !== null && Number(it.menu_active) === 0 ? 0 : 1;
    try {
      await db.prepare(
        'INSERT INTO feeding_preset_items (preset_id, food_id, meal_slot, amount_g, scheduled_time, sort_order, notes, menu_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(presetId, it.food_id, it.meal_slot, it.amount_g, it.scheduled_time || null, it.sort_order || i, it.notes || null, menuAct).run();
    } catch (e) {
      console.error('createPreset preset_item', e && e.message);
      return opsJson({
        error: 'db_error',
        message: e && e.message ? e.message : 'プリセット項目の保存に失敗しました',
      }, 500);
    }
  }

  var preset = await db.prepare('SELECT * FROM feeding_presets WHERE id = ?').bind(presetId).first();
  if (!preset) {
    return opsJson({ error: 'db_error', message: '作成したプリセットを読み込めませんでした' }, 500);
  }
  var pItems = await db.prepare(
    'SELECT pi.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.preset_id = ? ORDER BY pi.sort_order'
  ).bind(presetId).all();
  preset.items = pItems.results || [];
  enrichFeedingPresetForResponse(preset);
  return opsJson({ preset: preset }, 201);
}

async function updatePreset(db, req, id) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var existing = await db.prepare('SELECT id FROM feeding_presets WHERE id = ? AND active = 1').bind(id).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);

  var sets = ["updated_at = datetime('now')"];
  var params = [];
  var fields = ['name', 'description', 'species', 'life_stage', 'purpose', 'location_id'];
  for (var f = 0; f < fields.length; f++) {
    if (body[fields[f]] !== undefined) {
      if (fields[f] === 'location_id') {
        var lv = body.location_id === 'nekomata' ? 'nekomata' : (body.location_id === 'cafe' ? 'cafe' : null);
        if (lv === null) continue;
        sets.push('location_id = ?'); params.push(lv);
      } else {
        sets.push(fields[f] + ' = ?'); params.push(body[fields[f]]);
      }
    }
  }
  params.push(id);
  await db.prepare('UPDATE feeding_presets SET ' + sets.join(', ') + ' WHERE id = ?').bind.apply(
    db.prepare('UPDATE feeding_presets SET ' + sets.join(', ') + ' WHERE id = ?'), params
  ).run();

  var preset = await db.prepare('SELECT * FROM feeding_presets WHERE id = ?').bind(id).first();
  enrichFeedingPresetForResponse(preset);
  return opsJson({ preset: preset });
}

async function deletePreset(db, id) {
  var existing = await db.prepare('SELECT id FROM feeding_presets WHERE id = ? AND active = 1').bind(id).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  await db.prepare("UPDATE feeding_presets SET active = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
  return opsJson({ deleted: true });
}

async function getPresetItems(db, presetId) {
  var items = await db.prepare(
    'SELECT pi.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.preset_id = ? ORDER BY pi.sort_order, pi.meal_slot'
  ).bind(presetId).all();
  return opsJson({ items: items.results || [] });
}

async function addPresetItem(db, req, presetId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  if (!body.food_id || !body.meal_slot || !body.amount_g) {
    return opsJson({ error: 'missing_fields', message: 'food_id, meal_slot, amount_g は必須です' }, 400);
  }
  var menuActAdd = body.menu_active !== undefined && body.menu_active !== null && Number(body.menu_active) === 0 ? 0 : 1;
  var itemSql =
    'INSERT INTO feeding_preset_items (preset_id, food_id, meal_slot, amount_g, scheduled_time, sort_order, notes, menu_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  var newItemId = NaN;
  try {
    var addRet = await db.prepare(itemSql + ' RETURNING id').bind(
      presetId,
      body.food_id,
      body.meal_slot,
      body.amount_g,
      body.scheduled_time || null,
      body.sort_order || 0,
      body.notes || null,
      menuActAdd
    ).all();
    var rAdd = addRet.results && addRet.results[0];
    if (rAdd && rAdd.id != null) {
      newItemId = typeof rAdd.id === 'bigint' ? Number(rAdd.id) : Number(rAdd.id);
    }
  } catch (eAdd) {
    console.error('addPresetItem RETURNING', eAdd && eAdd.message);
  }
  if (!newItemId || isNaN(newItemId) || newItemId <= 0) {
    try {
      var result = await db.prepare(itemSql).bind(
        presetId,
        body.food_id,
        body.meal_slot,
        body.amount_g,
        body.scheduled_time || null,
        body.sort_order || 0,
        body.notes || null,
        menuActAdd
      ).run();
      newItemId = await d1LastInsertIdOrFallback(db, result);
    } catch (eRun) {
      console.error('addPresetItem INSERT', eRun && eRun.message);
      return opsJson({
        error: 'db_error',
        message: eRun && eRun.message ? eRun.message : 'プリセット項目の保存に失敗しました',
      }, 500);
    }
  }
  if (!newItemId || isNaN(newItemId) || newItemId <= 0) {
    return opsJson({ error: 'db_error', message: 'プリセット項目IDの取得に失敗しました' }, 500);
  }
  var item = await db.prepare(
    'SELECT pi.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.id = ?'
  ).bind(newItemId).first();
  return opsJson({ item: item }, 201);
}

async function updatePresetItem(db, req, itemId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  var existing = await db.prepare('SELECT id FROM feeding_preset_items WHERE id = ?').bind(itemId).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);

  var sets = [];
  var params = [];
  var fields = ['food_id', 'meal_slot', 'amount_g', 'scheduled_time', 'sort_order', 'notes'];
  for (var f = 0; f < fields.length; f++) {
    if (body[fields[f]] !== undefined) { sets.push(fields[f] + ' = ?'); params.push(body[fields[f]]); }
  }
  if (body.menu_active !== undefined) {
    sets.push('menu_active = ?');
    params.push(Number(body.menu_active) === 0 ? 0 : 1);
  }
  if (sets.length === 0) return opsJson({ error: 'no_fields' }, 400);
  params.push(itemId);
  var sql = 'UPDATE feeding_preset_items SET ' + sets.join(', ') + ' WHERE id = ?';
  await db.prepare(sql).bind.apply(db.prepare(sql), params).run();

  var item = await db.prepare(
    'SELECT pi.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.id = ?'
  ).bind(itemId).first();
  return opsJson({ item: item });
}

async function deletePresetItem(db, itemId) {
  var existing = await db.prepare('SELECT id FROM feeding_preset_items WHERE id = ?').bind(itemId).first();
  if (!existing) return opsJson({ error: 'not_found' }, 404);
  await db.prepare('DELETE FROM feeding_preset_items WHERE id = ?').bind(itemId).run();
  return opsJson({ deleted: true });
}

async function applyPreset(db, req, staffAuth, presetId) {
  var body;
  try { body = await req.json(); } catch (_) { return opsJson({ error: 'invalid_json' }, 400); }
  if (!body.cat_id) return opsJson({ error: 'missing_fields', message: 'cat_id は必須です' }, 400);

  var preset = await db.prepare('SELECT * FROM feeding_presets WHERE id = ? AND active = 1').bind(presetId).first();
  if (!preset) return opsJson({ error: 'not_found', message: 'プリセットが見つかりません' }, 404);

  var singleItemId = body.preset_item_id != null && body.preset_item_id !== '' ? parseInt(body.preset_item_id, 10) : null;
  if (singleItemId != null && isNaN(singleItemId)) return opsJson({ error: 'invalid_fields', message: 'preset_item_id が不正です' }, 400);

  if (singleItemId == null) {
    var otherCat = await findOtherCatWithAssignedPreset(db, presetId, body.cat_id);
    if (otherCat) {
      return opsJson({ error: 'preset_conflict', message: 'プリセットがすでに割り当てられています' }, 409);
    }
    var rep = await replaceCatFeedingPlansFromActivePreset(db, body.cat_id, presetId, { setAssigned: true });
    if (!rep.ok) {
      if (rep.reason === 'no_active_items') {
        return opsJson({ error: 'empty_preset', message: '有効なメニューがありません' }, 400);
      }
      if (rep.reason === 'too_many_items') {
        return opsJson({ error: 'limit_reached', message: '有効メニューが1匹あたりの上限（' + MAX_PLANS_PER_CAT + '件）を超えています' }, 400);
      }
      return opsJson({ error: 'not_found', message: 'プリセットが見つかりません' }, 404);
    }
    var plansRes = await db.prepare(
      "SELECT fp.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.cat_id = ? AND fp.active = 1 AND fp.plan_type = 'preset' AND fp.preset_id = ? ORDER BY fp.meal_slot"
    ).bind(body.cat_id, presetId).all();
    return opsJson({ applied: plansRes.results || [], preset_name: preset.name, single_item: false }, 201);
  }

  var catRow = await db.prepare('SELECT assigned_preset_id FROM cats WHERE id = ?').bind(body.cat_id).first();
  var assignedPid = catRow && catRow.assigned_preset_id != null && catRow.assigned_preset_id !== ''
    ? Number(catRow.assigned_preset_id)
    : null;
  if (assignedPid !== Number(presetId)) {
    return opsJson({
      error: 'preset_mismatch',
      message: '1品追加は、この猫に紐づいたプリセットからのみ可能です',
    }, 400);
  }

  var oneRow = await db.prepare(
    'SELECT pi.*, f.kcal_per_100g FROM feeding_preset_items pi JOIN foods f ON pi.food_id = f.id WHERE pi.preset_id = ? AND pi.id = ?'
  ).bind(presetId, singleItemId).first();
  if (!oneRow) {
    return opsJson({ error: 'not_found', message: '指定した品はこのプリセットにありません' }, 404);
  }
  if (!isPresetMenuItemActive(oneRow)) {
    return opsJson({ error: 'menu_inactive', message: 'このメニュー行は無効のため献立に追加できません' }, 400);
  }

  var countRow = await db.prepare('SELECT COUNT(*) AS cnt FROM feeding_plans WHERE cat_id = ? AND active = 1').bind(body.cat_id).first();
  var currentCount = countRow ? countRow.cnt : 0;
  if (currentCount + 1 > MAX_PLANS_PER_CAT) {
    return opsJson({ error: 'limit_reached', message: '適用すると上限' + MAX_PLANS_PER_CAT + '件を超えます（現在' + currentCount + '件 + 追加1件）' }, 400);
  }

  var pi = oneRow;
  var kcal = pi.amount_g * pi.kcal_per_100g / 100;
  var result = await db.prepare(
    "INSERT INTO feeding_plans (cat_id, food_id, meal_slot, amount_g, kcal_calc, notes, active, plan_type, preset_id, scheduled_time, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'preset', ?, ?, datetime('now'))"
  ).bind(body.cat_id, pi.food_id, pi.meal_slot, pi.amount_g, kcal, pi.notes || null, presetId, pi.scheduled_time || null).run();
  var plan = await db.prepare(
    'SELECT fp.*, f.name AS food_name, f.brand, f.kcal_per_100g FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.id = ?'
  ).bind(result.meta.last_row_id).first();
  var created = plan ? [plan] : [];
  return opsJson({ applied: created, preset_name: preset.name, single_item: true }, 201);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ワンクリック「あげた」
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function quickFed(db, req, staffAuth, planId) {
  var plan = await db.prepare(
    'SELECT fp.*, f.kcal_per_100g FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.id = ? AND fp.active = 1'
  ).bind(planId).first();
  if (!plan) return opsJson({ error: 'not_found', message: 'プランが見つかりません' }, 404);

  var body = {};
  try { body = await req.json(); } catch (_) {}

  var logDate = body.log_date || jstYmdString();
  var servedTime = resolveServedTimeForLogBody(body);
  var offeredG = plan.amount_g;
  if (body.offered_g !== undefined && body.offered_g !== null && String(body.offered_g).trim() !== '') {
    var og = Number(body.offered_g);
    if (!isNaN(og) && og > 0) offeredG = og;
  }
  if (offeredG == null || isNaN(Number(offeredG)) || Number(offeredG) <= 0) {
    return opsJson({ error: 'invalid_fields', message: '提供量(g)がプランにありません。量を入力してください。' }, 400);
  }
  offeredG = Number(offeredG);

  /** 摂取率: 明示指定 > 残りg から算出 > 未指定は 0%（あげた直後・まだ食べていない） */
  var eatenPct = null;
  if (body.eaten_pct !== undefined && body.eaten_pct !== null && String(body.eaten_pct).trim() !== '') {
    var ep = Number(body.eaten_pct);
    if (!isNaN(ep)) {
      eatenPct = Math.max(0, Math.min(100, Math.round(ep)));
    }
  } else if (body.leftover_g !== undefined && body.leftover_g !== null && String(body.leftover_g).trim() !== '') {
    var leftG = Number(body.leftover_g);
    if (isNaN(leftG) || leftG < 0) {
      return opsJson({ error: 'invalid_fields', message: '残り量(g)は0以上の数値にしてください' }, 400);
    }
    if (leftG > offeredG) {
      return opsJson({ error: 'invalid_fields', message: '残り量が提供量を超えています' }, 400);
    }
    eatenPct = leftG <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((offeredG - leftG) / offeredG * 100)));
  }
  if (eatenPct == null || isNaN(eatenPct)) {
    eatenPct = 0;
  }

  var eatenG = Math.round(offeredG * eatenPct / 100 * 10) / 10;
  var eatenKcal = plan.kcal_per_100g ? Math.round(eatenG * plan.kcal_per_100g / 100) : null;

  var result = await db.prepare(
    "INSERT INTO feeding_logs (cat_id, log_date, meal_slot, food_id, offered_g, eaten_pct, eaten_g, eaten_kcal, plan_id, meal_order, served_time, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).bind(
    plan.cat_id, logDate, plan.meal_slot, plan.food_id,
    offeredG, eatenPct, eatenG, eatenKcal,
    planId, plan.meal_order || null, servedTime,
    staffAuth.staffId
  ).run();

  var log = await db.prepare(
    'SELECT fl.*, f.name AS food_name FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id WHERE fl.id = ?'
  ).bind(result.meta.last_row_id).first();
  return opsJson({ log: log, message: 'あげました！' }, 201);
}
