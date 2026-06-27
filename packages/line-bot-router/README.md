# line-bot-router

Cloudflare Workers で動く、config-driven な LINE Bot Router の npm パッケージ。
LINE グループに 1 つだけ参加できる代表 bot をルーターとして使い、その内側で
複数の子 bot / 外部サービスを共存させる OSS です。

リポジトリ・テンプレート・ドキュメントは [GitHub repository](https://github.com/aspick/line-bot-router) を参照してください。

## インストール

```bash
npm i line-bot-router hono zod
# or
pnpm add line-bot-router hono zod
```

Node 20 以降、または Cloudflare Workers ランタイムで動作します。

## import surface

```ts
// 共通ヘルパーと型
import { decideRouting, verifyLineSignature } from "line-bot-router";

// 設定ファイル用
import { defineRouterConfig } from "line-bot-router/config";

// Cloudflare Workers アダプタ
import {
  handleLineWebhook,
  handleMessagingApiProxy,
  handleServiceMessage,
  D1Storage,
} from "line-bot-router/cloudflare";
```

## クイックスタート

`templates/cloudflare-worker` を雛形にデプロイするのが最短ルートです。
GitHub リポジトリの [docs/cloudflare-deploy.md](https://github.com/aspick/line-bot-router/blob/main/docs/cloudflare-deploy.md) を参照してください。

## D1 マイグレーション

初期化 SQL は `node_modules/line-bot-router/migrations/0001_init.sql` に含まれます。
`wrangler.jsonc` の `d1_databases[].migrations_dir` でこのパスを指定し、
`wrangler d1 migrations apply DB` で適用してください。

## ライセンス

MIT
