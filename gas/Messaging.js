/**
 * 公式LINEアカウント（Messaging API）との連携（2026-11-15 追加）。
 * - チャネルアクセストークンは Script Property「LINE_MESSAGING_ACCESS_TOKEN」にだけ置く（コード・Git・画面に出さない）。
 * - お客様の LINE ユーザーIDは Customers シートの値をサーバー内でだけ使い、画面・監査ログには出さない。
 * - Messaging API のチャネルは、お客様用ミニアプリと同じプロバイダーにあること（ユーザーIDが一致しないため）。
 */
var LINE_PROFILE_ENDPOINT = 'https://api.line.me/v2/bot/profile/';
var LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';
var LINE_MESSAGE_MAX_LENGTH = 500;

function messagingAccessToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('LINE_MESSAGING_ACCESS_TOKEN');
  return t ? String(t).trim() : '';
}

function isMessagingConfigured_() {
  return messagingAccessToken_() !== '';
}

/**
 * 公式アカウントの友だちか（ブロック中は友だちではない扱い）。
 * Messaging API のプロフィール取得は、友だちでなければ 404 を返す。プロフィールの中身は使わず、保存もしない。
 * @return {'friend' | 'not_friend' | 'unknown'} unknown は設定なし・通信失敗など（判定できない）
 */
function friendshipStatus_(lineUserId) {
  var token = messagingAccessToken_();
  if (!token || !lineUserId) return 'unknown';
  var res;
  try {
    res = UrlFetchApp.fetch(LINE_PROFILE_ENDPOINT + encodeURIComponent(lineUserId), {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
      followRedirects: false
    });
  } catch (e) {
    console.warn('Friendship check failed: fetch error');
    return 'unknown';
  }
  var status = res.getResponseCode();
  if (status === 200) return 'friend';
  if (status === 404) return 'not_friend';
  console.warn('Friendship check failed: HTTP ' + status); // 401 ならトークンの誤り・失効
  return 'unknown';
}

/**
 * 友だち追加が予約の条件になっているときに、予約を受け付けてよいか。
 * 判定できない場合（トークン未設定・LINE 側の障害）は受け付ける（予約の受付を優先）。
 */
function friendshipAllowsReservation_(config, lineUserId) {
  if (!config.RESERVATION_REQUIRE_FRIENDSHIP) return true;
  return friendshipStatus_(lineUserId) !== 'not_friend';
}

/**
 * テキストを1通送る。retryKey（UUID）を付けるので、同じキーの再送は LINE 側で1通にまとめられる。
 * @return {{ok: true} | {ok: false, code: string}}
 */
function pushTextMessage_(lineUserId, text, retryKey) {
  var token = messagingAccessToken_();
  if (!token) return { ok: false, code: 'MESSAGING_NOT_CONFIGURED' };
  var res;
  try {
    res = UrlFetchApp.fetch(LINE_PUSH_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, 'X-Line-Retry-Key': retryKey },
      payload: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true,
      followRedirects: false
    });
  } catch (e) {
    return { ok: false, code: 'MESSAGE_FAILED' };
  }
  var status = res.getResponseCode();
  // 409: 同じ retryKey で受付済み（前回の送信は届いている）
  if (status === 200 || status === 409) return { ok: true };
  console.warn('Push message failed: HTTP ' + status);
  if (status === 400 || status === 403 || status === 404) return { ok: false, code: 'MESSAGE_UNREACHABLE' };
  if (status === 429) return { ok: false, code: 'MESSAGE_QUOTA' };
  return { ok: false, code: 'MESSAGE_FAILED' };
}

/** お客様用: 公式アカウントの友だちか（予約画面の最初に確認する） */
function handleCheckFriendship_(body) {
  var config = getConfig_();
  if (!config.RESERVATION_REQUIRE_FRIENDSHIP) return { ok: true, required: false, friend: true };
  var auth = verifyLineIdToken_(body.idToken, config.LINE_CHANNEL_ID, now_());
  if (!auth.ok) return errorResponse_(auth.code);
  var status = friendshipStatus_(auth.sub);
  return { ok: true, required: true, friend: status !== 'not_friend' };
}

/**
 * 店舗用: 予約のキャンセル（オーナー・スタッフ）。
 * notifyMessage を付けると、LINE で予約したお客様へ公式アカウントから連絡してからキャンセルする。
 * 連絡に失敗したらキャンセルもしない（「連絡したつもり」を防ぐ）。
 */
function staffCancelReservation_(ctx) {
  var body = ctx.body;
  var user = ctx.user;
  if (!isValidRequestId_(body.requestId)) return errorResponse_('VALIDATION_ERROR', { requestId: 'invalid' });
  var notify = body.notifyMessage !== undefined && body.notifyMessage !== null && body.notifyMessage !== '';
  var message = null;
  if (notify) {
    message = validateNoteText_(body.notifyMessage, LINE_MESSAGE_MAX_LENGTH, true);
    if (message.error) return errorResponse_('VALIDATION_ERROR', { notifyMessage: message.error });
  }

  var reservation = indexBy_(readAll_('Reservations'), 'reservation_id')[body.reservationId];
  if (!reservation) return errorResponse_('NOT_FOUND');
  if (reservation.status !== RESERVATION_STATUS.RESERVED) return errorResponse_('RESERVATION_NOT_AVAILABLE');
  if (String(body.expectedVersion) !== String(reservation.version)) return errorResponse_('VERSION_CONFLICT');

  if (notify) {
    var customer = indexBy_(readAll_('Customers'), 'customer_id')[reservation.customer_id];
    if (!customer || !customer.line_user_id) return errorResponse_('VALIDATION_ERROR', { notifyMessage: 'no_line' });
    var sent = pushTextMessage_(customer.line_user_id, message.value, body.requestId);
    if (!sent.ok) {
      appendAudit_({
        userId: user.user_id, role: user.role, action: 'reservation.notify', targetType: 'reservation',
        targetId: reservation.reservation_id, reason: sent.code, requestId: body.requestId, result: 'failed'
      });
      return errorResponse_(sent.code);
    }
  }

  var changes = { status: RESERVATION_STATUS.CANCELLED, version: Number(reservation.version) + 1 };
  updateRecord_('Reservations', 'reservation_id', reservation.reservation_id, changes);
  appendAudit_({
    userId: user.user_id, role: user.role, action: notify ? 'reservation.decline' : 'reservation.cancel',
    targetType: 'reservation', targetId: reservation.reservation_id,
    before: { status: reservation.status, version: Number(reservation.version) },
    after: notify ? Object.assign({ notified_message: message.value }, changes) : changes,
    requestId: body.requestId, result: 'success'
  });
  return { ok: true, notified: notify };
}
