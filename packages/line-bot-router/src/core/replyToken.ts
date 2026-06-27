export const VIRTUAL_REPLY_TOKEN_PREFIX = "rtr_reply_";

/**
 * 仮想 replyToken の値を生成する。
 * 衝突を避けるため、UUID v4 から英数字のみ抽出する。
 * 仮想 token は serviceId / sourceId / expiresAt / used と一緒に
 * Storage に永続化されて初めて有効になる。
 */
export function createVirtualReplyTokenValue(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `${VIRTUAL_REPLY_TOKEN_PREFIX}${uuid}`;
}

export function isVirtualReplyToken(token: string): boolean {
  return token.startsWith(VIRTUAL_REPLY_TOKEN_PREFIX);
}

/**
 * LINE の本物 replyToken の有効期限はおおよそ 1 分。
 * router 側はそれより少し短い値をデフォルトにして、proxy 経路で消費される前に
 * router 側で期限切れ判定できるようにする。
 */
export const DEFAULT_VIRTUAL_REPLY_TOKEN_TTL_SECONDS = 55;
