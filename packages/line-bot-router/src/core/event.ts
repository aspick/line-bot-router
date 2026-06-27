import type {
  LineEvent,
  LineSource,
  NormalizedLineEvent,
} from "./types.js";

export function computeSourceId(source: LineSource): string {
  if (source.type === "group" && source.groupId) return source.groupId;
  if (source.type === "room" && source.roomId) return source.roomId;
  if (source.userId) return source.userId;
  return "unknown";
}

export function normalizeEvent(
  event: LineEvent & { webhookEventId?: string },
): NormalizedLineEvent {
  const webhookEventId =
    event.webhookEventId ??
    `evt_unknown_${event.timestamp}_${Math.floor(Math.random() * 1e9)}`;
  return {
    webhookEventId,
    type: event.type,
    timestamp: event.timestamp,
    source: event.source,
    sourceId: computeSourceId(event.source),
    actorUserId: event.source.userId,
    replyToken: event.replyToken,
    raw: event,
  };
}
