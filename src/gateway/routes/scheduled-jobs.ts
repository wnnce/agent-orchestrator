import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ScheduledJobStatusCode } from "../../domain/types.ts";
import type { Store } from "../../persistence/store.ts";
import { cancelScheduledJobRoute, listScheduledJobsRoute } from "../contracts/scheduled-jobs.ts";
import { createOpenAPIApp } from "../openapi.ts";

export interface ScheduledJobsRouteDeps {
  store: Store;
}

export function createScheduledJobsRouter(deps: ScheduledJobsRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  router.openapi(listScheduledJobsRoute, async (c) => {
    const { sessionId, projectId, status, limit } = c.req.valid("query");
    const jobs = await deps.store.listScheduledJobs({
      sessionId,
      projectId,
      status: status as ScheduledJobStatusCode | undefined,
      limit: limit ?? 50,
    });
    return c.json({ jobs }, 200);
  });

  router.openapi(cancelScheduledJobRoute, async (c) => {
    const { jobId } = c.req.valid("param");
    const success = await deps.store.cancelScheduledJobById(jobId);
    return c.json({ success, jobId }, 200);
  });

  return router;
}
