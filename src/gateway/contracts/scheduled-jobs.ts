import { createRoute, z } from "@hono/zod-openapi";
import { jsonContent } from "./common.ts";

export const scheduledJobRecordSchema = z
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
      .openapi({ description: "0=COMPLETED, 1=PENDING, 2=RUNNING, 3=CANCELLED, 4=ABANDONED" }),
    prompt: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    resultSummary: z.string().optional(),
    finishedAt: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .openapi("ScheduledJobRecord");

export const listScheduledJobsRoute = createRoute({
  method: "get",
  path: "/scheduled-jobs",
  tags: ["Scheduled Jobs"],
  summary: "List scheduled jobs",
  request: {
    query: z.object({
      sessionId: z.string().min(1).optional(),
      projectId: z.string().min(1).optional(),
      status: z.coerce.number().int().min(0).max(4).optional().openapi({
        description:
          "Numeric status code: 0=COMPLETED, 1=PENDING, 2=RUNNING, 3=CANCELLED, 4=ABANDONED",
      }),
      limit: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .openapi({ description: "Maximum number of jobs (default: 50)" }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({ jobs: z.array(scheduledJobRecordSchema) }),
      "Matching scheduled jobs",
    ),
  },
});

export const cancelScheduledJobRoute = createRoute({
  method: "post",
  path: "/scheduled-jobs/{jobId}/cancel",
  tags: ["Scheduled Jobs"],
  summary: "Cancel a pending scheduled job",
  request: {
    params: z.object({
      jobId: z
        .string()
        .min(1)
        .openapi({ param: { name: "jobId", in: "path" } }),
    }),
  },
  responses: {
    200: jsonContent(z.object({ success: z.boolean(), jobId: z.string() }), "Cancellation result"),
  },
});
