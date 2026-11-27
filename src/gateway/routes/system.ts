import type { OpenAPIHono } from "@hono/zod-openapi";
import { RuntimeModelCatalog } from "../../runtime/catalog.ts";
import type { RuntimeRegistry } from "../../runtime/registry.ts";
import {
  healthzRoute,
  listRuntimeModelsRoute,
  listRuntimesRoute,
  readyzRoute,
} from "../contracts/system.ts";
import { createOpenAPIApp } from "../openapi.ts";

export function createHealthRouter(): OpenAPIHono {
  const router = createOpenAPIApp();

  router.openapi(healthzRoute, (c) => c.json({ status: "ok" as const }, 200));
  router.openapi(readyzRoute, (c) => c.json({ status: "ready" as const }, 200));

  return router;
}

export function createRuntimesRouter(
  runtimeRegistry?: RuntimeRegistry,
  modelCatalog: RuntimeModelCatalog = new RuntimeModelCatalog(),
): OpenAPIHono {
  const router = createOpenAPIApp();

  router.openapi(listRuntimesRoute, async (c) => {
    if (!runtimeRegistry) return c.json({ runtimes: [] }, 200);
    const { includeInternal: includeInternalParam } = c.req.valid("query");
    const includeInternal = includeInternalParam !== "false" && includeInternalParam !== "0";
    const runtimes = await modelCatalog.listRuntimes(runtimeRegistry, { includeInternal });
    return c.json({ runtimes }, 200);
  });

  router.openapi(listRuntimeModelsRoute, async (c) => {
    if (!runtimeRegistry) return c.json({ error: "runtime_not_found" }, 404);
    const { runtimeType: rawRuntimeType } = c.req.valid("param");
    const runtimeType = rawRuntimeType.trim().toLowerCase();
    const meta = runtimeRegistry.listRuntimes().find((r) => r.type === runtimeType);
    if (!meta) return c.json({ error: "runtime_not_found" }, 404);
    const models = await modelCatalog.listModels(runtimeRegistry, meta.type);
    return c.json(
      {
        runtime: meta.type,
        defaultReasoningEfforts: meta.defaultReasoningEfforts ?? [],
        models,
      },
      200,
    );
  });

  return router;
}
