# ADR 0001: 試験導入版のアーキテクチャと仮定

- 状態: 採用
- 日付: 2026-11-07

## 決定事項（オーナー確認済み）

| 項目 | 決定 |
|---|---|
| 顧客フロント | **LINEミニアプリ**（未認証で開始。審査は初期版では行わない） |
| 予約画面の配置 | **GitHub Pages**（静的ファイル。`frontend/`） |
| バックエンド | GAS Web アプリ（API 専用）＋ Google スプレッドシート |
| 店舗ユーザー認証 | **LINEアカウント**（PIN・Googleアカウントは採用しない）。[ADR-0002](0002-staff-auth-line-account.md) |
| 希望キャスト | 予約画面で選択可。キャストの表示名一覧は公開情報として扱う |
| 予約受付条件 | 当日〜60日先 / 1〜10名 / 有効予約は1顧客3件まで / 15分刻み |

## 構成

```
LINEミニアプリ (GitHub Pages: frontend/)
  └ liff.getIDToken() ──HTTPS POST (text/plain JSON)──▶ GAS doPost
                                                         ├ LINE verify API で IDトークン検証 → sub
                                                         ├ 入力検証（サーバー時刻基準）
                                                         ├ ScriptLock 下で顧客照合・予約保存
                                                         └ AuditLogs へ記録
                                                       ▼
                                              Google スプレッドシート（GASを紐づけ）
```

### GAS を画面配信に使わない理由
GAS の HtmlService は googleusercontent.com 上の iframe で配信され、LIFF のエンドポイントURLと
ドメインが一致しない。画面は GitHub Pages、GAS は API のみとした。

### text/plain で POST する理由
GAS は OPTIONS（CORS プリフライト）に応答できない。`Content-Type: text/plain` は単純リクエスト
となりプリフライトが発生しない。GAS は HTTP ステータスを返せないため、結果は
`{ ok: false, error: { code } }` 形式で返す。

## セキュリティ上の判断

- **本人確認**: クライアントは IDトークンのみ送る。GAS が `https://api.line.me/oauth2/v2.1/verify`
  に `client_id = LINE_CHANNEL_ID` で問い合わせ、`iss`・`aud`・`exp`・`sub` を再確認する。
  チャネルシークレットはフェーズ1では使わない（コード・Script Properties ともに不要）。
- **IDトークンは保存しない**。監査ログ・console にも出さない。LINEユーザーID(`sub`)は Customers シートにのみ保存。
- **二重登録防止**: リクエストIDを予約行（`Reservations.request_id`）に保存し、ScriptLock 下で照合する。
  予約行と同じ行に入るため、「予約は保存されたが重複防止記録が残らない」状態が起きない。
  同一リクエストIDでも LINE ユーザーが異なる場合は `REQUEST_ID_CONFLICT`（他人の予約内容を返さない）。
- **数式インジェクション対策**: 文字列はすべて先頭に `'` を付けてテキストとして書き込む。
  ISO 日時文字列が日付型へ自動変換されることも防げる。
- **公開範囲**: Web アプリは「全員（匿名）」アクセス。誰でも呼べる前提で、全操作をサーバー側で認証・検証する。
- **いたずら予約の抑制**: 有効予約件数の上限、受付期間の制限、顧客の `active=false` による停止。
- **OAuth スコープ最小化**: `spreadsheets.currentonly`（紐づいたシートのみ）と `script.external_request`。

## 仕様資料からの差分

| 差分 | 理由 |
|---|---|
| `Reservations` に `request_id`、`nickname` 列を追加 | 二重登録防止の原子性 / 予約ごとのあだ名を保持（顧客のあだ名は初回登録時の値） |
| `Users` から `pin_salt`、`pin_hash` を削除 | 店舗ユーザーはアカウント方式に決定したため |
| `Visits` に `request_id`・`business_date`・`updated_at`・`version` を追加 | 二重登録防止 / 営業日集計 / 判定変更の同時編集検出 |
| `Transactions` に `request_id`・`note` を追加。`payout_rate` は%の整数 | 二重登録防止 / 円未満を整数演算で正確に切り捨てるため |
| `Invites` シートを追加 | 店舗ユーザーの LINE 紐づけ（ADR-0002）。招待コードはハッシュのみ保存 |
| タイムゾーンは設定値ではなく JST(+9) 固定 | 日本の1店舗のみ。夏時間なし |

## 仮定（セキュリティに影響しないため仮置き。変更可）

- 予約時刻の選択肢は 18:00〜翌4:00（`frontend/config.js`）。営業時間が確定したら変更する。
  サーバーは15分刻み・過去でない・60日以内のみ検証し、営業時間は検証しない。
- 予約画面の「ご来店日」は営業日の意味で扱い、「翌1:00」は来店日の翌日 1:00 として保存する。
- 予約IDの日付部分は **登録日**（日本時間の暦日）。例: 11/7 に登録した 11/10 の予約 → `R-20261107-001`。
- 顧客IDは `CUST-0001` 形式の連番（最大値+1。行番号は使わない）。
- あだ名は最大20文字、備考は最大200文字。
- 新規予約のオーナーへの通知は行わない（オーナーがシート／将来の管理画面で確認）。

## フェーズ2の認証（店舗ユーザー：アカウント方式）

> 2026-11-08 追記: LINE アカウント方式に確定した。[ADR-0002](0002-staff-auth-line-account.md) を参照。以下は検討時点の記録。

GAS 標準の `Session.getActiveUser()` は、個人 Gmail 間では「自分として実行」時にオーナー以外の
メールアドレスを返さず、「アクセスしたユーザーとして実行」ではスプレッドシートを各利用者に共有する必要が
あり「キャストにシートを共有しない」要件と矛盾する。そのため次の方式とする予定:

1. 店舗管理画面（GitHub Pages）で Google Identity Services により Google ID トークンを取得
2. GAS で ID トークンを検証（`aud` = 自前の OAuth クライアントID、`iss`、`exp`、`email_verified`）
3. `email` を `Users.login_identifier` と照合し、`active` とロールを確認
4. 以後の操作も毎回 ID トークンを送る（または短命のサーバーセッションを発行）。ロールは常にサーバーで判定

キャストが Google アカウントを持たない場合の代替として、LINE ログイン（LINEアカウント）で同じ仕組みを
とることも可能。フェーズ2着手前に確定する。

## 未決（実装前に要確認）

- 呼び判定ルール・日払い計算の詳細（フェーズ2）
- データ・ログの保存期間
