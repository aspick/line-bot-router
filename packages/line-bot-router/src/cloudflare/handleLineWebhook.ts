import {
  decideRouting,
  normalizeEvent,
  verifyLineSignature,
  type LineWebhookPayload,
  type RouterConfig,
  type StorageAdapter,
} from "../core/index.js";
import { D1Storage } from "./d1Storage.js";
import { dispatchHandler, dispatchObserver } from "./dispatch.js";
import { envSecretResolver, type BaseEnv, type MinimalExecutionContext } from "./env.js";
import { LineMessagingApiClient } from "./lineClient.js";
import { maybeRespondRouterInfo } from "./routerInfo.js";

export interface HandleLineWebhookInput<TEnv extends BaseEnv = BaseEnv> {
  request: Request;
  env: TEnv;
  ctx: MinimalExecutionContext;
  config: RouterConfig;
  storage?: StorageAdapter;
  fetchImpl?: typeof fetch;
}

export async function handleLineWebhook<TEnv extends BaseEnv = BaseEnv>(
  input: HandleLineWebhookInput<TEnv>,
): Promise<Response> {
  const buf = await input.request.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const sigHeader = input.request.headers.get("x-line-signature");
  const ok = await verifyLineSignature({
    secret: input.env.LINE_CHANNEL_SECRET,
    body: bytes,
    signature: sigHeader,
  });
  if (!ok) {
    return new Response("invalid signature", { status: 401 });
  }

  let payload: LineWebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as LineWebhookPayload;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  if (!payload || !Array.isArray(payload.events)) {
    return new Response("invalid payload", { status: 400 });
  }

  const storage = input.storage ?? new D1Storage(input.env.DB);
  const secrets = envSecretResolver(input.env);
  const lineClient = new LineMessagingApiClient({
    channelAccessToken: input.env.LINE_CHANNEL_ACCESS_TOKEN,
    fetchImpl: input.fetchImpl,
  });

  for (const rawEvent of payload.events) {
    try {
      await processSingleEvent({
        rawEvent,
        destination: payload.destination,
        storage,
        secrets,
        lineClient,
        ctx: input.ctx,
        config: input.config,
        fetchImpl: input.fetchImpl,
      });
    } catch (err) {
      console.error(
        `[line-bot-router] failed to process event: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
    }
  }

  return new Response("OK", { status: 200 });
}

interface ProcessSingleEventInput {
  rawEvent: LineWebhookPayload["events"][number];
  destination: string;
  storage: StorageAdapter;
  secrets: ReturnType<typeof envSecretResolver>;
  lineClient: LineMessagingApiClient;
  ctx: MinimalExecutionContext;
  config: RouterConfig;
  fetchImpl?: typeof fetch;
}

async function processSingleEvent(input: ProcessSingleEventInput): Promise<void> {
  const normalized = normalizeEvent(input.rawEvent);

  const claimed = await input.storage.claimEvent(normalized.webhookEventId);
  if (!claimed) {
    return;
  }
  await input.storage.saveEvent(normalized);

  const lock = await input.storage.getConversationLock(
    normalized.sourceId,
    normalized.actorUserId,
  );

  const decision = decideRouting({
    event: normalized,
    config: input.config,
    conversationLock: lock,
  });

  for (const observer of decision.observers) {
    input.ctx.waitUntil(
      dispatchObserver({
        service: observer,
        event: normalized,
        destination: input.destination,
        secrets: input.secrets,
        fetchImpl: input.fetchImpl,
      }),
    );
  }

  const info = await maybeRespondRouterInfo({
    event: normalized,
    config: input.config,
    lineClient: input.lineClient,
  });
  if (info.handled) return;

  if (!decision.handler) return;

  await dispatchHandler({
    service: decision.handler.service,
    event: normalized,
    destination: input.destination,
    matchedBy: decision.handler.matchedBy,
    command: decision.handler.command,
    secrets: input.secrets,
    storage: input.storage,
    lineClient: input.lineClient,
    virtualReplyTokenTtlSeconds:
      input.config.router.virtualReplyToken?.ttlSeconds,
    fetchImpl: input.fetchImpl,
  });
}
