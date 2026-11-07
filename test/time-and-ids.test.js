'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasContext } = require('./helpers/gasContext');

const { gas } = createGasContext();

test('formatJstIso_ は日本時間で出力する', () => {
  assert.equal(gas.formatJstIso_(new Date('2026-11-07T15:30:05Z')), '2026-11-08T00:30:05+09:00');
});

test('jstLocalToDate_ は日本時間として解釈し、存在しない日付を拒否する', () => {
  assert.equal(gas.jstLocalToDate_('2026-11-10', '21:00').toISOString(), '2026-11-10T12:00:00.000Z');
  assert.equal(gas.jstLocalToDate_('2026-02-30', '21:00'), null);
  assert.equal(gas.jstLocalToDate_('2026-11-10', '24:00'), null);
  assert.equal(gas.jstLocalToDate_('2026/11/10', '21:00'), null);
});

test('営業日は午前6時で切り替わる', () => {
  assert.equal(gas.businessDateOf_(new Date('2026-11-08T03:00:00+09:00'), 6), '2026-11-07');
  assert.equal(gas.businessDateOf_(new Date('2026-11-08T05:59:59+09:00'), 6), '2026-11-07');
  assert.equal(gas.businessDateOf_(new Date('2026-11-08T06:00:00+09:00'), 6), '2026-11-08');
  assert.equal(gas.businessDateOf_(new Date('2026-11-08T07:00:00+09:00'), 6), '2026-11-08');
});

test('顧客IDは最大値+1で採番する（行番号に依存しない）', () => {
  assert.equal(gas.nextCustomerId_([]), 'CUST-0001');
  assert.equal(gas.nextCustomerId_([{ customer_id: 'CUST-0003' }, { customer_id: 'CUST-0001' }]), 'CUST-0004');
});

test('予約IDは登録日（日本時間）ごとの連番', () => {
  const now = new Date('2026-11-07T23:30:00+09:00');
  const existing = [{ reservation_id: 'R-20261107-001' }, { reservation_id: 'R-20261106-009' }];
  assert.equal(gas.nextReservationId_(existing, now), 'R-20261107-002');
  assert.equal(gas.nextReservationId_([], new Date('2026-11-07T15:30:00Z')), 'R-20261108-001');
});

test('toCellValue_ は文字列をテキストとして書き込む（数式インジェクション対策）', () => {
  assert.equal(gas.toCellValue_('=IMPORTXML("http://x","//a")'), '\'=IMPORTXML("http://x","//a")');
  assert.equal(gas.toCellValue_(''), '');
  assert.equal(gas.toCellValue_(2), 2);
  assert.equal(gas.toCellValue_(null), '');
});
