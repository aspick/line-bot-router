import { test } from "node:test";
import assert from "node:assert/strict";
import { defineRouterConfig } from "../config/index.js";
import type {
  ConversationLock,
  CreateVirtualReplyTokenInput,
  NormalizedLineEvent,
  OutboundMessage,
  SecretResolver,
  ServiceConfig,
  StorageAdapter,
  VirtualReplyToken,
} from "../core/index.js";
import { VIRTUAL_REPLY_TOKEN_PREFIX } from "../core/index.js";
import { dispatchHandler } from "./dispatch.js";
import { LineMessagingApiClient } from "./lineClient.js";

class InMemoryStorage implements StorageAdapter {
  outbound: OutboundMessage[] = [];
  tokens = new Map<string, VirtualReplyToken>();
  deleted: string[] = [];

  async saveEvent(): Promise<void> {}
  async claimEvent(): Promise<boolean> {
    return true;
  }
  async getConversationLock(): Promise<ConversationLock | null> {
    return null;
  }
  async setConversationLock(): Promise<void> {}
  async clearConversationLock(): Promise<void> {}
  async createVirtualReplyToken(
    input: CreateVirtualReplyTokenInput,
  ): Promise<VirtualReplyToken> {
    const token: VirtualReplyToken = {
      virtualToken: `${VIRTUAL_REPLY_TOKEN_PREFIX}gen`,
      realReplyToken: input.realReplyToken,
      serviceId: input.serviceId,
      sourceId: input.sourceId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      used: false,
    };
    this.tokens.set(token.virtualToken, token);
    return token;
  }
  async peekVirtualReplyToken(): Promise<VirtualReplyToken | null> {
    return null;
  }
  async consumeVirtualReplyToken(): Promise<VirtualReplyToken | null> {
    return null;
  }
  async deleteVirtualReplyToken(virtualToken: string): Promise<void> {
    this.tokens.delete(virtualToken);
    this.deleted.push(virtualToken);
  }
  async saveOutboundMessage(
    msg: OutboundMessage,
  ): Promise<{ inserted: boolean }> {
    this.outbound.push(msg);
    return { inserted: true };
  }
  async deleteOutboundMessage(): Promise<void> {}
}

function makeEvent(replyToken: string | undefined): NormalizedLineEvent {
  const raw = {
    type: "message",
    timestamp: 1,
    source: { type: "group", groupId: "Cgroup", userId: "Uuser" },
    message: { type: "text", id: "1", text: "/x" },
    ...(replyToken ? { replyToken } : {}),
    webhookEventId: "evt_test",
  } as unknown as NormalizedLineEvent["raw"];
  return {
    webhookEventId: "evt_test",
    type: "message",
    timestamp: 1,
    source: { type: "group", groupId: "Cgroup", userId: "Uuser" },
    sourceId: "Cgroup",
    actorUserId: "Uuser",
    ...(replyToken ? { replyToken } : {}),
    raw,
  };
}

const emptySecrets: SecretResolver = { get: () => undefined };

function makeService(over: Partial<ServiceConfig>): ServiceConfig {
  const cfg = defineRouterConfig({
    services: [
      {
        id: "svc",
        endpoint: "https://svc.example.com",
        routing: { role: "handle", commands: ["/x"] },
        delivery: {
          eventFormat: "router-native",
          timing: "sync",
          responseMode: "http-response",
        },
        ...over,
      },
    ],
  });
  return cfg.services[0]!;
}

test("dispatchHandler throws when secretEnv is declared but env is empty (fail-closed)", async () => {
  const storage = new InMemoryStorage();
  const service = makeService({ secretEnv: "MISSING_SECRET" });
  let childFetched = false;
  const fetchImpl = async (): Promise<Response> => {
    childFetched = true;
    return new Response("{}", { status: 200 });
  };
  const lineClient = new LineMessagingApiClient({
    channelAccessToken: "tk",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  await assert.rejects(
    dispatchHandler({
      service,
      event: makeEvent("rt_real"),
      destination: "dest",
      matchedBy: "command",
      command: "/x",
      secrets: emptySecrets,
      storage,
      lineClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
    /secretEnv MISSING_SECRET is declared/,
  );
  assert.equal(childFetched, false, "child must not be fetched without signature");
});

test("dispatchHandler cleans up virtual reply token when secret is missing", async () => {
  const storage = new InMemoryStorage();
  const service = makeService({
    secretEnv: "MISSING_SECRET",
    delivery: {
      eventFormat: "line-compatible",
      timing: "sync",
      responseMode: "messaging-api-proxy",
    },
    proxy: { messagingApi: true },
    permissions: { sendMessages: true },
  });
  const fetchImpl = async (): Promise<Response> =>
    new Response("{}", { status: 200 });
  const lineClient = new LineMessagingApiClient({
    channelAccessToken: "tk",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  await assert.rejects(
    dispatchHandler({
      service,
      event: makeEvent("rt_real"),
      destination: "dest",
      matchedBy: "command",
      command: "/x",
      secrets: emptySecrets,
      storage,
      lineClient,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );
  assert.equal(storage.tokens.size, 0, "leaked virtual token row");
  assert.deepEqual(storage.deleted, [`${VIRTUAL_REPLY_TOKEN_PREFIX}gen`]);
});

test("dispatchHandler cleans up virtual reply token when child fetch fails", async () => {
  const storage = new InMemoryStorage();
  const service = makeService({
    delivery: {
      eventFormat: "line-compatible",
      timing: "sync",
      responseMode: "messaging-api-proxy",
    },
    proxy: { messagingApi: true },
    permissions: { sendMessages: true },
  });
  const fetchImpl = async (): Promise<Response> => {
    throw new Error("network down");
  };
  const lineClient = new LineMessagingApiClient({
    channelAccessToken: "tk",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const result = await dispatchHandler({
    service,
    event: makeEvent("rt_real"),
    destination: "dest",
    matchedBy: "command",
    command: "/x",
    secrets: emptySecrets,
    storage,
    lineClient,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(result.routerReplied, false);
  assert.equal(storage.tokens.size, 0);
  assert.deepEqual(storage.deleted, [`${VIRTUAL_REPLY_TOKEN_PREFIX}gen`]);
});

test("dispatchHandler refuses to call LINE reply when service lacks sendMessages permission", async () => {
  const storage = new InMemoryStorage();
  // permissions.sendMessages not set → default-deny on http-response reply path
  const service = makeService({});
  const childResponse = JSON.stringify({
    reply: { messages: [{ type: "text", text: "hello" }] },
  });
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://svc.example.com") {
      return new Response(childResponse, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`LINE reply must not be called for service without sendMessages: ${url}`);
  };
  const lineClient = new LineMessagingApiClient({
    channelAccessToken: "tk",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const result = await dispatchHandler({
    service,
    event: makeEvent("rt_real"),
    destination: "dest",
    matchedBy: "command",
    command: "/x",
    secrets: emptySecrets,
    storage,
    lineClient,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(result.routerReplied, false);
  assert.equal(storage.outbound.length, 0);
});

test("dispatchHandler calls LINE reply when service has sendMessages permission", async () => {
  const storage = new InMemoryStorage();
  const service = makeService({ permissions: { sendMessages: true } });
  const childResponse = JSON.stringify({
    reply: { messages: [{ type: "text", text: "hello" }] },
  });
  let lineReplyCalled = false;
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://svc.example.com") {
      return new Response(childResponse, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v2/bot/message/reply")) {
      lineReplyCalled = true;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const lineClient = new LineMessagingApiClient({
    channelAccessToken: "tk",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const result = await dispatchHandler({
    service,
    event: makeEvent("rt_real"),
    destination: "dest",
    matchedBy: "command",
    command: "/x",
    secrets: emptySecrets,
    storage,
    lineClient,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(result.routerReplied, true);
  assert.equal(lineReplyCalled, true);
});
