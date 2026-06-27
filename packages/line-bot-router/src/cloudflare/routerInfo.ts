import type {
  LineEvent,
  NormalizedLineEvent,
  RouterConfig,
} from "../core/index.js";
import type { LineMessagingApiClient } from "./lineClient.js";

function extractText(event: LineEvent): string | null {
  if (event.type === "message") {
    const msg = (event as { message?: { type?: string; text?: string } }).message;
    if (msg?.type === "text" && typeof msg.text === "string") return msg.text;
  }
  return null;
}

function isAdmin(config: RouterConfig, userId?: string): boolean {
  if (!userId) return false;
  return config.router.adminUserIds?.includes(userId) ?? false;
}

function buildInfoText(event: NormalizedLineEvent): string {
  const source = event.source;
  const lines: string[] = [];
  lines.push("source:");
  lines.push(`  type: ${source.type}`);
  if (source.groupId) lines.push(`  groupId: ${source.groupId}`);
  if (source.roomId) lines.push(`  roomId: ${source.roomId}`);
  if (event.actorUserId) {
    lines.push("user:");
    lines.push(`  userId: ${event.actorUserId}`);
  }
  return lines.join("\n");
}

export interface MaybeRespondRouterInfoInput {
  event: NormalizedLineEvent;
  config: RouterConfig;
  lineClient: LineMessagingApiClient;
}

export interface MaybeRespondRouterInfoResult {
  /** /router info コマンドとしてマッチして処理を消費したか */
  handled: boolean;
}

export async function maybeRespondRouterInfo(
  input: MaybeRespondRouterInfoInput,
): Promise<MaybeRespondRouterInfoResult> {
  const text = extractText(input.event.raw);
  if (text == null) return { handled: false };

  const infoCmd = input.config.router.infoCommand;
  if (text.trim() !== infoCmd) return { handled: false };

  const allowWithoutAdmin =
    input.config.router.setup?.allowInfoCommandWithoutAdmin === true;
  const admin = isAdmin(input.config, input.event.actorUserId);
  if (!admin && !allowWithoutAdmin) {
    return { handled: true };
  }

  if (!input.event.replyToken) {
    return { handled: true };
  }

  const messages = [
    {
      type: "text",
      text: buildInfoText(input.event),
    },
  ];

  const res = await input.lineClient.reply({
    replyToken: input.event.replyToken,
    messages,
  });
  if (res.status >= 400) {
    console.warn(
      `[line-bot-router] /router info reply failed status=${res.status} body=${res.body}`,
    );
  }
  return { handled: true };
}
