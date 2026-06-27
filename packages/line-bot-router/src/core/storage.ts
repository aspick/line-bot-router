import type {
  ConversationLock,
  CreateVirtualReplyTokenInput,
  NormalizedLineEvent,
  OutboundMessage,
  VirtualReplyToken,
} from "./types.js";

export interface StorageAdapter {
  saveEvent(event: NormalizedLineEvent): Promise<void>;
  hasProcessed(webhookEventId: string): Promise<boolean>;
  markProcessed(webhookEventId: string): Promise<void>;
  getConversationLock(
    sourceId: string,
    userId?: string,
  ): Promise<ConversationLock | null>;
  setConversationLock(lock: ConversationLock): Promise<void>;
  clearConversationLock(sourceId: string, userId?: string): Promise<void>;
  createVirtualReplyToken(
    input: CreateVirtualReplyTokenInput,
  ): Promise<VirtualReplyToken>;
  consumeVirtualReplyToken(
    token: string,
    serviceId: string,
  ): Promise<VirtualReplyToken | null>;
  /**
   * outbound メッセージを記録する。
   * dedupeKey が指定されていて既存と重複した場合は `{ inserted: false }` を返し、
   * 呼び出し側が再送を抑止できるようにする。
   */
  saveOutboundMessage(
    message: OutboundMessage,
  ): Promise<{ inserted: boolean }>;
}

export interface AsyncDispatcher {
  enqueue(delivery: {
    serviceId: string;
    endpoint: string;
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }): Promise<void>;
}

export interface SecretResolver {
  get(name: string): string | undefined;
}
