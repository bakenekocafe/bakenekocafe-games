/**
 * NYAGI Voice Console — フローティング音声入力ウィジェット (ES5)
 *
 * 全ページ共通。FAB / ミニ / フル の3モード。
 * ページコンテキストを自動判定し送信先をルーティング。
 */

(function () {
  'use strict';

  // ── 定数 ──────────────────────────────────────────────────────
  var MODE_FAB  = 'fab';
  var MODE_MINI = 'mini';
  var MODE_FULL = 'full';

  // ── 状態 ──────────────────────────────────────────────────────
  var currentMode = MODE_FAB;
  var recognition = null;
  var isRecording = false;
  var lastTranscript = '';

  function isLikelyIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  /** 読み込み直後だけでなく、録音直前にも再確認（環境によっては遅延公開される） */
  function hasSpeechApiNow() {
    try {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    } catch (_) {
      return false;
    }
  }

  function insecureSpeechHint() {
    if (typeof window.isSecureContext !== 'undefined' && window.isSecureContext) return '';
    var h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return '';
    return ' http（ローカルIP等）ではブラウザが音声認識を無効にしていることがあります。https または localhost を試してください。';
  }

  // ── DOM 参照（後で設定） ──────────────────────────────────────
  var fab, miniBar, overlay, panel;
  var miniModeLabel, miniText, miniMic, miniExpand, miniClose;
  var panelContext, panelRecordBtn, panelTranscript, panelEdit, panelEditTA;
  var panelSubmitBtn, panelResult;

  // ── コンテキスト判定 ──────────────────────────────────────────
  function detectContext() {
    var path = location.pathname;

    if (path.indexOf('foods.html') !== -1) {
      return { mode: 'food_search', label: 'フード検索' };
    }

    if (path.indexOf('cat.html') !== -1) {
      var params = new URLSearchParams(location.search);
      var id = params.get('id');
      if (id) return { mode: 'cat_report', catId: id, label: id + ' の報告' };
    }

    return { mode: 'general_report', label: '報告入力' };
  }

  var ctx = detectContext();

  var FILTER_LOC_LABELS = { cafe: 'BAKENEKO CAFE', nekomata: '猫又療養所', endo: '遠藤宅', azukari: '預かり隊' };
  var FILTER_STATUS_LABELS = { all: '全て', active: '在籍', adopted: '卒業', trial: 'トライアル中' };

  function getFilterLabel() {
    var loc = null, st = null;
    try { loc = localStorage.getItem('nyagi_dash_location'); } catch (_) {}
    try { st = localStorage.getItem('nyagi_dash_status'); } catch (_) {}
    var locLabel = (loc && loc !== 'all' && FILTER_LOC_LABELS[loc]) ? FILTER_LOC_LABELS[loc] : '全拠点';
    var stLabel = (st && st !== 'all' && FILTER_STATUS_LABELS[st]) ? FILTER_STATUS_LABELS[st] : '全ステータス';
    return '📍 ' + locLabel + ' / ' + stLabel;
  }

  // ── DOM 構築 ──────────────────────────────────────────────────
  function buildDOM() {
    // --- FAB ---
    fab = document.createElement('button');
    fab.className = 'vc-fab';
    fab.setAttribute('aria-label', '音声入力');
    fab.textContent = '\uD83C\uDFA4';
    fab.addEventListener('click', function () { switchMode(MODE_FULL); });

    // --- Mini bar ---
    miniBar = document.createElement('div');
    miniBar.className = 'vc-mini';
    miniBar.innerHTML =
      '<span class="vc-mini-mode"></span>' +
      '<span class="vc-mini-text">タップして展開</span>' +
      '<button class="vc-mini-mic" aria-label="録音">\uD83C\uDFA4</button>' +
      '<button class="vc-mini-expand" aria-label="展開">\u25B2</button>' +
      '<button class="vc-mini-close" aria-label="閉じる">\u2715</button>';

    miniModeLabel = miniBar.querySelector('.vc-mini-mode');
    miniText      = miniBar.querySelector('.vc-mini-text');
    miniMic       = miniBar.querySelector('.vc-mini-mic');
    miniExpand    = miniBar.querySelector('.vc-mini-expand');
    miniClose     = miniBar.querySelector('.vc-mini-close');

    miniModeLabel.textContent = ctx.label;
    miniBar.addEventListener('click', function (e) {
      if (e.target === miniMic || e.target === miniExpand || e.target === miniClose) return;
      switchMode(MODE_FULL);
    });
    miniMic.addEventListener('click', function () { toggleRecording(); });
    miniExpand.addEventListener('click', function () { switchMode(MODE_FULL); });
    miniClose.addEventListener('click', function () { stopRec(); switchMode(MODE_FAB); });

    // --- Overlay ---
    overlay = document.createElement('div');
    overlay.className = 'vc-overlay';
    overlay.addEventListener('click', function () { switchMode(MODE_MINI); });

    // --- Panel ---
    panel = document.createElement('div');
    panel.className = 'vc-panel';

    var hasSpeechApi = hasSpeechApiNow();
    var submitLabel = ctx.mode === 'food_search' ? '検索' : '送信';
    var editPlaceholder = ctx.mode === 'food_search'
      ? '製品名を入力 or 録音...'
      : ctx.mode === 'cat_report'
        ? '例: 排便あり 普通 / 体重3.5キロ / ごはん完食...'
        : '報告内容を入力 or 録音...';

    var quickActionsHtml = '';
    if (ctx.mode === 'cat_report') {
      quickActionsHtml =
        '<div class="vc-quick-actions">' +
          '<button class="vc-quick-btn" data-text="排便あり">💩 排便</button>' +
          '<button class="vc-quick-btn" data-text="排尿あり">💧 排尿</button>' +
          '<button class="vc-quick-btn" data-text="ごはん ">🍽 食事</button>' +
          '<button class="vc-quick-btn" data-text="体重 ">⚖️ 体重</button>' +
          '<button class="vc-quick-btn" data-text="嘔吐 ">🤮 嘔吐</button>' +
          '<button class="vc-quick-btn" data-text="投薬 ">💊 投薬</button>' +
        '</div>';
    }

    panel.innerHTML =
      '<div class="vc-panel-header">' +
        '<span class="vc-panel-title">\uD83C\uDFA4 入力コンソール</span>' +
        '<span class="vc-panel-context">' + escHtml(ctx.label) + '</span>' +
        '<div class="vc-panel-filter">' + escHtml(getFilterLabel()) + '</div>' +
        '<button class="vc-panel-minimize" aria-label="縮小">\u25BC</button>' +
        '<button class="vc-panel-close" aria-label="閉じる">\u2715</button>' +
      '</div>' +
      '<div class="vc-panel-body">' +
        quickActionsHtml +
        '<div class="vc-edit visible">' +
          '<textarea rows="2" placeholder="' + escHtml(editPlaceholder) + '"></textarea>' +
        '</div>' +
        '<div class="vc-record-row">' +
          '<button class="vc-record-btn">\uD83C\uDFA4 録音</button>' +
        '</div>' +
        '<div class="vc-transcript">聞き取り中...</div>' +
        '<div class="vc-submit-row">' +
          '<button class="vc-submit-btn">' + submitLabel + '</button>' +
        '</div>' +
        '<div class="vc-result"></div>' +
        (!hasSpeechApi
          ? '<div class="vc-unsupported">この端末は音声認識に対応していません。テキスト入力をお使いください。' +
            escHtml(insecureSpeechHint()) +
            '</div>'
          : '') +
      '</div>';

    panelContext   = panel.querySelector('.vc-panel-context');
    panelRecordBtn = panel.querySelector('.vc-record-btn');
    panelTranscript = panel.querySelector('.vc-transcript');
    panelEdit      = panel.querySelector('.vc-edit');
    panelEditTA    = panel.querySelector('.vc-edit textarea');
    panelSubmitBtn = panel.querySelector('.vc-submit-btn');
    panelResult    = panel.querySelector('.vc-result');

    var minimizeBtn = panel.querySelector('.vc-panel-minimize');
    var closeBtn    = panel.querySelector('.vc-panel-close');

    minimizeBtn.addEventListener('click', function () { switchMode(MODE_MINI); });
    closeBtn.addEventListener('click', function () { stopRec(); switchMode(MODE_FAB); });

    if (!hasSpeechApi) {
      panelRecordBtn.disabled = true;
      panelRecordBtn.textContent = '\u2328\uFE0F 音声非対応';
    }

    panelRecordBtn.addEventListener('click', function () { toggleRecording(); });
    panelSubmitBtn.addEventListener('click', function () { handleSubmit(); });

    var quickBtns = panel.querySelectorAll('.vc-quick-btn');
    for (var qi = 0; qi < quickBtns.length; qi++) {
      quickBtns[qi].addEventListener('click', function () {
        var prefix = this.getAttribute('data-text') || '';
        panelEditTA.value = prefix;
        panelEditTA.focus();
        var len = prefix.length;
        panelEditTA.setSelectionRange(len, len);
      });
    }

    panelEditTA.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    });

    // --- Append ---
    document.body.appendChild(fab);
    document.body.appendChild(miniBar);
    document.body.appendChild(overlay);
    document.body.appendChild(panel);
  }

  // ── モード切替 ────────────────────────────────────────────────
  function switchMode(mode) {
    currentMode = mode;

    fab.classList.toggle('hidden', mode !== MODE_FAB);
    miniBar.classList.toggle('visible', mode === MODE_MINI);
    overlay.classList.toggle('visible', mode === MODE_FULL);
    panel.classList.toggle('visible', mode === MODE_FULL);

    if (mode === MODE_FULL) {
      var filterEl = panel.querySelector('.vc-panel-filter');
      if (filterEl) filterEl.textContent = getFilterLabel();
    }

    if (mode === MODE_MINI) {
      if (lastTranscript) {
        miniText.textContent = lastTranscript;
        miniText.classList.remove('interim');
      }
    }
  }

  // ── 音声認識 ──────────────────────────────────────────────────
  function toggleRecording() {
    if (isRecording) {
      stopRec();
    } else {
      startRec();
    }
  }

  function startRec() {
    if (!hasSpeechApiNow()) {
      showPanelResult('この端末では音声認識を利用できません。' + insecureSpeechHint(), 'error');
      return;
    }

    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var ios = isLikelyIOS();
    recognition = new SR();
    recognition.lang = 'ja-JP';
    // iOS Safari は continuous:false だとすぐ終了して聞き取れないことがある
    recognition.continuous = ios;
    recognition.interimResults = true;

    recognition.onresult = function (event) {
      var interim = '';
      var finalText = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += t;
        } else {
          interim += t;
        }
      }

      if (finalText) {
        var combined;
        if (ios) {
          var prev = (panelEditTA.value || '').trim();
          var add = finalText.trim();
          combined = prev ? prev + ' ' + add : add;
        } else {
          combined = finalText;
        }
        lastTranscript = combined;
        showTranscript(combined, false);
        panelEditTA.value = combined;
        panelEdit.classList.add('visible');
        miniText.textContent = combined;
        miniText.classList.remove('interim');
      } else if (interim) {
        showTranscript(interim, true);
        miniText.textContent = interim;
        miniText.classList.add('interim');
      }
    };

    recognition.onend = function () {
      setRecState(false);
    };

    recognition.onerror = function (event) {
      setRecState(false);
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        showPanelResult('音声認識エラー: ' + event.error, 'error');
      }
    };

    try {
      recognition.start();
    } catch (startErr) {
      recognition = null;
      setRecState(false);
      showPanelResult('音声を開始できません: ' + (startErr && startErr.message ? startErr.message : startErr), 'error');
      return;
    }
    setRecState(true);
    showTranscript('聞き取り中...', true);
    hidePanelResult();
  }

  function stopRec() {
    if (recognition) {
      try { recognition.abort(); } catch (_) {}
      recognition = null;
    }
    setRecState(false);
  }

  function setRecState(recording) {
    isRecording = recording;
    if (recording) {
      panelRecordBtn.textContent = '\u23F9 録音停止';
      panelRecordBtn.classList.add('recording');
      miniMic.classList.add('recording');
    } else {
      panelRecordBtn.textContent = '\uD83C\uDFA4 録音開始';
      panelRecordBtn.classList.remove('recording');
      miniMic.classList.remove('recording');
    }
  }

  function showTranscript(text, interim) {
    panelTranscript.textContent = text;
    panelTranscript.classList.add('visible');
    panelTranscript.classList.toggle('interim', interim);
  }

  // ── 送信処理 ──────────────────────────────────────────────────
  function handleSubmit() {
    var text = panelEditTA.value.trim();
    if (!text) {
      showPanelResult('テキストが空です', 'warning');
      return;
    }

    if (ctx.mode === 'food_search') {
      submitFoodSearch(text);
    } else {
      submitReport(text);
    }
  }

  function submitFoodSearch(text) {
    if (typeof window.handleTextSearch === 'function') {
      window.handleTextSearch(text);
      switchMode(MODE_MINI);
      miniText.textContent = '検索中: ' + text;
    } else {
      showPanelResult('このページではフード検索を実行できません', 'error');
    }
  }

  function submitReport(text) {
    var opts = {
      inputType: 'speech',
      isConsult: false
    };

    if (typeof window.nyagiSubmitReport === 'function') {
      panelSubmitBtn.disabled = true;
      panelSubmitBtn.innerHTML = '<span class="vc-spinner"></span> 送信中...';

      window.nyagiSubmitReport(text, opts, function (err, data) {
        panelSubmitBtn.disabled = false;
        panelSubmitBtn.textContent = '送信';

        if (err) {
          showPanelResult('送信エラー: ' + err, 'error');
          return;
        }

        if (data && data.offline) {
          showPanelResult('オフライン保存しました。復帰時に自動送信されます。', 'warning');
        } else if (data && data.error) {
          showPanelResult('エラー: ' + (data.message || data.error), 'error');
        } else {
          var conf = (data && data.confirmation) ? data.confirmation : null;
          var msg = conf ? (conf.icon || '✅') + ' ' + (conf.text || '送信完了') : '送信完了';
          showPanelResult(msg, 'success');

          if (typeof window.nyagiOnVoiceSuccess === 'function') {
            window.nyagiOnVoiceSuccess(data);
          }
        }

        panelEditTA.value = '';
        panelTranscript.classList.remove('visible');
        lastTranscript = '';
      });
    } else {
      showPanelResult('送信関数が見つかりません（app.js が未読込の可能性）', 'error');
    }
  }

  // ── パネル内結果メッセージ ────────────────────────────────────
  function showPanelResult(msg, type) {
    panelResult.textContent = msg;
    panelResult.className = 'vc-result visible ' + (type || 'info');
  }

  function hidePanelResult() {
    panelResult.className = 'vc-result';
  }

  // ── ユーティリティ ────────────────────────────────────────────
  function escHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── 初期化 ────────────────────────────────────────────────────
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { buildDOM(); });
    } else {
      buildDOM();
    }
  }

  init();
})();
