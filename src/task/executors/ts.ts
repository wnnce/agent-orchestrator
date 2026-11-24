import { createActionContext } from "../../actions/context.ts";
import type { ActionRegistry } from "../../actions/registry.ts";
import type { ActionContext, ActionResult } from "../../actions/types.ts";
import type { TaskExecutionLogRecord } from "../../domain/types.ts";
import { Logger } from "../../observability/logger.ts";
import { TaskLogBuffer } from "../log-buffer.ts";
import type { TaskRunContext, TsTaskHandler, TsTaskResult } from "../sdk.ts";
import type {
  ITaskExecutor,
  TaskDefinition,
  TaskExecutionContext,
  TaskRunResult,
} from "../types.ts";

export interface TsTaskExecutorOptions {
  readonly resolveHandler: (task: TaskDefinition) => Promise<TsTaskHandler>;
  readonly actionRegistry?: ActionRegistry | undefined;
  readonly getEnv?: ((projectId: string) => Record<string, string> | undefined) | undefined;
  readonly getWorkdir?: ((projectId: string) => string | undefined) | undefined;
  readonly createActionContext?:
    | ((context: TaskExecutionContext) => ActionContext)
    | undefined;
  readonly appendLogs?:
    | ((logs: readonly TaskExecutionLogRecord[]) => Promise<void>)
    | undefined;
  readonly logFlushThreshold?: number | undefined;
  readonly logMaxBatchSize?: number | undefined;
  readonly logMaxConsecutiveFailures?: number | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * TypeScript task executor (`type: "ts"`).
 * Dynamically injects a Pi-style capability context (`TaskRunContext`) into the task's `run(ctx)` handler.
 */
export class TsTaskExecutor implements ITaskExecutor {
  readonly type = "ts";

  constructor(
    private readonly options: TsTaskExecutorOptions,
    private readonly logger = new Logger(),
  ) {}

  canHandle(task: TaskDefinition): boolean {
    return task.type === "ts" || task.sourceFormat === "typescript";
  }

  async execute(context: TaskExecutionContext): Promise<TaskRunResult> {
    const started = Date.now();
    const { task } = context;

    const workdir =
      (this.options.getWorkdir ? this.options.getWorkdir(task.projectId) : undefined) ??
      context.workspacePath ??
      process.cwd();
    const env: Readonly<Record<string, string>> = Object.freeze({
      ...(this.options.getEnv ? (this.options.getEnv(task.projectId) ?? {}) : {}),
    });

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

    let localState: Record<string, unknown> = { ...context.stateBefore };

    const actionContext: ActionContext = this.options.createActionContext
      ? this.options.createActionContext(effectiveContext)
      : context.createActionContext
        ? context.createActionContext({
            sessionId: `task_ts_${task.taskId}`,
            signal,
          })
        : createActionContext({
            projectId: task.projectId,
            sessionId: `task_ts_${task.taskId}`,
            taskKey: task.taskKey,
            workspacePath: workdir,
            logger: this.logger,
            signal,
            onGetTaskState: async () => ({ ...localState }),
            onUpdateTaskState: async (delta, opts) => {
              localState = opts?.merge === false ? { ...delta } : { ...localState, ...delta };
              context.updateState?.(localState);
              return { ...localState };
            },
          });

    const getState = async (): Promise<Record<string, unknown>> => {
      const current = await actionContext.getTaskState();
      localState = { ...current };
      return { ...current };
    };

    const updateState = async (
      delta: Record<string, unknown>,
      opts?: { merge?: boolean | undefined },
    ): Promise<Record<string, unknown>> => {
      const updated = await actionContext.updateTaskState(delta, opts);
      localState = { ...updated };
      context.updateState?.(localState);
      return { ...updated };
    };

    const logBuffer =
      context.executionId && this.options.appendLogs
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
          {
            projectId: task.projectId,
            taskKey: task.taskKey,
            ...(context.executionId ? { executionId: context.executionId } : {}),
          },
          (entry) => logBuffer.push(entry),
          { captureAllLevels: true },
        )
      : this.logger.child({ projectId: task.projectId, taskKey: task.taskKey });

    const runContext: TaskRunContext = {
      projectId: task.projectId,
      taskId: task.taskId,
      taskKey: task.taskKey,
      taskName: task.name,
      workdir,
      env,
      logger: taskLogger,
      signal,
      state: Object.freeze({ ...context.stateBefore }),
      getState,
      updateState,
      notify: (message, options) => actionContext.notify(message, options),
      createArtifact: (params) => actionContext.createArtifact(params),
      emit: (type, payload) => actionContext.emit(type, payload),
      dispatchTask: (params) => actionContext.dispatchTask(params),
      invokeAction: async <T = unknown>(
        name: string,
        params: Record<string, unknown>,
      ): Promise<ActionResult<T>> => {
        if (!this.options.actionRegistry) {
          throw new Error("ActionRegistry is not configured for TS task execution");
        }
        return this.options.actionRegistry.execute<T>(name, params, actionContext);
      },
    };

    try {
      const handler = await this.options.resolveHandler(task);

      this.logger.info("starting ts task execution", {
        ...(context.executionId ? { executionId: context.executionId } : {}),
        taskKey: task.taskKey,
        taskId: task.taskId,
        projectId: task.projectId,
      });

      const output = await runWithAbort(Promise.resolve().then(() => handler(runContext)), signal);

      if (output !== undefined && !isPlainRecord(output)) {
        throw new Error(
          `TS task "${task.taskKey}" returned an invalid value: expected void or a plain result object`,
        );
      }

      const typedOutput = output as TsTaskResult | undefined;
      if (typedOutput?.state !== undefined) {
        if (!isPlainRecord(typedOutput.state)) {
          throw new Error(
            `TS task "${task.taskKey}" returned an invalid "state" field: expected a plain object`,
          );
        }
        await updateState(typedOutput.state, { merge: typedOutput.mergeState });
      }

      const stateAfter = await getState();
      const summary = isPlainRecord(typedOutput?.summary) ? typedOutput.summary : undefined;

      return {
        success: true,
        durationMs: Date.now() - started,
        stateBefore: context.stateBefore,
        stateAfter,
        ...(summary !== undefined ? { actionsSummary: summary } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("ts task execution failed", {
        ...(context.executionId ? { executionId: context.executionId } : {}),
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
      if (logBuffer) {
        await logBuffer.flush();
      }
    }
  }
}

async function runWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw toAbortError(signal.reason);
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(toAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" && reason ? reason : "TS task execution aborted");
}
