import { Hono } from "hono";
import type { Store } from "../../persistence/store.ts";

export interface ScheduledJobsRouteDeps {
  store: Store;
}

export function createScheduledJobsRouter(deps: ScheduledJobsRouteDeps): Hono {
  const router = new Hono();

  router.get("/scheduled-jobs", async (c) => {
    const sessionId = c.req.query("sessionId");
    const projectId = c.req.query("projectId");
    const statusStr = c.req.query("status");
    const limitStr = c.req.query("limit");
    const status = statusStr !== undefined ? Number(statusStr) : undefined;
    const limit = limitStr !== undefined ? Number(limitStr) : 50;
    const jobs = await deps.store.listScheduledJobs({
      sessionId: sessionId || undefined,
      projectId: projectId || undefined,
      status: status !== undefined && !isNaN(status) ? (status as any) : undefined,
      limit,
    });
    return c.json({ jobs });
  });

  router.post("/scheduled-jobs/:jobId/cancel", async (c) => {
    const jobId = c.req.param("jobId");
    const success = await deps.store.cancelScheduledJobById(jobId);
    return c.json({ success, jobId });
  });

  return router;
}
