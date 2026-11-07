/**
 * ID発行。必ず ScriptLock 取得中に呼び出すこと（連番の重複防止）。
 *   顧客: CUST-0001
 *   予約: R-20261107-001（登録日の日本時間＋その日の連番）
 */
function escapeRegExp_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nextSequentialId_(existingIds, prefix, width) {
  var re = new RegExp('^' + escapeRegExp_(prefix) + '(\\d+)$');
  var max = 0;
  existingIds.forEach(function (id) {
    var m = re.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + pad_(max + 1, width);
}

function nextCustomerId_(customers) {
  return nextSequentialId_(customers.map(function (c) { return c.customer_id; }), 'CUST-', 4);
}

function nextReservationId_(reservations, now) {
  var prefix = 'R-' + formatJstCompactDate_(now) + '-';
  return nextSequentialId_(reservations.map(function (r) { return r.reservation_id; }), prefix, 3);
}

function newLogId_() {
  return 'LOG-' + Utilities.getUuid();
}
