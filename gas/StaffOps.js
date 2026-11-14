/**
 * 店舗用画面の操作。すべて handleStaffRequest_ で認証・ロール確認済みの ctx を受け取る。
 * write: true の操作は ScriptLock 取得中に実行される。
 * ブラウザから送られた日時・ユーザーID・ロール・判定結果・金額計算は信用しない。
 */
var PAYMENT_METHODS = ['cash', 'card', 'qr', 'other'];

function userName_(usersById, userId) {
  return userId && usersById[userId] ? usersById[userId].display_name : '';
}

function requireBusinessDate_(v, config) {
  if (v === undefined || v === null || v === '') return businessDateOf_(now_(), config.BUSINESS_DAY_CUTOFF_HOUR);
  return isValidDateString_(v) ? v : null;
}

/** 既存顧客ID か 新規あだ名 のどちらかから顧客を決める（ロック取得中に呼ぶ）。 */
function resolveCustomerInput_(input, customers, nowIso, ctx) {
  if (input.customerId) {
    var c = null;
    for (var i = 0; i < customers.length; i++) {
      if (customers[i].customer_id === input.customerId) { c = customers[i]; break; }
    }
    if (!c || !isTruthyCell_(c.active)) return { error: errorResponse_('VALIDATION_ERROR', { customerId: 'unknown' }) };
    return { customer: c };
  }
  var nick = validateShortText_(input.newCustomerNickname, ctx.config.NICKNAME_MAX_LENGTH);
  if (nick.error) return { error: errorResponse_('VALIDATION_ERROR', { newCustomerNickname: nick.error }) };
  var created = createCustomer_(customers, '', nick.value, nowIso);
  customers.push(created);
  appendAudit_({
    userId: ctx.user.user_id, role: ctx.user.role, action: 'customer.create', targetType: 'customer',
    targetId: created.customer_id, after: toAuditCustomer_(created), requestId: ctx.body.requestId, result: 'success'
  });
  return { customer: created };
}

// ---------- 顧客 ----------

function staffListCustomers_() {
  var list = readAll_('Customers')
    .filter(function (c) { return isTruthyCell_(c.active); })
    .map(function (c) { return { customerId: c.customer_id, nickname: c.nickname }; });
  list.sort(function (a, b) { return a.nickname < b.nickname ? -1 : a.nickname > b.nickname ? 1 : 0; });
  return { ok: true, customers: list };
}

// ---------- 予約 ----------

function toStaffReservation_(r, usersById) {
  var castId = r.assigned_cast_id || r.requested_cast_id;
  return {
    reservationId: r.reservation_id,
    scheduledAt: r.scheduled_at,
    nickname: r.nickname,
    numberOfGuests: Number(r.number_of_guests),
    source: r.source,
    castName: userName_(usersById, castId),
    castKind: r.assigned_cast_id ? 'assigned' : (r.requested_cast_id ? 'requested' : ''),
    createdByName: userName_(usersById, r.created_by_user_id),
    createdAt: r.created_at,
    status: r.status,
    note: r.note
  };
}

function staffListReservations_(ctx) {
  var date = requireBusinessDate_(ctx.body.businessDate, ctx.config);
  if (!date) return errorResponse_('VALIDATION_ERROR', { businessDate: 'invalid' });
  var usersById = indexBy_(readAll_('Users'), 'user_id');
  var cutoff = ctx.config.BUSINESS_DAY_CUTOFF_HOUR;
  var list = readAll_('Reservations').filter(function (r) {
    var at = parseIsoDate_(r.scheduled_at);
    if (!at || businessDateOf_(at, cutoff) !== date) return false;
    // キャストは自分が登録した予約と、自分が担当の予約のみ
    return ctx.user.role !== 'cast' || isOwnReservation_(r, ctx.user);
  }).map(function (r) { return toStaffReservation_(r, usersById); });
  list.sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? -1 : a.scheduledAt > b.scheduledAt ? 1 : 0; });
  return { ok: true, businessDate: date, reservations: list };
}

function isOwnReservation_(r, user) {
  return r.created_by_user_id === user.user_id || r.assigned_cast_id === user.user_id;
}

/**
 * 予約の種類と担当者を決める。
 * - type: 'invite'（呼び予約）/ 'store'（店舗受付）。省略時はキャストなら呼び予約、それ以外は店舗受付。
 * - 担当者は原則ログイン中の本人。オーナーだけが他の従業員（有効なユーザー）を担当者に指定できる。
 */
function resolveReservationType_(input, user, usersById) {
  var type = input.type === undefined || input.type === null || input.type === ''
    ? (user.role === 'cast' ? 'invite' : 'store')
    : input.type;
  if (type !== 'invite' && type !== 'store') return { error: errorResponse_('VALIDATION_ERROR', { type: 'invalid' }) };
  if (type === 'store') return { type: type, assigneeId: '' };

  var assigneeId = input.assigneeUserId || user.user_id;
  if (assigneeId !== user.user_id) {
    if (user.role !== 'owner') return { error: errorResponse_('FORBIDDEN') };
    var assignee = usersById[assigneeId];
    if (typeof assigneeId !== 'string' || !assignee || !isTruthyCell_(assignee.active) || STAFF_ROLES.indexOf(assignee.role) < 0) {
      return { error: errorResponse_('VALIDATION_ERROR', { assigneeUserId: 'invalid' }) };
    }
  }
  return { type: type, assigneeId: assigneeId };
}

/**
 * 店舗側の予約登録。呼び予約（source = 'invite'）だけが呼び判定の対象。
 */
function staffCreateReservation_(ctx) {
  var body = ctx.body;
  var user = ctx.user;
  if (!isValidRequestId_(body.requestId)) return errorResponse_('VALIDATION_ERROR', { requestId: 'invalid' });
  var input = body.reservation;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return errorResponse_('VALIDATION_ERROR', { reservation: 'required' });
  }
  var now = now_();
  var errors = {};
  var schedule = validateScheduleFields_(input, now, ctx.config, errors);
  if (Object.keys(errors).length) return errorResponse_('VALIDATION_ERROR', errors);

  var reservations = readAll_('Reservations');
  var usersById = indexBy_(readAll_('Users'), 'user_id');
  for (var i = 0; i < reservations.length; i++) {
    if (reservations[i].request_id === body.requestId) {
      if (reservations[i].created_by_user_id === user.user_id) {
        return { ok: true, replayed: true, reservation: toStaffReservation_(reservations[i], usersById) };
      }
      return errorResponse_('REQUEST_ID_CONFLICT');
    }
  }

  var kind = resolveReservationType_(input, user, usersById);
  if (kind.error) return kind.error;

  var nowIso = formatJstIso_(now);
  var resolved = resolveCustomerInput_(input, readAll_('Customers'), nowIso, ctx);
  if (resolved.error) return resolved.error;

  var record = {
    reservation_id: nextReservationId_(reservations, now),
    request_id: body.requestId,
    customer_id: resolved.customer.customer_id,
    nickname: resolved.customer.nickname,
    scheduled_at: formatJstIso_(schedule.scheduledAt),
    number_of_guests: schedule.numberOfGuests,
    source: kind.type, // 'invite'（呼び予約）| 'store'（店舗受付）
    created_by_user_id: user.user_id,
    assigned_cast_id: kind.assigneeId, // 呼び予約の担当者（キャスト・スタッフ・オーナー）
    requested_cast_id: '',
    created_at: nowIso,
    status: RESERVATION_STATUS.RESERVED,
    note: schedule.note,
    version: 1
  };
  appendRecord_('Reservations', record);
  appendAudit_({
    userId: user.user_id, role: user.role, action: 'reservation.create', targetType: 'reservation',
    targetId: record.reservation_id, after: record, requestId: body.requestId, result: 'success'
  });
  return { ok: true, replayed: false, reservation: toStaffReservation_(record, usersById) };
}

// ---------- 来店 ----------

function toStaffVisit_(v, usersById, customersById, tx, role) {
  var out = {
    visitId: v.visit_id,
    businessDate: v.business_date,
    checkedInAt: v.checked_in_at,
    nickname: customersById[v.customer_id] ? customersById[v.customer_id].nickname : '',
    customerId: v.customer_id,
    reservationId: v.reservation_id,
    invitationType: v.invitation_type,
    attributedCastId: v.attributed_cast_id,
    attributedCastName: userName_(usersById, v.attributed_cast_id),
    reason: v.determination_reason,
    checkedInByName: userName_(usersById, v.checked_in_by),
    paid: !!tx,
    version: Number(v.version)
  };
  if (tx && role !== 'cast') {
    out.transaction = {
      transactionId: tx.transaction_id,
      totalAmount: Number(tx.total_amount),
      castDrinkAmount: Number(tx.cast_drink_amount),
      paymentMethod: tx.payment_method
    };
  }
  return out;
}

function staffListVisits_(ctx) {
  var date = requireBusinessDate_(ctx.body.businessDate, ctx.config);
  if (!date) return errorResponse_('VALIDATION_ERROR', { businessDate: 'invalid' });
  var user = ctx.user;
  var usersById = indexBy_(readAll_('Users'), 'user_id');
  var customersById = indexBy_(readAll_('Customers'), 'customer_id');
  var txByVisit = {};
  readAll_('Transactions').forEach(function (t) { if (t.status !== 'void') txByVisit[t.visit_id] = t; });
  var list = readAll_('Visits').filter(function (v) {
    if (v.business_date !== date) return false;
    return user.role !== 'cast' || v.attributed_cast_id === user.user_id || v.checked_in_by === user.user_id;
  }).map(function (v) { return toStaffVisit_(v, usersById, customersById, txByVisit[v.visit_id], user.role); });
  list.sort(function (a, b) { return a.checkedInAt < b.checkedInAt ? -1 : 1; });
  return { ok: true, businessDate: date, visits: list };
}

/** 来店登録。来店時刻はサーバー時刻。予約は当日（営業日）分のみ選択可。 */
function staffCheckIn_(ctx) {
  var body = ctx.body;
  var user = ctx.user;
  var config = ctx.config;
  if (!isValidRequestId_(body.requestId)) return errorResponse_('VALIDATION_ERROR', { requestId: 'invalid' });

  var now = now_();
  var nowIso = formatJstIso_(now);
  var businessDate = businessDateOf_(now, config.BUSINESS_DAY_CUTOFF_HOUR);
  var visits = readAll_('Visits');
  var users = readAll_('Users');
  var usersById = indexBy_(users, 'user_id');
  var customers = readAll_('Customers');

  for (var i = 0; i < visits.length; i++) {
    if (visits[i].request_id === body.requestId) {
      if (visits[i].checked_in_by !== user.user_id) return errorResponse_('REQUEST_ID_CONFLICT');
      return { ok: true, replayed: true, visit: toStaffVisit_(visits[i], usersById, indexBy_(customers, 'customer_id'), null, user.role) };
    }
  }

  var reservation = null;
  var customer = null;
  if (body.reservationId) {
    var reservations = readAll_('Reservations');
    for (var j = 0; j < reservations.length; j++) {
      if (reservations[j].reservation_id === body.reservationId) { reservation = reservations[j]; break; }
    }
    if (!reservation) return errorResponse_('NOT_FOUND');
    if (user.role === 'cast' && !isOwnReservation_(reservation, user)) return errorResponse_('NOT_FOUND');
    if (reservation.status !== RESERVATION_STATUS.RESERVED) return errorResponse_('RESERVATION_NOT_AVAILABLE');
    var at = parseIsoDate_(reservation.scheduled_at);
    if (!at || businessDateOf_(at, config.BUSINESS_DAY_CUTOFF_HOUR) !== businessDate) {
      return errorResponse_('RESERVATION_NOT_TODAY');
    }
    customer = indexBy_(customers, 'customer_id')[reservation.customer_id];
    if (!customer) return errorResponse_('NOT_FOUND');
  } else {
    var resolved = resolveCustomerInput_(body, customers, nowIso, ctx);
    if (resolved.error) return resolved.error;
    customer = resolved.customer;
  }

  var det = determineInvitation_({
    reservation: reservation,
    checkedInBy: user,
    checkedInAt: now,
    users: users,
    thresholdMinutes: config.REVIEW_THRESHOLD_MINUTES
  });

  var prefix = 'V-' + businessDate.replace(/-/g, '') + '-';
  var visit = {
    visit_id: nextSequentialId_(visits.map(function (v) { return v.visit_id; }), prefix, 3),
    request_id: body.requestId,
    business_date: businessDate,
    customer_id: customer.customer_id,
    reservation_id: reservation ? reservation.reservation_id : '',
    checked_in_at: nowIso,
    checked_in_by: user.user_id,
    invitation_type: det.type,
    attributed_cast_id: det.castId,
    determination_reason: det.reason,
    created_at: nowIso,
    updated_at: nowIso,
    version: 1
  };
  appendRecord_('Visits', visit);
  if (reservation) {
    updateRecord_('Reservations', 'reservation_id', reservation.reservation_id, { status: RESERVATION_STATUS.VISITED });
  }
  appendAudit_({
    userId: user.user_id, role: user.role, action: 'visit.create', targetType: 'visit',
    targetId: visit.visit_id, after: visit, requestId: body.requestId, result: 'success'
  });
  var customersById = {};
  customersById[customer.customer_id] = customer;
  return { ok: true, replayed: false, visit: toStaffVisit_(visit, usersById, customersById, null, user.role) };
}

/** オーナーによる呼び判定の変更。理由必須、変更前後を監査ログへ。 */
function staffOverrideInvitation_(ctx) {
  var body = ctx.body;
  var errors = {};
  var type = body.invitationType;
  if (type !== INVITATION_TYPE.CAST_INVITED && type !== INVITATION_TYPE.STORE_CUSTOMER) errors.invitationType = 'invalid';
  var reason = validateNoteText_(body.reason, ctx.config.NOTE_MAX_LENGTH, true);
  if (reason.error) errors.reason = reason.error;
  if (Object.keys(errors).length) return errorResponse_('VALIDATION_ERROR', errors);

  var visits = readAll_('Visits');
  var visit = indexBy_(visits, 'visit_id')[body.visitId];
  if (!visit) return errorResponse_('NOT_FOUND');
  if (String(body.expectedVersion) !== String(visit.version)) return errorResponse_('VERSION_CONFLICT');

  var castId = '';
  if (type === INVITATION_TYPE.CAST_INVITED) {
    var cast = findUser_(readAll_('Users'), body.attributedCastId);
    // 呼びの担当者はキャスト・スタッフ・オーナーのいずれか
    if (!cast || STAFF_ROLES.indexOf(cast.role) < 0) return errorResponse_('VALIDATION_ERROR', { attributedCastId: 'unknown' });
    castId = cast.user_id;
  }

  var changes = {
    invitation_type: type,
    attributed_cast_id: castId,
    determination_reason: 'owner_override',
    updated_at: formatJstIso_(now_()),
    version: Number(visit.version) + 1
  };
  updateRecord_('Visits', 'visit_id', visit.visit_id, changes);
  appendAudit_({
    userId: ctx.user.user_id, role: ctx.user.role, action: 'visit.override_invitation', targetType: 'visit',
    targetId: visit.visit_id,
    before: { invitation_type: visit.invitation_type, attributed_cast_id: visit.attributed_cast_id, determination_reason: visit.determination_reason, version: Number(visit.version) },
    after: changes, reason: reason.value, result: 'success'
  });
  return { ok: true };
}

// ---------- 会計 ----------

function validateAmount_(v, max) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

function staffCreateTransaction_(ctx) {
  var body = ctx.body;
  var user = ctx.user;
  var config = ctx.config;
  if (!isValidRequestId_(body.requestId)) return errorResponse_('VALIDATION_ERROR', { requestId: 'invalid' });

  var errors = {};
  if (!validateAmount_(body.totalAmount, config.AMOUNT_MAX)) errors.totalAmount = 'invalid';
  if (!validateAmount_(body.castDrinkAmount, config.AMOUNT_MAX)) errors.castDrinkAmount = 'invalid';
  else if (!errors.totalAmount && body.castDrinkAmount > body.totalAmount) errors.castDrinkAmount = 'exceeds_total';
  if (PAYMENT_METHODS.indexOf(body.paymentMethod) < 0) errors.paymentMethod = 'invalid';
  var note = validateNoteText_(body.note, config.NOTE_MAX_LENGTH, false);
  if (note.error) errors.note = note.error;
  if (Object.keys(errors).length) return errorResponse_('VALIDATION_ERROR', errors);

  var transactions = readAll_('Transactions');
  for (var i = 0; i < transactions.length; i++) {
    if (transactions[i].request_id === body.requestId) {
      if (transactions[i].created_by !== user.user_id) return errorResponse_('REQUEST_ID_CONFLICT');
      return { ok: true, replayed: true, transactionId: transactions[i].transaction_id };
    }
  }
  var visit = indexBy_(readAll_('Visits'), 'visit_id')[body.visitId];
  if (!visit) return errorResponse_('NOT_FOUND');
  for (var j = 0; j < transactions.length; j++) {
    if (transactions[j].visit_id === visit.visit_id && transactions[j].status !== 'void') {
      return errorResponse_('ALREADY_PAID');
    }
  }

  var nowIso = formatJstIso_(now_());
  var prefix = 'T-' + visit.business_date.replace(/-/g, '') + '-';
  var record = {
    transaction_id: nextSequentialId_(transactions.map(function (t) { return t.transaction_id; }), prefix, 3),
    request_id: body.requestId,
    visit_id: visit.visit_id,
    business_date: visit.business_date, // 深夜の会計も来店の営業日に計上
    total_amount: body.totalAmount,
    cast_drink_amount: body.castDrinkAmount,
    payment_method: body.paymentMethod,
    payout_rate: config.PAYOUT_RATE_PERCENT, // 登録時点の率を保存（後の率変更で過去分を変えない）
    payout_amount: '', // 日払い確定（フェーズ3）で記録。予定額は集計時に算出
    status: 'open',
    note: note.value,
    created_by: user.user_id,
    created_at: nowIso,
    finalized_by: '',
    finalized_at: ''
  };
  appendRecord_('Transactions', record);
  appendAudit_({
    userId: user.user_id, role: user.role, action: 'transaction.create', targetType: 'transaction',
    targetId: record.transaction_id, after: record, requestId: body.requestId, result: 'success'
  });
  return { ok: true, replayed: false, transactionId: record.transaction_id };
}

// ---------- 集計 ----------

function staffDailySummary_(ctx) {
  var date = requireBusinessDate_(ctx.body.businessDate, ctx.config);
  if (!date) return errorResponse_('VALIDATION_ERROR', { businessDate: 'invalid' });
  var s = computeDailySummary_(
    readAll_('Visits'), readAll_('Transactions'), readAll_('Users'), readAll_('Customers'), date
  );
  if (ctx.user.role !== 'cast') return { ok: true, summary: s };

  // キャストは自分の分のみ
  var mine = null;
  for (var i = 0; i < s.casts.length; i++) {
    if (s.casts[i].castId === ctx.user.user_id) { mine = s.casts[i]; break; }
  }
  var pending = s.reviewList.filter(function (r) { return r.castId === ctx.user.user_id; });
  return {
    ok: true,
    summary: {
      businessDate: date,
      invitedSales: mine ? mine.invitedSales : 0,
      payout: mine ? mine.payout : 0,
      visitCount: mine ? mine.visitCount : 0,
      reviewPendingCount: pending.length
    }
  };
}

// ---------- ユーザー管理（オーナー） ----------

function toStaffUser_(u) {
  return {
    userId: u.user_id,
    displayName: u.display_name,
    role: u.role,
    active: isTruthyCell_(u.active),
    linked: isLinkedIdentifier_(u.login_identifier)
  };
}

function staffListUsers_() {
  return { ok: true, users: readAll_('Users').map(toStaffUser_) };
}

function staffCreateUser_(ctx) {
  var body = ctx.body;
  var errors = {};
  var name = validateShortText_(body.displayName, ctx.config.DISPLAY_NAME_MAX_LENGTH);
  if (name.error) errors.displayName = name.error;
  if (STAFF_ROLES.indexOf(body.role) < 0) errors.role = 'invalid';
  if (Object.keys(errors).length) return errorResponse_('VALIDATION_ERROR', errors);

  var users = readAll_('Users');
  var nowIso = formatJstIso_(now_());
  var record = {
    user_id: nextUserId_(users), login_identifier: '', display_name: name.value, role: body.role,
    active: true, created_at: nowIso, updated_at: nowIso
  };
  appendRecord_('Users', record);
  var invite = issueInvite_(record.user_id, ctx.user.user_id, ctx.config);
  appendAudit_({
    userId: ctx.user.user_id, role: ctx.user.role, action: 'user.create', targetType: 'user',
    targetId: record.user_id, after: toStaffUser_(record), result: 'success'
  });
  return { ok: true, user: toStaffUser_(record), invite: invite };
}

function staffIssueInvite_(ctx) {
  var target = findUser_(readAll_('Users'), ctx.body.userId);
  if (!target) return errorResponse_('NOT_FOUND');
  if (!isTruthyCell_(target.active)) return errorResponse_('VALIDATION_ERROR', { userId: 'inactive' });
  var invite = issueInvite_(target.user_id, ctx.user.user_id, ctx.config);
  appendAudit_({
    userId: ctx.user.user_id, role: ctx.user.role, action: 'invite.issue', targetType: 'user',
    targetId: target.user_id, result: 'success'
  });
  return { ok: true, invite: invite };
}

function staffSetUserActive_(ctx) {
  var body = ctx.body;
  if (typeof body.active !== 'boolean') return errorResponse_('VALIDATION_ERROR', { active: 'invalid' });
  if (body.userId === ctx.user.user_id) return errorResponse_('VALIDATION_ERROR', { userId: 'self' });
  var target = findUser_(readAll_('Users'), body.userId);
  if (!target) return errorResponse_('NOT_FOUND');
  updateRecord_('Users', 'user_id', target.user_id, { active: body.active, updated_at: formatJstIso_(now_()) });
  appendAudit_({
    userId: ctx.user.user_id, role: ctx.user.role, action: body.active ? 'user.activate' : 'user.deactivate',
    targetType: 'user', targetId: target.user_id,
    before: { active: isTruthyCell_(target.active) }, after: { active: body.active }, result: 'success'
  });
  return { ok: true };
}

/**
 * ロール変更（オーナーのみ）。
 * - 自分自身のロールは変えられない（操作者が owner のまま残るので、オーナーが0人になることもない）。
 * - expectedRole が現在のロールと違えば、他の人が先に変更したとみなして拒否する。
 * - 判定済みの来店・計上済みの会計は変わらない。来店前の呼び予約は、担当がキャストでなくなると
 *   来店登録時に要確認（cast_inactive）になる。
 */
function staffSetUserRole_(ctx) {
  var body = ctx.body;
  if (STAFF_ROLES.indexOf(body.role) < 0) return errorResponse_('VALIDATION_ERROR', { role: 'invalid' });
  if (body.userId === ctx.user.user_id) return errorResponse_('VALIDATION_ERROR', { userId: 'self' });
  var target = findUser_(readAll_('Users'), body.userId);
  if (!target) return errorResponse_('NOT_FOUND');
  if (body.expectedRole !== target.role) return errorResponse_('VERSION_CONFLICT');
  if (body.role === target.role) return { ok: true, user: toStaffUser_(target) };

  var nowIso = formatJstIso_(now_());
  updateRecord_('Users', 'user_id', target.user_id, { role: body.role, updated_at: nowIso });
  appendAudit_({
    userId: ctx.user.user_id, role: ctx.user.role, action: 'user.role_change', targetType: 'user',
    targetId: target.user_id, before: { role: target.role }, after: { role: body.role }, result: 'success'
  });
  var updated = Object.assign({}, target, { role: body.role, updated_at: nowIso });
  return { ok: true, user: toStaffUser_(updated) };
}
