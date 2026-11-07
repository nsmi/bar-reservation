/**
 * 入力値検証。ブラウザ側の検証は UX のためだけで、確定的な検証はここで行う。
 */
var REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var USER_ID_PATTERN = /^USR-[0-9A-Za-z_-]{1,32}$/;
var CONTROL_CHARS = new RegExp('[\u0000-\u001F\u007F-\u009F\u2028\u2029]');
var CONTROL_CHARS_EXCEPT_NEWLINE = new RegExp('[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]');

function isValidRequestId_(v) {
  return typeof v === 'string' && REQUEST_ID_PATTERN.test(v);
}

function charLength_(s) {
  return Array.from(s).length;
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

  // あだ名
  var nickname = typeof input.nickname === 'string' ? input.nickname.normalize('NFC').trim() : '';
  if (nickname === '') {
    errors.nickname = 'required';
  } else if (charLength_(nickname) > config.NICKNAME_MAX_LENGTH) {
    errors.nickname = 'too_long';
  } else if (CONTROL_CHARS.test(nickname)) {
    errors.nickname = 'invalid_chars';
  }

  // 来店予定日時（日本時間）
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

  // 人数
  var guests = input.numberOfGuests;
  if (typeof guests !== 'number' || !Number.isInteger(guests)) {
    errors.numberOfGuests = 'invalid';
  } else if (guests < config.RESERVATION_MIN_GUESTS || guests > config.RESERVATION_MAX_GUESTS) {
    errors.numberOfGuests = 'out_of_range';
  }

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

  // 備考（任意）
  var note = '';
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') {
      errors.note = 'invalid';
    } else {
      note = input.note.normalize('NFC').replace(/\r\n?/g, '\n').trim();
      if (charLength_(note) > config.NOTE_MAX_LENGTH) {
        errors.note = 'too_long';
      } else if (CONTROL_CHARS_EXCEPT_NEWLINE.test(note)) {
        errors.note = 'invalid_chars';
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors: errors };
  return {
    ok: true,
    value: {
      nickname: nickname,
      scheduledAt: scheduledAt,
      numberOfGuests: guests,
      requestedCastId: requestedCastId,
      note: note
    }
  };
}
