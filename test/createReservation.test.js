'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGasContext } = require('./helpers/gasContext');

const SUB_A = 'U' + 'a'.repeat(32);
const SUB_B = 'U' + 'b'.repeat(32);
const TOKEN_A = 'header.payloadA.sig';
const TOKEN_B = 'header.payloadB.sig';

function setup(opts = {}) {
  const c = createGasContext({
    tokens: { [TOKEN_A]: { sub: SUB_A }, [TOKEN_B]: { sub: SUB_B } },
    ...opts
  });
  c.gas.setupSheets();
  c.addUser({ user_id: 'USR-0001', login_identifier: 'owner@example.com', display_name: 'オーナー', role: 'owner', active: true });
  c.addUser({ user_id: 'USR-0002', login_identifier: 'a@example.com', display_name: 'あや', role: 'cast', active: true });
  c.addUser({ user_id: 'USR-0003', login_identifier: 'b@example.com', display_name: 'ゆう', role: 'cast', active: false });
  return c;
}

function body(overrides = {}) {
  return {
    action: 'createReservation',
    requestId: crypto.randomUUID(),
    idToken: TOKEN_A,
    reservation: { nickname: 'たかし', date: '2026-11-10', time: '21:00', numberOfGuests: 2, requestedCastId: '', note: '' },
    ...overrides
  };
}

test('予約が1件保存され、予約完了情報が返る', () => {
  const c = setup();
  const res = c.post(body({ reservation: { ...body().reservation, requestedCastId: 'USR-0002', note: '窓際希望' } }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.replayed, false);
  assert.equal(res.reservation.reservationId, 'R-20261107-001');
  assert.equal(res.reservation.scheduledAt, '2026-11-10T21:00:00+09:00');
  assert.equal(res.reservation.numberOfGuests, 2);
  assert.equal(res.reservation.requestedCastName, 'あや');

  const rows = c.rows('Reservations');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.customer_id, 'CUST-0001');
  assert.equal(r.source, 'line_customer');
  assert.equal(r.assigned_cast_id, '', '顧客予約では担当キャストを設定しない');
  assert.equal(r.requested_cast_id, 'USR-0002');
  assert.equal(r.status, 'reserved');
  assert.equal(r.created_at, '2026-11-07T12:00:00+09:00', 'サーバー時刻で記録');
  assert.equal(r.version, 1);

  const customers = c.rows('Customers');
  assert.equal(customers.length, 1);
  assert.equal(customers[0].line_user_id, SUB_A);
  assert.equal(customers[0].nickname, 'たかし');

  const audit = c.rows('AuditLogs').map((l) => l.action);
  assert.deepEqual(audit, ['customer.create', 'reservation.create']);
});

test('同じ requestId の再送では重複登録せず、同じ予約を返す（二重タップ対策）', () => {
  const c = setup();
  const b = body();
  const first = c.post(b);
  const second = c.post(b);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.reservation.reservationId, first.reservation.reservationId);
  assert.equal(c.rows('Reservations').length, 1);
});

test('他人の requestId を使っても、その人の予約内容は返らない', () => {
  const c = setup();
  const b = body();
  c.post(b);
  const res = c.post({ ...b, idToken: TOKEN_B });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'REQUEST_ID_CONFLICT');
  assert.equal(res.reservation, undefined);
});

test('既存顧客は LINE 識別子で照合し、あだ名が違っても同じ顧客IDになる', () => {
  const c = setup();
  c.post(body());
  const res = c.post(body({ reservation: { ...body().reservation, nickname: '別名' } }));
  assert.equal(res.ok, true);
  assert.equal(c.rows('Customers').length, 1);
  const rows = c.rows('Reservations');
  assert.equal(rows[1].customer_id, 'CUST-0001');
  assert.equal(rows[1].nickname, '別名');
  assert.equal(rows[1].reservation_id, 'R-20261107-002');
});

test('同じあだ名でも LINE ユーザーが違えば別顧客', () => {
  const c = setup();
  c.post(body());
  c.post(body({ idToken: TOKEN_B }));
  assert.deepEqual(c.rows('Customers').map((x) => x.customer_id), ['CUST-0001', 'CUST-0002']);
});

test('クライアントが送った lineUserId・作成日時・担当キャストは無視される', () => {
  const c = setup();
  const res = c.post(body({
    lineUserId: SUB_B,
    reservation: {
      ...body().reservation,
      lineUserId: SUB_B,
      createdAt: '2020-01-01T00:00:00+09:00',
      assignedCastId: 'USR-0002',
      source: 'cast',
      status: 'visited'
    }
  }));
  assert.equal(res.ok, true);
  const r = c.rows('Reservations')[0];
  assert.equal(c.rows('Customers')[0].line_user_id, SUB_A);
  assert.equal(r.created_at, '2026-11-07T12:00:00+09:00');
  assert.equal(r.assigned_cast_id, '');
  assert.equal(r.source, 'line_customer');
  assert.equal(r.status, 'reserved');
});

test('IDトークンなし・不正トークンでは保存されない', () => {
  const c = setup();
  assert.equal(c.post(body({ idToken: undefined })).error.code, 'AUTH_REQUIRED');
  assert.equal(c.post(body({ idToken: 'forged.token.value' })).error.code, 'AUTH_INVALID');
  assert.equal(c.rows('Reservations').length, 0);
  assert.equal(c.rows('Customers').length, 0);
  const denied = c.rows('AuditLogs').filter((l) => l.result === 'denied');
  assert.equal(denied.length, 2);
  assert.equal(denied[1].reason, 'AUTH_INVALID (line_400: Invalid IdToken.)');
});

test('IDトークン・LINEユーザーIDがログやシートに残らない（Customers以外）', () => {
  const c = setup();
  c.post(body());
  c.post(body({ idToken: 'forged.token.value' }));
  for (const name of ['Reservations', 'AuditLogs', 'Users']) {
    const dump = JSON.stringify(c.ss.getSheetByName(name).rows);
    assert.ok(!dump.includes(TOKEN_A), name + ' contains id token');
    assert.ok(!dump.includes('forged.token.value'), name + ' contains forged token');
    assert.ok(!dump.includes(SUB_A), name + ' contains LINE user id');
  }
  assert.ok(!JSON.stringify(c.rows('Customers')).includes(TOKEN_A));
  assert.ok(!c.logs.join('\n').includes(TOKEN_A));
});

test('不正な値は VALIDATION_ERROR で、保存されない', () => {
  const c = setup();
  const res = c.post(body({ reservation: { nickname: '', date: '2026-11-01', time: '21:00', numberOfGuests: 99 } }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(Object.keys(res.error.fields).sort(), ['nickname', 'numberOfGuests', 'scheduledAt']);
  assert.equal(c.rows('Reservations').length, 0);
});

test('無効・存在しない希望キャストは拒否', () => {
  const c = setup();
  for (const castId of ['USR-0003', 'USR-9999', 'USR-0001']) {
    const res = c.post(body({ reservation: { ...body().reservation, requestedCastId: castId } }));
    assert.equal(res.error.code, 'VALIDATION_ERROR', castId);
    assert.equal(res.error.fields.requestedCastId, 'unknown');
  }
  assert.equal(c.rows('Reservations').length, 0);
});

test('有効な予約は1顧客3件まで', () => {
  const c = setup();
  for (let i = 0; i < 3; i++) assert.equal(c.post(body()).ok, true);
  const res = c.post(body());
  assert.equal(res.error.code, 'LIMIT_EXCEEDED');
  assert.equal(c.rows('Reservations').length, 3);
  // 別の顧客は影響を受けない
  assert.equal(c.post(body({ idToken: TOKEN_B })).ok, true);
});

test('停止(active=false)された顧客は予約できない', () => {
  const c = setup();
  c.post(body());
  const sheet = c.ss.getSheetByName('Customers');
  const activeCol = c.gas.SCHEMAS.Customers.indexOf('active');
  sheet.rows[1][activeCol] = false;
  assert.equal(c.post(body()).error.code, 'CUSTOMER_INACTIVE');
});

test('ロックを取得できない場合は BUSY で、保存しない', () => {
  const c = setup();
  c.lockState.available = false;
  assert.equal(c.post(body()).error.code, 'BUSY');
  assert.equal(c.rows('Reservations').length, 0);
});

test('ロックは処理後に必ず解放される（例外時も含む）', () => {
  const c = setup();
  c.post(body());
  assert.equal(c.lockState.held, 0);
  c.ss.getSheetByName('Reservations').rows[0][0] = 'broken_header';
  const res = c.post(body());
  assert.equal(res.error.code, 'INTERNAL');
  assert.equal(c.lockState.held, 0);
});

test('数式風の入力はテキストとして保存される', () => {
  const c = setup();
  const res = c.post(body({ reservation: { ...body().reservation, nickname: '=1+1', note: '@SUM(A1)' } }));
  assert.equal(res.ok, true);
  assert.equal(c.rows('Reservations')[0].nickname, '=1+1');
});

test('不正なリクエスト形式', () => {
  const c = setup();
  assert.equal(c.post('not json').error.code, 'INVALID_REQUEST');
  assert.equal(c.post('[]').error.code, 'INVALID_REQUEST');
  assert.equal(c.post({ action: 'deleteAll' }).error.code, 'UNKNOWN_ACTION');
  assert.equal(c.post(body({ requestId: 'x' })).error.code, 'VALIDATION_ERROR');
  assert.equal(c.post('x'.repeat(10001)).error.code, 'INVALID_REQUEST');
});

test('LINE_CHANNEL_ID 未設定なら INTERNAL（設定値の不備を外部に出さない）', () => {
  const c = createGasContext({ properties: { LINE_CHANNEL_ID: '' } });
  c.gas.setupSheets();
  assert.equal(c.post(body()).error.code, 'INTERNAL');
});

test('getFormOptions は有効なキャストの表示名とIDだけを返す', () => {
  const c = setup();
  const res = c.post({ action: 'getFormOptions' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.casts, [{ castId: 'USR-0002', displayName: 'あや' }]);
  assert.equal(res.constraints.maxGuests, 10);
  assert.ok(!JSON.stringify(res).includes('@example.com'), 'メールアドレスを返さない');
});

test('setupSheets はタイムゾーンを設定し、再実行しても既存データを壊さない', () => {
  const c = setup();
  c.post(body());
  c.gas.setupSheets();
  assert.equal(c.ss.timeZone, 'Asia/Tokyo');
  assert.equal(c.rows('Reservations').length, 1);
});
