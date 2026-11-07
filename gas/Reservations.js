/**
 * 顧客向け LINE 予約。
 * - source は常に 'line_customer'（呼び候補にはならない）。
 * - 希望キャスト(requested_cast_id)は保存するが、assigned_cast_id は設定しない。
 * - 予約ID・登録日時・状態はサーバー側で決める。
 * - request_id を予約行に保存し、同一リクエストの再送では既存予約を返す（二重登録防止）。
 */
var RESERVATION_STATUS = {
  RESERVED: 'reserved',
  CANCELLED: 'cancelled',
  VISITED: 'visited',
  NO_SHOW: 'no_show'
};

function listActiveCasts_(users) {
  return users
    .filter(function (u) { return u.role === 'cast' && isTruthyCell_(u.active); })
    .map(function (u) { return { castId: u.user_id, displayName: u.display_name }; });
}

function castDisplayName_(users, userId) {
  if (!userId) return '';
  for (var i = 0; i < users.length; i++) {
    if (users[i].user_id === userId) return users[i].display_name;
  }
  return '';
}

function toPublicReservation_(r, castName) {
  return {
    reservationId: r.reservation_id,
    scheduledAt: r.scheduled_at,
    numberOfGuests: Number(r.number_of_guests),
    nickname: r.nickname,
    requestedCastName: castName || '',
    note: r.note
  };
}

/** 予約フォームの選択肢。キャストは表示名とIDのみ返す。認証不要。 */
function handleGetFormOptions_() {
  var config = getConfig_();
  return {
    ok: true,
    casts: listActiveCasts_(readAll_('Users')),
    constraints: {
      minGuests: config.RESERVATION_MIN_GUESTS,
      maxGuests: config.RESERVATION_MAX_GUESTS,
      maxDaysAhead: config.RESERVATION_MAX_DAYS_AHEAD,
      timeStepMinutes: config.RESERVATION_TIME_STEP_MINUTES,
      nicknameMaxLength: config.NICKNAME_MAX_LENGTH,
      noteMaxLength: config.NOTE_MAX_LENGTH,
      businessDayCutoffHour: config.BUSINESS_DAY_CUTOFF_HOUR
    }
  };
}

function handleCreateReservation_(body) {
  var config = getConfig_();

  if (!isValidRequestId_(body.requestId)) {
    return errorResponse_('VALIDATION_ERROR', { requestId: 'invalid' });
  }

  // 1. 本人確認（ロック外で実施: 外部通信中にロックを握らない）
  var auth = verifyLineIdToken_(body.idToken, config.LINE_CHANNEL_ID, now_());
  if (!auth.ok) {
    if (auth.code !== 'AUTH_UNAVAILABLE') {
      safeAppendAudit_({
        role: 'line_customer', action: 'reservation.create', targetType: 'reservation',
        reason: auth.code, requestId: body.requestId, result: 'denied'
      });
    }
    return errorResponse_(auth.code);
  }

  // 2. 入力検証（時刻の前後関係はサーバー時刻で判定）
  var v = validateReservationInput_(body.reservation, now_(), config);
  if (!v.ok) return errorResponse_('VALIDATION_ERROR', v.errors);

  // 3. 排他制御下で照合・保存
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(config.LOCK_WAIT_MS)) return errorResponse_('BUSY');
  try {
    var now = now_();
    var nowIso = formatJstIso_(now);
    var customers = readAll_('Customers');
    var customer = findCustomerByLineUserId_(customers, auth.sub);
    var reservations = readAll_('Reservations');
    var users = readAll_('Users');

    // 3-1. 同一リクエストIDの再送
    var prior = null;
    for (var i = 0; i < reservations.length; i++) {
      if (reservations[i].request_id === body.requestId) { prior = reservations[i]; break; }
    }
    if (prior) {
      if (customer && prior.customer_id === customer.customer_id) {
        return {
          ok: true,
          replayed: true,
          reservation: toPublicReservation_(prior, castDisplayName_(users, prior.requested_cast_id))
        };
      }
      return errorResponse_('REQUEST_ID_CONFLICT');
    }

    // 3-2. 希望キャストの存在確認
    var castName = '';
    if (v.value.requestedCastId) {
      var casts = listActiveCasts_(users);
      for (var j = 0; j < casts.length; j++) {
        if (casts[j].castId === v.value.requestedCastId) { castName = casts[j].displayName; break; }
      }
      if (!castName) return errorResponse_('VALIDATION_ERROR', { requestedCastId: 'unknown' });
    }

    // 3-3. 既存顧客の状態と予約件数上限
    if (customer) {
      if (!isTruthyCell_(customer.active)) return errorResponse_('CUSTOMER_INACTIVE');
      var activeCount = reservations.filter(function (r) {
        if (r.customer_id !== customer.customer_id || r.status !== RESERVATION_STATUS.RESERVED) return false;
        var at = parseIsoDate_(r.scheduled_at);
        return at !== null && at.getTime() > now.getTime();
      }).length;
      if (activeCount >= config.RESERVATION_MAX_ACTIVE_PER_CUSTOMER) {
        return errorResponse_('LIMIT_EXCEEDED');
      }
    } else {
      customer = createCustomer_(customers, auth.sub, v.value.nickname, nowIso);
      appendAudit_({
        userId: customer.customer_id, role: 'line_customer', action: 'customer.create',
        targetType: 'customer', targetId: customer.customer_id,
        after: toAuditCustomer_(customer), requestId: body.requestId, result: 'success'
      });
    }

    // 3-4. 予約保存
    var record = {
      reservation_id: nextReservationId_(reservations, now),
      request_id: body.requestId,
      customer_id: customer.customer_id,
      nickname: v.value.nickname,
      scheduled_at: formatJstIso_(v.value.scheduledAt),
      number_of_guests: v.value.numberOfGuests,
      source: 'line_customer',
      created_by_user_id: '',
      assigned_cast_id: '',
      requested_cast_id: v.value.requestedCastId,
      created_at: nowIso,
      status: RESERVATION_STATUS.RESERVED,
      note: v.value.note,
      version: 1
    };
    appendRecord_('Reservations', record);
    appendAudit_({
      userId: customer.customer_id, role: 'line_customer', action: 'reservation.create',
      targetType: 'reservation', targetId: record.reservation_id,
      after: record, requestId: body.requestId, result: 'success'
    });

    return { ok: true, replayed: false, reservation: toPublicReservation_(record, castName) };
  } finally {
    lock.releaseLock();
  }
}
