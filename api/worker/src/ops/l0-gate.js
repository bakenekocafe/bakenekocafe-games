/**
 * NYAGI L0 ゲート — プリルーティング
 *
 * テキスト中のキーワード + 猫の alert_level を元に
 * どの処理層(L1〜L5)へ送るかをコードのみで決定する。LLM は呼ばない。
 *
 * 出血は重症度で分離:
 *   大量出血/止血不能 → L5, 軽度出血(血便/血尿) → L1_blood (L2で重症度判定)
 */

var CRITICAL_EMERGENCY_WORDS = [
  '大量出血', '血が止まらない', '血を吐', '大量の血',
  '痙攣', 'けいれん', '意識ない', '呼吸おかしい', '骨折',
];

var BLOOD_WORDS = [
  '血便', '血尿', '出血',
];

var ANOMALY_WORDS = [
  '吐いた', '嘔吐', '下痢', '軟便', '食べない', '食欲ない',
  '元気ない', 'ぐったり', '体重減', '目やに', '鼻水', '脱毛', '血', '膿',
  '脱走',
];

var CONSULT_WORDS = [
  '相談', '詳しく', 'どうすれば', '心配', '気になる',
];

var SEVERITY_AMPLIFIERS = ['大量', '止まらない', 'ひどい', '激しい'];

function hasAny(text, words) {
  for (var i = 0; i < words.length; i++) {
    if (text.indexOf(words[i]) !== -1) return true;
  }
  return false;
}

function isSummaryMessage(text) {
  if (text.length < 150) return false;
  var hasStar = text.indexOf('⭐') !== -1;
  var hasSummaryWord = text.indexOf('まとめ') !== -1 || text.indexOf('前半') !== -1;
  var hasSectionMark = text.indexOf('【継続事項】') !== -1 || text.indexOf('【その他】') !== -1;
  return hasStar && (hasSummaryWord || hasSectionMark);
}

/**
 * @param {string} rawText
 * @param {{ alert_level?: string }|null} catRecord
 * @param {boolean} isExplicitConsult
 * @returns {string}
 */
export function preRoute(rawText, catRecord, isExplicitConsult) {
  if (isExplicitConsult) return 'L5';

  if (isSummaryMessage(rawText)) return 'L1_summary';

  if (catRecord && catRecord.alert_level === 'critical') return 'L5';

  var hasCritical = hasAny(rawText, CRITICAL_EMERGENCY_WORDS);
  var hasBlood = hasAny(rawText, BLOOD_WORDS);
  var hasAmplifier = hasAny(rawText, SEVERITY_AMPLIFIERS);

  if (catRecord && catRecord.alert_level === 'watch') {
    if (hasCritical) return 'L5';
    if (hasBlood && hasAmplifier) return 'L5';
    if (hasBlood) return 'L4';
    if (hasAny(rawText, ANOMALY_WORDS)) return 'L4';
    return 'L3';
  }

  if (hasCritical) return 'L5';
  if (hasBlood && hasAmplifier) return 'L5';
  if (hasBlood) return 'L1_blood';
  if (hasAny(rawText, ANOMALY_WORDS)) return 'L1_with_anomaly_flag';

  return 'L1';
}
