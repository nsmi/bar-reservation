/**
 * 店舗ユーザー（owner / staff / cast）の認証・認可（ADR-0002）。
 * - 店舗用ミニアプリの LINE IDトークンを毎リクエスト検証する（aud = LINE_STAFF_CHANNEL_ID）。
 * - 検証済み sub を Users.login_identifier と照合し、active とロールをサーバー側で判定する。
 * - sub と店舗ユーザーの紐づけは、オーナーが発行する1回限りの招待コードで行う。
 */
var STAFF_ROLES = ['owner', 'staff', 'cast'];
var INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I を除く32文字

/** アクション定義。ファイル読み込み順に依存しないよう関数で返す。 */
function staffActions_() {
  var ALL = STAFF_ROLES;
  var OWNER_STAFF = ['owner', 'staff'];
  var OWNER = ['owner'];
  return {
    'staff.me':                { roles: ALL,         write: false, handler: staffMe_ },
    'staff.listCustomers':     { roles: ALL,         write: false, handler: staffListCustomers_ },
    'staff.listReservations':  { roles: ALL,         write: false, handler: staffListReservations_ },
    'staff.createReservation': { roles: ALL,         write: true,  handler: staffCreateReservation_ },
    'staff.listVisits':        { roles: ALL,         write: false, handler: staffListVisits_ },
    'staff.checkIn':           { roles: ALL,         write: true,  handler: staffCheckIn_ },
    'staff.overrideInvitation':{ roles: OWNER,       write: true,  handler: staffOverrideInvitation_ },
    'staff.createTransaction': { roles: OWNER_STAFF, write: true,  handler: staffCreateTransaction_ },
    'staff.dailySummary':      { roles: ALL,         write: false, handler: staffDailySummary_ },
    'staff.listUsers':         { roles: OWNER,       write: false, handler: staffListUsers_ },
    'staff.createUser':        { roles: OWNER,       write: true,  handler: staffCreateUser_ },
    'staff.setUserActive':     { roles: OWNER,       write: true,  handler: staffSetUserActive_ },
    'staff.setUserRole':       { roles: OWNER,       write: true,  handler: staffSetUserRole_ },
    'staff.getSettings':       { roles: OWNER,       write: false, handler: staffGetSettings_ },
    'staff.updateSettings':    { roles: OWNER,       write: true,  handler: staffUpdateSettings_ },
    'staff.issueInvite':       { roles: OWNER,       write: true,  handler: staffIssueInvite_ }
  };
}

function handleStaffRequest_(body) {
  var config = getConfig_();
  if (!config.LINE_STAFF_CHANNEL_ID) throw new Error('CONFIG: LINE_STAFF_CHANNEL_ID is not set');

  var isRedeem = body.action === 'staff.redeemInvite';
  var def = isRedeem ? null : staffActions_()[body.action];
  if (!isRedeem && !def) return errorResponse_('UNKNOWN_ACTION');

  var auth = verifyLineIdToken_(body.idToken, config.LINE_STAFF_CHANNEL_ID, now_());
  if (!auth.ok) {
    var reason = auth.code + (auth.detail ? ' (' + auth.detail + ')' : '');
    console.warn('Staff auth rejected: ' + reason);
    if (auth.code !== 'AUTH_UNAVAILABLE') {
      safeAppendAudit_({ role: 'unknown', action: body.action, reason: reason, result: 'denied' });
    }
    return errorResponse_(auth.code);
  }

  if (isRedeem) {
    return withScriptLock_(config, function () { return redeemInvite_(body, auth.sub, config); });
  }

  var user = findUserBySub_(readAll_('Users'), auth.sub);
  if (!user) return errorResponse_('NOT_REGISTERED');
  if (!isTruthyCell_(user.active) || STAFF_ROLES.indexOf(user.role) < 0) {
    safeAppendAudit_({ userId: user.user_id, role: user.role, action: body.action, reason: 'inactive_user', result: 'denied' });
    return errorResponse_('FORBIDDEN');
  }
  if (def.roles.indexOf(user.role) < 0) {
    safeAppendAudit_({ userId: user.user_id, role: user.role, action: body.action, reason: 'role_not_allowed', result: 'denied' });
    return errorResponse_('FORBIDDEN');
  }

  var ctx = { user: user, config: config, body: body };
  if (def.write) return withScriptLock_(config, function () { return def.handler(ctx); });
  return def.handler(ctx);
}

function withScriptLock_(config, fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(config.LOCK_WAIT_MS)) return errorResponse_('BUSY');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function findUserBySub_(users, sub) {
  if (!sub) return null;
  for (var i = 0; i < users.length; i++) {
    if (users[i].login_identifier === sub) return users[i];
  }
  return null;
}

function findUser_(users, userId) {
  for (var i = 0; i < users.length; i++) {
    if (users[i].user_id === userId) return users[i];
  }
  return null;
}

function isLinkedIdentifier_(v) {
  return LINE_USER_ID_PATTERN.test(String(v || ''));
}

function staffMe_(ctx) {
  var c = ctx.config;
  return {
    ok: true,
    user: { userId: ctx.user.user_id, displayName: ctx.user.display_name, role: ctx.user.role },
    businessDate: businessDateOf_(now_(), c.BUSINESS_DAY_CUTOFF_HOUR),
    constraints: {
      minGuests: c.RESERVATION_MIN_GUESTS,
      maxGuests: c.RESERVATION_MAX_GUESTS,
      maxDaysAhead: c.RESERVATION_MAX_DAYS_AHEAD,
      timeStepMinutes: c.RESERVATION_TIME_STEP_MINUTES,
      openTime: c.RESERVATION_OPEN_TIME,
      closeTime: c.RESERVATION_CLOSE_TIME,
      defaultTime: c.RESERVATION_DEFAULT_TIME,
      nicknameMaxLength: c.NICKNAME_MAX_LENGTH,
      noteMaxLength: c.NOTE_MAX_LENGTH,
      displayNameMaxLength: c.DISPLAY_NAME_MAX_LENGTH,
      amountMax: c.AMOUNT_MAX,
      businessDayCutoffHour: c.BUSINESS_DAY_CUTOFF_HOUR,
      reviewThresholdMinutes: c.REVIEW_THRESHOLD_MINUTES,
      payoutRatePercent: c.PAYOUT_RATE_PERCENT
    }
  };
}

// ---------- 招待コード ----------

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b + 256) % 256 + 0x100).toString(16).slice(1); }).join('');
}

/** 50bit 相当のランダムな招待コード（XXXXX-XXXXX）。 */
function generateInviteCode_() {
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var chars = '';
  for (var i = 0; i < 10; i++) {
    var byte = parseInt(hex.substr(i * 2 + 16, 2), 16); // UUID の可変部（ランダム部）を使用
    chars += INVITE_ALPHABET.charAt(byte % 32);
  }
  return chars.slice(0, 5) + '-' + chars.slice(5);
}

function normalizeInviteCode_(code) {
  if (typeof code !== 'string') return null;
  var c = code.toUpperCase().replace(/[\s-]/g, '');
  if (!new RegExp('^[' + INVITE_ALPHABET + ']{10}$').test(c)) return null;
  return c.slice(0, 5) + '-' + c.slice(5);
}

/** ロック取得中に呼ぶこと。コードは返却時の1回だけ平文で扱い、保存はハッシュのみ。 */
function issueInvite_(userId, createdBy, config) {
  var now = now_();
  var code = generateInviteCode_();
  var expiresAt = new Date(now.getTime() + config.INVITE_TTL_HOURS * 3600 * 1000);
  appendRecord_('Invites', {
    invite_id: 'INV-' + Utilities.getUuid(),
    user_id: userId,
    code_hash: sha256Hex_(code),
    expires_at: formatJstIso_(expiresAt),
    used_at: '',
    created_by: createdBy,
    created_at: formatJstIso_(now)
  });
  return { code: code, expiresAt: formatJstIso_(expiresAt) };
}

function redeemInvite_(body, sub, config) {
  var code = normalizeInviteCode_(body.code);
  if (!code) return errorResponse_('INVITE_INVALID');
  var now = now_();
  var hash = sha256Hex_(code);
  var invites = readAll_('Invites');
  var invite = null;
  for (var i = 0; i < invites.length; i++) {
    if (invites[i].code_hash === hash) { invite = invites[i]; break; }
  }
  var expires = invite ? parseIsoDate_(invite.expires_at) : null;
  if (!invite || invite.used_at || !expires || expires.getTime() <= now.getTime()) {
    safeAppendAudit_({ role: 'unknown', action: 'staff.redeemInvite', reason: 'invite_invalid', result: 'denied' });
    return errorResponse_('INVITE_INVALID');
  }

  var users = readAll_('Users');
  var target = findUser_(users, invite.user_id);
  if (!target || !isTruthyCell_(target.active)) return errorResponse_('INVITE_INVALID');
  var other = findUserBySub_(users, sub);
  if (other && other.user_id !== target.user_id) return errorResponse_('ALREADY_LINKED');

  var nowIso = formatJstIso_(now);
  updateRecord_('Users', 'user_id', target.user_id, { login_identifier: sub, updated_at: nowIso });
  updateRecord_('Invites', 'invite_id', invite.invite_id, { used_at: nowIso });
  appendAudit_({
    userId: target.user_id, role: target.role, action: 'user.link', targetType: 'user', targetId: target.user_id,
    before: { linked: isLinkedIdentifier_(target.login_identifier) }, after: { linked: true }, result: 'success'
  });
  return { ok: true, user: { userId: target.user_id, displayName: target.display_name, role: target.role } };
}

/**
 * GAS エディタから実行: 最初のオーナー用の招待コードを発行してログに出す。
 * オーナー行がなければ作成する。
 */
function issueOwnerInvite() {
  var config = getConfig_();
  var lock = LockService.getScriptLock();
  lock.waitLock(config.LOCK_WAIT_MS);
  try {
    var users = readAll_('Users');
    var owner = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].role === 'owner' && isTruthyCell_(users[i].active)) { owner = users[i]; break; }
    }
    if (!owner) {
      var nowIso = formatJstIso_(now_());
      owner = {
        user_id: nextUserId_(users), login_identifier: '', display_name: 'オーナー', role: 'owner',
        active: true, created_at: nowIso, updated_at: nowIso
      };
      appendRecord_('Users', owner);
    }
    var invite = issueInvite_(owner.user_id, 'editor', config);
    appendAudit_({ userId: owner.user_id, role: 'owner', action: 'invite.issue', targetType: 'user', targetId: owner.user_id, reason: 'editor', result: 'success' });
    console.log('オーナー（' + owner.user_id + '）の招待コード: ' + invite.code + '  有効期限: ' + invite.expiresAt);
  } finally {
    lock.releaseLock();
  }
}

function nextUserId_(users) {
  return nextSequentialId_(users.map(function (u) { return u.user_id; }), 'USR-', 4);
}
