'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasContext, plain } = require('./helpers/gasContext');

const { gas } = createGasContext();
const config = Object.assign({}, gas.CONFIG_DEFAULTS);
const now = new Date('2026-11-07T12:00:00+09:00');

const valid = () => ({
  nickname: 'たかし',
  date: '2026-11-10',
  time: '21:00',
  numberOfGuests: 2,
  requestedCastId: '',
  note: ''
});

function errorsOf(input) {
  const r = gas.validateReservationInput_(input, now, config);
  return r.ok ? {} : plain(r.errors);
}

test('正常な入力を受け付ける', () => {
  const r = gas.validateReservationInput_(valid(), now, config);
  assert.equal(r.ok, true);
  assert.equal(r.value.scheduledAt.toISOString(), '2026-11-10T12:00:00.000Z');
  assert.equal(r.value.numberOfGuests, 2);
});

test('あだ名: 必須・最大20文字・制御文字禁止・前後空白除去', () => {
  assert.equal(errorsOf({ ...valid(), nickname: '   ' }).nickname, 'required');
  assert.equal(errorsOf({ ...valid(), nickname: 'あ'.repeat(21) }).nickname, 'too_long');
  assert.equal(errorsOf({ ...valid(), nickname: 'あ'.repeat(20) }).nickname, undefined);
  assert.equal(errorsOf({ ...valid(), nickname: 'a\u0000b' }).nickname, 'invalid_chars');
  assert.equal(errorsOf({ ...valid(), nickname: 123 }).nickname, 'required');
  assert.equal(gas.validateReservationInput_({ ...valid(), nickname: '  たかし ' }, now, config).value.nickname, 'たかし');
});

test('日時: 形式・過去・60日超・15分刻み', () => {
  assert.equal(errorsOf({ ...valid(), date: '2026-13-01' }).scheduledAt, 'invalid');
  assert.equal(errorsOf({ ...valid(), date: '2026-11-07', time: '11:45' }).scheduledAt, 'past');
  assert.equal(errorsOf({ ...valid(), date: '2026-11-07', time: '12:00' }).scheduledAt, 'past');
  assert.equal(errorsOf({ ...valid(), date: '2027-01-08', time: '21:00' }).scheduledAt, 'too_far');
  assert.equal(errorsOf({ ...valid(), date: '2027-01-06', time: '21:00' }).scheduledAt, undefined);
  assert.equal(errorsOf({ ...valid(), time: '21:10' }).scheduledAt, 'invalid_step');
  assert.equal(errorsOf({ ...valid(), date: undefined }).scheduledAt, 'required');
});

test('人数: 1〜10 の整数のみ', () => {
  assert.equal(errorsOf({ ...valid(), numberOfGuests: 0 }).numberOfGuests, 'out_of_range');
  assert.equal(errorsOf({ ...valid(), numberOfGuests: 11 }).numberOfGuests, 'out_of_range');
  assert.equal(errorsOf({ ...valid(), numberOfGuests: 2.5 }).numberOfGuests, 'invalid');
  assert.equal(errorsOf({ ...valid(), numberOfGuests: '2' }).numberOfGuests, 'invalid');
});

test('希望キャストと備考', () => {
  assert.equal(errorsOf({ ...valid(), requestedCastId: 'USR-0001' }).requestedCastId, undefined);
  assert.equal(errorsOf({ ...valid(), requestedCastId: '=HYPERLINK()' }).requestedCastId, 'invalid');
  assert.equal(errorsOf({ ...valid(), note: 'あ'.repeat(201) }).note, 'too_long');
  assert.equal(errorsOf({ ...valid(), note: '1行目\r\n2行目' }).note, undefined);
});

test('予約データ自体がない場合', () => {
  assert.deepEqual(errorsOf(null), { reservation: 'required' });
  assert.deepEqual(errorsOf([]), { reservation: 'required' });
});

test('requestId は UUID 形式のみ', () => {
  assert.equal(gas.isValidRequestId_('3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'), true);
  assert.equal(gas.isValidRequestId_('abc'), false);
  assert.equal(gas.isValidRequestId_(undefined), false);
});
