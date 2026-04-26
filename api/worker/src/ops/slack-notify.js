/**
 * NYAGI Slack Push 通知
 *
 * 送信対象:
 *   - L5 エスカレーション → #nyagi-alert @channel
 *   - alert_level → CRITICAL → #nyagi-alert @channel
 *   - template メッセージ（投薬拒否等） → 拠点チャンネル
 *   - 緊急語検知（血便等） → #nyagi-alert @channel
 *
 * SLACK_BOT_TOKEN 未設定時はログ出力のみ（MVP 段階）
 */

var EMERGENCY_KEYWORDS = ['血便', '血尿', '血を吐', '痙攣', 'けいれん', 'ぐったり', '骨折'];

/**
 * バイナリファイルを Slack にアップロードしチャンネルへ共有（files.getUploadURLExternal 系）
 * 成否は { ok, error?, files? }。Bot に files:write とチャンネルへの参加が必要。
 */
export async function shareBinaryFileToSlack(env, channelId, bytes, filename, initialComment) {
  var token = env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn('[slack-notify] SLACK_BOT_TOKEN not set — skipping file share');
    return { ok: false, error: 'not_authed' };
  }
  if (!bytes || !bytes.byteLength) return { ok: false, error: 'empty_file' };

  var res1 = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      filename: filename || 'file.bin',
      length: bytes.byteLength,
      alt_txt: initialComment ? String(initialComment).slice(0, 1000) : undefined,
    }),
  });
  var j1 = await res1.json();
  if (!j1 || !j1.ok || !j1.upload_url || !j1.file_id) {
    return { ok: false, error: (j1 && j1.error) || 'get_upload_url_failed' };
  }

  /** アップロード URL へは「宣言した length と完全一致するバイト列」を送る（ArrayBuffer ビューで余剰バイトが付くと Slack 側で失敗しうる） */
  var uploadBody = bytes;
  var uploadLen = bytes.byteLength;
  if (bytes instanceof Uint8Array && bytes.buffer && typeof bytes.buffer.slice === 'function') {
    uploadBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    uploadLen = uploadBody.byteLength;
  }

  var res2 = await fetch(j1.upload_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(uploadLen),
    },
    body: uploadBody,
  });
  if (!res2.ok) {
    return { ok: false, error: 'upload_bytes_failed', status: res2.status };
  }

  var res3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      files: [{ id: j1.file_id, title: filename || 'file' }],
      channel_id: channelId,
      initial_comment: initialComment ? String(initialComment) : '',
    }),
  });
  var j3 = await res3.json();
  if (!j3 || !j3.ok) {
    return { ok: false, error: (j3 && j3.error) || 'complete_upload_failed' };
  }
  return { ok: true, files: j3.files };
}

/**
 * Slack にメッセージを送信
 */
var SLACK_POST_MESSAGE_TIMEOUT_MS = 25000;

export async function sendSlackMessage(env, channel, text, blocks) {
  var token = env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn('[slack-notify] SLACK_BOT_TOKEN not set — skipping:', text);
    return null;
  }

  var ctrl = new AbortController();
  var timer = setTimeout(function () {
    try {
      ctrl.abort();
    } catch (_) {}
  }, SLACK_POST_MESSAGE_TIMEOUT_MS);

  try {
    var res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: channel,
        text: text,
        blocks: blocks || undefined,
      }),
    });
    var data = await res.json();
    if (!data.ok) {
      console.warn('[slack-notify] Slack API error:', data.error);
    }
    return data;
  } catch (e) {
    console.warn('[slack-notify] fetch error:', e && e.name, e && e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * L2 結果に基づいて適切な Slack 通知を送信
 *
 * @param {object} env
 * @param {object} l2Result  postCheck の戻り値
 * @param {object} context   { catRecord, rawText, staffId, locationId }
 */
export async function dispatchSlackNotification(env, l2Result, context) {
  var alertChannel = env.SLACK_ALERT_CHANNEL || '';
  var catName = (context.catRecord && context.catRecord.name) || '不明';

  // L5 エスカレーション
  if (l2Result.dest === 'L5') {
    var msg = '🚨 ' + catName + ': ' + (l2Result.reason || '要判断') + ' → 要判断';
    if (l2Result.slack_msg) msg = '🚨 ' + l2Result.slack_msg;
    await sendSlackMessage(env, alertChannel, '<!channel> ' + msg);
    return;
  }

  // L4 → CRITICAL
  if (l2Result.dest === 'L4') {
    var msg = '🚨 ' + catName + ' → CRITICAL（' + (l2Result.reason || '') + '）';
    await sendSlackMessage(env, alertChannel, '<!channel> ' + msg);
    return;
  }

  // template メッセージ（Slack にテンプレート送信）
  if (l2Result.slack_msg && l2Result.flag === 'template_action') {
    var templateMsg = '💊 ' + l2Result.slack_msg;
    var targetChannel = alertChannel;
    await sendSlackMessage(env, targetChannel, templateMsg);
    return;
  }

  // 投薬拒否テンプレート
  if (l2Result.slack_msg && l2Result.flag === 'med_refused_with_remedy') {
    var medMsg = '💊 ' + l2Result.slack_msg;
    await sendSlackMessage(env, alertChannel, medMsg);
    return;
  }

  // 緊急語検知チェック
  if (context.rawText) {
    for (var i = 0; i < EMERGENCY_KEYWORDS.length; i++) {
      if (context.rawText.indexOf(EMERGENCY_KEYWORDS[i]) !== -1) {
        var emergMsg = '🚨 ' + catName + ': ' + EMERGENCY_KEYWORDS[i] + ' 報告あり';
        await sendSlackMessage(env, alertChannel, '<!channel> ' + emergMsg);
        return;
      }
    }
  }
}

/**
 * 業務終了レポート（POST /tasks/close-day）と同じ考え方で拠点別 Slack チャンネル ID を返す。
 * cafe / nekomata は各 env。それ以外（遠藤宅・預かり等）でも SLACK_ALERT 未設定時は
 * SLACK_CHANNEL_CAFE → SLACK_CHANNEL_NEKOMATA の順にフォールバックし、レポートと同じ実チャンネルへ届くようにする。
 *
 * @param {object} env Cloudflare Worker env
 * @param {string} [locationId] cats.location_id / health_records.location_id 等
 * @returns {string} チャンネル ID（未設定時は空）
 */
export function resolveNyagiReportSlackChannel(env, locationId) {
  env = env || {};
  var loc = locationId == null || locationId === '' ? '' : String(locationId).trim();
  var cafe = env.SLACK_CHANNEL_CAFE && String(env.SLACK_CHANNEL_CAFE).trim();
  var neko = env.SLACK_CHANNEL_NEKOMATA && String(env.SLACK_CHANNEL_NEKOMATA).trim();
  var alert = env.SLACK_ALERT_CHANNEL && String(env.SLACK_ALERT_CHANNEL).trim();

  if (loc === 'cafe') return cafe || neko || alert || '';
  if (loc === 'nekomata') return neko || cafe || alert || '';
  return cafe || neko || alert || '';
}
