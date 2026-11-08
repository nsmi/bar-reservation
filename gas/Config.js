/**
 * 設定値。秘密情報・環境依存値は Script Properties で管理し、コードに書かない。
 *
 * 必須 Script Properties:
 *   LINE_CHANNEL_ID        顧客用 LINEミニアプリ チャネルのチャネルID（数字）
 * 店舗用画面を使う場合に必須:
 *   LINE_STAFF_CHANNEL_ID  店舗用 LINEミニアプリ チャネルのチャネルID（数字）
 * 任意（未設定時は CONFIG_DEFAULTS を使用）:
 *   BUSINESS_DAY_CUTOFF_HOUR など下記のキー
 */
var TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

var CONFIG_DEFAULTS = {
  BUSINESS_DAY_CUTOFF_HOUR: 6,
  RESERVATION_MAX_DAYS_AHEAD: 60,
  RESERVATION_MIN_GUESTS: 1,
  RESERVATION_MAX_GUESTS: 10,
  RESERVATION_MAX_ACTIVE_PER_CUSTOMER: 3,
  RESERVATION_TIME_STEP_MINUTES: 15,
  // 予約受付時間（HH:MM）。CLOSE が OPEN より前なら日付をまたぐ（例: 18:00〜翌04:00）。
  // オーナーが店舗用画面の「設定」タブで変更できる（gas/Settings.js）
  RESERVATION_OPEN_TIME: '18:00',
  RESERVATION_CLOSE_TIME: '04:00',
  RESERVATION_DEFAULT_TIME: '21:00',
  NICKNAME_MAX_LENGTH: 20,
  NOTE_MAX_LENGTH: 200,
  LOCK_WAIT_MS: 10000,
  // 呼び判定: 予約登録から来店登録までがこの分数未満なら要確認
  REVIEW_THRESHOLD_MINUTES: 30,
  // 日払い率（%）。会計総額（キャストドリンク代を含む）に掛ける
  PAYOUT_RATE_PERCENT: 10,
  AMOUNT_MAX: 10000000,
  INVITE_TTL_HOURS: 24,
  DISPLAY_NAME_MAX_LENGTH: 20
};

function getConfig_() {
  var props = PropertiesService.getScriptProperties().getProperties() || {};
  var cfg = {};
  Object.keys(CONFIG_DEFAULTS).forEach(function (key) {
    var raw = props[key];
    if (raw === undefined || raw === null || raw === '') {
      cfg[key] = CONFIG_DEFAULTS[key];
      return;
    }
    if (typeof CONFIG_DEFAULTS[key] === 'string') {
      if (!TIME_OF_DAY_PATTERN.test(String(raw))) throw new Error('CONFIG: ' + key + ' is not HH:MM');
      cfg[key] = String(raw);
      return;
    }
    var n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error('CONFIG: ' + key + ' is not a number');
    }
    cfg[key] = n;
  });

  var channelId = props.LINE_CHANNEL_ID;
  if (!channelId || !/^\d{6,20}$/.test(String(channelId))) {
    throw new Error('CONFIG: LINE_CHANNEL_ID is missing or invalid');
  }
  cfg.LINE_CHANNEL_ID = String(channelId);

  var staffChannelId = props.LINE_STAFF_CHANNEL_ID;
  if (staffChannelId && !/^\d{6,20}$/.test(String(staffChannelId))) {
    throw new Error('CONFIG: LINE_STAFF_CHANNEL_ID is invalid');
  }
  if (staffChannelId && String(staffChannelId) === cfg.LINE_CHANNEL_ID) {
    // 顧客用と同じチャネルだと、顧客向け画面のトークンで店舗APIを呼べてしまう
    throw new Error('CONFIG: LINE_STAFF_CHANNEL_ID must differ from LINE_CHANNEL_ID');
  }
  cfg.LINE_STAFF_CHANNEL_ID = staffChannelId ? String(staffChannelId) : '';
  return cfg;
}
