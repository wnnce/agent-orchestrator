import { Hono } from "hono";
import type { RuntimeRegistry } from "../../runtime/registry.ts";

export function createSystemRouter(runtimeRegistry?: RuntimeRegistry): Hono {
  const router = new Hono();
  router.get("/healthz", (c) => c.json({ status: "ok" }));
  router.get("/readyz", (c) => c.json({ status: "ready" }));
  router.get("/runtimes", (c) =>
    c.json({
      runtimes: runtimeRegistry ? runtimeRegistry.listRuntimes() : [],
    }),
  );
  return router;
}
