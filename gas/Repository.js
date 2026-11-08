/**
 * スプレッドシートを簡易DBとして扱う。
 * - 行番号はIDとして使わない（将来のCSV移行のため）。
 * - 書き込む文字列は先頭に ' を付けて「テキスト」として保存する。
 *   → 数式インジェクション（=IMPORTXML(...) 等）と日付への自動変換を防ぐ。
 * - 列の並びは SCHEMAS が正。ヘッダーが一致しない場合は処理を止める。
 */
var SCHEMAS = {
  Users: [
    'user_id', 'login_identifier', 'display_name', 'role', 'active', 'created_at', 'updated_at'
  ],
  Customers: [
    'customer_id', 'line_user_id', 'nickname', 'age_group', 'identification_note',
    'favorite_drink', 'memo', 'active', 'created_at', 'updated_at'
  ],
  Reservations: [
    'reservation_id', 'request_id', 'customer_id', 'nickname', 'scheduled_at', 'number_of_guests',
    'source', 'created_by_user_id', 'assigned_cast_id', 'requested_cast_id', 'created_at',
    'status', 'note', 'version'
  ],
  Visits: [
    'visit_id', 'request_id', 'business_date', 'customer_id', 'reservation_id', 'checked_in_at',
    'checked_in_by', 'invitation_type', 'attributed_cast_id', 'determination_reason',
    'created_at', 'updated_at', 'version'
  ],
  Transactions: [
    'transaction_id', 'request_id', 'visit_id', 'business_date', 'total_amount', 'cast_drink_amount',
    'payment_method', 'payout_rate', 'payout_amount', 'status', 'note', 'created_by', 'created_at',
    'finalized_by', 'finalized_at'
  ],
  Invites: [
    'invite_id', 'user_id', 'code_hash', 'expires_at', 'used_at', 'created_by', 'created_at'
  ],
  AuditLogs: [
    'log_id', 'timestamp', 'user_id', 'role', 'action', 'target_type', 'target_id',
    'before_json', 'after_json', 'reason', 'request_id', 'result'
  ]
};

function getSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Spreadsheet not found. Script must be bound to the spreadsheet.');
  return ss;
}

function getTable_(name) {
  var schema = SCHEMAS[name];
  if (!schema) throw new Error('Unknown table: ' + name);
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name + '. Run setupSheets().');
  return { sheet: sheet, schema: schema };
}

function assertHeader_(sheet, schema, name) {
  var header = sheet.getRange(1, 1, 1, schema.length).getValues()[0];
  for (var i = 0; i < schema.length; i++) {
    if (String(header[i]) !== schema[i]) {
      throw new Error('Header mismatch in ' + name + ' at column ' + (i + 1) + ': expected ' + schema[i]);
    }
  }
}

function fromCellValue_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return formatJstIso_(v);
  return String(v);
}

function toCellValue_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite number');
    return v;
  }
  if (typeof v === 'boolean') return v;
  var s = String(v);
  return s === '' ? '' : "'" + s;
}

function isTruthyCell_(v) {
  return /^(true|1|yes)$/i.test(String(v).trim());
}

/** 全行をオブジェクト配列で返す（値はすべて文字列）。 */
function readAll_(name) {
  var t = getTable_(name);
  assertHeader_(t.sheet, t.schema, name);
  var lastRow = t.sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = t.sheet.getRange(2, 1, lastRow - 1, t.schema.length).getValues();
  return values.map(function (row) {
    var obj = {};
    t.schema.forEach(function (key, i) {
      obj[key] = fromCellValue_(row[i]);
    });
    return obj;
  });
}

function appendRecord_(name, record) {
  var t = getTable_(name);
  var row = t.schema.map(function (key) {
    return toCellValue_(record[key]);
  });
  t.sheet.appendRow(row);
}

/**
 * keyField = keyValue の行の、changes に含まれる列だけを書き換える（ロック取得中に呼ぶこと）。
 * 変更しない列は書き戻さない（テキスト扱いの値を数式として再解釈させないため）。
 */
function updateRecord_(name, keyField, keyValue, changes) {
  var t = getTable_(name);
  assertHeader_(t.sheet, t.schema, name);
  var keyCol = t.schema.indexOf(keyField);
  if (keyCol < 0) throw new Error('Unknown key field: ' + keyField);
  var lastRow = t.sheet.getLastRow();
  if (lastRow < 2) throw new Error('Record not found: ' + name + ' ' + keyValue);
  var keys = t.sheet.getRange(2, keyCol + 1, lastRow - 1, 1).getValues();
  var rowIndex = -1;
  for (var i = 0; i < keys.length; i++) {
    if (fromCellValue_(keys[i][0]) === keyValue) { rowIndex = i + 2; break; }
  }
  if (rowIndex < 0) throw new Error('Record not found: ' + name + ' ' + keyValue);
  Object.keys(changes).forEach(function (field) {
    var col = t.schema.indexOf(field);
    if (col < 0) throw new Error('Unknown field: ' + field);
    t.sheet.getRange(rowIndex, col + 1).setValue(toCellValue_(changes[field]));
  });
}

function indexBy_(records, field) {
  var map = {};
  records.forEach(function (r) { map[r[field]] = r; });
  return map;
}
