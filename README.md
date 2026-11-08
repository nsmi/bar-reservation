# LINE予約・呼び売上管理ツール 試験導入版

バー向けの LINE 予約受付と、呼び客／店客の区別・売上管理（フェーズ2以降）を行う試験導入版です。
設計判断と仮定は [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md) を参照してください。

## 現在の実装範囲

フェーズ1（顧客向け）
- LINEミニアプリの予約画面（入力 → 確認 → 完了）
- LINE IDトークンのサーバー側検証、内部顧客ID（`CUST-0001`）の作成・照合
- 予約登録API（サーバー時刻記録、予約ID `R-YYYYMMDD-NNN` 発行、二重登録防止）
- スプレッドシート保存と監査ログ

フェーズ2（店舗用画面 `frontend/admin/`、LINEアカウント認証 → [ADR-0002](docs/adr/0002-staff-auth-line-account.md)）
- 招待コードによる店舗ユーザー登録、ロール別の権限判定（owner / staff / cast）
- 予約一覧、キャストの呼び予約登録、来店登録と呼び判定、会計登録、日次集計・要確認一覧
- オーナーによる判定変更（理由必須）、ユーザー管理
- 判定・集計・日払いのルールは [docs/business-rules.md](docs/business-rules.md)

## ディレクトリ

```
frontend/        顧客向け予約画面（GitHub Pages で公開）。config.js は公開値のみ
frontend/admin/  店舗用画面（同じく GitHub Pages の /admin/）
gas/        GAS バックエンド（clasp で push）
test/       Node 標準テストランナーによるテスト（GAS をフェイクで再現）
docs/adr/   設計判断の記録
```

## テスト

```sh
npm test
```

外部ライブラリは不要です（Node 20 以上）。

## セットアップ手順

### 1. スプレッドシートと GAS（店舗専用 Google アカウントで実施）

1. 店舗専用 Google アカウントを用意し、**2段階認証を有効化**する
2. 新しいスプレッドシートを作成 →「拡張機能 > Apps Script」でスクリプトを作成
3. ローカルから反映する場合:
   ```sh
   npm i -g @google/clasp
   clasp login
   cp .clasp.json.example .clasp.json   # scriptId を「プロジェクトの設定」の値に書き換える
   clasp push
   ```
   （.clasp.json はコミットしないこと）
4. GAS エディタで `setupSheets` を実行（シート作成・タイムゾーン設定）
5. 「プロジェクトの設定 > スクリプト プロパティ」に以下を登録
   | キー | 値 |
   |---|---|
   | `LINE_CHANNEL_ID` | LINEミニアプリ チャネルのチャネルID（数字） |
6. GAS エディタで `checkConfig` を実行して設定を確認
7. 「デプロイ > 新しいデプロイ > ウェブアプリ」
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
   - 発行された `https://script.google.com/macros/s/.../exec` を控える
8. `Users` シートにキャストを手入力（予約画面の希望キャスト選択肢になる）
   | user_id | login_identifier | display_name | role | active |
   |---|---|---|---|---|
   | USR-0001 | （メール） | オーナー | owner | TRUE |
   | USR-0002 | （メール） | あや | cast | TRUE |

   ※ **このスプレッドシートはキャスト・スタッフに共有しないでください。**

### 2. LINE Developers

1. LINE公式アカウント（コミュニケーションプラン／月額0円）を作成
2. LINE Developers で同じプロバイダーに **LINEミニアプリ チャネル** を作成
3. チャネルの「チャネルID」を GAS の `LINE_CHANNEL_ID` に設定
4. 「ウェブアプリ設定」で開発用／審査用／本番用の各エンドポイントURLに GitHub Pages の URL を設定
   （例 `https://<user>.github.io/<repo>/`）
5. Scope は `openid` のみで可（プロフィール情報は使わない）
6. 本番用の LIFF ID を `frontend/config.js` の `LIFF_ID` に設定
7. LINE Official Account Manager でリッチメニューを作成し、
   「予約する」のリンクに `https://miniapp.line.me/<LIFF ID>` を設定

### 3. GitHub Pages

1. GitHub にリポジトリを作成して push（GitHub Free で Pages を使う場合はリポジトリが公開になります。
   秘密情報はリポジトリに含まれない設計です）
2. `frontend/config.js` の `LIFF_ID`、`API_URL`（GAS の exec URL）、`SHOP_NAME` を設定してコミット
   （`REPLACE_WITH_` が残っているとデプロイは失敗します）
3. リポジトリの Settings > Pages > Source を **GitHub Actions** にする
4. `main` へ push すると `.github/workflows/pages.yml` が `frontend/` を公開

### 4. 店舗用画面（フェーズ2）

1. GAS を更新したら、GAS エディタで **`setupSheets` を再実行**（`Visits`・`Transactions`・`Invites` シートを追加。既存データはそのまま）
2. LINE Developers で、同じプロバイダーに **店舗用の LINEミニアプリ チャネル**を新規作成（顧客用とは別）
   - エンドポイントURL（開発用・審査用・本番用）: `https://nsmi.github.io/bar-reservation/admin/`
   - Scope: `openid`
3. GAS のスクリプト プロパティに `LINE_STAFF_CHANNEL_ID` = 店舗用チャネルのチャネルID を追加
   （顧客用の `LINE_CHANNEL_ID` と同じ値は設定できません）
4. `frontend/admin/config.js` の `STAFF_LIFF_ID` に店舗用チャネルの本番 LIFF ID を設定して push
5. GAS エディタで **`issueOwnerInvite`** を実行 → 実行ログに表示された招待コードを控える
6. オーナーのスマホの LINE で `https://miniapp.line.me/<店舗用 LIFF ID>` を開き、招待コードを入力
7. 以降、スタッフ・キャストは「ユーザー」タブで追加 → 表示された招待コードを本人に LINE で送る

※ 店舗用画面の URL は顧客に案内しないこと（開いても未登録なら操作できませんが、不要な露出を避けるため）。

## API

`POST <GAS exec URL>`、`Content-Type: text/plain;charset=utf-8`、本文は JSON。

| action | 入力 | 認証 |
|---|---|---|
| `getFormOptions` | なし | 不要（キャスト表示名と受付条件のみ返す） |
| `createReservation` | `requestId`(UUID), `idToken`, `reservation{nickname,date,time,numberOfGuests,requestedCastId,note}` | LINE IDトークン |
| `staff.*` | `idToken`（店舗用チャネル）＋各操作の入力。一覧は `gas/StaffAuth.js` の `staffActions_` | 店舗用 LINE IDトークン＋ロール |

エラー時は `{ "ok": false, "error": { "code": "..." } }`。
`VALIDATION_ERROR`（`fields` 付き）/ `AUTH_REQUIRED` / `AUTH_INVALID` / `AUTH_UNAVAILABLE` / `BUSY` /
`LIMIT_EXCEEDED` / `CUSTOMER_INACTIVE` / `REQUEST_ID_CONFLICT` / `INVALID_REQUEST` / `UNKNOWN_ACTION` / `INTERNAL`
店舗用: `NOT_REGISTERED` / `FORBIDDEN` / `NOT_FOUND` / `INVITE_INVALID` / `ALREADY_LINKED` / `RESERVATION_NOT_AVAILABLE` /
`RESERVATION_NOT_TODAY` / `ALREADY_PAID` / `VERSION_CONFLICT`

## 運用メモ

- 予約の変更・キャンセルは、顧客から LINE チャットで連絡 → オーナーがシートで `status` 等を修正（フェーズ3で画面化）
- いたずら予約をする顧客は `Customers.active` を `FALSE` にすると予約できなくなります
- スタッフ・キャストの端末紛失や退職時は「ユーザー」タブで無効にすると、即座に操作できなくなります
- 会計の入力ミスはフェーズ2では画面から訂正できません。オーナーがシートで直接修正する場合は、`AuditLogs` に理由を手で追記してください（訂正機能はフェーズ3）
- GAS のコードを変更したら「デプロイを管理」で既存デプロイの新バージョンを作成（URL を変えないため）
