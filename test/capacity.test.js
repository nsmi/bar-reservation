'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGasContext, STAFF_CHANNEL_ID } = require('./helpers/gasContext');

// 予約の受付上限（1日の組数・人数、1時間あたりの組数）
const subs = ['a', 'b', 'c', 'd', 'e'].map((ch) => 'U' + ch.repeat(32));
const OWNER_SUB = 'U' + '1'.repeat(32);
const OWNER = 'h.owner.s';
const tok = (i) => 'h.cust' + i + '.s';

function setup(limits = {}) {
  const tokens = { [OWNER]: { sub: OWNER_SUB, aud: STAFF_CHANNEL_ID } };
  subs.forEach((s, i) => { tokens[tok(i)] = { sub: s }; });
  const c = createGasContext({ tokens, properties: limits });
  c.gas.setupSheets();
  c.addUser({ user_id: 'USR-0001', login_identifier: OWNER_SUB, display_name: 'オーナー', role: 'owner', active: true });
  c.setNow(new Date('2026-11-07T12:00:00+09:00'));
  return c;
}

const book = (c, i, time = '21:00', guests = 2, date = '2026-11-10') => c.post({
  action: 'createReservation', requestId: crypto.randomUUID(), idToken: tok(i),
  reservation: { nickname: 'お客' + i, date, time, numberOfGuests: guests, note: '' }
});
const options = (c) => JSON.parse(JSON.stringify(c.post({ action: 'getFormOptions' })));

test('上限なし（既定）なら何件でも受け付け、満席情報は空', () => {
  const c = setup();
  for (let i = 0; i < 5; i++) assert.equal(book(c, i).ok, true);
  assert.deepEqual(options(c).availability, { fullDates: [], fullHours: {} });
});

test('1日の組数: 上限に達した日は FULLY_BOOKED、新しいお客様も登録しない', () => {
  const c = setup({ RESERVATION_MAX_GROUPS_PER_DAY: '2' });
  assert.equal(book(c, 0).ok, true);
  assert.equal(book(c, 1, '23:00').ok, true);
  const r = book(c, 2, '01:00', 2, '2026-11-11'); // 11/11 深夜1時は 11/10 の営業日として数える
  assert.equal(r.error.code, 'FULLY_BOOKED');
  assert.deepEqual(r.error.fields.capacity, ['day_groups']);
  assert.equal(c.rows('Customers').length, 2);
  assert.equal(book(c, 2, '21:00', 2, '2026-11-11').ok, true); // 11/11 の営業日は空いている
  assert.deepEqual(options(c).availability.fullDates, ['2026-11-10']);
});

test('1日の人数: 人数が収まらなければ断る。最少人数も入らない日は満席', () => {
  const c = setup({ RESERVATION_MAX_GUESTS_PER_DAY: '6' });
  assert.equal(book(c, 0, '21:00', 4).ok, true);
  assert.deepEqual(book(c, 1, '22:00', 3).error.fields.capacity, ['day_guests']);
  assert.deepEqual(options(c).availability.fullDates, []); // 2名ならまだ入れる
  assert.equal(book(c, 1, '22:00', 2).ok, true);
  assert.deepEqual(options(c).availability.fullDates, ['2026-11-10']);
});

test('1時間あたりの組数: 同じ時間帯（21:00〜21:59）だけ満席', () => {
  const c = setup({ RESERVATION_MAX_GROUPS_PER_HOUR: '1' });
  assert.equal(book(c, 0, '21:00').ok, true);
  assert.deepEqual(book(c, 1, '21:45').error.fields.capacity, ['hour_groups']);
  assert.equal(book(c, 1, '22:00').ok, true);
  assert.deepEqual(options(c).availability, { fullDates: [], fullHours: { '2026-11-10': ['21', '22'] } });
});

test('キャンセル・来店なしの予約は数えない。同じ予約の再送は上限に関係なく同じ結果を返す', () => {
  const c = setup({ RESERVATION_MAX_GROUPS_PER_DAY: '1' });
  const first = c.post({
    action: 'createReservation', requestId: '11111111-1111-4111-8111-111111111111', idToken: tok(0),
    reservation: { nickname: 'お客0', date: '2026-11-10', time: '21:00', numberOfGuests: 2, note: '' }
  });
  assert.equal(first.ok, true);
  const again = c.post({
    action: 'createReservation', requestId: '11111111-1111-4111-8111-111111111111', idToken: tok(0),
    reservation: { nickname: 'お客0', date: '2026-11-10', time: '21:00', numberOfGuests: 2, note: '' }
  });
  assert.equal(again.replayed, true);
  assert.equal(book(c, 1).error.code, 'FULLY_BOOKED');
  // キャンセルにすると空く
  const sheet = c.ss.getSheetByName('Reservations');
  const col = sheet.rows[0].indexOf('status');
  sheet.rows[1][col] = 'cancelled';
  assert.equal(book(c, 1).ok, true);
});

test('店舗用画面からは上限を超えても登録でき、警告を返す。予約一覧に店全体の件数を返す', () => {
  const c = setup({ RESERVATION_MAX_GROUPS_PER_DAY: '1', RESERVATION_MAX_GUESTS_PER_DAY: '3' });
  assert.equal(book(c, 0).ok, true);
  const r = c.post({
    action: 'staff.createReservation', idToken: OWNER, requestId: crypto.randomUUID(),
    reservation: { newCustomerNickname: '電話の方', date: '2026-11-10', time: '22:00', numberOfGuests: 2, note: '' }
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.capacityWarnings, ['day_groups', 'day_guests']);
  const list = JSON.parse(JSON.stringify(c.post({ action: 'staff.listReservations', idToken: OWNER, businessDate: '2026-11-10' })));
  assert.deepEqual(list.capacity, { groups: 2, guests: 4, maxGroups: 1, maxGuests: 3, maxGroupsPerHour: 0 });
});

test('設定: 上限は0（上限なし）以上。1日の人数上限は最少人数以上', () => {
  const c = setup();
  const cur = JSON.parse(JSON.stringify(c.post({ action: 'staff.getSettings', idToken: OWNER }).settings));
  assert.equal(cur.maxGroupsPerDay, 0);
  const save = (patch) => c.post({ action: 'staff.updateSettings', idToken: OWNER, settings: { ...cur, ...patch }, expected: cur });
  assert.equal(save({ maxGroupsPerDay: -1 }).error.fields.maxGroupsPerDay, 'out_of_range');
  assert.equal(save({ minGuests: 2, maxGuestsPerDay: 1 }).error.fields.maxGuestsPerDay, 'less_than_min');
  assert.equal(save({ maxGroupsPerDay: 10, maxGuestsPerDay: 30, maxGroupsPerHour: 4 }).ok, true);
  assert.equal(c.properties.RESERVATION_MAX_GROUPS_PER_HOUR, '4');
});
