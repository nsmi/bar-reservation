/**
 * 初期セットアップ。GAS エディタから手動で1回実行する。
 * 既存シートは上書きせず、ヘッダーの一致だけ確認する。
 */
function setupSheets() {
  var ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone('Asia/Tokyo');
  Object.keys(SCHEMAS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      createSheetWithHeader_(ss, name);
      return;
    }
    assertHeader_(sheet, SCHEMAS[name], name);
  });
}

/** Script Properties が正しく設定されているか確認する（値そのものはログに出さない）。 */
function checkConfig() {
  var cfg = getConfig_();
  console.log('Config OK. LINE_CHANNEL_ID is set (' + cfg.LINE_CHANNEL_ID.length + ' digits).');
}
