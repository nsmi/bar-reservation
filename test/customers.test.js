'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGasContext, STAFF_CHANNEL_ID } = require('./helpers/gasContext');

// 顧客タブ（従業員ごとの顧客管理）
const sub = (ch) => 'U' + ch.repeat(32);
const SUBS = { owner: sub('1'), staff: sub('2'), castA: sub('3'), castB: sub('4') };
const T = { owner: 'h.owner.s', staff: 'h.staff.s', castA: 'h.castA.s', castB: 'h.castB.s' };
const rid = () => crypto.randomUUID();

function setup() {
  const st = (s) => ({ sub: s, aud: STAFF_CHANNEL_ID });
  const c = createGasContext({
    tokens: { [T.owner]: st(SUBS.owner), [T.staff]: st(SUBS.staff), [T.castA]: st(SUBS.castA), [T.castB]: st(SUBS.castB) }
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

/**
 * けん: あやの呼び予約で来店（会計 10000円）
 * みほ: 予約なしで来店（店客、会計 5000円）
 * たく: ゆうの呼び予約（来店前）
 */
function seed() {
  const c = setup();
  c.at('2026-11-07T18:00:00+09:00');
  c.call(T.castA, 'staff.createReservation', { requestId: rid(), reservation: { newCustomerNickname: 'けん', date: '2026-11-07', time: '21:00', numberOfGuests: 1, note: '' } });
  c.call(T.castB, 'staff.createReservation', { requestId: rid(), reservation: { newCustomerNickname: 'たく', date: '2026-11-08', time: '21:00', numberOfGuests: 1, note: '' } });
  c.at('2026-11-07T21:00:00+09:00');
  const v1 = c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: c.rows('Reservations')[0].reservation_id }).visit;
  const v2 = c.call(T.staff, 'staff.checkIn', { requestId: rid(), newCustomerNickname: 'みほ' }).visit;
  c.call(T.staff, 'staff.createTransaction', { requestId: rid(), visitId: v1.visitId, totalAmount: 10000, castDrinkAmount: 2000, paymentMethod: 'cash' });
  c.call(T.staff, 'staff.createTransaction', { requestId: rid(), visitId: v2.visitId, totalAmount: 5000, castDrinkAmount: 0, paymentMethod: 'card' });
  assert.equal(v1.invitationType, 'cast_invited');
  const ids = Object.fromEntries(c.rows('Customers').map((r) => [r.nickname, r.customer_id]));
  return { c, ids };
}

const nicks = (res) => res.customers.map((x) => x.nickname).sort();

test('キャストは担当の顧客だけ一覧に出る。オーナー・スタッフは全員、担当者で絞り込める', () => {
  const { c } = seed();
  assert.deepEqual(nicks(c.call(T.castA, 'staff.listCustomerProfiles')), ['けん']);
  assert.deepEqual(nicks(c.call(T.castB, 'staff.listCustomerProfiles')), ['たく']);
  // キャストが他人の担当で絞り込もうとしても本人の分しか返らない
  assert.deepEqual(nicks(c.call(T.castA, 'staff.listCustomerProfiles', { assigneeUserId: 'USR-0003' })), ['けん']);
  assert.deepEqual(nicks(c.call(T.staff, 'staff.listCustomerProfiles')), ['けん', 'たく', 'みほ']);
  assert.deepEqual(nicks(c.call(T.owner, 'staff.listCustomerProfiles', { assigneeUserId: 'USR-0003' })), ['たく']);
  assert.equal(c.call(T.owner, 'staff.listCustomerProfiles', { assigneeUserId: 'USR-9999' }).error.code, 'VALIDATION_ERROR');

  const ken = c.call(T.castA, 'staff.listCustomerProfiles').customers[0];
  assert.equal(ken.visitCount, 1);
  assert.equal(ken.lastVisitDate, '2026-11-07');
  assert.equal(ken.totalSales, 10000);
  assert.equal(ken.invitedSales, 10000);
  assert.equal(ken.assigneeNames, undefined); // キャストには担当者一覧を返さない
  const all = c.call(T.owner, 'staff.listCustomerProfiles').customers;
  assert.deepEqual(all.find((x) => x.nickname === 'けん').assigneeNames, ['あや']);
  // LINEユーザーIDなどは含まない
  assert.ok(!JSON.stringify(all).includes('line_user_id'));
});

test('顧客の詳細: 来店履歴と会計額。キャストは担当外の顧客を見られない', () => {
  const { c, ids } = seed();
  const d = c.call(T.castA, 'staff.getCustomer', { customerId: ids['けん'] });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.visits.length, 1);
  assert.equal(d.visits[0].totalAmount, 10000);
  assert.equal(d.visits[0].castDrinkAmount, 2000);
  assert.equal(d.visits[0].mine, true);
  assert.equal(d.reservations.length, 1);
  assert.deepEqual(d.permissions, { editShared: false, editNickname: false });
  assert.equal(d.customer.hasLine, false);
  // 担当外の顧客は存在も分からない
  assert.equal(c.call(T.castA, 'staff.getCustomer', { customerId: ids['みほ'] }).error.code, 'NOT_FOUND');
  assert.equal(c.call(T.castB, 'staff.getCustomer', { customerId: ids['けん'] }).error.code, 'NOT_FOUND');
  assert.equal(c.call(T.staff, 'staff.getCustomer', { customerId: ids['みほ'] }).ok, true);
});

test('キャストが見る来店履歴では、他の人の担当名は出ない', () => {
  const { c, ids } = seed();
  // ゆうの担当の「たく」が、あやの呼びでも来店した
  c.at('2026-11-08T18:00:00+09:00');
  const r = c.call(T.owner, 'staff.createReservation', { requestId: rid(), reservation: { type: 'invite', assigneeUserId: 'USR-0002', customerId: ids['たく'], date: '2026-11-08', time: '21:30', numberOfGuests: 1, note: '' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  c.at('2026-11-08T21:30:00+09:00');
  c.call(T.staff, 'staff.checkIn', { requestId: rid(), reservationId: r.reservation.reservationId });
  const forB = c.call(T.castB, 'staff.getCustomer', { customerId: ids['たく'] });
  assert.equal(forB.visits[0].mine, false);
  assert.equal(forB.visits[0].attributedCastName, '');
  // ゆうには、あやの予約は見えない（自分の予約だけ）
  assert.equal(forB.reservations.length, 1);
  const forOwner = c.call(T.owner, 'staff.getCustomer', { customerId: ids['たく'] });
  assert.equal(forOwner.visits[0].attributedCastName, 'あや');
});

test('共通メモはオーナー・スタッフが編集、あだ名の変更はオーナーのみ、変更は監査ログへ', () => {
  const { c, ids } = seed();
  const id = ids['けん'];
  const cur = c.call(T.staff, 'staff.getCustomer', { customerId: id }).customer;
  const input = { nickname: cur.nickname, ageGroup: '30s', identificationNote: '眼鏡', favoriteDrink: 'ハイボール', memo: '=HYPERLINK("x")' };
  // キャストは編集できない
  assert.equal(c.call(T.castA, 'staff.updateCustomer', { customerId: id, expectedUpdatedAt: cur.updatedAt, customer: input }).error.code, 'FORBIDDEN');
  // スタッフはあだ名を変えられない
  assert.equal(c.call(T.staff, 'staff.updateCustomer', { customerId: id, expectedUpdatedAt: cur.updatedAt, customer: { ...input, nickname: 'けんじ' } }).error.code, 'FORBIDDEN');
  assert.equal(c.call(T.staff, 'staff.updateCustomer', { customerId: id, expectedUpdatedAt: cur.updatedAt, customer: { ...input, ageGroup: '10s' } }).error.fields.ageGroup, 'invalid');

  c.at('2026-11-08T12:00:00+09:00');
  const r = c.call(T.staff, 'staff.updateCustomer', { customerId: id, expectedUpdatedAt: cur.updatedAt, customer: input });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.customer.favoriteDrink, 'ハイボール');
  const row = c.rows('Customers').find((x) => x.customer_id === id);
  assert.equal(row.memo, '=HYPERLINK("x")'); // テキストとして保存（数式にならない）
  // 古い updatedAt のままでは上書きできない
  assert.equal(c.call(T.owner, 'staff.updateCustomer', { customerId: id, expectedUpdatedAt: cur.updatedAt, customer: input }).error.code, 'VERSION_CONFLICT');
  // オーナーはあだ名を変えられる。キャストにも反映される
  const o = c.call(T.owner, 'staff.updateCustomer', { customerId: id, expectedUpdatedAt: r.customer.updatedAt, customer: { ...input, nickname: 'けんじ' } });
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(c.call(T.castA, 'staff.getCustomer', { customerId: id }).customer.nickname, 'けんじ');
  const logs = c.rows('AuditLogs').filter((l) => l.action === 'customer.update');
  assert.equal(logs.length, 2);
  assert.equal(JSON.parse(logs[1].before_json).nickname, 'けん');
  assert.equal(JSON.parse(logs[1].after_json).nickname, 'けんじ');
});

test('個人メモは本人だけに見える。キャストは担当の顧客のみ保存できる', () => {
  const { c, ids } = seed();
  const id = ids['けん'];
  // 新規は expectedVersion 0
  const s1 = c.call(T.castA, 'staff.saveCustomerNote', { customerId: id, body: '誕生日は12月', expectedVersion: 0 });
  assert.equal(s1.ok, true, JSON.stringify(s1));
  assert.equal(s1.note.version, 1);
  assert.equal(c.call(T.castA, 'staff.saveCustomerNote', { customerId: id, body: '上書き', expectedVersion: 0 }).error.code, 'VERSION_CONFLICT');
  const s2 = c.call(T.castA, 'staff.saveCustomerNote', { customerId: id, body: '誕生日は12/3', expectedVersion: 1 });
  assert.equal(s2.note.version, 2);

  assert.equal(c.call(T.castA, 'staff.getCustomer', { customerId: id }).myNote.body, '誕生日は12/3');
  // オーナー・スタッフの画面には他人の個人メモは出ない
  const forOwner = c.call(T.owner, 'staff.getCustomer', { customerId: id });
  assert.equal(forOwner.myNote.body, '');
  assert.ok(!JSON.stringify(forOwner).includes('誕生日'));
  c.call(T.owner, 'staff.saveCustomerNote', { customerId: id, body: 'オーナーのメモ', expectedVersion: 0 });
  assert.equal(c.call(T.castA, 'staff.getCustomer', { customerId: id }).myNote.body, '誕生日は12/3');
  assert.equal(c.rows('CustomerNotes').length, 2);

  // 担当外の顧客には保存できない
  assert.equal(c.call(T.castA, 'staff.saveCustomerNote', { customerId: ids['みほ'], body: 'x', expectedVersion: 0 }).error.code, 'NOT_FOUND');
  assert.equal(c.call(T.castA, 'staff.saveCustomerNote', { customerId: id, body: 'あ'.repeat(501), expectedVersion: 2 }).error.fields.body, 'too_long');
});

test('CustomerNotes シートが無い既存環境でも、初回アクセス時に自動で作られる', () => {
  const { c, ids } = seed();
  c.ss.sheets.delete('CustomerNotes');
  assert.equal(c.call(T.castA, 'staff.getCustomer', { customerId: ids['けん'] }).ok, true);
  assert.deepEqual(c.ss.getSheetByName('CustomerNotes').rows[0].slice(0, 3), ['note_id', 'customer_id', 'user_id']);
  assert.equal(c.call(T.castA, 'staff.saveCustomerNote', { customerId: ids['けん'], body: 'メモ', expectedVersion: 0 }).ok, true);
});
