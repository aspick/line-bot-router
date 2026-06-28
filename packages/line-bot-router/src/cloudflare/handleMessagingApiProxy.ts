import {
  isVirtualReplyToken,
  type RouterConfig,
  type ServiceConfig,
  type StorageAdapter,
} from "../core/index.js";
import { D1Storage } from "./d1Storage.js";
import { envSecretResolver, type BaseEnv } from "./env.js";
import { LineMessagingApiClient } from "./lineClient.js";

export interface HandleMessagingApiProxyInput<TEnv extends BaseEnv = BaseEnv> {
  request: Request;
  env: TEnv;
  config: RouterConfig;
  storage?: StorageAdapter;
  fetchImpl?: typeof fetch;
}

type ProxyResult = Response;

function jsonError(status: number, message: string, details?: unknown): Response {
  return new Response(
    JSON.stringify(details ? { message, details } : { message }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

function passthrough(res: {
  status: number;
  body: string;
  contentType: string;
  passthroughHeaders: Record<string, string>;
}): Response {
  const headers = new Headers({ "content-type": res.contentType });
  for (const [name, value] of Object.entries(res.passthroughHeaders)) {
    headers.set(name, value);
  }
  return new Response(res.body, {
    status: res.status,
    headers,
  });
}

const FORWARDED_REQUEST_HEADERS = ["x-line-retry-key"] as const;

function pickForwardedHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() : null;
}

function findServiceByToken(
  config: RouterConfig,
  secrets: ReturnType<typeof envSecretResolver>,
  token: string,
): ServiceConfig | null {
  for (const s of config.services) {
    if (!s.serviceTokenEnv) continue;
    const expected = secrets.get(s.serviceTokenEnv);
    if (expected && constantTimeEqualString(expected, token)) return s;
  }
  return null;
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAllowedGroupForService(
  service: ServiceConfig,
  config: RouterConfig,
  targetId: string,
): boolean {
  if (
    service.permissions?.allowedGroupIds &&
    !service.permissions.allowedGroupIds.includes(targetId)
  ) {
    return false;
  }
  const group = config.groups?.find((g) => g.id === targetId);
  if (group?.enabledServices) {
    return group.enabledServices.includes(service.id);
  }
  return true;
}

export async function handleMessagingApiProxy<
  TEnv extends BaseEnv = BaseEnv,
>(input: HandleMessagingApiProxyInput<TEnv>): Promise<ProxyResult> {
  const url = new URL(input.request.url);
  const path = url.pathname;

  const token = extractBearer(input.request);
  if (!token) return jsonError(401, "missing bearer token");

  const secrets = envSecretResolver(input.env);
  const service = findServiceByToken(input.config, secrets, token);
  if (!service) return jsonError(401, "invalid service token");
  // handleServiceMessage と同じく default-deny。permissions.sendMessages を明示的に true にした
  // service のみ送信を許可する。undefined を default-allow にすると、handleServiceMessage 経由では
  // 403 で弾かれる service が proxy 経由でだけ通り抜けてしまう不整合を生むため統一する。
  if (service.permissions?.sendMessages !== true) {
    return jsonError(403, "service is not allowed to send messages");
  }
  if (!service.proxy?.messagingApi) {
    return jsonError(403, "service does not have messaging-api proxy enabled");
  }

  const storage = input.storage ?? new D1Storage(input.env.DB);
  const lineClient = new LineMessagingApiClient({
    channelAccessToken: input.env.LINE_CHANNEL_ACCESS_TOKEN,
    fetchImpl: input.fetchImpl,
  });

  if (input.request.method !== "POST") {
    return jsonError(405, `method ${input.request.method} not allowed`);
  }

  const rawBody = await input.request.text();
  const contentType =
    input.request.headers.get("content-type") ?? "application/json";
  const forwardedHeaders = pickForwardedHeaders(input.request);

  if (path === "/v2/bot/message/reply") {
    return proxyReply({
      service,
      storage,
      lineClient,
      rawBody,
      contentType,
      forwardedHeaders,
    });
  }
  if (path === "/v2/bot/message/push") {
    return proxyPush({
      service,
      config: input.config,
      lineClient,
      storage,
      rawBody,
      contentType,
      forwardedHeaders,
    });
  }
  if (
    path === "/v2/bot/message/validate/reply" ||
    path === "/v2/bot/message/validate/push"
  ) {
    const res = await lineClient.forward(
      path,
      rawBody,
      contentType,
      forwardedHeaders,
    );
    return passthrough(res);
  }

  // 未対応 endpoint は 501 で返す。v0.1 では reply/push/validate のみ対応。
  // 404 だと「URL を間違えた」と読まれて debug が紛らわしいので、Not Implemented を明示する。
  return jsonError(
    501,
    `proxy endpoint not implemented: ${input.request.method} ${path}. ` +
      `v0.1 supports POST /v2/bot/message/{reply,push,validate/reply,validate/push} only.`,
  );
}

interface ProxyReplyInput {
  service: ServiceConfig;
  storage: StorageAdapter;
  lineClient: LineMessagingApiClient;
  rawBody: string;
  contentType: string;
  forwardedHeaders: Record<string, string>;
}

async function proxyReply(input: ProxyReplyInput): Promise<Response> {
  let body: { replyToken?: string; messages?: unknown[] } | undefined;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return jsonError(400, "invalid json body");
  }
  if (!body?.replyToken || typeof body.replyToken !== "string") {
    return jsonError(400, "replyToken is required");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "messages is required");
  }
  if (body.messages.length > 5) {
    return jsonError(400, "messages length must be <= 5");
  }

  if (!isVirtualReplyToken(body.replyToken)) {
    return jsonError(
      400,
      "replyToken must be a router-issued virtual replyToken (rtr_reply_*)",
    );
  }

  // forward が失敗した場合に retry できなくなる事を防ぐため、まず peek (used を立てずに参照) して
  // LINE への forward が成功してから初めて consume する。LINE 側 replyToken は本来 single-use なので
  // 並行ペア両方が forward しても LINE がどちらか一方を拒否し、consume も atomic UPDATE なので
  // 重複消費は起きない。
  const peeked = await input.storage.peekVirtualReplyToken(
    body.replyToken,
    input.service.id,
  );
  if (!peeked) {
    return jsonError(
      400,
      "virtual replyToken is invalid, expired, or already used",
    );
  }

  const forwardBody = JSON.stringify({
    ...body,
    replyToken: peeked.realReplyToken,
  });
  const res = await input.lineClient.forward(
    "/v2/bot/message/reply",
    forwardBody,
    "application/json",
    input.forwardedHeaders,
  );
  if (res.status >= 200 && res.status < 300) {
    const consumed = await input.storage.consumeVirtualReplyToken(
      body.replyToken,
      input.service.id,
    );
    if (!consumed) {
      console.warn(
        `[line-bot-router] reply succeeded but failed to mark virtual reply token used: ${body.replyToken}`,
      );
    }
    await input.storage.saveOutboundMessage({
      serviceId: input.service.id,
      sourceId: peeked.sourceId,
      kind: "reply",
      createdAt: new Date().toISOString(),
    });
  }
  return passthrough(res);
}

interface ProxyPushInput {
  service: ServiceConfig;
  config: RouterConfig;
  storage: StorageAdapter;
  lineClient: LineMessagingApiClient;
  rawBody: string;
  contentType: string;
  forwardedHeaders: Record<string, string>;
}

async function proxyPush(input: ProxyPushInput): Promise<Response> {
  let body: { to?: string; messages?: unknown[] } | undefined;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return jsonError(400, "invalid json body");
  }
  if (!body?.to || typeof body.to !== "string") {
    return jsonError(400, "to is required");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "messages is required");
  }
  if (body.messages.length > 5) {
    return jsonError(400, "messages length must be <= 5");
  }
  if (!isAllowedGroupForService(input.service, input.config, body.to)) {
    return jsonError(403, `service is not allowed to push to ${body.to}`);
  }

  const res = await input.lineClient.forward(
    "/v2/bot/message/push",
    input.rawBody,
    input.contentType,
    input.forwardedHeaders,
  );
  if (res.status >= 200 && res.status < 300) {
    await input.storage.saveOutboundMessage({
      serviceId: input.service.id,
      sourceId: body.to,
      kind: "push",
      createdAt: new Date().toISOString(),
    });
  }
  return passthrough(res);
}
