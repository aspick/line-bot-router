import type {
  ConversationLock,
  CreateVirtualReplyTokenInput,
  NormalizedLineEvent,
  OutboundMessage,
  VirtualReplyToken,
} from "./types.js";

export interface StorageAdapter {
  saveEvent(event: NormalizedLineEvent): Promise<void>;
  /**
   * webhookEventId に対する処理権を atomic に主張する。
   * 新規に行を挿入できたとき true、既に処理済みで挿入されなかったとき false。
   * hasProcessed + markProcessed の 2 step では TOCTOU race を防げないため
   * この単一 atomic API を使うこと。
   */
  claimEvent(webhookEventId: string): Promise<boolean>;
  getConversationLock(
    sourceId: string,
    userId?: string,
  ): Promise<ConversationLock | null>;
  setConversationLock(lock: ConversationLock): Promise<void>;
  clearConversationLock(sourceId: string, userId?: string): Promise<void>;
  createVirtualReplyToken(
    input: CreateVirtualReplyTokenInput,
  ): Promise<VirtualReplyToken>;
  /**
   * virtual token を used フラグを立てずに参照する。
   * 外部 (LINE) 呼び出しが成功する前に token を消費すると、
   * 失敗時に retry できなくなるため、peek → forward → consume の順で使う。
   */
  peekVirtualReplyToken(
    token: string,
    serviceId: string,
  ): Promise<VirtualReplyToken | null>;
  consumeVirtualReplyToken(
    token: string,
    serviceId: string,
  ): Promise<VirtualReplyToken | null>;
  /**
   * dispatch 失敗時のクリーンアップ用に発行済み仮想 token を削除する。
   */
  deleteVirtualReplyToken(virtualToken: string): Promise<void>;
  /**
   * outbound メッセージを記録する。
   * dedupeKey が指定されていて既存と重複した場合は `{ inserted: false }` を返し、
   * 呼び出し側が再送を抑止できるようにする。
   */
  saveOutboundMessage(
    message: OutboundMessage,
  ): Promise<{ inserted: boolean }>;
  /**
   * 失敗時ロールバック用。saveOutboundMessage で確保した dedupe 行を取り消す。
   * dedupeKey が無い場合は実装側で no-op にできる。
   */
  deleteOutboundMessage(serviceId: string, dedupeKey: string): Promise<void>;
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
