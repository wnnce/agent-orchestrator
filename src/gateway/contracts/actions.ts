import { createRoute, z } from "@hono/zod-openapi";
import { jsonContent } from "./common.ts";

export const actionExecutionRecordSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    executionId: z.string(),
    projectId: z.string(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    taskKey: z.string().optional(),
    caller: z.string(),
    actionName: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    status: z.enum(["success", "failure"]),
    result: z.unknown().optional(),
    errorMessage: z.string().optional(),
    durationMs: z.number(),
    createdAt: z.string().optional(),
  })
  .openapi("ActionExecutionRecord");

export const listActionExecutionsRoute = createRoute({
  method: "get",
  path: "/action-executions",
  tags: ["Actions"],
  summary: "List action execution audit records",
  request: {
    query: z.object({
      projectId: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      actionName: z.string().min(1).optional(),
      limit: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .openapi({ description: "Maximum number of records (default: 50)" }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({ executions: z.array(actionExecutionRecordSchema) }),
      "Action execution records",
    ),
  },
});
