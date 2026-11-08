/**
 * 入力値検証。ブラウザ側の検証は UX のためだけで、確定的な検証はここで行う。
 */
var REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var USER_ID_PATTERN = /^USR-[0-9A-Za-z_-]{1,32}$/;
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var CONTROL_CHARS = new RegExp('[\u0000-\u001F\u007F-\u009F  ]');
var CONTROL_CHARS_EXCEPT_NEWLINE = new RegExp('[\u0000-\u0009\u000B-\u001F\u007F-\u009F  ]');

function isValidRequestId_(v) {
  return typeof v === 'string' && REQUEST_ID_PATTERN.test(v);
}

function isValidDateString_(v) {
  return typeof v === 'string' && DATE_PATTERN.test(v) && jstLocalToDate_(v, '00:00') !== null;
}

function charLength_(s) {
  return Array.from(s).length;
}

/** 1行の短い文字列（あだ名・表示名など）。@return {{value: string, error: string|null}} */
function validateShortText_(v, maxLength) {
  var s = typeof v === 'string' ? v.normalize('NFC').trim() : '';
  if (s === '') return { value: s, error: 'required' };
  if (charLength_(s) > maxLength) return { value: s, error: 'too_long' };
  if (CONTROL_CHARS.test(s)) return { value: s, error: 'invalid_chars' };
  return { value: s, error: null };
}

/** 任意の複数行テキスト（備考・理由など）。required=true なら空を拒否。 */
function validateNoteText_(v, maxLength, required) {
  if (v === undefined || v === null || v === '') {
    return { value: '', error: required ? 'required' : null };
  }
  if (typeof v !== 'string') return { value: '', error: 'invalid' };
  var s = v.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (required && s === '') return { value: s, error: 'required' };
  if (charLength_(s) > maxLength) return { value: s, error: 'too_long' };
  if (CONTROL_CHARS_EXCEPT_NEWLINE.test(s)) return { value: s, error: 'invalid_chars' };
  return { value: s, error: null };
}

/**
 * 予約に共通する「日時・人数・備考」を検証し、errors に書き込む。
 * @return {{scheduledAt: Date|null, numberOfGuests: number, note: string}}
 */
function validateScheduleFields_(input, now, config, errors) {
  var scheduledAt = null;
  if (typeof input.date !== 'string' || typeof input.time !== 'string') {
    errors.scheduledAt = 'required';
  } else {
    scheduledAt = jstLocalToDate_(input.date, input.time);
    if (!scheduledAt) {
      errors.scheduledAt = 'invalid';
    } else if (parseInt(input.time.slice(3, 5), 10) % config.RESERVATION_TIME_STEP_MINUTES !== 0) {
      errors.scheduledAt = 'invalid_step';
    } else if (scheduledAt.getTime() <= now.getTime()) {
      errors.scheduledAt = 'past';
    } else if (scheduledAt.getTime() > now.getTime() + (config.RESERVATION_MAX_DAYS_AHEAD + 1) * 86400000) {
      // +1日: 「翌1:00」のような深夜帯の予約を最終日にも許容するため
      errors.scheduledAt = 'too_far';
    }
  }

  var guests = input.numberOfGuests;
  if (typeof guests !== 'number' || !Number.isInteger(guests)) {
    errors.numberOfGuests = 'invalid';
  } else if (guests < config.RESERVATION_MIN_GUESTS || guests > config.RESERVATION_MAX_GUESTS) {
    errors.numberOfGuests = 'out_of_range';
  }

  var note = validateNoteText_(input.note, config.NOTE_MAX_LENGTH, false);
  if (note.error) errors.note = note.error;

  return { scheduledAt: scheduledAt, numberOfGuests: guests, note: note.value };
}

/**
 * 顧客向け予約入力を検証する。
 * クライアントが送る未知のフィールド（lineUserId、createdAt、assignedCastId など）は一切読まない。
 * @return {{ok: true, value: Object} | {ok: false, errors: Object}}
 */
function validateReservationInput_(input, now, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { reservation: 'required' } };
  }
  var errors = {};

  var nickname = validateShortText_(input.nickname, config.NICKNAME_MAX_LENGTH);
  if (nickname.error) errors.nickname = nickname.error;

  var schedule = validateScheduleFields_(input, now, config, errors);

  // 希望キャスト（任意）。存在確認はロック内で Users シートと照合する。
  var requestedCastId = '';
  var rc = input.requestedCastId;
  if (rc !== undefined && rc !== null && rc !== '') {
    if (typeof rc !== 'string' || !USER_ID_PATTERN.test(rc)) {
      errors.requestedCastId = 'invalid';
    } else {
      requestedCastId = rc;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors: errors };
  return {
    ok: true,
    value: {
      nickname: nickname.value,
      scheduledAt: schedule.scheduledAt,
      numberOfGuests: schedule.numberOfGuests,
      requestedCastId: requestedCastId,
      note: schedule.note
    }
  };
}
