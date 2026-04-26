/**
 * NYAGI 製品名辞書 自動登録ヘルパー
 *
 * food / medicine が DB に登録・更新された時、
 * product_name_dictionary に正式名＋バリアント（ブランド省略形等）を自動追加する。
 */

/**
 * @param {D1Database} db
 * @param {string} productId   - food_xxx / med_xxx
 * @param {string} productType - 'food' | 'medicine'
 * @param {string} name        - 正式名称
 * @param {string} [brand]     - ブランド名（food 用）
 */
export async function syncProductDict(db, productId, productType, name, brand) {
  if (!name) return;

  var variants = buildVariants(name, brand, productType);

  for (var i = 0; i < variants.length; i++) {
    var v = variants[i];
    try {
      await db.prepare(
        'INSERT OR IGNORE INTO product_name_dictionary (product_id, product_type, variant, variant_type, priority) VALUES (?, ?, ?, ?, ?)'
      ).bind(productId, productType, v.variant, v.type, v.priority).run();
    } catch (_) { /* ignore duplicates */ }
  }
}

function buildVariants(name, brand, productType) {
  var results = [];
  results.push({ variant: name, type: 'official', priority: 100 });

  var parts = name.split(/\s+/);

  if (parts.length > 1) {
    results.push({ variant: parts[0], type: 'alias', priority: 80 });

    if (parts.length >= 3) {
      results.push({ variant: parts.slice(0, 2).join(' '), type: 'alias', priority: 85 });
    }
  }

  if (brand) {
    var brandClean = brand.replace(/\(.*?\)/g, '').trim();
    if (brandClean && brandClean !== name && name.indexOf(brandClean) === -1) {
      results.push({ variant: brandClean + ' ' + parts[0], type: 'alias', priority: 75 });
    }
  }

  var noSpace = name.replace(/\s+/g, '');
  if (noSpace !== name) {
    results.push({ variant: noSpace, type: 'alias', priority: 90 });
  }

  return results;
}

/**
 * 名前変更時に古い辞書エントリを削除して再登録
 */
export async function resyncProductDict(db, productId, productType, newName, brand) {
  await db
    .prepare(
      'DELETE FROM product_name_dictionary WHERE product_id = ? AND product_type = ? AND variant_type IN (?, ?)'
    )
    .bind(productId, productType, 'official', 'alias')
    .run();

  await syncProductDict(db, productId, productType, newName, brand);
}
