import { Hono } from "hono";
import { RuntimeModelCatalog } from "../../runtime/catalog.ts";
import type { RuntimeRegistry } from "../../runtime/registry.ts";

export function createSystemRouter(
  runtimeRegistry?: RuntimeRegistry,
  modelCatalog: RuntimeModelCatalog = new RuntimeModelCatalog(),
): Hono {
  const router = new Hono();
  router.get("/healthz", (c) => c.json({ status: "ok" }));
  router.get("/readyz", (c) => c.json({ status: "ready" }));

  router.get("/runtimes", async (c) => {
    if (!runtimeRegistry) return c.json({ runtimes: [] });
    const includeInternalParam = c.req.query("includeInternal");
    const includeInternal = includeInternalParam !== "false" && includeInternalParam !== "0";
    const runtimes = await modelCatalog.listRuntimes(runtimeRegistry, { includeInternal });
    return c.json({ runtimes });
  });

  router.get("/runtimes/:runtimeType/models", async (c) => {
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
  });

  return router;
}
