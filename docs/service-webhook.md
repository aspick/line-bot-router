# service webhook

router から child bot に届く HTTP リクエストの仕様。

## 共通ヘッダ

| header                              | 説明                                     |
| ----------------------------------- | ---------------------------------------- |
| `Content-Type: application/json`    | 常に JSON                                |
| `X-Line-Bot-Router-Delivery`        | `observe` か `handle`                    |
| `X-Line-Bot-Router-Service`         | service id (config の id と一致)         |

## 署名

- `eventFormat: "line-compatible"` の場合、`X-Line-Signature` (`base64(HMAC_SHA256(secret, rawBody))`)
- `eventFormat: "router-native"` の場合、
  - `X-Line-Bot-Router-Timestamp: <unix秒>`
  - `X-Line-Bot-Router-Signature: hex(HMAC_SHA256(secret, "${timestamp}.${rawBody}"))`

secret は config の `secretEnv` が指す環境変数の値。

## payload

[delivery-modes.md](./delivery-modes.md) を参照。

## HTTP レスポンス

- `responseMode: "none"` (observer): router は response を無視
- `responseMode: "http-response"` (router-native handler):
  ```json
  {
    "reply": {
      "priority": 80,
      "messages": [{ "type": "text", "text": "..." }]
    }
  }
  ```
- `responseMode: "messaging-api-proxy"` (line-compatible handler):
  router 側は HTTP response の中身を見ません。child bot が proxy 経由で reply / push を行う想定です。

## タイムアウト

各 service の `delivery.timeoutMs` で指定 (デフォルト 8000ms)。
タイムアウトしても router は LINE に 200 を返します (再送防止)。
