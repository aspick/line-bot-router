export interface LineMessagingApiClientOptions {
  channelAccessToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface LineApiResponse {
  status: number;
  body: string;
  contentType: string;
}

const DEFAULT_BASE_URL = "https://api.line.me";

/**
 * LINE Messaging API への送信を担う薄いラッパ。
 * proxy 経路では、status / body / content-type をそのまま child bot へ返したい。
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
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get("content-type") ?? "application/json",
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

  async push(payload: {
    to: string;
    messages: Array<Record<string, unknown>>;
    notificationDisabled?: boolean;
  }): Promise<LineApiResponse> {
    return this.forward(
      "/v2/bot/message/push",
      JSON.stringify(payload),
      "application/json",
    );
  }
}
