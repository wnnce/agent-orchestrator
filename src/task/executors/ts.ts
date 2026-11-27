import type { ContextOptions, ScopedContext } from "../../context/index.ts";
import type { TaskOrigin } from "../../domain/origin.ts";
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
    const getState = async (): Promise<Record<string, unknown>> => ({ ...localState });
    const updateState = async (
      delta: Record<string, unknown>,
      opts?: { merge?: boolean | undefined },
    ): Promise<Record<string, unknown>> => {
      localState = opts?.merge === false ? { ...delta } : { ...localState, ...delta };
      context.updateState?.(localState);
      return { ...localState };
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
          state: localState,
        }),
      },
    );
    const project = scoped.context;

    const runContext: TaskRunContext = {
      projectId: task.projectId,
      taskId: task.taskId,
      taskKey: task.taskKey,
      taskName: task.name,
      workdir: project.project.dir,
      env: project.project.env,
      vars: project.project.vars,
      logger: project.logger,
      signal,
      state: Object.freeze({ ...context.stateBefore }),
      renderPrompt: (template, extraScopes) => project.render(template, extraScopes),
      getState,
      updateState,
      notify: (message, options) => project.notify(message, options),
      createArtifact: (params) => project.artifacts.create(params),
      dispatchTask: (params) => project.sessions.start(params),
      callMcpTool: (serverName, toolName, args, callOptions) =>
        project.mcp.call(serverName, toolName, args, callOptions),
      listMcpTools: (serverName, callOptions) => project.mcp.list(serverName, callOptions),
      startPipelineRun: (params) => project.pipelines.start(params),
    };

    try {
      const handler = await this.options.resolveHandler(task);

      this.logger.info("starting ts task execution", {
        executionId: context.executionId,
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
