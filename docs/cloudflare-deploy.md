# Cloudflare Workers へのデプロイ

`templates/cloudflare-worker` をベースに進めます。

## 1. 依存をインストール

```bash
pnpm install
```

## 2. D1 を作成

```bash
cd templates/cloudflare-worker
npx wrangler d1 create line_bot_router
```

出力された `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に貼り付けます。

## 3. マイグレーション適用

```bash
pnpm db:apply:local   # ローカル wrangler dev 用
pnpm db:apply:remote  # 本番 D1
```

## 4. シークレット投入

ローカル開発 (`wrangler dev`) は `.dev.vars` を作って入れます:

```bash
cp .dev.vars.example .dev.vars
$EDITOR .dev.vars
```

本番は wrangler secret で:

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put ARCHIVE_WEBHOOK_SECRET
npx wrangler secret put ATTENDANCE_WEBHOOK_SECRET
npx wrangler secret put ATTENDANCE_SERVICE_TOKEN
npx wrangler secret put REMINDER_WEBHOOK_SECRET
npx wrangler secret put REMINDER_SERVICE_TOKEN
```

## 5. ローカルで起動

```bash
pnpm dev
```

`http://127.0.0.1:8787/health` が `{ "ok": true }` を返せば OK。

## 6. デプロイ

```bash
pnpm deploy
```

成功したら LINE Developers コンソールで Webhook URL を:

```
https://<your-worker>.workers.dev/line/webhook
```

に設定します。
