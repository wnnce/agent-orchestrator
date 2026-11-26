import type { Logger } from "../observability/logger.ts";
import type { PipelineStore } from "../persistence/types.ts";
import type { PipelineNodeRunRecord } from "./types.ts";

/** `skipped`: the node run was no longer queued, e.g. its run was cancelled meanwhile. */
export type PipelineClaimResult = "started" | "no_capacity" | "skipped";

export interface PipelineSchedulerDeps {
  readonly projectId: string;
  readonly store: PipelineStore;
  readonly logger: Logger;
  /** How many runs of this node run's node may run at once. */
  readonly capacityOf: (nodeRun: PipelineNodeRunRecord) => number;
  /**
   * Tries to start a queued node run. The store still refuses when the node is at capacity, which
   * the scheduler's own count cannot rule out across processes.
   */
  readonly claim: (nodeRun: PipelineNodeRunRecord) => Promise<PipelineClaimResult>;
  /** Queues a waiting node run whose next poll is due. */
  readonly wake: (nodeRun: PipelineNodeRunRecord) => Promise<void>;
}

/**
 * Starts queued node runs and wakes waiting TS nodes when their next poll is due. It keeps no
 * state of its own beyond one timer: which nodes are queued, running or due is read from the store
 * every time, so a missed call or a restart cannot leave it out of step.
 */
export class PipelineScheduler {
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private alarm: { timer: Timer; atMs: number } | null = null;
  private stopped = true;

  constructor(private readonly deps: PipelineSchedulerDeps) {}

  start(): void {
    this.stopped = false;
    this.refresh();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearAlarm();
    await this.draining;
  }

  /** Called after every state change: start what can start and re-arm the poll alarm. */
  refresh(): void {
    void this.drain();
    void this.armAlarm().catch((error) =>
      this.deps.logger.warn("failed to arm pipeline poll alarm", {
        projectId: this.deps.projectId,
        error: (error as Error).message,
      }),
    );
  }

  /**
   * Claims queued node runs one at a time, oldest first. A call made while a pass is running is
   * folded into one more pass, so capacity checks never race within this process.
   */
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.drainAgain = false;
        await this.drainOnce();
      } while (this.drainAgain && !this.stopped);
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Wakes every waiting node whose poll is due, then re-arms the alarm for the next one. */
  async pollDue(asOf: Date = new Date()): Promise<number> {
    if (this.stopped) return 0;
    const due = await this.deps.store.listDueNodeRuns(this.deps.projectId, asOf);
    for (const nodeRun of due) {
      if (this.stopped) break;
      await this.deps.wake(nodeRun).catch((error) => this.warn("wake", nodeRun, error));
    }
    return due.length;
  }

  /**
   * Counts what each node is running first and claims only where a slot is free, so a full node
   * with a long queue costs one query per pass instead of one transaction per queued run.
   */
  private async drainOnce(): Promise<void> {
    const active = await this.deps.store.listNodeRunsByStatus(this.deps.projectId, [
      "queued",
      "running",
    ]);
    const running = new Map<string, number>();
    for (const nodeRun of active) {
      if (nodeRun.status === "running") {
        running.set(nodeKey(nodeRun), (running.get(nodeKey(nodeRun)) ?? 0) + 1);
      }
    }

    for (const nodeRun of active) {
      if (this.stopped) return;
      if (nodeRun.status !== "queued") continue;
      const key = nodeKey(nodeRun);
      const limit = this.deps.capacityOf(nodeRun);
      const busy = running.get(key) ?? 0;
      if (busy >= limit) continue;
      const result = await this.deps.claim(nodeRun).catch((error): PipelineClaimResult => {
        this.warn("claim", nodeRun, error);
        return "skipped";
      });
      if (result === "started") running.set(key, busy + 1);
      // Another process took the last slot: the node is full for the rest of this pass.
      if (result === "no_capacity") running.set(key, limit);
    }
  }

  private async armAlarm(): Promise<void> {
    if (this.stopped) return;
    const next = await this.deps.store.getNextPollAt(this.deps.projectId);
    const atMs = next ? Date.parse(next) : Number.NaN;
    if (!Number.isFinite(atMs)) {
      this.clearAlarm();
      return;
    }
    if (this.alarm && this.alarm.atMs <= atMs) return;
    this.clearAlarm();
    const timer = setTimeout(
      () => {
        this.alarm = null;
        void this.pollDue().finally(() => this.refresh());
      },
      Math.max(0, atMs - Date.now()),
    );
    this.alarm = { timer, atMs };
  }

  private clearAlarm(): void {
    if (this.alarm) clearTimeout(this.alarm.timer);
    this.alarm = null;
  }

  private warn(step: string, nodeRun: PipelineNodeRunRecord, error: unknown): void {
    this.deps.logger.warn(`pipeline scheduler failed to ${step} node run`, {
      projectId: this.deps.projectId,
      runId: nodeRun.runId,
      nodeRunId: nodeRun.nodeRunId,
      error: (error as Error).message,
    });
  }
}

function nodeKey(nodeRun: PipelineNodeRunRecord): string {
  return `${nodeRun.pipelineId}:${nodeRun.nodeId}`;
}
