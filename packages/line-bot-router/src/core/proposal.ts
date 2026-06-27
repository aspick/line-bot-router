import type { ReplyProposal } from "./types.js";

const LINE_REPLY_MAX_MESSAGES = 5;

/**
 * handler から受け取った reply proposal を集約する。
 * MVP では handler は最大 1 つだが、将来 multi-handler を許す場合に備えて
 * priority を考慮するインターフェースにしておく。
 */
export function aggregateReplyProposals(
  proposals: ReplyProposal[],
): Array<Record<string, unknown>> | null {
  if (proposals.length === 0) return null;
  const sorted = [...proposals].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
  const top = sorted[0]!;
  if (!Array.isArray(top.messages) || top.messages.length === 0) return null;
  return top.messages.slice(0, LINE_REPLY_MAX_MESSAGES);
}
