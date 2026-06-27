# routing

webhook の 1 event ごとに次の順序で配送先を決めます。

```text
LINE webhook event
  ↓
1. X-Line-Signature 検証
2. webhookEventId による dedupe
3. event 永続化 (D1: line_events)
4. observer 全部に async 配送 (ctx.waitUntil)
5. /router info コマンドなら admin チェックして reply して終了
6. handler を最大 1 つ決定して sync 配送
7. handler の responseMode に応じて reply を実行
```

## handler 決定の優先順位

```text
1. conversation lock (該当 sourceId/userId に lock があり、その service が handle role)
2. postback namespace prefix
3. command の完全一致 / prefix + 空白
4. mention 文字列の包含
5. regex match
6. routing.role === "fallback"
```

同じレベルで複数マッチしたら `routing.priority` の降順で勝つ方を採用します。

## observer 配送

- `routing.events: ["*"]` で全イベントを受ける
- 配送は `ctx.waitUntil(fetch(...))` で fire-and-forget
- 失敗は warning ログを残すだけで握りつぶす (MVP)
- v0.2 で Cloudflare Queues + retry をサポート予定

## permissions

- service に `permissions.allowedGroupIds` を指定すると、その group 以外には配送 / 送信を拒否
- `groups[].enabledServices` でも絞り込み可能
