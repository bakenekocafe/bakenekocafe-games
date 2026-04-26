/**
 * NYAGI スタッフ管理
 *
 * GET  /api/ops/staff        → 一覧 + 拠点一覧
 * POST /api/ops/staff        → 新規登録（admin 必須）
 * PUT  /api/ops/staff/:id    → 更新（active 停止/開始、管理者権限）
 */

import { opsJson } from './router.js';
import { hasPermission } from './auth.js';

async function sha256Hex(str) {
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

export async function handleStaff(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  // PUT /staff/:id
  var idMatch = subPath.match(/^\/([^/]+)\/?$/);
  if (method === 'PUT' && idMatch) {
    if (!hasPermission(staffAuth, 'admin')) {
      return opsJson({ error: 'forbidden', message: 'admin 権限が必要です' }, 403);
    }
    var staffId = decodeURIComponent(idMatch[1]);
    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }
    var existing = await db.prepare('SELECT * FROM staff WHERE id = ?').bind(staffId).first();
    if (!existing) return opsJson({ error: 'not_found', message: 'スタッフが見つかりません' }, 404);

    var active = body.active !== undefined ? (body.active ? 1 : 0) : existing.active;
    var permissions = body.permissions !== undefined ? (Array.isArray(body.permissions) ? JSON.stringify(body.permissions) : body.permissions) : existing.permissions;
    var locationId = body.location_id !== undefined ? body.location_id : existing.location_id;
    var name = body.name !== undefined ? body.name : existing.name;
    var role = body.role !== undefined ? body.role : existing.role;

    var passwordHash = existing.password_hash;
    if (body.password && body.password.trim()) {
      passwordHash = await sha256Hex('nyagi:' + body.password.trim());
    }

    await db.prepare(
      "UPDATE staff SET name = ?, role = ?, location_id = ?, permissions = ?, active = ?, password_hash = ? WHERE id = ?"
    ).bind(name, role, locationId || null, permissions, active, passwordHash || null, staffId).run();

    var row = await db.prepare('SELECT id, name, role, location_id, active, created_at FROM staff WHERE id = ?').bind(staffId).first();
    return opsJson({ staff: row });
  }

  if (method === 'GET' && (subPath === '' || subPath === '/')) {
    var staffRows = await db.prepare(
      'SELECT id, name, role, location_id, permissions, active, created_at FROM staff ORDER BY created_at DESC'
    ).all();
    var locRows = await db.prepare(
      "SELECT id, name FROM locations WHERE active = 1 AND id IN ('cafe', 'nekomata', 'endo', 'azukari', 'both') ORDER BY CASE id WHEN 'cafe' THEN 1 WHEN 'nekomata' THEN 2 WHEN 'endo' THEN 3 WHEN 'azukari' THEN 4 WHEN 'both' THEN 5 ELSE 6 END"
    ).all();
    return opsJson({
      staff: staffRows.results || [],
      locations: locRows.results || [],
    });
  }

  if (method === 'POST' && (subPath === '' || subPath === '/')) {
    if (!hasPermission(staffAuth, 'admin')) {
      return opsJson({ error: 'forbidden', message: 'admin 権限が必要です' }, 403);
    }

    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
    }

    var id = (body.id || body.staff_id || '').trim();
    var name = (body.name || '').trim();
    var password = (body.password || '').trim();
    if (!id || !name) {
      return opsJson({ error: 'bad_request', message: 'id と name は必須です' }, 400);
    }
    if (!password || password.length !== 4 || !/^\d{4}$/.test(password)) {
      return opsJson({ error: 'bad_request', message: '4桁の数字パスワードを入力してください' }, 400);
    }

    var existing = await db.prepare('SELECT id FROM staff WHERE id = ?').bind(id).first();
    if (existing) {
      return opsJson({ error: 'conflict', message: 'この Staff ID は既に登録されています' }, 409);
    }

    var hash = await sha256Hex('nyagi:' + password);
    var role = body.role || 'part_time';
    var locationId = body.location_id || staffAuth.locationId || null;
    var permissions = body.permissions;
    if (body.admin) {
      permissions = JSON.stringify(['admin']);
    } else if (Array.isArray(permissions)) {
      permissions = JSON.stringify(permissions);
    } else if (typeof permissions === 'string') {
      try { JSON.parse(permissions); } catch (_) { permissions = '[]'; }
    } else {
      permissions = '[]';
    }

    await db.prepare(
      'INSERT INTO staff (id, name, role, location_id, permissions, active, password_hash) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).bind(id, name, role, locationId, permissions, hash).run();

    var row = await db.prepare('SELECT id, name, role, location_id, active, created_at FROM staff WHERE id = ?').bind(id).first();
    return opsJson({ staff: row }, 201);
  }

  return opsJson({ error: 'method_not_allowed' }, 405);
}
