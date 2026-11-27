import type { OpenAPIHono } from "@hono/zod-openapi";
import { AppError, ErrorCode } from "../../domain/errors.ts";
import type { Logger } from "../../observability/logger.ts";
import type { ProjectManager } from "../../project/manager.ts";
import { createOpenAPIApp } from "../openapi.ts";

export interface HooksRouteDeps {
  readonly projects: ProjectManager;
  /** Logs the errors hooks throw, which reach no API client to see them. */
  readonly logger: Logger;
}

/** Where a project's hook receives requests. */
export function hookPath(projectId: string, hookId: string): string {
  return `/hooks/${projectId}/${hookId}`;
}

/**
 * Passes requests for `/hooks/{projectId}/{hookId}`, of any method, to the project's hook as
 * they arrived. Hooks answer external platforms, which cannot send the API token, so these
 * routes sit outside `/api/v1` and its authentication; each hook verifies its sender itself.
 * Their requests and responses are the hook's own, so they are left out of the OpenAPI document.
 */
export function createHooksRouter(deps: HooksRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp({ logger: deps.logger });
  router.all("/hooks/:projectId/:hookId", async (c) => {
    const { projectId, hookId } = c.req.param();
    try {
      const response = await deps.projects.get(projectId).handleHook(hookId, c.req.raw);
      // Rebuilt through the context so headers set by middleware (trace and request IDs) stay.
      return c.newResponse(response.body, response);
    } catch (error) {
      if (error instanceof AppError) throw error;
      deps.logger.error("project hook failed", {
        projectId,
        hookId,
        method: c.req.method,
        path: c.req.path,
        error,
      });
      return c.json({ error: ErrorCode.INTERNAL_ERROR }, 500);
    }
  });
  return router;
}
