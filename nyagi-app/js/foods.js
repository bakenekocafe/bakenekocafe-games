/**
 * NYAGI フードDB ビルドモード
 * - テキスト入力 / URL貼り付け / 音声入力 → 自動判別
 * - テキスト → Web検索 → 候補表示 → スクレイプ → プレビュー
 * - URL → ダイレクトスクレイプ → プレビュー
 * - 重複チェック（URL/ブランド+名前一致で弾く）
 * - 全フード一覧表示 + カテゴリフィルタ
 */

var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
var API_BASE = _origin + '/api/ops/feeding';
var credentials = null;
var allFoods = [];
var currentFilter = 'all';
var currentSpeciesFilter = 'all';
var currentPreviewUrl = '';

// ── 認証 ──────────────────────────────────────────────────────────────────────

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

// ── 初期化 ─────────────────────────────────────────────────────────────────────

(function init() {
  credentials = loadCredentials();
  if (!credentials) {
    document.getElementById('loginGate').style.display = 'block';
    return;
  }
  document.getElementById('foodContent').style.display = 'block';
  loadFoodList();
})();

// ── スマート検索（URL/テキスト自動判定） ───────────────────────────────────────

function handleSearch() {
  var input = document.getElementById('searchInput').value.trim();
  if (!input) {
    showToast('製品名またはURLを入力してください', 'warning');
    return;
  }

  if (input.indexOf('http') === 0) {
    handleUrlScrape(input);
  } else {
    handleTextSearch(input);
  }
}

// ── URL直接スクレイプ ──────────────────────────────────────────────────────────

function handleUrlScrape(url) {
  var btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.textContent = '取得中...';
  currentPreviewUrl = url;
  hideCandidates();

  fetch(API_BASE + '/foods/scrape', {
    method: 'POST',
    headers: apiHeaders(), cache: 'no-store',
    body: JSON.stringify({ url: url })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    btn.disabled = false;
    btn.textContent = '検索';

    if (data.status === 'ok' && data.extracted) {
      showPreview(data.extracted, url);
      var ext = data.extracted;
      var summary = [];
      if (ext.name) summary.push(ext.name);
      if (ext.kcal_per_100g) summary.push(ext.kcal_per_100g + 'kcal/100g');
      if (ext.brand) summary.push(ext.brand);
      showToast('取得成功' + (summary.length ? ': ' + summary.join(' / ') : '') + ' — 確認して登録', 'success');
    } else {
      showPreview({}, url);
      showToast('自動取得失敗 — 下のフォームに手動入力してください', 'warning');
    }
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.textContent = '検索';
    showPreview({}, url);
    showToast('通信エラー: ' + err.message, 'error');
  });
}

// ── テキスト → Web検索 ────────────────────────────────────────────────────────

function handleTextSearch(query) {
  var btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.textContent = '検索中...';
  hideCandidates();

  var species = currentSpeciesFilter !== 'all' ? currentSpeciesFilter : 'cat';
  fetch(API_BASE + '/foods/search', {
    method: 'POST',
    headers: apiHeaders(), cache: 'no-store',
    body: JSON.stringify({ query: query, species: species })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    btn.disabled = false;
    btn.textContent = '検索';

    if (data.status === 'ok' && data.extracted) {
      currentPreviewUrl = data.url || '';
      showPreview(data.extracted, data.url);
      showCandidates(data.candidates || []);
      var ext = data.extracted;
      var summary = [];
      if (ext.name) summary.push(ext.name);
      if (ext.kcal_per_100g) summary.push(ext.kcal_per_100g + 'kcal/100g');
      showToast('取得成功' + (summary.length ? ': ' + summary.join(' / ') : '') + ' — 確認して登録', 'success');
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
  .catch(function(err) {
    btn.disabled = false;
    btn.textContent = '検索';
    showToast('通信エラー: ' + err.message, 'error');
  });
}

// ── 候補リスト ─────────────────────────────────────────────────────────────────

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
  document.getElementById('candidateList').classList.remove('visible');
}

function selectCandidate(url) {
  hideCandidates();
  document.getElementById('searchInput').value = url;
  handleUrlScrape(url);
}

// voice-console.js がグローバルから handleTextSearch() を呼ぶ
window.handleTextSearch = handleTextSearch;

// ── プレビュー表示 ─────────────────────────────────────────────────────────────

function showPreview(data, url) {
  var card = document.getElementById('previewCard');
  card.classList.add('visible');

  var fields = [
    { id: 'pBrand',   key: 'brand' },
    { id: 'pName',    key: 'name' },
    { id: 'pKcal',    key: 'kcal_per_100g' },
    { id: 'pProtein', key: 'protein_pct' },
    { id: 'pFat',     key: 'fat_pct' },
    { id: 'pFiber',   key: 'fiber_pct' },
    { id: 'pWater',   key: 'water_pct' },
    { id: 'pServing', key: 'serving_size_g' },
    { id: 'pPurpose', key: 'purpose' },
    { id: 'pFlavor',  key: 'flavor' },
    { id: 'pNotes',   key: 'notes' }
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
  }

  var form = data.form || (url && url.indexOf('dry') !== -1 ? 'dry' : '');
  if (form) document.getElementById('pForm').value = form;

  if (data.species && (data.species === 'cat' || data.species === 'dog')) {
    document.getElementById('pSpecies').value = data.species;
  }

  card.classList.toggle('has-data', filledCount > 2);

  if (filledCount > 2) {
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
  var ids = ['pBrand','pName','pKcal','pProtein','pFat','pFiber','pWater','pServing','pPurpose','pFlavor','pNotes'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    el.value = '';
    el.classList.remove('auto-filled');
  }
  var spEl = document.getElementById('pSpecies');
  if (spEl) spEl.value = 'cat';
}

// ── 登録 ───────────────────────────────────────────────────────────────────────

function handleRegister() {
  var name = document.getElementById('pName').value.trim();
  var kcal = parseFloat(document.getElementById('pKcal').value);

  if (!name) { showToast('製品名は必須です', 'warning'); return; }
  if (isNaN(kcal) || kcal <= 0) { showToast('カロリーは必須です', 'warning'); return; }

  var catVal = document.getElementById('pCategory').value;
  var ftMap = { '療法食': 'therapeutic', '総合栄養食': 'complete', '一般食': 'supplement', 'おやつ': 'treat' };
  var speciesEl = document.getElementById('pSpecies');
  var body = {
    brand: document.getElementById('pBrand').value.trim() || null,
    name: name,
    category: catVal,
    food_type: ftMap[catVal] || 'complete',
    form: document.getElementById('pForm').value,
    species: speciesEl ? speciesEl.value : 'cat',
    kcal_per_100g: kcal,
    protein_pct: parseFloatOrNull('pProtein'),
    fat_pct: parseFloatOrNull('pFat'),
    fiber_pct: parseFloatOrNull('pFiber'),
    water_pct: parseFloatOrNull('pWater'),
    serving_size_g: parseFloatOrNull('pServing'),
    purpose: document.getElementById('pPurpose').value.trim() || null,
    flavor: document.getElementById('pFlavor').value.trim() || null,
    notes: document.getElementById('pNotes').value.trim() || null,
    product_url: currentPreviewUrl || null
  };

  var btn = document.getElementById('registerBtn');
  btn.disabled = true;
  btn.textContent = '登録中...';

  fetch(API_BASE + '/foods/import', {
    method: 'POST',
    headers: apiHeaders(), cache: 'no-store',
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    btn.disabled = false;
    btn.textContent = '登録';

    if (data.status === 'created') {
      showToast('登録成功: ' + data.food.name, 'success');
      hidePreview();
      document.getElementById('searchInput').value = '';
      loadFoodList();
    } else if (data.status === 'duplicate') {
      var reason = data.reason === 'url' ? 'URL一致' : 'ブランド+名前一致';
      if (data.enriched) {
        showToast('既存データ更新: ' + data.enriched_fields + '項目追加 — 「' + data.existing.name + '」', 'success');
        showPreview(data.existing, data.existing.product_url);
        loadFoodList();
      } else {
        showToast('重複: ' + reason + ' — 「' + data.existing.name + '」は登録済み', 'warning');
      }
    } else if (data.error === 'missing_fields') {
      showToast('必須項目不足: ' + data.message, 'error');
    } else {
      showToast('登録エラー: ' + (data.message || JSON.stringify(data)), 'error');
    }
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.textContent = '登録';
    showToast('通信エラー: ' + err.message, 'error');
  });
}

function parseFloatOrNull(id) {
  var val = parseFloat(document.getElementById(id).value);
  return isNaN(val) ? null : val;
}

// ── フード一覧読込 ────────────────────────────────────────────────────────────

function loadFoodList() {
  fetch(API_BASE + '/foods?active=0', {
    headers: apiHeaders(), cache: 'no-store'
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    allFoods = data.foods || [];
    renderFoodList();
  })
  .catch(function() {
    document.getElementById('foodGrid').innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
  });
}

function foodTypeLabel(ft) {
  var map = { therapeutic: '療法食', complete: '総合栄養食', supplement: '一般食', treat: 'おやつ' };
  return map[ft] || ft || '不明';
}

function renderFoodList() {
  var grid = document.getElementById('foodGrid');
  var count = document.getElementById('foodCount');
  var filtered = [];

  for (var i = 0; i < allFoods.length; i++) {
    var f = allFoods[i];
    var ft = f.food_type || 'complete';
    var sp = f.species || 'cat';

    if (currentSpeciesFilter !== 'all' && sp !== currentSpeciesFilter) continue;

    if (currentFilter !== 'all') {
      if (currentFilter === '一般食') {
        if (ft !== 'supplement' && ft !== 'treat') continue;
      } else if (currentFilter === '療法食' && ft !== 'therapeutic') {
        continue;
      } else if (currentFilter === '総合栄養食' && ft !== 'complete') {
        continue;
      }
    }

    filtered.push(f);
  }

  var hasFilter = currentFilter !== 'all' || currentSpeciesFilter !== 'all';
  count.textContent = '登録フード: ' + allFoods.length + '件' +
    (hasFilter ? ' (表示: ' + filtered.length + '件)' : '');

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-msg">フードが登録されていません</div>';
    return;
  }

  var html = '';
  for (var j = 0; j < filtered.length; j++) {
    var food = filtered[j];
    var icon = formIcon(food.form);
    var formBadge = '<span class="food-badge ' + (food.form || 'dry') + '">' + formLabel(food.form) + '</span>';
    var ftLabel = foodTypeLabel(food.food_type);
    var catBadge = food.food_type === 'therapeutic'
      ? '<span class="food-badge therapy">療法食</span>'
      : '<span class="food-badge general">' + esc(ftLabel) + '</span>';
    var spClass = (food.species || 'cat') === 'dog' ? 'sp-dog' : 'sp-cat';
    var spLabel = (food.species || 'cat') === 'dog' ? '🐶' : '🐱';
    var speciesBadge = '<span class="food-badge ' + spClass + '">' + spLabel + '</span>';

    html += '<div class="food-item" onclick="showDetail(\'' + escAttr(food.id) + '\')">';
    html += '  <div class="food-icon">' + icon + '</div>';
    html += '  <div class="food-info">';
    html += '    <div class="food-name">' + esc(food.name) + '</div>';
    html += '    <div class="food-meta">' + speciesBadge + catBadge + formBadge;
    if (food.brand) html += ' ' + esc(food.brand);
    if (food.flavor) html += ' / ' + esc(food.flavor);
    html += '</div>';
    if (food.purpose) {
      html += '<div class="food-meta">' + esc(food.purpose) + '</div>';
    }
    html += '  </div>';
    html += '  <div class="food-kcal">' + (food.kcal_per_100g || '?') + '</div>';
    html += '</div>';
  }

  grid.innerHTML = html;
}

// ── フィルタ ───────────────────────────────────────────────────────────────────

function filterList(cat) {
  currentFilter = cat;

  var tabs = document.querySelectorAll('.tab-btn');
  for (var i = 0; i < tabs.length; i++) {
    var btn = tabs[i];
    if (btn.id && btn.id.indexOf('sp') === 0) continue;
    btn.classList.remove('active');
  }

  var tabMap = { 'all': 'tabAll', '療法食': 'tabTherapy', '総合栄養食': 'tabGeneral', '一般食': 'tabSnack' };
  var active = document.getElementById(tabMap[cat]);
  if (active) active.classList.add('active');

  renderFoodList();
}

function filterSpecies(sp) {
  currentSpeciesFilter = sp;
  var spTabs = ['spAll', 'spCat', 'spDog'];
  for (var i = 0; i < spTabs.length; i++) {
    var el = document.getElementById(spTabs[i]);
    if (el) el.classList.remove('active');
  }
  var tabMap = { all: 'spAll', cat: 'spCat', dog: 'spDog' };
  var active = document.getElementById(tabMap[sp]);
  if (active) active.classList.add('active');
  renderFoodList();
}

// ── 詳細モーダル ───────────────────────────────────────────────────────────────

function showDetail(foodId) {
  var food = null;
  for (var i = 0; i < allFoods.length; i++) {
    if (allFoods[i].id === foodId) { food = allFoods[i]; break; }
  }
  if (!food) return;

  document.getElementById('modalTitle').textContent = food.name;

  var spLabels = { cat: '🐱 猫用', dog: '🐶 犬用' };
  var rows = [
    ['ブランド', food.brand],
    ['カテゴリ', foodTypeLabel(food.food_type)],
    ['対象動物', spLabels[food.species] || '🐱 猫用'],
    ['形態', formLabel(food.form)],
    ['用途', food.purpose],
    ['フレーバー', food.flavor],
    ['カロリー', food.kcal_per_100g ? food.kcal_per_100g + ' kcal/100g' : null],
    ['たんぱく質', food.protein_pct ? food.protein_pct + '%' : null],
    ['脂質', food.fat_pct ? food.fat_pct + '%' : null],
    ['粗繊維', food.fiber_pct ? food.fiber_pct + '%' : null],
    ['水分', food.water_pct ? food.water_pct + '%' : null],
    ['リン', food.phosphorus_mg_per_100g ? food.phosphorus_mg_per_100g + ' mg/100g' : null],
    ['ナトリウム', food.sodium_mg_per_100g ? food.sodium_mg_per_100g + ' mg/100g' : null],
    ['1食分', food.serving_size_g ? food.serving_size_g + 'g' : null],
    ['メモ', food.notes],
    ['URL', food.product_url ? '<a href="' + escAttr(food.product_url) + '" target="_blank" style="color:var(--primary);word-break:break-all;">' + esc(food.product_url) + '</a>' : null],
    ['状態', food.active ? '有効' : '無効']
  ];

  var html = '';
  for (var j = 0; j < rows.length; j++) {
    if (rows[j][1] != null && rows[j][1] !== '') {
      html += '<div class="detail-row"><span class="detail-label">' + rows[j][0] + '</span><span class="detail-value">' + rows[j][1] + '</span></div>';
    }
  }

  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('detailModal').classList.add('open');
}

function closeModal() {
  document.getElementById('detailModal').classList.remove('open');
}

// ── トースト ───────────────────────────────────────────────────────────────────

function showToast(msg, type) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type || 'info');

  void toast.offsetWidth;
  toast.classList.add('show');

  setTimeout(function() {
    toast.classList.remove('show');
  }, 3000);
}

// ── ヘルパー ───────────────────────────────────────────────────────────────────

function formIcon(form) {
  if (form === 'wet') return '\uD83E\uDD6B';
  if (form === 'liquid') return '\uD83E\uDDCA';
  if (form === 'semi_moist') return '\uD83C\uDF5E';
  if (form === 'treat') return '\uD83C\uDF6A';
  return '\uD83C\uDF3E';
}

function formLabel(form) {
  var labels = { dry: 'ドライ', wet: 'ウェット', semi_moist: 'セミモイスト', liquid: 'リキッド', treat: 'トリーツ' };
  return labels[form] || form || 'ドライ';
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
