# LINE予約・呼び売上管理ツール 試験導入版

バー向けの LINE 予約受付と、呼び客／店客の区別・売上管理（フェーズ2以降）を行う試験導入版です。
設計判断と仮定は [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md) を参照してください。

## 現在の実装範囲（フェーズ1）

- LINEミニアプリの予約画面（入力 → 確認 → 完了）
- LINE IDトークンのサーバー側検証、内部顧客ID（`CUST-0001`）の作成・照合
- 予約登録API（サーバー時刻記録、予約ID `R-YYYYMMDD-NNN` 発行、二重登録防止）
- スプレッドシート保存と監査ログ

## ディレクトリ

```
frontend/   予約画面（GitHub Pages で公開）。config.js は公開値のみ
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

## API

`POST <GAS exec URL>`、`Content-Type: text/plain;charset=utf-8`、本文は JSON。

| action | 入力 | 認証 |
|---|---|---|
| `getFormOptions` | なし | 不要（キャスト表示名と受付条件のみ返す） |
| `createReservation` | `requestId`(UUID), `idToken`, `reservation{nickname,date,time,numberOfGuests,requestedCastId,note}` | LINE IDトークン |

エラー時は `{ "ok": false, "error": { "code": "..." } }`。
`VALIDATION_ERROR`（`fields` 付き）/ `AUTH_REQUIRED` / `AUTH_INVALID` / `AUTH_UNAVAILABLE` / `BUSY` /
`LIMIT_EXCEEDED` / `CUSTOMER_INACTIVE` / `REQUEST_ID_CONFLICT` / `INVALID_REQUEST` / `UNKNOWN_ACTION` / `INTERNAL`

## 運用メモ

- 予約の変更・キャンセルは、顧客から LINE チャットで連絡 → オーナーがシートで `status` 等を修正（フェーズ3で画面化）
- いたずら予約をする顧客は `Customers.active` を `FALSE` にすると予約できなくなります
- GAS のコードを変更したら「デプロイを管理」で既存デプロイの新バージョンを作成（URL を変えないため）
