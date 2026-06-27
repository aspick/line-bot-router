import type {
  ConversationLock,
  LineEvent,
  NormalizedLineEvent,
  RoutingDecision,
  RoutingMatchType,
  ServiceConfig,
} from "./types.js";
import type { RouterConfig } from "../config/schema.js";

export interface DecideRoutingInput {
  event: NormalizedLineEvent;
  config: RouterConfig;
  conversationLock?: ConversationLock | null;
}

interface HandlerCandidate {
  service: ServiceConfig;
  matchedBy: RoutingMatchType;
  command?: string;
  priorityRank: number;
}

const PRIORITY_RANK: Record<RoutingMatchType, number> = {
  "conversation-lock": 0,
  "postback-namespace": 1,
  command: 2,
  mention: 3,
  regex: 4,
  fallback: 5,
};

function isEnabledForSource(
  service: ServiceConfig,
  config: RouterConfig,
  sourceId: string,
): boolean {
  if (
    service.permissions?.allowedGroupIds &&
    !service.permissions.allowedGroupIds.includes(sourceId)
  ) {
    return false;
  }

  const group = config.groups?.find((g) => g.id === sourceId);
  if (group?.enabledServices) {
    return group.enabledServices.includes(service.id);
  }
  return true;
}

function matchesEventFilter(service: ServiceConfig, eventType: string): boolean {
  const filter = service.routing.events;
  if (!filter || filter.length === 0) return true;
  if (filter.includes("*")) return true;
  return filter.includes(eventType);
}

function extractText(event: LineEvent): string | null {
  if (event.type === "message") {
    const msg = (event as { message?: { type?: string; text?: string } }).message;
    if (msg?.type === "text" && typeof msg.text === "string") return msg.text;
  }
  return null;
}

function extractPostbackData(event: LineEvent): string | null {
  if (event.type === "postback") {
    const pb = (event as { postback?: { data?: string } }).postback;
    if (pb?.data) return pb.data;
  }
  return null;
}

function matchCommand(text: string, commands: string[] | undefined): string | null {
  if (!commands) return null;
  for (const cmd of commands) {
    if (text === cmd) return cmd;
    if (!text.startsWith(cmd)) continue;

    // 末尾が ":" / "：" のコマンドは prefix match を許す ("出欠:明日" などを想定)。
    // それ以外は word-boundary を要求し、"/attendance" を "/att" が誤マッチしないようにする。
    if (cmd.endsWith(":") || cmd.endsWith("：")) return cmd;

    const next = text.slice(cmd.length, cmd.length + 1);
    if (next === "" || /\s/.test(next)) return cmd;
  }
  return null;
}

function matchMention(text: string, mentions: string[] | undefined): string | null {
  if (!mentions) return null;
  for (const m of mentions) {
    if (text.includes(`@${m}`) || text.includes(m)) return m;
  }
  return null;
}

function matchRegex(text: string, regexes: string[] | undefined): string | null {
  if (!regexes) return null;
  for (const r of regexes) {
    try {
      if (new RegExp(r).test(text)) return r;
    } catch {
      // ignore invalid regex; surfaced via config validate (future)
    }
  }
  return null;
}

function compareCandidates(a: HandlerCandidate, b: HandlerCandidate): number {
  if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
  const aPriority = a.service.routing.priority ?? 0;
  const bPriority = b.service.routing.priority ?? 0;
  return bPriority - aPriority;
}

export function decideRouting({
  event,
  config,
  conversationLock,
}: DecideRoutingInput): RoutingDecision {
  const observers: ServiceConfig[] = [];
  const handlerCandidates: HandlerCandidate[] = [];

  const text = extractText(event.raw);
  const postbackData = extractPostbackData(event.raw);

  for (const service of config.services) {
    if (!isEnabledForSource(service, config, event.sourceId)) continue;
    if (service.permissions?.receiveMessages === false) continue;

    const role = service.routing.role;

    if (role === "observe") {
      if (matchesEventFilter(service, event.type)) {
        observers.push(service);
      }
      continue;
    }

    if (!matchesEventFilter(service, event.type)) continue;

    if (
      conversationLock &&
      conversationLock.serviceId === service.id &&
      role === "handle"
    ) {
      handlerCandidates.push({
        service,
        matchedBy: "conversation-lock",
        priorityRank: PRIORITY_RANK["conversation-lock"],
      });
      continue;
    }

    if (postbackData && service.routing.postbackNamespace) {
      const ns = service.routing.postbackNamespace;
      if (
        postbackData === ns ||
        postbackData.startsWith(`${ns}:`) ||
        postbackData.startsWith(`${ns}=`) ||
        postbackData.startsWith(`${ns}.`)
      ) {
        handlerCandidates.push({
          service,
          matchedBy: "postback-namespace",
          priorityRank: PRIORITY_RANK["postback-namespace"],
        });
        continue;
      }
    }

    if (text != null) {
      const cmd = matchCommand(text, service.routing.commands);
      if (cmd) {
        handlerCandidates.push({
          service,
          matchedBy: "command",
          command: cmd,
          priorityRank: PRIORITY_RANK.command,
        });
        continue;
      }
      const mention = matchMention(text, service.routing.mentions);
      if (mention) {
        handlerCandidates.push({
          service,
          matchedBy: "mention",
          priorityRank: PRIORITY_RANK.mention,
        });
        continue;
      }
      const regex = matchRegex(text, service.routing.regex);
      if (regex) {
        handlerCandidates.push({
          service,
          matchedBy: "regex",
          priorityRank: PRIORITY_RANK.regex,
        });
        continue;
      }
    }

    if (role === "fallback") {
      handlerCandidates.push({
        service,
        matchedBy: "fallback",
        priorityRank: PRIORITY_RANK.fallback,
      });
    }
  }

  handlerCandidates.sort(compareCandidates);
  const top = handlerCandidates[0];

  return {
    observers,
    handler: top
      ? {
          service: top.service,
          matchedBy: top.matchedBy,
          ...(top.command ? { command: top.command } : {}),
        }
      : null,
  };
}
