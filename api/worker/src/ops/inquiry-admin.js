/**
 * 統合問い合わせ管理: スタッフ向け API（X-Admin-Key + X-Staff-Id 必須）
 *
 * GET    /api/ops/inquiry-admin/dashboard
 * GET    /api/ops/inquiry-admin/tickets   ?status=&channel=&type=&assigned_to=&q=&limit=&offset=
 * GET    /api/ops/inquiry-admin/tickets/:id
 * PUT    /api/ops/inquiry-admin/tickets/:id      body: { status?, inquiry_type?, priority?, assigned_to?, tags? }
 * POST   /api/ops/inquiry-admin/tickets/:id/reply        body: { body, is_internal_note? }
 * POST   /api/ops/inquiry-admin/tickets/:id/promote-intake  body: { email? }
 * DELETE /api/ops/inquiry-admin/tickets/:id
 */

import { opsJson } from './router.js';
import { sendSlackMessage } from './slack-notify.js';

function normSub(p) { return (p || '').replace(/^\/+|\/+$/g, ''); }

async function sendReplyEmail(env, toEmail, toName, staffName, replyBody, ticketId) {
  var key = env.RESEND_API_KEY;
  var from = env.RESEND_FROM || 'noreply@bakenekocafe.studio';
  if (!key || !toEmail) {
    console.warn('[inquiry-admin] RESEND_API_KEY or toEmail missing — skip reply email');
    return { ok: false, error: !key ? 'RESEND_API_KEY not set' : 'toEmail missing' };
  }
  var ref = ticketId.slice(0, 8).toUpperCase();
  var subject = '【BAKENEKO CAFE】お問い合わせへのご返信（受付番号: ' + ref + '）';
  var html = '<p>' + (toName || 'お客様') + ' 様</p>'
    + '<p>' + replyBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>'
    + '<hr><p style="color:#888;font-size:12px;">'
    + 'BAKENEKO CAFE / 猫又療養所 — ' + (staffName || '') + '<br>'
    + 'https://bakenekocafe.studio/</p>';
  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: [toEmail], subject: subject, html: html }),
    });
    if (!res.ok) {
      var txt = await res.text();
      console.warn('[inquiry-admin] Resend error', res.status, txt);
      return { ok: false, error: 'HTTP ' + res.status + ': ' + txt.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[inquiry-admin] Resend fetch error:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

function randomHex(byteLen) {
  var arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  var s = '';
  for (var i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

async function getNow(db) {
  var r = await db.prepare("SELECT datetime('now') AS n").first();
  return r && r.n ? r.n : new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export async function handleInquiryAdmin(req, env, url, staffAuth, subPath) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  var path = normSub(subPath);
  var db = env.OPS_DB;
  var method = req.method;

  // GET /dashboard
  if (path === 'dashboard' && method === 'GET') {
    var byStatus  = await db.prepare('SELECT status, COUNT(1) AS c FROM inquiry_tickets GROUP BY status ORDER BY c DESC').all();
    var byType    = await db.prepare('SELECT inquiry_type, COUNT(1) AS c FROM inquiry_tickets GROUP BY inquiry_type ORDER BY c DESC').all();
    var openCount = await db.prepare("SELECT COUNT(1) AS c FROM inquiry_tickets WHERE status = 'open'").first();
    return opsJson({
      ok: true,
      open_count: openCount && openCount.c ? Number(openCount.c) : 0,
      by_status: byStatus.results || [],
      by_type: byType.results || [],
    });
  }

  // GET /tickets
  if (path === 'tickets' && method === 'GET') {
    var params = url.searchParams;
    var sFilter = params.get('status')      || null;
    var cFilter = params.get('channel')     || null;
    var tFilter = params.get('type')        || null;
    var aFilter = params.get('assigned_to') || null;
    var qFilter = params.get('q') ? ('%' + params.get('q') + '%') : null;
    var limit   = Math.min(Number(params.get('limit')  || 50), 200);
    var offset  = Number(params.get('offset') || 0);

    // IS NULL pattern: D1(SQLite) で動的バインドの代わりに全条件を固定引数で渡す
    var sql = 'SELECT id, channel, inquiry_type, status, priority, sender_name, sender_email, '
      + 'assigned_to, tags, first_message_at, last_message_at, created_at '
      + 'FROM inquiry_tickets '
      + 'WHERE (? IS NULL OR status = ?) '
      + 'AND (? IS NULL OR channel = ?) '
      + 'AND (? IS NULL OR inquiry_type = ?) '
      + 'AND (? IS NULL OR assigned_to = ?) '
      + 'AND (? IS NULL OR sender_name LIKE ? OR sender_email LIKE ?) '
      + 'ORDER BY last_message_at DESC LIMIT ? OFFSET ?';

    var rows = await db.prepare(sql)
      .bind(
        sFilter, sFilter,
        cFilter, cFilter,
        tFilter, tFilter,
        aFilter, aFilter,
        qFilter, qFilter, qFilter,
        limit, offset
      ).all();

    return opsJson({ ok: true, tickets: rows.results || [], limit: limit, offset: offset });
  }

  // /tickets/:id 系
  var ticketMatch = path.match(/^tickets\/([^/]+)(?:\/(.*))?$/);
  if (!ticketMatch) return opsJson({ error: 'not_found' }, 404);

  var ticketId  = ticketMatch[1];
  var ticketSub = normSub(ticketMatch[2] || '');

  // GET /tickets/:id
  if (!ticketSub && method === 'GET') {
    var ticket = await db.prepare('SELECT * FROM inquiry_tickets WHERE id = ?').bind(ticketId).first();
    if (!ticket) return opsJson({ error: 'not_found' }, 404);
    var messages = await db.prepare(
      'SELECT * FROM inquiry_messages WHERE ticket_id = ? ORDER BY created_at ASC'
    ).bind(ticketId).all();
    return opsJson({ ok: true, ticket: ticket, messages: messages.results || [] });
  }

  // PUT /tickets/:id — フィールドごとに個別 UPDATE（D1 動的バインド回避）
  if (!ticketSub && method === 'PUT') {
    var body;
    try { body = await req.json(); } catch (_) { return opsJson({ error: 'bad_request' }, 400); }
    var now = await getNow(db);
    var updated = false;

    if (body.status !== undefined) {
      updated = true;
      if (body.status === 'resolved') {
        await db.prepare("UPDATE inquiry_tickets SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
          .bind(body.status, now, now, ticketId).run();
      } else {
        await db.prepare("UPDATE inquiry_tickets SET status = ?, updated_at = ? WHERE id = ?")
          .bind(body.status, now, ticketId).run();
      }
    }
    if (body.inquiry_type !== undefined) {
      updated = true;
      await db.prepare("UPDATE inquiry_tickets SET inquiry_type = ?, updated_at = ? WHERE id = ?")
        .bind(body.inquiry_type, now, ticketId).run();
    }
    if (body.priority !== undefined) {
      updated = true;
      await db.prepare("UPDATE inquiry_tickets SET priority = ?, updated_at = ? WHERE id = ?")
        .bind(body.priority, now, ticketId).run();
    }
    if (body.assigned_to !== undefined) {
      updated = true;
      await db.prepare("UPDATE inquiry_tickets SET assigned_to = ?, updated_at = ? WHERE id = ?")
        .bind(body.assigned_to, now, ticketId).run();
    }
    if (body.tags !== undefined) {
      updated = true;
      await db.prepare("UPDATE inquiry_tickets SET tags = ?, updated_at = ? WHERE id = ?")
        .bind(body.tags, now, ticketId).run();
    }
    if (!updated) return opsJson({ error: 'bad_request', message: '更新項目がありません' }, 400);
    return opsJson({ ok: true });
  }

  // DELETE /tickets/:id
  if (!ticketSub && method === 'DELETE') {
    await db.prepare('DELETE FROM inquiry_tickets WHERE id = ?').bind(ticketId).run();
    return opsJson({ ok: true });
  }

  // POST /tickets/:id/reply
  if (ticketSub === 'reply' && method === 'POST') {
    var ticket = await db.prepare('SELECT * FROM inquiry_tickets WHERE id = ?').bind(ticketId).first();
    if (!ticket) return opsJson({ error: 'not_found' }, 404);

    var body;
    try { body = await req.json(); } catch (_) { return opsJson({ error: 'bad_request' }, 400); }
    var replyBody = body && body.body ? String(body.body).trim() : '';
    if (!replyBody) return opsJson({ error: 'bad_request', message: '本文が空です' }, 400);
    var isNote = body && body.is_internal_note ? 1 : 0;
    var now = await getNow(db);

    await db.prepare(
      'INSERT INTO inquiry_messages (ticket_id, direction, sender_type, sender_id, sender_name, body, is_internal_note, delivery_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(ticketId, 'outbound', 'staff', staffAuth.staffId, staffAuth.name || staffAuth.staffId, replyBody, isNote, 'pending', now).run();

    await db.prepare(
      "UPDATE inquiry_tickets SET last_message_at = ?, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?"
    ).bind(now, now, ticketId).run();

    var deliveryStatus = 'skipped';
    var deliveryError = null;
    if (!isNote && ticket.channel === 'web' && ticket.sender_email) {
      var sendResult = await sendReplyEmail(env, ticket.sender_email, ticket.sender_name, staffAuth.name, replyBody, ticketId);
      deliveryStatus = sendResult.ok ? 'sent' : 'failed';
      deliveryError = sendResult.error || null;
    }

    // delivery_status と delivery_error を最新レコードに反映
    await db.prepare(
      "UPDATE inquiry_messages SET delivery_status = ?, delivery_error = ? WHERE ticket_id = ? AND direction = 'outbound' AND sender_id = ? AND created_at = ?"
    ).bind(deliveryStatus, deliveryError, ticketId, staffAuth.staffId, now).run();

    return opsJson({ ok: true, delivery_status: deliveryStatus, delivery_error: deliveryError });
  }

  // POST /tickets/:id/promote-intake
  if (ticketSub === 'promote-intake' && method === 'POST') {
    var ticket = await db.prepare('SELECT * FROM inquiry_tickets WHERE id = ?').bind(ticketId).first();
    if (!ticket) return opsJson({ error: 'not_found' }, 404);
    if (ticket.intake_applicant_id) {
      return opsJson({ error: 'conflict', message: '既に引き受け申請に昇格済みです', applicant_id: ticket.intake_applicant_id }, 409);
    }

    var body;
    try { body = await req.json(); } catch (_) { body = {}; }
    var email = (body && body.email ? String(body.email).trim().toLowerCase() : '') || ticket.sender_email || '';
    if (!email || email.indexOf('@') < 1) {
      return opsJson({ error: 'bad_request', message: '引き受け申請にはメールアドレスが必要です' }, 400);
    }

    var existing = await db.prepare('SELECT id FROM intake_applicants WHERE email = ?').bind(email).first();
    if (existing) {
      await db.prepare("UPDATE inquiry_tickets SET intake_applicant_id = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(existing.id, ticketId).run();
      return opsJson({ ok: true, applicant_id: existing.id, note: '既存の申請者に紐付けました' });
    }

    var token = randomHex(24);
    var newId = crypto.randomUUID();
    var expRow = await db.prepare("SELECT datetime('now', '+7 days') AS e").first();
    await db.prepare(
      "INSERT INTO intake_applicants (id, email, name, token, token_expires, phase, created_by) VALUES (?, ?, ?, ?, ?, 'invited', ?)"
    ).bind(newId, email, ticket.sender_name || '', token, expRow.e, staffAuth.staffId).run();

    await db.prepare("UPDATE inquiry_tickets SET intake_applicant_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(newId, ticketId).run();

    var base = (env.INTAKE_SETUP_URL_BASE || 'https://bakenekocafe.studio/nyagi-app/intake/setup.html').replace(/\/$/, '');
    var setupUrl = base + '?token=' + encodeURIComponent(token);

    return opsJson({ ok: true, applicant_id: newId, setup_url: setupUrl });
  }

  return opsJson({ error: 'not_found' }, 404);
}
