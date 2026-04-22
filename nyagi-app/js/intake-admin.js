/**
 * NYAGI 引き受け申請スタッフ画面（ES5）
 */
(function () {
  'use strict';

  var API_BASE =
    (window.NYAGI_API_ORIGIN != null ? window.NYAGI_API_ORIGIN : '') + '/api/ops/intake-admin';

  var credentials = null;

  function loadCredentials() {
    try {
      var stored = localStorage.getItem('nyagi_creds');
      if (stored) return JSON.parse(stored);
    } catch (_) {}
    try {
      var m = document.cookie.match(/(?:^|; )nyagi_creds=([^;]*)/);
      if (m) {
        var p = JSON.parse(decodeURIComponent(m[1]));
        if (p && p.staffId) {
          localStorage.setItem('nyagi_creds', JSON.stringify(p));
          return p;
        }
      }
    } catch (_) {}
    return null;
  }

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Admin-Key': credentials.adminKey,
      'X-Staff-Id': credentials.staffId,
    };
  }

  function apiFetch(method, path, bodyObj) {
    var opts = { method: method, headers: apiHeaders(), cache: 'no-store' };
    if (bodyObj != null && method !== 'GET' && method !== 'HEAD') {
      opts.body = JSON.stringify(bodyObj);
    }
    return fetch(API_BASE + path, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try {
          j = t ? JSON.parse(t) : {};
        } catch (_) {}
        if (!r.ok) {
          var err = new Error(j.message || j.error || String(r.status));
          err.body = j;
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var STATUS_LABEL = {
    draft: '入力中',
    submitted: '申請済み',
    under_review: '審査中',
    info_requested: '情報待ち',
    approved: '承認済み',
    rejected: '却下',
    withdrawn: '取り下げ',
  };

  var APPLICANT_PHASE_LABEL = {
    invited: '招待済み',
    active: '登録完了',
    draft: '入力中',
    submitted: '申請済み',
    under_review: '審査中',
    info_requested: '情報待ち',
    approved: '承認済み',
    rejected: '却下',
    done: '完了',
  };

  var gate = document.getElementById('intakeAdminGate');
  var main = document.getElementById('intakeAdminMain');
  var inviteAlert = document.getElementById('inviteAlert');
  var appsList = document.getElementById('appsList');
  var detailPanel = document.getElementById('detailPanel');
  var dashSummary = document.getElementById('dashSummary');

  function showGate() {
    if (gate) gate.style.display = 'block';
    if (main) main.style.display = 'none';
  }

  function showMain() {
    if (gate) gate.style.display = 'none';
    if (main) main.style.display = 'block';
  }

  function refreshDashboard() {
    apiFetch('GET', '/dashboard', null)
      .then(function (d) {
        var ap = d.applicants_by_phase || [];
        var st = d.applications_by_status || [];
        if (!dashSummary) return;
        if (!ap.length && !st.length) {
          dashSummary.innerHTML = '<span class="intake-dash-empty">（集計なし）</span>';
          return;
        }
        var parts = [];
        for (var i = 0; i < ap.length; i++) {
          var pl = APPLICANT_PHASE_LABEL[ap[i].phase] || ap[i].phase;
          parts.push(
            '<span class="intake-dash-badge intake-dash-badge--phase" title="申請者フェーズ">' +
              esc(pl) +
              ' <strong>' +
              esc(String(ap[i].c)) +
              '</strong></span>'
          );
        }
        for (var j = 0; j < st.length; j++) {
          var sl = STATUS_LABEL[st[j].status] || st[j].status;
          parts.push(
            '<span class="intake-dash-badge intake-dash-badge--status" title="申請ステータス">' +
              esc(sl) +
              ' <strong>' +
              esc(String(st[j].c)) +
              '</strong></span>'
          );
        }
        dashSummary.innerHTML = parts.join(' ');
      })
      .catch(function () {
        if (dashSummary) dashSummary.textContent = 'ダッシュボード取得に失敗';
      });
  }

  function switchIntakeTab(tab) {
    var paneApps = document.getElementById('intakePaneApps');
    var paneAp = document.getElementById('intakePaneApplicants');
    var b1 = document.getElementById('tabAppsBtn');
    var b2 = document.getElementById('tabApplicantsBtn');
    var isApps = tab === 'apps';
    if (paneApps) paneApps.style.display = isApps ? 'block' : 'none';
    if (paneAp) paneAp.style.display = isApps ? 'none' : 'block';
    if (b1 && b2) {
      if (isApps) {
        b1.className = 'btn btn-primary intake-tab-btn';
        b2.className = 'btn btn-outline intake-tab-btn';
      } else {
        b1.className = 'btn btn-outline intake-tab-btn';
        b2.className = 'btn btn-primary intake-tab-btn';
        loadApplicants();
      }
    }
  }

  var cachedApplicantsList = [];

  function renderApplicantsListFiltered() {
    var listEl = document.getElementById('applicantsList');
    if (!listEl) return;
    var tf = document.getElementById('applicantTextFilter');
    var needle = tf ? String(tf.value || '').trim().toLowerCase() : '';
    var rows = cachedApplicantsList;
    if (needle) {
      var out = [];
      for (var fi = 0; fi < rows.length; fi++) {
        var x = rows[fi];
        var em = (x.email || '').toLowerCase();
        var nm = (x.name || '').toLowerCase();
        if (em.indexOf(needle) >= 0 || nm.indexOf(needle) >= 0) out.push(x);
      }
      rows = out;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      var phLabel = APPLICANT_PHASE_LABEL[a.phase] || a.phase;
      html +=
        '<div class="intake-admin-row intake-admin-applicant-row" data-applicant-id="' +
        esc(a.id) +
        '" style="padding:10px;border-bottom:1px solid rgba(0,0,0,0.08);cursor:pointer;">' +
        '<strong>' +
        esc(a.email || '') +
        '</strong><br><span style="font-size:11px;color:#888;">' +
        esc(a.name || '') +
        ' · ' +
        esc(phLabel) +
        '</span></div>';
    }
    listEl.innerHTML = html || '<p style="padding:12px;color:#888;">該当なし</p>';
    var nodes = listEl.querySelectorAll('[data-applicant-id]');
    for (var k = 0; k < nodes.length; k++) {
      nodes[k].addEventListener('click', function () {
        openApplicantDetail(this.getAttribute('data-applicant-id'));
      });
    }
  }

  function loadApplicants() {
    var listEl = document.getElementById('applicantsList');
    if (!listEl) return;
    var phEl = document.getElementById('applicantPhaseFilter');
    var ph = phEl ? phEl.value : '';
    var q = ph ? '?phase=' + encodeURIComponent(ph) : '';
    apiFetch('GET', '/applicants' + q, null)
      .then(function (d) {
        cachedApplicantsList = d.applicants || [];
        renderApplicantsListFiltered();
      })
      .catch(function (e) {
        cachedApplicantsList = [];
        listEl.innerHTML =
          '<p style="padding:12px;color:#c44;">読み込み失敗: ' + esc(e.message) + '</p>';
      });
  }

  function openApplicantDetail(applicantId) {
    var panel = document.getElementById('applicantDetailPanel');
    if (!panel) return;
    panel.innerHTML = '<p style="padding:12px;">読込中…</p>';
    apiFetch('GET', '/applicants/' + encodeURIComponent(applicantId), null)
      .then(function (d) {
        var ap = d.applicant || {};
        var apps = d.applications || [];
        var phLabel = APPLICANT_PHASE_LABEL[ap.phase] || ap.phase;
        var html = '';
        html +=
          '<p style="font-size:12px;color:#666;">' +
          esc(ap.name || '') +
          ' &lt;' +
          esc(ap.email || '') +
          '&gt;</p>';
        html += '<p style="font-size:12px;">フェーズ: ' + esc(phLabel) + '</p>';
        if (ap.phone) html += '<p style="font-size:12px;">電話: ' + esc(ap.phone) + '</p>';
        if (ap.address)
          html += '<p style="font-size:12px;white-space:pre-wrap;">住所: ' + esc(ap.address) + '</p>';
        html += '<h4 style="margin:12px 0 6px;">申請履歴</h4>';
        if (!apps.length) {
          html += '<p style="font-size:12px;color:#888;">なし</p>';
        } else {
          for (var i = 0; i < apps.length; i++) {
            var a = apps[i];
            var st = STATUS_LABEL[a.status] || a.status;
            html +=
              '<p style="margin:6px 0;font-size:13px;">#' +
              esc(a.id) +
              ' ' +
              esc(st) +
              ' — <a href="#" class="open-app-from-applicant" data-app-id="' +
              a.id +
              '">申請タブで開く</a></p>';
          }
        }
        panel.innerHTML = html;
        var links = panel.querySelectorAll('.open-app-from-applicant');
        for (var j = 0; j < links.length; j++) {
          links[j].addEventListener('click', function (ev) {
            ev.preventDefault();
            var aid = parseInt(this.getAttribute('data-app-id'), 10);
            switchIntakeTab('apps');
            openDetail(aid);
          });
        }
      })
      .catch(function (e) {
        panel.innerHTML = '<p style="color:#c44;">取得失敗: ' + esc(e.message) + '</p>';
      });
  }

  var cachedApplicationsList = [];

  function renderApplicationsListFiltered() {
    if (!appsList) return;
    var sf = document.getElementById('appStatusFilter');
    var want = sf ? String(sf.value || '').trim() : '';
    var rows = cachedApplicationsList;
    if (want) {
      var out = [];
      for (var fi = 0; fi < rows.length; fi++) {
        if (rows[fi].status === want) out.push(rows[fi]);
      }
      rows = out;
    }
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      var st = STATUS_LABEL[a.status] || a.status;
      var catc = a.cat_count != null ? a.cat_count : 0;
      var pct = typeof a.completion_pct === 'number' ? a.completion_pct : 0;
      var upd = a.updated_at ? esc(String(a.updated_at).replace('T', ' ').slice(0, 16)) : '—';
      html +=
        '<div class="intake-admin-row" data-app-id="' +
        a.id +
        '" style="padding:10px;border-bottom:1px solid rgba(0,0,0,0.08);cursor:pointer;">' +
        '<strong>#' +
        esc(a.id) +
        '</strong> ' +
        esc(st) +
        '<br><span style="font-size:11px;color:#888;">' +
        esc(a.applicant_email || '') +
        ' · ' +
        esc(a.applicant_name || '') +
        '</span>' +
        '<br><span style="font-size:11px;color:#888;">猫 ' +
        esc(String(catc)) +
        ' 頭 · 更新 ' +
        upd +
        '</span>' +
        '<div style="margin-top:6px;height:6px;background:#eee;border-radius:3px;overflow:hidden;max-width:100%;">' +
        '<div style="height:100%;width:' +
        pct +
        '%;background:#5cb89f;min-width:0;"></div></div>' +
        '<span style="font-size:10px;color:#aaa;">入力目安 ' +
        pct +
        '%</span></div>';
    }
    appsList.innerHTML = html || '<p style="padding:12px;color:#888;">該当なし</p>';
    var nodes = appsList.querySelectorAll('[data-app-id]');
    for (var k = 0; k < nodes.length; k++) {
      nodes[k].addEventListener('click', function () {
        var id = parseInt(this.getAttribute('data-app-id'), 10);
        openDetail(id);
      });
    }
  }

  function loadApplications() {
    apiFetch('GET', '/applications', null)
      .then(function (d) {
        cachedApplicationsList = d.applications || [];
        renderApplicationsListFiltered();
      })
      .catch(function (e) {
        cachedApplicationsList = [];
        appsList.innerHTML =
          '<p style="padding:12px;color:#c44;">読み込み失敗: ' + esc(e.message) + '</p>';
      });
  }

  var selectedAppId = null;

  function openDetail(appId) {
    selectedAppId = appId;
    detailPanel.innerHTML = '<p style="padding:12px;">読込中…</p>';
    apiFetch('GET', '/applications/' + appId, null)
      .then(function (d) {
        var det = d.detail || {};
        var app = det.application || {};
        var ap = det.applicant || {};
        var cats = det.cats || [];
        var msgs = det.messages || [];
        var st = STATUS_LABEL[app.status] || app.status;

        var html = '';
        html += '<h3 style="margin:0 0 8px;">申請 #' + esc(app.id) + ' — ' + esc(st) + '</h3>';
        html +=
          '<div style="font-size:12px;color:#666;margin-bottom:6px;">' +
          '<p style="margin:2px 0;">申請者: ' + esc(ap.name || '') + ' &lt;' + esc(ap.email || '') + '&gt;</p>';
        if (ap.phone) {
          html += '<p style="margin:2px 0;">電話: ' + esc(ap.phone) + '</p>';
        }
        if (ap.address) {
          html += '<p style="margin:2px 0;">住所: ' + esc(ap.address) + '</p>';
        }
        if (ap.organization) {
          html += '<p style="margin:2px 0;">団体: ' + esc(ap.organization) + '</p>';
        }
        html += '</div>';
        if (app.reason) {
          html += '<div style="margin:10px 0;padding:10px;background:#f5f5f5;border-radius:8px;font-size:13px;">' + esc(app.reason) + '</div>';
        }
        html += '<h4 style="margin:14px 0 6px;">猫</h4>';
        for (var c = 0; c < cats.length; c++) {
          var item = cats[c];
          var cat = item.cat || {};
          var comp = item.completion || {};
          var pct = comp.pct != null ? comp.pct : 0;
          var rDone = comp.required_done || 0;
          var rTotal = comp.required_total || 0;
          html +=
            '<div style="margin-bottom:10px;padding:8px 12px;background:#fafafa;border-radius:8px;font-size:13px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<strong>' + esc(cat.name || '（未命名）') + '</strong>' +
            '<span style="font-size:11px;color:#888;">' + rDone + '/' + rTotal + '</span>' +
            '</div>' +
            '<div style="margin-top:4px;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden;">' +
            '<div style="height:100%;width:' + pct + '%;background:' + (pct >= 100 ? '#4caf50' : '#ff9800') + ';border-radius:3px;transition:width .3s;"></div>' +
            '</div>' +
            '<div style="font-size:10px;color:#999;margin-top:2px;">' + pct + '%</div>' +
            '</div>';
        }

        html += '<h4 style="margin:14px 0 6px;">メッセージ</h4>';
        for (var m = 0; m < msgs.length; m++) {
          var msg = msgs[m];
          html +=
            '<div style="font-size:12px;padding:8px;margin-bottom:6px;background:#fafafa;border-radius:6px;">' +
            esc(msg.body || '') +
            '<div style="color:#999;margin-top:4px;">' +
            esc(msg.sender_type || '') +
            '</div></div>';
        }

        if (app.status === 'rejected' && app.rejection_reason) {
          html +=
            '<div style="margin:10px 0;padding:10px;border-left:3px solid #c44;font-size:13px;background:#fff5f5;">却下理由: ' +
            esc(app.rejection_reason) +
            '</div>';
        }

        var rawSt = app.status;
        var isWithdrawn = rawSt === 'withdrawn';
        var isApproved = rawSt === 'approved';
        var isRejected = rawSt === 'rejected';
        var isDraft = rawSt === 'draft';
        var terminal = isApproved || isRejected;
        var showReview = rawSt === 'submitted' || rawSt === 'info_requested';
        var showPipeline = rawSt === 'submitted' || rawSt === 'under_review' || rawSt === 'info_requested';

        if (isWithdrawn) {
          html +=
            '<p style="margin-top:14px;font-size:12px;color:#888;">取り下げ済みのため、審査・プレビュー操作はできません。</p>';
        } else {
          html +=
            '<div style="margin-top:14px;display:flex;flex-direction:column;gap:8px;">' +
            '<h4 style="margin:0;font-size:13px;color:#555;">スタッフ操作</h4>';
          if (terminal) {
            html +=
              '<p style="font-size:12px;color:#666;margin:0;">' +
              (isApproved ? '承認済み' : '却下済み') +
              ' — 審査・プレビュー操作は出しません。メッセージのみ送信できます。</p>';
          } else if (isDraft) {
            html +=
              '<p style="font-size:12px;color:#666;margin:0;">下書き — 審査系は非表示。プレビューで外部画面を確認できます。</p>';
          }
          html +=
            '<textarea id="staffMsgBody" rows="2" placeholder="スタッフからのメッセージ" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;"></textarea>' +
            '<button type="button" class="btn btn-primary" id="btnStaffMsg">メッセージ送信</button>';
          if (!terminal) {
            if (showReview) {
              html += '<button type="button" class="btn btn-outline" id="btnReview">審査開始</button>';
            }
            if (showPipeline) {
              html +=
                '<textarea id="reqInfoBody" rows="2" placeholder="追加で必要な情報（情報依頼と同時に送信）" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;"></textarea>' +
                '<button type="button" class="btn btn-outline" id="btnReqInfo">情報追加依頼</button>' +
                '<textarea id="rejectReason" rows="2" placeholder="却下理由" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;"></textarea>' +
                '<button type="button" class="btn btn-outline" id="btnReject" style="border-color:#c44;color:#c44;">却下</button>' +
                '<button type="button" class="btn btn-primary" id="btnApprove">承認（猫登録実行）</button>';
            }
            html +=
              '<button type="button" class="btn btn-outline" id="btnPreview">外部プレビューURLを発行</button>' +
              '<p id="previewOut" style="font-size:11px;word-break:break-all;"></p>';
          }
          html += '</div>';
        }

        detailPanel.innerHTML = html;

        if (isWithdrawn) {
          return;
        }

        function bindClickIfPresent(id, handler) {
          var el = document.getElementById(id);
          if (el) el.addEventListener('click', handler);
        }

        bindClickIfPresent('btnStaffMsg', function () {
          var body = document.getElementById('staffMsgBody').value.trim();
          if (!body) return;
          apiFetch('POST', '/applications/' + appId + '/messages', { body: body })
            .then(function () {
              openDetail(appId);
              loadApplications();
            })
            .catch(function (e) {
              alert(e.message || '失敗');
            });
        });

        bindClickIfPresent('btnReview', function () {
          apiFetch('POST', '/applications/' + appId + '/review', {})
            .then(function () {
              openDetail(appId);
              loadApplications();
              refreshDashboard();
            })
            .catch(function (e) {
              alert(e.message || '失敗');
            });
        });

        bindClickIfPresent('btnReqInfo', function () {
          var body = document.getElementById('reqInfoBody').value.trim();
          if (!body) {
            alert('依頼内容を入力してください');
            return;
          }
          apiFetch('POST', '/applications/' + appId + '/request-info', { body: body })
            .then(function () {
              openDetail(appId);
              loadApplications();
              refreshDashboard();
            })
            .catch(function (e) {
              alert(e.message || '失敗');
            });
        });

        bindClickIfPresent('btnReject', function () {
          var reason = document.getElementById('rejectReason').value.trim();
          if (!reason) {
            alert('却下理由を入力してください');
            return;
          }
          if (!confirm('却下します。よろしいですか？')) return;
          apiFetch('POST', '/applications/' + appId + '/reject', { reason: reason })
            .then(function () {
              openDetail(appId);
              loadApplications();
              refreshDashboard();
            })
            .catch(function (e) {
              alert(e.message || '失敗');
            });
        });

        bindClickIfPresent('btnApprove', function () {
          if (!confirm('承認し、猫マスターへ登録します。よろしいですか？')) return;
          apiFetch('POST', '/applications/' + appId + '/approve', {})
            .then(function (res) {
              alert('承認しました。猫ID: ' + (res.cat_ids || []).join(', '));
              openDetail(appId);
              loadApplications();
              refreshDashboard();
            })
            .catch(function (e) {
              alert(e.message || '失敗');
            });
        });

        bindClickIfPresent('btnPreview', function () {
          apiFetch('GET', '/applications/' + appId + '/preview-token', null)
            .then(function (res) {
              var tok = res.preview_token || '';
              var rel = 'intake/app.html?id=' + appId + '&pt=' + encodeURIComponent(tok);
              var abs = location.origin + location.pathname.replace(/[^/]*$/, '') + rel;
              var out = document.getElementById('previewOut');
              if (out) {
                out.innerHTML =
                  '共有用（約30分）:<br><a href="' +
                  esc(abs) +
                  '" target="_blank" rel="noopener">' +
                  esc(abs) +
                  '</a>';
              }
            })
            .catch(function (e) {
              alert(e.message || '失敗');
            });
        });
      })
      .catch(function (e) {
        detailPanel.innerHTML =
          '<p style="color:#c44;">詳細取得失敗: ' + esc(e.message) + '</p>';
      });
  }

  document.getElementById('inviteBtn').addEventListener('click', function () {
    inviteAlert.innerHTML = '';
    var email = document.getElementById('inviteEmail').value.trim().toLowerCase();
    var name = document.getElementById('inviteName').value.trim();
    if (!email || email.indexOf('@') < 1) {
      inviteAlert.innerHTML = '<div class="login-alert" style="display:block;">メールを入力してください</div>';
      return;
    }
    apiFetch('POST', '/applicants/invite', { email: email, name: name })
      .then(function (d) {
        inviteAlert.innerHTML =
          '<div class="login-alert" style="display:block;background:#e8f5e9;color:#1b5e20;">招待を作成しました。setup URL をメールで送ってください。<br><code style="word-break:break-all;">' +
          esc(d.setup_url || '') +
          '</code></div>';
        refreshDashboard();
      })
      .catch(function (e) {
        inviteAlert.innerHTML =
          '<div class="login-alert" style="display:block;">' + esc(e.message || '失敗') + '</div>';
      });
  });

  document.getElementById('reloadAppsBtn').addEventListener('click', function () {
    loadApplications();
    refreshDashboard();
  });

  var tabBtns = document.querySelectorAll('.intake-tab-btn');
  for (var ti = 0; ti < tabBtns.length; ti++) {
    tabBtns[ti].addEventListener('click', function () {
      switchIntakeTab(this.getAttribute('data-intake-tab'));
    });
  }

  var rAp = document.getElementById('reloadApplicantsBtn');
  if (rAp) {
    rAp.addEventListener('click', function () {
      loadApplicants();
    });
  }
  var phF = document.getElementById('applicantPhaseFilter');
  if (phF) {
    phF.addEventListener('change', function () {
      loadApplicants();
    });
  }
  var appSf = document.getElementById('appStatusFilter');
  if (appSf) {
    appSf.addEventListener('change', function () {
      renderApplicationsListFiltered();
    });
  }
  var apTf = document.getElementById('applicantTextFilter');
  if (apTf) {
    apTf.addEventListener('input', function () {
      renderApplicantsListFiltered();
    });
  }

  credentials = loadCredentials();
  if (!credentials || !credentials.adminKey || !credentials.staffId) {
    showGate();
    return;
  }

  showMain();
  refreshDashboard();
  loadApplications();
})();
