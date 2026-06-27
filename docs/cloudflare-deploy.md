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

## 7. 自分の userId / groupId を取得する (初回のみ)

`adminUserIds` を埋めるためには自分の LINE userId が必要です。`/router info` コマンドが応答するように一時的に開放します。

1. `router.config.ts` を次のように一時編集:

   ```ts
   router: {
     // ...
     adminUserIds: [],
     setup: {
       allowInfoCommandWithoutAdmin: true, // ← 一時的に true
     },
   }
   ```

2. `pnpm deploy` で deploy
3. router を group / 1:1 talk に招待し、`/router info` と送る。返ってきた `sourceId` / `groupId` / `userId` を控える
4. `router.config.ts` を元に戻す:

   ```ts
   router: {
     adminUserIds: ["U..."], // 控えた userId
     setup: {
       allowInfoCommandWithoutAdmin: false, // ← 必ず false に戻す
     },
   }
   ```

5. もう一度 `pnpm deploy`

`allowInfoCommandWithoutAdmin: true` のまま運用すると、router が居る group の任意ユーザーから内部 ID が読み出せてしまうので必ず手順 4 で戻してください。`defineRouterConfig` は `allowInfoCommandWithoutAdmin: true` かつ `adminUserIds` 空のとき deploy ログに警告を出します。
