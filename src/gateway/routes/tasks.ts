import { Hono } from "hono";
import type { TaskExecutionLogLevel } from "../../domain/types.ts";
import type { Store } from "../../persistence/store.ts";
import type { ProjectManager } from "../../project/manager.ts";

const VALID_LOG_LEVELS = new Set<TaskExecutionLogLevel>(["debug", "info", "warn", "error"]);

export interface TasksRouteDeps {
  projects: ProjectManager;
  store: Store;
}

export function createTasksRouter(deps: TasksRouteDeps): Hono {
  const router = new Hono();

  router.get("/projects/:projectId/tasks", async (c) => {
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
  });

  router.post("/projects/:projectId/tasks/:taskId/run", async (c) => {
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
  });

  router.get("/projects/:projectId/tasks/:taskId/executions", async (c) => {
    const projectId = c.req.param("projectId");
    const taskId = c.req.param("taskId");
    const limit = Number(c.req.query("limit") ?? 20);
    const taskKey = `${projectId}:${taskId}`;
    const executions = await deps.store.listTaskExecutions(taskKey, limit);
    return c.json({ taskKey, executions });
  });

  router.get("/tasks/executions", async (c) => {
    const projectId = c.req.query("projectId");
    const taskKey = c.req.query("taskKey");
    const limitStr = c.req.query("limit");
    const limit = limitStr !== undefined ? Number(limitStr) : 50;
    const executions = await deps.store.listTaskExecutions(
      taskKey || undefined,
      limit,
      projectId || undefined,
    );
    return c.json({ executions });
  });

  router.get("/tasks/executions/:executionId/logs", async (c) => {
    const executionId = c.req.param("executionId");
    const afterSeqStr = c.req.query("afterSeq");
    const limitStr = c.req.query("limit");
    const levelParam = c.req.query("level");

    const level =
      levelParam && VALID_LOG_LEVELS.has(levelParam as TaskExecutionLogLevel)
        ? (levelParam as TaskExecutionLogLevel)
        : undefined;
    const parsedAfterSeq = afterSeqStr !== undefined ? Number(afterSeqStr) : undefined;
    const afterSequence =
      parsedAfterSeq !== undefined && Number.isFinite(parsedAfterSeq) && parsedAfterSeq > 0
        ? Math.trunc(parsedAfterSeq)
        : undefined;
    const parsedLimit = limitStr !== undefined ? Number(limitStr) : 200;
    const effectiveLimit = Math.max(
      1,
      Math.min(Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 200, 1000),
    );

    const rows = await deps.store.listTaskExecutionLogs(executionId, {
      afterSequence,
      level,
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
  });

  return router;
}
