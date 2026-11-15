import type {
  ITaskExecutor,
  TaskDefinition,
  TaskExecutionContext,
  TaskRunResult,
} from "../../src/task/types.ts";

export interface MockTaskExecutorOptions {
  readonly success?: boolean | undefined;
  readonly delayMs?: number | undefined;
  readonly stateAfter?: Record<string, unknown> | undefined;
  readonly error?: string | undefined;
  readonly actionsSummary?: Record<string, unknown> | undefined;
  readonly handler?:
    | ((context: TaskExecutionContext) => Promise<TaskRunResult> | TaskRunResult)
    | undefined;
}

/**
 * 测试环境专属的 Mock 执行器，绝不污染生产目录
 */
export class MockTaskExecutor implements ITaskExecutor {
  readonly type: string;
  readonly calls: TaskExecutionContext[] = [];

  constructor(
    private options: MockTaskExecutorOptions = {},
    type = "mock",
  ) {
    this.type = type;
  }

  setOptions(options: MockTaskExecutorOptions): void {
    this.options = options;
  }

  canHandle(task: TaskDefinition): boolean {
    return task.type === this.type || task.executor === this.type;
  }

  async execute(context: TaskExecutionContext): Promise<TaskRunResult> {
    this.calls.push(context);
    const started = Date.now();

    if (this.options.delayMs && this.options.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.delayMs);
        if (context.signal) {
          context.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Task aborted"));
          });
        }
      });
    }

    if (this.options.handler) {
      return this.options.handler(context);
    }

    const durationMs = Date.now() - started;
    const success = this.options.success ?? (this.options.error === undefined);
    const stateAfter = this.options.stateAfter ?? context.stateBefore;

    if (context.updateState && this.options.stateAfter) {
      context.updateState(this.options.stateAfter);
    }

    return {
      success,
      durationMs,
      stateBefore: context.stateBefore,
      stateAfter,
      ...(this.options.error !== undefined ? { error: this.options.error } : {}),
      ...(this.options.actionsSummary !== undefined
        ? { actionsSummary: this.options.actionsSummary }
        : {}),
    };
  }
}
