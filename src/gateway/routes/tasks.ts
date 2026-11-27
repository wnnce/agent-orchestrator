import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Store } from "../../persistence/store.ts";
import type { ProjectManager } from "../../project/manager.ts";
import {
  listGlobalTaskExecutionsRoute,
  listProjectTasksRoute,
  listTaskExecutionLogsRoute,
  listTaskExecutionsRoute,
  runProjectTaskRoute,
} from "../contracts/tasks.ts";
import { createOpenAPIApp } from "../openapi.ts";

export interface TasksRouteDeps {
  projects: ProjectManager;
  store: Store;
}

export function createTasksRouter(deps: TasksRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  router.openapi(listProjectTasksRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const runtime = deps.projects.get(projectId);
    const tasks = await runtime.listTasks();
    const scheduled = runtime.taskScheduler.getScheduledTasks();
    const scheduledMap = new Map(scheduled.map((s) => [s.taskKey, s]));
    const result = tasks.map((t) => ({
      ...t,
      isScheduled: runtime.taskScheduler.isScheduled(t.taskKey),
      nextRun: scheduledMap.get(t.taskKey)?.nextRun?.toISOString() ?? null,
    }));
    return c.json({ projectId, tasks: result }, 200);
  });

  router.openapi(runProjectTaskRoute, async (c) => {
    const { projectId, taskId } = c.req.valid("param");
    const runtime = deps.projects.get(projectId);
    const queued = await runtime.runTask(taskId);
    return c.json(
      {
        projectId,
        taskId,
        queued,
        message: queued
          ? "task dispatched successfully"
          : "task already running or queued (single-flight skipped)",
      },
      200,
    );
  });

  router.openapi(listTaskExecutionsRoute, async (c) => {
    const { projectId, taskId } = c.req.valid("param");
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
    return c.json({ taskKey, executions, hasMore, nextBeforeId }, 200);
  });

  router.openapi(listGlobalTaskExecutionsRoute, async (c) => {
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
    return c.json({ executions, hasMore, nextBeforeId }, 200);
  });

  router.openapi(listTaskExecutionLogsRoute, async (c) => {
    const { executionId } = c.req.valid("param");
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
    const nextAfterSeq = logs.length > 0 ? logs[logs.length - 1]!.sequence : (afterSequence ?? 0);

    return c.json({ executionId, logs, hasMore, nextAfterSeq }, 200);
  });

  return router;
}
