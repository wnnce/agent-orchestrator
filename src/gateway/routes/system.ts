import { Hono } from "hono";

export function createSystemRouter(): Hono {
  const router = new Hono();
  router.get("/healthz", (c) => c.json({ status: "ok" }));
  router.get("/readyz", (c) => c.json({ status: "ready" }));
  return router;
}
