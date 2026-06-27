# セキュリティ方針

- LINE webhook は必ず `X-Line-Signature` を検証する (`raw body` のバイト列に対して HMAC-SHA256)
- 子 bot への LINE 互換配送では、router が `secretEnv` で署名した `X-Line-Signature` を付ける
- router-native 配送は `X-Line-Bot-Router-Signature` + `X-Line-Bot-Router-Timestamp` で署名
- service から router API への投稿は `Authorization: Bearer <service-token>` 必須
- Messaging API proxy でも同じ service-token を必須
- service ごとに `permissions.allowedGroupIds` と `groups[].enabledServices` で送信先 group を制限する
- observer は `sendMessages: true` を付けられない (defineRouterConfig が validate で reject)
- 本物の LINE replyToken は外部に出さない (子 bot へは仮想 replyToken のみ)
- 仮想 replyToken は短命 (デフォルト 55 秒) / 1 回きり / serviceId 紐付け
- `/router info` は `adminUserIds` 限定 (`setup.allowInfoCommandWithoutAdmin: true` のときだけ全員可)
- secret は config に直接書かず、すべて env / `wrangler secret put` 経由
- `service.secretEnv` を宣言したのに対応する env が空の場合、router は警告を出して unsigned で送るのではなく、その service への dispatch を中断する (fail-closed)
- `routing.regex` は JS RegExp で評価する。Cloudflare Workers では sandbox / timeout が無いため、operator が catastrophic backtracking を起こす regex (`^(a+)+$` など) を書くと特定 text で Worker CPU を使い切るリスクがある。256 文字を超える text は regex 評価をスキップして「no match」扱いにするが、これは延命にすぎず本質的な防御は **operator がレビュー済みの安全な regex のみ使うこと**。詳しくは [routing.md](./routing.md#regex-の-match-仕様-redos-注意) を参照
