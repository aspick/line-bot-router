# Messaging API proxy

`responseMode: "messaging-api-proxy"` の child bot は、LINE Messaging API の代わりに router の proxy endpoint を叩きます。

## 必須設定

`router.config.ts` で:

```ts
{
  id: "legacy-reminder",
  serviceTokenEnv: "REMINDER_SERVICE_TOKEN",
  delivery: {
    eventFormat: "line-compatible",
    responseMode: "messaging-api-proxy",
    timing: "sync",
  },
  proxy: {
    messagingApi: true,
  },
  permissions: {
    // proxy 経由で reply / push する service は必須。
    // 未設定だと defineRouterConfig が config-time エラーで止める。
    sendMessages: true,
  },
}
```

`serviceTokenEnv` で指定した環境変数の値が、child bot からのリクエストの `Authorization: Bearer ...` と一致しないと 401 で弾かれます。

## child bot 側

`@line/bot-sdk` を base URL を router に向けて使えます。ただし v0.1 で proxy が受け付ける endpoint は下の表のとおりで、それ以外を叩くと 501 が返ります (詳細は「対応エンドポイント」節を参照)。

```ts
import { messagingApi } from "@line/bot-sdk";

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  baseURL: process.env.LINE_API_BASE_URL,
});

await client.replyMessage({
  replyToken: event.replyToken,
  messages: [{ type: "text", text: "..." }],
});
```

```env
LINE_CHANNEL_SECRET=<router と握った child webhook secret>
LINE_CHANNEL_ACCESS_TOKEN=<router と握った service token>
LINE_API_BASE_URL=https://router.example.com
```

## 仮想 replyToken

- router は child へ配送する直前に `rtr_reply_<rand>` を発行し、D1 に「仮想 ↔ 本物」「serviceId」「sourceId」「expiresAt」「used」を保存
- child が `/v2/bot/message/reply` を叩くと router が `consumeVirtualReplyToken` で消費
- 失敗条件: 期限切れ / 既使用 / 別 service が呼んだ / 仮想形式ではない
- 仮想 TTL は `router.virtualReplyToken.ttlSeconds` (デフォルト 55 秒、最大 60 秒)

## 対応エンドポイント (MVP)

| method | path                                | 状態              |
| ------ | ----------------------------------- | ----------------- |
| POST   | `/v2/bot/message/reply`             | 仮想 replyToken 解決つき |
| POST   | `/v2/bot/message/push`              | 送信先 groupId 制限つき |
| POST   | `/v2/bot/message/validate/reply`    | LINE へ素通し     |
| POST   | `/v2/bot/message/validate/push`     | LINE へ素通し     |

未対応 endpoint (例: `GET /v2/bot/profile/{userId}`, `POST /v2/bot/message/multicast`) は **501 Not Implemented** を返します。v0.2 で `multicast`, `profile`, `group/summary`, `group/member/{userId}` を追加予定。Blob API はさらに先。

## 転送されるリクエストヘッダ

child → router → LINE の方向で、現状 router が LINE に転送するヘッダは以下:

- `X-Line-Retry-Key` (`@line/bot-sdk` の `retryKey` オプションが付ける idempotency key)

それ以外のヘッダ (任意の `X-*`、`User-Agent` 等) は転送しません。LINE → router → child の方向では `x-line-request-id`, `x-line-accepted-request-id`, `retry-after` をそのまま返します。
