/**
 * NYAGI 音声入力ハンドラ — L0/L1 パイプライン
 *
 * POST /api/ops/voice/submit  → 音声テキスト受付 → 猫名解決 → L0 → L1 → DB保存
 * GET  /api/ops/voice/history → 入力履歴
 */

import { opsJson } from './router.js';
import { handleCatNameDictionaryRoutes } from './cat-name-dictionary.js';
import { resolveCatName, splitMultiCatInput, suggestCatNames, autoRepairDictionary, logVoiceFailure } from './name-resolver.js';
import { resolveProductName } from './product-resolver.js';
import { resolveCareType } from './care-resolver.js';
import { preRoute } from './l0-gate.js';
import { structureText } from './l1-structurer.js';
import { postCheck, autoEscalateAlertLevel } from './l2-rules.js';
import { callL3, processL3Result } from './l3-assist.js';
import { dispatchSlackNotification } from './slack-notify.js';
import { refreshNutritionProfile, getDailyNutritionSummary, formatNutritionSummary, detectCalorieDeficit, findOverdueFeedingChecks, buildCatCard, buildFoodSuggestion } from './nutrition.js';
import {
  jstNowIsoTimestamp,
  jstCalendarYmdFromInstant,
  jstCalendarAddDays,
  jstCalendarHmFromInstant,
  jstCalendarHourFromInstant,
} from './jst-util.js';

function jstNow() {
  return jstNowIsoTimestamp();
}

function jstToday() {
  return jstCalendarYmdFromInstant(Date.now());
}

function jstHour() {
  return jstCalendarHourFromInstant(Date.now());
}


export async function handleVoice(req, env, url, staffAuth, subPath) {
  var method = req.method;
  var db = env.OPS_DB;

  var dictRoute = await handleCatNameDictionaryRoutes(req, env, url, staffAuth, subPath, db);
  if (dictRoute) return dictRoute;

  if (method === 'POST' && subPath.indexOf('/shortcut/voice') === 0) {
    return handleShortcutVoiceSubmit(req, env, db, staffAuth);
  }

  if (method === 'POST' && subPath.indexOf('/submit') === 0) {
    return handleSubmit(req, env, db, staffAuth);
  }

  if (method === 'POST' && subPath.indexOf('/followup') === 0) {
    return handleFollowup(req, env, db, staffAuth);
  }

  if (method === 'GET' && subPath.indexOf('/history') === 0) {
    return handleHistory(url, db, staffAuth);
  }

  if (method === 'GET' && subPath.indexOf('/cat-card') === 0) {
    return handleCatCard(url, db);
  }

  if (method === 'GET' && subPath.indexOf('/food-suggest') === 0) {
    return handleFoodSuggest(url, db);
  }

  var inExcretion = subPath.match(/^\/inputs\/(\d+)\/excretion$/);
  if (inExcretion) {
    var voiceExId = parseInt(inExcretion[1], 10);
    if (method === 'PUT' || method === 'PATCH') {
      return correctVoiceExcretion(req, db, staffAuth, voiceExId);
    }
    if (method === 'DELETE') {
      return deleteVoiceExcretion(db, staffAuth, voiceExId);
    }
    return opsJson({ error: 'method_not_allowed' }, 405);
  }

  return opsJson({ error: 'not_found', message: 'Voice endpoint not found' }, 404);
}

/**
 * 複数猫の連続入力を個別処理して統合レスポンスを返す
 */
async function handleMultiCatSubmit(segments, rawText, env, db, staffAuth) {
  var results = [];
  var allRecords = [];
  var confirmParts = [];
  var today = jstToday();
  var now = jstNow();

  for (var s = 0; s < segments.length; s++) {
    var seg = segments[s];
    var catId = seg.catId;
    var catName = seg.catName;
    var segText = seg.text;

    var careResult = null;
    try { careResult = await resolveCareType(segText, db); } catch (_) {}

    var parsed = null;
    if (careResult) {
      var careDone = !/してない|スキップ|なし|やらなかった|できなかった/i.test(segText);
      var careModule = 'care';
      var rt = careResult.recordType;
      if (rt === 'stool' || rt === 'urination') careModule = 'stool';
      else if (rt === 'vomiting') careModule = 'vomiting';
      else if (rt === 'weight') careModule = 'weight';
      else if (rt === 'force_feeding') careModule = 'feeding';

      var careParsedData = { details: careResult.details, done: careDone };
      if (rt === 'stool' || rt === 'urination') {
        var consistency = null;
        if (/健康|普通|正常|いつも通り/.test(segText)) consistency = 'normal';
        else if (/硬い|コロコロ|ころころ/.test(segText)) consistency = 'hard';
        else if (/軟便|やわらかい|柔らかい|ゆるい/.test(segText)) consistency = 'soft';
        else if (/下痢|水|びちゃびちゃ/.test(segText)) consistency = 'liquid';
        if (consistency) careParsedData.consistency = consistency;
        if (/血/.test(segText)) careParsedData.blood = 'present';
        careParsedData.status = consistency || 'recorded';
      }

      parsed = {
        module: careModule,
        record_type: rt,
        parsed: careParsedData,
        confidence: 0.9,
        source: 'care_dict',
      };
    }

    if (!parsed) {
      try {
        parsed = await structureText({ catId: catId, text: segText, routeHint: 'L1' }, env);
      } catch (_) {}
    }

    var voiceResult = await db.prepare(
      'INSERT INTO voice_inputs (staff_id, location_id, raw_transcript, parsed_data, target_module, target_cat_id, routing_layer, status, created_records) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).bind(
      staffAuth.staffId, staffAuth.locationId,
      catName + ' ' + segText,
      parsed ? JSON.stringify(parsed) : null,
      parsed ? parsed.module : null,
      catId, 'L1',
      parsed ? 'completed' : 'processing',
      null
    ).first();

    var voiceInputId = voiceResult.id;
    var createdRecords = [];
    if (parsed && catId) {
      createdRecords = await saveStructuredRecords(db, parsed, catId, staffAuth, voiceInputId, segText);
    }

    if (createdRecords.length > 0) {
      await db.prepare(
        'UPDATE voice_inputs SET created_records = ?, status = ? WHERE id = ?'
      ).bind(JSON.stringify(createdRecords), 'completed', voiceInputId).run();
    }

    allRecords = allRecords.concat(createdRecords);

    var conf = buildConfirmation(parsed, catName, createdRecords, 'L1', null, null, null);
    confirmParts.push(conf.icon + ' ' + conf.text);

    results.push({
      voice_input_id: voiceInputId,
      cat: { id: catId, name: catName },
      parsed: parsed,
      records_created: createdRecords,
    });
  }

  return opsJson({
    ok: true,
    multi: true,
    count: results.length,
    results: results,
    records_created: allRecords,
    confirmation: {
      icon: '✅',
      text: confirmParts.join('\n'),
      time: jstTimeLabel(),
    },
  }, 201);
}

/**
 * iPhone ショートカット / Siri 連携用の薄い受け口。
 * body.text を raw_transcript に正規化し、通常の voice/submit と同一パイプラインへ。
 * レスポンスに shortcut.speak / shortcut.display を付与（「結果を表示」「読み上げ」用）。
 */
async function handleShortcutVoiceSubmit(req, env, db, staffAuth) {
  var sBody;
  try { sBody = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  var fromText = sBody.text != null ? String(sBody.text).trim() : '';
  var fromRaw = (sBody.raw_transcript || '').trim();
  var unified = String(fromText || fromRaw || '').trim();
  if (!unified) {
    return opsJson({ error: 'bad_request', message: 'text または raw_transcript が必要です' }, 400);
  }
  var inner = Object.assign({}, sBody);
  inner.raw_transcript = unified;
  delete inner.text;
  var res = await submitVoiceFromBody(inner, env, db, staffAuth);
  try {
    var ct = res.headers && res.headers.get('Content-Type');
    if (ct && ct.indexOf('json') !== -1) {
      var data = await res.clone().json();
      if (data && typeof data === 'object') {
        var speak = '';
        if (data.ok && data.confirmation && data.confirmation.text) {
          speak = (data.confirmation.icon ? String(data.confirmation.icon) + ' ' : '') + String(data.confirmation.text);
        } else if (data.message) {
          speak = String(data.message);
        } else if (data.error) {
          speak = 'エラー: ' + String(data.message || data.error);
        }
        speak = speak.trim();
        data.shortcut = {
          speak: speak || (data.ok ? '完了しました' : '処理できませんでした'),
          display: speak || (data.ok ? 'OK' : 'NG'),
        };
        return opsJson(data, res.status);
      }
    }
  } catch (e) {
    console.warn('shortcut/voice enrich:', e && e.message);
  }
  return res;
}

async function handleSubmit(req, env, db, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  return submitVoiceFromBody(body, env, db, staffAuth);
}

async function submitVoiceFromBody(body, env, db, staffAuth) {
  if (!body || !body.raw_transcript) {
    return opsJson({ error: 'bad_request', message: 'raw_transcript required' }, 400);
  }

  var rawText = body.raw_transcript.trim();
  var inputType = body.input_type || 'text';
  var isConsult = !!body.is_consult;

  var filterOpts = {};
  if (body.filter_location) filterOpts.filterLocation = body.filter_location;
  if (body.filter_status) filterOpts.filterStatus = body.filter_status;

  var catId = null;
  var catName = null;
  var textForProcessing = rawText;

  // 0. 複数猫の連続入力を検出 → セグメント分割して個別処理
  var multiSegments = null;
  if (!isConsult) {
    try { multiSegments = await splitMultiCatInput(rawText, db, filterOpts); } catch (_) {}
  }
  if (multiSegments && multiSegments.length > 1) {
    return handleMultiCatSubmit(multiSegments, rawText, env, db, staffAuth);
  }

  // 1. 猫名を解決（フィルタ条件付き）
  var nameResult = await resolveCatName(rawText, db, filterOpts);
  catId = nameResult.catId;
  catName = nameResult.catName;
  textForProcessing = nameResult.remainingText;

  // 1b. 猫名未解決 → 422 エラー
  if (!catId && !isConsult) {
    var voiceFail = await db.prepare(
      'INSERT INTO voice_inputs (staff_id, location_id, raw_transcript, parsed_data, target_module, target_cat_id, routing_layer, status, created_records) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).bind(staffAuth.staffId, staffAuth.locationId, rawText, null, null, null, 'L1', 'failed', null).first();

    var suggestions = [];
    try { suggestions = await suggestCatNames(rawText, db, filterOpts); } catch (_) {}

    try { await autoRepairDictionary(db); } catch (_) {}

    var filterLabel = '';
    if (filterOpts.filterLocation || filterOpts.filterStatus) {
      var locLabels = { cafe: 'BAKENEKO CAFE', nekomata: '猫又療養所', endo: '遠藤宅', azukari: '預かり隊' };
      var stLabels = { active: '在籍', adopted: '卒業', trial: 'トライアル中' };
      var parts = [];
      if (filterOpts.filterLocation && locLabels[filterOpts.filterLocation]) parts.push(locLabels[filterOpts.filterLocation]);
      if (filterOpts.filterStatus && stLabels[filterOpts.filterStatus]) parts.push(stLabels[filterOpts.filterStatus]);
      if (parts.length) filterLabel = '（' + parts.join('/') + 'の猫）';
    }

    return opsJson({
      ok: false,
      error: 'unresolved',
      error_type: 'cat_not_found',
      message: filterLabel
        ? filterLabel + 'に該当する猫名を認識できませんでした。フィルタを確認するか、修正して再送信してください。'
        : '猫名を認識できませんでした。修正して再送信してください。',
      raw_transcript: rawText,
      voice_input_id: voiceFail.id,
      attempted: nameResult.unresolved || null,
      suggestions: suggestions,
    }, 422);
  }

  // 2. 製品名（フード/薬）を解決
  var productResult = await resolveProductName(textForProcessing, db, null);
  var resolvedProduct = null;
  if (productResult.productId) {
    resolvedProduct = {
      id: productResult.productId,
      type: productResult.productType,
      name: productResult.productName,
    };
    textForProcessing = productResult.remainingText;
  }

  // 2b. ケア項目を解決（音声辞書から）
  // care_type_dictionary には排泄・嘔吐・体重も登録（LLM失敗時のセーフティネット）
  var careResult = await resolveCareType(textForProcessing, db);
  var careParsed = null;
  if (careResult && catId) {
    var careDone = !/してない|スキップ|なし|やらなかった|できなかった/i.test(rawText);
    var careModule = 'care';
    var rt = careResult.recordType;
    if (rt === 'stool' || rt === 'urination') careModule = 'stool';
    else if (rt === 'vomiting') careModule = 'vomiting';
    else if (rt === 'weight') careModule = 'weight';
    else if (rt === 'force_feeding') careModule = 'feeding';

    var careParsedData = { details: careResult.details, done: careDone };
    if (rt === 'stool' || rt === 'urination') {
      var statusWord = rawText;
      var consistency = null;
      if (/健康|普通|正常|いつも通り/.test(statusWord)) consistency = 'normal';
      else if (/硬い|コロコロ|ころころ/.test(statusWord)) consistency = 'hard';
      else if (/軟便|やわらかい|柔らかい|ゆるい/.test(statusWord)) consistency = 'soft';
      else if (/下痢|水|びちゃびちゃ/.test(statusWord)) consistency = 'liquid';
      if (consistency) careParsedData.consistency = consistency;
      if (/血/.test(statusWord)) careParsedData.blood = 'present';
      careParsedData.status = consistency || 'recorded';
    }

    careParsed = {
      module: careModule,
      record_type: rt,
      parsed: careParsedData,
      confidence: 0.9,
      source: 'care_dict',
    };
    textForProcessing = careResult.remainingText;
  }

  // 3. cat レコード取得（alert_level 参照）
  var catRecord = null;
  if (catId) {
    catRecord = await db.prepare(
      'SELECT id, name, alert_level FROM cats WHERE id = ?'
    ).bind(catId).first();
  }

  // 4. L0 ゲートで routing_layer を決定
  var routingLayer = preRoute(rawText, catRecord, isConsult);

  // 5. L1 構造化（ケア辞書で解決済みならスキップ）
  var parsed = careParsed;
  var needsFurther = false;
  if (!parsed && (routingLayer === 'L1' || routingLayer === 'L1_with_anomaly_flag' || routingLayer === 'L1_blood' || routingLayer === 'L1_summary')) {
    parsed = await structureText(
      { catId: catId, text: textForProcessing, routeHint: routingLayer },
      env
    );
    if (routingLayer === 'L1_with_anomaly_flag') {
      needsFurther = true;
    }
  } else if (!parsed) {
    needsFurther = true;
  }

  // 5b. 構造化完全失敗 → 422 エラー
  var isStructureFailed = !parsed || (parsed.module === 'general' && (parsed.confidence === 0 || !parsed.confidence));
  if (isStructureFailed && catId && !isConsult) {
    await logVoiceFailure(db, rawText, textForProcessing, 'parse_failed');

    var voiceFail2 = await db.prepare(
      'INSERT INTO voice_inputs (staff_id, location_id, raw_transcript, parsed_data, target_module, target_cat_id, routing_layer, status, created_records) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).bind(staffAuth.staffId, staffAuth.locationId, rawText, parsed ? JSON.stringify(parsed) : null, 'general', catId, routingLayer, 'failed', null).first();

    return opsJson({
      ok: false,
      error: 'unresolved',
      error_type: 'parse_failed',
      message: catName + ' の記録内容を認識できませんでした。もう少し詳しく入力してください。',
      raw_transcript: rawText,
      voice_input_id: voiceFail2.id,
      cat: { id: catId, name: catName },
    }, 422);
  }

  // 6. L2 ルールチェック（L1 構造化済みの入力に対して実行）
  var l2Result = null;
  if (parsed && catId && catRecord) {
    try {
      var parsedForL2 = Object.assign({}, parsed, { cat_id: catId });
      l2Result = await postCheck(parsedForL2, catRecord, env);

      if (l2Result && l2Result.dest !== 'save') {
        routingLayer = l2Result.dest;
        needsFurther = true;
      }
    } catch (e) {
      console.warn('L2 postCheck error (non-fatal):', e && e.message);
    }
  }

  // 7. voice_inputs に保存
  var voiceResult = await db.prepare(
    'INSERT INTO voice_inputs (staff_id, location_id, raw_transcript, parsed_data, target_module, target_cat_id, routing_layer, status, created_records) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).bind(
    staffAuth.staffId,
    staffAuth.locationId,
    rawText,
    parsed ? JSON.stringify(parsed) : null,
    parsed ? parsed.module : null,
    catId,
    routingLayer,
    parsed ? 'completed' : 'processing',
    null
  ).first();

  var voiceInputId = voiceResult.id;

  // 8. 構造化成功 → 対応テーブルへ自動変換して保存
  var createdRecords = [];
  if (parsed && catId) {
    createdRecords = await saveStructuredRecords(db, parsed, catId, staffAuth, voiceInputId, rawText);
  }

  // created_records を更新
  if (createdRecords.length > 0) {
    await db.prepare(
      'UPDATE voice_inputs SET created_records = ?, status = ? WHERE id = ?'
    ).bind(JSON.stringify(createdRecords), 'completed', voiceInputId).run();
  }

  // 8. L3 呼出（L2 が dest=L3 のとき同期実行）
  var l3Result = null;
  if (l2Result && l2Result.dest === 'L3' && catId && catRecord) {
    try {
      // 直近7日の健康記録を取得（L3 プロンプトのコンテキスト用）
      var sevenDaysAgo = jstCalendarAddDays(jstCalendarYmdFromInstant(Date.now()), -7);
      var recentLogsResult = await db.prepare(
        "SELECT record_type, record_date, value, details FROM health_records WHERE cat_id = ? AND record_date >= ? ORDER BY record_date DESC LIMIT 20"
      ).bind(catId, sevenDaysAgo).all();
      var recentLogs = recentLogsResult.results || [];

      var voiceInputForL3 = {
        raw_transcript: rawText,
        parsed_data: parsed ? JSON.stringify(parsed) : null,
        l2_reason: l2Result.reason || null,
      };

      // catRecord に追加フィールドを取得
      var catRecordFull = await db.prepare(
        'SELECT id, name, sex, alert_level, internal_note FROM cats WHERE id = ?'
      ).bind(catId).first();

      l3Result = await callL3(voiceInputForL3, catRecordFull || catRecord, recentLogs, env);

      await processL3Result(db, voiceInputId, catId, l3Result, staffAuth.locationId);
    } catch (e) {
      console.warn('L3 processing error (non-fatal):', e && e.message);
    }
  }

  // 9. L2 結果に基づく後処理: Slack 通知 + auto_action + alert_level 自動昇格
  var l2Info = null;
  if (l2Result) {
    l2Info = { dest: l2Result.dest, reason: l2Result.reason || null, flag: l2Result.flag || null };

    try {
      await dispatchSlackNotification(env, l2Result, {
        catRecord: catRecord,
        rawText: rawText,
        staffId: staffAuth.staffId,
        locationId: staffAuth.locationId,
      });
    } catch (e) {
      console.warn('Slack notification error (non-fatal):', e && e.message);
    }

    if (l2Result.auto_action && l2Result.auto_action.create_action_item) {
      try {
        var action = l2Result.auto_action.create_action_item;
        var dueDate = jstCalendarYmdFromInstant(Date.now() + (action.due_minutes || 60) * 60000);
        await db.prepare(
          'INSERT INTO action_items (source_module, source_id, cat_id, location_id, title, priority, due_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind('voice_input', String(voiceInputId), catId, staffAuth.locationId, action.title, 'high', dueDate, 'open', 'system').run();
      } catch (e) {
        console.warn('auto_action create error (non-fatal):', e && e.message);
      }
    }

    try {
      await autoEscalateAlertLevel(db, catId, l2Result);
    } catch (e) {
      console.warn('autoEscalateAlertLevel error (non-fatal):', e && e.message);
    }
  }

  // 10. フォローアップ構造を生成（UIチャット用）
  var followup = buildFollowup(l2Result, catRecord, catName, voiceInputId, parsed);

  // 11. 確認ポップアップ用メッセージを生成
  var confirmation = buildConfirmation(parsed, catName, createdRecords, routingLayer, l2Result, l3Result, resolvedProduct);

  // 12. 拠点内の未確認ごはんアラート（6時間超過）
  var overdueAlerts = [];
  try {
    overdueAlerts = await findOverdueFeedingChecks(db, staffAuth.locationId);
  } catch (_) {}

  // 13. 自己修復: misrecognition_log の頻出パターンを自動辞書追加
  try { await autoRepairDictionary(db); } catch (_) {}

  return opsJson({
    ok: true,
    voice_input_id: voiceInputId,
    cat: catId ? { id: catId, name: catName } : null,
    product: resolvedProduct,
    routing_layer: routingLayer,
    parsed: parsed,
    records_created: createdRecords,
    needs_further_processing: needsFurther,
    l2: l2Info,
    l3: l3Result ? {
      analysis: l3Result.analysis || null,
      severity: l3Result.severity || null,
      action_proposal: l3Result.action_proposal || null,
      needs_deeper: l3Result.needs_deeper || false,
    } : null,
    followup: followup,
    confirmation: confirmation,
    overdue_feeding_checks: overdueAlerts.length > 0 ? overdueAlerts : null,
  }, 201);
}

var COMPLETENESS_RULES = {
  stool: {
    fields: ['consistency'],
    question: '状態は？',
    options: [
      { id: 'stool_hard',   label: 'コロコロ/硬い', field: 'consistency', value: 'hard' },
      { id: 'stool_normal', label: '普通',          field: 'consistency', value: 'normal' },
      { id: 'stool_soft',   label: '軟便',          field: 'consistency', value: 'soft' },
      { id: 'stool_liquid', label: '水様/下痢',     field: 'consistency', value: 'liquid' },
    ],
  },
  vomiting: {
    fields: ['content'],
    question: '何を吐いた？',
    options: [
      { id: 'vomit_hair',   label: '毛玉',      field: 'content', value: 'hairball' },
      { id: 'vomit_food',   label: '未消化フード', field: 'content', value: 'undigested_food' },
      { id: 'vomit_liquid', label: '胃液/泡',    field: 'content', value: 'gastric_fluid' },
      { id: 'vomit_other',  label: 'その他/不明', field: 'content', value: 'other' },
    ],
  },
  behavior: {
    fields: ['severity'],
    question: 'どのくらい気になる？',
    options: [
      { id: 'beh_minor', label: 'ちょっと気になる程度', field: 'severity', value: 'minor' },
      { id: 'beh_moderate', label: '明らかにいつもと違う', field: 'severity', value: 'moderate' },
      { id: 'beh_serious', label: 'かなり心配', field: 'severity', value: 'serious' },
    ],
  },
};

function buildFollowup(l2Result, catRecord, catName, voiceInputId, parsed) {
  var name = catName || (catRecord && catRecord.name) || '';

  // --- 血便系フォローアップ（L2 起因・優先） ---
  if (l2Result) {
    if (l2Result.flag === 'chronic_blood') {
      if (!l2Result.slack_msg) return null;
      return {
        type: 'gentle_confirm',
        voice_input_id: voiceInputId,
        message: name + '血便 記録しました（いつもの）',
        sub_message: 'いつもと違う場合だけタップ:',
        options: [
          { id: 'blood_heavy', label: '量が多い', escalate: 'L5' },
          { id: 'blood_dark',  label: '色が黒い', escalate: 'L4' },
          { id: 'blood_ok',    label: 'いつも通り', escalate: null },
        ],
      };
    }

    if (l2Result.reason && l2Result.reason.indexOf('軽度出血') !== -1 && l2Result.auto_action) {
      return {
        type: 'required_confirm',
        voice_input_id: voiceInputId,
        message: name + '血便 記録しました',
        sub_message: '量はどのくらい？',
        options: [
          { id: 'blood_light',  label: '少量', escalate: null },
          { id: 'blood_normal', label: '普通〜やや多め', escalate: 'L4' },
          { id: 'blood_heavy',  label: '明らかに多い/黒い', escalate: 'L5' },
        ],
        timeout_minutes: 30,
      };
    }
  }

  // --- 投薬: 複数薬選択 + 飲めた確認 ---
  if (!parsed) return null;
  var mod = parsed.module;
  var p = parsed.parsed || {};

  if (mod === 'medication') {
    var medInfo = parsed._medInfo;
    if (!medInfo) return null;

    if (medInfo.all.length > 1 && !p._med_selected) {
      var opts = [];
      for (var i = 0; i < medInfo.all.length; i++) {
        opts.push({
          id: 'med_select_' + medInfo.all[i].id,
          label: formatMedLabel(medInfo.all[i]),
          medication_id: medInfo.all[i].id,
        });
      }
      var slotLabel = SLOT_LABELS[medInfo.slot] || medInfo.slot;
      return {
        type: 'med_select',
        voice_input_id: voiceInputId,
        message: name + ' ' + slotLabel + 'の投薬',
        sub_message: 'どの薬？',
        options: opts,
      };
    }

    var matched = medInfo.matched;
    if (!p.took) {
      var medLabel = matched ? formatMedLabel(matched) : '投薬';
      return {
        type: 'med_status',
        voice_input_id: voiceInputId,
        message: name + ' ' + medLabel + ' 記録しました',
        sub_message: '飲めた？',
        options: [
          { id: 'med_ok',      label: '飲めた',     field: 'took', value: 'ok' },
          { id: 'med_partial', label: '半分くらい',  field: 'took', value: 'partial' },
          { id: 'med_spit',    label: '吐き出した',  field: 'took', value: 'spit' },
          { id: 'med_refused', label: '拒否/未投与', field: 'took', value: 'refused' },
        ],
      };
    }

    return null;
  }

  // --- 食事: 複数食の提供選択 / 残量確認 ---
  if (mod === 'feeding') {
    var action = parsed._feedAction;
    var feedPlans = parsed._feedPlans;

    if (action === 'serve') {
      var plans = feedPlans ? feedPlans.all : [];
      if (plans.length === 0) return null;

      if (plans.length === 1 && parsed._feedServedPlan) {
        var plan = parsed._feedServedPlan;
        return {
          type: 'feed_served',
          voice_input_id: voiceInputId,
          message: name + ' ' + formatMealLabel(plan) + ' 提供しました',
          sub_message: null,
          options: null,
        };
      }

      var opts = [];
      for (var i = 0; i < plans.length; i++) {
        opts.push({
          id: 'serve_plan_' + plans[i].id,
          label: formatMealLabel(plans[i]),
          plan_id: plans[i].id,
        });
      }
      return {
        type: 'feed_select_serve',
        voice_input_id: voiceInputId,
        message: name + ' どのごはんを提供？',
        sub_message: null,
        options: opts,
      };
    }

    if (action === 'check') {
      var openLogs = parsed._feedOpenLogs || [];
      if (openLogs.length === 0) {
        return {
          type: 'feed_no_open',
          voice_input_id: voiceInputId,
          message: name + ' 今日の未確認ごはんがありません',
          sub_message: '先にごはんの提供を記録してください',
          options: null,
        };
      }

      if (openLogs.length === 1) {
        var log = openLogs[0];
        var servedAt = log.served_time ? log.served_time.slice(11, 16) : '';
        var desc = (log.food_name || '') + (log.offered_g ? ' ' + log.offered_g + 'g' : '');
        return {
          type: 'feed_check_remaining',
          voice_input_id: voiceInputId,
          feeding_log_id: log.id,
          message: name + ' ' + desc + (servedAt ? '（' + servedAt + '提供）' : ''),
          sub_message: '残りは？',
          options: buildRemainingOptions(log.offered_g),
        };
      }

      var opts = [];
      for (var i = 0; i < openLogs.length; i++) {
        var ol = openLogs[i];
        var orderChar = '①②③④⑤⑥⑦⑧'.charAt((ol.meal_order || 1) - 1);
        var servedAt = ol.served_time ? ol.served_time.slice(11, 16) : '';
        opts.push({
          id: 'check_log_' + ol.id,
          label: orderChar + ' ' + (ol.food_name || '?') + (ol.offered_g ? ' ' + ol.offered_g + 'g' : '') + (servedAt ? ' ' + servedAt + '提供' : ''),
          feeding_log_id: ol.id,
          offered_g: ol.offered_g,
        });
      }
      return {
        type: 'feed_select_check',
        voice_input_id: voiceInputId,
        message: name + ' どのごはんを確認？',
        sub_message: null,
        options: opts,
      };
    }

    return null;
  }

  // --- 汎用の欠損フィールド聞き返し ---
  var rule = COMPLETENESS_RULES[mod];
  if (!rule) return null;

  var missing = [];
  for (var i = 0; i < rule.fields.length; i++) {
    var f = rule.fields[i];
    if (!p[f] && p[f] !== 0) missing.push(f);
  }
  if (missing.length === 0) return null;

  var label = MODULE_LABELS[mod] || mod;
  return {
    type: 'detail_request',
    voice_input_id: voiceInputId,
    message: name + ' ' + label + ' 記録しました',
    sub_message: rule.question,
    options: rule.options,
    update_field: missing[0],
  };
}

var MODULE_LABELS = {
  health: '健康', stool: '排泄', vomiting: '嘔吐', behavior: '行動',
  weight: '体重', medication: '投薬', feeding: '食事', care: 'ケア', other: '記録',
};

function jstTimeLabel() {
  return jstCalendarHmFromInstant(Date.now());
}

function buildConfirmation(parsed, catName, createdRecords, routingLayer, l2Result, l3Result, resolvedProduct) {
  var name = catName || '';
  var icon = '✅';
  var time = jstTimeLabel();
  var parts = [];

  if (!parsed) {
    var pendingText = name ? name + ' ' : '';
    if (resolvedProduct) pendingText += resolvedProduct.name + ' ';
    return { icon: '📝', text: pendingText + '受付しました。処理中…', time: time };
  }

  var mod = parsed.module || 'other';
  var label = MODULE_LABELS[mod] || mod;
  var p = parsed.parsed || {};

  if (mod === 'stool') {
    var desc = [];
    if (p.consistency) desc.push(consistencyToJa(p.consistency, parsed.record_type === 'urination' || parsed.record_type === 'urine'));
    if (p.blood) desc.push('血' + p.blood);
    parts.push(label + (desc.length ? '（' + desc.join('・') + '）' : ''));
  } else if (mod === 'care') {
    parts.push('ケア（' + (p.details || '') + (p.done === false ? ' スキップ' : ' 実施') + '）');
  } else if (mod === 'vomiting') {
    var desc = [];
    if (p.content) desc.push(p.content);
    if (p.count) desc.push(p.count + '回');
    parts.push(label + (desc.length ? '（' + desc.join('・') + '）' : ''));
  } else if (mod === 'weight') {
    var val = p.amount || p.value || p.weight || '';
    parts.push(label + (val ? '（' + val + 'g）' : ''));
    var np = parsed._nutritionProfile;
    if (np) {
      var kg = np.weight_kg ? (Math.round(np.weight_kg * 100) / 100) + 'kg' : '';
      parts.push('→ 必要カロリー ' + np.target_kcal + 'kcal/日');
      if (np.weight_trend !== 'stable') {
        parts.push('(' + (np.weight_trend === 'losing' ? '↓減少傾向' : '↑増加傾向') + np.weight_trend_pct + '%)');
      }
    }
  } else if (mod === 'medication') {
    var medInfo = parsed._medInfo;
    if (medInfo && medInfo.matched) {
      parts.push('投薬（' + formatMedLabel(medInfo.matched) + '）');
    } else {
      parts.push('投薬' + (p.medicine_name ? '（' + p.medicine_name + '）' : ''));
    }
  } else if (mod === 'feeding') {
    var feedAction = parsed._feedAction;
    if (feedAction === 'serve' && parsed._feedServedPlan) {
      parts.push(formatMealLabel(parsed._feedServedPlan) + ' 提供');
    } else if (feedAction === 'serve') {
      parts.push('ごはん提供 → 選択してください');
    } else if (feedAction === 'check') {
      parts.push('ごはん残量確認');
    } else {
      parts.push(label);
    }
  } else {
    parts.push(label);
  }

  if (createdRecords.length > 0) {
    parts.push('→ 保存済み');
  }

  if (l2Result && l2Result.dest && l2Result.dest !== 'save') {
    icon = l2Result.dest === 'L5' ? '🔴' : '⚠️';
    parts.push(l2Result.reason || '');
  }

  if (l3Result && l3Result.action_proposal) {
    parts.push('💡 ' + l3Result.action_proposal);
  }

  var prodLabel = (resolvedProduct && resolvedProduct.name) ? '【' + resolvedProduct.name + '】' : '';
  return {
    icon: icon,
    text: (name ? name + ' ' : '') + prodLabel + parts.join(' '),
    time: time,
  };
}

/**
 * POST /api/ops/voice/followup — フォローアップ選択の処理
 */
async function handleFollowup(req, env, db, staffAuth) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }

  var voiceInputId = body.voice_input_id;
  var selectedOption = body.selected_option;
  if (!voiceInputId || !selectedOption) {
    return opsJson({ error: 'bad_request', message: 'voice_input_id and selected_option required' }, 400);
  }

  var original = await db.prepare(
    'SELECT * FROM voice_inputs WHERE id = ?'
  ).bind(voiceInputId).first();
  if (!original) {
    return opsJson({ error: 'not_found', message: 'voice_input not found' }, 404);
  }

  var catId = original.target_cat_id;
  var catRecord = null;
  if (catId) {
    catRecord = await db.prepare('SELECT id, name, alert_level, internal_note FROM cats WHERE id = ?').bind(catId).first();
  }

  // --- 投薬: 薬選択 (med_select_<id>) ---
  if (selectedOption.indexOf('med_select_') === 0) {
    var medicationId = parseInt(selectedOption.replace('med_select_', ''), 10);
    var createdRecords = original.created_records;
    if (createdRecords) {
      try {
        var recs = JSON.parse(createdRecords);
        for (var i = 0; i < recs.length; i++) {
          if (recs[i].indexOf('medication_logs:') === 0) {
            var logId = recs[i].split(':')[1];
            await db.prepare('UPDATE medication_logs SET medication_id = ? WHERE id = ?').bind(medicationId, logId).run();
          }
        }
      } catch (_) {}
    }

    var medRow = await db.prepare(
      'SELECT m.id, m.dosage_amount, m.dosage_unit, m.time_slots, med.name AS medicine_name FROM medications m JOIN medicines med ON m.medicine_id = med.id WHERE m.id = ?'
    ).bind(medicationId).first();
    var medLabel = medRow ? formatMedLabel(medRow) : '投薬';
    var catName = (catRecord && catRecord.name) || '';

    return opsJson({
      ok: true,
      voice_input_id: voiceInputId,
      selected_option: selectedOption,
      message: '✅ ' + catName + ' ' + medLabel + ' を選択しました',
      followup: {
        type: 'med_status',
        voice_input_id: voiceInputId,
        message: catName + ' ' + medLabel,
        sub_message: '飲めた？',
        options: [
          { id: 'med_ok',      label: '飲めた',     field: 'took', value: 'ok' },
          { id: 'med_partial', label: '半分くらい',  field: 'took', value: 'partial' },
          { id: 'med_spit',    label: '吐き出した',  field: 'took', value: 'spit' },
          { id: 'med_refused', label: '拒否/未投与', field: 'took', value: 'refused' },
        ],
      },
      confirmation: { icon: '💊', text: catName + ' ' + medLabel + ' を選択' },
    });
  }

  // --- 投薬ステータス: medication_logs.status を更新 ---
  if (selectedOption.indexOf('med_') === 0 && (selectedOption === 'med_ok' || selectedOption === 'med_partial' || selectedOption === 'med_spit' || selectedOption === 'med_refused')) {
    var statusMap = { med_ok: 'done', med_partial: 'partial', med_spit: 'spit', med_refused: 'skipped' };
    var skipReasonMap = { med_spit: '吐き出し', med_refused: '拒否/未投与' };
    var newStatus = statusMap[selectedOption] || 'done';
    var skipReason = skipReasonMap[selectedOption] || null;

    var createdRecords = original.created_records;
    if (createdRecords) {
      try {
        var recs = JSON.parse(createdRecords);
        for (var i = 0; i < recs.length; i++) {
          if (recs[i].indexOf('medication_logs:') === 0) {
            var logId = recs[i].split(':')[1];
            await db.prepare(
              'UPDATE medication_logs SET status = ?, skip_reason = ? WHERE id = ?'
            ).bind(newStatus, skipReason, logId).run();
          }
        }
      } catch (_) {}
    }

    var catName = (catRecord && catRecord.name) || '';
    var isWarning = selectedOption === 'med_spit' || selectedOption === 'med_refused';
    var icon = isWarning ? '⚠️' : '✅';
    var msgMap = {
      med_ok: '飲めました',
      med_partial: '半分くらい飲めました',
      med_spit: '吐き出し → 獣医に相談を検討',
      med_refused: '拒否/未投与 → 投与方法の見直しを検討',
    };
    var msg = icon + ' ' + catName + ' ' + (msgMap[selectedOption] || '記録しました');

    await db.prepare(
      'UPDATE voice_inputs SET status = ? WHERE id = ?'
    ).bind('completed', voiceInputId).run();

    return opsJson({
      ok: true,
      voice_input_id: voiceInputId,
      selected_option: selectedOption,
      message: msg,
      confirmation: { icon: icon, text: msg },
    });
  }

  // --- 食事: 提供する食事を選択 (serve_plan_<id>) ---
  if (selectedOption.indexOf('serve_plan_') === 0) {
    var planId = parseInt(selectedOption.replace('serve_plan_', ''), 10);
    var plan = await db.prepare(
      'SELECT fp.id, fp.meal_slot, fp.meal_order, fp.amount_g, fp.food_id, fp.scheduled_time, f.name AS food_name, f.kcal_per_100g FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.id = ?'
    ).bind(planId).first();

    if (plan) {
      var now = jstNow();
      var today = jstToday();
      var result = await db.prepare(
        'INSERT INTO feeding_logs (cat_id, log_date, meal_slot, meal_order, plan_id, food_id, offered_g, served_time, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).bind(
        catId, today, plan.meal_slot || getCurrentSlot(), plan.meal_order || 1,
        plan.id, plan.food_id, plan.amount_g, now, staffAuth.staffId
      ).first();

      var catName = (catRecord && catRecord.name) || '';
      var label = formatMealLabel(plan);
      var msg = '✅ ' + catName + ' ' + label + ' 提供しました';

      return opsJson({
        ok: true,
        voice_input_id: voiceInputId,
        selected_option: selectedOption,
        message: msg,
        confirmation: { icon: '✅', text: msg, time: jstTimeLabel() },
      });
    }
  }

  // --- 食事: 確認する食事を選択 (check_log_<id>) ---
  if (selectedOption.indexOf('check_log_') === 0) {
    var feedingLogId = parseInt(selectedOption.replace('check_log_', ''), 10);
    var log = await db.prepare(
      'SELECT fl.id, fl.offered_g, fl.served_time, fl.meal_order, f.name AS food_name FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id WHERE fl.id = ?'
    ).bind(feedingLogId).first();

    if (log) {
      var catName = (catRecord && catRecord.name) || '';
      var servedAt = log.served_time ? log.served_time.slice(11, 16) : '';
      var desc = (log.food_name || '') + (log.offered_g ? ' ' + log.offered_g + 'g' : '');
      return opsJson({
        ok: true,
        voice_input_id: voiceInputId,
        selected_option: selectedOption,
        message: catName + ' ' + desc + (servedAt ? '（' + servedAt + '提供）' : ''),
        followup: {
          type: 'feed_check_remaining',
          voice_input_id: voiceInputId,
          feeding_log_id: log.id,
          message: catName + ' ' + desc,
          sub_message: '残りは？',
          options: buildRemainingOptions(log.offered_g),
        },
      });
    }
  }

  // --- 食事: 残量選択 (remain_0/remain_15/remain_50/remain_85/remain_100) ---
  if (selectedOption.indexOf('remain_') === 0) {
    var feedingLogId = body.feeding_log_id;
    var remainingG = body.remaining_g;

    if (remainingG === undefined || remainingG === null) {
      var remainMap = { remain_0: 0, remain_15: 0.15, remain_50: 0.5, remain_85: 0.85, remain_100: 1.0 };
      var ratio = remainMap[selectedOption];
      if (ratio !== undefined && feedingLogId) {
        var logRow = await db.prepare('SELECT offered_g FROM feeding_logs WHERE id = ?').bind(feedingLogId).first();
        remainingG = logRow ? Math.round((logRow.offered_g || 0) * ratio) : 0;
      }
    }

    if (feedingLogId && remainingG !== undefined) {
      var logFull = await db.prepare(
        'SELECT fl.offered_g, fl.food_id, f.name AS food_name, f.kcal_per_100g FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id WHERE fl.id = ?'
      ).bind(feedingLogId).first();

      var eaten = calcEaten(logFull.offered_g, remainingG, logFull.kcal_per_100g);
      var now = jstNow();

      await db.prepare(
        'UPDATE feeding_logs SET remaining_g = ?, eaten_g = ?, eaten_pct = ?, eaten_kcal = ?, checked_time = ?, recorded_by = ? WHERE id = ?'
      ).bind(eaten.eaten_g, eaten.eaten_g, eaten.eaten_pct, eaten.eaten_kcal, now, staffAuth.staffId, feedingLogId).run();

      await db.prepare(
        'UPDATE voice_inputs SET status = ? WHERE id = ?'
      ).bind('completed', voiceInputId).run();

      var summary = null;
      if (catId) {
        try {
          summary = await getDailyNutritionSummary(db, catId);
        } catch (_) {}
      }

      var catName = (catRecord && catRecord.name) || '';
      var foodName = logFull.food_name || '';
      var isWarning = eaten.eaten_pct <= 10;
      var icon = isWarning ? '⚠️' : '✅';
      var msg = icon + ' ' + catName + ' ' + foodName + ' '
        + eaten.eaten_g + 'g/' + (logFull.offered_g || '?') + 'g食べた'
        + (eaten.eaten_kcal ? '（' + eaten.eaten_kcal + 'kcal）' : '');

      if (summary) {
        msg += '\n' + formatNutritionSummary(summary);
      }

      if (eaten.eaten_pct === 0) msg += '\n⚠️ 食欲不振が続くなら要注意';

      var deficitInfo = null;
      if (catId) {
        try {
          deficitInfo = await detectCalorieDeficit(db, catId);
          if (deficitInfo && deficitInfo.alert) {
            msg += '\n🔴 直近7日中' + deficitInfo.deficit_days + '日がカロリー不足（<70%）';
          }
        } catch (_) {}
      }

      return opsJson({
        ok: true,
        voice_input_id: voiceInputId,
        selected_option: selectedOption,
        remaining_g: remainingG,
        eaten: eaten,
        daily_summary: summary,
        calorie_deficit: deficitInfo,
        message: msg,
        confirmation: { icon: icon, text: msg, time: jstTimeLabel() },
      });
    }
  }

  // --- 汎用 detail_request: parsed_data にフィールドを追記 ---
  var matchedOption = findOptionById(selectedOption);
  if (matchedOption && matchedOption.field) {
    var parsedData = {};
    try { parsedData = JSON.parse(original.parsed_data || '{}'); } catch (_) {}
    var inner = parsedData.parsed || parsedData;
    inner[matchedOption.field] = matchedOption.value;
    parsedData.parsed = inner;

    await db.prepare(
      'UPDATE voice_inputs SET parsed_data = ?, status = ? WHERE id = ?'
    ).bind(JSON.stringify(parsedData), 'completed', voiceInputId).run();

    if (catId && original.created_records) {
      try {
        await updateHealthRecordDetail(db, original.created_records, matchedOption.field, matchedOption.value);
      } catch (_) {}
    }

    var needsAttention = isAttentionOption(selectedOption);
    var responseMessage = needsAttention
      ? '⚠️ ' + matchedOption.value + ' で更新しました。注意して観察します。'
      : '✅ ' + matchedOption.label + ' で記録を更新しました。';

    return opsJson({
      ok: true,
      voice_input_id: voiceInputId,
      selected_option: selectedOption,
      escalated_to: null,
      message: responseMessage,
      confirmation: { icon: needsAttention ? '⚠️' : '✅', text: responseMessage },
    });
  }

  // --- 血便系エスカレーション ---
  var escalateTo = null;
  var responseMessage = '';

  if (selectedOption === 'blood_heavy') {
    escalateTo = 'L5';
    responseMessage = '🔴 大量出血として緊急対応します。受診を手配してください。';
  } else if (selectedOption === 'blood_dark') {
    escalateTo = 'L4';
    responseMessage = '⚠️ 黒い血便は消化管上部出血の可能性。注意深く経過観察し、続くなら受診を。';
  } else if (selectedOption === 'blood_normal') {
    escalateTo = 'L4';
    responseMessage = '⚠️ やや多めの出血を記録。経過を注視します。';
  } else if (selectedOption === 'blood_light') {
    escalateTo = null;
    responseMessage = '✅ 少量で記録しました。経過観察します。';
  } else if (selectedOption === 'blood_ok') {
    escalateTo = null;
    responseMessage = '✅ いつも通りで記録しました。';
  } else {
    responseMessage = '✅ 回答を記録しました。';
  }

  if (escalateTo) {
    await db.prepare(
      'UPDATE voice_inputs SET routing_layer = ?, status = ? WHERE id = ?'
    ).bind(escalateTo, 'escalated', voiceInputId).run();

    if (catId) {
      try {
        await autoEscalateAlertLevel(db, catId, { dest: escalateTo, reason: 'followup: ' + selectedOption });
      } catch (_) {}
    }

    if (escalateTo === 'L5') {
      try {
        await dispatchSlackNotification(env, {
          dest: 'L5',
          reason: 'フォローアップで重度確認',
          slack_msg: (catRecord && catRecord.name || '') + ': フォローアップで大量出血/重度確認 → 至急受診',
        }, {
          catRecord: catRecord,
          rawText: original.raw_transcript,
          staffId: staffAuth.staffId,
          locationId: staffAuth.locationId,
        });
      } catch (_) {}
    }
  } else {
    await db.prepare(
      'UPDATE voice_inputs SET status = ? WHERE id = ?'
    ).bind('completed', voiceInputId).run();
  }

  return opsJson({
    ok: true,
    voice_input_id: voiceInputId,
    selected_option: selectedOption,
    escalated_to: escalateTo,
    message: responseMessage,
    confirmation: { icon: escalateTo ? '⚠️' : '✅', text: responseMessage },
  });
}

function findOptionById(optionId) {
  var modules = Object.keys(COMPLETENESS_RULES);
  for (var i = 0; i < modules.length; i++) {
    var opts = COMPLETENESS_RULES[modules[i]].options;
    for (var j = 0; j < opts.length; j++) {
      if (opts[j].id === optionId) return opts[j];
    }
  }
  return null;
}

var ATTENTION_OPTIONS = ['stool_liquid', 'vomit_other', 'feed_zero', 'feed_few', 'med_spit', 'med_refused', 'beh_serious', 'beh_moderate'];

function isAttentionOption(optionId) {
  return ATTENTION_OPTIONS.indexOf(optionId) !== -1;
}

async function updateHealthRecordDetail(db, createdRecordsJson, field, value) {
  var records = [];
  try { records = JSON.parse(createdRecordsJson); } catch (_) { return; }
  for (var i = 0; i < records.length; i++) {
    var parts = records[i].split(':');
    if (parts[0] !== 'health_records') continue;
    var recordId = parts[1];
    var row = await db.prepare('SELECT details FROM health_records WHERE id = ?').bind(recordId).first();
    if (!row) continue;
    var details = {};
    try { details = JSON.parse(row.details || '{}'); } catch (_) {}
    details[field] = value;
    await db.prepare('UPDATE health_records SET details = ? WHERE id = ?').bind(JSON.stringify(details), recordId).run();
  }
}

var STOOL_LABEL = { normal: '健康', hard: '硬い', soft: '軟便', liquid: '下痢', recorded: '記録あり' };
var URINE_LABEL = { normal: '普通', hard: '多い', soft: '少量', liquid: 'なし（異常）', recorded: '記録あり' };

function consistencyToJa(code, recordType) {
  if (!code) return null;
  if (recordType === 'urination' || recordType === 'urine') return URINE_LABEL[code] || code;
  return STOOL_LABEL[code] || code;
}

/**
 * 構造化結果 → 対応テーブルへレコード保存
 */
async function saveStructuredRecords(db, parsed, catId, staffAuth, voiceInputId, rawText) {
  var records = [];
  var mod = parsed.module;
  var p = parsed.parsed || {};
  var today = jstToday();
  var now = jstNow();

  try {
    if (mod === 'health' || mod === 'stool' || mod === 'vomiting' || mod === 'behavior') {
      var recordType = parsed.record_type || p.symptom || mod;
      var rawValue = p.status || p.symptom || null;
      var value = consistencyToJa(rawValue, recordType) || rawValue;
      var details = JSON.stringify(p);

      var result = await db.prepare(
        'INSERT INTO health_records (cat_id, location_id, record_type, record_date, recorded_time, value, details, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).bind(
        catId, staffAuth.locationId, recordType, today, now, value, details, staffAuth.staffId
      ).first();

      records.push('health_records:' + result.id);
    }

    if (mod === 'weight') {
      var weightVal = p.amount || p.value || p.weight || null;
      var details = JSON.stringify(p);

      var result = await db.prepare(
        'INSERT INTO health_records (cat_id, location_id, record_type, record_date, recorded_time, value, details, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).bind(
        catId, staffAuth.locationId, 'weight', today, now, weightVal, details, staffAuth.staffId
      ).first();

      records.push('health_records:' + result.id);

      try {
        var profile = await refreshNutritionProfile(db, catId);
        if (profile) parsed._nutritionProfile = profile;
      } catch (_) {}
    }

    if (mod === 'medication') {
      var medInfo = await inferMedication(db, catId);
      if (medInfo.matched) {
        var slotLabel = SLOT_LABELS[medInfo.slot] || medInfo.slot;
        var result = await db.prepare(
          'INSERT INTO medication_logs (medication_id, cat_id, scheduled_at, administered_at, status, administered_by, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
        ).bind(
          medInfo.matched.id,
          catId,
          now,
          now,
          'done',
          staffAuth.staffId,
          slotLabel + ' voice input #' + voiceInputId
        ).first();

        records.push('medication_logs:' + result.id);
        parsed._medInfo = medInfo;
      }
    }

    if (mod === 'care') {
      var careDetails = p.details || null;
      var careDone = p.done !== false;
      var careValue = careDone ? staffAuth.staffId : '×';

      if (careDetails) {
        var careResult = await db.prepare(
          'INSERT INTO health_records (cat_id, location_id, record_type, record_date, recorded_time, value, details, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
        ).bind(
          catId, staffAuth.locationId, parsed.record_type, today, now, careValue, careDetails, staffAuth.staffId
        ).first();

        records.push('health_records:' + careResult.id);
      }
    }

    if (mod === 'feeding') {
      var isCheck = p.action === 'check' || (rawText && (rawText.indexOf('確認') !== -1 || rawText.indexOf('残') !== -1));
      var feedInfo = await inferFeedingPlan(db, catId);
      parsed._feedPlans = feedInfo;

      if (isCheck) {
        var openLogs = await findOpenFeedingLog(db, catId);
        parsed._feedOpenLogs = openLogs;
        parsed._feedAction = 'check';
      } else {
        parsed._feedAction = 'serve';
        var plans = feedInfo.all;
        if (plans.length === 1) {
          var plan = plans[0];
          var result = await db.prepare(
            'INSERT INTO feeding_logs (cat_id, log_date, meal_slot, meal_order, plan_id, food_id, offered_g, served_time, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
          ).bind(
            catId, today, feedInfo.slot, plan.meal_order || 1,
            plan.id, plan.food_id, plan.amount_g || null, now, staffAuth.staffId
          ).first();
          records.push('feeding_logs:' + result.id);
          parsed._feedServedPlan = plan;
        }
      }
    }
  } catch (e) {
    console.warn('saveStructuredRecords error:', e && e.message);
  }

  return records;
}

var SLOT_LABELS = { morning: '朝', afternoon: '昼', evening: '夕' };

function getCurrentSlot() {
  var h = jstHour();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/**
 * その猫の active な medications を薬名・用量付きで取得。
 * 返り値: { matched: <best match>, all: [...], slot: 'morning'|... }
 */
async function inferMedication(db, catId) {
  var rows = await db.prepare(
    'SELECT m.id, m.time_slots, m.dosage_amount, m.dosage_unit, m.frequency, med.name AS medicine_name, med.form AS medicine_form FROM medications m JOIN medicines med ON m.medicine_id = med.id WHERE m.cat_id = ? AND m.active = 1'
  ).bind(catId).all();

  var meds = rows.results || [];
  if (meds.length === 0) return { matched: null, all: [], slot: getCurrentSlot() };

  var slot = getCurrentSlot();

  if (meds.length === 1) {
    return { matched: meds[0], all: meds, slot: slot };
  }

  for (var i = 0; i < meds.length; i++) {
    var slots = meds[i].time_slots || '';
    if (slots.indexOf(slot) !== -1) {
      return { matched: meds[i], all: meds, slot: slot };
    }
  }

  return { matched: meds[0], all: meds, slot: slot };
}

function formatMedLabel(med) {
  var parts = [med.medicine_name || '?'];
  if (med.dosage_amount) {
    parts.push(med.dosage_amount + (med.dosage_unit || ''));
  }
  if (med.time_slots) {
    var slots = med.time_slots.split(',');
    var labels = [];
    for (var i = 0; i < slots.length; i++) {
      labels.push(SLOT_LABELS[slots[i].trim()] || slots[i].trim());
    }
    parts.push(labels.join('/'));
  }
  return parts.join(' ');
}

/**
 * 猫の feeding_plan を全件取得（meal_order 順）
 */
async function inferFeedingPlan(db, catId) {
  var rows = await db.prepare(
    'SELECT fp.id, fp.meal_slot, fp.meal_order, fp.amount_g, fp.scheduled_time, fp.target_kcal, fp.food_id, fp.notes, f.name AS food_name, f.brand, f.category, f.kcal_per_100g FROM feeding_plans fp JOIN foods f ON fp.food_id = f.id WHERE fp.cat_id = ? AND fp.active = 1 ORDER BY fp.meal_order ASC'
  ).bind(catId).all();

  var plans = rows.results || [];
  var slot = getCurrentSlot();

  for (var i = 0; i < plans.length; i++) {
    var p = plans[i];
    if (!p.target_kcal && p.amount_g && p.kcal_per_100g) {
      p.target_kcal = Math.round(p.amount_g * p.kcal_per_100g / 100 * 10) / 10;
    }
  }

  return { all: plans, slot: slot };
}

function formatMealLabel(plan) {
  var order = plan.meal_order || 1;
  var time = plan.scheduled_time || '';
  var food = plan.food_name || '?';
  var g = plan.amount_g ? plan.amount_g + 'g' : '';
  return '①②③④⑤⑥⑦⑧'.charAt(order - 1) + ' ' + (time ? time + ' ' : '') + food + (g ? ' ' + g : '');
}

/**
 * 今日の未確認（remaining_g IS NULL）の feeding_log を検索
 */
async function findOpenFeedingLog(db, catId) {
  var today = jstToday();
  var rows = await db.prepare(
    'SELECT fl.id, fl.meal_slot, fl.meal_order, fl.offered_g, fl.served_time, fl.food_id, fl.plan_id, fl.note, f.name AS food_name, f.kcal_per_100g FROM feeding_logs fl LEFT JOIN foods f ON fl.food_id = f.id WHERE fl.cat_id = ? AND fl.log_date = ? AND fl.remaining_g IS NULL ORDER BY fl.meal_order ASC'
  ).bind(catId, today).all();

  return rows.results || [];
}

/**
 * 残量(g)からカロリー計算
 */
function calcEaten(offeredG, remainingG, kcalPer100g) {
  var eatenG = Math.max(0, (offeredG || 0) - (remainingG || 0));
  var eatenPct = offeredG > 0 ? Math.round(eatenG / offeredG * 100) : 0;
  var eatenKcal = kcalPer100g ? Math.round(eatenG * kcalPer100g / 100 * 10) / 10 : 0;
  return { eaten_g: eatenG, eaten_pct: eatenPct, eaten_kcal: eatenKcal };
}

/**
 * offered_g に基づいて残量選択肢を動的生成
 */
function buildRemainingOptions(offeredG) {
  var g = offeredG || 60;
  return [
    { id: 'remain_0',   label: '完食',           remaining_g: 0 },
    { id: 'remain_15',  label: '少し残し（~' + Math.round(g * 0.15) + 'g）', remaining_g: Math.round(g * 0.15) },
    { id: 'remain_50',  label: '半分（~' + Math.round(g * 0.5) + 'g）',      remaining_g: Math.round(g * 0.5) },
    { id: 'remain_85',  label: 'ほぼ残し（~' + Math.round(g * 0.85) + 'g）', remaining_g: Math.round(g * 0.85) },
    { id: 'remain_100', label: '食べてない（' + g + 'g）',                    remaining_g: g },
  ];
}

function linkedHealthRecordIdFromCreated(createdRecordsJson) {
  if (!createdRecordsJson) return null;
  try {
    var arr = JSON.parse(createdRecordsJson);
    if (!Array.isArray(arr)) return null;
    for (var i = 0; i < arr.length; i++) {
      var s = String(arr[i] || '');
      if (s.indexOf('health_records:') === 0) {
        var hid = parseInt(s.split(':')[1], 10);
        if (!isNaN(hid)) return hid;
      }
    }
  } catch (_) {}
  return null;
}

function jaToExcretionCode(valueJa, isUrine) {
  if (!valueJa) return 'recorded';
  if (isUrine) {
    var um = {
      '普通': 'normal', '多い': 'hard', '少量': 'soft',
      'なし（異常）': 'liquid', 'なし': 'normal',
      '血尿小': 'recorded', '血尿大（異常）': 'recorded',
    };
    return um[valueJa] || valueJa;
  }
  var sm = {
    '健康': 'normal', '硬い': 'hard', '軟便': 'soft', '下痢': 'liquid',
    '血便小': 'recorded', '血便大（異常）': 'recorded',
  };
  return sm[valueJa] || valueJa;
}

/**
 * PUT /api/ops/voice/inputs/:id/excretion
 * 猫一覧「項目ごと」から音声ソースの排便・排尿を修正（parsed_data + 紐づく health_records があれば同期）
 */
async function correctVoiceExcretion(req, db, staffAuth, voiceInputId) {
  var body;
  try { body = await req.json(); } catch (_) {
    return opsJson({ error: 'bad_request', message: 'Invalid JSON' }, 400);
  }
  var valueJa = body.value;
  var detailsSlot = body.details !== undefined ? body.details : null;
  var recordDate = body.record_date;
  if (!valueJa || !recordDate) {
    return opsJson({ error: 'bad_request', message: 'value と record_date が必要です' }, 400);
  }

  var row = await db.prepare('SELECT * FROM voice_inputs WHERE id = ?').bind(voiceInputId).first();
  if (!row) return opsJson({ error: 'not_found', message: 'voice_input not found' }, 404);

  if (staffAuth.locationId && row.location_id && row.location_id !== staffAuth.locationId) {
    return opsJson({ error: 'forbidden', message: '別拠点の入力です' }, 403);
  }

  var pd = {};
  try { pd = JSON.parse(row.parsed_data || '{}'); } catch (_) {}
  var inner = pd.parsed && typeof pd.parsed === 'object' ? Object.assign({}, pd.parsed) : {};
  var rt0 = pd.record_type || inner.record_type || '';
  var isUrine = rt0 === 'urination' || rt0 === 'urine';

  var code = jaToExcretionCode(valueJa, isUrine);
  inner.consistency = code;
  inner.status = code;
  if (detailsSlot) inner.slot = detailsSlot;
  else delete inner.slot;

  pd.parsed = inner;
  if (!pd.record_type) pd.record_type = isUrine ? 'urination' : 'stool';
  if (!pd.module && (row.target_module === 'stool' || row.target_module === 'health')) pd.module = 'stool';

  await db.prepare('UPDATE voice_inputs SET parsed_data = ? WHERE id = ?')
    .bind(JSON.stringify(pd), voiceInputId).run();

  var linked = linkedHealthRecordIdFromCreated(row.created_records);
  if (linked) {
    var hr = await db.prepare('SELECT id, cat_id FROM health_records WHERE id = ?').bind(linked).first();
    if (hr && hr.cat_id === row.target_cat_id) {
      var detStr = detailsSlot || null;
      await db.prepare(
        "UPDATE health_records SET value = ?, details = ?, record_date = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(valueJa, detStr, recordDate, linked).run();
    }
  }

  return opsJson({ ok: true, voice_input_id: voiceInputId });
}

/**
 * DELETE /api/ops/voice/inputs/:id/excretion
 * 音声のみの排泄行を削除（紐づく health_records も削除）
 */
async function deleteVoiceExcretion(db, staffAuth, voiceInputId) {
  var row = await db.prepare('SELECT * FROM voice_inputs WHERE id = ?').bind(voiceInputId).first();
  if (!row) return opsJson({ error: 'not_found', message: 'voice_input not found' }, 404);

  if (staffAuth.locationId && row.location_id && row.location_id !== staffAuth.locationId) {
    return opsJson({ error: 'forbidden', message: '別拠点の入力です' }, 403);
  }

  var linked = linkedHealthRecordIdFromCreated(row.created_records);
  if (linked) {
    var hr = await db.prepare('SELECT id, cat_id FROM health_records WHERE id = ?').bind(linked).first();
    if (hr && hr.cat_id === row.target_cat_id) {
      await db.prepare('DELETE FROM health_records WHERE id = ?').bind(linked).run();
    }
  }

  await db.prepare('DELETE FROM voice_inputs WHERE id = ?').bind(voiceInputId).run();
  return opsJson({ ok: true, deleted_id: voiceInputId });
}

async function handleHistory(url, db, staffAuth) {
  var limit = Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10) || 20);

  var rows = await db.prepare(
    'SELECT * FROM voice_inputs WHERE staff_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(staffAuth.staffId, limit).all();

  return opsJson({ inputs: rows.results || [] });
}

/**
 * GET /api/ops/voice/cat-card?cat_id=xxx
 */
async function handleCatCard(url, db) {
  var catId = url.searchParams.get('cat_id');
  if (!catId) {
    return opsJson({ error: 'bad_request', message: 'cat_id required' }, 400);
  }

  var card = await buildCatCard(db, catId);
  if (!card) {
    return opsJson({ error: 'not_found', message: 'Cat not found' }, 404);
  }

  return opsJson(card);
}

async function handleFoodSuggest(url, db) {
  var catId = url.searchParams.get('cat_id');
  if (!catId) {
    return opsJson({ error: 'bad_request', message: 'cat_id required' }, 400);
  }

  try {
    var suggestion = await buildFoodSuggestion(db, catId);
    return opsJson(suggestion);
  } catch (err) {
    return opsJson({ error: 'internal', message: err.message || 'Failed to build food suggestion' }, 500);
  }
}
