/**
 * オーナーが店舗用画面から変更できる予約受付の設定。
 * 保存先は Script Properties（getConfig_ が読むのと同じ場所）。
 * 呼び判定・金額・営業日に影響する設定（REVIEW_THRESHOLD_MINUTES、PAYOUT_RATE_PERCENT、
 * BUSINESS_DAY_CUTOFF_HOUR）はここでは変更できない。
 */
var EDITABLE_SETTINGS = [
  { key: 'openTime',             prop: 'RESERVATION_OPEN_TIME',               type: 'time' },
  { key: 'closeTime',            prop: 'RESERVATION_CLOSE_TIME',              type: 'time' },
  { key: 'defaultTime',          prop: 'RESERVATION_DEFAULT_TIME',            type: 'time' },
  { key: 'timeStepMinutes',      prop: 'RESERVATION_TIME_STEP_MINUTES',       type: 'int', allowed: [15, 30, 60] },
  { key: 'maxDaysAhead',         prop: 'RESERVATION_MAX_DAYS_AHEAD',          type: 'int', min: 0, max: 365 },
  { key: 'minGuests',            prop: 'RESERVATION_MIN_GUESTS',              type: 'int', min: 1, max: 50 },
  { key: 'maxGuests',            prop: 'RESERVATION_MAX_GUESTS',              type: 'int', min: 1, max: 50 },
  { key: 'maxActivePerCustomer', prop: 'RESERVATION_MAX_ACTIVE_PER_CUSTOMER', type: 'int', min: 1, max: 20 }
];

function timeToMinutes_(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
}

/** 営業日の始まり（切り替え時刻）からの経過分。0〜1439。 */
function minutesFromCutoff_(minutesOfDay, cutoffHour) {
  return (minutesOfDay - cutoffHour * 60 + 1440) % 1440;
}

/** 時刻（HH:MM）が受付時間内か。受付時間は1つの営業日の中に収まっている前提。 */
function isWithinReservationHours_(hhmm, config) {
  var c = config.BUSINESS_DAY_CUTOFF_HOUR;
  var t = minutesFromCutoff_(timeToMinutes_(hhmm), c);
  return t >= minutesFromCutoff_(timeToMinutes_(config.RESERVATION_OPEN_TIME), c) &&
    t <= minutesFromCutoff_(timeToMinutes_(config.RESERVATION_CLOSE_TIME), c);
}

function currentSettings_(config) {
  var out = {};
  EDITABLE_SETTINGS.forEach(function (d) { out[d.key] = config[d.prop]; });
  return out;
}

/**
 * 設定値を検証する。
 * @return {{ok: true, value: Object} | {ok: false, errors: Object}}
 */
function validateSettings_(input, cutoffHour) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { settings: 'required' } };
  }
  var errors = {};
  var v = {};
  EDITABLE_SETTINGS.forEach(function (d) {
    var x = input[d.key];
    if (d.type === 'time') {
      if (typeof x !== 'string' || !TIME_OF_DAY_PATTERN.test(x)) { errors[d.key] = 'invalid'; return; }
    } else {
      if (typeof x !== 'number' || !Number.isInteger(x)) { errors[d.key] = 'invalid'; return; }
      if (d.allowed && d.allowed.indexOf(x) < 0) { errors[d.key] = 'invalid'; return; }
      if (d.min !== undefined && (x < d.min || x > d.max)) { errors[d.key] = 'out_of_range'; return; }
    }
    v[d.key] = x;
  });
  if (Object.keys(errors).length) return { ok: false, errors: errors };

  // 時刻は時間間隔の区切りに合わせる（例: 30分間隔なら 18:15 は不可）
  ['openTime', 'closeTime', 'defaultTime'].forEach(function (k) {
    if (timeToMinutes_(v[k]) % v.timeStepMinutes !== 0) errors[k] = 'invalid_step';
  });
  // 受付時間は1つの営業日の中に収める（切り替え時刻をまたぐと営業日が分かれてしまう）
  var open = minutesFromCutoff_(timeToMinutes_(v.openTime), cutoffHour);
  var close = minutesFromCutoff_(timeToMinutes_(v.closeTime), cutoffHour);
  if (!errors.closeTime && !errors.openTime && close <= open) errors.closeTime = 'before_open';
  var def = minutesFromCutoff_(timeToMinutes_(v.defaultTime), cutoffHour);
  if (!errors.defaultTime && !errors.closeTime && (def < open || def > close)) errors.defaultTime = 'outside_hours';
  if (v.minGuests > v.maxGuests) errors.maxGuests = 'less_than_min';

  if (Object.keys(errors).length) return { ok: false, errors: errors };
  return { ok: true, value: v };
}

function staffGetSettings_(ctx) {
  return {
    ok: true,
    settings: currentSettings_(ctx.config),
    businessDayCutoffHour: ctx.config.BUSINESS_DAY_CUTOFF_HOUR
  };
}

function staffUpdateSettings_(ctx) {
  var config = ctx.config;
  var result = validateSettings_(ctx.body.settings, config.BUSINESS_DAY_CUTOFF_HOUR);
  if (!result.ok) return errorResponse_('VALIDATION_ERROR', result.errors);

  // 画面を開いた後に他のオーナーが変更していたら上書きしない
  var before = currentSettings_(config);
  var expected = ctx.body.expected;
  if (!expected || typeof expected !== 'object' ||
      EDITABLE_SETTINGS.some(function (d) { return expected[d.key] !== before[d.key]; })) {
    return errorResponse_('VERSION_CONFLICT');
  }

  var props = {};
  EDITABLE_SETTINGS.forEach(function (d) { props[d.prop] = String(result.value[d.key]); });
  PropertiesService.getScriptProperties().setProperties(props, false);

  appendAudit_({
    userId: ctx.user.user_id, role: ctx.user.role, action: 'settings.update', targetType: 'settings',
    targetId: 'reservation', before: before, after: result.value, result: 'success'
  });
  return { ok: true, settings: result.value };
}
