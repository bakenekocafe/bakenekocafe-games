/**
 * 掲示板・注意事項の「表示名」マスター（選別・仕様確認用）
 *
 * 注意事項ラベルは nyagi-app/js/bulletin.js の NOTE_CATEGORY_LABEL_JA と揃える。
 * 健康記録の「掲示板に出る9種」は health.js の scope=clinic と同一。
 */

var NOTE_CATEGORY_ORDER = [
  'general',
  'health',
  'behavior',
  'feeding',
  'medication',
  'task',
  'warning',
  'nutrition',
];

var NOTE_CATEGORY_LABEL_JA = {
  general: '一般',
  health: '健康',
  behavior: '行動',
  feeding: '食事',
  medication: '投薬',
  task: 'タスク関連',
  warning: '警告',
  nutrition: '栄養',
};

/** 掲示板の病院タイムラインに出る record_type（health.js scope=clinic と一致） */
var HEALTH_BULLETIN_ORDER = [
  'vaccine',
  'checkup',
  'surgery',
  'dental',
  'emergency',
  'test',
  'observation',
  'medication_start',
  'medication_end',
];

var HEALTH_BULLETIN_LABEL_JA = {
  vaccine: 'ワクチン',
  checkup: '健康診断',
  surgery: '手術',
  dental: '歯科',
  emergency: '緊急',
  test: '検査',
  observation: '経過観察',
  medication_start: '投薬開始',
  medication_end: '投薬終了',
};

/** 掲示板では出さない record_type（猫詳細・日報・TSV 等で使用） */
var HEALTH_NOT_ON_BULLETIN_ORDER = [
  'weight',
  'care',
  'eye_discharge',
  'stool',
  'urine',
  'urination',
  'medication',
  'medication_evening',
  'vomiting',
  'feeding_morning',
  'feeding_evening',
  'feeding_prev_evening',
  'stool_midday',
  'churu_water',
  'cough',
  'sneeze',
  'handover_morning',
  'handover_evening',
  'daily_report',
  'dental_care',
];

var HEALTH_NOT_ON_BULLETIN_LABEL_JA = {
  weight: '体重',
  care: 'ケア',
  eye_discharge: '目ヤニ',
  stool: '排便',
  urine: '排尿',
  urination: '排尿',
  medication: '投薬（記録）',
  medication_evening: '投薬（夜）',
  vomiting: '嘔吐',
  feeding_morning: '給餌（朝）',
  feeding_evening: '給餌（夜）',
  feeding_prev_evening: '給餌（前夜）',
  stool_midday: '排便（日中）',
  churu_water: 'ちゅる・水分',
  cough: '咳',
  sneeze: 'くしゃみ',
  handover_morning: '申し送り（朝）',
  handover_evening: '申し送り（夜）',
  daily_report: '日報',
  dental_care: '歯磨き（ケア）',
};

/** ケア記録の care_type（details）。掲示板では care 行自体を返さないため参照用。 */
var CARE_DETAIL_TYPES = [
  { id: 'brush', label: 'ブラシ', record_type: 'care' },
  { id: 'chin', label: 'アゴ', record_type: 'care' },
  { id: 'ear', label: '耳', record_type: 'care' },
  { id: 'nail', label: '爪切り', record_type: 'care' },
  { id: 'paw', label: '肉球', record_type: 'care' },
  { id: 'butt', label: 'お尻', record_type: 'care' },
  { id: 'eye', label: '目ヤニ拭き', record_type: 'eye_discharge' },
];

function mapOrderToRows(order, labelMap) {
  var out = [];
  for (var i = 0; i < order.length; i++) {
    var id = order[i];
    out.push({ id: id, label: labelMap[id] || id });
  }
  return out;
}

/**
 * @returns {{
 *   note_categories: Array<{id:string,label:string}>,
 *   health_record_types_bulletin: Array<{id:string,label:string}>,
 *   health_record_types_not_on_bulletin: Array<{id:string,label:string}>,
 *   care_detail_types: Array<{id:string,label:string,record_type:string}>
 * }}
 */
export function buildDisplayCatalogPayload() {
  var noteCategories = [];
  for (var ni = 0; ni < NOTE_CATEGORY_ORDER.length; ni++) {
    var nid = NOTE_CATEGORY_ORDER[ni];
    noteCategories.push({ id: nid, label: NOTE_CATEGORY_LABEL_JA[nid] || nid });
  }

  return {
    note_categories: noteCategories,
    health_record_types_bulletin: mapOrderToRows(HEALTH_BULLETIN_ORDER, HEALTH_BULLETIN_LABEL_JA),
    health_record_types_not_on_bulletin: mapOrderToRows(HEALTH_NOT_ON_BULLETIN_ORDER, HEALTH_NOT_ON_BULLETIN_LABEL_JA),
    care_detail_types: CARE_DETAIL_TYPES.slice(),
  };
}
