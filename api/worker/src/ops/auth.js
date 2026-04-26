/**
 * NYAGI 認証・権限ミドルウェア
 *
 * MVP: ADMIN_KEY ヘッダー認証 + staff テーブル照合
 * ログイン: 4桁パスワード → staff 検索 → staffId 返却
 */

/**
 * 4桁パスワードでログイン。X-Admin-Key 必須。
 * POST /api/ops/auth/login { password: "3374" }
 * @returns {{ staffId, name, role, locationId } | null}
 */
export async function loginByPassword(req, env) {
  if (req.method !== 'POST') return null;

  var expected = (env.ADMIN_KEY || '').trim();
  if (!expected) return null;

  var provided = (req.headers.get('X-Admin-Key') || '').trim();
  if (!provided || provided !== expected) return null;

  var body;
  try { body = await req.json(); } catch (_) { return null; }
  var password = (body.password || '').trim();
  if (!password) return null;

  var hash = await sha256Hex('nyagi:' + password);
  var row = await env.OPS_DB.prepare(
    'SELECT id, name, role, location_id, permissions FROM staff WHERE password_hash = ? AND active = 1'
  ).bind(hash).first();

  if (!row) return null;

  return { staffId: row.id, name: row.name, role: row.role, locationId: row.location_id, permissions: safeParsePermissions(row.permissions) };
}

async function sha256Hex(str) {
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/**
 * X-Admin-Key ヘッダーを検証し、staff レコードを返す。
 * 失敗時は null を返す（呼び出し側で 401 を返す）。
 *
 * @param {Request} req
 * @param {{ ADMIN_KEY: string, OPS_DB: D1Database }} env
 * @returns {Promise<{ staffId: string, locationId: string, role: string } | null>}
 */
export async function authenticateStaff(req, env) {
  var expected = (env.ADMIN_KEY || '').trim();
  if (!expected) return null;

  var provided = (req.headers.get('X-Admin-Key') || '').trim();
  if (!provided || provided !== expected) return null;

  var staffId = (req.headers.get('X-Staff-Id') || '').trim();
  if (!staffId) return null;

  var row = await env.OPS_DB.prepare(
    'SELECT id, name, role, location_id, permissions FROM staff WHERE id = ? AND active = 1'
  ).bind(staffId).first();

  if (!row) return null;

  return {
    staffId: row.id,
    name: row.name,
    role: row.role,
    locationId: row.location_id,
    permissions: safeParsePermissions(row.permissions),
  };
}

function safeParsePermissions(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { var arr = JSON.parse(val); return Array.isArray(arr) ? arr : []; } catch (_) { return []; }
}

/**
 * 権限チェック。owner は全権限を持つ。
 */
export function hasPermission(staffAuth, requiredPermission) {
  if (!staffAuth) return false;
  if (staffAuth.role === 'owner') return true;
  if (staffAuth.permissions.indexOf(requiredPermission) !== -1) return true;
  return false;
}
