/**
 * 公開設定。ここに置く値はブラウザから誰でも見えるため、秘密情報は絶対に書かない。
 * （LIFF ID と GAS の URL は公開されても問題ない値。チャネルシークレットは書かない）
 * REPLACE_WITH_ が残っている間はアプリが起動せず、GitHub Pages へのデプロイも失敗する。
 */
window.APP_CONFIG = Object.freeze({
  LIFF_ID: '2012614927-MmfDkJmV',
  API_URL: 'https://script.google.com/macros/s/AKfycbzho1RHsVS2p2AvTP0oCLBXhyJGSbPra8iN1B9U-fTBg4dQmYgI-TEqgd5-r0dgz9fF/exec',
  SHOP_NAME: 'Bar予約システム',
  // 公式LINEアカウントの友だち追加URL（https://lin.ee/… など。公開してよい値）。
  // 「友だち限定」を設定タブでオンにしたとき、友だちでないお客様に表示する。空ならボタンを出さない
  FRIEND_ADD_URL: 'https://lin.ee/TopHHQI'
  // 予約の受付時間・人数などは、店舗用画面の「設定」タブで変更する（サーバーから取得）
});
