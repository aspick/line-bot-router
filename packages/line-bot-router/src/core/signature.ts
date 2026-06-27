/**
 * LINE 署名検証 / 各種 HMAC 生成のユーティリティ。
 *
 * - 検証は **raw body のバイト列** に対して行う。
 *   string で受け取った場合は UTF-8 でエンコードする。
 * - Web Crypto (`crypto.subtle`) のみを使い、Node にも CF Workers にも依存しない。
 */

const textEncoder = new TextEncoder();

function toBytes(input: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof input === "string") return textEncoder.encode(input);
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

function uint8ToBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.byteLength; i++) {
    bin += String.fromCharCode(buf[i]!);
  }
  return btoa(bin);
}

async function hmacSha256(
  secret: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return new Uint8Array(sig);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface VerifyLineSignatureInput {
  secret: string;
  body: ArrayBuffer | Uint8Array | string;
  signature: string | null | undefined;
}

export async function verifyLineSignature(
  input: VerifyLineSignatureInput,
): Promise<boolean> {
  if (!input.signature) return false;
  const sig = await hmacSha256(input.secret, toBytes(input.body));
  const expected = uint8ToBase64(sig);
  return constantTimeEqual(expected, input.signature);
}

/**
 * child bot 向け LINE webhook 互換配送で使う X-Line-Signature を生成する。
 * 共有 secret は router と child の合意のもの。LINE 本物の channel secret ではない。
 */
export async function signChildBotPayload(
  secret: string,
  body: ArrayBuffer | Uint8Array | string,
): Promise<string> {
  const sig = await hmacSha256(secret, toBytes(body));
  return uint8ToBase64(sig);
}

/**
 * router-native 配送で X-Router-Signature を作る。
 * 形式: hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))
 */
export async function signRouterNativePayload(input: {
  secret: string;
  body: ArrayBuffer | Uint8Array | string;
  timestamp: number;
}): Promise<string> {
  const data = textEncoder.encode(
    `${input.timestamp}.${
      typeof input.body === "string"
        ? input.body
        : new TextDecoder().decode(toBytes(input.body))
    }`,
  );
  const sig = await hmacSha256(input.secret, data);
  return Array.from(sig)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
