# リリース手順

`line-bot-router` パッケージを npm に publish する手順。MVP 期は手動運用。

## 0. 前提

- npm に publish 権限がある (`npm whoami` で確認)
- 公開鍵で npm の 2FA を通せる
- ローカルに最新の `main` をチェックアウト済み・clean

## 1. version を上げる

```bash
cd packages/line-bot-router
npm version <major|minor|patch>
```

`npm version` は `package.json` の `version` を上げ、commit と tag (`vX.Y.Z`) を打ちます。
monorepo ルート側の version は触りません (publish 対象は line-bot-router だけ)。

## 2. ローカルで grünn になることを確認

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test
pnpm --filter line-bot-router build
pnpm --filter line-bot-router publint
```

CI と同じ手順です (`.github/workflows/ci.yml`)。

## 3. tarball を覗いて confidence check

```bash
pnpm --filter line-bot-router pack
tar tf packages/line-bot-router/line-bot-router-*.tgz | sort
```

確認ポイント:

- `package/dist/{core,config,cloudflare}/index.{js,d.ts}` が含まれる
- `package/migrations/0001_init.sql` が含まれる
- `package/LICENSE` / `package/README.md` が含まれる
- `*.test.js` / `*.test.d.ts` が含まれて **いない**

## 4. publish

```bash
pnpm --filter line-bot-router publish --access public
```

`prepublishOnly` で `pnpm run build` が自動で走ります。
`publishConfig.exports` が effective になり、tarball 内の `exports` は `dist/**/*` を指します。

OTP を求められたら入力します。

## 5. tag を push して GitHub Release を作る

```bash
git push origin main --follow-tags
gh release create vX.Y.Z --generate-notes
```

## ロールバック

publish 後 72 時間以内なら `npm unpublish line-bot-router@X.Y.Z` が可能。
それ以降は deprecated にする (`npm deprecate line-bot-router@X.Y.Z "理由"`)。

## テンプレートの扱い

`templates/cloudflare-worker` は npm publish の対象外 (`private: true`) です。
利用者は「リポジトリをクローンしてテンプレートを使う」想定です。
テンプレートを別リポジトリにコピーする場合は、`package.json` の
`"line-bot-router": "workspace:*"` を `"^X.Y.0"` のような実バージョンに書き換える必要があります。
