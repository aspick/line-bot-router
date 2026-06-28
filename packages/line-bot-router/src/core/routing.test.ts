import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRouting } from "./routing.js";
import type {
  ConversationLock,
  LineEvent,
  NormalizedLineEvent,
} from "./types.js";
import { RouterConfigSchema, type RouterConfig } from "../config/schema.js";

const baseDeliveryRouterNative = {
  eventFormat: "router-native" as const,
  timing: "sync" as const,
  responseMode: "http-response" as const,
};

const baseDeliveryObserve = {
  eventFormat: "line-compatible" as const,
  timing: "async" as const,
  responseMode: "none" as const,
};

function makeConfig(services: RouterConfig["services"]): RouterConfig {
  // routing.test.ts は decideRouting の挙動だけを試す。schema の
  // 「http-response / messaging-api-proxy → sendMessages:true 必須」 validate を満たすため、
  // handle / fallback role の service には permissions.sendMessages: true を補完する。
  const enriched = services.map((s) => {
    const needsSend =
      (s.routing.role === "handle" || s.routing.role === "fallback") &&
      !s.permissions;
    return needsSend ? { ...s, permissions: { sendMessages: true } } : s;
  });
  return RouterConfigSchema.parse({
    services: enriched,
  });
}

function makeTextEvent(text: string): NormalizedLineEvent {
  const raw = {
    type: "message",
    timestamp: 1,
    source: { type: "group", groupId: "Cgroup", userId: "Uuser" },
    message: { type: "text", id: "1", text },
    replyToken: "rt_real",
    webhookEventId: "evt_text",
  } as unknown as LineEvent;
  return {
    webhookEventId: "evt_text",
    type: "message",
    timestamp: 1,
    source: { type: "group", groupId: "Cgroup", userId: "Uuser" },
    sourceId: "Cgroup",
    actorUserId: "Uuser",
    replyToken: "rt_real",
    raw,
  };
}

function makePostbackEvent(data: string): NormalizedLineEvent {
  const raw = {
    type: "postback",
    timestamp: 1,
    source: { type: "group", groupId: "Cgroup", userId: "Uuser" },
    postback: { data },
    webhookEventId: "evt_postback",
  } as unknown as LineEvent;
  return {
    webhookEventId: "evt_postback",
    type: "postback",
    timestamp: 1,
    source: { type: "group", groupId: "Cgroup", userId: "Uuser" },
    sourceId: "Cgroup",
    actorUserId: "Uuser",
    raw,
  };
}

test("observer with events:['*'] receives all event types", () => {
  const config = makeConfig([
    {
      id: "archive",
      endpoint: "https://example.com",
      routing: { role: "observe", events: ["*"] },
      delivery: baseDeliveryObserve,
    },
  ]);
  const event = makeTextEvent("hello");
  const decision = decideRouting({ event, config });
  assert.equal(decision.observers.length, 1);
  assert.equal(decision.observers[0]!.id, "archive");
  assert.equal(decision.handler, null);
});

test("conversation lock wins over command match", () => {
  const config = makeConfig([
    {
      id: "payment",
      endpoint: "https://payment.example.com",
      routing: { role: "handle", commands: ["/pay"] },
      delivery: baseDeliveryRouterNative,
    },
    {
      id: "attendance",
      endpoint: "https://attendance.example.com",
      routing: { role: "handle", commands: ["/att"] },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const event = makeTextEvent("/att 7/3");
  const lock: ConversationLock = {
    sourceId: "Cgroup",
    userId: "Uuser",
    serviceId: "payment",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const decision = decideRouting({ event, config, conversationLock: lock });
  assert.equal(decision.handler?.service.id, "payment");
  assert.equal(decision.handler?.matchedBy, "conversation-lock");
});

test("postback namespace wins over command match", () => {
  const config = makeConfig([
    {
      id: "payment",
      endpoint: "https://payment.example.com",
      routing: { role: "handle", postbackNamespace: "payment" },
      delivery: baseDeliveryRouterNative,
    },
    {
      id: "attendance",
      endpoint: "https://attendance.example.com",
      routing: { role: "handle", commands: ["/att"] },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const event = makePostbackEvent("payment:invoice:42");
  const decision = decideRouting({ event, config });
  assert.equal(decision.handler?.service.id, "payment");
  assert.equal(decision.handler?.matchedBy, "postback-namespace");
});

test("command match returns the handler with the command name", () => {
  const config = makeConfig([
    {
      id: "attendance",
      endpoint: "https://attendance.example.com",
      routing: { role: "handle", commands: ["/att", "出欠:"] },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const decision = decideRouting({
    event: makeTextEvent("/att 7/3 練習"),
    config,
  });
  assert.equal(decision.handler?.matchedBy, "command");
  assert.equal(decision.handler?.command, "/att");
});

test("colon-suffix command matches even when content follows directly", () => {
  const config = makeConfig([
    {
      id: "attendance",
      endpoint: "https://attendance.example.com",
      routing: { role: "handle", commands: ["出欠:"] },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const decision = decideRouting({
    event: makeTextEvent("出欠:7/3 練習"),
    config,
  });
  assert.equal(decision.handler?.matchedBy, "command");
  assert.equal(decision.handler?.command, "出欠:");
});

test("slash command does not match a longer command without word boundary", () => {
  const config = makeConfig([
    {
      id: "att",
      endpoint: "https://attendance.example.com",
      routing: { role: "handle", commands: ["/att"] },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const decision = decideRouting({
    event: makeTextEvent("/attendance 7/3"),
    config,
  });
  assert.equal(decision.handler, null);
});

test("mention match works when no command matches", () => {
  const config = makeConfig([
    {
      id: "attendance",
      endpoint: "https://attendance.example.com",
      routing: { role: "handle", mentions: ["出欠bot"] },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const decision = decideRouting({
    event: makeTextEvent("@出欠bot 出欠とって"),
    config,
  });
  assert.equal(decision.handler?.matchedBy, "mention");
});

test("regex match works when no command/mention matches", () => {
  const config = makeConfig([
    {
      id: "reminder",
      endpoint: "https://reminder.example.com",
      routing: { role: "handle", regex: ["^明日.*忘れない"] },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const decision = decideRouting({
    event: makeTextEvent("明日 8時 忘れないで"),
    config,
  });
  assert.equal(decision.handler?.matchedBy, "regex");
});

test("regex match returns no match when text exceeds the length cap (preserves anchored semantics)", () => {
  // ^a+$ would *match* a truncated prefix of 256 'a's, but the full text includes a '!'
  // at the end that disqualifies it. Truncate-and-match would dispatch to the wrong handler.
  const config = makeConfig([
    {
      id: "all-a",
      endpoint: "https://example.com",
      routing: { role: "handle", regex: ["^a+$"] },
      delivery: baseDeliveryRouterNative,
    },
    {
      id: "fallback",
      endpoint: "https://fallback.example.com",
      routing: { role: "fallback" },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const overLimit = "a".repeat(300) + "!";
  const decision = decideRouting({
    event: makeTextEvent(overLimit),
    config,
  });
  // Must fall through to fallback, NOT match ^a+$ via a truncated prefix.
  assert.equal(decision.handler?.service.id, "fallback");
  assert.equal(decision.handler?.matchedBy, "fallback");
});

test("falls back to role:fallback when nothing else matched", () => {
  const config = makeConfig([
    {
      id: "echo",
      endpoint: "https://echo.example.com",
      routing: { role: "fallback" },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const decision = decideRouting({
    event: makeTextEvent("hello"),
    config,
  });
  assert.equal(decision.handler?.service.id, "echo");
  assert.equal(decision.handler?.matchedBy, "fallback");
});

test("returns no handler when nothing matches and no fallback exists", () => {
  const config = makeConfig([
    {
      id: "attendance",
      endpoint: "https://attendance.example.com",
      routing: { role: "handle", commands: ["/att"] },
      delivery: baseDeliveryRouterNative,
    },
  ]);
  const decision = decideRouting({
    event: makeTextEvent("hello"),
    config,
  });
  assert.equal(decision.handler, null);
});

test("group.enabledServices restricts both observer and handler", () => {
  const event = makeTextEvent("/att");
  const config = makeConfig([
    {
      id: "attendance",
      endpoint: "https://attendance.example.com",
      routing: { role: "handle", commands: ["/att"] },
      delivery: baseDeliveryRouterNative,
    },
    {
      id: "archive",
      endpoint: "https://archive.example.com",
      routing: { role: "observe", events: ["*"] },
      delivery: baseDeliveryObserve,
    },
  ]);
  const configWithGroup: RouterConfig = {
    ...config,
    groups: [{ id: "Cgroup", enabledServices: ["archive"] }],
  };
  const decision = decideRouting({ event, config: configWithGroup });
  assert.equal(decision.handler, null);
  assert.deepEqual(
    decision.observers.map((s) => s.id),
    ["archive"],
  );
});
