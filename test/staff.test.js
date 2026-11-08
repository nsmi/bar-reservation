'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGasContext, STAFF_CHANNEL_ID } = require('./helpers/gasContext');

const sub = (ch) => 'U' + ch.repeat(32);
const SUBS = { owner: sub('1'), staff: sub('2'), castA: sub('3'), castB: sub('4'), newbie: sub('5'), customer: sub('c') };
const T = {
  owner: 'h.owner.s', staff: 'h.staff.s', castA: 'h.castA.s', castB: 'h.castB.s', newbie: 'h.newbie.s',
  customer: 'h.customer.s',           // 顧客用チャネルのトークン
  ownerOnCustomerApp: 'h.ownerc.s'    // オーナー本人だが顧客用チャネルのトークン
};

function setup() {
  const st = (s) => ({ sub: s, aud: STAFF_CHANNEL_ID });
  const c = createGasContext({
    tokens: {
      [T.owner]: st(SUBS.owner), [T.staff]: st(SUBS.staff), [T.castA]: st(SUBS.castA), [T.castB]: st(SUBS.castB),
      [T.newbie]: st(SUBS.newbie), [T.customer]: { sub: SUBS.customer }, [T.ownerOnCustomerApp]: { sub: SUBS.owner }
    }
  });
  c.gas.setupSheets();
  c.addUser({ user_id: 'USR-0001', login_identifier: SUBS.owner, display_name: 'オーナー', role: 'owner', active: true });
  c.addUser({ user_id: 'USR-0002', login_identifier: SUBS.castA, display_name: 'あや', role: 'cast', active: true });
  c.addUser({ user_id: 'USR-0003', login_identifier: SUBS.castB, display_name: 'ゆう', role: 'cast', active: true });
  c.addUser({ user_id: 'USR-0004', login_identifier: SUBS.staff, display_name: 'スタッフ', role: 'staff', active: true });
  c.call = (token, action, extra = {}) => c.post({ action, idToken: token, ...extra });
  c.at = (iso) => c.setNow(new Date(iso));
  return c;
}

const rid = () => crypto.randomUUID();
const castReservation = (c, token, extra = {}) => c.call(token, 'staff.createReservation', {
  requestId: rid(),
  reservation: { newCustomerNickname: 'けん', date: '2026-11-07', time: '21:00', numberOfGuests: 2, note: '', ...extra }
});

// ---------- 認証・認可 ----------

test('店舗APIは店舗用チャネルのトークンのみ受け付ける（顧客用トークンは拒否）', () => {
  const c = setup();
  assert.equal(c.call(T.owner, 'staff.me').ok, true);
  assert.equal(c.call(T.ownerOnCustomerApp, 'staff.me').error.code, 'AUTH_INVALID');
  assert.equal(c.call(T.customer, 'staff.me').error.code, 'AUTH_INVALID');
  assert.equal(c.call(undefined, 'staff.me').error.code, 'AUTH_REQUIRED');
});

test('未登録の LINE ユーザーは NOT_REGISTERED', () => {
  const c = setup();
  assert.equal(c.call(T.newbie, 'staff.me').error.code, 'NOT_REGISTERED');
});

test('ロールごとの権限（画面のボタン非表示に頼らない）', () => {
  const c = setup();
  const forbidden = (token, action, extra) => assert.equal(c.call(token, action, extra).error.code, 'FORBIDDEN', action);
  forbidden(T.staff, 'staff.overrideInvitation', { visitId: 'V', invitationType: 'store_customer', reason: 'x' });
  forbidden(T.castA, 'staff.overrideInvitation', { visitId: 'V', invitationType: 'store_customer', reason: 'x' });
  forbidden(T.castA, 'staff.createTransaction', { requestId: rid(), visitId: 'V', totalAmount: 1, castDrinkAmount: 0, paymentMethod: 'cash' });
  forbidden(T.castA, 'staff.listUsers');
  forbidden(T.staff, 'staff.listUsers');
  forbidden(T.staff, 'staff.createUser', { displayName: 'x', role: 'owner' });
  forbidden(T.castA, 'staff.issueInvite', { userId: 'USR-0002' });
  const denied = c.rows('AuditLogs').filter((l) => l.result === 'denied');
  assert.equal(denied.length, 7);
});

test('無効化されたユーザーは操作できない（オーナーは自分を無効化できない）', () => {
  const c = setup();
  assert.equal(c.call(T.owner, 'staff.setUserActive', { userId: 'USR-0002', active: false }).ok, true);
  assert.equal(c.call(T.castA, 'staff.me').error.code, 'FORBIDDEN');
  assert.equal(c.call(T.owner, 'staff.setUserActive', { userId: 'USR-0001', active: false }).error.code, 'VALIDATION_ERROR');
});

test('LINE_STAFF_CHANNEL_ID 未設定・顧客用と同一なら INTERNAL', () => {
  for (const v of ['', '1234567890']) {
    const c = createGasContext({ properties: { LINE_STAFF_CHANNEL_ID: v } });
    c.gas.setupSheets();
    assert.equal(c.post({ action: 'staff.me', idToken: T.owner }).error.code, 'INTERNAL');
  }
});

// ---------- 招待コード ----------

test('オーナーがユーザー作成 → 招待コードで本人の LINE を紐づけ', () => {
  const c = setup();
  const created = c.call(T.owner, 'staff.createUser', { displayName: 'みき', role: 'cast' });
  assert.equal(created.ok, true);
  assert.match(created.invite.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(created.user.linked, false);

  const typed = created.invite.code.toLowerCase().replace('-', ' ');
  const r = c.call(T.newbie, 'staff.redeemInvite', { code: typed });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.user.userId, 'USR-0005');
  const me = c.call(T.newbie, 'staff.me');
  assert.equal(me.user.role, 'cast');
  assert.equal(me.user.displayName, 'みき');

  // 使用済みコードは再利用不可
  assert.equal(c.call(T.newbie, 'staff.redeemInvite', { code: created.invite.code }).error.code, 'INVITE_INVALID');
  // 招待コードの平文はシートに残らない
  const dump = JSON.stringify([...c.ss.sheets.values()].map((s) => s.rows));
  assert.ok(!dump.includes(created.invite.code));
  // LINE の sub は Users 以外に残らない
  for (const name of ['AuditLogs', 'Invites', 'Reservations', 'Visits', 'Transactions']) {
    assert.ok(!JSON.stringify(c.ss.getSheetByName(name).rows).includes(SUBS.newbie), name);
  }
});

test('期限切れ・不正な招待コード、他ユーザーに紐づいた LINE は拒否', () => {
  const c = setup();
  const created = c.call(T.owner, 'staff.createUser', { displayName: 'みき', role: 'cast' });
  assert.equal(c.call(T.newbie, 'staff.redeemInvite', { code: 'AAAAA-AAAAA' }).error.code, 'INVITE_INVALID');
  assert.equal(c.call(T.newbie, 'staff.redeemInvite', { code: '=1+1' }).error.code, 'INVITE_INVALID');
  // 既に別ユーザー(あや)に紐づいた LINE では使えない
  assert.equal(c.call(T.castA, 'staff.redeemInvite', { code: created.invite.code }).error.code, 'ALREADY_LINKED');
  c.at('2026-11-08T12:00:01+09:00'); // 24時間超
  assert.equal(c.call(T.newbie, 'staff.redeemInvite', { code: created.invite.code }).error.code, 'INVITE_INVALID');
});

test('GAS エディタからの初回オーナー招待（オーナー行がなければ作成）', () => {
  const c = createGasContext({ tokens: { [T.owner]: { sub: SUBS.owner, aud: STAFF_CHANNEL_ID } } });
  c.gas.setupSheets();
  c.gas.issueOwnerInvite();
  const line = c.logs.find((l) => l.includes('招待コード'));
  const code = /([A-Z2-9]{5}-[A-Z2-9]{5})/.exec(line)[1];
  const r = c.post({ action: 'staff.redeemInvite', idToken: T.owner, code });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'owner');
});

// ---------- 予約 ----------

test('キャストの予約は source=cast、担当キャストは本人に固定（入力値は無視）', () => {
  const c = setup();
  const res = castReservation(c, T.castA, { assignedCastId: 'USR-0003', source: 'line_customer' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const r = c.rows('Reservations')[0];
  assert.equal(r.source, 'cast');
  assert.equal(r.assigned_cast_id, 'USR-0002');
  assert.equal(r.created_by_user_id, 'USR-0002');
  assert.equal(r.created_at, '2026-11-07T12:00:00+09:00');
  const cust = c.rows('Customers')[0];
  assert.equal(cust.nickname, 'けん');
  assert.equal(cust.line_user_id, '');
});

test('既存顧客を選んで予約でき、存在しない顧客は拒否', () => {
  const c = setup();
  castReservation(c, T.castA);
  const res = castReservation(c, T.castB, { newCustomerNickname: undefined, customerId: 'CUST-0001' });
  assert.equal(res.ok, true);
  assert.equal(c.rows('Customers').length, 1);
  assert.equal(castReservation(c, T.castB, { newCustomerNickname: undefined, customerId: 'CUST-9999' }).error.code, 'VALIDATION_ERROR');
});

test('キャストは自分の予約だけ、オーナー・スタッフは全予約を閲覧できる', () => {
  const c = setup();
  castReservation(c, T.castA);
  castReservation(c, T.castB);
  assert.equal(c.call(T.castA, 'staff.listReservations', { businessDate: '2026-11-07' }).reservations.length, 1);
  assert.equal(c.call(T.staff, 'staff.listReservations', { businessDate: '2026-11-07' }).reservations.length, 2);
  const list = c.call(T.owner, 'staff.listReservations', { businessDate: '2026-11-07' });
  assert.ok(!JSON.stringify(list).includes('login_identifier'));
});

test('予約の再送は重複登録しない', () => {
  const c = setup();
  const body = { requestId: rid(), reservation: { newCustomerNickname: 'けん', date: '2026-11-07', time: '21:00', numberOfGuests: 1 } };
  c.call(T.castA, 'staff.createReservation', body);
  const again = c.call(T.castA, 'staff.createReservation', body);
  assert.equal(again.replayed, true);
  assert.equal(c.rows('Reservations').length, 1);
  assert.equal(c.rows('Customers').length, 1);
});

// ---------- 来店・呼び判定 ----------

function reservationIdOf(c, i = 0) { return c.rows('Reservations')[i].reservation_id; }

test('キャストの事前予約をスタッフが来店登録 → 呼び。予約は visited になる', () => {
  const c = setup();
  castReservation(c, T.castA);
  c.at('2026-11-07T21:05:00+09:00');
  const res = c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.visit.invitationType, 'cast_invited');
  assert.equal(res.visit.attributedCastName, 'あや');
  const v = c.rows('Visits')[0];
  assert.equal(v.checked_in_at, '2026-11-07T21:05:00+09:00');
  assert.equal(v.checked_in_by, 'USR-0004');
  assert.equal(v.business_date, '2026-11-07');
  assert.equal(c.rows('Reservations')[0].status, 'visited');
  // 同じ予約で二重に来店登録できない
  assert.equal(c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c) }).error.code, 'RESERVATION_NOT_AVAILABLE');
});

test('キャスト本人が来店登録 → 要確認', () => {
  const c = setup();
  castReservation(c, T.castA);
  c.at('2026-11-07T21:00:00+09:00');
  const res = c.call(T.castA, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c) });
  assert.equal(res.visit.invitationType, 'review_required');
  assert.equal(res.visit.reason, 'self_checkin');
});

test('来店直前（30分未満）の予約 → 要確認', () => {
  const c = setup();
  c.at('2026-11-07T20:45:00+09:00');
  castReservation(c, T.castA);
  c.at('2026-11-07T21:00:00+09:00');
  const res = c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c) });
  assert.equal(res.visit.reason, 'registered_shortly_before');
});

test('顧客の LINE 予約・予約なし来店 → 店客', () => {
  const c = setup();
  const lineRes = c.post({
    action: 'createReservation', requestId: rid(), idToken: T.customer,
    reservation: { nickname: 'たかし', date: '2026-11-07', time: '21:00', numberOfGuests: 2, requestedCastId: 'USR-0002' }
  });
  assert.equal(lineRes.ok, true, JSON.stringify(lineRes));
  c.at('2026-11-07T21:00:00+09:00');
  const a = c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c) });
  assert.equal(a.visit.invitationType, 'store_customer');
  assert.equal(a.visit.reason, 'customer_line_reservation');
  const b = c.call(T.staff, 'staff.checkIn', { requestId: rid(), newCustomerNickname: 'ふらっと' });
  assert.equal(b.visit.invitationType, 'store_customer');
  assert.equal(b.visit.reason, 'no_reservation');
});

test('当日以外の予約・他キャストの予約は来店登録できない', () => {
  const c = setup();
  castReservation(c, T.castA, { date: '2026-11-08' });
  c.at('2026-11-07T21:00:00+09:00');
  assert.equal(c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c) }).error.code, 'RESERVATION_NOT_TODAY');
  c.at('2026-11-08T21:00:00+09:00');
  assert.equal(c.call(T.castB, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c) }).error.code, 'NOT_FOUND');
});

test('深夜（営業日切り替え前）の来店は前日の営業日', () => {
  const c = setup();
  castReservation(c, T.castA, { date: '2026-11-08', time: '01:00' });
  c.at('2026-11-08T01:10:00+09:00');
  const res = c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.visit.businessDate, '2026-11-07');
  assert.match(res.visit.visitId, /^V-20261107-/);
});

test('来店登録の再送は1件のみ', () => {
  const c = setup();
  c.at('2026-11-07T21:00:00+09:00');
  const body = { requestId: rid(), newCustomerNickname: 'ふらっと' };
  c.call(T.staff, 'staff.checkIn', body);
  assert.equal(c.call(T.staff, 'staff.checkIn', body).replayed, true);
  assert.equal(c.rows('Visits').length, 1);
  assert.equal(c.rows('Customers').length, 1);
});

// ---------- 会計・集計・判定変更 ----------

function scenario() {
  const c = setup();
  castReservation(c, T.castA);                         // 呼び
  castReservation(c, T.castA, { newCustomerNickname: 'じろう' }); // 本人来店登録 → 要確認
  c.at('2026-11-07T21:00:00+09:00');
  const invited = c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c, 0) }).visit;
  const review = c.call(T.castA, 'staff.checkIn', { requestId: rid(), reservationId: reservationIdOf(c, 1) }).visit;
  const store = c.call(T.staff, 'staff.checkIn', { requestId: rid(), newCustomerNickname: 'ふらっと' }).visit;
  c.at('2026-11-08T02:30:00+09:00'); // 深夜の会計
  const pay = (visit, total, drink) => c.call(T.staff, 'staff.createTransaction', {
    requestId: rid(), visitId: visit.visitId, totalAmount: total, castDrinkAmount: drink, paymentMethod: 'cash'
  });
  assert.equal(pay(invited, 20000, 5000).ok, true);
  assert.equal(pay(review, 10000, 0).ok, true);
  assert.equal(pay(store, 70000, 0).ok, true);
  return { c, invited, review, store, pay };
}

test('日次集計（資料の表示例どおり）。深夜の会計は来店の営業日に計上', () => {
  const { c } = scenario();
  const s = c.call(T.owner, 'staff.dailySummary', { businessDate: '2026-11-07' }).summary;
  assert.equal(s.totalSales, 100000);
  assert.equal(s.invitedSales, 20000);
  assert.equal(s.storeSales, 70000);
  assert.equal(s.reviewSales, 10000);
  assert.deepEqual(s.casts.map((x) => [x.castName, x.invitedSales, x.payout]), [['あや', 20000, 2000]]);
  assert.equal(s.reviewList.length, 1);
  assert.equal(c.rows('Transactions')[0].business_date, '2026-11-07');
  assert.equal(c.rows('Transactions')[0].payout_rate, 10);
});

test('キャストは自分の日払い予定のみ閲覧できる', () => {
  const { c } = scenario();
  const a = c.call(T.castA, 'staff.dailySummary', { businessDate: '2026-11-07' }).summary;
  assert.deepEqual(a, { businessDate: '2026-11-07', invitedSales: 20000, payout: 2000, visitCount: 1, reviewPendingCount: 1 });
  const b = c.call(T.castB, 'staff.dailySummary', { businessDate: '2026-11-07' }).summary;
  assert.equal(b.payout, 0);
  assert.equal(b.totalSales, undefined);
  // キャストの来店一覧に会計金額は含めない
  const visits = c.call(T.castA, 'staff.listVisits', { businessDate: '2026-11-07' }).visits;
  assert.equal(visits.length, 2);
  assert.ok(visits.every((v) => v.transaction === undefined));
});

test('会計の入力検証と1来店1会計', () => {
  const { c, invited, pay } = scenario();
  assert.equal(pay(invited, 1000, 0).error.code, 'ALREADY_PAID');
  const c2 = scenario();
  const fresh = c2.c.call(T.staff, 'staff.checkIn', { requestId: rid(), newCustomerNickname: 'x' }).visit;
  const bad = (total, drink, method = 'cash') => c2.c.call(T.staff, 'staff.createTransaction', {
    requestId: rid(), visitId: fresh.visitId, totalAmount: total, castDrinkAmount: drink, paymentMethod: method
  }).error;
  assert.deepEqual(Object.keys(bad(1000, 2000).fields), ['castDrinkAmount']);
  assert.deepEqual(Object.keys(bad(-1, 0).fields), ['totalAmount']);
  assert.deepEqual(Object.keys(bad(1000.5, 0).fields), ['totalAmount']);
  assert.deepEqual(Object.keys(bad('1000', 0).fields), ['totalAmount']);
  assert.deepEqual(Object.keys(bad(1000, 0, 'bitcoin').fields), ['paymentMethod']);
  assert.equal(c.call(T.staff, 'staff.createTransaction', { requestId: rid(), visitId: 'V-NONE', totalAmount: 1, castDrinkAmount: 0, paymentMethod: 'cash' }).error.code, 'NOT_FOUND');
});

test('オーナーが要確認を呼びに変更 → 日払いに反映、理由と変更前後が監査ログに残る', () => {
  const { c, review } = scenario();
  const noReason = c.call(T.owner, 'staff.overrideInvitation', {
    visitId: review.visitId, invitationType: 'cast_invited', attributedCastId: 'USR-0002', expectedVersion: 1
  });
  assert.equal(noReason.error.code, 'VALIDATION_ERROR');
  const ok = c.call(T.owner, 'staff.overrideInvitation', {
    visitId: review.visitId, invitationType: 'cast_invited', attributedCastId: 'USR-0002', reason: '事前に連絡を確認', expectedVersion: 1
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const s = c.call(T.owner, 'staff.dailySummary', { businessDate: '2026-11-07' }).summary;
  assert.equal(s.invitedSales, 30000);
  assert.equal(s.reviewSales, 0);
  assert.equal(s.casts[0].payout, 3000);
  const log = c.rows('AuditLogs').find((l) => l.action === 'visit.override_invitation');
  assert.equal(log.reason, '事前に連絡を確認');
  assert.equal(JSON.parse(log.before_json).invitation_type, 'review_required');
  // 古い version での更新は拒否（同時編集対策）
  const stale = c.call(T.owner, 'staff.overrideInvitation', {
    visitId: review.visitId, invitationType: 'store_customer', reason: 'x', expectedVersion: 1
  });
  assert.equal(stale.error.code, 'VERSION_CONFLICT');
  const listed = c.call(T.owner, 'staff.listVisits', { businessDate: '2026-11-07' }).visits.find((v) => v.visitId === review.visitId);
  assert.equal(listed.version, 2);
});
