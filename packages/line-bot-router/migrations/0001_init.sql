-- LINE Bot Router 初期 schema (Cloudflare D1)
-- すべて UTC ISO8601 文字列で expires_at / received_at / created_at を表現する。

CREATE TABLE IF NOT EXISTS line_events (
  webhook_event_id TEXT PRIMARY KEY,
  event_type       TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  actor_user_id    TEXT,
  reply_token      TEXT,
  payload          TEXT NOT NULL,
  received_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_events_source_received
  ON line_events (source_id, received_at);

CREATE TABLE IF NOT EXISTS processed_events (
  webhook_event_id TEXT PRIMARY KEY,
  processed_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_locks (
  source_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL DEFAULT '',
  service_id  TEXT NOT NULL,
  state       TEXT,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (source_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_locks_expires
  ON conversation_locks (expires_at);

CREATE TABLE IF NOT EXISTS virtual_reply_tokens (
  virtual_token    TEXT PRIMARY KEY,
  real_reply_token TEXT NOT NULL,
  service_id       TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  used             INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_virtual_reply_tokens_expires
  ON virtual_reply_tokens (expires_at);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id   TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  dedupe_key   TEXT,
  created_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_outbound_messages_dedupe
  ON outbound_messages (service_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
