'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasContext, plain } = require('./helpers/gasContext');

const { gas } = createGasContext();

const castA = { user_id: 'USR-0002', role: 'cast', active: 'true', display_name: 'あや' };
const staff = { user_id: 'USR-0009', role: 'staff', active: 'true', display_name: 'スタッフ' };
const users = [castA, staff];
const checkedInAt = new Date('2026-11-07T21:00:00+09:00');

function castReservation(overrides = {}) {
  return {
    reservation_id: 'R-20261107-001',
    source: 'cast',
    assigned_cast_id: 'USR-0002',
    created_by_user_id: 'USR-0002',
    created_at: '2026-11-07T12:00:00+09:00',
    version: '1',
    ...overrides
  };
}

function judge(reservation, by = staff) {
  return plain(gas.determineInvitation_({ reservation, checkedInBy: by, checkedInAt, users, thresholdMinutes: 30 }));
}

test('判定表（引き継ぎ資料 6.2）', () => {
  // キャストが事前予約、別スタッフが来店登録 → 呼び
  assert.deepEqual(judge(castReservation()), { type: 'cast_invited', castId: 'USR-0002', reason: 'cast_reservation' });
  // 予約なし → 店客
  assert.equal(judge(null).type, 'store_customer');
  // 来店後にキャストが予約登録 → 店客
  assert.equal(judge(castReservation({ created_at: '2026-11-07T21:05:00+09:00' })).type, 'store_customer');
  // 顧客が LINE から予約（希望キャストあり）→ 店客
  assert.deepEqual(judge({ source: 'line_customer', requested_cast_id: 'USR-0002', created_at: '2026-11-01T00:00:00+09:00', version: '1' }),
    { type: 'store_customer', castId: '', reason: 'customer_line_reservation' });
  // キャストが事前予約し、本人が来店登録 → 要確認
  assert.deepEqual(judge(castReservation(), castA), { type: 'review_required', castId: 'USR-0002', reason: 'self_checkin' });
  // 来店直前（30分未満）に予約登録 → 要確認
  assert.equal(judge(castReservation({ created_at: '2026-11-07T20:31:00+09:00' })).reason, 'registered_shortly_before');
  // ちょうど30分前 → 呼び
  assert.equal(judge(castReservation({ created_at: '2026-11-07T20:30:00+09:00' })).type, 'cast_invited');
  // 担当キャストが変更されている → 要確認
  assert.equal(judge(castReservation({ version: '2' })).reason, 'reservation_modified');
});

test('店舗受付（owner/staff 登録）の予約は店客', () => {
  assert.equal(judge(castReservation({ source: 'owner', assigned_cast_id: '' })).reason, 'store_reservation');
});

test('担当キャストが無効化されている場合は要確認', () => {
  const r = gas.determineInvitation_({
    reservation: castReservation(), checkedInBy: staff, checkedInAt, thresholdMinutes: 30,
    users: [{ ...castA, active: 'false' }, staff]
  });
  assert.equal(r.reason, 'cast_inactive');
});

test('日次集計: 呼び売上は総売上の内訳、日払いはキャストドリンク代込み総額の10%を切り捨て', () => {
  const visits = [
    { visit_id: 'V1', business_date: '2026-11-07', customer_id: 'C1', invitation_type: 'cast_invited', attributed_cast_id: 'USR-0002' },
    { visit_id: 'V2', business_date: '2026-11-07', customer_id: 'C2', invitation_type: 'cast_invited', attributed_cast_id: 'USR-0002' },
    { visit_id: 'V3', business_date: '2026-11-07', customer_id: 'C3', invitation_type: 'store_customer', attributed_cast_id: '' },
    { visit_id: 'V4', business_date: '2026-11-07', customer_id: 'C4', invitation_type: 'review_required', attributed_cast_id: 'USR-0002', determination_reason: 'self_checkin' },
    { visit_id: 'V5', business_date: '2026-11-07', customer_id: 'C5', invitation_type: 'store_customer', attributed_cast_id: '' },
    { visit_id: 'V9', business_date: '2026-11-06', customer_id: 'C1', invitation_type: 'cast_invited', attributed_cast_id: 'USR-0002' }
  ];
  const tx = (id, visitId, total, drink, date = '2026-11-07', status = 'open') =>
    ({ transaction_id: id, visit_id: visitId, business_date: date, total_amount: String(total), cast_drink_amount: String(drink), payout_rate: '10', status });
  const transactions = [
    tx('T1', 'V1', 12345, 3000),
    tx('T2', 'V2', 7659, 0),
    tx('T3', 'V3', 70000, 0),
    tx('T4', 'V4', 10000, 2000),
    tx('T8', 'V5', 99999, 0, '2026-11-07', 'void'),
    tx('T9', 'V9', 50000, 0, '2026-11-06')
  ];
  const customers = [{ customer_id: 'C4', nickname: 'たかし' }];
  const s = plain(gas.computeDailySummary_(visits, transactions, users, customers, '2026-11-07'));
  assert.equal(s.totalSales, 100004);
  assert.equal(s.invitedSales, 20004);
  assert.equal(s.storeSales, 70000);
  assert.equal(s.reviewSales, 10000);
  assert.equal(s.invitedSales + s.storeSales + s.reviewSales, s.totalSales);
  // (12345 + 7659) × 10% = 2000.4 → 2000（キャスト単位で合算してから切り捨て）
  assert.deepEqual(s.casts, [{ castId: 'USR-0002', castName: 'あや', invitedSales: 20004, payout: 2000, visitCount: 2 }]);
  assert.equal(s.reviewList.length, 1);
  assert.equal(s.reviewList[0].nickname, 'たかし');
  assert.equal(s.unpaidVisitCount, 1, 'void の会計は未会計扱い');
});
