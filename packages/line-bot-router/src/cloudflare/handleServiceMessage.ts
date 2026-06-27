import type {
  RouterConfig,
  ServiceConfig,
  StorageAdapter,
} from "../core/index.js";
import { D1Storage } from "./d1Storage.js";
import { envSecretResolver, type BaseEnv } from "./env.js";
import { LineMessagingApiClient } from "./lineClient.js";

export interface HandleServiceMessageInput<TEnv extends BaseEnv = BaseEnv> {
  request: Request;
  env: TEnv;
  config: RouterConfig;
  storage?: StorageAdapter;
  fetchImpl?: typeof fetch;
}

interface ServiceMessageRequest {
  serviceId?: string;
  to?: { type?: string; id?: string } | string;
  messages?: unknown[];
  dedupeKey?: string;
  notificationDisabled?: boolean;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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

function extractTo(to: ServiceMessageRequest["to"]): string | null {
  if (!to) return null;
  if (typeof to === "string") return to;
  if (typeof to === "object" && typeof to.id === "string") return to.id;
  return null;
}

function isAllowedTarget(
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

export async function handleServiceMessage<TEnv extends BaseEnv = BaseEnv>(
  input: HandleServiceMessageInput<TEnv>,
): Promise<Response> {
  if (input.request.method !== "POST") {
    return jsonError(405, `method ${input.request.method} not allowed`);
  }

  const auth = input.request.headers.get("authorization");
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  const token = m ? m[1]!.trim() : null;
  if (!token) return jsonError(401, "missing bearer token");

  const secrets = envSecretResolver(input.env);
  const service = findServiceByToken(input.config, secrets, token);
  if (!service) return jsonError(401, "invalid service token");
  if (service.permissions?.sendMessages !== true) {
    return jsonError(403, "service is not allowed to send messages");
  }

  let body: ServiceMessageRequest;
  try {
    body = (await input.request.json()) as ServiceMessageRequest;
  } catch {
    return jsonError(400, "invalid json body");
  }
  if (body.serviceId && body.serviceId !== service.id) {
    return jsonError(400, "serviceId does not match authenticated service");
  }
  const target = extractTo(body.to);
  if (!target) return jsonError(400, "to is required");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "messages is required");
  }
  if (body.messages.length > 5) {
    return jsonError(400, "messages length must be <= 5");
  }
  if (!isAllowedTarget(service, input.config, target)) {
    return jsonError(403, `service is not allowed to push to ${target}`);
  }

  const storage = input.storage ?? new D1Storage(input.env.DB);

  const outboundRecord: {
    serviceId: string;
    sourceId: string;
    kind: "push";
    createdAt: string;
    dedupeKey?: string;
  } = {
    serviceId: service.id,
    sourceId: target,
    kind: "push",
    createdAt: new Date().toISOString(),
  };
  if (body.dedupeKey) outboundRecord.dedupeKey = body.dedupeKey;

  const saved = await storage.saveOutboundMessage(outboundRecord);
  if (!saved.inserted && body.dedupeKey) {
    return new Response(JSON.stringify({ deduped: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const lineClient = new LineMessagingApiClient({
    channelAccessToken: input.env.LINE_CHANNEL_ACCESS_TOKEN,
    fetchImpl: input.fetchImpl,
  });

  let res: Awaited<ReturnType<typeof lineClient.push>>;
  try {
    res = await lineClient.push({
      to: target,
      messages: body.messages as Array<Record<string, unknown>>,
      notificationDisabled: body.notificationDisabled,
    });
  } catch (err) {
    if (body.dedupeKey) {
      await storage.deleteOutboundMessage(service.id, body.dedupeKey);
    }
    throw err;
  }

  // LINE が 5xx / 429 を返した場合は dedupe row をロールバックして同 dedupeKey での retry を許容する。
  if (body.dedupeKey && (res.status >= 500 || res.status === 429)) {
    await storage.deleteOutboundMessage(service.id, body.dedupeKey);
  }
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.contentType },
  });
}
