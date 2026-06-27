import {
  DEFAULT_VIRTUAL_REPLY_TOKEN_TTL_SECONDS,
  createVirtualReplyTokenValue,
  type ConversationLock,
  type CreateVirtualReplyTokenInput,
  type NormalizedLineEvent,
  type OutboundMessage,
  type StorageAdapter,
  type VirtualReplyToken,
} from "../core/index.js";

export class D1Storage implements StorageAdapter {
  constructor(private readonly db: D1Database) {}

  async saveEvent(event: NormalizedLineEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO line_events
          (webhook_event_id, event_type, source_id, actor_user_id, reply_token, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.webhookEventId,
        event.type,
        event.sourceId,
        event.actorUserId ?? null,
        event.replyToken ?? null,
        JSON.stringify(event.raw),
        new Date(event.timestamp).toISOString(),
      )
      .run();
  }

  async hasProcessed(webhookEventId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 FROM processed_events WHERE webhook_event_id = ?`)
      .bind(webhookEventId)
      .first();
    return row !== null;
  }

  async markProcessed(webhookEventId: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_events (webhook_event_id, processed_at)
         VALUES (?, ?)`,
      )
      .bind(webhookEventId, new Date().toISOString())
      .run();
  }

  async getConversationLock(
    sourceId: string,
    userId?: string,
  ): Promise<ConversationLock | null> {
    const row = await this.db
      .prepare(
        `SELECT source_id, user_id, service_id, state, expires_at
         FROM conversation_locks
         WHERE source_id = ? AND user_id = ?
           AND expires_at > ?`,
      )
      .bind(sourceId, userId ?? "", new Date().toISOString())
      .first<{
        source_id: string;
        user_id: string;
        service_id: string;
        state: string | null;
        expires_at: string;
      }>();

    if (!row) return null;
    return {
      sourceId: row.source_id,
      userId: row.user_id || undefined,
      serviceId: row.service_id,
      state: row.state ?? undefined,
      expiresAt: row.expires_at,
    };
  }

  async setConversationLock(lock: ConversationLock): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO conversation_locks
            (source_id, user_id, service_id, state, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source_id, user_id)
         DO UPDATE SET service_id=excluded.service_id,
                       state=excluded.state,
                       expires_at=excluded.expires_at`,
      )
      .bind(
        lock.sourceId,
        lock.userId ?? "",
        lock.serviceId,
        lock.state ?? null,
        lock.expiresAt,
      )
      .run();
  }

  async clearConversationLock(sourceId: string, userId?: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM conversation_locks WHERE source_id = ? AND user_id = ?`,
      )
      .bind(sourceId, userId ?? "")
      .run();
  }

  async createVirtualReplyToken(
    input: CreateVirtualReplyTokenInput,
  ): Promise<VirtualReplyToken> {
    const ttl = input.ttlSeconds ?? DEFAULT_VIRTUAL_REPLY_TOKEN_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const virtualToken = createVirtualReplyTokenValue();
    await this.db
      .prepare(
        `INSERT INTO virtual_reply_tokens
          (virtual_token, real_reply_token, service_id, source_id, expires_at, used, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(
        virtualToken,
        input.realReplyToken,
        input.serviceId,
        input.sourceId,
        expiresAt,
        new Date().toISOString(),
      )
      .run();
    return {
      virtualToken,
      realReplyToken: input.realReplyToken,
      serviceId: input.serviceId,
      sourceId: input.sourceId,
      expiresAt,
      used: false,
    };
  }

  async consumeVirtualReplyToken(
    token: string,
    serviceId: string,
  ): Promise<VirtualReplyToken | null> {
    const now = new Date().toISOString();
    const row = await this.db
      .prepare(
        `SELECT virtual_token, real_reply_token, service_id, source_id, expires_at, used
         FROM virtual_reply_tokens
         WHERE virtual_token = ?`,
      )
      .bind(token)
      .first<{
        virtual_token: string;
        real_reply_token: string;
        service_id: string;
        source_id: string;
        expires_at: string;
        used: number;
      }>();
    if (!row) return null;
    if (row.service_id !== serviceId) return null;
    if (row.used) return null;
    if (row.expires_at <= now) return null;

    const update = await this.db
      .prepare(
        `UPDATE virtual_reply_tokens
            SET used = 1
          WHERE virtual_token = ? AND used = 0`,
      )
      .bind(token)
      .run();
    if (!update.success || (update.meta?.changes ?? 0) === 0) return null;

    return {
      virtualToken: row.virtual_token,
      realReplyToken: row.real_reply_token,
      serviceId: row.service_id,
      sourceId: row.source_id,
      expiresAt: row.expires_at,
      used: true,
    };
  }

  async saveOutboundMessage(
    message: OutboundMessage,
  ): Promise<{ inserted: boolean }> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO outbound_messages
          (service_id, source_id, kind, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        message.serviceId,
        message.sourceId,
        message.kind,
        message.dedupeKey ?? null,
        message.createdAt,
      )
      .run();
    const changes = Number(result.meta?.changes ?? 0);
    return { inserted: changes > 0 };
  }
}
