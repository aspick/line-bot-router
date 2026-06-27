# LINE 側のセットアップ

## 1. LINE Developers でチャネルを用意する

1. <https://developers.line.biz/console/> から Provider を作る
2. Messaging API チャネルを作成し、対象の LINE Official Account と連携
3. 「チャネル基本設定」で次を控えておく
   - **Channel secret** → `LINE_CHANNEL_SECRET`
4. 「Messaging API 設定」で次を発行・控えておく
   - **Channel access token (long-lived)** → `LINE_CHANNEL_ACCESS_TOKEN`

## 2. ボットの基本設定

LINE Official Account Manager 側で:

- 「応答メッセージ」は **オフ**
- 「Webhook」は **オン**
- 「あいさつメッセージ」は任意
- 「グループ・トークルームへの参加を許可する」を **オン**

## 3. Webhook URL

router を Cloudflare にデプロイしたあと、

```
https://<your-worker>.workers.dev/line/webhook
```

を Webhook URL に設定します。「検証」を押して 200 が返れば OK です。

## 4. 子 bot 側のセットアップ

LINE 直下の子 bot は LINE Developers でチャネルを作る必要は **ありません**。

代わりに、router と子 bot の間で:

- **共有 webhook secret** (`X-Line-Signature` 互換の署名鍵)
- **service token** (push / proxy reply の Bearer)

を発行し、router の `secretEnv` / `serviceTokenEnv` と子 bot の環境変数に同じ値を入れます。
