/**
 * Web アプリの入口（API 専用）。
 * GAS は CORS プリフライト(OPTIONS)に応答できないため、クライアントは
 * Content-Type: text/plain で JSON 文字列を POST する。
 * GAS では HTTP ステータスを設定できないため、結果は常に {ok, error:{code}} で返す。
 */
var MAX_BODY_LENGTH = 10000;

/** サーバー時刻。テストで差し替えられるよう関数経由で取得する。 */
function now_() {
  return new Date();
}

function doPost(e) {
  return jsonOutput_(handleRequest_(e));
}

function doGet() {
  return jsonOutput_({ ok: true, service: 'bar-reservation-api' });
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(code, fields) {
  var res = { ok: false, error: { code: code } };
  if (fields) res.error.fields = fields;
  return res;
}

function handleRequest_(e) {
  try {
    var raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (!raw || raw.length > MAX_BODY_LENGTH) return errorResponse_('INVALID_REQUEST');

    var body;
    try {
      body = JSON.parse(raw);
    } catch (parseError) {
      return errorResponse_('INVALID_REQUEST');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse_('INVALID_REQUEST');

    if (typeof body.action === 'string' && body.action.indexOf('staff.') === 0) {
      return handleStaffRequest_(body);
    }
    switch (body.action) {
      case 'getFormOptions':
        return handleGetFormOptions_();
      case 'createReservation':
        return handleCreateReservation_(body);
      default:
        return errorResponse_('UNKNOWN_ACTION');
    }
  } catch (err) {
    // リクエスト本文（IDトークンを含む）はログに出さない
    console.error('Unhandled error: ' + (err && err.message));
    return errorResponse_('INTERNAL');
  }
}
