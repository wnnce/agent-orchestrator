import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Store } from "../../persistence/store.ts";
import { listToolExecutionsRoute } from "../contracts/tools.ts";
import { createOpenAPIApp } from "../openapi.ts";

export interface ToolsRouteDeps {
  store: Store;
}

export function createToolsRouter(deps: ToolsRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  router.openapi(listToolExecutionsRoute, async (c) => {
    const { projectId, sessionId, toolName, ownerKind, ownerId, limit } = c.req.valid("query");
    const executions = await deps.store.listToolExecutions({
      projectId,
      sessionId,
      toolName,
      ownerKind,
      ownerId,
      limit: limit ?? 50,
    });
    return c.json({ executions }, 200);
  });

  return router;
}
