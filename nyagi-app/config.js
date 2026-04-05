/**
 * NYAGI 共通設定（Admin Key はここで設定、ユーザー入力不要）
 * 本番では wrangler.toml の ADMIN_KEY と一致する値に変更すること
 */
/** デプロイ後にコンソール等で「最新を読んでいるか」確認するための識別子（必要に応じて更新） */
window.NYAGI_BUILD_ID = '20250404-close-day-slim';

window.NYAGI_ADMIN_KEY = "dev-admin-key-change-in-production";

window.NYAGI_API_ORIGIN = (function () {
  var h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') {
    return 'http://' + h + ':8787';
  }
  if (h.indexOf('192.168.') === 0 || h.indexOf('10.') === 0) {
    return location.protocol + '//' + h + ':' + location.port;
  }
  return 'https://api.bakenekocafe.studio';
})();
