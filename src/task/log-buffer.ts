import type { TaskExecutionLogRecord } from "../domain/types.ts";
import type { LogEntry, Logger } from "../observability/logger.ts";

export interface TaskLogBufferOptions {
  readonly executionId: string;
  readonly projectId: string;
  readonly taskKey: string;
  readonly writer: (entries: readonly TaskExecutionLogRecord[]) => Promise<void>;
  /** Soft queue threshold that triggers an asynchronous batch insert (default: 256). */
  readonly flushThreshold?: number | undefined;
  /** Maximum entries per single batch SQL INSERT (default: 1024). */
  readonly maxBatchSize?: number | undefined;
  /**
   * Number of consecutive write failures tolerated before tripping the circuit breaker.
   * When consecutive failures exceed this number (default: 3, i.e. on the 4th consecutive failure),
   * all buffered and future logs for this execution are dropped without further DB writes.
   */
  readonly maxConsecutiveFailures?: number | undefined;
  /** Host logger for operational warnings (must NOT be the captured task logger). */
  readonly hostLogger?: Logger | undefined;
}

/**
 * Unbounded per-execution async batch log buffer with high-watermark flushing
 * and a consecutive-failure circuit breaker.
 */
export class TaskLogBuffer {
  private buffer: TaskExecutionLogRecord[] = [];
  private sequence = 0;
  private inFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private disabled = false;
  private persisted = 0;

  private readonly flushThreshold: number;
  private readonly maxBatchSize: number;
  private readonly maxConsecutiveFailures: number;

  constructor(private readonly options: TaskLogBufferOptions) {
    this.flushThreshold = Math.max(1, options.flushThreshold ?? 256);
    this.maxBatchSize = Math.max(this.flushThreshold, options.maxBatchSize ?? 1024);
    this.maxConsecutiveFailures = Math.max(0, options.maxConsecutiveFailures ?? 3);
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  get pendingCount(): number {
    return this.buffer.length;
  }

  get persistedCount(): number {
    return this.persisted;
  }

  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Appends a log entry synchronously. Triggers an asynchronous batch flush when
   * the soft threshold is reached and no flush is currently in flight.
   */
  push(entry: LogEntry): void {
    if (this.disabled) return;

    this.sequence += 1;
    this.buffer.push({
      executionId: this.options.executionId,
      projectId: this.options.projectId,
      taskKey: this.options.taskKey,
      sequence: this.sequence,
      level: entry.level,
      message: entry.message,
      ...(entry.fields !== undefined ? { fields: entry.fields } : {}),
      createdAt: entry.timestamp,
    });

    if (!this.inFlight && this.buffer.length >= this.flushThreshold) {
      this.scheduleFlush();
    }
  }

  /**
   * Waits for any in-flight flush and persists all remaining buffered logs.
   * Called in the executor's `finally` block so logs are durable before completion.
   */
  async flush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
    }

    while (!this.disabled && this.buffer.length > 0) {
      const ok = await this.writeNextBatch();
      if (!ok) {
        // Avoid stalling task completion when the database is unavailable.
        break;
      }
    }
  }

  private scheduleFlush(): void {
    if (this.disabled || this.inFlight || this.buffer.length === 0) return;

    const run = (async () => {
      const ok = await this.writeNextBatch();
      return ok;
    })();

    this.inFlight = run.then((ok) => {
      this.inFlight = null;
      if (ok && !this.disabled && this.buffer.length >= this.flushThreshold) {
        this.scheduleFlush();
      }
    });
  }

  private async writeNextBatch(): Promise<boolean> {
    if (this.disabled || this.buffer.length === 0) return true;

    const batch = this.buffer.slice(0, this.maxBatchSize);
    try {
      await this.options.writer(batch);
      this.consecutiveFailures = 0;
      this.persisted += batch.length;
      if (batch.length >= this.buffer.length) {
        // Reassign a fresh empty array so JSC/V8 releases the backing store promptly.
        this.buffer = [];
      } else {
        this.buffer.splice(0, batch.length);
      }
      return true;
    } catch (err) {
      this.consecutiveFailures += 1;
      const msg = err instanceof Error ? err.message : String(err);

      if (this.consecutiveFailures > this.maxConsecutiveFailures) {
        this.disabled = true;
        this.buffer = [];
        this.options.hostLogger?.warn(
          "task execution log buffer tripped circuit breaker; dropping buffered and future logs",
          {
            executionId: this.options.executionId,
            taskKey: this.options.taskKey,
            consecutiveFailures: this.consecutiveFailures,
            error: msg,
          },
        );
      } else {
        this.options.hostLogger?.warn("failed to persist task execution log batch", {
          executionId: this.options.executionId,
          taskKey: this.options.taskKey,
          batchSize: batch.length,
          consecutiveFailures: this.consecutiveFailures,
          error: msg,
        });
      }
      return false;
    }
  }
}
