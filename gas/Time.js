/**
 * 日時ユーティリティ。タイムゾーンは Asia/Tokyo（UTC+9、夏時間なし）に固定。
 * サーバー実行環境のタイムゾーン設定に依存しないよう、オフセット計算で扱う。
 * 保存形式は ISO 8601 文字列（例: 2026-11-07T21:00:00+09:00）。
 */
var JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad_(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

function jstParts_(date) {
  var d = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds()
  };
}

/** YYYY-MM-DD */
function formatJstDate_(date) {
  var p = jstParts_(date);
  return p.year + '-' + pad_(p.month, 2) + '-' + pad_(p.day, 2);
}

/** YYYYMMDD */
function formatJstCompactDate_(date) {
  return formatJstDate_(date).replace(/-/g, '');
}

/** YYYY-MM-DDTHH:mm:ss+09:00 */
function formatJstIso_(date) {
  var p = jstParts_(date);
  return formatJstDate_(date) + 'T' + pad_(p.hour, 2) + ':' + pad_(p.minute, 2) + ':' + pad_(p.second, 2) + '+09:00';
}

/**
 * 'YYYY-MM-DD' と 'HH:mm'（日本時間）を Date に変換する。存在しない日付は null。
 */
function jstLocalToDate_(dateStr, timeStr) {
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  var tm = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!dm || !tm) return null;
  var y = parseInt(dm[1], 10);
  var mo = parseInt(dm[2], 10);
  var d = parseInt(dm[3], 10);
  var h = parseInt(tm[1], 10);
  var mi = parseInt(tm[2], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  var date = new Date(Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS);
  var p = jstParts_(date);
  if (p.year !== y || p.month !== mo || p.day !== d) return null; // 2/30 など
  return date;
}

/**
 * 営業日を返す。切り替え時刻（既定 6時）より前は前日の営業日とする。
 * 例: 2026-11-08 03:00 → '2026-11-07'
 */
function businessDateOf_(date, cutoffHour) {
  return formatJstDate_(new Date(date.getTime() - cutoffHour * 60 * 60 * 1000));
}

function parseIsoDate_(s) {
  var t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
