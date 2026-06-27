# LINE Bot Router 設計方針

作成日: 2026-06-27  
最終更新: 2026-06-27

## 目的

LINE グループには同時に 1 つの LINE Official Account / bot しか参加できない前提で、1 つの代表 bot をルーターとして招待し、その内側で複数の子 bot / 外部サービスを共存させる。

この OSS は SaaS として中央管理するのではなく、利用者が自分の LINE Developers / LINE Official Account / デプロイ先を用意し、設定ファイルを編集して自分でデプロイする方式を基本とする。

## コンセプト

```text
LINE Group
  ↓ webhook
LINE Bot Router
  ├─ observer bot: アーカイブ、要約、分析など
  ├─ handler bot: コマンド、呼びかけ、postback に応答する bot
  └─ legacy / normal LINE bot: LINE webhook / Messaging API 互換で動かす bot
  ↓
LINE Messaging API
```

プロジェクトの位置づけは、次のようにする。

```text
Cloudflare Workers で簡単に動かせる、config-driven な LINE Bot Router
```

ただし core は Web 標準の `Request` / `Response` を中心に実装し、Cloudflare Workers 以外の環境にも adapter を追加できるようにする。

## 基本方針

- OSS / self-hosted を前提にする
- 管理画面は作らない
- 設定は `router.config.ts` または `router.config.yaml` で宣言する
- secret は設定ファイルに直接書かず、環境変数または各プラットフォームの secrets に置く
- LINE の channel secret / channel access token は router だけが保持する
- 子 bot は、できるだけ「自分が LINE 直下にいるのか、router 配下にいるのか」を意識しなくてよい設計にする
- 子 bot に起動モードを追加するのではなく、router 側に child bot ごとの配信モードを持たせる
- 本物の LINE replyToken は子 bot には渡さない
- LINE webhook 互換モードでは、router が仮想 replyToken を発行する
- LINE Messaging API 互換 proxy を用意し、子 bot の LINE SDK から router 経由で reply / push できるようにする
- incoming webhook は observer lane と handler lane に分けて配送する
- アーカイブ bot と応答 bot が共存できる設計にする

## router と child bot の責務分離

### 良くない方向

child bot 側に、以下のような起動モードを持たせる設計は避ける。

```text
child bot
  ├─ direct LINE mode
  └─ router mode
```

この方式では、すべての child bot が router の存在を意識する必要があり、既存の LINE bot 実装も流用しづらい。

### 採用する方向

router 側が child bot ごとに配信モードを決める。

```text
LINE
  ↓
line-bot-router
  ├─ archive-bot      delivery: observe + line-compatible + async + none
  ├─ attendance-bot   delivery: handle + router-native + sync + http-response
  ├─ legacy-bot       delivery: handle + line-compatible + sync + messaging-api-proxy
  └─ summary-bot      delivery: observe + router-native + async + none
```

child bot は単なる HTTP endpoint として実装できる。

router が吸収する責務:

- LINE webhook 署名検証
- event format 変換
- observer / handler 配送
- sync / async 配送
- child bot 向け署名付与
- 仮想 replyToken 発行
- replyToken 一元管理
- LINE Messaging API proxy
- push / reply の代理送信

## incoming webhook の分配方針

incoming webhook は、1 つの event に対して複数の routing lane を通す。

### 子 bot の分類

#### observer bot

すべて、または条件に合う event を受け取る bot。

用途:

- 全会話アーカイブ
- AI 要約
- 検索用インデックス
- 利用状況分析
- 監査ログ

性質:

- 複数 bot へ配送可能
- 原則として返信しない
- `canReply: false`
- `canPush: false` をデフォルトにする
- 失敗してもユーザー体験を止めない
- 非同期配送・retry 対象

#### handler bot

呼びかけ、コマンド、postback、conversation lock に一致したときだけ event を受け取る bot。

用途:

- 出欠 bot
- 集金 bot
- リマインダー bot
- 録音共有 bot
- 問い合わせ bot

性質:

- 原則として最大 1 bot を選ぶ
- `canReply: true` を付与できる
- router-native では reply proposal を返せる
- line-compatible-proxy では LINE SDK の reply API 呼び出しを router が受ける
- router が最終的に LINE reply / push を一元管理する

## webhook 処理順

```text
LINE webhook event
  ↓
1. X-Line-Signature 検証
2. webhookEventId による dedupe
3. event 永続化
4. observer bots に async 配送
5. handler bot を最大 1 つ決定
6. handler に sync 配送
7. router-native なら reply proposal を受け取る
8. line-compatible-proxy なら仮想 replyToken を child bot に渡し、Messaging API proxy で reply を受ける
9. router が本物の LINE replyToken を使って LINE に reply
10. 遅い処理・observe 処理は async / push に回す
```

## routing 優先順位

handler bot は、次の優先順位で決定する。

```text
1. conversation lock
2. postback namespace
3. explicit command
4. mention / 呼びかけ
5. regex / keyword
6. fallback
```

競合時の原則:

- observer は複数に配送してよい
- handler は原則 1 つだけ採用する
- handler が複数一致したら priority の高いものを採用する
- observer が reply / push を要求しても、権限がなければ拒否する
- 本物の LINE replyToken を使うのは router だけ
- handler が遅い場合は、必要に応じて「受け付けました」だけ reply し、後続は push に回す

## conversation lock

会話型フローでは、ユーザーまたはグループ単位で一時的に handler を固定する。

例:

```json
{
  "sourceId": "Cxxxxxxxx",
  "userId": "Uxxxxxxxx",
  "serviceId": "payment",
  "state": "creating_invoice",
  "expiresAt": "2026-06-27T19:00:00+09:00"
}
```

例:

```text
User: /pay
Bot: 金額を入力してください
User: 2000円
  → command は付いていないが、conversation lock により payment bot へ handle 配送
```

この event も archive bot には observe 配送される。

## delivery mode

child bot への配信は、以下の軸を組み合わせる。

```text
role:
  observe | handle | fallback

eventFormat:
  router-native | line-compatible | raw-line

timing:
  sync | async

responseMode:
  none | http-response | callback | messaging-api-proxy
```

### 1. observe + line-compatible + async + none

アーカイブ bot / ログ保存 bot 向け。

```ts
{
  id: "archive",
  endpoint: "https://archive.example.com/line-webhook",
  routing: {
    role: "observe",
    events: ["*"]
  },
  delivery: {
    eventFormat: "line-compatible",
    timing: "async",
    responseMode: "none"
  }
}
```

child bot には LINE webhook に近い payload を配送する。

```json
{
  "destination": "Uxxxxxxxx",
  "events": [
    {
      "type": "message",
      "timestamp": 1710000000000,
      "source": {
        "type": "group",
        "groupId": "Cxxxxxxxx",
        "userId": "Uxxxxxxxx"
      },
      "message": {
        "type": "text",
        "id": "123456",
        "text": "次の練習どうします？"
      }
    }
  ]
}
```

### 2. handle + router-native + sync + http-response

新しく作る child bot 向け。MVP の標準的な handler 方式。

```ts
{
  id: "attendance",
  endpoint: "https://attendance.example.com/events",
  routing: {
    role: "handle",
    commands: ["/att", "出欠:"],
    postbackNamespace: "attendance"
  },
  delivery: {
    eventFormat: "router-native",
    timing: "sync",
    responseMode: "http-response"
  }
}
```

router-native payload 例:

```json
{
  "deliveryType": "handle",
  "eventId": "evt_123",
  "source": {
    "type": "group",
    "id": "Cxxxxxxxx"
  },
  "actor": {
    "userId": "Uxxxxxxxx",
    "displayName": "Yugo"
  },
  "event": {
    "type": "message",
    "message": {
      "type": "text",
      "text": "/att 7/3 練習"
    }
  },
  "routing": {
    "matchedBy": "command",
    "command": "/att"
  },
  "capabilities": {
    "canReply": true,
    "canPush": true
  }
}
```

child bot は HTTP response で reply proposal を返す。

```json
{
  "reply": {
    "priority": 80,
    "messages": [
      {
        "type": "text",
        "text": "7/3 の出欠を作成しました。"
      }
    ]
  }
}
```

### 3. handle + line-compatible + sync + messaging-api-proxy

既存 LINE bot 実装の移植向け。重要な目玉機能。

```ts
{
  id: "legacy-reminder",
  endpoint: "https://reminder.example.com/line-webhook",
  routing: {
    role: "handle",
    commands: ["/remind", "リマインド:"]
  },
  delivery: {
    eventFormat: "line-compatible",
    timing: "sync",
    responseMode: "messaging-api-proxy"
  },
  proxy: {
    messagingApi: true,
    blobApi: false
  }
}
```

router は child bot に LINE webhook 互換 payload を配送する。

```json
{
  "destination": "Uxxxxxxxx",
  "events": [
    {
      "type": "message",
      "timestamp": 1710000000000,
      "source": {
        "type": "group",
        "groupId": "Cxxxxxxxx",
        "userId": "Uxxxxxxxx"
      },
      "replyToken": "rtr_reply_01HXYZ...",
      "message": {
        "type": "text",
        "id": "123456",
        "text": "/remind 明日 20時 練習"
      }
    }
  ]
}
```

この `replyToken` は LINE の本物の replyToken ではなく、router が発行した仮想 replyToken。

child bot 側では、LINE SDK の API base URL を router に向ける。

```ts
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  baseURL: process.env.LINE_API_BASE_URL, // https://router.example.com
});
```

child bot の環境変数例:

```env
LINE_CHANNEL_SECRET=child_bot_webhook_secret
LINE_CHANNEL_ACCESS_TOKEN=child_bot_service_token
LINE_API_BASE_URL=https://router.example.com
```

child bot は通常の LINE bot のように書ける。

```ts
await client.replyMessage({
  replyToken: event.replyToken,
  messages: [{ type: "text", text: "リマインダーを作成しました。" }],
});
```

実際の通信は次のようになる。

```text
child bot
  ↓ POST https://router.example.com/v2/bot/message/reply
router
  ↓ POST https://api.line.me/v2/bot/message/reply
LINE
```

## LINE Messaging API proxy

`line-compatible + messaging-api-proxy` では、router が LINE Messaging API 互換 endpoint を提供する。

### 最小実装

MVP では、まず以下だけ実装する。

```text
POST /v2/bot/message/reply
POST /v2/bot/message/push
POST /v2/bot/message/validate/reply
POST /v2/bot/message/validate/push
```

### 早期に追加したい endpoint

```text
POST /v2/bot/message/multicast
GET  /v2/bot/profile/{userId}
GET  /v2/bot/group/{groupId}/summary
GET  /v2/bot/group/{groupId}/member/{userId}
```

### 後回しにする endpoint

```text
Rich menu
Audience
Insight
LIFF
LINE Login
Narrowcast
Account link
```

### Blob API

画像・動画・音声・ファイルを扱う場合は、`api-data.line.me` 系の Blob API も必要になる。

MVP では `blobApi: false` を基本にし、必要になった段階で以下を proxy 対象に追加する。

```text
GET /v2/bot/message/{messageId}/content
```

## 仮想 replyToken

`messaging-api-proxy` では、child bot に本物の LINE replyToken を渡さない。

router が仮想 replyToken を発行する。

```text
rtr_reply_01HXYZ...
```

router 内部では、以下のように本物の replyToken と対応づける。

```json
{
  "virtualReplyToken": "rtr_reply_01HXYZ...",
  "realReplyToken": "abcdef...",
  "serviceId": "legacy-reminder",
  "sourceId": "Cxxxxxxxx",
  "expiresAt": "2026-06-27T19:00:55+09:00",
  "used": false
}
```

child bot が `/v2/bot/message/reply` を呼ぶと、router は仮想 replyToken を検証し、本物の replyToken に差し替えて LINE Reply API を呼ぶ。

制約:

- 仮想 replyToken も 1 回だけ使用可能
- 有効期限は本物の replyToken より少し短めにする
- handler として採用された service のみ使用可能
- observer service には仮想 replyToken を発行しない
- 1 回の reply で送れる messages 数は LINE の制約に合わせる

## child bot 向け署名

router が child bot に LINE webhook 互換 payload を配送する場合、`X-Line-Signature` も router が生成する。

```http
X-Line-Signature: <HMAC using child_bot_webhook_secret>
```

child bot 側では通常の LINE SDK / WebhookParser で署名検証できる。

ここで使う secret は、本物の LINE Channel Secret ではなく、router と child bot 間の共有 secret。

## config-first 方針

管理画面は作らず、設定ファイルを編集してデプロイする。

Cloudflare Workers first では、実行時に任意のファイルを読むより、`router.config.ts` を bundle に含める方式が扱いやすい。

設定例:

```ts
import { defineRouterConfig } from "line-bot-router/config";

export default defineRouterConfig({
  router: {
    infoCommand: "/router info",
    unknownGroupPolicy: "ignore",
  },

  services: [
    {
      id: "archive",
      name: "Archive Bot",
      endpoint: "https://archive.example.com/line-webhook",
      secretEnv: "ARCHIVE_WEBHOOK_SECRET",
      routing: {
        role: "observe",
        events: ["*"],
      },
      delivery: {
        eventFormat: "line-compatible",
        timing: "async",
        responseMode: "none",
      },
      permissions: {
        receiveMessages: true,
        sendMessages: false,
      },
    },

    {
      id: "attendance",
      name: "Attendance Bot",
      endpoint: "https://attendance.example.com/events",
      secretEnv: "ATTENDANCE_WEBHOOK_SECRET",
      routing: {
        role: "handle",
        commands: ["/att", "出欠:"],
        postbackNamespace: "attendance",
        mentions: ["出欠bot"],
      },
      delivery: {
        eventFormat: "router-native",
        timing: "sync",
        responseMode: "http-response",
      },
      permissions: {
        receiveMessages: true,
        sendMessages: true,
      },
    },

    {
      id: "legacy-reminder",
      name: "Legacy Reminder Bot",
      endpoint: "https://reminder.example.com/line-webhook",
      secretEnv: "REMINDER_WEBHOOK_SECRET",
      serviceTokenEnv: "REMINDER_SERVICE_TOKEN",
      routing: {
        role: "handle",
        commands: ["/remind", "リマインド:"],
      },
      delivery: {
        eventFormat: "line-compatible",
        timing: "sync",
        responseMode: "messaging-api-proxy",
      },
      proxy: {
        messagingApi: true,
        blobApi: false,
      },
      permissions: {
        receiveMessages: true,
        sendMessages: true,
      },
    },
  ],

  groups: [
    {
      id: "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      name: "Chor Doma",
      enabledServices: ["archive", "attendance", "legacy-reminder"],
    },
  ],
});
```

## `/router info`

管理画面を持たないため、groupId / userId を確認するための管理用コマンドを用意する。

例:

```text
/router info
```

返答例:

```text
source:
  type: group
  groupId: Cxxxxxxxx
user:
  userId: Uxxxxxxxx
```

情報漏れを避けるため、通常は admin userId のみ実行可能にする。

初回セットアップ時だけ、以下のような設定を許可してもよい。

```ts
setup: {
  allowInfoCommandWithoutAdmin: true,
}
```

運用開始後は false に戻す。

## Cloudflare Workers first の構成

Cloudflare Workers 版は次を基本構成にする。

```text
LINE Webhook
  ↓
Cloudflare Worker
  ├─ signature verify
  ├─ routing
  ├─ delivery mode conversion
  ├─ virtual replyToken issuance
  ├─ Messaging API proxy
  ├─ D1: event log / dedupe / locks / virtual replyToken
  ├─ Queues: async dispatch / retry
  └─ fetch: child services / LINE Messaging API
```

役割:

```text
D1:
- webhookEventId の重複排除
- event log
- conversation lock
- virtual replyToken mapping
- outbound dedupe
- group / service runtime state

Queues:
- observer bot への非同期配送
- retry したい external webhook
- 遅い処理

Durable Objects:
- v0.1 では不要
- 将来、group 単位の強い直列化が必要なら検討
```

## Cloudflare 用 wrangler 設定例

```jsonc
{
  "name": "line-bot-router",
  "main": "src/cloudflare/index.ts",
  "compatibility_date": "2026-06-01",

  "vars": {
    "APP_ENV": "production"
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "line_bot_router",
      "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  ],

  "queues": {
    "producers": [
      {
        "binding": "EVENT_QUEUE",
        "queue": "line-bot-router-events"
      }
    ],
    "consumers": [
      {
        "queue": "line-bot-router-events"
      }
    ]
  }
}
```

secrets:

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put ARCHIVE_WEBHOOK_SECRET
npx wrangler secret put ATTENDANCE_WEBHOOK_SECRET
npx wrangler secret put REMINDER_WEBHOOK_SECRET
npx wrangler secret put REMINDER_SERVICE_TOKEN
```

## Cloudflare Worker entrypoint 例

```ts
import { Hono } from "hono";
import config from "../../router.config";
import {
  handleLineWebhook,
  handleServiceMessage,
  handleMessagingApiProxy,
} from "line-bot-router/cloudflare";

type Env = {
  DB: D1Database;
  EVENT_QUEUE: Queue;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  ARCHIVE_WEBHOOK_SECRET: string;
  ATTENDANCE_WEBHOOK_SECRET: string;
  REMINDER_WEBHOOK_SECRET: string;
  REMINDER_SERVICE_TOKEN: string;
};

const app = new Hono<{ Bindings: Env }>();

app.post("/line/webhook", async (c) => {
  return handleLineWebhook({
    request: c.req.raw,
    env: c.env,
    ctx: c.executionCtx,
    config,
  });
});

app.post("/api/messages", async (c) => {
  return handleServiceMessage({
    request: c.req.raw,
    env: c.env,
    config,
  });
});

app.all("/v2/bot/*", async (c) => {
  return handleMessagingApiProxy({
    request: c.req.raw,
    env: c.env,
    config,
  });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
```

## Cloudflare 以外のデプロイ先

Cloudflare Workers を第一候補にしつつ、他の adapter / template も用意できるようにする。

### 1. Cloudflare Workers + D1 + Queues

第一候補。

向いている理由:

- Webhook router と相性が良い
- デプロイが軽い
- D1 / Queues / Secrets を同じプラットフォームで扱える
- OSS 利用者が比較的安価に始めやすい
- Web 標準 API で実装しやすい

注意点:

- Node.js の `fs` や長時間常駐処理を前提にできない
- 重い AI 処理は外部サービスに逃がす
- 実行時間・CPU 制限を意識する

### 2. Google Cloud Run

Docker / container 版の第一候補。

向いている理由:

- 任意の container を動かせる
- Node.js / Go / Ruby など runtime の自由度が高い
- Cloud SQL / Pub/Sub / Secret Manager と組み合わせやすい
- Cloudflare Workers より一般的なサーバーアプリに近い

注意点:

- Google Cloud の設定項目が多く、OSS 利用者にはやや重い
- D1 相当の軽い内蔵 DB はないため、Cloud SQL などの外部 DB を使う想定になる

### 3. Fly.io

Docker + SQLite / Litestream / Postgres で運用したい場合の候補。

向いている理由:

- Dockerfile から deploy しやすい
- persistent volume を使える
- SQLite を volume に置く構成が作りやすい
- 小さな常駐 web service に向いている

注意点:

- volume はマシンに紐づくため、冗長化やリージョン設計は考える必要がある
- DB を安全に運用するには Cloudflare D1 より理解が必要

### 4. Render

GitHub 連携で web service / worker / cron / managed Postgres を使いたい場合の候補。

向いている理由:

- GitHub からのデプロイが分かりやすい
- web service、background worker、cron job、managed database などが揃っている
- Node.js server として動かしやすい

注意点:

- Cloudflare Workers より常駐サーバー寄り
- 小さな router だけを置くにはやや大きい可能性がある

### 5. Deno Deploy

Deno / TypeScript / Web 標準 API に強く寄せる場合の候補。

向いている理由:

- Web 標準 API と相性が良い
- TypeScript で軽く書ける
- cron などの platform primitive もある

注意点:

- ecosystem と利用者の慣れでは Cloudflare Workers の方が広い可能性がある
- OSS 利用者がすでに Deno に慣れているとは限らない

### 6. Vercel / Netlify Functions

Webhook endpoint としては使えるが、第一候補ではない。

向いている理由:

- Next.js / frontend と同居させるなら楽
- GitHub 連携が分かりやすい
- 小さな HTTP endpoint は作りやすい

注意点:

- router 専用基盤としては、DB / Queue / retry を別途考える必要がある
- LINE webhook router のためだけなら Cloudflare Workers / Cloud Run の方が自然
- Vercel / Netlify は frontend hosting の印象が強く、router OSS の標準デプロイ先としてはややズレる

## 推奨 adapter 順

```text
Tier 1:
- Cloudflare Workers adapter

Tier 2:
- Node.js adapter for Docker / Cloud Run / Fly.io / Render

Tier 3:
- Deno adapter
- Vercel / Netlify function template
```

## runtime 抽象化

core は platform に依存させない。

```text
packages/core
  - config schema
  - routing engine
  - delivery planner
  - event format converter
  - virtual replyToken manager
  - reply proposal aggregation
  - normalized event types

packages/cloudflare
  - D1 storage
  - Queue dispatcher
  - Workers entrypoint helper
  - Cloudflare secrets/env adapter
  - Messaging API proxy adapter

packages/node
  - SQLite/PostgreSQL storage
  - HTTP server adapter
  - Docker entrypoint
  - Messaging API proxy adapter
```

抽象化する interface:

```ts
export interface StorageAdapter {
  saveEvent(event: NormalizedLineEvent): Promise<void>;
  hasProcessed(webhookEventId: string): Promise<boolean>;
  markProcessed(webhookEventId: string): Promise<void>;
  getConversationLock(sourceId: string, userId?: string): Promise<ConversationLock | null>;
  setConversationLock(lock: ConversationLock): Promise<void>;
  createVirtualReplyToken(input: CreateVirtualReplyTokenInput): Promise<VirtualReplyToken>;
  consumeVirtualReplyToken(token: string, serviceId: string): Promise<VirtualReplyToken | null>;
  saveOutboundMessage(message: OutboundMessage): Promise<void>;
}

export interface AsyncDispatcher {
  enqueue(delivery: ServiceDelivery): Promise<void>;
}

export interface SecretResolver {
  get(name: string): string | undefined;
}

export interface LineApiProxy {
  handle(request: Request, service: ServiceConfig): Promise<Response>;
}
```

## service webhook payload

router から service へ配送する payload は、delivery mode によって変える。

### router-native

```json
{
  "eventId": "evt_123",
  "deliveryType": "handle",
  "source": {
    "type": "group",
    "id": "Cxxxxxxxx"
  },
  "actor": {
    "userId": "Uxxxxxxxx",
    "displayName": "Yugo"
  },
  "event": {
    "type": "message",
    "message": {
      "type": "text",
      "text": "/att 7/3 練習"
    }
  },
  "routing": {
    "matchedBy": "command",
    "command": "/att"
  },
  "capabilities": {
    "canReply": true,
    "canPush": true
  }
}
```

### line-compatible observe

```json
{
  "destination": "Uxxxxxxxx",
  "events": [
    {
      "type": "message",
      "timestamp": 1710000000000,
      "source": {
        "type": "group",
        "groupId": "Cxxxxxxxx",
        "userId": "Uxxxxxxxx"
      },
      "message": {
        "type": "text",
        "id": "123456",
        "text": "次の練習どうします？"
      }
    }
  ]
}
```

### line-compatible handler

```json
{
  "destination": "Uxxxxxxxx",
  "events": [
    {
      "type": "message",
      "timestamp": 1710000000000,
      "source": {
        "type": "group",
        "groupId": "Cxxxxxxxx",
        "userId": "Uxxxxxxxx"
      },
      "replyToken": "rtr_reply_01HXYZ...",
      "message": {
        "type": "text",
        "id": "123456",
        "text": "/remind 明日 20時 練習"
      }
    }
  ]
}
```

## service から router への送信方法

送信方法は2つ用意する。

### 1. router native API

外部 service は LINE Messaging API を直接叩かず、router の内部 API を叩く。

```http
POST /api/messages
Authorization: Bearer <service-token>
```

```json
{
  "serviceId": "payment",
  "to": {
    "type": "group",
    "id": "Cxxxxxxxx"
  },
  "messages": [
    {
      "type": "text",
      "text": "[集金] 参加費 2,000円の集金を開始しました。"
    }
  ],
  "dedupeKey": "payment:invoice:123:created"
}
```

### 2. LINE Messaging API proxy

既存 LINE bot 実装を流用したい場合、child bot は LINE SDK の API base URL を router に向ける。

```text
LINE_API_BASE_URL=https://router.example.com
```

child bot から見ると、通常の Messaging API を叩いているように見える。

router は service token / virtual replyToken / group 権限を検証し、LINE API に代理送信する。

## v0.1 MVP

最初の実装範囲:

- Cloudflare Workers template
- Hono endpoint
- LINE signature verification
- `router.config.ts`
- config validation
- command routing
- postback namespace routing
- observer / handler lane
- delivery mode
  - `observe + line-compatible + async + none`
  - `handle + router-native + sync + http-response`
  - `handle + line-compatible + sync + messaging-api-proxy`
- D1 event log
- webhookEventId dedupe
- conversation lock
- virtual replyToken
- external webhook dispatch
- reply proposal aggregation
- router native send API: `POST /api/messages`
- Messaging API proxy
  - `POST /v2/bot/message/reply`
  - `POST /v2/bot/message/push`
  - validate endpoints
- `/router info`
- wrangler deploy 手順

## v0.2

- Cloudflare Queues による observe 配送 / retry
- dead letter 相当の失敗記録
- service webhook timeout / retry policy
- group ごとの enabled services
- service priority
- Messaging API proxy endpoint 追加
  - multicast
  - profile
  - group summary
  - group member
- Docker / Node.js adapter
- SQLite storage adapter

## v0.3

- sample plugins
  - echo
  - archive
  - reminder
  - attendance sample
- Blob API proxy
- Cloud Run template
- Fly.io template
- Render template
- CLI
  - `validate`
  - `print-webhook-url`
  - `events tail`
  - `services test`

## リポジトリ構成案

```text
line-bot-router/
  packages/
    core/
      config/
      routing/
      delivery/
      line/
      proxy/
      tokens/
      types/
    cloudflare/
      handleLineWebhook.ts
      handleMessagingApiProxy.ts
      d1Storage.ts
      queueDispatcher.ts
      lineClient.ts
    node/
      server.ts
      sqliteStorage.ts
      postgresStorage.ts
      handleMessagingApiProxy.ts

  templates/
    cloudflare-worker/
      src/index.ts
      router.config.ts
      wrangler.jsonc
      migrations/
      package.json

    docker/
      src/index.ts
      router.config.ts
      docker-compose.yml
      package.json

  examples/
    echo-service/
    archive-service/
    attendance-service/
    legacy-line-bot-service/
    payment-service/

  docs/
    line-setup.md
    cloudflare-deploy.md
    config.md
    routing.md
    delivery-modes.md
    messaging-api-proxy.md
    service-webhook.md
    security.md
```

## セキュリティ方針

- LINE webhook は必ず `X-Line-Signature` を検証する
- child bot への LINE 互換配送では、router が child secret で `X-Line-Signature` を生成する
- service webhook への router-native 配送は HMAC 署名付きにする
- service から router API への投稿は service token で認証する
- Messaging API proxy でも service token を必須にする
- service ごとに送信可能な groupId を制限する
- observer bot にはデフォルトで送信権限を与えない
- 本物の LINE replyToken は外部に出さない
- 仮想 replyToken は短命・一度きり・serviceId に紐づける
- event log の保存期間を設定可能にする
- secret は config に直接書かない
- `/router info` は admin userId 制限を基本とする

## 最終方針

この OSS は、次の方針で進める。

```text
Cloudflare Workers first
config-first
no admin UI
observer / handler routing
delivery mode on router side
LINE-compatible delivery
Messaging API proxy
virtual replyToken
adapter-based runtime support
```

まずは Cloudflare Workers + D1 で最小実装を作る。

MVP では次の3種類の child bot を共存させられることを目標にする。

```text
1. 全会話をアーカイブする observer bot
2. router-native で reply proposal を返す新規 handler bot
3. LINE SDK の API base URL を router に向ける既存 LINE bot 風 handler bot
```

その上で Node.js adapter を追加し、Cloud Run / Fly.io / Render などにも展開できる構成にする。
