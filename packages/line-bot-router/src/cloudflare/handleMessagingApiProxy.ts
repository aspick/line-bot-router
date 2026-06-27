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
}): Response {
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.contentType },
  });
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
  if (service.permissions?.sendMessages === false) {
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

  if (path === "/v2/bot/message/reply") {
    return proxyReply({
      service,
      storage,
      lineClient,
      rawBody,
      contentType,
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
    });
  }
  if (
    path === "/v2/bot/message/validate/reply" ||
    path === "/v2/bot/message/validate/push"
  ) {
    const res = await lineClient.forward(path, rawBody, contentType);
    return passthrough(res);
  }

  return jsonError(404, `proxy endpoint not implemented: ${path}`);
}

interface ProxyReplyInput {
  service: ServiceConfig;
  storage: StorageAdapter;
  lineClient: LineMessagingApiClient;
  rawBody: string;
  contentType: string;
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

  const consumed = await input.storage.consumeVirtualReplyToken(
    body.replyToken,
    input.service.id,
  );
  if (!consumed) {
    return jsonError(
      400,
      "virtual replyToken is invalid, expired, or already used",
    );
  }

  const forwardBody = JSON.stringify({
    ...body,
    replyToken: consumed.realReplyToken,
  });
  const res = await input.lineClient.forward(
    "/v2/bot/message/reply",
    forwardBody,
    "application/json",
  );
  if (res.status >= 200 && res.status < 300) {
    await input.storage.saveOutboundMessage({
      serviceId: input.service.id,
      sourceId: consumed.sourceId,
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
