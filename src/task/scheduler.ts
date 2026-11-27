import { Cron } from "croner";
import { Logger } from "../observability/logger.ts";
import { detached } from "../observability/tracing.ts";
import type { TaskDefinition } from "./types.ts";
import type { TaskEngine } from "./engine.ts";

export interface ScheduledTaskInfo {
  readonly taskKey: string;
  readonly cron: string;
  readonly timezone?: string | undefined;
  readonly nextRun: Date | null;
}

export class TaskScheduler {
  private readonly jobs = new Map<string, Cron>();
  private readonly definitions = new Map<string, TaskDefinition>();

  constructor(
    private readonly engine: TaskEngine,
    private readonly logger = new Logger(),
  ) {}

  /**
   * Registers and schedules a single task.
   * @returns true if scheduled; false if disabled or failed.
   */
  scheduleTask(task: TaskDefinition): boolean {
    this.unscheduleTask(task.taskKey);

    if (!task.enabled) {
      this.logger.info("task schedule skipped because it is disabled", {
        taskKey: task.taskKey,
        name: task.name,
      });
      return false;
    }

    try {
      const job = new Cron(
        task.cron,
        {
          ...(task.timezone ? { timezone: task.timezone } : {}),
          protect: true, // Prevent overlapping invocations if execution exceeds interval
        },
        () =>
          // A cron run starts its own trace; the timer may have been set up during a request.
          detached(() => {
            this.logger.info("cron triggered task execution", {
              taskKey: task.taskKey,
              name: task.name,
            });
            this.engine.dispatch(task);
          }),
      );

      this.jobs.set(task.taskKey, job);
      this.definitions.set(task.taskKey, task);

      const nextRun = job.nextRun();
      this.logger.info("task scheduled successfully", {
        taskKey: task.taskKey,
        cron: task.cron,
        timezone: task.timezone,
        nextRun: nextRun?.toISOString() ?? null,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("failed to schedule task", {
        taskKey: task.taskKey,
        cron: task.cron,
        error: msg,
      });
      return false;
    }
  }

  /**
   * Cancels scheduling for a task.
   */
  unscheduleTask(taskKey: string): boolean {
    const job = this.jobs.get(taskKey);
    if (!job) {
      return false;
    }

    job.stop();
    this.jobs.delete(taskKey);
    this.definitions.delete(taskKey);
    this.logger.info("task unscheduled", { taskKey });
    return true;
  }

  /**
   * Reloads tasks and reconciles additions, updates, and removals.
   */
  reloadTasks(tasks: readonly TaskDefinition[]): void {
    const newTaskKeys = new Set<string>();

    for (const task of tasks) {
      newTaskKeys.add(task.taskKey);
      const existing = this.definitions.get(task.taskKey);

      // Reschedule if task is new or schedule/content properties changed
      if (
        !existing ||
        existing.cron !== task.cron ||
        existing.timezone !== task.timezone ||
        existing.enabled !== task.enabled ||
        existing.promptTemplate !== task.promptTemplate ||
        existing.fileMtimeMs !== task.fileMtimeMs
      ) {
        this.scheduleTask(task);
      }
    }

    // Unschedule removed tasks
    for (const taskKey of Array.from(this.jobs.keys())) {
      if (!newTaskKeys.has(taskKey)) {
        this.unscheduleTask(taskKey);
      }
    }
  }

  /**
   * Retrieves next run timestamp for a scheduled task.
   */
  getNextRun(taskKey: string): Date | null {
    const job = this.jobs.get(taskKey);
    return job?.nextRun() ?? null;
  }

  /**
   * Checks whether a task is currently scheduled.
   */
  isScheduled(taskKey: string): boolean {
    return this.jobs.has(taskKey);
  }

  /**
   * Returns list of all active scheduled tasks.
   */
  getScheduledTasks(): ScheduledTaskInfo[] {
    const result: ScheduledTaskInfo[] = [];
    for (const [taskKey, job] of this.jobs) {
      const def = this.definitions.get(taskKey);
      result.push({
        taskKey,
        cron: def?.cron ?? "",
        timezone: def?.timezone,
        nextRun: job.nextRun(),
      });
    }
    return result;
  }

  /**
   * Stops all active cron schedulers.
   */
  stop(): void {
    for (const [taskKey, job] of this.jobs) {
      job.stop();
      this.logger.info("task scheduler stopped", { taskKey });
    }
    this.jobs.clear();
    this.definitions.clear();
  }
}
