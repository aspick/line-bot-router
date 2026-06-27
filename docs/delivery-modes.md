# delivery mode

`delivery.eventFormat` × `delivery.timing` × `delivery.responseMode` の組み合わせで child bot への配送形式が決まります。MVP では下記 3 種だけサポートします。

## 1. `observe + line-compatible + async + none`

アーカイブ / ログ保存向け。

- router → child: `POST` に LINE webhook 互換の `{destination, events: [...]}` を送る
- `replyToken` は **削る** (observer に reply 権限は与えない)
- 署名は `X-Line-Signature` (child と router 間の共有 secret で HMAC-SHA256)
- response body は無視

## 2. `handle + router-native + sync + http-response`

新規 child bot 向けの推奨形式。

- router → child: `POST` に router-native payload (下記) を送る
- response body から `{ reply: { messages: [...] } }` を期待
- router が **本物の LINE replyToken** を使って LINE Reply API に転送

```json
{
  "eventId": "evt_123",
  "deliveryType": "handle",
  "source": { "type": "group", "id": "Cxxxxxxxx" },
  "actor": { "userId": "Uxxxxxxxx" },
  "event": { "type": "message", "message": { "type": "text", "text": "/att" } },
  "routing": { "matchedBy": "command", "command": "/att" },
  "capabilities": { "canReply": true, "canPush": true }
}
```

署名は `X-Line-Bot-Router-Signature: hex(HMAC_SHA256(secret, "${timestamp}.${rawBody}"))` と `X-Line-Bot-Router-Timestamp: <unix秒>`。

## 3. `handle + line-compatible + sync + messaging-api-proxy`

既存 LINE bot 実装の移植向け。

- router → child: `POST` に LINE webhook 互換 payload を送る
- `replyToken` は **router が発行する仮想 replyToken** (`rtr_reply_*`) に置き換える
- child は通常通り `@line/bot-sdk` で `client.replyMessage(...)` を呼ぶ
- ただし `baseURL` を router 自身 (`https://router.example.com`) に向ける
- router の `POST /v2/bot/message/reply` が仮想 replyToken を本物に差し替えて LINE に転送

詳しくは [messaging-api-proxy.md](./messaging-api-proxy.md) を参照。
