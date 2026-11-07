'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasContext, CHANNEL_ID } = require('./helpers/gasContext');

const SUB = 'U' + 'a'.repeat(32);
const now = new Date('2026-11-07T12:00:00+09:00');
const nowSec = Math.floor(now.getTime() / 1000);

function ctxWithResponse(status, body) {
  return createGasContext({
    fetchHandler: () => ({ getResponseCode: () => status, getContentText: () => JSON.stringify(body) })
  });
}

const goodClaims = () => ({ iss: 'https://access.line.me', sub: SUB, aud: CHANNEL_ID, exp: nowSec + 600 });

test('検証成功時は LINE が返した sub を返す', () => {
  const c = ctxWithResponse(200, goodClaims());
  const r = c.gas.verifyLineIdToken_('a.b.c', CHANNEL_ID, now);
  assert.equal(r.ok, true);
  assert.equal(r.sub, SUB);
  assert.equal(c.fetchCalls.length, 1);
  assert.equal(c.fetchCalls[0].opts.payload.client_id, CHANNEL_ID);
  assert.equal(c.fetchCalls[0].opts.payload.id_token, 'a.b.c');
});

test('トークン未送信・形式不正は LINE に問い合わせずに拒否', () => {
  const c = ctxWithResponse(200, goodClaims());
  assert.equal(c.gas.verifyLineIdToken_(undefined, CHANNEL_ID, now).code, 'AUTH_REQUIRED');
  assert.equal(c.gas.verifyLineIdToken_('', CHANNEL_ID, now).code, 'AUTH_REQUIRED');
  assert.equal(c.gas.verifyLineIdToken_('not-a-jwt', CHANNEL_ID, now).code, 'AUTH_INVALID');
  assert.equal(c.fetchCalls.length, 0);
});

test('LINE が 400 を返したら AUTH_INVALID', () => {
  const c = ctxWithResponse(400, { error: 'invalid_request' });
  assert.equal(c.gas.verifyLineIdToken_('a.b.c', CHANNEL_ID, now).code, 'AUTH_INVALID');
});

test('LINE 側障害は AUTH_UNAVAILABLE', () => {
  const c = ctxWithResponse(503, {});
  assert.equal(c.gas.verifyLineIdToken_('a.b.c', CHANNEL_ID, now).code, 'AUTH_UNAVAILABLE');
  const c2 = createGasContext({ fetchHandler: () => { throw new Error('network'); } });
  assert.equal(c2.gas.verifyLineIdToken_('a.b.c', CHANNEL_ID, now).code, 'AUTH_UNAVAILABLE');
});

test('aud / iss / exp / sub が不正なら拒否', () => {
  const cases = [
    { ...goodClaims(), aud: '999' },
    { ...goodClaims(), iss: 'https://evil.example' },
    { ...goodClaims(), exp: nowSec - 1 },
    { ...goodClaims(), sub: 'Uxxxxxxxx' }
  ];
  for (const claims of cases) {
    const c = ctxWithResponse(200, claims);
    assert.equal(c.gas.verifyLineIdToken_('a.b.c', CHANNEL_ID, now).code, 'AUTH_INVALID', JSON.stringify(claims));
  }
});

test('拒否理由(detail)を返す（トークン本体は含めない）', () => {
  const c = createGasContext({
    fetchHandler: () => ({
      getResponseCode: () => 400,
      getContentText: () => JSON.stringify({ error: 'invalid_request', error_description: 'IdToken expired.' })
    })
  });
  const r = c.gas.verifyLineIdToken_('a.b.c', CHANNEL_ID, now);
  assert.equal(r.code, 'AUTH_INVALID');
  assert.equal(r.detail, 'line_400: IdToken expired.');
  const c2 = ctxWithResponse(200, { ...goodClaims(), aud: '999' });
  assert.equal(c2.gas.verifyLineIdToken_('a.b.c', CHANNEL_ID, now).detail, 'aud_mismatch');
});
