/**
 * 猫ステータスの共通定義。
 *
 * status は在籍ライフサイクルだけを表す:
 *   in_care  — 在籍（ケア中・カフェ常駐含む）
 *   adopted  — 卒業
 *   trial    — トライアル中
 *   deceased — 死亡
 *
 * 拠点は location_id（cafe / nekomata / endo / azukari）で管理。
 * 緊急度は alert_level（normal / watch / critical）で管理。
 *
 * 旧値 'cafe', 'active', 'watch', 'critical' は status に使わない。
 * DB マイグレで in_care に統合済みの前提。
 */

/** 在籍猫（日常業務の対象）に該当する status 値 */
export var STATUS_IN_CARE = "'in_care'";

/** SQL WHERE 断片: 在籍猫（日常業務全般） */
export function sqlStatusInCare(alias) {
  var col = alias ? alias + '.status' : 'status';
  return col + " = 'in_care'";
}

/** 一覧フィルタ用 SQL WHERE 断片 */
export function sqlStatusCondition(statusFilter, alias) {
  var col = alias ? alias + '.status' : 'status';
  if (statusFilter === 'active' || statusFilter === 'in_care') return col + " = 'in_care'";
  if (statusFilter === 'trial') return col + " = 'trial'";
  if (statusFilter === 'adopted') return col + " = 'adopted'";
  if (statusFilter === 'all') return col + " IN ('in_care', 'adopted', 'trial', 'deceased')";
  return col + " = 'in_care'";
}
