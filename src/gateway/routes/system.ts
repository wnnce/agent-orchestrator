import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { RuntimeModelCatalog } from "../../runtime/catalog.ts";
import type { RuntimeRegistry } from "../../runtime/registry.ts";

const runtimeModelSchema = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    provider: z.string().optional(),
    reasoningEfforts: z.array(z.string()).optional(),
  })
  .meta({ ref: "RuntimeModel" });

const runtimeCatalogEntrySchema = z
  .object({
    type: z.string().describe("Runtime adapter identifier (e.g. codex, claude, pi, acp)"),
    displayName: z.string().optional(),
    internal: z.boolean().optional(),
    defaultModel: z.string().optional(),
    defaultReasoningEfforts: z.array(z.string()).optional(),
    models: z.array(runtimeModelSchema).optional(),
  })
  .meta({ ref: "RuntimeCatalogEntry" });

const listRuntimesQuerySchema = z.object({
  includeInternal: z
    .enum(["true", "false", "0", "1"])
    .optional()
    .describe('Set to `"false"` or `"0"` to exclude internal/test runtimes (default: true).'),
});

export function createSystemRouter(
  runtimeRegistry?: RuntimeRegistry,
  modelCatalog: RuntimeModelCatalog = new RuntimeModelCatalog(),
): Hono {
  const router = new Hono();

  router.get(
    "/healthz",
    describeRoute({
      tags: ["System"],
      summary: "Liveness health check",
      security: [],
      responses: {
        200: {
          description: "Service is alive",
          content: { "application/json": { schema: resolver(z.object({ status: z.literal("ok") })) } },
        },
      },
    }),
    (c) => c.json({ status: "ok" }),
  );

  router.get(
    "/readyz",
    describeRoute({
      tags: ["System"],
      summary: "Readiness probe",
      security: [],
      responses: {
        200: {
          description: "Service is ready",
          content: {
            "application/json": { schema: resolver(z.object({ status: z.literal("ready") })) },
          },
        },
      },
    }),
    (c) => c.json({ status: "ready" }),
  );

  router.get(
    "/runtimes",
    describeRoute({
      tags: ["System"],
      summary: "List registered agent runtimes",
      security: [],
      responses: {
        200: {
          description: "Available agent runtimes",
          content: {
            "application/json": {
              schema: resolver(z.object({ runtimes: z.array(runtimeCatalogEntrySchema) })),
            },
          },
        },
      },
    }),
    validator("query", listRuntimesQuerySchema),
    async (c) => {
      if (!runtimeRegistry) return c.json({ runtimes: [] });
      const { includeInternal: includeInternalParam } = c.req.valid("query");
      const includeInternal = includeInternalParam !== "false" && includeInternalParam !== "0";
      const runtimes = await modelCatalog.listRuntimes(runtimeRegistry, { includeInternal });
      return c.json({ runtimes });
    },
  );

  router.get(
    "/runtimes/:runtimeType/models",
    describeRoute({
      tags: ["System"],
      summary: "List supported models for a runtime",
      security: [],
      responses: {
        200: {
          description: "Models and default reasoning efforts for the specified runtime",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  runtime: z.string(),
                  defaultReasoningEfforts: z.array(z.string()),
                  models: z.array(runtimeModelSchema),
                }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      if (!runtimeRegistry) return c.json({ error: "runtime_not_found" }, 404);
      const runtimeType = c.req.param("runtimeType").trim().toLowerCase();
      const meta = runtimeRegistry.listRuntimes().find((r) => r.type === runtimeType);
      if (!meta) return c.json({ error: "runtime_not_found", runtime: runtimeType }, 404);
      const models = await modelCatalog.listModels(runtimeRegistry, meta.type);
      return c.json({
        runtime: meta.type,
        defaultReasoningEfforts: meta.defaultReasoningEfforts ?? [],
        models,
      });
    },
  );

  return router;
}
