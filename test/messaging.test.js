'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGasContext, response, STAFF_CHANNEL_ID } = require('./helpers/gasContext');

// 公式LINE連携: 友だち限定の予約、お断りの連絡（キャンセル）
const FRIEND = 'U' + 'f'.repeat(32);
const STRANGER = 'U' + 'e'.repeat(32);
const OWNER_SUB = 'U' + '1'.repeat(32);
const CAST_SUB = 'U' + '3'.repeat(32);
const TOKEN = 'secret-channel-access-token';
const T = { friend: 'h.friend.s', stranger: 'h.stranger.s', owner: 'h.owner.s', cast: 'h.cast.s' };

function setup({ token = TOKEN, require = false, line = {} } = {}) {
  const sent = [];
  const properties = {};
  if (token) properties.LINE_MESSAGING_ACCESS_TOKEN = token;
  if (require) properties.RESERVATION_REQUIRE_FRIENDSHIP = 'true';
  const lineApi = (url, opts) => {
    if (line.down) throw new Error('network');
    assert.equal(opts.headers.Authorization, 'Bearer ' + TOKEN);
    if (url.startsWith('https://api.line.me/v2/bot/profile/')) {
      const id = decodeURIComponent(url.split('/').pop());
      if (line.profileStatus) return response(line.profileStatus, {});
      return id === FRIEND ? response(200, { userId: id, displayName: 'LINE名' }) : response(404, { message: 'Not found' });
    }
    if (url === 'https://api.line.me/v2/bot/message/push') {
      sent.push({ body: JSON.parse(opts.payload), retryKey: opts.headers['X-Line-Retry-Key'] });
      return response(line.pushStatus || 200, {});
    }
    throw new Error('unexpected ' + url);
  };
  const c = createGasContext({
    tokens: {
      [T.friend]: { sub: FRIEND }, [T.stranger]: { sub: STRANGER },
      [T.owner]: { sub: OWNER_SUB, aud: STAFF_CHANNEL_ID }, [T.cast]: { sub: CAST_SUB, aud: STAFF_CHANNEL_ID }
    },
    properties,
    lineApi
  });
  c.gas.setupSheets();
  c.addUser({ user_id: 'USR-0001', login_identifier: OWNER_SUB, display_name: 'オーナー', role: 'owner', active: true });
  c.addUser({ user_id: 'USR-0002', login_identifier: CAST_SUB, display_name: 'あや', role: 'cast', active: true });
  c.setNow(new Date('2026-11-07T12:00:00+09:00'));
  c.sent = sent;
  return c;
}

const book = (c, token) => c.post({
  action: 'createReservation', requestId: crypto.randomUUID(), idToken: token,
  reservation: { nickname: 'たかし', date: '2026-11-10', time: '21:00', numberOfGuests: 2, note: '' }
});
const listFor = (c, token = T.owner) => c.post({ action: 'staff.listReservations', idToken: token, businessDate: '2026-11-10' }).reservations;

// ---------- 友だち限定 ----------

test('友だち限定がオフ（既定）なら、友だちでなくても予約でき、LINE API は呼ばない', () => {
  const c = setup();
  assert.equal(book(c, T.stranger).ok, true);
  assert.ok(!c.fetchCalls.some((f) => f.url.includes('/v2/bot/')));
  assert.deepEqual(c.post({ action: 'checkFriendship', idToken: T.stranger }), { ok: true, required: false, friend: true });
});

test('友だち限定がオンなら、友だちでない人は NOT_FRIEND で、顧客も登録しない', () => {
  const c = setup({ require: true });
  assert.equal(c.post({ action: 'getFormOptions' }).requireFriendship, true);
  assert.deepEqual(c.post({ action: 'checkFriendship', idToken: T.stranger }), { ok: true, required: true, friend: false });
  assert.deepEqual(c.post({ action: 'checkFriendship', idToken: T.friend }), { ok: true, required: true, friend: true });
  assert.equal(c.post({ action: 'checkFriendship', idToken: 'bad.token.x' }).error.code, 'AUTH_INVALID');
  assert.equal(book(c, T.stranger).error.code, 'NOT_FRIEND');
  assert.equal(c.rows('Customers').length, 0);
  assert.equal(book(c, T.friend).ok, true);
  // プロフィール（LINE の表示名など）は保存しない
  assert.ok(!JSON.stringify([...c.ss.sheets.values()].map((s) => s.rows)).includes('LINE名'));
});

test('友だちか判定できない（LINE 側の障害・トークン失効）ときは予約を受け付ける', () => {
  assert.equal(book(setup({ require: true, line: { down: true } }), T.stranger).ok, true);
  assert.equal(book(setup({ require: true, line: { profileStatus: 401 } }), T.stranger).ok, true);
});

test('トークン未設定では友だち限定をオンにできない', () => {
  const c = setup({ token: '' });
  const cur = JSON.parse(JSON.stringify(c.post({ action: 'staff.getSettings', idToken: T.owner })));
  assert.equal(cur.messagingConfigured, false);
  const r = c.post({ action: 'staff.updateSettings', idToken: T.owner, settings: { ...cur.settings, requireFriendship: true }, expected: cur.settings });
  assert.equal(r.error.fields.requireFriendship, 'not_configured');
  const ok = setup();
  const cur2 = JSON.parse(JSON.stringify(ok.post({ action: 'staff.getSettings', idToken: T.owner })));
  assert.equal(cur2.messagingConfigured, true);
  assert.ok(!JSON.stringify(cur2).includes(TOKEN), 'トークンを画面へ返さない');
  assert.equal(ok.post({ action: 'staff.updateSettings', idToken: T.owner, settings: { ...cur2.settings, requireFriendship: true }, expected: cur2.settings }).ok, true);
  assert.equal(ok.properties.RESERVATION_REQUIRE_FRIENDSHIP, 'true');
});

// ---------- お断りの連絡・キャンセル ----------

test('お断りの連絡: 公式LINEから送ってからキャンセル。ユーザーIDは画面にもログにも出さない', () => {
  const c = setup();
  book(c, T.friend);
  const r = listFor(c)[0];
  assert.equal(r.lineReachable, true);
  assert.ok(!JSON.stringify(listFor(c)).includes(FRIEND));
  const requestId = crypto.randomUUID();
  const res = c.post({ action: 'staff.cancelReservation', idToken: T.owner, requestId, reservationId: r.reservationId, expectedVersion: r.version, notifyMessage: 'たかし様\n満席のためお受けできませんでした。' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.notified, true);
  assert.deepEqual(c.sent, [{ body: { to: FRIEND, messages: [{ type: 'text', text: 'たかし様\n満席のためお受けできませんでした。' }] }, retryKey: requestId }]);
  assert.equal(c.rows('Reservations')[0].status, 'cancelled');
  const log = c.rows('AuditLogs').find((l) => l.action === 'reservation.decline');
  assert.ok(log.after_json.includes('満席のため'));
  assert.ok(!JSON.stringify(c.rows('AuditLogs')).includes(FRIEND));
  // キャンセル済みは数えないので、同じ枠が空く／再度のキャンセルはできない
  assert.equal(c.post({ action: 'staff.cancelReservation', idToken: T.owner, requestId: crypto.randomUUID(), reservationId: r.reservationId, expectedVersion: 2 }).error.code, 'RESERVATION_NOT_AVAILABLE');
});

test('送信に失敗したらキャンセルしない（友だちでない・ブロック・上限）', () => {
  for (const [status, code] of [[400, 'MESSAGE_UNREACHABLE'], [429, 'MESSAGE_QUOTA'], [500, 'MESSAGE_FAILED']]) {
    const c = setup({ line: { pushStatus: status } });
    book(c, T.friend);
    const r = listFor(c)[0];
    const res = c.post({ action: 'staff.cancelReservation', idToken: T.owner, requestId: crypto.randomUUID(), reservationId: r.reservationId, expectedVersion: r.version, notifyMessage: 'x' });
    assert.equal(res.error.code, code);
    assert.equal(c.rows('Reservations')[0].status, 'reserved');
    assert.equal(c.rows('AuditLogs').filter((l) => l.result === 'failed').length, 1);
  }
});

test('連絡なしのキャンセル・店舗で登録した予約・権限・トークン未設定', () => {
  const c = setup({ token: '' });
  // 店舗で登録した予約（LINE のユーザーIDなし）は連絡できないが、キャンセルはできる
  c.post({ action: 'staff.createReservation', idToken: T.owner, requestId: crypto.randomUUID(), reservation: { newCustomerNickname: '電話の方', date: '2026-11-10', time: '22:00', numberOfGuests: 2, note: '' } });
  book(c, T.friend);
  const [walk, line] = [listFor(c).find((x) => x.nickname === '電話の方'), listFor(c).find((x) => x.nickname === 'たかし')];
  assert.equal(walk.lineReachable, false);
  const cancel = (r, extra = {}, token = T.owner) => c.post({ action: 'staff.cancelReservation', idToken: token, requestId: crypto.randomUUID(), reservationId: r.reservationId, expectedVersion: r.version, ...extra });
  assert.equal(cancel(walk, { notifyMessage: 'x' }).error.fields.notifyMessage, 'no_line');
  assert.equal(cancel(line, { notifyMessage: 'x' }).error.code, 'MESSAGING_NOT_CONFIGURED');
  assert.equal(cancel(line, {}, T.cast).error.code, 'FORBIDDEN');
  assert.equal(cancel({ ...line, version: 9 }).error.code, 'VERSION_CONFLICT');
  assert.equal(cancel(walk).ok, true);
  assert.equal(c.rows('AuditLogs').filter((l) => l.action === 'reservation.cancel').length, 1);
  assert.equal(cancel(line, { notifyMessage: 'あ'.repeat(501) }).error.fields.notifyMessage, 'too_long');
});
