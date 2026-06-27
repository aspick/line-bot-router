import {
  buildServicePayload,
  signChildBotPayload,
  signRouterNativePayload,
  type NormalizedLineEvent,
  type ReplyProposal,
  type RoutingMatchType,
  type SecretResolver,
  type ServiceConfig,
  type ServiceResponseBody,
  type StorageAdapter,
} from "../core/index.js";
import type { LineMessagingApiClient } from "./lineClient.js";

const DEFAULT_SERVICE_TIMEOUT_MS = 8000;

export interface DispatchObserverInput {
  service: ServiceConfig;
  event: NormalizedLineEvent;
  destination: string;
  secrets: SecretResolver;
  fetchImpl?: typeof fetch;
}

export async function dispatchObserver(
  input: DispatchObserverInput,
): Promise<void> {
  const payload = buildServicePayload({
    service: input.service,
    event: input.event,
    destination: input.destination,
    deliveryType: "observe",
  });

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-line-bot-router-delivery": "observe",
    "x-line-bot-router-service": input.service.id,
  };

  await addSignatureHeaders({
    service: input.service,
    body,
    headers,
    secrets: input.secrets,
    deliveryType: "observe",
  });

  const timeoutMs =
    input.service.delivery.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch.bind(globalThis);

  try {
    await fetchImpl(input.service.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.warn(
      `[line-bot-router] observer dispatch failed: service=${input.service.id} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface DispatchHandlerInput {
  service: ServiceConfig;
  event: NormalizedLineEvent;
  destination: string;
  matchedBy: RoutingMatchType;
  command?: string;
  secrets: SecretResolver;
  storage: StorageAdapter;
  lineClient: LineMessagingApiClient;
  virtualReplyTokenTtlSeconds?: number;
  fetchImpl?: typeof fetch;
}

export interface DispatchHandlerResult {
  /**
   * router が LINE へ reply を発射した場合 true。
   * messaging-api-proxy で child が proxy 経由で reply する場合は false。
   */
  routerReplied: boolean;
  serviceResponseStatus?: number;
}

export async function dispatchHandler(
  input: DispatchHandlerInput,
): Promise<DispatchHandlerResult> {
  const { service, event, destination } = input;
  let virtualReplyToken: string | undefined;

  if (
    service.delivery.responseMode === "messaging-api-proxy" &&
    event.replyToken
  ) {
    const created = await input.storage.createVirtualReplyToken({
      realReplyToken: event.replyToken,
      serviceId: service.id,
      sourceId: event.sourceId,
      ttlSeconds: input.virtualReplyTokenTtlSeconds,
    });
    virtualReplyToken = created.virtualToken;
  }

  const payload = buildServicePayload({
    service,
    event,
    destination,
    deliveryType: "handle",
    routing: { matchedBy: input.matchedBy, command: input.command },
    virtualReplyToken,
  });

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-line-bot-router-delivery": "handle",
    "x-line-bot-router-service": service.id,
  };

  // addSignatureHeaders は secret 欠落時に throw する (fail-closed)。createVirtualReplyToken の
  // 後でこの throw が出ると未使用 token が D1 に残るため、cleanup を保証する。
  try {
    await addSignatureHeaders({
      service,
      body,
      headers,
      secrets: input.secrets,
      deliveryType: "handle",
    });
  } catch (err) {
    if (virtualReplyToken) {
      await input.storage.deleteVirtualReplyToken(virtualReplyToken);
    }
    throw err;
  }

  const timeoutMs = service.delivery.timeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch.bind(globalThis);

  let res: Response | null = null;
  try {
    res = await fetchImpl(service.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.warn(
      `[line-bot-router] handler dispatch failed: service=${service.id} err=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // 仮想 reply token は child に届かなかったので、未使用のまま D1 に残らないよう削除する。
    if (virtualReplyToken) {
      await input.storage.deleteVirtualReplyToken(virtualReplyToken);
    }
    return { routerReplied: false };
  }

  const status = res.status;

  if (service.delivery.responseMode === "http-response") {
    if (!event.replyToken) return { routerReplied: false, serviceResponseStatus: status };

    let parsed: ServiceResponseBody | undefined;
    try {
      parsed = (await res.json()) as ServiceResponseBody;
    } catch {
      parsed = undefined;
    }
    if (!parsed?.reply) return { routerReplied: false, serviceResponseStatus: status };

    // eventFormat.ts:37-40 で canReply は `permissions.sendMessages === true` から計算しており、
    // child には capabilities.canReply: false を渡している。ここで送信権限を二重に確認しないと
    // 「sendMessages 権限を持たないはずの observer 系 service」が response body に reply を含めると
    // router が代行送信してしまい矛盾する。default-deny で揃える。
    const sendsEnabled = service.permissions?.sendMessages === true;
    if (!sendsEnabled) {
      console.warn(
        `[line-bot-router] service=${service.id} returned reply proposal but lacks permissions.sendMessages; dropping`,
      );
      return { routerReplied: false, serviceResponseStatus: status };
    }

    const proposal: ReplyProposal = parsed.reply;
    const messages = (proposal.messages ?? []).slice(0, 5);
    if (messages.length === 0) {
      return { routerReplied: false, serviceResponseStatus: status };
    }

    const replyRes = await input.lineClient.reply({
      replyToken: event.replyToken,
      messages,
    });
    if (replyRes.status >= 200 && replyRes.status < 300) {
      await input.storage.saveOutboundMessage({
        serviceId: service.id,
        sourceId: event.sourceId,
        kind: "reply",
        createdAt: new Date().toISOString(),
      });
      return { routerReplied: true, serviceResponseStatus: status };
    }
    console.warn(
      `[line-bot-router] LINE reply failed: status=${replyRes.status} body=${replyRes.body}`,
    );
    return { routerReplied: false, serviceResponseStatus: status };
  }

  return { routerReplied: false, serviceResponseStatus: status };
}

interface AddSignatureHeadersInput {
  service: ServiceConfig;
  body: string;
  headers: Record<string, string>;
  secrets: SecretResolver;
  deliveryType: "observe" | "handle";
}

async function addSignatureHeaders(input: AddSignatureHeadersInput) {
  if (!input.service.secretEnv) return;
  const secret = input.secrets.get(input.service.secretEnv);
  if (!secret) {
    // fail-closed: secretEnv が宣言されているのに env 側が空 / undefined だと、
    // child は署名を期待しているので unsigned に落とすと契約違反 (検証してる child は 401 で全破棄、
    // 検証していない child でも署名前提の運用方針が崩れる)。dispatch 自体を中断する。
    throw new Error(
      `[line-bot-router] secretEnv ${input.service.secretEnv} is declared for service ${input.service.id} but is empty in env; refusing to dispatch unsigned`,
    );
  }

  if (input.service.delivery.eventFormat === "router-native") {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signRouterNativePayload({
      secret,
      body: input.body,
      timestamp: ts,
    });
    input.headers["x-line-bot-router-timestamp"] = String(ts);
    input.headers["x-line-bot-router-signature"] = sig;
  } else {
    const sig = await signChildBotPayload(secret, input.body);
    input.headers["x-line-signature"] = sig;
  }
}
