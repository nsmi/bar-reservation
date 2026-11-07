/**
 * LINE IDトークンの検証。
 * クライアントから送られた LINE ユーザーID は一切信用せず、
 * LINE の検証エンドポイントが返した sub だけを本人の識別子として使う。
 * IDトークン自体は保存・ログ出力しない。
 * https://developers.line.biz/ja/reference/line-login/#verify-id-token
 */
var LINE_VERIFY_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify';
var LINE_ISSUER = 'https://access.line.me';
var LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;

/**
 * @return {{ok: true, sub: string} | {ok: false, code: string}}
 *   code: AUTH_REQUIRED | AUTH_INVALID | AUTH_UNAVAILABLE
 */
function verifyLineIdToken_(idToken, channelId, now) {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return { ok: false, code: 'AUTH_REQUIRED' };
  }
  if (idToken.length > 4096 || idToken.split('.').length !== 3) {
    return { ok: false, code: 'AUTH_INVALID' };
  }

  var response;
  try {
    response = UrlFetchApp.fetch(LINE_VERIFY_ENDPOINT, {
      method: 'post',
      payload: { id_token: idToken, client_id: String(channelId) },
      muteHttpExceptions: true,
      followRedirects: false
    });
  } catch (e) {
    return { ok: false, code: 'AUTH_UNAVAILABLE' };
  }

  var status = response.getResponseCode();
  if (status >= 400 && status < 500) return { ok: false, code: 'AUTH_INVALID' };
  if (status !== 200) return { ok: false, code: 'AUTH_UNAVAILABLE' };

  var claims;
  try {
    claims = JSON.parse(response.getContentText());
  } catch (e) {
    return { ok: false, code: 'AUTH_UNAVAILABLE' };
  }

  // LINE側でも検証済みだが、念のため主要クレームを再確認する
  if (!claims || claims.iss !== LINE_ISSUER) return { ok: false, code: 'AUTH_INVALID' };
  if (String(claims.aud) !== String(channelId)) return { ok: false, code: 'AUTH_INVALID' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) {
    return { ok: false, code: 'AUTH_INVALID' };
  }
  if (typeof claims.sub !== 'string' || !LINE_USER_ID_PATTERN.test(claims.sub)) {
    return { ok: false, code: 'AUTH_INVALID' };
  }
  return { ok: true, sub: claims.sub };
}
