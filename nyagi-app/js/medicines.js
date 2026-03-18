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

function loadCredentials() {
  try {
    var raw = localStorage.getItem('nyagi_creds');
    if (raw) return JSON.parse(raw);
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
  fetch(API_BASE + '/medicines', { headers: apiHeaders() })
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

  var rows = [
    ['一般名', med.generic_name],
    ['カテゴリ', categoryLabel(med.category)],
    ['剤型', formLabel(med.form)],
    ['単位', med.unit],
    ['対象動物', speciesLabel(med.species)],
    ['備考', med.notes],
    ['状態', med.active !== 0 ? '有効' : '無効'],
    ['登録日', med.created_at ? med.created_at.slice(0, 10) : null]
  ];

  var html = '';
  for (var j = 0; j < rows.length; j++) {
    if (rows[j][1] != null && rows[j][1] !== '') {
      html += '<div class="detail-row"><span class="detail-label">' + rows[j][0] + '</span><span class="detail-value">' + esc(String(rows[j][1])) + '</span></div>';
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
    document.getElementById('fGenericName').value = med.generic_name || '';
    document.getElementById('fCategory').value = med.category || 'other';
    document.getElementById('fSpecies').value = med.species || 'cat';
    document.getElementById('fForm').value = med.form || 'tablet';
    document.getElementById('fUnit').value = med.unit || '';
    document.getElementById('fNotes').value = med.notes || '';
  } else {
    document.getElementById('fName').value = '';
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

  var btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = '保存中...';

  var url = isEdit ? API_BASE + '/medicines/' + editId : API_BASE + '/medicines';
  var method = isEdit ? 'PUT' : 'POST';

  fetch(url, {
    method: method,
    headers: apiHeaders(),
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
