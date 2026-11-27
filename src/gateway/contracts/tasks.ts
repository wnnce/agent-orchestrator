import { createRoute, z } from "@hono/zod-openapi";
import { REASONING_EFFORTS } from "../../domain/types.ts";
import {
  badRequestResponse,
  jsonContent,
  notFoundResponse,
  projectIdParamSchema,
} from "./common.ts";

export const taskExecutionStatusSchema = z.enum([
  "success",
  "failed",
  "skipped_overlapping",
  "timeout",
]);

export const taskExecutionLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const taskWithScheduleSchema = z
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
  .openapi("TaskWithSchedule");

export const taskExecutionRecordSchema = z
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
  .openapi("TaskExecutionRecord");

export const taskExecutionLogRecordSchema = z
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
  .openapi("TaskExecutionLogRecord");

const taskExecutionsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .openapi({ description: "Page size (1–200, default: 20)" }),
  beforeId: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: "Cursor ID for pagination" }),
  cursor: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ description: "Alias for `beforeId`" }),
  status: taskExecutionStatusSchema.optional(),
});

const projectTaskParamsSchema = projectIdParamSchema.extend({
  taskId: z
    .string()
    .min(1)
    .openapi({ param: { name: "taskId", in: "path" } }),
});

export const listProjectTasksRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/tasks",
  tags: ["Tasks"],
  summary: "List tasks configured for a project",
  request: {
    params: projectIdParamSchema,
  },
  responses: {
    200: jsonContent(
      z.object({ projectId: z.string(), tasks: z.array(taskWithScheduleSchema) }),
      "Project tasks with current schedule state",
    ),
    404: notFoundResponse,
  },
});

export const runProjectTaskRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/tasks/{taskId}/run",
  tags: ["Tasks"],
  summary: "Trigger immediate execution of a project task",
  request: {
    params: projectTaskParamsSchema,
  },
  responses: {
    200: jsonContent(
      z.object({
        projectId: z.string(),
        taskId: z.string(),
        queued: z.boolean(),
        message: z.string(),
      }),
      "Task dispatch status",
    ),
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

export const listTaskExecutionsRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/tasks/{taskId}/executions",
  tags: ["Tasks"],
  summary: "List execution history for a specific task",
  request: {
    params: projectTaskParamsSchema,
    query: taskExecutionsQuerySchema,
  },
  responses: {
    200: jsonContent(
      z.object({
        taskKey: z.string(),
        executions: z.array(taskExecutionRecordSchema),
        hasMore: z.boolean(),
        nextBeforeId: z.number().int().nullable(),
      }),
      "Paginated task execution history",
    ),
  },
});

export const listGlobalTaskExecutionsRoute = createRoute({
  method: "get",
  path: "/tasks/executions",
  tags: ["Tasks"],
  summary: "List task executions across projects",
  request: {
    query: taskExecutionsQuerySchema.extend({
      projectId: z.string().min(1).optional(),
      taskKey: z.string().min(1).optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .openapi({ description: "Page size (1–200, default: 50)" }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        executions: z.array(taskExecutionRecordSchema),
        hasMore: z.boolean(),
        nextBeforeId: z.number().int().nullable(),
      }),
      "Paginated global task execution list",
    ),
  },
});

export const listTaskExecutionLogsRoute = createRoute({
  method: "get",
  path: "/tasks/executions/{executionId}/logs",
  tags: ["Tasks"],
  summary: "Fetch structured logs for a task execution",
  request: {
    params: z.object({
      executionId: z
        .string()
        .min(1)
        .openapi({ param: { name: "executionId", in: "path" } }),
    }),
    query: z.object({
      afterSeq: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .openapi({ description: "Return logs with sequence > afterSeq" }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .openapi({ description: "Page size (1–1000, default: 200)" }),
      level: taskExecutionLogLevelSchema.optional(),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        executionId: z.string(),
        logs: z.array(taskExecutionLogRecordSchema),
        hasMore: z.boolean(),
        nextAfterSeq: z.number().int(),
      }),
      "Paginated task execution logs",
    ),
  },
});
