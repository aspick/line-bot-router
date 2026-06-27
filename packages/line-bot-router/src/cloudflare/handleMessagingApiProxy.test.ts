import { test } from "node:test";
import assert from "node:assert/strict";
import { defineRouterConfig } from "../config/index.js";
import type {
  ConversationLock,
  CreateVirtualReplyTokenInput,
  NormalizedLineEvent,
  OutboundMessage,
  StorageAdapter,
  VirtualReplyToken,
} from "../core/index.js";
import { VIRTUAL_REPLY_TOKEN_PREFIX } from "../core/index.js";
import { handleMessagingApiProxy } from "./handleMessagingApiProxy.js";

class InMemoryStorage implements StorageAdapter {
  events: NormalizedLineEvent[] = [];
  processed = new Set<string>();
  locks = new Map<string, ConversationLock>();
  outbound: OutboundMessage[] = [];
  tokens = new Map<string, VirtualReplyToken>();

  async saveEvent(event: NormalizedLineEvent): Promise<void> {
    this.events.push(event);
  }
  async claimEvent(id: string): Promise<boolean> {
    if (this.processed.has(id)) return false;
    this.processed.add(id);
    return true;
  }
  async getConversationLock(): Promise<ConversationLock | null> {
    return null;
  }
  async setConversationLock(lock: ConversationLock): Promise<void> {
    this.locks.set(lock.sourceId, lock);
  }
  async clearConversationLock(): Promise<void> {}
  async createVirtualReplyToken(
    input: CreateVirtualReplyTokenInput,
  ): Promise<VirtualReplyToken> {
    const token: VirtualReplyToken = {
      virtualToken: `${VIRTUAL_REPLY_TOKEN_PREFIX}test`,
      realReplyToken: input.realReplyToken,
      serviceId: input.serviceId,
      sourceId: input.sourceId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      used: false,
    };
    this.tokens.set(token.virtualToken, token);
    return token;
  }
  async peekVirtualReplyToken(
    token: string,
    serviceId: string,
  ): Promise<VirtualReplyToken | null> {
    const t = this.tokens.get(token);
    if (!t) return null;
    if (t.serviceId !== serviceId) return null;
    if (t.used) return null;
    return { ...t };
  }
  async consumeVirtualReplyToken(
    token: string,
    serviceId: string,
  ): Promise<VirtualReplyToken | null> {
    const peeked = await this.peekVirtualReplyToken(token, serviceId);
    if (!peeked) return null;
    this.tokens.set(token, { ...peeked, used: true });
    return { ...peeked, used: true };
  }
  async deleteVirtualReplyToken(virtualToken: string): Promise<void> {
    this.tokens.delete(virtualToken);
  }
  async saveOutboundMessage(
    msg: OutboundMessage,
  ): Promise<{ inserted: boolean }> {
    this.outbound.push(msg);
    return { inserted: true };
  }
  async deleteOutboundMessage(): Promise<void> {}
}

function buildEnv() {
  return {
    DB: {} as unknown as D1Database,
    LINE_CHANNEL_SECRET: "channel-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "channel-token",
    REMIND_TOKEN: "service-token",
  };
}

function configWithProxyService(opts: {
  sendMessages?: boolean | undefined;
  proxyMessagingApi?: boolean;
}) {
  return defineRouterConfig({
    services: [
      {
        id: "remind",
        endpoint: "https://reminder.example.com",
        serviceTokenEnv: "REMIND_TOKEN",
        routing: { role: "handle", commands: ["/remind"] },
        delivery: {
          eventFormat: "line-compatible",
          timing: "sync",
          responseMode: "messaging-api-proxy",
        },
        proxy: { messagingApi: opts.proxyMessagingApi ?? true },
        ...(opts.sendMessages !== undefined
          ? { permissions: { sendMessages: opts.sendMessages } }
          : {}),
      },
    ],
  });
}

function buildPushRequest(token = "service-token") {
  return new Request("https://router.example.com/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      to: "Cgroup",
      messages: [{ type: "text", text: "hi" }],
    }),
  });
}

test("proxy rejects service without explicit sendMessages permission (default-deny)", async () => {
  const storage = new InMemoryStorage();
  // sendMessages is undefined — must NOT pass (parity with handleServiceMessage)
  const config = configWithProxyService({});
  const fetchImpl = async (): Promise<Response> => {
    throw new Error("LINE must not be called when permission is denied");
  };
  const res = await handleMessagingApiProxy({
    request: buildPushRequest(),
    env: buildEnv(),
    config,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(res.status, 403);
});

test("proxy returns 501 for endpoints that v0.1 doesn't implement", async () => {
  const storage = new InMemoryStorage();
  const config = configWithProxyService({ sendMessages: true });
  const fetchImpl = async (): Promise<Response> => {
    throw new Error("LINE must not be called for unsupported endpoints");
  };
  const req = new Request(
    "https://router.example.com/v2/bot/message/multicast",
    {
      method: "POST",
      headers: {
        authorization: `Bearer service-token`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: ["U1"], messages: [{ type: "text", text: "x" }] }),
    },
  );
  const res = await handleMessagingApiProxy({
    request: req,
    env: buildEnv(),
    config,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(res.status, 501);
});

test("proxy forwards X-Line-Retry-Key to LINE and returns LINE response headers", async () => {
  const storage = new InMemoryStorage();
  const config = configWithProxyService({ sendMessages: true });
  let forwardedRetryKey: string | null = null;
  const fetchImpl = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    forwardedRetryKey = headers.get("x-line-retry-key");
    return new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-line-request-id": "req-123",
        "retry-after": "5",
      },
    });
  };
  const req = new Request("https://router.example.com/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer service-token`,
      "content-type": "application/json",
      "x-line-retry-key": "abc-retry-key",
    },
    body: JSON.stringify({
      to: "Cgroup",
      messages: [{ type: "text", text: "hi" }],
    }),
  });
  const res = await handleMessagingApiProxy({
    request: req,
    env: buildEnv(),
    config,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(res.status, 200);
  assert.equal(forwardedRetryKey, "abc-retry-key");
  assert.equal(res.headers.get("x-line-request-id"), "req-123");
  assert.equal(res.headers.get("retry-after"), "5");
});

test("proxy reply does not consume virtual token when LINE forward fails", async () => {
  const storage = new InMemoryStorage();
  const created = await storage.createVirtualReplyToken({
    realReplyToken: "rt_real",
    serviceId: "remind",
    sourceId: "Cgroup",
  });
  const config = configWithProxyService({ sendMessages: true });
  let realTokenForwarded: string | null = null;
  const fetchImpl = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.body) {
      try {
        const body = JSON.parse(init.body as string);
        realTokenForwarded = body.replyToken;
      } catch {
        /* noop */
      }
    }
    // first forward returns 500
    return new Response('{"message":"oops"}', {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
  const req = new Request("https://router.example.com/v2/bot/message/reply", {
    method: "POST",
    headers: {
      authorization: `Bearer service-token`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      replyToken: created.virtualToken,
      messages: [{ type: "text", text: "hi" }],
    }),
  });

  const res = await handleMessagingApiProxy({
    request: req,
    env: buildEnv(),
    config,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(res.status, 500);
  assert.equal(realTokenForwarded, "rt_real", "router forwarded with real token");
  // Token must still be usable for retry, because LINE side never accepted it.
  const peeked = await storage.peekVirtualReplyToken(created.virtualToken, "remind");
  assert.ok(peeked, "virtual token must remain peekable after LINE 5xx");
  assert.equal(peeked?.used, false);
});
