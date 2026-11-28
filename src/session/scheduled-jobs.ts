import { randomUUID } from "node:crypto";
import {
  ScheduledJobStatus,
  type ScheduledJobRecord,
  type ScheduledJobStatusCode,
} from "../domain/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { Store } from "../persistence/store.ts";
import type { SessionTurns } from "./turns.ts";

export interface ScheduleJobRequest {
  readonly name: string;
  readonly delayMinutes: number;
  readonly prompt: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ScheduledJobsDeps {
  readonly projectId: string;
  readonly store: Store;
  readonly turns: Pick<SessionTurns, "submit" | "waitForIdle">;
  readonly logger: Logger;
}

/**
 * Wake-ups an agent schedules for its own session: after a delay, the job's prompt runs as a new
 * turn. A job is dropped when its session has ended, or has moved on with a turn newer than the
 * one that scheduled it.
 */
export class ScheduledJobs {
  /** Jobs whose turn is running, by job ID. */
  private readonly running = new Map<string, Promise<void>>();
  /** The poll picking up due jobs; polls never overlap, so a job is picked up once. */
  private polling: Promise<Promise<void>[]> | undefined;
  private stopped = false;

  constructor(private readonly deps: ScheduledJobsDeps) {}

  /** Schedules a wake-up of `sessionId`; `turnId` is the turn scheduling it. */
  async schedule(
    sessionId: string,
    turnId: string | undefined,
    job: ScheduleJobRequest,
  ): Promise<ScheduledJobRecord> {
    const triggerAt = new Date(Date.now() + job.delayMinutes * 60_000).toISOString();
    const record: ScheduledJobRecord = {
      jobId: `job_${randomUUID()}`,
      projectId: this.deps.projectId,
      sessionId,
      name: job.name,
      createdAt: new Date().toISOString(),
      delayMinutes: job.delayMinutes,
      triggerAt,
      status: ScheduledJobStatus.PENDING,
      prompt: job.prompt,
      metadata: { ...(job.metadata ?? {}), ...(turnId ? { createdTurnId: turnId } : {}) },
    };
    await this.deps.store.createScheduledJob(record);
    this.deps.logger.info("scheduled job created for session", {
      sessionId,
      jobId: record.jobId,
      name: job.name,
      delayMinutes: job.delayMinutes,
      triggerAt,
    });
    return record;
  }

  /** Cancels a pending wake-up of `sessionId` by name or job ID. */
  async cancel(sessionId: string, nameOrId: string): Promise<boolean> {
    const cancelled = await this.deps.store.cancelScheduledJob(sessionId, nameOrId);
    this.deps.logger.info("scheduled job cancellation requested", {
      sessionId,
      name: nameOrId,
      cancelled,
    });
    return cancelled;
  }

  async hasPending(sessionId: string): Promise<boolean> {
    const jobs = await this.deps.store.listScheduledJobs({
      sessionId,
      projectId: this.deps.projectId,
      status: ScheduledJobStatus.PENDING,
      limit: 1,
    });
    return jobs.length > 0;
  }

  /**
   * Picks up the jobs due at `asOf` and runs each as a turn of its session, and waits for them.
   * Jobs run independently: a long turn in one session does not hold up another session's job.
   */
  async poll(asOf: Date = new Date()): Promise<void> {
    if (this.stopped) return;
    this.polling ??= this.pickUp(asOf).finally(() => {
      this.polling = undefined;
    });
    await Promise.allSettled(await this.polling);
  }

  /** Stops polling and waits for the jobs that are running. Their turns must be able to end. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.polling?.catch(() => {});
    await Promise.allSettled([...this.running.values()]);
  }

  /** Marks the due jobs running, or abandoned, and starts the ones that run. */
  private async pickUp(asOf: Date): Promise<Promise<void>[]> {
    const started: Promise<void>[] = [];
    try {
      const due = await this.deps.store.listDueScheduledJobs(this.deps.projectId, asOf);
      for (const job of due) {
        if (!(await this.claim(job))) continue;
        const run = this.run(job).finally(() => this.running.delete(job.jobId));
        this.running.set(job.jobId, run);
        started.push(run);
      }
    } catch (error) {
      this.deps.logger.error("error polling scheduled jobs", {
        projectId: this.deps.projectId,
        error: String(error),
      });
    }
    return started;
  }

  /** Marks a due job running, or abandoned when its session has ended or moved on. */
  private async claim(job: ScheduledJobRecord): Promise<boolean> {
    const { store, logger } = this.deps;
    const session = await store.getSession(job.sessionId);
    if (
      !session ||
      session.status === "closing" ||
      session.status === "archived" ||
      session.status === "failed"
    ) {
      logger.info("scheduled job abandoned because session is closed or archived", {
        jobId: job.jobId,
        sessionId: job.sessionId,
        status: session?.status,
      });
      await this.finish(job, ScheduledJobStatus.ABANDONED, "session_closed");
      return false;
    }

    const createdTurnId =
      typeof job.metadata.createdTurnId === "string" ? job.metadata.createdTurnId : undefined;
    const latestTurn = createdTurnId ? await store.getLatestTurn(job.sessionId) : undefined;
    if (
      createdTurnId &&
      latestTurn &&
      latestTurn.id !== createdTurnId &&
      latestTurn.runtimeTurnId !== createdTurnId
    ) {
      logger.info("scheduled job abandoned because session has progressed with new turn", {
        jobId: job.jobId,
        sessionId: job.sessionId,
        createdTurnId,
        latestTurnId: latestTurn.id,
        latestRuntimeTurnId: latestTurn.runtimeTurnId,
      });
      await this.finish(job, ScheduledJobStatus.ABANDONED, "stale_turn_superceded");
      return false;
    }

    await store.updateScheduledJobStatus(job.jobId, ScheduledJobStatus.RUNNING);
    return true;
  }

  private async run(job: ScheduledJobRecord): Promise<void> {
    const { store, turns, logger } = this.deps;
    logger.info("waking up session for scheduled job", {
      jobId: job.jobId,
      sessionId: job.sessionId,
      name: job.name,
    });
    try {
      const turn = await turns.submit(job.sessionId, job.prompt);
      await turns.waitForIdle(job.sessionId);
      const finished = await store.getTurn(turn.id);
      if (finished?.status === "completed") {
        await this.finish(job, ScheduledJobStatus.COMPLETED, "completed");
        logger.info("scheduled job completed successfully", { jobId: job.jobId, turnId: turn.id });
      } else {
        await this.finish(job, ScheduledJobStatus.ABANDONED, finished?.error ?? "turn_failed");
      }
    } catch (error) {
      logger.error("scheduled job turn execution failed", {
        jobId: job.jobId,
        sessionId: job.sessionId,
        error: String(error),
      });
      await this.finish(job, ScheduledJobStatus.ABANDONED, String(error));
    }
  }

  private finish(
    job: ScheduledJobRecord,
    status: ScheduledJobStatusCode,
    summary: string,
  ): Promise<void> {
    return this.deps.store.updateScheduledJobStatus(
      job.jobId,
      status,
      summary,
      new Date().toISOString(),
    );
  }
}
