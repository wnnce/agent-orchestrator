import { Hono } from "hono";
import type { Store } from "../../persistence/store.ts";

export interface ActionsRouteDeps {
  store: Store;
}

export function createActionsRouter(deps: ActionsRouteDeps): Hono {
  const router = new Hono();

  router.get("/action-executions", async (c) => {
    const projectId = c.req.query("projectId");
    const sessionId = c.req.query("sessionId");
    const actionName = c.req.query("actionName");
    const limitStr = c.req.query("limit");
    const limit = limitStr !== undefined ? Number(limitStr) : 50;
    const executions = await deps.store.listActionExecutions({
      projectId: projectId || undefined,
      sessionId: sessionId || undefined,
      actionName: actionName || undefined,
      limit,
    });
    return c.json({ executions });
  });

  return router;
}
