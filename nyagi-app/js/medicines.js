/**
 * NYAGI 薬マスター管理
 */

var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
var API_BASE = _origin + '/api/ops/health';
var credentials = null;
var allMedicines = [];
var currentSpeciesFilter = 'all';
var currentTextFilter = '';
var _detailMedId = null;
var currentPreviewUrl = '';

function loadCredentials() {
  try {
    var raw = localStorage.getItem('nyagi_creds');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  try {
    var m = document.cookie.match(/(?:^|; )nyagi_creds=([^;]*)/);
    if (m) { var p = JSON.parse(decodeURIComponent(m[1])); if (p && p.staffId) { localStorage.setItem('nyagi_creds', JSON.stringify(p)); return p; } }
  } catch (_) {}
  return null;
}

function apiHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Admin-Key': credentials.adminKey,
    'X-Staff-Id': credentials.staffId
  };
}

(function init() {
  credentials = loadCredentials();
  if (!credentials) {
    document.getElementById('loginGate').style.display = 'block';
    return;
  }
  document.getElementById('medContent').style.display = 'block';
  document.getElementById('fabAdd').style.display = 'flex';
  loadMedicineList();
})();

function loadMedicineList() {
  fetch(API_BASE + '/medicines', { headers: apiHeaders(), cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      allMedicines = data.medicines || [];
      renderList();
    })
    .catch(function () {
      document.getElementById('medGrid').innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
    });
}

var CATEGORY_LABELS = {
  antibiotic: '抗生物質', anti_inflammatory: '抗炎症薬', painkiller: '鎮痛剤',
  antifungal: '抗真菌薬', antiparasitic: '駆虫薬', heart: '心臓薬',
  kidney: '腎臓薬', thyroid: '甲状腺薬', steroid: 'ステロイド',
  supplement: 'サプリメント', eye: '点眼薬', ear: '点耳薬',
  skin: '皮膚薬', gastrointestinal: '消化器薬', other: 'その他'
};

var FORM_LABELS = {
  tablet: '錠剤', capsule: 'カプセル', powder: '粉末', liquid: '液剤',
  injection: '注射', ointment: '軟膏', eye_drop: '点眼薬', ear_drop: '点耳薬',
  patch: 'パッチ', other: 'その他'
};

var SPECIES_LABELS = { cat: '🐱 猫用', dog: '🐶 犬用', both: '🐾 共通' };

function categoryLabel(cat) { return CATEGORY_LABELS[cat] || cat || '不明'; }
function formLabel(f) { return FORM_LABELS[f] || f || ''; }
function speciesLabel(s) { return SPECIES_LABELS[s] || s || '猫用'; }

function categoryIcon(cat) {
  var map = {
    antibiotic: '💊', anti_inflammatory: '🩹', painkiller: '💉',
    antifungal: '🧫', antiparasitic: '🐛', heart: '❤️',
    kidney: '🫘', thyroid: '🦋', steroid: '⚡',
    supplement: '🌿', eye: '👁️', ear: '👂',
    skin: '🧴', gastrointestinal: '🫁', other: '💊'
  };
  return map[cat] || '💊';
}

function renderList() {
  var grid = document.getElementById('medGrid');
  var count = document.getElementById('medCount');
  var filtered = [];
  var text = currentTextFilter.toLowerCase();

  for (var i = 0; i < allMedicines.length; i++) {
    var m = allMedicines[i];
    var sp = m.species || 'cat';

    if (currentSpeciesFilter !== 'all' && sp !== currentSpeciesFilter) continue;

    if (text) {
      var searchable = ((m.name || '') + ' ' + (m.generic_name || '') + ' ' + categoryLabel(m.category) + ' ' + (m.notes || '')).toLowerCase();
      if (searchable.indexOf(text) === -1) continue;
    }

    filtered.push(m);
  }

  count.textContent = '登録薬: ' + allMedicines.length + '件' +
    (currentSpeciesFilter !== 'all' || text ? ' (表示: ' + filtered.length + '件)' : '');

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-msg">薬が登録されていません</div>';
    return;
  }

  var html = '';
  for (var j = 0; j < filtered.length; j++) {
    var med = filtered[j];
    var icon = categoryIcon(med.category);
    var sp2 = med.species || 'cat';
    var speciesBadge = '<span class="med-badge ' + sp2 + '">' + esc(speciesLabel(sp2)) + '</span>';
    var catBadge = '<span class="med-badge other">' + esc(categoryLabel(med.category)) + '</span>';

    html += '<div class="med-item' + (med.active === 0 ? ' inactive' : '') + '" onclick="showDetail(\'' + escAttr(med.id) + '\')">';
    html += '<div class="med-icon">' + icon + '</div>';
    html += '<div class="med-info">';
    html += '<div class="med-name">' + esc(med.name) + '</div>';
    html += '<div class="med-meta">' + speciesBadge + catBadge;
    if (med.form) html += ' <span class="med-badge cat-form">' + esc(formLabel(med.form)) + '</span>';
    html += '</div>';
    if (med.generic_name) html += '<div class="med-meta">' + esc(med.generic_name) + '</div>';
    html += '</div>';
    if (med.unit) html += '<div style="font-size:12px;color:var(--text-dim);white-space:nowrap;padding-top:3px;">' + esc(med.unit) + '</div>';
    html += '</div>';
  }

  grid.innerHTML = html;
}

function filterSpecies(sp) {
  currentSpeciesFilter = sp;
  var tabs = document.querySelectorAll('.tab-btn');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
  var tabMap = { all: 'tabAll', cat: 'tabCat', dog: 'tabDog', both: 'tabBoth' };
  var active = document.getElementById(tabMap[sp]);
  if (active) active.classList.add('active');
  renderList();
}

function filterByText() {
  currentTextFilter = document.getElementById('searchInput').value.trim();
  renderList();
}

function showDetail(medId) {
  var med = null;
  for (var i = 0; i < allMedicines.length; i++) {
    if (allMedicines[i].id === medId) { med = allMedicines[i]; break; }
  }
  if (!med) return;
  _detailMedId = medId;

  document.getElementById('detailTitle').textContent = med.name;

  var refU = extractReferenceUrlFromNotes(med.notes || '');
  var rows = [
    ['参考URL', refU ? '<a href="' + escAttr(refU) + '" target="_blank" rel="noopener" style="color:var(--primary);word-break:break-all;">' + esc(refU) + '</a>' : null],
    ['一般名', med.generic_name],
    ['カテゴリ', categoryLabel(med.category)],
    ['剤型', formLabel(med.form)],
    ['単位', med.unit],
    ['対象動物', speciesLabel(med.species)],
    ['備考', notesWithoutReferenceUrl(med.notes || '')],
    ['状態', med.active !== 0 ? '有効' : '無効'],
    ['登録日', med.created_at ? med.created_at.slice(0, 10) : null]
  ];

  var html = '';
  for (var j = 0; j < rows.length; j++) {
    if (rows[j][1] != null && rows[j][1] !== '') {
      var valHtml = rows[j][0] === '参考URL' ? rows[j][1] : esc(String(rows[j][1]));
      html += '<div class="detail-row"><span class="detail-label">' + rows[j][0] + '</span><span class="detail-value">' + valHtml + '</span></div>';
    }
  }

  document.getElementById('detailBody').innerHTML = html;
  document.getElementById('detailModal').classList.add('open');
}

function closeDetailModal() {
  document.getElementById('detailModal').classList.remove('open');
  _detailMedId = null;
}

function editFromDetail() {
  closeDetailModal();
  if (_detailMedId) openEditModal(_detailMedId);
}

function openAddModal() {
  openEditModal(null);
}

function openEditModal(medId) {
  var isEdit = !!medId;
  document.getElementById('editTitle').textContent = isEdit ? '💊 薬を編集' : '💊 薬を登録';
  document.getElementById('editId').value = medId || '';

  if (isEdit) {
    var med = null;
    for (var i = 0; i < allMedicines.length; i++) {
      if (allMedicines[i].id === medId) { med = allMedicines[i]; break; }
    }
    if (!med) return;
    document.getElementById('fName').value = med.name || '';
    var refEl = document.getElementById('fReferenceUrl');
    if (refEl) refEl.value = extractReferenceUrlFromNotes(med.notes || '');
    document.getElementById('fGenericName').value = med.generic_name || '';
    document.getElementById('fCategory').value = med.category || 'other';
    document.getElementById('fSpecies').value = med.species || 'cat';
    document.getElementById('fForm').value = med.form || 'tablet';
    document.getElementById('fUnit').value = med.unit || '';
    document.getElementById('fNotes').value = notesWithoutReferenceUrl(med.notes || '');
  } else {
    document.getElementById('fName').value = '';
    var refElNew = document.getElementById('fReferenceUrl');
    if (refElNew) refElNew.value = '';
    document.getElementById('fGenericName').value = '';
    document.getElementById('fCategory').value = 'other';
    document.getElementById('fSpecies').value = 'cat';
    document.getElementById('fForm').value = 'tablet';
    document.getElementById('fUnit').value = '';
    document.getElementById('fNotes').value = '';
  }

  document.getElementById('editModal').classList.add('open');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('open');
}

function saveMedicine() {
  var name = document.getElementById('fName').value.trim();
  if (!name) { showToast('薬名は必須です', 'warning'); return; }

  var editId = document.getElementById('editId').value;
  var isEdit = !!editId;

  var body = {
    name: name,
    generic_name: document.getElementById('fGenericName').value.trim() || null,
    category: document.getElementById('fCategory').value,
    species: document.getElementById('fSpecies').value,
    form: document.getElementById('fForm').value,
    unit: document.getElementById('fUnit').value.trim() || null,
    notes: document.getElementById('fNotes').value.trim() || null
  };
  var refInp = document.getElementById('fReferenceUrl');
  if (refInp) body.reference_url = refInp.value.trim();

  var btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = '保存中...';

  var url = isEdit ? API_BASE + '/medicines/' + editId : API_BASE + '/medicines';
  var method = isEdit ? 'PUT' : 'POST';

  fetch(url, {
    method: method,
    headers: apiHeaders(), cache: 'no-store',
    body: JSON.stringify(body)
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    btn.disabled = false;
    btn.textContent = '保存';

    if (data.medicine) {
      showToast((isEdit ? '更新' : '登録') + '成功: ' + data.medicine.name, 'success');
      closeEditModal();
      loadMedicineList();
    } else {
      showToast('エラー: ' + (data.message || JSON.stringify(data)), 'error');
    }
  })
  .catch(function (err) {
    btn.disabled = false;
    btn.textContent = '保存';
    showToast('通信エラー: ' + err.message, 'error');
  });
}

// ── スマート検索（薬名 or URL 自動判定） ──────────────────────────────────────

function handleSmartSearch() {
  var input = document.getElementById('smartSearchInput').value.trim();
  if (!input) { showToast('薬名またはURLを入力してください', 'warning'); return; }
  if (input.indexOf('http') === 0) {
    handleUrlScrape(input);
  } else {
    handleTextSearch(input);
  }
}

function handleUrlScrape(url) {
  var btn = document.getElementById('smartSearchBtn');
  btn.disabled = true;
  btn.textContent = '取得中...';
  currentPreviewUrl = url;
  hideCandidates();

  fetch(API_BASE + '/medicines/scrape', {
    method: 'POST',
    headers: apiHeaders(), cache: 'no-store',
    body: JSON.stringify({ url: url })
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    btn.disabled = false;
    btn.textContent = '検索';
    if (data.status === 'ok' && data.extracted) {
      showPreview(data.extracted, url);
      showToast('取得成功: ' + (data.extracted.name || '') + ' — 確認して登録', 'success');
    } else {
      showPreview({}, url);
      showToast('自動取得失敗 — 下のフォームに手動入力してください', 'warning');
    }
  })
  .catch(function (err) {
    btn.disabled = false;
    btn.textContent = '検索';
    showPreview({}, url);
    showToast('通信エラー: ' + err.message, 'error');
  });
}

function handleTextSearch(query) {
  var btn = document.getElementById('smartSearchBtn');
  btn.disabled = true;
  btn.textContent = '検索中...';
  hideCandidates();

  fetch(API_BASE + '/medicines/search', {
    method: 'POST',
    headers: apiHeaders(), cache: 'no-store',
    body: JSON.stringify({ query: query })
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    btn.disabled = false;
    btn.textContent = '検索';

    if (data.status === 'ok' && data.extracted) {
      currentPreviewUrl = data.url || '';
      showPreview(data.extracted, data.url);
      showCandidates(data.candidates || []);
      showToast('取得成功: ' + (data.extracted.name || '') + ' — 確認して登録', 'success');
    } else if (data.status === 'partial') {
      currentPreviewUrl = data.url || '';
      showPreview({}, data.url);
      showCandidates(data.candidates || []);
      showToast('候補あり — 候補を選択するか手動入力してください', 'warning');
    } else if (data.status === 'no_results') {
      showToast('検索結果なし — URLを直接貼り付けてください', 'warning');
    } else {
      showToast('検索失敗: ' + (data.message || '') + ' — URLを直接貼り付けてください', 'error');
    }
  })
  .catch(function (err) {
    btn.disabled = false;
    btn.textContent = '検索';
    showToast('通信エラー: ' + err.message, 'error');
  });
}

// ── 候補リスト ──────────────────────────────────────────────────────────────

function showCandidates(candidates) {
  if (!candidates || candidates.length <= 1) return;
  var container = document.getElementById('candidateItems');
  var html = '';
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var domain = '';
    try { domain = new URL(c.url).hostname.replace('www.', ''); } catch (_) {}
    html += '<div class="candidate-item" onclick="selectCandidate(\'' + escAttr(c.url) + '\')">';
    html += '<span class="idx">' + (i + 1) + '</span>';
    html += '<span class="ctitle">' + esc(c.title || c.url) + '</span>';
    html += '<span class="cdomain">' + esc(domain) + '</span>';
    html += '</div>';
  }
  container.innerHTML = html;
  document.getElementById('candidateList').classList.add('visible');
}

function hideCandidates() {
  var el = document.getElementById('candidateList');
  if (el) el.classList.remove('visible');
}

function selectCandidate(url) {
  hideCandidates();
  document.getElementById('smartSearchInput').value = url;
  handleUrlScrape(url);
}

// ── プレビュー ──────────────────────────────────────────────────────────────

var FORM_TO_SELECT = {
  '錠剤': 'tablet', 'カプセル': 'capsule', '粉末': 'powder', '液剤': 'liquid',
  '注射': 'injection', '軟膏': 'ointment', '点眼': 'eye_drop', '点耳': 'ear_drop',
  'パッチ': 'patch', 'その他': 'other',
  'tablet': 'tablet', 'capsule': 'capsule', 'powder': 'powder', 'liquid': 'liquid',
  'injection': 'injection', 'ointment': 'ointment', 'eye_drop': 'eye_drop', 'ear_drop': 'ear_drop',
  'patch': 'patch', 'other': 'other',
};

function showPreview(data, url) {
  var card = document.getElementById('previewCard');
  card.classList.add('visible');

  var fields = [
    { id: 'pName', key: 'name' },
    { id: 'pGenericName', key: 'generic_name' },
    { id: 'pUnit', key: 'unit' },
    { id: 'pNotes', key: 'notes' },
  ];

  var filledCount = 0;
  for (var i = 0; i < fields.length; i++) {
    var el = document.getElementById(fields[i].id);
    var val = data[fields[i].key];
    if (val != null && val !== '') {
      el.value = val;
      el.classList.add('auto-filled');
      filledCount++;
    } else {
      el.value = '';
      el.classList.remove('auto-filled');
    }
  }

  if (data.category) {
    document.getElementById('pCategory').value = data.category;
    filledCount++;
  }
  if (data.form) {
    var fv = FORM_TO_SELECT[data.form] || data.form;
    document.getElementById('pForm').value = fv;
    filledCount++;
  }
  if (data.species) {
    document.getElementById('pSpecies').value = data.species;
  }

  card.classList.toggle('has-data', filledCount > 1);

  if (filledCount > 1) {
    document.getElementById('previewTitle').textContent = '取得データ (' + filledCount + '項目 自動入力)';
  } else if (filledCount > 0) {
    document.getElementById('previewTitle').textContent = '部分取得 — 残りを手動入力';
  } else {
    document.getElementById('previewTitle').textContent = '手動入力モード';
  }

  if (url) currentPreviewUrl = url;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hidePreview() {
  var card = document.getElementById('previewCard');
  card.classList.remove('visible', 'has-data');
  currentPreviewUrl = '';
  clearPreviewFields();
  hideCandidates();
}

function clearPreviewFields() {
  var ids = ['pName', 'pGenericName', 'pUnit', 'pNotes'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) { el.value = ''; el.classList.remove('auto-filled'); }
  }
  var pSp = document.getElementById('pSpecies');
  if (pSp) pSp.value = 'cat';
  var pCat = document.getElementById('pCategory');
  if (pCat) pCat.value = 'other';
  var pForm = document.getElementById('pForm');
  if (pForm) pForm.value = '';
}

// ── プレビューから登録 ──────────────────────────────────────────────────────

function handleRegister() {
  var name = document.getElementById('pName').value.trim();
  if (!name) { showToast('薬名は必須です', 'warning'); return; }

  var body = {
    name: name,
    generic_name: document.getElementById('pGenericName').value.trim() || null,
    category: document.getElementById('pCategory').value || 'other',
    species: document.getElementById('pSpecies').value || 'cat',
    form: document.getElementById('pForm').value || null,
    unit: document.getElementById('pUnit').value.trim() || null,
    notes: document.getElementById('pNotes').value.trim() || null,
  };
  if (currentPreviewUrl) body.reference_url = currentPreviewUrl;

  var btn = document.getElementById('registerBtn');
  btn.disabled = true;
  btn.textContent = '登録中...';

  fetch(API_BASE + '/medicines', {
    method: 'POST',
    headers: apiHeaders(), cache: 'no-store',
    body: JSON.stringify(body),
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    btn.disabled = false;
    btn.textContent = '登録';

    if (data.medicine) {
      var msg = '登録成功: ' + data.medicine.name;
      if (data.ai_enriched) msg += ' (AI自動補完あり)';
      showToast(msg, 'success');
      hidePreview();
      document.getElementById('smartSearchInput').value = '';
      loadMedicineList();
    } else if (data.error) {
      showToast('エラー: ' + (data.message || data.error), 'error');
    } else {
      showToast('登録エラー: ' + JSON.stringify(data), 'error');
    }
  })
  .catch(function (err) {
    btn.disabled = false;
    btn.textContent = '登録';
    showToast('通信エラー: ' + err.message, 'error');
  });
}

// ── トースト ────────────────────────────────────────────────────────────────

function showToast(msg, type) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type || 'info');
  void toast.offsetWidth;
  toast.classList.add('show');
  setTimeout(function () { toast.classList.remove('show'); }, 3000);
}

function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

function extractReferenceUrlFromNotes(notes) {
  if (!notes) return '';
  var m = String(notes).match(/^\s*参考URL:\s*(\S+)/);
  return m ? m[1] : '';
}

function notesWithoutReferenceUrl(notes) {
  if (!notes) return '';
  var lines = String(notes).split('\n').filter(function (l) {
    return !/^\s*参考URL:\s*/.test(l);
  });
  return lines.join('\n').trim();
}
