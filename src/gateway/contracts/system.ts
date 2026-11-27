import { createRoute, z } from "@hono/zod-openapi";
import { jsonContent, notFoundResponse } from "./common.ts";

export const runtimeModelSchema = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    provider: z.string().optional(),
    reasoningEfforts: z.array(z.string()).readonly().optional(),
    defaultReasoningEffort: z.string().optional(),
    contextWindow: z.number().optional(),
  })
  .openapi("RuntimeModel");

export const runtimeCatalogEntrySchema = z
  .object({
    type: z
      .string()
      .openapi({ description: "Runtime adapter identifier (e.g. codex, claude, pi, acp)" }),
    name: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    internal: z.boolean().optional(),
    defaultModel: z.string().optional(),
    defaultReasoningEfforts: z.array(z.string()).readonly().optional(),
    models: z.array(runtimeModelSchema).readonly().optional(),
  })
  .openapi("RuntimeCatalogEntry");

export const healthzRoute = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["System"],
  summary: "Liveness health check",
  security: [],
  responses: {
    200: jsonContent(z.object({ status: z.literal("ok") }), "Service is alive"),
  },
});

export const readyzRoute = createRoute({
  method: "get",
  path: "/readyz",
  tags: ["System"],
  summary: "Readiness probe",
  security: [],
  responses: {
    200: jsonContent(z.object({ status: z.literal("ready") }), "Service is ready"),
  },
});

export const listRuntimesRoute = createRoute({
  method: "get",
  path: "/runtimes",
  tags: ["System"],
  summary: "List registered agent runtimes",
  security: [],
  request: {
    query: z.object({
      includeInternal: z
        .enum(["true", "false", "0", "1"])
        .optional()
        .openapi({
          description:
            'Set to `"false"` or `"0"` to exclude internal/test runtimes (default: true).',
        }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({ runtimes: z.array(runtimeCatalogEntrySchema) }),
      "Available agent runtimes",
    ),
  },
});

export const listRuntimeModelsRoute = createRoute({
  method: "get",
  path: "/runtimes/{runtimeType}/models",
  tags: ["System"],
  summary: "List supported models for a runtime",
  security: [],
  request: {
    params: z.object({
      runtimeType: z
        .string()
        .min(1)
        .openapi({ param: { name: "runtimeType", in: "path" } }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        runtime: z.string(),
        defaultReasoningEfforts: z.array(z.string()).readonly(),
        models: z.array(runtimeModelSchema).readonly(),
      }),
      "Models and default reasoning efforts for the specified runtime",
    ),
    404: notFoundResponse,
  },
});
