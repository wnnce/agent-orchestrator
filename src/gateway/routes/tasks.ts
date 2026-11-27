import type { OpenAPIHono } from "@hono/zod-openapi";
import { fetchPage } from "../../persistence/pagination.ts";
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
    const scheduler = runtime.taskScheduler;
    const tasks = (await runtime.listTasks()).map((task) => ({
      ...task,
      isScheduled: scheduler.isScheduled(task.taskKey),
      nextRun: scheduler.getNextRun(task.taskKey)?.toISOString() ?? null,
    }));
    return c.json({ projectId, tasks }, 200);
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
    const taskKey = `${projectId}:${taskId}`;
    const { items: executions, hasMore } = await fetchPage(query.limit ?? 20, (limit) =>
      deps.store.listTaskExecutions(taskKey, limit, undefined, {
        beforeId: query.beforeId ?? query.cursor,
        status: query.status,
      }),
    );
    const nextBeforeId = hasMore ? (executions.at(-1)?.id ?? null) : null;
    return c.json({ taskKey, executions, hasMore, nextBeforeId }, 200);
  });

  router.openapi(listGlobalTaskExecutionsRoute, async (c) => {
    const query = c.req.valid("query");
    const { items: executions, hasMore } = await fetchPage(query.limit ?? 50, (limit) =>
      deps.store.listTaskExecutions(query.taskKey, limit, query.projectId, {
        beforeId: query.beforeId ?? query.cursor,
        status: query.status,
      }),
    );
    const nextBeforeId = hasMore ? (executions.at(-1)?.id ?? null) : null;
    return c.json({ executions, hasMore, nextBeforeId }, 200);
  });

  router.openapi(listTaskExecutionLogsRoute, async (c) => {
    const { executionId } = c.req.valid("param");
    const query = c.req.valid("query");
    const afterSequence = query.afterSeq && query.afterSeq > 0 ? query.afterSeq : undefined;
    const { items: logs, hasMore } = await fetchPage(query.limit ?? 200, (limit) =>
      deps.store.listTaskExecutionLogs(executionId, { afterSequence, level: query.level, limit }),
    );
    const nextAfterSeq = logs.at(-1)?.sequence ?? afterSequence ?? 0;

    return c.json({ executionId, logs, hasMore, nextAfterSeq }, 200);
  });

  return router;
}
