/**
 * NYAGI グローバル API Origin
 * localhost/127.0.0.1: Wrangler dev (8787) 直
 * LAN/Tailscale: 同一オリジン（serve-lan.py プロキシ経由）
 * 本番: 同一オリジン（''）
 */
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

/**
 * NYAGI PWA — メインアプリ (ES5 互換)
 *
 * Web Speech API + API 通信 + IndexedDB オフラインバッファ
 */

(function () {
  'use strict';

  // ── 定数 ─────────────────────────────
  var API_BASE = window.NYAGI_API_ORIGIN + '/api/ops/voice';
  var IDB_NAME = 'nyagi-offline';
  var IDB_VERSION = 1;
  var IDB_STORE = 'pending_inputs';
  var MAX_RETRY = 5;

  // ── DOM 参照 ──────────────────────────
  var loginSection = document.getElementById('loginSection');
  var inputSection = document.getElementById('inputSection');
  var passwordInput = document.getElementById('passwordInput');
  var loginBtn = document.getElementById('loginBtn');
  var logoutBtn = document.getElementById('logoutBtn');
  var recordBtn = document.getElementById('recordBtn');
  var transcriptPreview = document.getElementById('transcriptPreview');
  var editArea = document.getElementById('editArea');
  var transcriptEdit = document.getElementById('transcriptEdit');
  var submitVoiceBtn = document.getElementById('submitVoiceBtn');
  var textInput = document.getElementById('textInput');
  var submitTextBtn = document.getElementById('submitTextBtn');
  var resultArea = document.getElementById('resultArea');
  var loginAlert = document.getElementById('loginAlert');
  var historyList = document.getElementById('historyList');
  var offlineBanner = document.getElementById('offlineBanner');

  // ── 状態 ──────────────────────────────
  var recognition = null;
  var isRecording = false;
  var credentials = null;

  // ── Service Worker 登録（本番のみ） ──
  if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      console.log('SW registered:', reg.scope);
    }).catch(function (err) {
      console.warn('SW registration failed:', err);
    });
  }

  // ── オフライン検出 ────────────────────
  function updateOnlineStatus() {
    if (navigator.onLine) {
      if (offlineBanner) offlineBanner.classList.remove('visible');
      syncPendingInputs();
    } else {
      if (offlineBanner) offlineBanner.classList.add('visible');
    }
  }
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  // ── ログイン ──────────────────────────
  function loadCredentials() {
    try {
      var stored = localStorage.getItem('nyagi_creds');
      if (stored) return JSON.parse(stored);
    } catch (_) {}
    return null;
  }

  function saveCredentials(adminKey, staffId) {
    var creds = { adminKey: adminKey, staffId: staffId };
    localStorage.setItem('nyagi_creds', JSON.stringify(creds));
    return creds;
  }

  function showApp() {
    if (loginSection) loginSection.style.display = 'none';
    if (inputSection) inputSection.classList.add('visible');
    loadHistory();
  }

  function showLogin() {
    if (loginSection) loginSection.style.display = 'block';
    if (inputSection) inputSection.classList.remove('visible');
  }

  credentials = loadCredentials();
  if (credentials) {
    showApp();
  } else {
    showLogin();
  }

  function showLoginAlert(msg) {
    if (loginAlert) {
      loginAlert.textContent = msg;
      loginAlert.style.display = 'block';
      setTimeout(function () { loginAlert.style.display = 'none'; }, 5000);
    } else {
      alert(msg);
    }
  }

  if (loginBtn) {
    loginBtn.addEventListener('click', function () {
      var password = (passwordInput && passwordInput.value) ? passwordInput.value.trim() : '';
      var adminKey = (window.NYAGI_ADMIN_KEY != null) ? String(window.NYAGI_ADMIN_KEY).trim() : '';
      if (!password) {
        showLoginAlert('4桁パスワードを入力してください');
        return;
      }
      if (!adminKey) {
        showLoginAlert('設定エラー: Admin Key が設定されていません');
        return;
      }
      loginBtn.disabled = true;
      if (loginAlert) loginAlert.style.display = 'none';
      var apiOrigin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
      fetch(apiOrigin + '/api/ops/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify({ password: password }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) {
            showLoginAlert(data.message || 'パスワードが正しくありません');
            return;
          }
          credentials = saveCredentials(adminKey, data.staffId);
          if (passwordInput) passwordInput.value = '';
          showApp();
        })
        .catch(function () {
          showLoginAlert('通信エラー');
        })
        .then(function () {
          loginBtn.disabled = false;
        });
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      localStorage.removeItem('nyagi_creds');
      credentials = null;
      showLogin();
    });
  }

  // ── API 通信 ──────────────────────────
  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-Admin-Key': credentials.adminKey,
      'X-Staff-Id': credentials.staffId,
    };
  }

  function submitTranscript(rawText, inputType, isConsult, callback) {
    var payload = {
      raw_transcript: rawText,
      input_type: inputType,
      is_consult: isConsult,
    };

    if (!navigator.onLine) {
      savePending(payload);
      var offlineData = { offline: true, raw_transcript: rawText };
      showResult(offlineData);
      if (callback) callback(null, offlineData);
      return;
    }

    setSubmitting(true);

    fetch(API_BASE + '/submit', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      setSubmitting(false);
      if (data.error) {
        showResult({ error: true, message: data.message || data.error });
      } else {
        showResult(data);
        loadHistory();
      }
      if (callback) callback(null, data);
    }).catch(function (err) {
      setSubmitting(false);
      savePending(payload);
      var offlineData = { offline: true, raw_transcript: rawText, error_detail: err.message };
      showResult(offlineData);
      if (callback) callback(null, offlineData);
    });
  }

  /**
   * グローバル公開: voice-console.js や他ページから呼べる送信関数
   * @param {string} text
   * @param {Object} opts - { inputType, isConsult, catId }
   * @param {Function} callback - function(err, data)
   */
  window.nyagiSubmitReport = function (text, opts, callback) {
    if (!credentials) {
      if (callback) callback('未ログイン', null);
      return;
    }
    var inputType = (opts && opts.inputType) || 'text';
    var isConsult = (opts && opts.isConsult) || false;
    submitTranscript(text, inputType, isConsult, callback);
  };

  function setSubmitting(busy) {
    if (submitVoiceBtn) submitVoiceBtn.disabled = busy;
    if (submitTextBtn) submitTextBtn.disabled = busy;
    if (busy) {
      if (submitVoiceBtn) submitVoiceBtn.innerHTML = '<span class="spinner"></span> 送信中...';
      if (submitTextBtn) submitTextBtn.innerHTML = '<span class="spinner"></span>';
    } else {
      if (submitVoiceBtn) submitVoiceBtn.textContent = '送信';
      if (submitTextBtn) submitTextBtn.textContent = '送信';
    }
  }

  // ── 結果表示 ──────────────────────────
  function showResult(data) {
    var html = '';

    if (data.offline) {
      html += '<div class="result-card warning">';
      html += '<div class="result-cat">オフライン保存</div>';
      html += '<div class="result-parsed">' + escapeHtml(data.raw_transcript) + '</div>';
      html += '<div class="result-records">オンライン復帰時に自動送信されます</div>';
      html += '</div>';
    } else if (data.error) {
      html += '<div class="result-card error">';
      html += '<div class="result-cat">エラー</div>';
      html += '<div class="result-parsed">' + escapeHtml(data.message || 'Unknown error') + '</div>';
      html += '</div>';
    } else {
      var cardClass = data.needs_further_processing ? 'result-card warning' : 'result-card';
      html += '<div class="' + cardClass + '">';

      if (data.cat) {
        html += '<div class="result-cat">🐱 ' + escapeHtml(data.cat.name) + ' (' + escapeHtml(data.cat.id) + ')</div>';
      } else {
        html += '<div class="result-cat">🐱 猫名未検出</div>';
      }

      html += '<span class="result-layer">' + escapeHtml(data.routing_layer || '?') + '</span>';

      if (data.parsed) {
        html += '<div class="result-parsed">' + escapeHtml(JSON.stringify(data.parsed, null, 2)) + '</div>';
      }

      if (data.records_created && data.records_created.length > 0) {
        html += '<div class="result-records">✅ ' + escapeHtml(data.records_created.join(', ')) + '</div>';
      }

      if (data.needs_further_processing) {
        html += '<div class="result-records" style="color:var(--warning);">⚠ 後続処理が必要です</div>';
      }

      html += '</div>';
    }

    if (resultArea) resultArea.innerHTML = html + resultArea.innerHTML;
  }

  // ── 音声入力（index.html ページ内UI用、他ページではスキップ） ──
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (recordBtn) {
    if (!SpeechRecognition) {
      recordBtn.textContent = '\u2328\uFE0F 音声非対応（テキスト入力をお使いください）';
      recordBtn.disabled = true;
      recordBtn.style.background = '#555';
    }

    recordBtn.addEventListener('click', function () {
      if (!SpeechRecognition) return;

      if (isRecording) {
        stopRecording();
        return;
      }

      recognition = new SpeechRecognition();
      recognition.lang = 'ja-JP';
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onresult = function (event) {
        var interim = '';
        var final = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            final += transcript;
          } else {
            interim += transcript;
          }
        }

        if (final) {
          transcriptPreview.textContent = final;
          transcriptPreview.classList.remove('interim');
          transcriptEdit.value = final;
          editArea.style.display = 'block';
        } else if (interim) {
          transcriptPreview.textContent = interim;
          transcriptPreview.classList.add('interim');
        }

        transcriptPreview.style.display = 'block';
      };

      recognition.onend = function () {
        isRecording = false;
        recordBtn.textContent = '\uD83C\uDFA4 録音開始';
        recordBtn.classList.remove('recording');
      };

      recognition.onerror = function (event) {
        isRecording = false;
        recordBtn.textContent = '\uD83C\uDFA4 録音開始';
        recordBtn.classList.remove('recording');
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          showAlert('音声認識エラー: ' + event.error);
        }
      };

      recognition.start();
      isRecording = true;
      recordBtn.textContent = '\u23F9 録音停止';
      recordBtn.classList.add('recording');
      transcriptPreview.textContent = '聞き取り中...';
      transcriptPreview.classList.add('interim');
      transcriptPreview.style.display = 'block';
      editArea.style.display = 'none';
    });
  }

  function stopRecording() {
    if (recognition) {
      recognition.stop();
    }
    isRecording = false;
    if (recordBtn) {
      recordBtn.textContent = '\uD83C\uDFA4 録音開始';
      recordBtn.classList.remove('recording');
    }
  }

  if (submitVoiceBtn) {
    submitVoiceBtn.addEventListener('click', function () {
      var text = transcriptEdit.value.trim();
      if (!text) {
        showAlert('テキストが空です');
        return;
      }
      submitTranscript(text, 'speech', false);
      transcriptPreview.style.display = 'none';
      editArea.style.display = 'none';
      transcriptEdit.value = '';
    });
  }

  // ── テキスト入力 ──────────────────────
  if (submitTextBtn) {
    submitTextBtn.addEventListener('click', function () {
      var text = textInput.value.trim();
      if (!text) return;
      submitTranscript(text, 'text', false);
      textInput.value = '';
    });
  }

  if (textInput) {
    textInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitTextBtn.click();
      }
    });
  }

  // ── 履歴読み込み ──────────────────────
  function loadHistory() {
    if (!credentials || !historyList) return;

    fetch(API_BASE + '/history?limit=20', {
      headers: apiHeaders(),
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      renderHistory(data.inputs || []);
    }).catch(function () {
      if (historyList) historyList.innerHTML = '<div class="history-item"><span class="time">履歴を読み込めません</span></div>';
    });
  }

  function renderHistory(items) {
    if (!historyList) return;
    if (items.length === 0) {
      historyList.innerHTML = '<div class="history-item"><span class="time">まだ入力がありません</span></div>';
      return;
    }

    var html = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var time = item.created_at ? formatTime(item.created_at) : '';
      var cat = item.target_cat_id || '';
      var layer = item.routing_layer || '';

      html += '<div class="history-item">';
      html += '<span class="time">' + escapeHtml(time) + '</span>';
      html += '<div class="transcript">' + escapeHtml(item.raw_transcript || '') + '</div>';
      html += '<div class="meta">';
      if (cat) html += '🐱 ' + escapeHtml(cat) + ' ';
      if (layer) html += '📍 ' + escapeHtml(layer) + ' ';
      html += escapeHtml(item.status || '');
      html += '</div>';
      html += '</div>';
    }
    historyList.innerHTML = html;
  }

  // ── IndexedDB オフラインバッファ ──────
  function openIDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function savePending(payload) {
    openIDB().then(function (db) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      var store = tx.objectStore(IDB_STORE);
      store.add({
        timestamp: new Date().toISOString(),
        raw_transcript: payload.raw_transcript,
        input_type: payload.input_type,
        is_consult: payload.is_consult || false,
        synced: false,
        retries: 0,
      });
    }).catch(function (err) {
      console.warn('IDB save error:', err);
    });
  }

  function syncPendingInputs() {
    if (!credentials) return;

    openIDB().then(function (db) {
      var tx = db.transaction(IDB_STORE, 'readonly');
      var store = tx.objectStore(IDB_STORE);
      var getAll = store.getAll();
      getAll.onsuccess = function () {
        var items = getAll.result || [];
        var pending = items.filter(function (item) { return !item.synced; });
        if (pending.length === 0) return;

        sendPendingBatch(pending, 0);
      };
    }).catch(function () {});
  }

  function sendPendingBatch(items, idx) {
    if (idx >= items.length) return;
    var item = items[idx];

    fetch(API_BASE + '/submit', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        raw_transcript: item.raw_transcript,
        input_type: item.input_type,
        is_consult: item.is_consult,
      }),
    }).then(function (res) {
      return res.json();
    }).then(function () {
      removePending(item.id);
      var delay = 200;
      setTimeout(function () { sendPendingBatch(items, idx + 1); }, delay);
    }).catch(function () {
      var retries = (item.retries || 0) + 1;
      if (retries >= MAX_RETRY) {
        removePending(item.id);
      } else {
        updateRetryCount(item.id, retries);
      }
      var backoff = Math.min(30000, Math.pow(2, retries) * 1000);
      setTimeout(function () { sendPendingBatch(items, idx + 1); }, backoff);
    });
  }

  function removePending(id) {
    openIDB().then(function (db) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
    }).catch(function () {});
  }

  function updateRetryCount(id, retries) {
    openIDB().then(function (db) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      var store = tx.objectStore(IDB_STORE);
      var req = store.get(id);
      req.onsuccess = function () {
        var item = req.result;
        if (item) {
          item.retries = retries;
          store.put(item);
        }
      };
    }).catch(function () {});
  }

  // ── ユーティリティ ────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      var mo = d.getMonth() + 1;
      var da = d.getDate();
      var h = d.getHours();
      var mi = d.getMinutes();
      return mo + '/' + da + ' ' + (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
    } catch (_) {
      return iso;
    }
  }

  function showAlert(msg) {
    if (!resultArea) return;
    var div = document.createElement('div');
    div.className = 'result-card error';
    div.innerHTML = '<div class="result-parsed">' + escapeHtml(msg) + '</div>';
    resultArea.insertBefore(div, resultArea.firstChild);
    setTimeout(function () {
      if (div.parentNode) div.parentNode.removeChild(div);
    }, 5000);
  }

})();
