import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signChildBotPayload,
  signRouterNativePayload,
  verifyLineSignature,
} from "./signature.js";

test("verifyLineSignature passes when the signature matches the raw body", async () => {
  const secret = "dummy-channel-secret";
  const body = JSON.stringify({ events: [{ type: "message" }] });
  const signature = await signChildBotPayload(secret, body);
  const ok = await verifyLineSignature({ secret, body, signature });
  assert.equal(ok, true);
});

test("verifyLineSignature fails when the body is tampered", async () => {
  const secret = "dummy-channel-secret";
  const original = JSON.stringify({ events: [{ type: "message" }] });
  const tampered = JSON.stringify({ events: [{ type: "follow" }] });
  const signature = await signChildBotPayload(secret, original);
  const ok = await verifyLineSignature({ secret, body: tampered, signature });
  assert.equal(ok, false);
});

test("verifyLineSignature fails when the secret differs", async () => {
  const body = "{}";
  const signature = await signChildBotPayload("secret-a", body);
  const ok = await verifyLineSignature({
    secret: "secret-b",
    body,
    signature,
  });
  assert.equal(ok, false);
});

test("verifyLineSignature fails when no signature header is present", async () => {
  const ok = await verifyLineSignature({
    secret: "any",
    body: "{}",
    signature: null,
  });
  assert.equal(ok, false);
});

test("verifyLineSignature treats raw bytes and equivalent string the same", async () => {
  const secret = "s";
  const body = '{"a":1}';
  const sigFromString = await signChildBotPayload(secret, body);
  const ok = await verifyLineSignature({
    secret,
    body: new TextEncoder().encode(body),
    signature: sigFromString,
  });
  assert.equal(ok, true);
});

test("signRouterNativePayload returns a stable hex string for the same inputs", async () => {
  const a = await signRouterNativePayload({
    secret: "secret",
    body: '{"x":1}',
    timestamp: 1_700_000_000,
  });
  const b = await signRouterNativePayload({
    secret: "secret",
    body: '{"x":1}',
    timestamp: 1_700_000_000,
  });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("signRouterNativePayload differs when the timestamp changes", async () => {
  const a = await signRouterNativePayload({
    secret: "secret",
    body: "{}",
    timestamp: 1,
  });
  const b = await signRouterNativePayload({
    secret: "secret",
    body: "{}",
    timestamp: 2,
  });
  assert.notEqual(a, b);
});
