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
  return parsed.data;
}
