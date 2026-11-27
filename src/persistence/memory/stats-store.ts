import { ScheduledJobStatus } from "../../domain/types.ts";
import {
  buildDateWindow,
  buildProjectMetricsFromAggregates,
  formatDayInTimeZone,
  parseMetricsRangeDays,
  resolveTimeZone,
  type PipelineMetricsBucketRow,
  type SessionSourceBucketRow,
  type TaskMetricsBucketRow,
  type TurnMetricsBucketRow,
} from "../stats-helpers.ts";
import type {
  ProjectMetricsData,
  ProjectMetricsQueryOptions,
  ProjectOverviewPipelineNodeItem,
  ProjectOverviewPipelineRunItem,
  ProjectOverviewQueryOptions,
  ProjectOverviewScheduledJobItem,
  ProjectOverviewSessionItem,
  ProjectOverviewStoreSnapshot,
  ProjectOverviewTaskFailureItem,
} from "../stats-types.ts";
import { clampLimit } from "../types.ts";
import type { MemoryPipelineStore } from "./pipeline-store.ts";
import type { MemorySessionStore } from "./session-store.ts";
import type { MemoryTaskAuditStore } from "./task-audit-store.ts";
import type { MemoryTurnEventStore } from "./turn-event-store.ts";

/** In-memory project overview & metrics aggregation mirroring `PostgresProjectStatsRepo`. */
export class MemoryProjectStatsStore {
  constructor(
    private readonly sessionStore: MemorySessionStore,
    private readonly turnEventStore: MemoryTurnEventStore,
    private readonly taskAuditStore: MemoryTaskAuditStore,
    private readonly pipelineStore: MemoryPipelineStore,
  ) {}

  async getProjectOverview(
    projectId: string,
    options?: ProjectOverviewQueryOptions,
  ): Promise<ProjectOverviewStoreSnapshot> {
    const limit = clampLimit(options?.limit, 5, 20);
    const now = options?.now ?? new Date();
    const lookbackDays = options?.failureLookbackDays ?? 7;
    const failureSinceMs = now.getTime() - lookbackDays * 86_400_000;

    // 1. Sessions (interactive only, matching SessionBoard)
    const sessionCounts = { active: 0, idle: 0, suspended: 0, archived: 0, total: 0 };
    const activeSessionCandidates: ProjectOverviewSessionItem[] = [];
    for (const s of this.sessionStore.sessions.values()) {
      if (s.projectId !== projectId) continue;
      if (s.source === "task" || s.source === "pipeline") continue;
      sessionCounts.total += 1;
      if (s.status === "active") {
        sessionCounts.active += 1;
        activeSessionCandidates.push({
          sessionId: s.sessionId,
          ...(s.title ? { title: s.title } : {}),
          status: s.status,
          ...(s.source ? { source: s.source } : {}),
          ...(s.externalChannel ? { externalChannel: s.externalChannel } : {}),
          ...(s.runtime ? { runtime: s.runtime } : {}),
          ...(s.model ? { model: s.model } : {}),
          lastActiveAt: s.lastActiveAt,
        });
      } else if (s.status === "idle") {
        sessionCounts.idle += 1;
      } else if (s.status === "suspended") {
        sessionCounts.suspended += 1;
      } else {
        sessionCounts.archived += 1;
      }
    }
    const activeSessions = activeSessionCandidates
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
      .slice(0, limit);

    // 2. Pipelines
    const allRuns = await this.pipelineStore.listRuns({ projectId, limit: 10_000 });
    const pipelineCounts = {
      running: 0,
      waiting: 0,
      waitingConfirmation: 0,
      failed: 0,
      completed: 0,
      cancelled: 0,
      total: allRuns.length,
    };
    const waitingConfirmations: ProjectOverviewPipelineRunItem[] = [];
    const failedPipelineRuns: ProjectOverviewPipelineRunItem[] = [];
    const runTitleById = new Map<string, string>();

    for (const run of allRuns) {
      runTitleById.set(run.runId, run.title);
      switch (run.status) {
        case "running":
          pipelineCounts.running += 1;
          break;
        case "waiting":
          pipelineCounts.waiting += 1;
          break;
        case "waiting_confirmation":
          pipelineCounts.waitingConfirmation += 1;
          if (waitingConfirmations.length < limit) {
            waitingConfirmations.push({
              runId: run.runId,
              pipelineId: run.pipelineId,
              pipelineVersion: run.pipelineVersion,
              title: run.title,
              currentNodeId: run.currentNodeId,
              status: run.status,
              ...(run.statusSummary ? { statusSummary: run.statusSummary } : {}),
              updatedAt: run.updatedAt,
              createdAt: run.createdAt,
            });
          }
          break;
        case "failed":
          pipelineCounts.failed += 1;
          if (failedPipelineRuns.length < limit && Date.parse(run.updatedAt) >= failureSinceMs) {
            failedPipelineRuns.push({
              runId: run.runId,
              pipelineId: run.pipelineId,
              pipelineVersion: run.pipelineVersion,
              title: run.title,
              currentNodeId: run.currentNodeId,
              status: run.status,
              ...(run.statusSummary ? { statusSummary: run.statusSummary } : {}),
              updatedAt: run.updatedAt,
              createdAt: run.createdAt,
            });
          }
          break;
        case "completed":
          pipelineCounts.completed += 1;
          break;
        case "cancelled":
          pipelineCounts.cancelled += 1;
          break;
      }
    }

    const activeNodeRunsRaw = await this.pipelineStore.listNodeRunsByStatus(projectId, [
      "running",
      "waiting",
    ]);
    const activePipelineNodes: ProjectOverviewPipelineNodeItem[] = activeNodeRunsRaw
      .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
      .slice(0, limit)
      .map((nr) => {
        const runTitle = runTitleById.get(nr.runId);
        return {
          nodeRunId: nr.nodeRunId,
          runId: nr.runId,
          pipelineId: nr.pipelineId,
          ...(runTitle ? { runTitle } : {}),
          nodeId: nr.nodeId,
          executorType: nr.executorType,
          status: nr.status,
          ...(nr.startedAt ? { startedAt: nr.startedAt } : {}),
          ...(nr.nextPollAt ? { nextPollAt: nr.nextPollAt } : {}),
          updatedAt: nr.updatedAt,
        };
      });

    // 3. Recent failed task executions
    const failedTaskExecutions: ProjectOverviewTaskFailureItem[] = [];
    for (let i = this.taskAuditStore.taskExecutions.length - 1; i >= 0; i--) {
      const exec = this.taskAuditStore.taskExecutions[i]!;
      if (exec.projectId !== projectId) continue;
      if (exec.status !== "failed" && exec.status !== "timeout") continue;
      const startedMs = exec.startedAt ? Date.parse(exec.startedAt) : 0;
      if (startedMs < failureSinceMs) continue;
      failedTaskExecutions.push({
        executionId: exec.executionId,
        taskId: exec.taskId,
        taskKey: exec.taskKey,
        status: exec.status,
        ...(exec.errorMessage ? { errorMessage: exec.errorMessage } : {}),
        ...(exec.startedAt ? { startedAt: exec.startedAt } : {}),
        ...(exec.durationMs !== undefined ? { durationMs: exec.durationMs } : {}),
      });
      if (failedTaskExecutions.length >= limit) break;
    }

    // 4. Pending scheduled jobs
    const pendingJobs: ProjectOverviewScheduledJobItem[] = [];
    for (const job of this.taskAuditStore.scheduledJobs.values()) {
      if (job.projectId !== projectId) continue;
      if (job.status !== ScheduledJobStatus.PENDING) continue;
      pendingJobs.push({
        jobId: job.jobId,
        sessionId: job.sessionId,
        name: job.name,
        triggerAt: job.triggerAt,
        delayMinutes: job.delayMinutes,
      });
    }
    pendingJobs.sort((a, b) => Date.parse(a.triggerAt) - Date.parse(b.triggerAt));

    return {
      sessions: sessionCounts,
      pipelines: pipelineCounts,
      scheduledJobs: { pending: pendingJobs.length },
      attention: {
        waitingConfirmations,
        failedPipelineRuns,
        failedTaskExecutions,
      },
      live: {
        activeSessions,
        activePipelineNodes,
        upcomingJobs: pendingJobs.slice(0, limit),
      },
    };
  }

  async getProjectMetrics(
    projectId: string,
    options: ProjectMetricsQueryOptions,
  ): Promise<ProjectMetricsData> {
    const days = parseMetricsRangeDays(options.range);
    const tz = resolveTimeZone(options.tz);
    const now = options.now ?? new Date();
    const { dayKeys, querySince } = buildDateWindow(days, tz, now);
    const querySinceMs = querySince.getTime();

    // Map all project sessions (including task & pipeline sessions)
    const projectSessions = new Map<
      string,
      { model?: string; source?: string; externalChannel?: string }
    >();
    const sessionSourceMap = new Map<string, SessionSourceBucketRow>();

    for (const s of this.sessionStore.sessions.values()) {
      if (s.projectId !== projectId) continue;
      projectSessions.set(s.sessionId, {
        ...(s.model ? { model: s.model } : {}),
        ...(s.source ? { source: s.source } : {}),
        ...(s.externalChannel ? { externalChannel: s.externalChannel } : {}),
      });
      const createdMs = Date.parse(s.createdAt ?? s.lastActiveAt);
      if (createdMs >= querySinceMs) {
        const key = `${s.source ?? ""}|${s.externalChannel ?? ""}`;
        const existing = sessionSourceMap.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          sessionSourceMap.set(key, {
            source: s.source ?? null,
            externalChannel: s.externalChannel ?? null,
            count: 1,
          });
        }
      }
    }

    // Aggregate turns into the same bucket shape as Postgres
    const turnBucketMap = new Map<string, TurnMetricsBucketRow>();
    for (const turn of this.turnEventStore.turns.values()) {
      const sess = projectSessions.get(turn.sessionId);
      if (!sess) continue;
      const createdAt = new Date(turn.createdAt ?? turn.startedAt ?? now.toISOString());
      if (createdAt.getTime() < querySinceMs) continue;

      const day = formatDayInTimeZone(createdAt, tz);
      const model = turn.usage?.model ?? sess.model ?? null;
      const key = `${day}|${model ?? ""}|${sess.source ?? ""}|${sess.externalChannel ?? ""}`;
      let acc = turnBucketMap.get(key);
      if (!acc) {
        acc = {
          day,
          model,
          source: sess.source ?? null,
          externalChannel: sess.externalChannel ?? null,
          turnCount: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        };
        turnBucketMap.set(key, acc);
      }
      acc.turnCount += 1;
      if (turn.usage) {
        acc.inputTokens += turn.usage.inputTokens;
        acc.cacheReadTokens += turn.usage.cacheReadTokens;
        acc.cacheWriteTokens += turn.usage.cacheWriteTokens;
        acc.outputTokens += turn.usage.outputTokens;
        acc.reasoningTokens += turn.usage.reasoningTokens;
        acc.totalTokens += turn.usage.totalTokens;
      }
    }

    // Task executions
    const taskBucketMap = new Map<string, TaskMetricsBucketRow>();
    for (const exec of this.taskAuditStore.taskExecutions) {
      if (exec.projectId !== projectId) continue;
      const started = new Date(exec.startedAt ?? exec.createdAt ?? now.toISOString());
      if (started.getTime() < querySinceMs) continue;
      const day = formatDayInTimeZone(started, tz);
      const key = `${day}|${exec.status}`;
      const existing = taskBucketMap.get(key);
      if (existing) existing.count += 1;
      else taskBucketMap.set(key, { day, status: exec.status, count: 1 });
    }

    // Pipeline runs
    const allRuns = await this.pipelineStore.listRuns({ projectId, limit: 10_000 });
    const pipelineBucketMap = new Map<string, PipelineMetricsBucketRow>();
    for (const run of allRuns) {
      const created = new Date(run.createdAt);
      if (created.getTime() < querySinceMs) continue;
      const day = formatDayInTimeZone(created, tz);
      const key = `${day}|${run.status}`;
      const existing = pipelineBucketMap.get(key);
      if (existing) existing.count += 1;
      else pipelineBucketMap.set(key, { day, status: run.status, count: 1 });
    }

    return buildProjectMetricsFromAggregates({
      range: options.range,
      days,
      tz,
      dayKeys,
      now,
      turnRows: Array.from(turnBucketMap.values()),
      taskRows: Array.from(taskBucketMap.values()),
      pipelineRows: Array.from(pipelineBucketMap.values()),
      sessionRows: Array.from(sessionSourceMap.values()),
    });
  }
}
