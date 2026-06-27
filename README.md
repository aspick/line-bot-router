# line-bot-router

Cloudflare Workers で簡単に動かせる、config-driven な LINE Bot Router。

LINE グループには同時に 1 つの LINE Official Account / bot しか参加できない、という前提のもとで、1 つの代表 bot をルーターとして招待し、その内側で複数の子 bot / 外部サービスを共存させるための OSS です。

詳しい設計は [`line-bot-router-plan.md`](./line-bot-router-plan.md) を参照してください。

## 構成

```text
packages/
  line-bot-router/         # npm パッケージ "line-bot-router"
    src/
      core/                # 共通ロジック (signature / routing / replyToken ...)
      config/              # defineRouterConfig
      cloudflare/          # Cloudflare Workers アダプタ
    migrations/            # D1 用 SQL
templates/
  cloudflare-worker/       # 初学者向けデプロイテンプレート
docs/                      # セットアップ・運用ガイド
```

外部に公開する import surface:

| import path                  | 用途                                             |
| ---------------------------- | ------------------------------------------------ |
| `line-bot-router`            | 共通型と core ヘルパー                           |
| `line-bot-router/config`     | `defineRouterConfig` (設定ファイルで使う)        |
| `line-bot-router/cloudflare` | `handleLineWebhook` などの CF Workers ハンドラ群 |

## v0.1 で実装している範囲

- LINE webhook の署名検証
- `webhookEventId` ベースの dedupe
- D1 への event 永続化
- observer / handler 配送
- delivery mode 3 種
  - `observe + line-compatible + async + none`
  - `handle + router-native + sync + http-response`
  - `handle + line-compatible + sync + messaging-api-proxy`
- conversation lock (read のみ、書き込みは v0.2)
- 仮想 replyToken (発行 / 1 回限り消費)
- `/router info` コマンド
- Messaging API proxy
  - `POST /v2/bot/message/reply`
  - `POST /v2/bot/message/push`
  - `POST /v2/bot/message/validate/{reply,push}`
- router native send API: `POST /api/messages`

非対応 (v0.2 以降):

- Cloudflare Queues / multicast / profile / group summary
- Blob API proxy
- Node.js / Docker adapter
- CLI (`validate`, `events tail` など)

## クイックスタート (Cloudflare Workers)

詳しくは [`docs/cloudflare-deploy.md`](./docs/cloudflare-deploy.md) を参照。

```bash
pnpm install
cp templates/cloudflare-worker/.dev.vars.example templates/cloudflare-worker/.dev.vars
# .dev.vars を編集して LINE channel secret / access token を入れる
pnpm --filter @templates/cloudflare-worker db:apply:local
pnpm --filter @templates/cloudflare-worker dev
```

## ドキュメント

- [docs/line-setup.md](./docs/line-setup.md)
- [docs/cloudflare-deploy.md](./docs/cloudflare-deploy.md)
- [docs/config.md](./docs/config.md)
- [docs/routing.md](./docs/routing.md)
- [docs/delivery-modes.md](./docs/delivery-modes.md)
- [docs/messaging-api-proxy.md](./docs/messaging-api-proxy.md)
- [docs/service-webhook.md](./docs/service-webhook.md)
- [docs/security.md](./docs/security.md)

## ライセンス

MIT
