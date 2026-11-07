/**
 * 公開設定。ここに置く値はブラウザから誰でも見えるため、秘密情報は絶対に書かない。
 * （LIFF ID と GAS の URL は公開されても問題ない値。チャネルシークレットは書かない）
 * REPLACE_WITH_ が残っている間はアプリが起動せず、GitHub Pages へのデプロイも失敗する。
 */
window.APP_CONFIG = Object.freeze({
  LIFF_ID: '2012448458-QHDMgaU1',
  API_URL: 'https://script.google.com/macros/s/AKfycbzho1RHsVS2p2AvTP0oCLBXhyJGSbPra8iN1B9U-fTBg4dQmYgI-TEqgd5-r0dgz9fF/exec',
  SHOP_NAME: 'Barサンドラ伊豆',
  // 予約時刻の選択肢。END が START 以前なら日付をまたぐ（例: 18:00〜翌4:00）
  TIME_SLOT_START: '18:00',
  TIME_SLOT_END: '04:00',
  DEFAULT_TIME: '21:00'
});
