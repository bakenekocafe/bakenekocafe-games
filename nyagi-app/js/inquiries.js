/**
 * NYAGI 統合問い合わせ受信箱（ES5）
 */
(function () {
  'use strict';

  var API_BASE = (window.NYAGI_API_ORIGIN || '') + '/api/ops/inquiry-admin';
  var PUBLIC_API = (window.NYAGI_API_ORIGIN || '') + '/api/ops/inquiry-public';
  var credentials = null;
  var currentTicketId = null;
  var listOffset = 0;
  var LIST_LIMIT = 30;

  var TYPE_LABEL = {
    intake_consult: '猫の引き受け相談',
    adoption: '譲渡希望',
    visit: '見学・来店',
    volunteer: 'ボランティア・寄付',
    media: '取材・コラボ',
    partnership: '協業等の相談',
    other: 'その他',
  };

  var STATUS_LABEL = {
    open: '📩 新規',
    in_progress: '💬 対応中',
    resolved: '✅ 解決済み',
    closed: '🔒 クローズ',
    spam: '🚫 スパム',
  };

  var PRIORITY_LABEL = { normal: '通常', high: '高', urgent: '緊急' };

  // ─── 認証 ───────────────────────────────────────────

  function loadCredentials() {
    try {
      var stored = localStorage.getItem('nyagi_creds');
      if (stored) return JSON.parse(stored);
    } catch (_) {}
    try {
      var m = document.cookie.match(/(?:^|; )nyagi_creds=([^;]*)/);
      if (m) {
        var p = JSON.parse(decodeURIComponent(m[1]));
        if (p && p.staffId) { localStorage.setItem('nyagi_creds', JSON.stringify(p)); return p; }
      }
    } catch (_) {}
    return null;
  }

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Admin-Key': credentials.adminKey,
      'X-Staff-Id': credentials.staffId,
    };
  }

  function apiFetch(method, path, bodyObj) {
    var opts = { method: method, headers: apiHeaders(), cache: 'no-store' };
    if (bodyObj != null && method !== 'GET') opts.body = JSON.stringify(bodyObj);
    return fetch(API_BASE + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try { j = t ? JSON.parse(t) : {}; } catch (_) {}
        if (!r.ok) {
          var err = new Error(j.message || j.error || String(r.status));
          err.body = j; err.status = r.status; throw err;
        }
        return j;
      });
    });
  }

  // ─── ユーティリティ ──────────────────────────────────

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s.replace(' ', 'T') + (s.indexOf('T') < 0 ? '+09:00' : ''));
    if (isNaN(d.getTime())) return s;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function showAlert(elId, msg, isErr) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = '<div style="padding:8px 12px;border-radius:6px;font-size:13px;margin-top:6px;background:' + (isErr ? '#fff0f0;color:#c00;border:1px solid #fcc' : '#f0fff4;color:#060;border:1px solid #9dc') + ';">' + esc(msg) + '</div>';
  }

  // ─── ダッシュボード ──────────────────────────────────

  function refreshDashboard() {
    apiFetch('GET', '/dashboard', null).then(function (d) {
      var el = document.getElementById('inqDash');
      if (!el) return;
      var parts = [];
      var byStatus = d.by_status || [];
      for (var i = 0; i < byStatus.length; i++) {
        var s = byStatus[i];
        var lbl = STATUS_LABEL[s.status] || s.status;
        parts.push('<span style="display:inline-block;margin:2px 4px;padding:4px 10px;border-radius:999px;font-size:11px;background:#f0f4f8;border:1px solid #dde;">' + esc(lbl) + ' <strong>' + esc(String(s.c)) + '</strong></span>');
      }
      el.innerHTML = parts.join('') || '<span style="color:#aaa;font-size:12px;">データなし</span>';
    }).catch(function () {});
  }

  // ─── チケット一覧 ────────────────────────────────────

  function buildListQuery(offset) {
    var status = document.getElementById('filterStatus');
    var type   = document.getElementById('filterType');
    var q      = document.getElementById('filterQ');
    var qs = '?limit=' + LIST_LIMIT + '&offset=' + (offset || 0);
    if (status && status.value) qs += '&status=' + encodeURIComponent(status.value);
    if (type   && type.value)   qs += '&type='   + encodeURIComponent(type.value);
    if (q      && q.value.trim()) qs += '&q='    + encodeURIComponent(q.value.trim());
    return qs;
  }

  function loadTicketList(reset) {
    if (reset) listOffset = 0;
    var listEl = document.getElementById('ticketList');
    var moreEl = document.getElementById('ticketListMore');
    if (reset && listEl) listEl.innerHTML = '<p style="color:#aaa;font-size:13px;padding:8px;">読み込み中…</p>';

    apiFetch('GET', '/tickets' + buildListQuery(listOffset), null).then(function (d) {
      var tickets = d.tickets || [];
      if (reset && listEl) listEl.innerHTML = '';

      if (!tickets.length && reset) {
        if (listEl) listEl.innerHTML = '<p style="color:#aaa;font-size:13px;padding:8px;">チケットなし</p>';
        if (moreEl) moreEl.style.display = 'none';
        return;
      }

      for (var i = 0; i < tickets.length; i++) {
        var t = tickets[i];
        var row = document.createElement('div');
        row.className = 'inq-ticket-row';
        row.setAttribute('data-id', t.id);
        row.style.cssText = 'padding:10px 12px;border-bottom:1px solid rgba(0,0,0,0.07);cursor:pointer;transition:background .15s;';
        if (t.id === currentTicketId) row.style.background = '#f0f8ff';

        var statusBadge = STATUS_LABEL[t.status] || t.status;
        var typeBadge   = TYPE_LABEL[t.inquiry_type] || t.inquiry_type;

        row.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">'
          + '<span style="font-size:12px;font-weight:600;color:#333;">' + esc(t.sender_name || '（名前なし）') + '</span>'
          + '<span style="font-size:11px;color:#999;">' + fmtDate(t.last_message_at) + '</span>'
          + '</div>'
          + '<div style="font-size:11px;color:#666;">'
          + '<span style="margin-right:6px;">' + esc(statusBadge) + '</span>'
          + '<span style="background:#f3f0ff;padding:1px 6px;border-radius:4px;">' + esc(typeBadge) + '</span>'
          + '</div>';

        row.addEventListener('mouseover', function () { this.style.background = '#f5f9ff'; });
        row.addEventListener('mouseout',  function () { this.style.background = this.getAttribute('data-id') === currentTicketId ? '#f0f8ff' : ''; });
        row.addEventListener('click', (function (id) {
          return function () { loadTicketDetail(id); };
        })(t.id));

        if (listEl) listEl.appendChild(row);
      }

      listOffset += tickets.length;
      if (moreEl) moreEl.style.display = tickets.length === LIST_LIMIT ? 'block' : 'none';
    }).catch(function (e) {
      if (listEl) listEl.innerHTML = '<p style="color:#c00;font-size:13px;padding:8px;">読み込みエラー: ' + esc(e.message) + '</p>';
    });
  }

  // ─── チケット詳細 ────────────────────────────────────

  function loadTicketDetail(id) {
    currentTicketId = id;
    // 選択行をハイライト
    var rows = document.querySelectorAll('.inq-ticket-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].style.background = rows[i].getAttribute('data-id') === id ? '#f0f8ff' : '';
    }

    var detailEl = document.getElementById('ticketDetail');
    if (detailEl) detailEl.innerHTML = '<p style="color:#aaa;font-size:13px;">読み込み中…</p>';

    apiFetch('GET', '/tickets/' + encodeURIComponent(id), null).then(function (d) {
      renderTicketDetail(d.ticket, d.messages || []);
    }).catch(function (e) {
      if (detailEl) detailEl.innerHTML = '<p style="color:#c00;font-size:13px;">読み込みエラー: ' + esc(e.message) + '</p>';
    });
  }

  function renderTicketDetail(t, messages) {
    var detailEl = document.getElementById('ticketDetail');
    if (!detailEl) return;

    var typeLabel   = TYPE_LABEL[t.inquiry_type]  || t.inquiry_type;
    var statusLabel = STATUS_LABEL[t.status]        || t.status;
    var prioLabel   = PRIORITY_LABEL[t.priority]    || t.priority;

    var messagesHtml = '';
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var isOut  = m.direction === 'outbound';
      var isNote = m.is_internal_note;
      var bg = isNote ? '#fffbe6' : (isOut ? '#f0f8ff' : '#f9f9f9');
      var label = isNote ? '📝 内部メモ' : (isOut ? '↑ 返信' : '↓ 受信');
      messagesHtml +=
        '<div style="margin-bottom:10px;padding:10px 12px;border-radius:8px;background:' + bg + ';border:1px solid rgba(0,0,0,0.07);">'
        + '<div style="font-size:11px;color:#888;margin-bottom:4px;">'
        + label + ' — ' + fmtDate(m.created_at)
        + (m.delivery_status && m.delivery_status !== 'pending' && m.delivery_status !== 'skipped'
            ? ' <span style="color:' + (m.delivery_status === 'sent' ? '#090' : '#c00') + ';">(' + esc(m.delivery_status) + ')</span>' : '')
        + '</div>'
        + '<div style="font-size:13px;white-space:pre-wrap;">' + esc(m.body) + '</div>'
        + '</div>';
    }

    detailEl.innerHTML =
      '<div style="margin-bottom:12px;">'
      + '<h3 style="margin:0 0 4px;">' + esc(t.sender_name || '（名前なし）') + '</h3>'
      + '<div style="font-size:12px;color:#666;">' + esc(t.sender_email || '') + '</div>'
      + '</div>'

      + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;font-size:12px;">'
      + '<span style="padding:3px 10px;border-radius:999px;background:#e8f4fc;border:1px solid #b8d4ec;">' + esc(statusLabel) + '</span>'
      + '<span style="padding:3px 10px;border-radius:999px;background:#f3f0ff;border:1px solid #d4c8f0;">' + esc(typeLabel) + '</span>'
      + '<span style="padding:3px 10px;border-radius:999px;background:#f0f4f8;border:1px solid #dde;">優先度: ' + esc(prioLabel) + '</span>'
      + '</div>'

      + '<div style="margin-bottom:14px;font-size:12px;color:#888;">受付: ' + fmtDate(t.created_at) + ' / 最終: ' + fmtDate(t.last_message_at) + '</div>'

      + '<h4 style="margin:0 0 8px;font-size:13px;">メッセージ履歴</h4>'
      + '<div style="max-height:300px;overflow-y:auto;margin-bottom:14px;">'
      + (messagesHtml || '<p style="color:#aaa;font-size:13px;">メッセージなし</p>')
      + '</div>'

      + '<h4 style="margin:0 0 8px;font-size:13px;">返信 / メモ</h4>'
      + '<textarea id="replyBody" rows="4" style="width:100%;padding:8px;border-radius:6px;border:1px solid #ddd;font-size:13px;box-sizing:border-box;" placeholder="返信内容を入力…"></textarea>'
      + '<div style="display:flex;align-items:center;gap:10px;margin:6px 0 10px;">'
      + '<label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">'
      + '<input type="checkbox" id="replyIsNote"> 内部メモ（外部に送信しない）'
      + '</label>'
      + '</div>'
      + '<div id="replyAlert"></div>'
      + '<button type="button" id="replyBtn" class="btn btn-primary" style="margin-bottom:10px;">送信</button>'

      + '<hr style="margin:14px 0;border:none;border-top:1px solid #eee;">'
      + '<h4 style="margin:0 0 8px;font-size:13px;">ステータス変更</h4>'
      + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">'
      + '<button type="button" class="btn btn-outline inq-status-btn" style="font-size:12px;" data-status="in_progress">対応中</button>'
      + '<button type="button" class="btn btn-outline inq-status-btn" style="font-size:12px;" data-status="resolved">✅ 解決済み</button>'
      + '<button type="button" class="btn btn-outline inq-status-btn" style="font-size:12px;" data-status="closed">🔒 クローズ</button>'
      + '<button type="button" class="btn btn-outline inq-status-btn" style="font-size:12px;color:#c00;" data-status="spam">🚫 スパム</button>'
      + '</div>'

      + '<h4 style="margin:0 0 8px;font-size:13px;">引き受け申請に昇格</h4>'
      + '<div style="display:flex;gap:6px;align-items:center;">'
      + '<input type="email" id="promoteEmail" placeholder="メールアドレス" value="' + esc(t.sender_email || '') + '" style="flex:1;padding:6px 10px;border-radius:6px;border:1px solid #ddd;font-size:13px;">'
      + '<button type="button" id="promoteBtn" class="btn btn-outline" style="font-size:12px;"' + (t.intake_applicant_id ? ' disabled title="昇格済み"' : '') + '>昇格</button>'
      + '</div>'
      + (t.intake_applicant_id ? '<p style="font-size:11px;color:#090;margin-top:4px;">✅ 昇格済み</p>' : '')
      + '<div id="promoteAlert"></div>';

    // イベント: 返信
    var replyBtn = document.getElementById('replyBtn');
    if (replyBtn) {
      replyBtn.addEventListener('click', function () {
        var body = (document.getElementById('replyBody') || {}).value || '';
        var isNote = document.getElementById('replyIsNote');
        if (!body.trim()) { showAlert('replyAlert', '本文を入力してください', true); return; }
        replyBtn.disabled = true;
        apiFetch('POST', '/tickets/' + encodeURIComponent(t.id) + '/reply', {
          body: body.trim(),
          is_internal_note: isNote && isNote.checked ? 1 : 0,
        }).then(function (d) {
          showAlert('replyAlert', (d.delivery_status === 'sent' ? 'メール送信済み' : '保存しました') + ' (' + d.delivery_status + ')', false);
          var rb = document.getElementById('replyBody');
          if (rb) rb.value = '';
          setTimeout(function () { loadTicketDetail(t.id); loadTicketList(true); refreshDashboard(); }, 600);
        }).catch(function (e) {
          showAlert('replyAlert', e.message, true);
        }).then(function () { replyBtn.disabled = false; });
      });
    }

    // イベント: ステータス変更
    var statusBtns = document.querySelectorAll('.inq-status-btn');
    for (var si = 0; si < statusBtns.length; si++) {
      statusBtns[si].addEventListener('click', (function (btn) {
        return function () {
          var st = btn.getAttribute('data-status');
          btn.disabled = true;
          apiFetch('PUT', '/tickets/' + encodeURIComponent(t.id), { status: st })
            .then(function () {
              setTimeout(function () { loadTicketDetail(t.id); loadTicketList(true); refreshDashboard(); }, 400);
            })
            .catch(function (e) { alert('エラー: ' + e.message); btn.disabled = false; });
        };
      })(statusBtns[si]));
    }

    // イベント: 昇格
    var promoteBtn = document.getElementById('promoteBtn');
    if (promoteBtn && !t.intake_applicant_id) {
      promoteBtn.addEventListener('click', function () {
        var email = (document.getElementById('promoteEmail') || {}).value || '';
        if (!email.trim()) { showAlert('promoteAlert', 'メールアドレスを入力してください', true); return; }
        promoteBtn.disabled = true;
        apiFetch('POST', '/tickets/' + encodeURIComponent(t.id) + '/promote-intake', { email: email.trim() })
          .then(function (d) {
            showAlert('promoteAlert', '引き受け申請に昇格しました' + (d.setup_url ? '（招待URL: ' + d.setup_url + '）' : ''), false);
            setTimeout(function () { loadTicketDetail(t.id); }, 800);
          })
          .catch(function (e) {
            showAlert('promoteAlert', e.message, true);
            promoteBtn.disabled = false;
          });
      });
    }
  }

  // ─── 初期化 ──────────────────────────────────────────

  function init() {
    credentials = loadCredentials();
    var gate = document.getElementById('inqGate');
    var main = document.getElementById('inqMain');

    if (!credentials || !credentials.staffId) {
      if (gate) gate.style.display = 'block';
      if (main) main.style.display = 'none';
      return;
    }

    if (gate) gate.style.display = 'none';
    if (main) main.style.display = 'block';

    refreshDashboard();
    loadTicketList(true);

    var filterBtn  = document.getElementById('filterBtn');
    var reloadBtn  = document.getElementById('reloadBtn');
    var loadMore   = document.getElementById('loadMoreBtn');
    var filterQ    = document.getElementById('filterQ');

    if (filterBtn) filterBtn.addEventListener('click', function () { loadTicketList(true); });
    if (reloadBtn) reloadBtn.addEventListener('click', function () { loadTicketList(true); refreshDashboard(); });
    if (loadMore)  loadMore.addEventListener('click', function () { loadTicketList(false); });
    if (filterQ) {
      filterQ.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') loadTicketList(true);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
