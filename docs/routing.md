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

## mention の match 仕様

- `mentions: ["出欠bot"]` のようにキーワードを並べると、`@出欠bot ...` のように `@` プレフィクス付きで text に含まれる場合にのみマッチする
- v0.1 以前にあった裸のキーワード部分一致 (`text.includes("bot")` のような) は意図しないハンドラ起動が起きるため廃止
- 空文字を含めても自動的にスキップされる

## regex の match 仕様 (ReDoS 注意)

- `regex: [...]` は `new RegExp(r).test(text)` で評価する
- text が 256 文字を超える場合は regex 評価をスキップして「no match」として扱う (catastrophic backtracking 対策の defense-in-depth)。truncate して prefix を試すと `^a+$` のような anchored pattern で意味論が壊れて誤マッチを引き起こすため、prefix では試さない
- ただし JS RegExp は Cloudflare Workers で sandbox / timeout を持てないため、`^(a+)+$` のような operator が書いた catastrophic pattern は短い text でも CPU を使い切る。文字数 cap は最後の砦に過ぎず、本質的な防御は **operator が pattern をレビューすること**
- 自分で書いた regex は信頼できる範囲に留め、外部から取り込んだ pattern や AI が生成した pattern はレビューしてから設定すること

## permissions

- service に `permissions.allowedGroupIds` を指定すると、その group 以外には配送 / 送信を拒否
- `groups[].enabledServices` でも絞り込み可能
