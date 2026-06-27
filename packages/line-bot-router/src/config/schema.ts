import { z } from "zod";

const ServiceRoutingSchema = z.object({
  role: z.enum(["observe", "handle", "fallback"]),
  events: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  postbackNamespace: z.string().optional(),
  mentions: z.array(z.string()).optional(),
  regex: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
});

const ServiceDeliverySchema = z.object({
  eventFormat: z.enum(["router-native", "line-compatible", "raw-line"]),
  timing: z.enum(["sync", "async"]),
  responseMode: z.enum([
    "none",
    "http-response",
    "callback",
    "messaging-api-proxy",
  ]),
  timeoutMs: z.number().int().positive().optional(),
});

const ServicePermissionsSchema = z.object({
  receiveMessages: z.boolean().optional(),
  sendMessages: z.boolean().optional(),
  allowedGroupIds: z.array(z.string()).optional(),
});

const ServiceProxySchema = z.object({
  messagingApi: z.boolean().optional(),
  blobApi: z.boolean().optional(),
});

const ServiceConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  endpoint: z.string().url(),
  secretEnv: z.string().optional(),
  serviceTokenEnv: z.string().optional(),
  routing: ServiceRoutingSchema,
  delivery: ServiceDeliverySchema,
  permissions: ServicePermissionsSchema.optional(),
  proxy: ServiceProxySchema.optional(),
});

const GroupConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  enabledServices: z.array(z.string()).optional(),
});

const RouterRuntimeSchema = z.object({
  infoCommand: z.string().default("/router info"),
  unknownGroupPolicy: z.enum(["ignore", "respond"]).default("ignore"),
  adminUserIds: z.array(z.string()).optional(),
  setup: z
    .object({
      allowInfoCommandWithoutAdmin: z.boolean().optional(),
    })
    .optional(),
  virtualReplyToken: z
    .object({
      ttlSeconds: z.number().int().positive().max(60).optional(),
    })
    .optional(),
});

export const RouterConfigSchema = z
  .object({
    router: RouterRuntimeSchema.default({
      infoCommand: "/router info",
      unknownGroupPolicy: "ignore",
    }),
    services: z.array(ServiceConfigSchema),
    groups: z.array(GroupConfigSchema).optional(),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const [index, service] of cfg.services.entries()) {
      if (seen.has(service.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["services", index, "id"],
          message: `duplicate service id: ${service.id}`,
        });
      }
      seen.add(service.id);

      if (
        service.delivery.responseMode === "messaging-api-proxy" &&
        service.delivery.eventFormat !== "line-compatible"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["services", index, "delivery"],
          message:
            "messaging-api-proxy responseMode requires line-compatible eventFormat",
        });
      }

      if (
        service.delivery.responseMode === "messaging-api-proxy" &&
        !service.proxy?.messagingApi
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["services", index, "proxy"],
          message:
            "messaging-api-proxy responseMode requires proxy.messagingApi = true",
        });
      }

      // messaging-api-proxy 経由で reply / push する service は permissions.sendMessages: true が
      // 必須。default-deny で実装されている (handleMessagingApiProxy / dispatchHandler) ため、
      // 未設定だと runtime で 403 となり気付きづらいので config-time エラーで止める。
      if (
        service.delivery.responseMode === "messaging-api-proxy" &&
        service.permissions?.sendMessages !== true
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["services", index, "permissions", "sendMessages"],
          message:
            "messaging-api-proxy responseMode requires permissions.sendMessages = true",
        });
      }

      if (service.routing.role === "observe") {
        const sendsEnabled = service.permissions?.sendMessages === true;
        if (sendsEnabled) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["services", index, "permissions", "sendMessages"],
            message:
              "observer service should not have sendMessages = true by default",
          });
        }
      }
    }

    if (cfg.groups) {
      const ids = new Set<string>();
      for (const [i, g] of cfg.groups.entries()) {
        if (ids.has(g.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["groups", i, "id"],
            message: `duplicate group id: ${g.id}`,
          });
        }
        ids.add(g.id);
        if (g.enabledServices) {
          for (const [j, sid] of g.enabledServices.entries()) {
            if (!seen.has(sid)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["groups", i, "enabledServices", j],
                message: `unknown service id: ${sid}`,
              });
            }
          }
        }
      }
    }
  });

export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type GroupConfig = z.infer<typeof GroupConfigSchema>;
export type RouterRuntimeConfig = z.infer<typeof RouterRuntimeSchema>;

export type RouterConfigInput = z.input<typeof RouterConfigSchema>;
