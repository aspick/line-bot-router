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
import { handleServiceMessage } from "./handleServiceMessage.js";

class InMemoryStorage implements StorageAdapter {
  events: NormalizedLineEvent[] = [];
  processed = new Set<string>();
  locks = new Map<string, ConversationLock>();
  outbound: OutboundMessage[] = [];

  async saveEvent(event: NormalizedLineEvent): Promise<void> {
    this.events.push(event);
  }
  async hasProcessed(id: string): Promise<boolean> {
    return this.processed.has(id);
  }
  async markProcessed(id: string): Promise<void> {
    this.processed.add(id);
  }
  async getConversationLock(): Promise<ConversationLock | null> {
    return null;
  }
  async setConversationLock(lock: ConversationLock): Promise<void> {
    this.locks.set(lock.sourceId, lock);
  }
  async clearConversationLock(): Promise<void> {}
  async createVirtualReplyToken(
    _input: CreateVirtualReplyTokenInput,
  ): Promise<VirtualReplyToken> {
    throw new Error("not used in this test");
  }
  async consumeVirtualReplyToken(): Promise<VirtualReplyToken | null> {
    return null;
  }
  async saveOutboundMessage(
    msg: OutboundMessage,
  ): Promise<{ inserted: boolean }> {
    if (
      msg.dedupeKey &&
      this.outbound.some(
        (o) => o.serviceId === msg.serviceId && o.dedupeKey === msg.dedupeKey,
      )
    ) {
      return { inserted: false };
    }
    this.outbound.push(msg);
    return { inserted: true };
  }
}

function buildEnv() {
  return {
    DB: {} as unknown as D1Database,
    LINE_CHANNEL_SECRET: "channel-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "channel-token",
    ATT_TOKEN: "service-token",
  };
}

function buildConfig() {
  return defineRouterConfig({
    services: [
      {
        id: "att",
        endpoint: "https://attendance.example.com",
        serviceTokenEnv: "ATT_TOKEN",
        routing: { role: "handle", commands: ["/att"] },
        delivery: {
          eventFormat: "router-native",
          timing: "sync",
          responseMode: "http-response",
        },
        permissions: { sendMessages: true },
      },
    ],
  });
}

function buildRequest(body: Record<string, unknown>, token = "service-token") {
  return new Request("https://router.example.com/api/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("/api/messages forwards push when dedupeKey is fresh", async () => {
  const storage = new InMemoryStorage();
  let pushCount = 0;
  const fetchImpl = async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v2/bot/message/push")) {
      pushCount += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const res = await handleServiceMessage({
    request: buildRequest({
      to: { type: "group", id: "Cgroup" },
      messages: [{ type: "text", text: "hi" }],
      dedupeKey: "evt-1",
    }),
    env: buildEnv(),
    config: buildConfig(),
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(res.status, 200);
  assert.equal(pushCount, 1);
  assert.equal(storage.outbound.length, 1);
});

test("/api/messages returns deduped:true on the second call with the same dedupeKey", async () => {
  const storage = new InMemoryStorage();
  let pushCount = 0;
  const fetchImpl = async (
    input: RequestInfo | URL,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v2/bot/message/push")) {
      pushCount += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const env = buildEnv();
  const config = buildConfig();
  const body = {
    to: { type: "group", id: "Cgroup" },
    messages: [{ type: "text", text: "hi" }],
    dedupeKey: "evt-1",
  };

  const first = await handleServiceMessage({
    request: buildRequest(body),
    env,
    config,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const second = await handleServiceMessage({
    request: buildRequest(body),
    env,
    config,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(pushCount, 1, "second push must be suppressed");
  assert.deepEqual(await second.json(), { deduped: true });
});

test("/api/messages without dedupeKey always pushes", async () => {
  const storage = new InMemoryStorage();
  let pushCount = 0;
  const fetchImpl = async (): Promise<Response> => {
    pushCount += 1;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const env = buildEnv();
  const config = buildConfig();
  const body = {
    to: { type: "group", id: "Cgroup" },
    messages: [{ type: "text", text: "hi" }],
  };

  await handleServiceMessage({
    request: buildRequest(body),
    env,
    config,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  await handleServiceMessage({
    request: buildRequest(body),
    env,
    config,
    storage,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(pushCount, 2);
});

test("/api/messages rejects an invalid bearer token", async () => {
  const storage = new InMemoryStorage();
  const res = await handleServiceMessage({
    request: buildRequest(
      {
        to: { type: "group", id: "Cgroup" },
        messages: [{ type: "text", text: "hi" }],
      },
      "wrong-token",
    ),
    env: buildEnv(),
    config: buildConfig(),
    storage,
  });
  assert.equal(res.status, 401);
});
