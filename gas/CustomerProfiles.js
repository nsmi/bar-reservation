/**
 * 顧客タブ（従業員ごとの顧客管理）。
 * - キャストは「自分の担当の顧客」だけを見られる。担当の顧客とは、次のいずれかに当たる顧客:
 *     自分に呼びと判定された来店がある / 自分が登録した・自分が担当の予約がある / お客様が自分を希望した予約がある
 *   オーナー・スタッフは全顧客を見られる（担当者で絞り込み可）。
 * - 共通メモ（年代・見分け方・好きなお酒・メモ）はオーナー・スタッフが編集。あだ名の変更はオーナーのみ。
 * - 個人メモは従業員ごとに1つ。画面では本人だけが見られる。
 * - LINEユーザーIDは画面へ返さない。電話番号は扱わない。
 */
var AGE_GROUPS = ['', '20s', '30s', '40s', '50s', '60s'];
var CUSTOMER_TEXT_LIMITS = { identificationNote: 50, favoriteDrink: 50, memo: 500 };
var CUSTOMER_NOTE_MAX_LENGTH = 500;

/** userId の担当の顧客IDの集合（{customer_id: true}） */
function customerIdsRelatedTo_(userId, visits, reservations) {
  var ids = {};
  visits.forEach(function (v) {
    if (v.attributed_cast_id === userId) ids[v.customer_id] = true;
  });
  reservations.forEach(function (r) {
    if (r.created_by_user_id === userId || r.assigned_cast_id === userId || r.requested_cast_id === userId) {
      ids[r.customer_id] = true;
    }
  });
  return ids;
}

/** 顧客ごとの担当者ID（呼びの来店・呼び予約の担当・希望キャスト） */
function assigneesByCustomer_(visits, reservations) {
  var map = {};
  var add = function (cid, uid) {
    if (!cid || !uid) return;
    map[cid] = map[cid] || {};
    map[cid][uid] = true;
  };
  visits.forEach(function (v) { add(v.customer_id, v.attributed_cast_id); });
  reservations.forEach(function (r) {
    add(r.customer_id, r.assigned_cast_id);
    add(r.customer_id, r.requested_cast_id);
  });
  return map;
}

function activeTransactionsByVisit_(transactions) {
  var map = {};
  transactions.forEach(function (t) { if (t.status !== 'void') map[t.visit_id] = t; });
  return map;
}

function canViewCustomer_(user, customerId, visits, reservations) {
  if (user.role !== 'cast') return true;
  return !!customerIdsRelatedTo_(user.user_id, visits, reservations)[customerId];
}

function staffListCustomerProfiles_(ctx) {
  var user = ctx.user;
  var visits = readAll_('Visits');
  var reservations = readAll_('Reservations');
  var users = readAll_('Users');
  var usersById = indexBy_(users, 'user_id');
  var txByVisit = activeTransactionsByVisit_(readAll_('Transactions'));

  // 誰の担当で絞るか: キャストは常に本人。オーナー・スタッフは任意（空なら全員）
  var targetId = '';
  if (user.role === 'cast') {
    targetId = user.user_id;
  } else if (ctx.body.assigneeUserId) {
    if (!usersById[ctx.body.assigneeUserId]) return errorResponse_('VALIDATION_ERROR', { assigneeUserId: 'unknown' });
    targetId = ctx.body.assigneeUserId;
  }
  var related = targetId ? customerIdsRelatedTo_(targetId, visits, reservations) : null;
  var assignees = assigneesByCustomer_(visits, reservations);

  var stats = {};
  visits.forEach(function (v) {
    var s = stats[v.customer_id] = stats[v.customer_id] || { visitCount: 0, lastVisitDate: '', totalSales: 0, invitedSales: 0 };
    s.visitCount++;
    if (v.business_date > s.lastVisitDate) s.lastVisitDate = v.business_date;
    var tx = txByVisit[v.visit_id];
    if (!tx) return;
    var amount = Number(tx.total_amount) || 0;
    s.totalSales += amount;
    // 呼び売上: 絞り込み中はその担当者の分、全員表示なら呼び全体
    if (v.invitation_type === INVITATION_TYPE.CAST_INVITED && (!targetId || v.attributed_cast_id === targetId)) {
      s.invitedSales += amount;
    }
  });

  var list = readAll_('Customers').filter(function (c) {
    return isTruthyCell_(c.active) && (!related || related[c.customer_id]);
  }).map(function (c) {
    var s = stats[c.customer_id] || { visitCount: 0, lastVisitDate: '', totalSales: 0, invitedSales: 0 };
    var out = {
      customerId: c.customer_id,
      nickname: c.nickname,
      ageGroup: c.age_group,
      favoriteDrink: c.favorite_drink,
      visitCount: s.visitCount,
      lastVisitDate: s.lastVisitDate,
      totalSales: s.totalSales,
      invitedSales: s.invitedSales
    };
    if (user.role !== 'cast') {
      out.assigneeNames = Object.keys(assignees[c.customer_id] || {})
        .map(function (uid) { return userName_(usersById, uid); }).filter(Boolean);
    }
    return out;
  });
  // 最近来店した順。来店がなければ登録順の新しい順
  list.sort(function (a, b) {
    if (a.lastVisitDate !== b.lastVisitDate) return a.lastVisitDate < b.lastVisitDate ? 1 : -1;
    return a.customerId < b.customerId ? 1 : -1;
  });
  return { ok: true, assigneeUserId: targetId, customers: list };
}

function findMyNote_(notes, customerId, userId) {
  for (var i = 0; i < notes.length; i++) {
    if (notes[i].customer_id === customerId && notes[i].user_id === userId) return notes[i];
  }
  return null;
}

function toCustomerDetail_(c) {
  return {
    customerId: c.customer_id,
    nickname: c.nickname,
    ageGroup: c.age_group,
    identificationNote: c.identification_note,
    favoriteDrink: c.favorite_drink,
    memo: c.memo,
    hasLine: !!c.line_user_id, // IDそのものは返さない
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
}

function staffGetCustomer_(ctx) {
  var user = ctx.user;
  var customer = indexBy_(readAll_('Customers'), 'customer_id')[ctx.body.customerId];
  if (!customer || !isTruthyCell_(customer.active)) return errorResponse_('NOT_FOUND');
  var visits = readAll_('Visits');
  var reservations = readAll_('Reservations');
  // 担当でないキャストには存在自体を知らせない
  if (!canViewCustomer_(user, customer.customer_id, visits, reservations)) return errorResponse_('NOT_FOUND');

  var usersById = indexBy_(readAll_('Users'), 'user_id');
  var txByVisit = activeTransactionsByVisit_(readAll_('Transactions'));
  var isCast = user.role === 'cast';

  var visitList = visits.filter(function (v) { return v.customer_id === customer.customer_id; }).map(function (v) {
    var tx = txByVisit[v.visit_id];
    var mine = v.attributed_cast_id === user.user_id;
    return {
      visitId: v.visit_id,
      businessDate: v.business_date,
      checkedInAt: v.checked_in_at,
      invitationType: v.invitation_type,
      mine: mine,
      // キャストには、他の人の担当名は見せない（自分の担当かどうかだけ）
      attributedCastName: isCast && !mine ? '' : userName_(usersById, v.attributed_cast_id),
      totalAmount: tx ? Number(tx.total_amount) : null,
      castDrinkAmount: tx ? Number(tx.cast_drink_amount) : null
    };
  });
  visitList.sort(function (a, b) { return a.checkedInAt < b.checkedInAt ? 1 : -1; });

  var reservationList = reservations.filter(function (r) {
    if (r.customer_id !== customer.customer_id) return false;
    return !isCast || isOwnReservation_(r, user) || r.requested_cast_id === user.user_id;
  }).map(function (r) { return toStaffReservation_(r, usersById); });
  reservationList.sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? 1 : -1; });

  var note = findMyNote_(readAll_('CustomerNotes'), customer.customer_id, user.user_id);
  return {
    ok: true,
    customer: toCustomerDetail_(customer),
    visits: visitList,
    reservations: reservationList,
    myNote: note ? { body: note.body, version: Number(note.version), updatedAt: note.updated_at } : { body: '', version: 0, updatedAt: '' },
    permissions: { editShared: user.role !== 'cast', editNickname: user.role === 'owner' }
  };
}

/** 共通メモの更新（オーナー・スタッフ）。あだ名の変更はオーナーのみ。 */
function staffUpdateCustomer_(ctx) {
  var body = ctx.body;
  var input = body.customer;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return errorResponse_('VALIDATION_ERROR', { customer: 'required' });
  }
  var customer = indexBy_(readAll_('Customers'), 'customer_id')[body.customerId];
  if (!customer || !isTruthyCell_(customer.active)) return errorResponse_('NOT_FOUND');

  var errors = {};
  var changes = {};
  if (input.nickname !== undefined && input.nickname !== customer.nickname) {
    if (ctx.user.role !== 'owner') return errorResponse_('FORBIDDEN');
    var nick = validateShortText_(input.nickname, ctx.config.NICKNAME_MAX_LENGTH);
    if (nick.error) errors.nickname = nick.error;
    else if (nick.value !== customer.nickname) changes.nickname = nick.value;
  }
  if (AGE_GROUPS.indexOf(input.ageGroup) < 0) errors.ageGroup = 'invalid';
  else if (input.ageGroup !== customer.age_group) changes.age_group = input.ageGroup;
  var fields = { identificationNote: 'identification_note', favoriteDrink: 'favorite_drink', memo: 'memo' };
  Object.keys(fields).forEach(function (k) {
    var t = validateNoteText_(input[k], CUSTOMER_TEXT_LIMITS[k], false);
    if (t.error) errors[k] = t.error;
    else if (t.value !== customer[fields[k]]) changes[fields[k]] = t.value;
  });
  if (Object.keys(errors).length) return errorResponse_('VALIDATION_ERROR', errors);

  // 画面を開いた後に他の人が変更していたら上書きしない
  if (body.expectedUpdatedAt !== customer.updated_at) return errorResponse_('VERSION_CONFLICT');
  if (!Object.keys(changes).length) return { ok: true, customer: toCustomerDetail_(customer) };

  changes.updated_at = formatJstIso_(now_());
  updateRecord_('Customers', 'customer_id', customer.customer_id, changes);
  var before = {};
  Object.keys(changes).forEach(function (k) { if (k !== 'updated_at') before[k] = customer[k]; });
  appendAudit_({
    userId: ctx.user.user_id, role: ctx.user.role, action: 'customer.update', targetType: 'customer',
    targetId: customer.customer_id, before: before, after: changes, result: 'success'
  });
  return { ok: true, customer: toCustomerDetail_(Object.assign({}, customer, changes)) };
}

/** 個人メモの保存（全ロール）。キャストは担当の顧客のみ。空にすると内容を消す。 */
function staffSaveCustomerNote_(ctx) {
  var body = ctx.body;
  var user = ctx.user;
  var customer = indexBy_(readAll_('Customers'), 'customer_id')[body.customerId];
  if (!customer || !isTruthyCell_(customer.active)) return errorResponse_('NOT_FOUND');
  if (!canViewCustomer_(user, customer.customer_id, readAll_('Visits'), readAll_('Reservations'))) {
    return errorResponse_('NOT_FOUND');
  }
  var text = validateNoteText_(body.body, CUSTOMER_NOTE_MAX_LENGTH, false);
  if (text.error) return errorResponse_('VALIDATION_ERROR', { body: text.error });

  var notes = readAll_('CustomerNotes');
  var note = findMyNote_(notes, customer.customer_id, user.user_id);
  var currentVersion = note ? Number(note.version) : 0;
  if (String(body.expectedVersion) !== String(currentVersion)) return errorResponse_('VERSION_CONFLICT');
  if (!note && text.value === '') return { ok: true, note: { body: '', version: 0, updatedAt: '' } };
  if (note && note.body === text.value) {
    return { ok: true, note: { body: note.body, version: currentVersion, updatedAt: note.updated_at } };
  }

  var nowIso = formatJstIso_(now_());
  var saved;
  if (note) {
    saved = { body: text.value, updated_at: nowIso, version: currentVersion + 1 };
    updateRecord_('CustomerNotes', 'note_id', note.note_id, saved);
    saved = Object.assign({}, note, saved);
  } else {
    saved = {
      note_id: nextSequentialId_(notes.map(function (n) { return n.note_id; }), 'CN-', 5),
      customer_id: customer.customer_id,
      user_id: user.user_id,
      body: text.value,
      created_at: nowIso,
      updated_at: nowIso,
      version: 1
    };
    appendRecord_('CustomerNotes', saved);
  }
  appendAudit_({
    userId: user.user_id, role: user.role, action: 'customer_note.save', targetType: 'customer',
    targetId: customer.customer_id, before: note ? { body: note.body } : null, after: { body: text.value },
    result: 'success'
  });
  return { ok: true, note: { body: saved.body, version: Number(saved.version), updatedAt: saved.updated_at } };
}
