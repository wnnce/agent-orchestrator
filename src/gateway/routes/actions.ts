import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Store } from "../../persistence/store.ts";
import { listActionExecutionsRoute } from "../contracts/actions.ts";
import { createOpenAPIApp } from "../openapi.ts";

export interface ActionsRouteDeps {
  store: Store;
}

export function createActionsRouter(deps: ActionsRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  router.openapi(listActionExecutionsRoute, async (c) => {
    const { projectId, sessionId, actionName, limit } = c.req.valid("query");
    const executions = await deps.store.listActionExecutions({
      projectId,
      sessionId,
      actionName,
      limit: limit ?? 50,
    });
    return c.json({ executions }, 200);
  });

  return router;
}
