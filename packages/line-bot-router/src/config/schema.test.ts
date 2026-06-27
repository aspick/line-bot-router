import { test } from "node:test";
import assert from "node:assert/strict";
import { defineRouterConfig } from "./index.js";

test("defineRouterConfig accepts a minimal valid config", () => {
  const cfg = defineRouterConfig({
    services: [
      {
        id: "echo",
        endpoint: "https://example.com",
        routing: { role: "fallback" },
        delivery: {
          eventFormat: "router-native",
          timing: "sync",
          responseMode: "http-response",
        },
      },
    ],
  });
  assert.equal(cfg.services.length, 1);
  assert.equal(cfg.router.infoCommand, "/router info");
});

test("defineRouterConfig rejects messaging-api-proxy without line-compatible format", () => {
  assert.throws(() =>
    defineRouterConfig({
      services: [
        {
          id: "legacy",
          endpoint: "https://example.com",
          proxy: { messagingApi: true },
          routing: { role: "handle", commands: ["/x"] },
          delivery: {
            eventFormat: "router-native",
            timing: "sync",
            responseMode: "messaging-api-proxy",
          },
          permissions: { sendMessages: true },
        },
      ],
    }),
  );
});

test("defineRouterConfig rejects messaging-api-proxy without permissions.sendMessages: true", () => {
  // omitting permissions entirely
  assert.throws(
    () =>
      defineRouterConfig({
        services: [
          {
            id: "legacy",
            endpoint: "https://example.com",
            proxy: { messagingApi: true },
            routing: { role: "handle", commands: ["/x"] },
            delivery: {
              eventFormat: "line-compatible",
              timing: "sync",
              responseMode: "messaging-api-proxy",
            },
          },
        ],
      }),
    /sendMessages = true/,
  );
  // explicit sendMessages: false
  assert.throws(
    () =>
      defineRouterConfig({
        services: [
          {
            id: "legacy",
            endpoint: "https://example.com",
            proxy: { messagingApi: true },
            routing: { role: "handle", commands: ["/x"] },
            delivery: {
              eventFormat: "line-compatible",
              timing: "sync",
              responseMode: "messaging-api-proxy",
            },
            permissions: { sendMessages: false },
          },
        ],
      }),
    /sendMessages = true/,
  );
});

test("defineRouterConfig rejects observer with sendMessages = true", () => {
  assert.throws(() =>
    defineRouterConfig({
      services: [
        {
          id: "archive",
          endpoint: "https://example.com",
          routing: { role: "observe", events: ["*"] },
          delivery: {
            eventFormat: "line-compatible",
            timing: "async",
            responseMode: "none",
          },
          permissions: { sendMessages: true },
        },
      ],
    }),
  );
});

test("defineRouterConfig rejects duplicate service ids", () => {
  assert.throws(() =>
    defineRouterConfig({
      services: [
        {
          id: "dup",
          endpoint: "https://a.example.com",
          routing: { role: "handle", commands: ["/a"] },
          delivery: {
            eventFormat: "router-native",
            timing: "sync",
            responseMode: "http-response",
          },
        },
        {
          id: "dup",
          endpoint: "https://b.example.com",
          routing: { role: "handle", commands: ["/b"] },
          delivery: {
            eventFormat: "router-native",
            timing: "sync",
            responseMode: "http-response",
          },
        },
      ],
    }),
  );
});

test("defineRouterConfig rejects group.enabledServices referencing unknown service", () => {
  assert.throws(() =>
    defineRouterConfig({
      services: [
        {
          id: "echo",
          endpoint: "https://example.com",
          routing: { role: "fallback" },
          delivery: {
            eventFormat: "router-native",
            timing: "sync",
            responseMode: "http-response",
          },
        },
      ],
      groups: [
        {
          id: "Cgroup",
          enabledServices: ["does-not-exist"],
        },
      ],
    }),
  );
});
