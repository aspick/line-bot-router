import { Hono } from "hono";
import {
  handleLineWebhook,
  handleMessagingApiProxy,
  handleServiceMessage,
} from "line-bot-router/cloudflare";
import config from "../router.config.js";
import type { Env } from "../worker-configuration";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, env: c.env.APP_ENV ?? "unknown" }));

app.post("/line/webhook", async (c) => {
  return handleLineWebhook({
    request: c.req.raw,
    env: c.env,
    ctx: c.executionCtx,
    config,
  });
});

app.post("/api/messages", async (c) => {
  return handleServiceMessage({
    request: c.req.raw,
    env: c.env,
    config,
  });
});

app.all("/v2/bot/*", async (c) => {
  return handleMessagingApiProxy({
    request: c.req.raw,
    env: c.env,
    config,
  });
});

app.notFound((c) => c.json({ message: "not found" }, 404));

app.onError((err, c) => {
  console.error("[line-bot-router] unhandled error", err);
  return c.json({ message: "internal error" }, 500);
});

export default app;
