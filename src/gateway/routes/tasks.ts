import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { REASONING_EFFORTS } from "../../domain/types.ts";
import type { Store } from "../../persistence/store.ts";
import type { ProjectManager } from "../../project/manager.ts";

export interface TasksRouteDeps {
  projects: ProjectManager;
  store: Store;
}

const taskExecutionStatusSchema = z.enum([
  "success",
  "failed",
  "skipped_overlapping",
  "timeout",
]);

const taskExecutionLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const taskWithScheduleSchema = z
  .object({
    taskKey: z.string(),
    projectId: z.string(),
    taskId: z.string(),
    name: z.string(),
    cron: z.string(),
    timezone: z.string().optional(),
    enabled: z.boolean(),
    description: z.string().optional(),
    promptTemplate: z.string(),
    filePath: z.string(),
    sourceFormat: z.enum(["markdown", "typescript"]).optional(),
    type: z.string().optional(),
    executor: z.string().optional(),
    timeoutMs: z.number().optional(),
    runtime: z
      .object({
        type: z.string().optional(),
        model: z.string().optional(),
        reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
      })
      .optional(),
    isScheduled: z.boolean(),
    nextRun: z.string().nullable(),
  })
  .meta({ ref: "TaskWithSchedule" });

const taskExecutionRecordSchema = z
  .object({
    id: z.number().int().optional(),
    executionId: z.string(),
    taskKey: z.string(),
    projectId: z.string(),
    taskId: z.string(),
    taskType: z.enum(["project_task", "scheduled_job"]),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    status: taskExecutionStatusSchema,
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    durationMs: z.number().optional(),
    stateBefore: z.record(z.string(), z.unknown()).optional(),
    stateAfter: z.record(z.string(), z.unknown()).optional(),
    actionsSummary: z.record(z.string(), z.unknown()).optional(),
    errorMessage: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .meta({ ref: "TaskExecutionRecord" });

const taskExecutionLogRecordSchema = z
  .object({
    id: z.number().int().optional(),
    executionId: z.string(),
    projectId: z.string(),
    taskKey: z.string(),
    sequence: z.number().int(),
    level: taskExecutionLogLevelSchema,
    message: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string(),
  })
  .meta({ ref: "TaskExecutionLogRecord" });

const taskExecutionsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Page size (1–200, default: 20)"),
  beforeId: z.coerce.number().int().positive().optional().describe("Cursor ID for pagination"),
  cursor: z.coerce.number().int().positive().optional().describe("Alias for `beforeId`"),
  status: taskExecutionStatusSchema.optional(),
});

const globalTaskExecutionsQuerySchema = taskExecutionsQuerySchema.extend({
  projectId: z.string().min(1).optional(),
  taskKey: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Page size (1–200, default: 50)"),
});

const taskExecutionLogsQuerySchema = z.object({
  afterSeq: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Return logs with sequence > afterSeq"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Page size (1–1000, default: 200)"),
  level: taskExecutionLogLevelSchema.optional(),
});

export function createTasksRouter(deps: TasksRouteDeps): Hono {
  const router = new Hono();

  router.get(
    "/projects/:projectId/tasks",
    describeRoute({
      tags: ["Tasks"],
      summary: "List tasks configured for a project",
      responses: {
        200: {
          description: "Project tasks with current schedule state",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ projectId: z.string(), tasks: z.array(taskWithScheduleSchema) }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId");
      try {
        const runtime = deps.projects.get(projectId);
        const tasks = await runtime.listTasks();
        const scheduled = runtime.taskScheduler.getScheduledTasks();
        const scheduledMap = new Map(scheduled.map((s) => [s.taskKey, s]));
        const result = tasks.map((t) => ({
          ...t,
          isScheduled: runtime.taskScheduler.isScheduled(t.taskKey),
          nextRun: scheduledMap.get(t.taskKey)?.nextRun?.toISOString() ?? null,
        }));
        return c.json({ projectId, tasks: result });
      } catch {
        return c.json({ error: `project not found: ${projectId}` }, 404);
      }
    },
  );

  router.post(
    "/projects/:projectId/tasks/:taskId/run",
    describeRoute({
      tags: ["Tasks"],
      summary: "Trigger immediate execution of a project task",
      responses: {
        200: {
          description: "Task dispatch status",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  projectId: z.string(),
                  taskId: z.string(),
                  queued: z.boolean(),
                  message: z.string(),
                }),
              ),
            },
          },
        },
        400: { $ref: "#/components/responses/BadRequest" },
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId");
      const taskId = c.req.param("taskId");
      try {
        const runtime = deps.projects.get(projectId);
        const queued = await runtime.runTask(taskId);
        return c.json({
          projectId,
          taskId,
          queued,
          message: queued
            ? "task dispatched successfully"
            : "task already running or queued (single-flight skipped)",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 400);
      }
    },
  );

  router.get(
    "/projects/:projectId/tasks/:taskId/executions",
    describeRoute({
      tags: ["Tasks"],
      summary: "List execution history for a specific task",
      responses: {
        200: {
          description: "Paginated task execution history",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  taskKey: z.string(),
                  executions: z.array(taskExecutionRecordSchema),
                  hasMore: z.boolean(),
                  nextBeforeId: z.number().int().nullable(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("query", taskExecutionsQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const taskId = c.req.param("taskId");
      const query = c.req.valid("query");
      const effectiveLimit = query.limit ?? 20;
      const beforeId = query.beforeId ?? query.cursor;
      const taskKey = `${projectId}:${taskId}`;
      const rows = await deps.store.listTaskExecutions(taskKey, effectiveLimit + 1, undefined, {
        beforeId,
        status: query.status,
      });
      const hasMore = rows.length > effectiveLimit;
      const executions = hasMore ? rows.slice(0, effectiveLimit) : rows;
      const lastId = executions.length > 0 ? executions[executions.length - 1]?.id : undefined;
      const nextBeforeId = hasMore && typeof lastId === "number" ? lastId : null;
      return c.json({ taskKey, executions, hasMore, nextBeforeId });
    },
  );

  router.get(
    "/tasks/executions",
    describeRoute({
      tags: ["Tasks"],
      summary: "List task executions across projects",
      responses: {
        200: {
          description: "Paginated global task execution list",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  executions: z.array(taskExecutionRecordSchema),
                  hasMore: z.boolean(),
                  nextBeforeId: z.number().int().nullable(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("query", globalTaskExecutionsQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const effectiveLimit = query.limit ?? 50;
      const beforeId = query.beforeId ?? query.cursor;
      const rows = await deps.store.listTaskExecutions(
        query.taskKey,
        effectiveLimit + 1,
        query.projectId,
        { beforeId, status: query.status },
      );
      const hasMore = rows.length > effectiveLimit;
      const executions = hasMore ? rows.slice(0, effectiveLimit) : rows;
      const lastId = executions.length > 0 ? executions[executions.length - 1]?.id : undefined;
      const nextBeforeId = hasMore && typeof lastId === "number" ? lastId : null;
      return c.json({ executions, hasMore, nextBeforeId });
    },
  );

  router.get(
    "/tasks/executions/:executionId/logs",
    describeRoute({
      tags: ["Tasks"],
      summary: "Fetch structured logs for a task execution",
      responses: {
        200: {
          description: "Paginated task execution logs",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  executionId: z.string(),
                  logs: z.array(taskExecutionLogRecordSchema),
                  hasMore: z.boolean(),
                  nextAfterSeq: z.number().int(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("query", taskExecutionLogsQuerySchema),
    async (c) => {
      const executionId = c.req.param("executionId");
      const query = c.req.valid("query");
      const effectiveLimit = query.limit ?? 200;
      const afterSequence = query.afterSeq && query.afterSeq > 0 ? query.afterSeq : undefined;

      const rows = await deps.store.listTaskExecutionLogs(executionId, {
        afterSequence,
        level: query.level,
        limit: effectiveLimit + 1,
      });
      const hasMore = rows.length > effectiveLimit;
      const logs = hasMore ? rows.slice(0, effectiveLimit) : rows;
      const nextAfterSeq =
        logs.length > 0 ? logs[logs.length - 1]!.sequence : (afterSequence ?? 0);

      return c.json({
        executionId,
        logs,
        hasMore,
        nextAfterSeq,
      });
    },
  );

  return router;
}
