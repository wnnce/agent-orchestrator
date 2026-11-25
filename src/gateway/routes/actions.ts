import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { Store } from "../../persistence/store.ts";

export interface ActionsRouteDeps {
  store: Store;
}

const actionExecutionRecordSchema = z
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
  .meta({ ref: "ActionExecutionRecord" });

const listActionExecutionsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  actionName: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of records (default: 50)"),
});

export function createActionsRouter(deps: ActionsRouteDeps): Hono {
  const router = new Hono();

  router.get(
    "/action-executions",
    describeRoute({
      tags: ["Actions"],
      summary: "List action execution audit records",
      responses: {
        200: {
          description: "Action execution records",
          content: {
            "application/json": {
              schema: resolver(z.object({ executions: z.array(actionExecutionRecordSchema) })),
            },
          },
        },
      },
    }),
    validator("query", listActionExecutionsQuerySchema),
    async (c) => {
      const { projectId, sessionId, actionName, limit } = c.req.valid("query");
      const executions = await deps.store.listActionExecutions({
        projectId,
        sessionId,
        actionName,
        limit: limit ?? 50,
      });
      return c.json({ executions });
    },
  );

  return router;
}
