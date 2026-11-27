import { untilAborted } from "../../context/abort.ts";
import type { ContextOptions, ScopedContext } from "../../context/index.ts";
import type { TaskOrigin } from "../../domain/origin.ts";
import type { TaskExecutionLogRecord } from "../../domain/types.ts";
import { Logger } from "../../observability/logger.ts";
import { TaskLogBuffer } from "../log-buffer.ts";
import type { TaskContext, TaskRun } from "../sdk.ts";
import type {
  ITaskExecutor,
  TaskDefinition,
  TaskExecutionContext,
  TaskRunResult,
} from "../types.ts";

export interface TsTaskExecutorOptions {
  readonly resolveHandler: (task: TaskDefinition) => Promise<TaskRun>;
  /** The project's capabilities acting for one task execution. */
  readonly createContext: (origin: TaskOrigin, options: ContextOptions) => ScopedContext;
  readonly appendLogs?: ((logs: readonly TaskExecutionLogRecord[]) => Promise<void>) | undefined;
  readonly logFlushThreshold?: number | undefined;
  readonly logMaxBatchSize?: number | undefined;
  readonly logMaxConsecutiveFailures?: number | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runs TypeScript tasks (`type: "ts"`): calls the task's `run` with a `TaskContext` acting as this
 * execution, and saves the task state it leaves when the execution succeeds.
 */
export class TsTaskExecutor implements ITaskExecutor {
  readonly type = "ts";

  constructor(
    private readonly options: TsTaskExecutorOptions,
    private readonly logger = new Logger(),
  ) {}

  canHandle(task: TaskDefinition): boolean {
    return task.type === "ts";
  }

  async execute(context: TaskExecutionContext): Promise<TaskRunResult> {
    const started = Date.now();
    const { task } = context;

    // Combine parent AbortSignal (from TaskEngine timeoutMs) with optional defaultTimeoutMs.
    const abortController = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let onParentAbort: (() => void) | undefined;

    if (context.signal) {
      if (context.signal.aborted) {
        abortController.abort(context.signal.reason);
      } else {
        onParentAbort = () => abortController.abort(context.signal?.reason);
        context.signal.addEventListener("abort", onParentAbort, { once: true });
      }
    } else {
      const timeoutMs = task.timeoutMs ?? this.options.defaultTimeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          abortController.abort(new Error(`TS task timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    }

    const signal = abortController.signal;
    const effectiveContext: TaskExecutionContext = { ...context, signal };

    let state: Record<string, unknown> = { ...context.stateBefore };
    const setState = (next: Record<string, unknown>): void => {
      state = { ...next };
      context.updateState?.(state);
    };

    const logBuffer = this.options.appendLogs
      ? new TaskLogBuffer({
          executionId: context.executionId,
          projectId: task.projectId,
          taskKey: task.taskKey,
          writer: this.options.appendLogs,
          flushThreshold: this.options.logFlushThreshold,
          maxBatchSize: this.options.logMaxBatchSize,
          maxConsecutiveFailures: this.options.logMaxConsecutiveFailures,
          hostLogger: this.logger,
        })
      : undefined;

    const taskLogger = logBuffer
      ? this.logger.withListener(
          { projectId: task.projectId, taskKey: task.taskKey, executionId: context.executionId },
          (entry) => logBuffer.push(entry),
          { captureAllLevels: true },
        )
      : this.logger.child({ projectId: task.projectId, taskKey: task.taskKey });

    const scoped = this.options.createContext(
      {
        kind: "task",
        taskId: task.taskId,
        taskKey: task.taskKey,
        executionId: context.executionId,
      },
      {
        signal,
        logger: taskLogger,
        timezone: task.timezone,
        renderScopes: () => ({
          task: {
            id: task.taskId,
            key: task.taskKey,
            name: task.name,
            cron: task.cron,
            timezone: task.timezone ?? "",
          },
          state,
        }),
      },
    );
    const taskContext: TaskContext = {
      ...scoped.context,
      origin: {
        kind: "task",
        taskId: task.taskId,
        taskKey: task.taskKey,
        executionId: context.executionId,
      },
      task: {
        id: task.taskId,
        name: task.name,
        cron: task.cron,
        ...(task.timezone ? { timezone: task.timezone } : {}),
      },
      state: {
        get: () => state,
        set: (next) => setState(next),
        merge: (patch) => setState({ ...state, ...patch }),
      },
    };

    try {
      const handler = await this.options.resolveHandler(task);

      this.logger.info("starting ts task execution", {
        executionId: context.executionId,
        taskKey: task.taskKey,
        taskId: task.taskId,
        projectId: task.projectId,
      });

      const summary = await untilAborted(
        Promise.resolve().then(() => handler(taskContext)),
        signal,
      );
      if (summary !== undefined && !isPlainRecord(summary)) {
        throw new Error(
          `TS task "${task.taskKey}" returned an invalid value: expected nothing or a summary object`,
        );
      }

      return {
        success: true,
        durationMs: Date.now() - started,
        stateBefore: context.stateBefore,
        stateAfter: { ...state },
        ...(summary !== undefined ? { actionsSummary: summary } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("ts task execution failed", {
        executionId: context.executionId,
        taskKey: task.taskKey,
        error: msg,
      });

      return {
        success: false,
        durationMs: Date.now() - started,
        stateBefore: context.stateBefore,
        stateAfter: context.stateBefore,
        error: msg,
      };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (context.signal && onParentAbort) {
        context.signal.removeEventListener("abort", onParentAbort);
      }
      await scoped.dispose();
      if (logBuffer) {
        await logBuffer.flush();
      }
    }
  }
}
