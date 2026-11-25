import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { ScheduledJobStatusCode } from "../../domain/types.ts";
import type { Store } from "../../persistence/store.ts";

export interface ScheduledJobsRouteDeps {
  store: Store;
}

const scheduledJobRecordSchema = z
  .object({
    id: z.number().int().optional(),
    jobId: z.string(),
    projectId: z.string(),
    sessionId: z.string(),
    name: z.string(),
    delayMinutes: z.number().int(),
    triggerAt: z.string(),
    status: z
      .number()
      .int()
      .describe("0=COMPLETED, 1=PENDING, 2=RUNNING, 3=CANCELLED, 4=ABANDONED"),
    prompt: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    resultSummary: z.string().optional(),
    finishedAt: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .meta({ ref: "ScheduledJobRecord" });

const listScheduledJobsQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  status: z.coerce
    .number()
    .int()
    .min(0)
    .max(4)
    .optional()
    .describe("Numeric status code: 0=COMPLETED, 1=PENDING, 2=RUNNING, 3=CANCELLED, 4=ABANDONED"),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of jobs (default: 50)"),
});

export function createScheduledJobsRouter(deps: ScheduledJobsRouteDeps): Hono {
  const router = new Hono();

  router.get(
    "/scheduled-jobs",
    describeRoute({
      tags: ["Scheduled Jobs"],
      summary: "List scheduled jobs",
      responses: {
        200: {
          description: "Matching scheduled jobs",
          content: {
            "application/json": {
              schema: resolver(z.object({ jobs: z.array(scheduledJobRecordSchema) })),
            },
          },
        },
      },
    }),
    validator("query", listScheduledJobsQuerySchema),
    async (c) => {
      const { sessionId, projectId, status, limit } = c.req.valid("query");
      const jobs = await deps.store.listScheduledJobs({
        sessionId,
        projectId,
        status: status as ScheduledJobStatusCode | undefined,
        limit: limit ?? 50,
      });
      return c.json({ jobs });
    },
  );

  router.post(
    "/scheduled-jobs/:jobId/cancel",
    describeRoute({
      tags: ["Scheduled Jobs"],
      summary: "Cancel a pending scheduled job",
      responses: {
        200: {
          description: "Cancellation result",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.boolean(), jobId: z.string() })),
            },
          },
        },
      },
    }),
    async (c) => {
      const jobId = c.req.param("jobId");
      const success = await deps.store.cancelScheduledJobById(jobId);
      return c.json({ success, jobId });
    },
  );

  return router;
}
