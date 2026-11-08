/**
 * 店舗用画面の公開設定。秘密情報は書かない。
 * STAFF_LIFF_ID は「店舗用」LINEミニアプリ チャネルの LIFF ID（顧客用とは別チャネル）。
 */
window.ADMIN_CONFIG = Object.freeze({
  STAFF_LIFF_ID: '2012465168-tyLr0vog',
  API_URL: 'https://script.google.com/macros/s/AKfycbzho1RHsVS2p2AvTP0oCLBXhyJGSbPra8iN1B9U-fTBg4dQmYgI-TEqgd5-r0dgz9fF/exec',
  SHOP_NAME: 'Barサンドラ伊豆'
  // 予約の受付時間・人数などは「設定」タブで変更する（サーバーから取得）
});
