/**
 * 引き受け申請: 外部ユーザー向け API（スタッフ認証不要）
 *
 * POST /api/ops/intake-public/verify-token
 * POST /api/ops/intake-public/setup
 * POST /api/ops/intake-public/login
 * POST /api/ops/intake-public/logout
 * GET  /api/ops/intake-public/me
 * PUT  /api/ops/intake-public/me
 * GET  /api/ops/intake-public/locations  — 受入拠点一覧（認証不要）
 */

import { opsJson } from './router.js';
import { handleIntakeApplicantRoutes } from './intake-public-apps.js';

var SESSION_HOURS = 24;
var PASSWORD_MIN_LEN = 8;
var LOGIN_MAX_ATTEMPTS = 5;
var LOGIN_LOCK_MINUTES = 15;

async function sha256Hex(str) {
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map(function (b) {
      return b.toString(16).padStart(2, '0');
    })
    .join('');
}

function hashIntakePassword(password) {
  return sha256Hex('intake:' + password);
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return '***';
  var at = email.indexOf('@');
  if (at < 1) return '***';
  var local = email.slice(0, at);
  var domain = email.slice(at + 1);
  var hint = local.length <= 1 ? local.charAt(0) + '***' : local.slice(0, 2) + '***';
  return hint + '@' + domain;
}

function normalizePath(subPath) {
  var p = (subPath || '').replace(/^\/+|\/+$/g, '');
  return p;
}

function parseBearer(req) {
  var h = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  var m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1].trim() : '';
}

async function getApplicantBySessionTokenOnly(db, sessionToken) {
  if (!sessionToken) return null;
  var row = await db
    .prepare(
      "SELECT id, email, name, password_hash, phone, address, organization, phase, terms_agreed_at, created_at, updated_at " +
        "FROM intake_applicants WHERE session_token = ? AND session_expires IS NOT NULL AND session_expires > datetime('now')"
    )
    .bind(sessionToken)
    .first();
  return row || null;
}

/** 申請 API 用: 通常セッション or スタッフ発行のプレビュートークン */
async function resolveApplicantForIntakeApps(db, token) {
  if (!token) return null;
  var row = await getApplicantBySessionTokenOnly(db, token);
  if (row) return { applicant: row, readOnly: false };
  row = await db
    .prepare(
      "SELECT id, email, name, password_hash, phone, address, organization, phase, terms_agreed_at, created_at, updated_at " +
        "FROM intake_applicants WHERE preview_token = ? AND preview_expires IS NOT NULL AND preview_expires > datetime('now')"
    )
    .bind(token)
    .first();
  if (row) return { applicant: row, readOnly: true };
  return null;
}

function applicantPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    address: row.address,
    organization: row.organization,
    phase: row.phase,
    terms_agreed_at: row.terms_agreed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function issueSession(db, applicantId) {
  var sessionTok = crypto.randomUUID();
  var mod = '+' + String(SESSION_HOURS) + ' hours';
  await db
    .prepare(
      "UPDATE intake_applicants SET session_token = ?, session_expires = datetime('now', ?), updated_at = datetime('now') WHERE id = ?"
    )
    .bind(sessionTok, mod, applicantId)
    .run();
  return sessionTok;
}

async function clearSession(db, applicantId) {
  await db
    .prepare(
      "UPDATE intake_applicants SET session_token = NULL, session_expires = NULL, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(applicantId)
    .run();
}

async function handleVerifyToken(req, db) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed', message: 'POST only' }, 405);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  var token = (body && body.token && String(body.token).trim()) || '';
  if (!token) return opsJson({ error: 'bad_request', message: 'token required' }, 400);

  var row = await db
    .prepare(
      'SELECT id, email, token_expires, password_hash, phase FROM intake_applicants WHERE token = ? AND token IS NOT NULL'
    )
    .bind(token)
    .first();

  if (!row) {
    return opsJson({ error: 'not_found', message: 'Invalid or expired token' }, 404);
  }

  if (row.token_expires) {
    var cmpV = await db
      .prepare("SELECT CASE WHEN datetime(?) > datetime('now') THEN 1 ELSE 0 END AS ok")
      .bind(row.token_expires)
      .first();
    if (!cmpV || !cmpV.ok) {
      return opsJson({ error: 'gone', message: 'Invitation expired' }, 410);
    }
  }

  if (row.password_hash) {
    return opsJson({
      ok: true,
      already_registered: true,
      email_hint: maskEmail(row.email),
      phase: row.phase,
    });
  }

  return opsJson({
    ok: true,
    already_registered: false,
    email_hint: maskEmail(row.email),
    token_expires: row.token_expires,
  });
}

async function handleSetup(req, db) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed', message: 'POST only' }, 405);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  var token = (body && body.token && String(body.token).trim()) || '';
  var password = (body && body.password && String(body.password)) || '';
  var name = (body && body.name != null && String(body.name).trim()) || '';
  var phone = body && body.phone != null ? String(body.phone).trim() || null : null;
  var address = body && body.address != null ? String(body.address).trim() || null : null;
  var organization = body && body.organization != null ? String(body.organization).trim() || null : null;
  var agree = body && body.agree_terms === true;

  if (!token) return opsJson({ error: 'bad_request', message: 'token required' }, 400);
  if (password.length < PASSWORD_MIN_LEN) {
    return opsJson({ error: 'bad_request', message: 'パスワードは8文字以上にしてください' }, 400);
  }
  if (!name) return opsJson({ error: 'bad_request', message: 'name required' }, 400);
  if (!agree) return opsJson({ error: 'bad_request', message: '利用規約への同意が必要です' }, 400);

  var row = await db
    .prepare(
      'SELECT id, email, token_expires, password_hash FROM intake_applicants WHERE token = ? AND token IS NOT NULL'
    )
    .bind(token)
    .first();

  if (!row) {
    return opsJson({ error: 'not_found', message: 'Invalid or expired token' }, 404);
  }

  if (row.token_expires) {
    var cmp2 = await db
      .prepare("SELECT CASE WHEN datetime(?) > datetime('now') THEN 1 ELSE 0 END AS ok")
      .bind(row.token_expires)
      .first();
    if (!cmp2 || !cmp2.ok) {
      return opsJson({ error: 'gone', message: 'Invitation expired' }, 410);
    }
  }

  if (row.password_hash) {
    return opsJson({ error: 'conflict', message: '既に登録済みです。ログインしてください。' }, 409);
  }

  var pwdHash = await hashIntakePassword(password);
  var termsAt = new Date().toISOString();

  await db
    .prepare(
      "UPDATE intake_applicants SET password_hash = ?, name = ?, phone = ?, address = ?, organization = ?, " +
        "token = NULL, token_expires = NULL, terms_agreed_at = ?, phase = 'active', updated_at = datetime('now') " +
        "WHERE id = ?"
    )
    .bind(pwdHash, name, phone, address, organization, termsAt, row.id)
    .run();

  var sessionTok = await issueSession(db, row.id);

  return opsJson({
    ok: true,
    session_token: sessionTok,
    expires_in_hours: SESSION_HOURS,
    applicant: applicantPublic(
      await db
        .prepare(
          'SELECT id, email, name, phone, address, organization, phase, terms_agreed_at, created_at, updated_at FROM intake_applicants WHERE id = ?'
        )
        .bind(row.id)
        .first()
    ),
  });
}

async function handleLogin(req, db) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed', message: 'POST only' }, 405);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  var email = (body && body.email && String(body.email).trim().toLowerCase()) || '';
  var password = (body && body.password && String(body.password)) || '';

  if (!email || !password) {
    return opsJson({ error: 'bad_request', message: 'email and password required' }, 400);
  }

  var row = await db
    .prepare(
      'SELECT id, email, name, password_hash, phone, address, organization, phase, terms_agreed_at, ' +
        'login_attempts, locked_until, created_at, updated_at ' +
        'FROM intake_applicants WHERE email = ?'
    )
    .bind(email)
    .first();

  if (!row || !row.password_hash) {
    return opsJson({ error: 'unauthorized', message: 'メールまたはパスワードが正しくありません' }, 401);
  }

  if (row.locked_until) {
    var lockCheck = await db
      .prepare("SELECT CASE WHEN datetime(?) > datetime('now') THEN 1 ELSE 0 END AS locked")
      .bind(row.locked_until)
      .first();
    if (lockCheck && lockCheck.locked) {
      return opsJson({
        error: 'too_many_requests',
        message: 'ログイン試行回数が上限に達しました。' + LOGIN_LOCK_MINUTES + '分後にお試しください。',
      }, 429);
    }
    await db
      .prepare("UPDATE intake_applicants SET login_attempts = 0, locked_until = NULL WHERE id = ?")
      .bind(row.id)
      .run();
    row.login_attempts = 0;
  }

  var pwdHash = await hashIntakePassword(password);
  if (pwdHash !== row.password_hash) {
    var attempts = (row.login_attempts || 0) + 1;
    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      var lockMod = '+' + String(LOGIN_LOCK_MINUTES) + ' minutes';
      await db
        .prepare("UPDATE intake_applicants SET login_attempts = ?, locked_until = datetime('now', ?) WHERE id = ?")
        .bind(attempts, lockMod, row.id)
        .run();
      return opsJson({
        error: 'too_many_requests',
        message: 'ログイン試行回数が上限（' + LOGIN_MAX_ATTEMPTS + '回）に達しました。' + LOGIN_LOCK_MINUTES + '分後にお試しください。',
      }, 429);
    }
    await db
      .prepare("UPDATE intake_applicants SET login_attempts = ? WHERE id = ?")
      .bind(attempts, row.id)
      .run();
    return opsJson({ error: 'unauthorized', message: 'メールまたはパスワードが正しくありません' }, 401);
  }

  if (row.login_attempts > 0) {
    await db
      .prepare("UPDATE intake_applicants SET login_attempts = 0, locked_until = NULL WHERE id = ?")
      .bind(row.id)
      .run();
  }

  var sessionTok = await issueSession(db, row.id);

  return opsJson({
    ok: true,
    session_token: sessionTok,
    expires_in_hours: SESSION_HOURS,
    applicant: applicantPublic(row),
  });
}

async function handleLogout(req, db) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed', message: 'POST only' }, 405);
  var tok = parseBearer(req);
  if (!tok) return opsJson({ error: 'unauthorized', message: 'Bearer token required' }, 401);

  var app = await getApplicantBySessionTokenOnly(db, tok);
  if (!app) return opsJson({ error: 'unauthorized', message: 'Invalid session' }, 401);

  await clearSession(db, app.id);
  return opsJson({ ok: true });
}

async function handleMeGet(req, db) {
  if (req.method !== 'GET') return opsJson({ error: 'method_not_allowed', message: 'GET only' }, 405);
  var tok = parseBearer(req);
  if (!tok) return opsJson({ error: 'unauthorized', message: 'Bearer token required' }, 401);

  var app = await getApplicantBySessionTokenOnly(db, tok);
  if (!app) return opsJson({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);

  return opsJson({ ok: true, applicant: applicantPublic(app) });
}

async function handleMePut(req, db) {
  if (req.method !== 'PUT') return opsJson({ error: 'method_not_allowed', message: 'PUT only' }, 405);
  var tok = parseBearer(req);
  if (!tok) return opsJson({ error: 'unauthorized', message: 'Bearer token required' }, 401);

  var app = await getApplicantBySessionTokenOnly(db, tok);
  if (!app) return opsJson({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);

  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  var newName = body.name !== undefined ? String(body.name).trim() : app.name;
  var newPhone = body.phone !== undefined ? String(body.phone).trim() || null : app.phone;
  var newAddress = body.address !== undefined ? String(body.address).trim() || null : app.address;
  var newOrg =
    body.organization !== undefined ? String(body.organization).trim() || null : app.organization;

  if (newName === '') {
    return opsJson({ error: 'bad_request', message: 'name cannot be empty' }, 400);
  }

  var hasChange =
    body.name !== undefined || body.phone !== undefined || body.address !== undefined || body.organization !== undefined;
  if (!hasChange) {
    return opsJson({ error: 'bad_request', message: 'no updatable fields' }, 400);
  }

  await db
    .prepare(
      "UPDATE intake_applicants SET name = ?, phone = ?, address = ?, organization = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(newName, newPhone, newAddress, newOrg, app.id)
    .run();

  var row = await db
    .prepare(
      "SELECT id, email, name, phone, address, organization, phase, terms_agreed_at, created_at, updated_at " +
        "FROM intake_applicants WHERE id = ?"
    )
    .bind(app.id)
    .first();

  return opsJson({ ok: true, applicant: applicantPublic(row) });
}

async function handleIntakeLocationsGet(db) {
  var res = await db
    .prepare(
      "SELECT id, name FROM locations WHERE active = 1 AND id IN ('cafe', 'nekomata', 'endo', 'azukari', 'both') " +
        "ORDER BY CASE id WHEN 'cafe' THEN 1 WHEN 'nekomata' THEN 2 WHEN 'endo' THEN 3 WHEN 'azukari' THEN 4 WHEN 'both' THEN 5 ELSE 6 END"
    )
    .all();
  return opsJson({ ok: true, locations: res.results || [] });
}

/**
 * @param {Request} req
 * @param {object} env
 * @param {URL} url
 * @param {string} subPath e.g. "/verify-token" or "/me"
 * @returns {Promise<Response>}
 */
export async function handleIntakePublic(req, env, url, subPath) {
  var db = env.OPS_DB;
  if (!db) {
    return opsJson({ error: 'service_unavailable', message: 'Database not configured' }, 503);
  }

  var path = normalizePath(subPath);
  var method = req.method;

  try {
    if (path === 'verify-token' && method === 'POST') {
      return await handleVerifyToken(req, db);
    }
    if (path === 'setup' && method === 'POST') {
      return await handleSetup(req, db);
    }
    if (path === 'login' && method === 'POST') {
      return await handleLogin(req, db);
    }
    if (path === 'logout' && method === 'POST') {
      return await handleLogout(req, db);
    }
    if (path === 'me' && method === 'GET') {
      return await handleMeGet(req, db);
    }
    if (path === 'me' && method === 'PUT') {
      return await handleMePut(req, db);
    }
    if (path === 'locations' && method === 'GET') {
      return await handleIntakeLocationsGet(db);
    }

    if (path === 'applications' || path.indexOf('applications/') === 0) {
      var sessTok2 = parseBearer(req);
      var resolved = await resolveApplicantForIntakeApps(db, sessTok2);
      if (!resolved) {
        return opsJson({ error: 'unauthorized', message: 'Invalid or expired session' }, 401);
      }
      if (resolved.readOnly && method !== 'GET') {
        return opsJson({ error: 'forbidden', message: 'プレビューは閲覧のみです' }, 403);
      }
      return await handleIntakeApplicantRoutes(req, env, db, resolved.applicant, path, method);
    }

    return opsJson({ error: 'not_found', message: 'Unknown intake-public endpoint' }, 404);
  } catch (e) {
    console.error('intake-public error:', path, e && e.message, e && e.stack);
    if (env.ENV === 'dev' || env.PSEUDO_VERIFY_MODE === 'true') {
      return opsJson({ error: 'internal', message: 'Internal error', debug: e && e.message }, 500);
    }
    return opsJson({ error: 'internal', message: 'Internal error' }, 500);
  }
}
