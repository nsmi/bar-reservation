/**
 * 設定値。秘密情報・環境依存値は Script Properties で管理し、コードに書かない。
 *
 * 必須 Script Properties:
 *   LINE_CHANNEL_ID  LINEミニアプリ チャネルのチャネルID（数字）
 * 任意（未設定時は CONFIG_DEFAULTS を使用）:
 *   BUSINESS_DAY_CUTOFF_HOUR など下記のキー
 */
var CONFIG_DEFAULTS = {
  BUSINESS_DAY_CUTOFF_HOUR: 6,
  RESERVATION_MAX_DAYS_AHEAD: 60,
  RESERVATION_MIN_GUESTS: 1,
  RESERVATION_MAX_GUESTS: 10,
  RESERVATION_MAX_ACTIVE_PER_CUSTOMER: 3,
  RESERVATION_TIME_STEP_MINUTES: 15,
  NICKNAME_MAX_LENGTH: 20,
  NOTE_MAX_LENGTH: 200,
  LOCK_WAIT_MS: 10000
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
  return cfg;
}
