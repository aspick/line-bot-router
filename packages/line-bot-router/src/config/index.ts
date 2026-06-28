import {
  RouterConfigSchema,
  type RouterConfig,
  type RouterConfigInput,
} from "./schema.js";

export type {
  RouterConfig,
  RouterConfigInput,
  ServiceConfig,
  GroupConfig,
  RouterRuntimeConfig,
} from "./schema.js";
export { RouterConfigSchema } from "./schema.js";

/**
 * router.config.ts で使うエントリポイント。
 * 与えられた config を validate し、解決済みの RouterConfig を返す。
 */
export function defineRouterConfig(input: RouterConfigInput): RouterConfig {
  const parsed = RouterConfigSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    });
    throw new Error(
      `[line-bot-router] invalid router config:\n${lines.join("\n")}`,
    );
  }
  warnOnRiskySetup(parsed.data);
  return parsed.data;
}

/**
 * config の安全性が落ちる組合せに対する非ブロッキングな注意喚起。
 * 例: `allowInfoCommandWithoutAdmin: true` のまま `adminUserIds` が空だと、
 * /router info で内部 ID (sourceId / groupId / actorUserId) が任意ユーザーから読み出せる。
 * 初回セットアップでは正規の状態なので reject せず warning のみ。
 */
function warnOnRiskySetup(cfg: RouterConfig): void {
  const allowOpen = cfg.router.setup?.allowInfoCommandWithoutAdmin === true;
  const noAdmins =
    !cfg.router.adminUserIds || cfg.router.adminUserIds.length === 0;
  if (allowOpen && noAdmins) {
    console.warn(
      "[line-bot-router] WARNING: router.setup.allowInfoCommandWithoutAdmin=true with empty adminUserIds. " +
        "/router info will reply with sourceId / groupId / actorUserId to ANY user in the group. " +
        "Set this back to false (and populate adminUserIds) before production use.",
    );
  }
}
