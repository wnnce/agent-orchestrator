import { randomUUID } from "node:crypto";
import { Logger } from "../observability/logger.ts";
import { SpanStatusCode, captureTraceContext, withSpan } from "../observability/tracing.ts";
import type { Store } from "../persistence/store.ts";
import type { TaskExecutorRegistry } from "./registry.ts";
import type {
  QueuedTask,
  TaskDefinition,
  TaskEngineOptions,
  TaskExecutionContext,
  TaskExecutor,
  TaskRunResult,
} from "./types.ts";

export class TaskEngine {
  private readonly queue: QueuedTask[] = [];
  private readonly runningTasks = new Set<string>(); // Single-flight task lock set
  private readonly stateCache = new Map<string, Record<string, unknown>>(); // In-memory incremental state cache
  private activeWorkers = 0;
  private readonly maxConcurrency: number;
  private registry?: TaskExecutorRegistry | undefined;
  private executor?: TaskExecutor | undefined;

  constructor(
    private readonly store?: Store,
    private readonly logger = new Logger(),
    options: TaskEngineOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency ?? 2;
    this.registry = options.registry;
  }

  setRegistry(registry: TaskExecutorRegistry): this {
    this.registry = registry;
    return this;
  }

  getRegistry(): TaskExecutorRegistry | undefined {
    return this.registry;
  }

  setExecutor(executor: TaskExecutor): this {
    this.executor = executor;
    return this;
  }

  /**
   * Enqueues a task for worker execution with single-flight deduplication.
   * @returns true if queued; false if already queued or running.
   */
  dispatch(task: TaskDefinition): boolean {
    if (this.runningTasks.has(task.taskKey)) {
      this.logger.warn("skipping overlapping task execution", {
        taskKey: task.taskKey,
        name: task.name,
      });
      return false;
    }

    this.runningTasks.add(task.taskKey);
    this.queue.push({
      taskKey: task.taskKey,
      projectId: task.projectId,
      taskId: task.taskId,
      task,
      enqueuedAt: new Date(),
      traceContext: captureTraceContext(),
    });

    this.logger.info("task enqueued for execution", {
      taskKey: task.taskKey,
      queueLength: this.queue.length,
      activeWorkers: this.activeWorkers,
    });

    void this.processNext();
    return true;
  }

  /**
   * Retrieves task incremental state (memory-first, hydrated from store on cold start).
   */
  async getState(taskKey: string): Promise<Record<string, unknown>> {
    const cached = this.stateCache.get(taskKey);
    if (cached) {
      return cached;
    }

    if (this.store) {
      try {
        const persisted = await this.store.getLatestTaskExecutionState(taskKey);
        if (persisted) {
          this.stateCache.set(taskKey, persisted);
          return persisted;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error("failed to hydrate task state from store", { taskKey, error: msg });
      }
    }

    return {};
  }

  /**
   * Updates in-memory incremental state cache.
   */
  updateState(taskKey: string, state: Record<string, unknown>): void {
    this.stateCache.set(taskKey, state);
  }

  /**
   * Checks whether a task is active (queued or executing).
   */
  isTaskRunning(taskKey: string): boolean {
    return this.runningTasks.has(taskKey);
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getActiveWorkers(): number {
    return this.activeWorkers;
  }

  /**
   * Waits for all queued and executing tasks to finish.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    while (this.queue.length > 0 || this.activeWorkers > 0) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`TaskEngine drain timed out after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * Worker pool execution loop.
   */
  private async processNext(): Promise<void> {
    if (this.activeWorkers >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const queued = this.queue.shift();
    if (!queued) return;

    this.activeWorkers++;
    try {
      await withSpan(
        `task ${queued.taskKey}`,
        {
          parent: queued.traceContext,
          attributes: {
            "project.id": queued.projectId,
            "task.key": queued.taskKey,
            "task.id": queued.taskId,
            ...(queued.task.type ? { "task.type": queued.task.type } : {}),
          },
        },
        async (span) => {
          if (!(await this.runQueued(queued))) span.setStatus({ code: SpanStatusCode.ERROR });
        },
      );
    } finally {
      // Release single-flight lock and worker slot, continue pumping queue
      this.runningTasks.delete(queued.taskKey);
      this.activeWorkers--;
      void this.processNext();
    }
  }

  /** Runs one queued task and records its execution; returns whether it succeeded. */
  private async runQueued(queued: QueuedTask): Promise<boolean> {
    const startedAt = new Date();
    const executionId = `exec_${randomUUID()}`;

    const abortController = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    if (queued.task.timeoutMs && queued.task.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        abortController.abort(new Error(`Task timed out after ${queued.task.timeoutMs}ms`));
      }, queued.task.timeoutMs);
    }

    try {
      // 1. Hydrate latest state (in-memory cache or cold-start persistence)
      const stateBefore = await this.getState(queued.taskKey);

      const context: TaskExecutionContext = {
        executionId,
        task: queued.task,
        stateBefore,
        signal: abortController.signal,
        updateState: (newState) => {
          this.stateCache.set(queued.taskKey, newState);
        },
      };

      // 2. Resolve executor and execute task
      let result: TaskRunResult;

      if (this.registry) {
        const executor = this.registry.resolve(queued.task);
        result = await executor.execute(context);
      } else if (this.executor) {
        if (typeof this.executor === "function") {
          result = await this.executor(queued.task, stateBefore, context);
        } else {
          result = await this.executor.execute(context);
        }
      } else {
        result = {
          success: true,
          durationMs: Date.now() - startedAt.getTime(),
          stateBefore,
          stateAfter: stateBefore,
        };
      }

      // Mark as failed if timeout triggered but executor did not catch it
      if (abortController.signal.aborted && result.success) {
        result = {
          ...result,
          success: false,
          error:
            result.error ?? `Task execution timed out after ${queued.task.timeoutMs ?? 0}ms`,
        };
      }

      // 3. Update memory state cache
      this.stateCache.set(queued.taskKey, result.stateAfter);

      // 4. Record task execution audit into store
      if (this.store) {
        await this.store.recordTaskExecution({
          executionId,
          taskKey: queued.taskKey,
          projectId: queued.projectId,
          taskId: queued.taskId,
          taskType: "project_task",
          sessionId: result.sessionId,
          status: result.success ? "success" : "failed",
          durationMs: result.durationMs,
          stateBefore: result.stateBefore,
          stateAfter: result.stateAfter,
          actionsSummary: result.actionsSummary,
          errorMessage: result.error,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
        });
      }

      this.logger.info("task execution completed", {
        executionId,
        taskKey: queued.taskKey,
        success: result.success,
        durationMs: result.durationMs,
      });
      return result.success;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("task worker execution error", {
        executionId,
        taskKey: queued.taskKey,
        error: msg,
      });

      // Record failed execution audit
      if (this.store) {
        const stateBefore = await this.getState(queued.taskKey);
        await this.store.recordTaskExecution({
          executionId,
          taskKey: queued.taskKey,
          projectId: queued.projectId,
          taskId: queued.taskId,
          taskType: "project_task",
          status: "failed",
          durationMs: Date.now() - startedAt.getTime(),
          stateBefore,
          stateAfter: stateBefore,
          errorMessage: msg,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
        });
      }
      return false;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }
}
