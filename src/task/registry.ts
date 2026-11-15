import { Logger } from "../observability/logger.ts";
import type { ITaskExecutor, TaskDefinition } from "./types.ts";

export class TaskExecutorRegistry {
  private readonly executors = new Map<string, ITaskExecutor>();

  constructor(private readonly logger = new Logger()) {}

  register(executor: ITaskExecutor): this {
    if (this.executors.has(executor.type)) {
      this.logger.warn("overwriting existing task executor", { type: executor.type });
    }
    this.executors.set(executor.type, executor);
    return this;
  }

  get(type: string): ITaskExecutor | undefined {
    return this.executors.get(type);
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  unregister(type: string): boolean {
    return this.executors.delete(type);
  }

  getAll(): ITaskExecutor[] {
    return Array.from(this.executors.values());
  }

  /**
   * Resolves the appropriate executor for a task:
   * 1. Match explicitly by task.type or task.executor
   * 2. Fall back to scanning registered executors via canHandle
   */
  resolve(task: TaskDefinition): ITaskExecutor {
    // 1. Direct match by task.executor or task.type
    const taskType = task.executor ?? task.type ?? "agent";
    const direct = this.executors.get(taskType);
    if (direct && direct.canHandle(task)) {
      return direct;
    }

    // 2. Iterate registered executors to find candidate via canHandle
    for (const executor of this.executors.values()) {
      if (executor.canHandle(task)) {
        return executor;
      }
    }

    throw new Error(
      `No task executor found capable of handling task "${task.taskKey}" (executor/type: "${taskType}")`,
    );
  }
}
