# router.config.ts

設定は `templates/cloudflare-worker/router.config.ts` に書きます。
`defineRouterConfig` は値の validate を行い、不整合があれば deploy 前に例外で落ちます。

## 形

```ts
import { defineRouterConfig } from "line-bot-router/config";

export default defineRouterConfig({
  router: {
    infoCommand: "/router info",
    unknownGroupPolicy: "ignore", // "ignore" | "respond"
    adminUserIds: ["Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    setup: {
      allowInfoCommandWithoutAdmin: false,
    },
    virtualReplyToken: {
      ttlSeconds: 55,
    },
  },
  services: [
    /* ServiceConfig[] */
  ],
  groups: [
    /* GroupConfig[] */
  ],
});
```

## ServiceConfig

| field             | 型                                                                              | 説明                                                |
| ----------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `id`              | string                                                                          | 一意な識別子                                        |
| `endpoint`        | URL                                                                             | service の webhook (router から POST する宛先)      |
| `secretEnv`       | env 名                                                                          | child へ送る署名に使う secret の環境変数名          |
| `serviceTokenEnv` | env 名                                                                          | proxy / `/api/messages` の Bearer に使う token      |
| `routing.role`    | `"observe"` \| `"handle"` \| `"fallback"`                                       |                                                     |
| `routing.events`  | string[]                                                                        | `"*"` で全 event。observer の event filter         |
| `routing.commands` / `postbackNamespace` / `mentions` / `regex` / `priority` | handler 用                                          |
| `delivery.eventFormat` | `"router-native"` \| `"line-compatible"` \| `"raw-line"`                       |                                                     |
| `delivery.timing` | `"sync"` \| `"async"`                                                            | MVP の handler は実質 sync, observer は async       |
| `delivery.responseMode` | `"none"` \| `"http-response"` \| `"messaging-api-proxy"`                       | child の返答の受け取り方                            |
| `permissions.receiveMessages` | bool                                                                            |                                                     |
| `permissions.sendMessages`    | bool                                                                            | observer はデフォルト false。`true` にして送信権限を与える |
| `permissions.allowedGroupIds` | string[]                                                                        | この service が送信できる group を限定する        |
| `proxy.messagingApi`          | bool                                                                            | `messaging-api-proxy` を有効にする場合は `true`     |

## GroupConfig

```ts
{
  id: "Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  name: "Chor Doma",
  enabledServices: ["archive", "attendance"]
}
```

`enabledServices` が指定されていれば、その group ではリストにない service は配送対象外になります。

## validate ルール

- `messaging-api-proxy` の service は `eventFormat: "line-compatible"` と `proxy.messagingApi: true` が必須
- `messaging-api-proxy` の service は `permissions.sendMessages: true` が必須 (proxy 経由で reply / push するため)
- `http-response` の service も `permissions.sendMessages: true` が必須 (response body の reply を router が転送するため)。reply しない handler は `responseMode: "none"` を使うこと
- observer に `sendMessages: true` を付けるとエラー (誤設定防止)
- group の `enabledServices` に未知の service id があるとエラー
- service id / group id の重複はエラー
