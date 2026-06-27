import type { RouterConfig, ServiceConfig } from "../config/schema.js";

export type { RouterConfig, ServiceConfig };

export type LineSourceType = "user" | "group" | "room";

export interface LineSource {
  type: LineSourceType;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineMessageBase {
  id: string;
  type: string;
}

export interface LineTextMessage extends LineMessageBase {
  type: "text";
  text: string;
  mention?: {
    mentionees: Array<{
      index: number;
      length: number;
      userId?: string;
      type?: "user" | "all";
    }>;
  };
}

export type LineMessage = LineTextMessage | (LineMessageBase & { type: string });

export interface LineEventCommon {
  type: string;
  timestamp: number;
  webhookEventId: string;
  source: LineSource;
  replyToken?: string;
  mode?: string;
}

export interface LineMessageEvent extends LineEventCommon {
  type: "message";
  message: LineMessage;
}

export interface LinePostbackEvent extends LineEventCommon {
  type: "postback";
  postback: {
    data: string;
    params?: Record<string, string>;
  };
}

export type LineEvent =
  | LineMessageEvent
  | LinePostbackEvent
  | (LineEventCommon & { type: string });

export interface LineWebhookPayload {
  destination: string;
  events: LineEvent[];
}

export interface NormalizedLineEvent {
  webhookEventId: string;
  type: string;
  timestamp: number;
  source: LineSource;
  sourceId: string;
  actorUserId?: string;
  replyToken?: string;
  raw: LineEvent;
}

export interface ConversationLock {
  sourceId: string;
  userId?: string;
  serviceId: string;
  state?: string;
  expiresAt: string;
}

export interface VirtualReplyToken {
  virtualToken: string;
  realReplyToken: string;
  serviceId: string;
  sourceId: string;
  expiresAt: string;
  used: boolean;
}

export interface CreateVirtualReplyTokenInput {
  realReplyToken: string;
  serviceId: string;
  sourceId: string;
  ttlSeconds?: number;
}

export type RoutingMatchType =
  | "conversation-lock"
  | "postback-namespace"
  | "command"
  | "mention"
  | "regex"
  | "fallback";

export interface RoutingDecision {
  observers: ServiceConfig[];
  handler:
    | {
        service: ServiceConfig;
        matchedBy: RoutingMatchType;
        command?: string;
      }
    | null;
}

export interface OutboundMessage {
  serviceId: string;
  sourceId: string;
  kind: "reply" | "push" | "multicast";
  dedupeKey?: string;
  createdAt: string;
}

export interface ServiceDelivery {
  service: ServiceConfig;
  payload: unknown;
  signatureHeader?: string;
  contentType: string;
  rawBody: string;
}

export interface ReplyProposal {
  priority?: number;
  messages: Array<Record<string, unknown>>;
}

export interface ServiceResponseBody {
  reply?: ReplyProposal;
  push?: ReplyProposal;
}
