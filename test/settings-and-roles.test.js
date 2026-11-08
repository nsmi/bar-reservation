'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGasContext, plain, STAFF_CHANNEL_ID } = require('./helpers/gasContext');

const sub = (ch) => 'U' + ch.repeat(32);
const SUBS = { owner: sub('1'), castA: sub('3'), staff: sub('2'), customer: sub('c') };
const T = { owner: 'h.owner.s', castA: 'h.castA.s', staff: 'h.staff.s', customer: 'h.customer.s' };

function setup() {
  const st = (s) => ({ sub: s, aud: STAFF_CHANNEL_ID });
  const c = createGasContext({
    tokens: { [T.owner]: st(SUBS.owner), [T.castA]: st(SUBS.castA), [T.staff]: st(SUBS.staff), [T.customer]: { sub: SUBS.customer } }
  });
  c.gas.setupSheets();
  c.addUser({ user_id: 'USR-0001', login_identifier: SUBS.owner, display_name: 'オーナー', role: 'owner', active: true });
  c.addUser({ user_id: 'USR-0002', login_identifier: SUBS.castA, display_name: 'あや', role: 'cast', active: true });
  c.addUser({ user_id: 'USR-0004', login_identifier: SUBS.staff, display_name: 'スタッフ', role: 'staff', active: true });
  c.call = (token, action, extra = {}) => c.post({ action, idToken: token, ...extra });
  return c;
}

const DEFAULTS = {
  openTime: '18:00', closeTime: '04:00', defaultTime: '21:00', timeStepMinutes: 15,
  maxDaysAhead: 60, minGuests: 1, maxGuests: 10, maxActivePerCustomer: 3
};

const customerReservation = (c, time, date = '2026-11-08') => c.post({
  action: 'createReservation', requestId: crypto.randomUUID(), idToken: T.customer,
  reservation: { nickname: 'たかし', date, time, numberOfGuests: 2, requestedCastId: '', note: '' }
});

// ---------- ロール変更 ----------

test('オーナーはロールを変更でき、変更前後が監査ログに残る', () => {
  const c = setup();
  const r = c.call(T.owner, 'staff.setUserRole', { userId: 'USR-0002', role: 'staff', expectedRole: 'cast' });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'staff');
  assert.equal(c.rows('Users').find((u) => u.user_id === 'USR-0002').role, 'staff');
  // 新しいロールがすぐに効く
  assert.equal(c.call(T.castA, 'staff.me').user.role, 'staff');
  const log = c.rows('AuditLogs').find((l) => l.action === 'user.role_change');
  assert.deepEqual(JSON.parse(log.before_json), { role: 'cast' });
  assert.deepEqual(JSON.parse(log.after_json), { role: 'staff' });
  // キャストでなくなると、顧客の予約画面の希望キャスト候補から外れる
  assert.equal(plain(c.post({ action: 'getFormOptions' })).casts.length, 0);
});

test('ロール変更: オーナー以外は不可、自分自身は不可、競合は VERSION_CONFLICT', () => {
  const c = setup();
  assert.equal(c.call(T.staff, 'staff.setUserRole', { userId: 'USR-0002', role: 'owner', expectedRole: 'cast' }).error.code, 'FORBIDDEN');
  assert.equal(c.call(T.castA, 'staff.setUserRole', { userId: 'USR-0002', role: 'owner', expectedRole: 'cast' }).error.code, 'FORBIDDEN');
  assert.equal(c.call(T.owner, 'staff.setUserRole', { userId: 'USR-0001', role: 'cast', expectedRole: 'owner' }).error.code, 'VALIDATION_ERROR');
  assert.equal(c.call(T.owner, 'staff.setUserRole', { userId: 'USR-0002', role: 'admin', expectedRole: 'cast' }).error.code, 'VALIDATION_ERROR');
  assert.equal(c.call(T.owner, 'staff.setUserRole', { userId: 'USR-9999', role: 'staff', expectedRole: 'cast' }).error.code, 'NOT_FOUND');
  assert.equal(c.call(T.owner, 'staff.setUserRole', { userId: 'USR-0002', role: 'staff', expectedRole: 'staff' }).error.code, 'VERSION_CONFLICT');
  assert.equal(c.rows('Users').find((u) => u.user_id === 'USR-0002').role, 'cast');
});

test('担当キャストが来店前にキャストでなくなった呼び予約は、来店登録で要確認になる', () => {
  const c = setup();
  c.setNow(new Date('2026-11-08T19:00:00+09:00'));
  const res = c.call(T.castA, 'staff.createReservation', {
    requestId: crypto.randomUUID(),
    reservation: { newCustomerNickname: 'けん', date: '2026-11-08', time: '21:00', numberOfGuests: 2, note: '' }
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  c.call(T.owner, 'staff.setUserRole', { userId: 'USR-0002', role: 'staff', expectedRole: 'cast' });
  c.setNow(new Date('2026-11-08T21:00:00+09:00'));
  const v = c.call(T.owner, 'staff.checkIn', { requestId: crypto.randomUUID(), reservationId: res.reservation.reservationId });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.visit.invitationType, 'review_required');
  assert.equal(v.visit.reason, 'cast_inactive');
});

// ---------- 予約受付の設定 ----------

test('設定の取得・変更はオーナーのみ', () => {
  const c = setup();
  assert.deepEqual(plain(c.call(T.owner, 'staff.getSettings').settings), DEFAULTS);
  assert.equal(c.call(T.staff, 'staff.getSettings').error.code, 'FORBIDDEN');
  assert.equal(c.call(T.castA, 'staff.updateSettings', { settings: DEFAULTS, expected: DEFAULTS }).error.code, 'FORBIDDEN');
});

test('設定を変更すると、予約画面の選択肢とサーバーの検証に反映される', () => {
  const c = setup();
  const next = { ...DEFAULTS, openTime: '19:00', closeTime: '02:00', defaultTime: '20:00', timeStepMinutes: 30, maxGuests: 6 };
  const r = c.call(T.owner, 'staff.updateSettings', { settings: next, expected: DEFAULTS });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(c.properties.RESERVATION_OPEN_TIME, '19:00');

  const opts = plain(c.post({ action: 'getFormOptions' })).constraints;
  assert.equal(opts.openTime, '19:00');
  assert.equal(opts.closeTime, '02:00');
  assert.equal(opts.defaultTime, '20:00');
  assert.equal(opts.timeStepMinutes, 30);
  assert.equal(opts.maxGuests, 6);
  assert.equal(c.call(T.owner, 'staff.me').constraints.openTime, '19:00');

  assert.equal(customerReservation(c, '18:30').error.fields.scheduledAt, 'outside_hours');
  assert.equal(customerReservation(c, '19:15').error.fields.scheduledAt, 'invalid_step');
  assert.equal(customerReservation(c, '02:30', '2026-11-09').error.fields.scheduledAt, 'outside_hours');
  assert.equal(customerReservation(c, '02:00', '2026-11-09').ok, true);
  assert.equal(customerReservation(c, '19:00').ok, true);

  const log = c.rows('AuditLogs').find((l) => l.action === 'settings.update');
  assert.equal(JSON.parse(log.before_json).openTime, '18:00');
  assert.equal(JSON.parse(log.after_json).openTime, '19:00');
});

test('設定: 他のオーナーが先に変更していたら VERSION_CONFLICT', () => {
  const c = setup();
  assert.equal(c.call(T.owner, 'staff.updateSettings', { settings: { ...DEFAULTS, maxGuests: 8 }, expected: DEFAULTS }).ok, true);
  const r = c.call(T.owner, 'staff.updateSettings', { settings: { ...DEFAULTS, maxGuests: 5 }, expected: DEFAULTS });
  assert.equal(r.error.code, 'VERSION_CONFLICT');
  assert.equal(c.properties.RESERVATION_MAX_GUESTS, '8');
});

test('設定の検証: 不正な値は保存しない', () => {
  const c = setup();
  const bad = (patch) => {
    const r = c.call(T.owner, 'staff.updateSettings', { settings: { ...DEFAULTS, ...patch }, expected: DEFAULTS });
    assert.equal(r.ok, false, JSON.stringify(patch));
    return plain(r.error.fields);
  };
  assert.equal(bad({ openTime: '25:00' }).openTime, 'invalid');
  assert.equal(bad({ timeStepMinutes: 20 }).timeStepMinutes, 'invalid');
  assert.equal(bad({ timeStepMinutes: 30, openTime: '18:15' }).openTime, 'invalid_step');
  // 営業日の切り替え（6:00）をまたぐ受付時間は不可
  assert.equal(bad({ closeTime: '07:00' }).closeTime, 'before_open');
  assert.equal(bad({ openTime: '05:00', closeTime: '04:00', defaultTime: '05:00' }).closeTime, 'before_open');
  assert.equal(bad({ closeTime: '18:00' }).closeTime, 'before_open');
  assert.equal(bad({ defaultTime: '05:00' }).defaultTime, 'outside_hours');
  assert.equal(bad({ minGuests: 4, maxGuests: 3 }).maxGuests, 'less_than_min');
  assert.equal(bad({ maxDaysAhead: 400 }).maxDaysAhead, 'out_of_range');
  assert.equal(bad({ maxActivePerCustomer: 0 }).maxActivePerCustomer, 'out_of_range');
  assert.equal(bad({ maxGuests: '10' }).maxGuests, 'invalid');
  assert.equal(c.properties.RESERVATION_OPEN_TIME, undefined);
  assert.equal(c.rows('AuditLogs').filter((l) => l.action === 'settings.update').length, 0);
});

test('受付時間: 既定（18:00〜翌04:00）の範囲外は受け付けない', () => {
  const c = setup();
  assert.equal(customerReservation(c, '17:45').error.fields.scheduledAt, 'outside_hours');
  assert.equal(customerReservation(c, '04:15', '2026-11-09').error.fields.scheduledAt, 'outside_hours');
  assert.equal(customerReservation(c, '04:00', '2026-11-09').ok, true);
});

test('受付期間は営業日で数える（0日なら当日の営業日のみ、深夜帯も可）', () => {
  const c = setup();
  c.call(T.owner, 'staff.updateSettings', { settings: { ...DEFAULTS, maxDaysAhead: 0 }, expected: DEFAULTS });
  // 既定の現在時刻 2026-11-07 12:00 → 当日の営業日は 11/07
  assert.equal(customerReservation(c, '21:00', '2026-11-07').ok, true);
  assert.equal(customerReservation(c, '01:00', '2026-11-08').ok, true);
  assert.equal(customerReservation(c, '21:00', '2026-11-08').error.fields.scheduledAt, 'too_far');
});
