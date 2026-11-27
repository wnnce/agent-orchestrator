import { createRoute, z } from "@hono/zod-openapi";
import { jsonContent } from "./common.ts";

const ownerKindSchema = z.enum(["task", "pipeline"]);

export const toolExecutionRecordSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    executionId: z.string(),
    projectId: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    ownerKind: z.enum(["session", "task", "pipeline", "hook"]).optional().openapi({
      description: "Kind of the task execution or pipeline node run the session works for",
    }),
    ownerId: z.string().optional(),
    toolName: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    status: z.enum(["success", "failure"]),
    result: z.unknown().optional(),
    errorMessage: z.string().optional(),
    durationMs: z.number(),
    createdAt: z.string().optional(),
  })
  .openapi("ToolExecutionRecord");

export const listToolExecutionsRoute = createRoute({
  method: "get",
  path: "/tool-executions",
  tags: ["Tools"],
  summary: "List the tool calls agents made",
  request: {
    query: z.object({
      projectId: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      toolName: z.string().min(1).optional(),
      ownerKind: ownerKindSchema.optional(),
      ownerId: z.string().min(1).optional(),
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
      z.object({ executions: z.array(toolExecutionRecordSchema) }),
      "Tool execution records",
    ),
  },
});
