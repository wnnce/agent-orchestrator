import type { LogEntry, Logger } from "../observability/logger.ts";
import type { PipelineNodeLogRecord } from "./types.ts";

export interface PipelineNodeLogBufferOptions {
  readonly nodeRunId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly initialSequence?: number | undefined;
  readonly writer: (entries: readonly PipelineNodeLogRecord[]) => Promise<void>;
  readonly flushThreshold?: number | undefined;
  readonly maxBatchSize?: number | undefined;
  readonly maxConsecutiveFailures?: number | undefined;
  readonly hostLogger?: Logger | undefined;
}

/**
 * Per-nodeRun async batch log buffer with monotonic sequence continuation across TS node replays.
 */
export class PipelineNodeLogBuffer {
  private buffer: PipelineNodeLogRecord[] = [];
  private sequence: number;
  private inFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private disabled = false;

  private readonly flushThreshold: number;
  private readonly maxBatchSize: number;
  private readonly maxConsecutiveFailures: number;

  constructor(private readonly options: PipelineNodeLogBufferOptions) {
    this.sequence = Math.max(0, options.initialSequence ?? 0);
    this.flushThreshold = Math.max(1, options.flushThreshold ?? 128);
    this.maxBatchSize = Math.max(this.flushThreshold, options.maxBatchSize ?? 512);
    this.maxConsecutiveFailures = Math.max(0, options.maxConsecutiveFailures ?? 3);
  }

  push(entry: LogEntry): void {
    if (this.disabled) return;
    this.sequence += 1;
    this.buffer.push({
      nodeRunId: this.options.nodeRunId,
      runId: this.options.runId,
      projectId: this.options.projectId,
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

  async flush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
    }
    while (!this.disabled && this.buffer.length > 0) {
      const ok = await this.writeNextBatch();
      if (!ok) break;
    }
  }

  private scheduleFlush(): void {
    if (this.disabled || this.inFlight || this.buffer.length === 0) return;
    const run = this.writeNextBatch();
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
      if (batch.length >= this.buffer.length) {
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
        this.options.hostLogger?.warn("pipeline node log buffer tripped circuit breaker", {
          nodeRunId: this.options.nodeRunId,
          error: msg,
        });
      }
      return false;
    }
  }
}
