import type {
  NormalizedLineEvent,
  RoutingMatchType,
  ServiceConfig,
} from "./types.js";

export interface BuildServicePayloadInput {
  service: ServiceConfig;
  event: NormalizedLineEvent;
  destination: string;
  deliveryType: "observe" | "handle";
  routing?: {
    matchedBy: RoutingMatchType;
    command?: string;
  };
  virtualReplyToken?: string;
  actor?: {
    userId?: string;
    displayName?: string;
  };
}

export function buildServicePayload(input: BuildServicePayloadInput): unknown {
  const format = input.service.delivery.eventFormat;

  if (format === "router-native") {
    return buildRouterNativePayload(input);
  }

  if (format === "line-compatible" || format === "raw-line") {
    return buildLineCompatiblePayload(input);
  }

  return buildRouterNativePayload(input);
}

function buildRouterNativePayload(input: BuildServicePayloadInput) {
  const sendsEnabled = input.service.permissions?.sendMessages === true;
  const canReply = input.deliveryType === "handle" && sendsEnabled;
  const canPush = sendsEnabled;
  return {
    eventId: input.event.webhookEventId,
    deliveryType: input.deliveryType,
    source: {
      type: input.event.source.type,
      id: input.event.sourceId,
    },
    actor: {
      userId: input.actor?.userId ?? input.event.actorUserId,
      displayName: input.actor?.displayName,
    },
    event: stripLineRawShape(input.event.raw as unknown as Record<string, unknown>),
    routing: input.routing
      ? {
          matchedBy: input.routing.matchedBy,
          ...(input.routing.command ? { command: input.routing.command } : {}),
        }
      : undefined,
    capabilities: {
      canReply,
      canPush,
    },
  };
}

function buildLineCompatiblePayload(input: BuildServicePayloadInput) {
  const rawEvent: Record<string, unknown> = { ...input.event.raw };

  if (input.deliveryType === "observe") {
    delete rawEvent.replyToken;
  } else if (input.virtualReplyToken) {
    rawEvent.replyToken = input.virtualReplyToken;
  } else {
    delete rawEvent.replyToken;
  }

  return {
    destination: input.destination,
    events: [rawEvent],
  };
}

function stripLineRawShape(raw: Record<string, unknown>) {
  const shaped: Record<string, unknown> = {
    type: raw.type,
  };
  if (raw.message !== undefined) shaped.message = raw.message;
  if (raw.postback !== undefined) shaped.postback = raw.postback;
  if (raw.joined !== undefined) shaped.joined = raw.joined;
  if (raw.left !== undefined) shaped.left = raw.left;
  return shaped;
}
