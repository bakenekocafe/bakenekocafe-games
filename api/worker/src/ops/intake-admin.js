/**
 * 引き受け申請: スタッフ向け API（X-Admin-Key + X-Staff-Id）
 */

import { opsJson } from './router.js';
import { computeCatCompletion } from './intake-public-apps.js';
import { sendSlackMessage } from './slack-notify.js';

var MODULE_CAT_PHOTO = 'intake_app_cat_photo';
var MODULE_CAT_DOC = 'intake_app_cat_doc';
var MODULE_INTAKE_RECORD_FILE = 'cat_intake_record';

function normSub(p) {
  return (p || '').replace(/^\/+|\/+$/g, '');
}

function randomTokenHex(byteLen) {
  var arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  var s = '';
  for (var i = 0; i < arr.length; i++) {
    s += arr[i].toString(16).padStart(2, '0');
  }
  return s;
}

function intakeOneLine(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function intakeAlertChannel(env) {
  var e = env || {};
  return (
    (e.SLACK_ALERT_CHANNEL && String(e.SLACK_ALERT_CHANNEL).trim()) ||
    (e.INQUIRY_SLACK_CHANNEL && String(e.INQUIRY_SLACK_CHANNEL).trim()) ||
    ''
  );
}

function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** E2/E3: handleInvite の setup ベースと同じ導線でマイページ（login）URL */
function intakeMypageUrlFromEnv(env) {
  var b =
    (env.INTAKE_SETUP_URL_BASE && String(env.INTAKE_SETUP_URL_BASE).replace(/\/$/, '')) ||
    'https://nyagi.bakenekocafe.studio/intake/setup.html';
  if (/setup\.html$/i.test(b)) {
    return b.replace(/setup\.html$/i, 'login.html');
  }
  if (!/\/intake\/?$/i.test(b) && /\/intake\//i.test(b) && !/\.html$/i.test(b)) {
    return b + '/login.html';
  }
  if (!/\.html$/i.test(b)) {
    return b + '/intake/login.html';
  }
  return b.replace(/\/[^/]+\.html$/i, '/login.html');
}

/** E1/E2/E3: 失敗しても本処理に影響しない */
async function postIntakeResendEmail(env, to, subject, html) {
  var key = env.RESEND_API_KEY;
  var from = (env.RESEND_FROM && String(env.RESEND_FROM).trim()) || 'noreply@bakenekocafe.studio';
  if (!key) {
    console.warn('[intake-admin] RESEND_API_KEY not set — skip email to', to);
    return;
  }
  if (!to) return;
  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: [to], subject: subject, html: html }),
    });
    if (!res.ok) {
      var txt = await res.text();
      console.warn('[intake-admin] Resend error', res.status, txt);
    }
  } catch (e) {
    console.warn('[intake-admin] Resend fetch error:', e && e.message);
  }
}

/** E4: intake イベントの Slack 通知（チャンネル空・トークン未設定はスキップ。API 成否に影響しない） */
async function postIntakeSlack(env, text) {
  var ch = intakeAlertChannel(env);
  if (!ch) return;
  try {
    await sendSlackMessage(env, ch, text);
  } catch (err) {
    console.warn('[intake-admin] postIntakeSlack failed:', err && err.message);
  }
}

async function countCatPhotosAdmin(db, catId) {
  var r = await db
    .prepare(
      "SELECT COUNT(1) AS c FROM files WHERE module = ? AND ref_id = ? AND r2_key IS NOT NULL AND r2_key != ''"
    )
    .bind(MODULE_CAT_PHOTO, String(catId))
    .first();
  return r && r.c ? Number(r.c) : 0;
}

async function handleDashboard(db) {
  var phases = await db.prepare('SELECT phase, COUNT(1) AS c FROM intake_applicants GROUP BY phase').all();
  var statuses = await db.prepare('SELECT status, COUNT(1) AS c FROM intake_applications GROUP BY status').all();
  return opsJson({
    ok: true,
    applicants_by_phase: phases.results || [],
    applications_by_status: statuses.results || [],
  });
}

async function handleInvite(req, db, staffAuth, env) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed' }, 405);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request' }, 400);
  }
  var email = (body && body.email && String(body.email).trim().toLowerCase()) || '';
  if (!email || email.indexOf('@') < 1) {
    return opsJson({ error: 'bad_request', message: 'valid email required' }, 400);
  }
  var dispName = body && body.name != null ? String(body.name).trim() : '';
  var existing = await db.prepare('SELECT id FROM intake_applicants WHERE email = ?').bind(email).first();
  if (existing) {
    return opsJson({ error: 'conflict', message: 'このメールアドレスは既に登録されています' }, 409);
  }
  var id = crypto.randomUUID();
  var token = randomTokenHex(24);
  var expRow = await db.prepare("SELECT datetime('now', '+7 days') AS e").first();
  var tokenExpires = expRow && expRow.e ? expRow.e : null;
  await db
    .prepare(
      "INSERT INTO intake_applicants (id, email, name, token, token_expires, phase, created_by) VALUES (?, ?, ?, ?, ?, 'invited', ?)"
    )
    .bind(id, email, dispName || '', token, tokenExpires, staffAuth.staffId)
    .run();
  var base =
    (env.INTAKE_SETUP_URL_BASE && String(env.INTAKE_SETUP_URL_BASE).replace(/\/$/, '')) ||
    'https://nyagi.bakenekocafe.studio/intake/setup.html';
  var setupUrl = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
  var expDisplay = tokenExpires ? String(tokenExpires) : '';
  var subjInvite = '【NYAGI】アカウント設定のご案内';
  var htmlInvite =
    '<p>お世話になっております。NYAGI から招待が届いています。</p>' +
    '<p>下記のリンクから初回登録（パスワード設定）をお願いします:<br><a href="' +
    htmlEsc(setupUrl) +
    '">' +
    htmlEsc(setupUrl) +
    '</a></p>' +
    (expDisplay ? '<p>有効期限: ' + htmlEsc(expDisplay) + '</p>' : '') +
    '<p>ご不明点は BAKENEKO CAFE までお問い合わせください。</p>';
  await postIntakeSlack(
    env,
    '🆕 [intake] 新規招待: ' +
      intakeOneLine(dispName || '（無名）') +
      ' <' +
      email +
      '> / app_id=' +
      id
  );
  await postIntakeResendEmail(env, email, subjInvite, htmlInvite);
  return opsJson(
    {
      ok: true,
      applicant_id: id,
      email: email,
      token: token,
      token_expires: tokenExpires,
      setup_url: setupUrl,
    },
    201
  );
}

async function handleListApplicants(db, url) {
  var phase = url.searchParams.get('phase');
  var q = 'SELECT id, email, name, phone, phase, created_at, updated_at FROM intake_applicants';
  var res;
  if (phase) {
    res = await db.prepare(q + ' WHERE phase = ? ORDER BY updated_at DESC').bind(phase).all();
  } else {
    res = await db.prepare(q + ' ORDER BY updated_at DESC LIMIT 200').all();
  }
  return opsJson({ ok: true, applicants: res.results || [] });
}

async function handleGetApplicant(db, applicantId) {
  var row = await db.prepare('SELECT * FROM intake_applicants WHERE id = ?').bind(applicantId).first();
  if (!row) return opsJson({ error: 'not_found' }, 404);
  delete row.password_hash;
  delete row.token;
  delete row.session_token;
  var apps = await db
    .prepare('SELECT * FROM intake_applications WHERE applicant_id = ? ORDER BY id DESC')
    .bind(applicantId)
    .all();
  return opsJson({ ok: true, applicant: row, applications: apps.results || [] });
}

async function buildAdminApplicationDetail(db, appId) {
  var app = await db.prepare('SELECT * FROM intake_applications WHERE id = ?').bind(appId).first();
  if (!app) return null;
  var applicant = await db.prepare('SELECT * FROM intake_applicants WHERE id = ?').bind(app.applicant_id).first();
  if (applicant) {
    delete applicant.password_hash;
    delete applicant.token;
    delete applicant.session_token;
  }
  var catsRes = await db
    .prepare('SELECT * FROM intake_application_cats WHERE application_id = ? ORDER BY id ASC')
    .bind(appId)
    .all();
  var cats = catsRes.results || [];
  var catsOut = [];
  for (var i = 0; i < cats.length; i++) {
    var pc = await countCatPhotosAdmin(db, cats[i].id);
    catsOut.push({ cat: cats[i], completion: computeCatCompletion(cats[i], pc) });
  }
  var msgs = await db
    .prepare('SELECT * FROM intake_application_messages WHERE application_id = ? ORDER BY id ASC')
    .bind(appId)
    .all();
  return { application: app, applicant: applicant, cats: catsOut, messages: msgs.results || [] };
}

async function handleApplicantFile(env, db, applicantId, fileId) {
  var row = await db
    .prepare(
      'SELECT f.r2_key, f.original_name, f.mime_type ' +
        'FROM files f ' +
        'JOIN intake_application_cats ac ON ac.id = CAST(f.ref_id AS INTEGER) ' +
        'JOIN intake_applications a ON a.id = ac.application_id ' +
        'WHERE f.id = ? AND a.applicant_id = ? AND f.module IN (?, ?) AND f.r2_key IS NOT NULL'
    )
    .bind(fileId, applicantId, MODULE_CAT_PHOTO, MODULE_CAT_DOC)
    .first();
  if (!row || !row.r2_key) return opsJson({ error: 'not_found' }, 404);

  var r2 = env.NYAGI_FILES;
  if (!r2) return opsJson({ error: 'unavailable' }, 503);
  var obj = await r2.get(row.r2_key);
  if (!obj) return opsJson({ error: 'not_found' }, 404);

  var headers = new Headers();
  headers.set('Content-Type', row.mime_type || 'application/octet-stream');
  headers.set('Content-Disposition', 'inline; filename="' + (row.original_name || 'file') + '"');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers: headers });
}

async function enrichApplicationsListWithCompletion(db, rows) {
  if (!rows || !rows.length) return rows;
  var ids = [];
  for (var i = 0; i < rows.length; i++) ids.push(rows[i].id);
  var ph = ids.map(function () {
    return '?';
  }).join(',');
  var catsRes = await db
    .prepare(
      'SELECT * FROM intake_application_cats WHERE application_id IN (' +
        ph +
        ') ORDER BY application_id ASC, id ASC'
    )
    .bind.apply(null, ids)
    .all();
  var catsList = catsRes.results || [];
  var byApp = {};
  var catIdStrs = [];
  for (var j = 0; j < catsList.length; j++) {
    var c = catsList[j];
    var aid = c.application_id;
    if (!byApp[aid]) byApp[aid] = [];
    byApp[aid].push(c);
    catIdStrs.push(String(c.id));
  }
  var photoMap = {};
  if (catIdStrs.length) {
    var ph2 = catIdStrs.map(function () {
      return '?';
    }).join(',');
    var photoRes = await db
      .prepare(
        "SELECT ref_id, COUNT(1) AS c FROM files WHERE module = ? AND r2_key IS NOT NULL AND r2_key != '' AND ref_id IN (" +
          ph2 +
          ') GROUP BY ref_id'
      )
      .bind.apply(
        null,
        [MODULE_CAT_PHOTO].concat(catIdStrs)
      )
      .all();
    var pr = photoRes.results || [];
    for (var p = 0; p < pr.length; p++) {
      photoMap[String(pr[p].ref_id)] = Number(pr[p].c) || 0;
    }
  }
  for (var k = 0; k < rows.length; k++) {
    var a = rows[k];
    var cats = byApp[a.id] || [];
    var pct = 0;
    if (cats.length) {
      var sum = 0;
      for (var t = 0; t < cats.length; t++) {
        var pc = photoMap[String(cats[t].id)] || 0;
        var comp = computeCatCompletion(cats[t], pc);
        sum += comp.pct;
      }
      pct = Math.round(sum / cats.length);
    }
    rows[k].completion_pct = pct;
  }
  return rows;
}

async function handleListApplications(db) {
  var res = await db
    .prepare(
      'SELECT a.*, ap.email AS applicant_email, ap.name AS applicant_name, ap.phase AS applicant_phase ' +
        'FROM intake_applications a JOIN intake_applicants ap ON ap.id = a.applicant_id ORDER BY a.updated_at DESC LIMIT 200'
    )
    .all();
  var list = res.results || [];
  await enrichApplicationsListWithCompletion(db, list);
  return opsJson({ ok: true, applications: list });
}

async function handleGetApplication(db, appId) {
  var detail = await buildAdminApplicationDetail(db, appId);
  if (!detail) return opsJson({ error: 'not_found' }, 404);
  return opsJson({ ok: true, detail: detail });
}

async function handleStaffMessage(req, db, appId, staffAuth, env) {
  if (req.method !== 'POST') return opsJson({ error: 'method_not_allowed' }, 405);
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request' }, 400);
  }
  var text = body && body.body != null ? String(body.body).trim() : '';
  if (!text) return opsJson({ error: 'bad_request', message: 'body required' }, 400);
  var app = await db.prepare('SELECT id FROM intake_applications WHERE id = ?').bind(appId).first();
  if (!app) return opsJson({ error: 'not_found' }, 404);
  var row = await db
    .prepare(
      "INSERT INTO intake_application_messages (application_id, sender_type, sender_id, body) VALUES (?, 'staff', ?, ?) RETURNING id, created_at"
    )
    .bind(appId, staffAuth.staffId, text)
    .first();
  var apInfo = await db
    .prepare(
      'SELECT ap.name, ap.email FROM intake_applications a JOIN intake_applicants ap ON ap.id = a.applicant_id WHERE a.id = ?'
    )
    .bind(appId)
    .first();
  var stName = (apInfo && apInfo.name) || '';
  var myE3 = intakeMypageUrlFromEnv(env);
  var subjE3 = '【NYAGI】スタッフからメッセージが届いています';
  var htmlE3 =
    '<p>スタッフからメッセージがあります。</p><p>ログインして確認してください: <a href="' +
    htmlEsc(myE3) +
    '">' +
    htmlEsc(myE3) +
    '</a></p>';
  await postIntakeSlack(
    env,
    '💬 [intake] スタッフ送信: ' +
      intakeOneLine(stName || '（不明）') +
      ' / app_id=' +
      appId +
      ' by staff=' +
      String(staffAuth.staffId)
  );
  await postIntakeResendEmail(env, apInfo && apInfo.email, subjE3, htmlE3);
  return opsJson({ ok: true, message: row }, 201);
}

async function handleReview(db, appId, staffAuth) {
  var app = await db.prepare('SELECT id, status FROM intake_applications WHERE id = ?').bind(appId).first();
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (app.status !== 'submitted' && app.status !== 'info_requested') {
    return opsJson({ error: 'bad_request', message: 'Invalid status for review' }, 400);
  }
  await db
    .prepare(
      "UPDATE intake_applications SET status = 'under_review', reviewed_by = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(staffAuth.staffId, appId)
    .run();
  return opsJson({ ok: true });
}

async function handleRequestInfo(req, db, appId, staffAuth) {
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request' }, 400);
  }
  var text = body && body.body != null ? String(body.body).trim() : '';
  if (!text) return opsJson({ error: 'bad_request', message: 'body required' }, 400);
  var app = await db.prepare('SELECT id FROM intake_applications WHERE id = ?').bind(appId).first();
  if (!app) return opsJson({ error: 'not_found' }, 404);
  await db
    .prepare(
      "UPDATE intake_applications SET status = 'info_requested', reviewed_by = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(staffAuth.staffId, appId)
    .run();
  await db
    .prepare(
      "INSERT INTO intake_application_messages (application_id, sender_type, sender_id, body) VALUES (?, 'staff', ?, ?)"
    )
    .bind(appId, staffAuth.staffId, text)
    .run();
  var apRow = await db
    .prepare('SELECT applicant_id FROM intake_applications WHERE id = ?')
    .bind(appId)
    .first();
  if (apRow) {
    await db
      .prepare("UPDATE intake_applicants SET phase = 'info_requested', updated_at = datetime('now') WHERE id = ?")
      .bind(apRow.applicant_id)
      .run();
  }
  return opsJson({ ok: true });
}

async function handleReject(req, db, appId, staffAuth, env) {
  var body;
  try {
    body = await req.json();
  } catch (_) {
    return opsJson({ error: 'bad_request' }, 400);
  }
  var reason = body && body.reason != null ? String(body.reason).trim() : '';
  if (!reason) return opsJson({ error: 'bad_request', message: 'reason required' }, 400);
  var app = await db.prepare('SELECT applicant_id FROM intake_applications WHERE id = ?').bind(appId).first();
  if (!app) return opsJson({ error: 'not_found' }, 404);
  var rejAt = new Date().toISOString();
  await db
    .prepare(
      "UPDATE intake_applications SET status = 'rejected', rejection_reason = ?, rejected_at = ?, reviewed_by = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(reason, rejAt, staffAuth.staffId, appId)
    .run();
  await db
    .prepare("UPDATE intake_applicants SET phase = 'rejected', updated_at = datetime('now') WHERE id = ?")
    .bind(app.applicant_id)
    .run();
  var apNameRow = await db.prepare('SELECT name, email FROM intake_applicants WHERE id = ?').bind(app.applicant_id).first();
  var rejName = (apNameRow && apNameRow.name) || '';
  var myRej = intakeMypageUrlFromEnv(env);
  var subjRej = '【NYAGI】お申込み内容についてのご連絡';
  var htmlRej =
    '<p>この度はお申し込みいただき、ありがとうございました。</p><p>慎重に審査した結果、今回のお申し込みについてはお願いできかねる状況でした。</p>' +
    (reason
      ? '<p>補足: ' + htmlEsc(intakeOneLine(reason)) + '</p>'
      : '<p>詳細はマイページをご確認ください: <a href="' +
        htmlEsc(myRej) +
        '">' +
        htmlEsc(myRej) +
        '</a></p>');
  await postIntakeSlack(
    env,
    '❌ [intake] 却下: ' +
      intakeOneLine(rejName || '（不明）') +
      ' / app_id=' +
      appId +
      ' 理由=' +
      intakeOneLine(reason || 'なし')
  );
  await postIntakeResendEmail(env, apNameRow && apNameRow.email, subjRej, htmlRej);
  return opsJson({ ok: true, rejected_at: rejAt });
}

function buildIntakeNoteJson(appCat, applicant, application) {
  return JSON.stringify({
    source: 'intake_application',
    application_id: application.id,
    intake_application_cat_id: appCat.id,
    applicant: {
      name: applicant.name,
      email: applicant.email,
      address: applicant.address,
    },
    legal_snapshot: {
      breed: appCat.breed,
      estimated_birth_date: appCat.estimated_birth_date,
      microchip_id: appCat.microchip_id,
      source_type: appCat.source_type,
      breeder_known: appCat.breeder_known,
      ownership_start_date: appCat.ownership_start_date,
    },
    story: appCat.story,
    rescue: {
      date: appCat.rescue_date,
      location: appCat.rescue_location,
      situation: appCat.rescue_situation,
    },
  });
}

async function handleApprove(req, db, appId, staffAuth, env) {
  var app = await db.prepare('SELECT * FROM intake_applications WHERE id = ?').bind(appId).first();
  if (!app) return opsJson({ error: 'not_found' }, 404);
  if (app.status === 'approved') {
    return opsJson({ error: 'bad_request', message: 'Already approved' }, 400);
  }
  if (app.status !== 'submitted' && app.status !== 'under_review' && app.status !== 'info_requested') {
    return opsJson({ error: 'bad_request', message: 'Cannot approve from this status' }, 400);
  }
  var applicant = await db.prepare('SELECT * FROM intake_applicants WHERE id = ?').bind(app.applicant_id).first();
  if (!applicant) return opsJson({ error: 'server_error' }, 500);

  var catsRes = await db.prepare('SELECT * FROM intake_application_cats WHERE application_id = ?').bind(appId).all();
  var cats = catsRes.results || [];
  if (cats.length === 0) return opsJson({ error: 'bad_request', message: 'No cats' }, 400);

  var locId = app.location_id || staffAuth.locationId || 'cafe';
  var createdIds = [];

  for (var i = 0; i < cats.length; i++) {
    var ac = cats[i];
    if (ac.cat_id) {
      createdIds.push(ac.cat_id);
      continue;
    }
    var newId = crypto.randomUUID();
    var displayName = ac.name && String(ac.name).trim() ? String(ac.name).trim() : '未命名';
    var descParts = [];
    if (ac.color_markings) descParts.push(String(ac.color_markings));
    if (ac.personality) descParts.push(String(ac.personality));
    var intakeSummary = '';
    if (ac.story) intakeSummary = String(ac.story).slice(0, 500);
    else if (ac.rescue_situation) intakeSummary = String(ac.rescue_situation).slice(0, 500);

    await db
      .prepare(
        'INSERT INTO cats (id, name, photo_url, birth_date, sex, neutered, microchip_id, location_id, status, description, intake_info, species) ' +
          "VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'in_care', ?, ?, 'cat')"
      )
      .bind(
        newId,
        displayName,
        ac.estimated_birth_date || null,
        ac.sex || null,
        ac.neutered ? 1 : 0,
        ac.microchip_id || null,
        locId,
        descParts.length ? descParts.join(' / ') : null,
        intakeSummary || null
      )
      .run();

    var noteJson = buildIntakeNoteJson(ac, applicant, app);
    var recRow = await db
      .prepare(
        'INSERT INTO cat_intake_records (cat_id, note, created_by) VALUES (?, ?, ?) RETURNING id'
      )
      .bind(newId, noteJson, staffAuth.staffId)
      .first();
    if (!recRow) return opsJson({ error: 'server_error', message: 'intake record' }, 500);
    var recId = String(recRow.id);

    await db
      .prepare(
        "UPDATE files SET module = ?, ref_id = ? WHERE module IN (?, ?) AND ref_id = ?"
      )
      .bind(MODULE_INTAKE_RECORD_FILE, recId, MODULE_CAT_PHOTO, MODULE_CAT_DOC, String(ac.id))
      .run();

    await db
      .prepare("UPDATE intake_application_cats SET cat_id = ?, approval_status = 'approved', updated_at = datetime('now') WHERE id = ?")
      .bind(newId, ac.id)
      .run();

    createdIds.push(newId);
  }

  var apAt = new Date().toISOString();
  await db
    .prepare(
      "UPDATE intake_applications SET status = 'approved', approved_at = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(apAt, staffAuth.staffId, appId)
    .run();
  await db
    .prepare("UPDATE intake_applicants SET phase = 'done', updated_at = datetime('now') WHERE id = ?")
    .bind(app.applicant_id)
    .run();

  await db
    .prepare(
      "INSERT INTO intake_application_messages (application_id, sender_type, sender_id, body) VALUES (?, 'system', NULL, ?)"
    )
    .bind(appId, '申請が承認され、猫が登録されました。')
    .run();

  await postIntakeSlack(
    env,
    '✅ [intake] 承認: ' +
      intakeOneLine((applicant && applicant.name) || '（不明）') +
      ' / app_id=' +
      appId +
      ' by staff=' +
      String(staffAuth.staffId)
  );
  var myAp = intakeMypageUrlFromEnv(env);
  var subjAp = '【NYAGI】お申込み承認のお知らせ';
  var htmlAp =
    '<p>この度はお申し込みありがとうございます。審査の結果、承認とさせていただきます。手続きの続きはマイページよりお願いいたします: <a href="' +
    htmlEsc(myAp) +
    '">' +
    htmlEsc(myAp) +
    '</a></p>';
  await postIntakeResendEmail(env, (applicant && applicant.email) || '', subjAp, htmlAp);
  return opsJson({ ok: true, approved_at: apAt, cat_ids: createdIds });
}

async function handlePreviewToken(db, appId, staffAuth) {
  var app = await db.prepare('SELECT applicant_id FROM intake_applications WHERE id = ?').bind(appId).first();
  if (!app) return opsJson({ error: 'not_found' }, 404);
  var tok = randomTokenHex(16);
  var expRow = await db.prepare("SELECT datetime('now', '+30 minutes') AS e").first();
  var exp = expRow && expRow.e ? expRow.e : null;
  await db
    .prepare(
      "UPDATE intake_applicants SET preview_token = ?, preview_expires = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(tok, exp, app.applicant_id)
    .run();
  return opsJson({
    ok: true,
    preview_token: tok,
    preview_expires: exp,
    use_header: 'Authorization: Bearer ' + tok,
  });
}

/**
 * @param {Request} req
 * @param {object} env
 * @param {URL} url
 * @param {object} staffAuth
 * @param {string} subPath
 */
export async function handleIntakeAdmin(req, env, url, staffAuth, subPath) {
  var db = env.OPS_DB;
  if (!db) return opsJson({ error: 'service_unavailable' }, 503);

  var path = normSub(subPath);
  var method = req.method;

  try {
    if (path === 'dashboard' && method === 'GET') {
      return await handleDashboard(db);
    }
    if (path === 'applicants/invite' && method === 'POST') {
      return await handleInvite(req, db, staffAuth, env);
    }
    if (path === 'applicants' && method === 'GET') {
      return await handleListApplicants(db, url);
    }

    var mApFile = path.match(/^applicants\/([^/]+)\/files\/(\d+)$/);
    if (mApFile && method === 'GET') {
      return await handleApplicantFile(env, db, mApFile[1], parseInt(mApFile[2], 10));
    }

    var mAp = path.match(/^applicants\/([^/]+)$/);
    if (mAp && method === 'GET') {
      return await handleGetApplicant(db, mAp[1]);
    }

    if (path === 'applications' && method === 'GET') {
      return await handleListApplications(db);
    }

    var mApp = path.match(/^applications\/(\d+)$/);
    if (mApp && method === 'GET') {
      return await handleGetApplication(db, parseInt(mApp[1], 10));
    }

    var mRev = path.match(/^applications\/(\d+)\/review$/);
    if (mRev && method === 'POST') {
      return await handleReview(db, parseInt(mRev[1], 10), staffAuth);
    }

    var mReq = path.match(/^applications\/(\d+)\/request-info$/);
    if (mReq && method === 'POST') {
      return await handleRequestInfo(req, db, parseInt(mReq[1], 10), staffAuth);
    }

    var mRej = path.match(/^applications\/(\d+)\/reject$/);
    if (mRej && method === 'POST') {
      return await handleReject(req, db, parseInt(mRej[1], 10), staffAuth, env);
    }

    var mApr = path.match(/^applications\/(\d+)\/approve$/);
    if (mApr && method === 'POST') {
      return await handleApprove(req, db, parseInt(mApr[1], 10), staffAuth, env);
    }

    var mMsg = path.match(/^applications\/(\d+)\/messages$/);
    if (mMsg && method === 'POST') {
      return await handleStaffMessage(req, db, parseInt(mMsg[1], 10), staffAuth, env);
    }

    var mPrev = path.match(/^applications\/(\d+)\/preview-token$/);
    if (mPrev && method === 'GET') {
      return await handlePreviewToken(db, parseInt(mPrev[1], 10), staffAuth);
    }

    return opsJson({ error: 'not_found', message: 'Unknown intake-admin endpoint' }, 404);
  } catch (e) {
    console.error('intake-admin error:', path, e && e.message, e && e.stack);
    if (env.ENV === 'dev' || env.PSEUDO_VERIFY_MODE === 'true') {
      return opsJson({ error: 'internal', debug: e && e.message }, 500);
    }
    return opsJson({ error: 'internal' }, 500);
  }
}
