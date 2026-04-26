/**
 * 給餌プリセットの表示用 name / description を組み立てる（一覧・詳細で共通）
 * - cats.assigned_preset_id
 * - feeding_plans.preset_id（適用のみで紐づけ未設定の場合のフォールバック）
 * - feeding_presets.description + feeding_preset_items.notes（全体メモが空でもフード行メモを束ねる）
 */

export function collectPresetIdsOrdered(assignedPresetId, planRows) {
  var idsOrder = [];
  var seen = {};
  function add(id) {
    if (id == null || id === '') return;
    var s = String(id);
    if (seen[s]) return;
    seen[s] = true;
    idsOrder.push(s);
  }
  add(assignedPresetId);
  for (var i = 0; i < (planRows || []).length; i++) {
    add(planRows[i].preset_id);
  }
  return idsOrder;
}

export function resolvePresetDisplayNameDescription(idsOrder, presetById, itemNotesAgg) {
  if (!idsOrder || idsOrder.length === 0) return { name: null, description: null };
  var nameParts = [];
  var descParts = [];
  for (var j = 0; j < idsOrder.length; j++) {
    var idStr = idsOrder[j];
    var info = presetById[idStr];
    if (info && info.name && nameParts.indexOf(info.name) === -1) nameParts.push(info.name);
    var chunkParts = [];
    if (info && info.description && String(info.description).trim()) {
      chunkParts.push(String(info.description).trim());
    }
    var inotes = itemNotesAgg[idStr];
    if (inotes && String(inotes).trim()) chunkParts.push(String(inotes).trim());
    if (chunkParts.length) descParts.push(chunkParts.join('\n\n'));
  }
  return {
    name: nameParts.length ? nameParts.join(' / ') : null,
    description: descParts.length ? descParts.join('\n---\n') : null
  };
}

export async function fetchPresetDisplayMaps(db, presetIdList) {
  var presetById = {};
  var itemNotesAgg = {};
  if (!presetIdList || presetIdList.length === 0) {
    return { presetById: presetById, itemNotesAgg: itemNotesAgg, itemNotesByPlanKey: {} };
  }
  var pin = presetIdList.map(function () { return '?'; }).join(',');
  var pst = db.prepare('SELECT id, name, description FROM feeding_presets WHERE id IN (' + pin + ')');
  pst = pst.bind.apply(pst, presetIdList);
  var pRes = await pst.all();
  var pRows = pRes.results || [];
  for (var pri = 0; pri < pRows.length; pri++) {
    var prow = pRows[pri];
    presetById[String(prow.id)] = { name: prow.name, description: prow.description };
  }
  /** 献立行（feeding_plans）と突き合わせる meal_slot（dashboard の normMealSlotForOverview と同一） */
  function normSlotForPresetItemKey(s) {
    if (s == null || s === '') return '';
    var x = String(s).toLowerCase().trim();
    if (x === '朝' || x === 'morning' || x === 'am') return 'morning';
    if (x === '昼' || x === 'afternoon' || x === 'noon' || x === 'lunch') return 'afternoon';
    if (x === '夜' || x === 'evening' || x === 'night' || x === 'pm' || x === '夕' || x === 'dinner') return 'evening';
    return x;
  }

  var pit = db.prepare(
    'SELECT preset_id, food_id, meal_slot, notes FROM feeding_preset_items WHERE preset_id IN (' + pin + ") AND notes IS NOT NULL AND TRIM(notes) != ''"
  );
  pit = pit.bind.apply(pit, presetIdList);
  var itRes = await pit.all();
  var itRows = itRes.results || [];
  var byP = {};
  /** key: presetId|foodId|normMealSlot → フード行メモ（猫一覧の献立行にそのまま付与） */
  var itemNotesByPlanKey = {};
  for (var ii = 0; ii < itRows.length; ii++) {
    var ir = itRows[ii];
    var pid = String(ir.preset_id);
    var nt = String(ir.notes || '').trim();
    if (!nt) continue;
    if (!byP[pid]) byP[pid] = [];
    if (byP[pid].indexOf(nt) === -1) byP[pid].push(nt);
    var fk = pid + '|' + String(ir.food_id) + '|' + normSlotForPresetItemKey(ir.meal_slot);
    if (!itemNotesByPlanKey[fk]) itemNotesByPlanKey[fk] = nt;
    else if (itemNotesByPlanKey[fk].indexOf(nt) === -1) itemNotesByPlanKey[fk] = itemNotesByPlanKey[fk] + '\n' + nt;
  }
  for (var pk in byP) {
    if (!Object.prototype.hasOwnProperty.call(byP, pk)) continue;
    itemNotesAgg[pk] = byP[pk].join('\n');
  }
  return { presetById: presetById, itemNotesAgg: itemNotesAgg, itemNotesByPlanKey: itemNotesByPlanKey };
}
