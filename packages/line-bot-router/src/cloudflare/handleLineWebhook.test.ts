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
import { handleLineWebhook } from "./handleLineWebhook.js";
import { signChildBotPayload } from "../core/signature.js";

class RecordingStorage implements StorageAdapter {
  saved: NormalizedLineEvent[] = [];
  claimed: string[] = [];
  ops: string[] = [];
  saveEventShouldFail = false;

  async saveEvent(event: NormalizedLineEvent): Promise<void> {
    this.ops.push("saveEvent");
    if (this.saveEventShouldFail) {
      throw new Error("saveEvent failed");
    }
    this.saved.push(event);
  }
  async claimEvent(id: string): Promise<boolean> {
    this.ops.push("claimEvent");
    if (this.claimed.includes(id)) return false;
    this.claimed.push(id);
    return true;
  }
  async getConversationLock(): Promise<ConversationLock | null> {
    return null;
  }
  async setConversationLock(): Promise<void> {}
  async clearConversationLock(): Promise<void> {}
  async createVirtualReplyToken(
    _input: CreateVirtualReplyTokenInput,
  ): Promise<VirtualReplyToken> {
    throw new Error("not used");
  }
  async peekVirtualReplyToken(): Promise<VirtualReplyToken | null> {
    return null;
  }
  async consumeVirtualReplyToken(): Promise<VirtualReplyToken | null> {
    return null;
  }
  async deleteVirtualReplyToken(): Promise<void> {}
  async saveOutboundMessage(
    _msg: OutboundMessage,
  ): Promise<{ inserted: boolean }> {
    return { inserted: true };
  }
  async deleteOutboundMessage(): Promise<void> {}
}

async function buildSignedRequest(payload: unknown, secret: string) {
  const body = JSON.stringify(payload);
  const sig = await signChildBotPayload(secret, body);
  return new Request("https://router.example.com/line/webhook", {
    method: "POST",
    headers: {
      "x-line-signature": sig,
      "content-type": "application/json",
    },
    body,
  });
}

function buildPayload(eventId: string) {
  return {
    destination: "Ubot",
    events: [
      {
        type: "message",
        timestamp: 1,
        source: { type: "user", userId: "Uuser" },
        message: { id: "1", type: "text", text: "hello" },
        replyToken: "rt_real",
        webhookEventId: eventId,
        mode: "active",
      },
    ],
  };
}

function buildEnv() {
  return {
    DB: {} as unknown as D1Database,
    LINE_CHANNEL_SECRET: "channel-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "channel-token",
  };
}

function buildConfig() {
  return defineRouterConfig({
    services: [],
  });
}

const ctx = { waitUntil: (_p: Promise<unknown>) => {} };

test("processSingleEvent saves event before claiming (so saveEvent failures are retryable)", async () => {
  const storage = new RecordingStorage();
  const env = buildEnv();
  const req = await buildSignedRequest(
    buildPayload("evt-order"),
    env.LINE_CHANNEL_SECRET,
  );

  const res = await handleLineWebhook({
    request: req,
    env,
    ctx,
    config: buildConfig(),
    storage,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(
    storage.ops,
    ["saveEvent", "claimEvent"],
    "saveEvent must run before claimEvent so D1 saveEvent failures don't strand the event",
  );
  assert.equal(storage.saved.length, 1);
  assert.deepEqual(storage.claimed, ["evt-order"]);
});

test("when saveEvent fails, no claim row is written so the LINE retry can recover", async () => {
  const storage = new RecordingStorage();
  storage.saveEventShouldFail = true;
  const env = buildEnv();
  const req = await buildSignedRequest(
    buildPayload("evt-retry"),
    env.LINE_CHANNEL_SECRET,
  );

  const res = await handleLineWebhook({
    request: req,
    env,
    ctx,
    config: buildConfig(),
    storage,
  });

  // outer for-loop catches the throw, webhook still returns 200 to LINE so LINE retries
  assert.equal(res.status, 200);
  assert.deepEqual(storage.claimed, [], "claim must not be written when saveEvent failed");
  assert.deepEqual(storage.ops, ["saveEvent"], "claimEvent must not have been called");

  // Retry with healed storage: must process this event, not silently drop it.
  storage.saveEventShouldFail = false;
  const retryReq = await buildSignedRequest(
    buildPayload("evt-retry"),
    env.LINE_CHANNEL_SECRET,
  );
  const retryRes = await handleLineWebhook({
    request: retryReq,
    env,
    ctx,
    config: buildConfig(),
    storage,
  });

  assert.equal(retryRes.status, 200);
  assert.deepEqual(storage.claimed, ["evt-retry"], "retry must successfully claim");
  assert.equal(storage.saved.length, 1);
});

test("processSingleEvent skips a second delivery of the same webhookEventId", async () => {
  const storage = new RecordingStorage();
  const env = buildEnv();
  const req1 = await buildSignedRequest(
    buildPayload("evt-dup"),
    env.LINE_CHANNEL_SECRET,
  );
  const req2 = await buildSignedRequest(
    buildPayload("evt-dup"),
    env.LINE_CHANNEL_SECRET,
  );

  await handleLineWebhook({
    request: req1,
    env,
    ctx,
    config: buildConfig(),
    storage,
  });
  const opsAfterFirst = [...storage.ops];

  await handleLineWebhook({
    request: req2,
    env,
    ctx,
    config: buildConfig(),
    storage,
  });

  // saveEvent runs both times (idempotent at the D1 layer via INSERT OR IGNORE), but
  // claimEvent returns false on the second call so the rest of the pipeline is skipped.
  assert.deepEqual(opsAfterFirst, ["saveEvent", "claimEvent"]);
  assert.deepEqual(storage.ops, [
    "saveEvent",
    "claimEvent",
    "saveEvent",
    "claimEvent",
  ]);
  assert.equal(storage.claimed.length, 1, "only first delivery claims");
});
