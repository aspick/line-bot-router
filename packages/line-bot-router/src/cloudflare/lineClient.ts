export interface LineMessagingApiClientOptions {
  channelAccessToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface LineApiResponse {
  status: number;
  body: string;
  contentType: string;
  /**
   * child bot へそのまま返したい LINE 由来のヘッダ
   * (`x-line-request-id`, `retry-after`, `x-line-accepted-request-id` など)。
   * すべて小文字キーで保持する。
   */
  passthroughHeaders: Record<string, string>;
}

const DEFAULT_BASE_URL = "https://api.line.me";

const PASSTHROUGH_RESPONSE_HEADERS = [
  "x-line-request-id",
  "x-line-accepted-request-id",
  "retry-after",
] as const;

/**
 * LINE Messaging API への送信を担う薄いラッパ。
 * proxy 経路では、status / body / content-type / 主要ヘッダをそのまま child bot へ返したい。
 */
export class LineMessagingApiClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LineMessagingApiClientOptions) {
    this.token = opts.channelAccessToken;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  async forward(
    path: string,
    body: string,
    contentType: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<LineApiResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": contentType,
        ...extraHeaders,
      },
      body,
    });
    const passthroughHeaders: Record<string, string> = {};
    for (const key of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = res.headers.get(key);
      if (value !== null) passthroughHeaders[key] = value;
    }
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get("content-type") ?? "application/json",
      passthroughHeaders,
    };
  }

  async reply(payload: {
    replyToken: string;
    messages: Array<Record<string, unknown>>;
    notificationDisabled?: boolean;
  }): Promise<LineApiResponse> {
    return this.forward(
      "/v2/bot/message/reply",
      JSON.stringify(payload),
      "application/json",
    );
  }

  async push(
    payload: {
      to: string;
      messages: Array<Record<string, unknown>>;
      notificationDisabled?: boolean;
    },
    options: { retryKey?: string } = {},
  ): Promise<LineApiResponse> {
    const extraHeaders: Record<string, string> = {};
    if (options.retryKey) {
      extraHeaders["x-line-retry-key"] = options.retryKey;
    }
    return this.forward(
      "/v2/bot/message/push",
      JSON.stringify(payload),
      "application/json",
      extraHeaders,
    );
  }
}

/**
 * `(serviceId, dedupeKey)` から決定論的に UUIDv4 形式の retry key を生成する。
 * SHA-256 の先頭 16 byte を取り、v4 / variant のビットを差し替えて UUIDv4 仕様に揃える。
 * 同じ入力からは同じ retry key が出るので、retry したときに LINE が deduplicate してくれる。
 */
export async function deriveLineRetryKey(
  serviceId: string,
  dedupeKey: string,
): Promise<string> {
  const data = new TextEncoder().encode(
    `line-bot-router:retry:${serviceId}|${dedupeKey}`,
  );
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hashBuffer, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
