/**
 * 統合問い合わせ管理: 外部ユーザー向け API（認証不要）
 *
 * POST /api/ops/inquiry-public/submit
 *   body: { name, email, inquiry_type, subject?, body }
 */

import { opsJson } from './router.js';
import { sendSlackMessage } from './slack-notify.js';

var VALID_TYPES = ['intake_consult', 'adoption', 'visit', 'volunteer', 'media', 'partnership', 'other'];
var RATE_LIMIT_PER_HOUR = 10;

var TYPE_LABEL = {
  intake_consult: '猫の引き受け相談',
  adoption: '譲渡希望',
  visit: '見学・来店',
  volunteer: 'ボランティア・寄付',
  media: '取材・コラボ',
  partnership: '協業等の相談',
  other: 'その他',
};

async function checkRateLimit(env, ip) {
  if (!env.IDEMPOTENCY_KV) return true;
  var key = 'inq_rl:' + ip;
  var raw = await env.IDEMPOTENCY_KV.get(key);
  var count = raw ? Number(raw) : 0;
  if (count >= RATE_LIMIT_PER_HOUR) return false;
  await env.IDEMPOTENCY_KV.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

async function sendAutoReply(env, to, name, ticketId) {
  var key = env.RESEND_API_KEY;
  var from = env.RESEND_FROM || 'noreply@bakenekocafe.studio';
  if (!key) {
    console.warn('[inquiry-public] RESEND_API_KEY not set — skip auto reply to', to);
    return;
  }
  var ref = ticketId.slice(0, 8).toUpperCase();
  var subject = '【BAKENEKO CAFE】お問い合わせを受け付けました（受付番号: ' + ref + '）';
  var html = '<p>' + name + ' 様</p>'
    + '<p>お問い合わせありがとうございます。内容を確認のうえ、担当よりご連絡いたします。</p>'
    + '<p>通常 2〜3 営業日以内にご返信いたします。</p>'
    + '<p style="color:#888;font-size:12px;">受付番号: ' + ref + '</p>'
    + '<hr><p style="color:#888;font-size:12px;">BAKENEKO CAFE / 猫又療養所<br>https://bakenekocafe.studio/</p>';
  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: from, to: [to], subject: subject, html: html }),
    });
    if (!res.ok) {
      var txt = await res.text();
      console.warn('[inquiry-public] Resend error', res.status, txt);
    }
  } catch (e) {
    console.warn('[inquiry-public] Resend fetch error:', e && e.message);
  }
}

export async function handleInquiryPublic(req, env, url, subPath) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  var path = (subPath || '').replace(/^\/+|\/+$/g, '');

  if (path === 'submit' && req.method === 'POST') {
    var ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    var allowed = await checkRateLimit(env, ip);
    if (!allowed) {
      return opsJson({
        error: 'rate_limited',
        message: '送信回数が上限を超えました。しばらくしてからお試しください。',
      }, 429);
    }

    var body;
    try { body = await req.json(); } catch (_) {
      return opsJson({ error: 'bad_request', message: '不正なリクエストです' }, 400);
    }

    var name    = body && body.name    ? String(body.name).trim()    : '';
    var email   = body && body.email   ? String(body.email).trim().toLowerCase() : '';
    var msgBody = body && body.body    ? String(body.body).trim()    : '';
    var itype   = body && body.inquiry_type && VALID_TYPES.indexOf(body.inquiry_type) >= 0
                    ? body.inquiry_type : 'other';
    var subject = body && body.subject ? String(body.subject).trim().slice(0, 200) : '';

    if (!name || name.length > 100)
      return opsJson({ error: 'validation', field: 'name', message: 'お名前は1〜100文字で入力してください' }, 400);
    if (!email || email.indexOf('@') < 1)
      return opsJson({ error: 'validation', field: 'email', message: '有効なメールアドレスを入力してください' }, 400);
    if (!msgBody || msgBody.length < 1 || msgBody.length > 5000)
      return opsJson({ error: 'validation', field: 'body', message: 'お問い合わせ内容は1〜5000文字で入力してください' }, 400);

    var db = env.OPS_DB;
    var ticketId = crypto.randomUUID();
    var nowRow = await db.prepare("SELECT datetime('now') AS n").first();
    var now = nowRow && nowRow.n ? nowRow.n : new Date().toISOString().replace('T', ' ').slice(0, 19);

    await db.prepare(
      'INSERT INTO inquiry_tickets (id, channel, inquiry_type, status, priority, sender_name, sender_email, first_message_at, last_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(ticketId, 'web', itype, 'open', 'normal', name, email, now, now, now, now).run();

    var fullBody = subject ? '【' + subject + '】\n' + msgBody : msgBody;
    await db.prepare(
      'INSERT INTO inquiry_messages (ticket_id, direction, sender_type, body, delivery_status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(ticketId, 'inbound', 'external', fullBody, 'sent', now).run();

    var alertCh = env.INQUIRY_SLACK_CHANNEL || env.SLACK_ALERT_CHANNEL || '';
    if (alertCh) {
      var typeLabel = TYPE_LABEL[itype] || itype;
      var ref = ticketId.slice(0, 8).toUpperCase();
      var adminUrl = 'https://nyagi.bakenekocafe.studio/inquiries';
      var slackText = '📨 *新着問い合わせ — 受付番号: ' + ref + '*\n'
        + '種別: ' + typeLabel + '　｜　送信者: ' + name + ' <' + email + '>\n'
        + (subject ? '件名: ' + subject + '\n' : '')
        + '本文: ' + msgBody.slice(0, 120) + (msgBody.length > 120 ? '…' : '') + '\n'
        + '🔗 管理画面: ' + adminUrl;
      await sendSlackMessage(env, alertCh, slackText);
    }

    await sendAutoReply(env, email, name, ticketId);

    return opsJson({ ok: true, ticket_id: ticketId, ref: ticketId.slice(0, 8).toUpperCase() });
  }

  return opsJson({ error: 'not_found' }, 404);
}
