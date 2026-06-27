import type { SecretResolver } from "../core/index.js";

/**
 * Cloudflare Workers の env から値を引くための薄い helper。
 * env はインデックスシグネチャを持たないことが多いので unknown 越しに参照する。
 */
export function envSecretResolver(env: unknown): SecretResolver {
  return {
    get(name: string): string | undefined {
      if (env && typeof env === "object" && name in (env as Record<string, unknown>)) {
        const value = (env as Record<string, unknown>)[name];
        if (typeof value === "string") return value;
      }
      return undefined;
    },
  };
}

export interface BaseEnv {
  DB: D1Database;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
}

export interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
