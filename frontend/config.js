/**
 * 公開設定。ここに置く値はブラウザから誰でも見えるため、秘密情報は絶対に書かない。
 * （LIFF ID と GAS の URL は公開されても問題ない値。チャネルシークレットは書かない）
 * REPLACE_WITH_ が残っている間はアプリが起動せず、GitHub Pages へのデプロイも失敗する。
 */
window.APP_CONFIG = Object.freeze({
  LIFF_ID: '2012448458-QHDMgaU1',
  API_URL: 'https://script.google.com/macros/s/AKfycbzho1RHsVS2p2AvTP0oCLBXhyJGSbPra8iN1B9U-fTBg4dQmYgI-TEqgd5-r0dgz9fF/exec',
  SHOP_NAME: 'Barサンドラ伊豆'
  // 予約の受付時間・人数などは、店舗用画面の「設定」タブで変更する（サーバーから取得）
});
