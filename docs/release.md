# リリース手順

`line-bot-router` パッケージは GitHub Actions の **Trusted Publishing** で自動 publish します。
タグを push すると `.github/workflows/release.yml` が起動し、OIDC + Sigstore provenance 付きで
npm registry に publish されます。手動 publish は CI が壊れている等の緊急時のみ使います。

## 0. 前提 (一度だけ設定)

[npmjs.com の Trusted Publisher 設定][trusted-publishers] を済ませておきます。

- Package: `line-bot-router`
- Publisher: GitHub Actions
- Organization / repository owner: `aspick`
- Repository name: `line-bot-router`
- Workflow filename: `release.yml`
- Environment name: (空のままで OK)

[trusted-publishers]: https://docs.npmjs.com/trusted-publishers

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

## 3. tag を push して publish を起動

```bash
git push origin main --follow-tags
```

`vX.Y.Z` タグ push をトリガーに `release.yml` が起動し、以下を自動実行します:

1. install / typecheck / test / build / publint を再実行
2. `pnpm pack` で `publishConfig.exports` を適用した tarball を生成
3. `npm publish --provenance` で npm registry に publish (OIDC + Sigstore provenance 付き)

進行と結果は GitHub Actions タブで確認します。失敗時は workflow を Re-run するか、
`workflow_dispatch` から再実行します。Trusted Publishing なので長期 npm token を
secrets に置く必要はありません。

## 4. GitHub Release を作る

CI が publish に成功したら release を作って通知します:

```bash
gh release create vX.Y.Z --generate-notes
```

## tarball を覗いて confidence check したい場合

publish 前にローカルで tarball の中身を確認したいときは:

```bash
pnpm --filter line-bot-router pack
tar tf packages/line-bot-router/line-bot-router-*.tgz | sort
```

確認ポイント:

- `package/dist/{core,config,cloudflare}/index.{js,d.ts}` が含まれる
- `package/migrations/0001_init.sql` が含まれる
- `package/LICENSE` / `package/README.md` が含まれる
- `*.test.js` / `*.test.d.ts` が含まれて **いない**
- 展開後 (`package/package.json`) の `exports` が `./dist/**/*` を指している
  (`pnpm pack` は `publishConfig.exports` を適用するが、`npm pack` だと
  `./src/**/*` のままになるので注意)

## ロールバック

publish 後 72 時間以内なら `npm unpublish line-bot-router@X.Y.Z` が可能。
それ以降は deprecated にする (`npm deprecate line-bot-router@X.Y.Z "理由"`)。

## 緊急時: 手動 publish (fallback)

Trusted Publishing が使えない (CI 障害 / npmjs 側設定の問題など) の緊急時のみ使います。
npm の 2FA を passkey のみで運用しているため、CLI publish では Granular Access Token が必要です。

1. <https://www.npmjs.com/settings/aspick/tokens> で Granular Access Token を発行
   - Permissions: **Read and write**
   - Selected packages and scopes: `line-bot-router` (もしくは All packages)
   - **Allow bypassing 2FA when publishing: ON**
   - Expiration: 短く (7 days など)
2. 手元で build → pack → publish:
   ```bash
   cd packages/line-bot-router
   pnpm --filter line-bot-router build
   pnpm pack
   npm publish line-bot-router-*.tgz --access public \
     '--//registry.npmjs.org/:_authToken=npm_xxxxxxxxxx'
   ```
3. 作業後すぐに token を revoke

## テンプレートの扱い

`templates/cloudflare-worker` は npm publish の対象外 (`private: true`) です。
利用者は「リポジトリをクローンしてテンプレートを使う」想定です。
テンプレートを別リポジトリにコピーする場合は、`package.json` の
`"line-bot-router": "workspace:*"` を `"^X.Y.0"` のような実バージョンに書き換える必要があります。
