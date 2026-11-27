import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { NOT_DELETED, ScheduledJobStatus } from "../../domain/types.ts";
import type { DrizzleDatabase } from "../db.ts";
import {
  pipelineNodeRuns,
  pipelineRuns,
  scheduledJobs,
  sessions,
  taskExecutions,
  turns,
} from "../schema.ts";
import {
  buildDateWindow,
  buildProjectMetricsFromAggregates,
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

/** Read-only PostgreSQL aggregation repository for project overview and time-series metrics. */
export class PostgresProjectStatsRepo {
  constructor(private readonly db: DrizzleDatabase) {}

  async getProjectOverview(
    projectId: string,
    options?: ProjectOverviewQueryOptions,
  ): Promise<ProjectOverviewStoreSnapshot> {
    const limit = clampLimit(options?.limit, 5, 20);
    const now = options?.now ?? new Date();
    const lookbackDays = options?.failureLookbackDays ?? 7;
    const failureSince = new Date(now.getTime() - lookbackDays * 86_400_000);

    const interactiveSessionFilter = and(
      eq(sessions.projectId, projectId),
      eq(sessions.deletedAt, NOT_DELETED),
      ne(sessions.source, "task"),
      ne(sessions.source, "pipeline"),
    );

    const [
      sessionCountRows,
      activeSessionRows,
      pipelineCountRows,
      waitingConfirmationRows,
      failedPipelineRows,
      activeNodeRows,
      failedTaskRows,
      pendingJobCountRows,
      upcomingJobRows,
    ] = await Promise.all([
      // 1. Session counts by status (interactive sessions matching SessionBoard)
      this.db
        .select({
          status: sessions.status,
          cnt: sql<number>`count(*)::int`,
        })
        .from(sessions)
        .where(interactiveSessionFilter)
        .groupBy(sessions.status),

      // 2. Top N active interactive sessions
      this.db
        .select({
          sessionId: sessions.sessionId,
          title: sessions.title,
          status: sessions.status,
          source: sessions.source,
          externalChannel: sessions.externalChannel,
          runtime: sessions.runtime,
          model: sessions.model,
          lastActiveAt: sessions.lastActiveAt,
        })
        .from(sessions)
        .where(and(interactiveSessionFilter, eq(sessions.status, "active")))
        .orderBy(desc(sessions.lastActiveAt), desc(sessions.id))
        .limit(limit),

      // 3. Pipeline run counts by status
      this.db
        .select({
          status: pipelineRuns.status,
          cnt: sql<number>`count(*)::int`,
        })
        .from(pipelineRuns)
        .where(eq(pipelineRuns.projectId, projectId))
        .groupBy(pipelineRuns.status),

      // 4. Waiting human confirmation runs (indexed on project_id, status, id desc)
      this.db
        .select({
          runId: pipelineRuns.runId,
          pipelineId: pipelineRuns.pipelineId,
          pipelineVersion: pipelineRuns.pipelineVersion,
          title: pipelineRuns.title,
          currentNodeId: pipelineRuns.currentNodeId,
          status: pipelineRuns.status,
          statusSummary: pipelineRuns.statusSummary,
          updatedAt: pipelineRuns.updatedAt,
          createdAt: pipelineRuns.createdAt,
        })
        .from(pipelineRuns)
        .where(
          and(
            eq(pipelineRuns.projectId, projectId),
            eq(pipelineRuns.status, "waiting_confirmation"),
          ),
        )
        .orderBy(desc(pipelineRuns.id))
        .limit(limit),

      // 5. Recent failed pipeline runs
      this.db
        .select({
          runId: pipelineRuns.runId,
          pipelineId: pipelineRuns.pipelineId,
          pipelineVersion: pipelineRuns.pipelineVersion,
          title: pipelineRuns.title,
          currentNodeId: pipelineRuns.currentNodeId,
          status: pipelineRuns.status,
          statusSummary: pipelineRuns.statusSummary,
          updatedAt: pipelineRuns.updatedAt,
          createdAt: pipelineRuns.createdAt,
        })
        .from(pipelineRuns)
        .where(
          and(
            eq(pipelineRuns.projectId, projectId),
            eq(pipelineRuns.status, "failed"),
            gte(pipelineRuns.updatedAt, failureSince),
          ),
        )
        .orderBy(desc(pipelineRuns.id))
        .limit(limit),

      // 6. Active pipeline nodes (hits partial indexes for running/waiting)
      this.db
        .select({
          nodeRunId: pipelineNodeRuns.nodeRunId,
          runId: pipelineNodeRuns.runId,
          pipelineId: pipelineNodeRuns.pipelineId,
          nodeId: pipelineNodeRuns.nodeId,
          executorType: pipelineNodeRuns.executorType,
          status: pipelineNodeRuns.status,
          startedAt: pipelineNodeRuns.startedAt,
          nextPollAt: pipelineNodeRuns.nextPollAt,
          updatedAt: pipelineNodeRuns.updatedAt,
        })
        .from(pipelineNodeRuns)
        .where(
          and(
            eq(pipelineNodeRuns.projectId, projectId),
            inArray(pipelineNodeRuns.status, ["running", "waiting"]),
          ),
        )
        .orderBy(desc(pipelineNodeRuns.id))
        .limit(limit),

      // 7. Recent failed/timed-out task executions (projected without large state jsonb)
      this.db
        .select({
          executionId: taskExecutions.executionId,
          taskId: taskExecutions.taskId,
          taskKey: taskExecutions.taskKey,
          status: taskExecutions.status,
          errorMessage: taskExecutions.errorMessage,
          startedAt: taskExecutions.startedAt,
          durationMs: taskExecutions.durationMs,
        })
        .from(taskExecutions)
        .where(
          and(
            eq(taskExecutions.projectId, projectId),
            inArray(taskExecutions.status, ["failed", "timeout"]),
            gte(taskExecutions.startedAt, failureSince),
          ),
        )
        .orderBy(desc(taskExecutions.id))
        .limit(limit),

      // 8. Pending scheduled jobs count
      this.db
        .select({
          cnt: sql<number>`count(*)::int`,
        })
        .from(scheduledJobs)
        .where(
          and(
            eq(scheduledJobs.projectId, projectId),
            eq(scheduledJobs.status, ScheduledJobStatus.PENDING),
            eq(scheduledJobs.deletedAt, NOT_DELETED),
          ),
        ),

      // 9. Next upcoming scheduled jobs
      this.db
        .select({
          jobId: scheduledJobs.jobId,
          sessionId: scheduledJobs.sessionId,
          name: scheduledJobs.name,
          triggerAt: scheduledJobs.triggerAt,
          delayMinutes: scheduledJobs.delayMinutes,
        })
        .from(scheduledJobs)
        .where(
          and(
            eq(scheduledJobs.projectId, projectId),
            eq(scheduledJobs.status, ScheduledJobStatus.PENDING),
            eq(scheduledJobs.deletedAt, NOT_DELETED),
          ),
        )
        .orderBy(asc(scheduledJobs.triggerAt), asc(scheduledJobs.id))
        .limit(limit),
    ]);

    // Enrich at most `limit` active pipeline nodes with their run titles via primary index lookup
    const activeNodeRunIds = Array.from(new Set(activeNodeRows.map((row) => row.runId)));
    const runTitleById = new Map<string, string>();
    if (activeNodeRunIds.length > 0) {
      const titleRows = await this.db
        .select({
          runId: pipelineRuns.runId,
          title: pipelineRuns.title,
        })
        .from(pipelineRuns)
        .where(inArray(pipelineRuns.runId, activeNodeRunIds));
      for (const row of titleRows) {
        runTitleById.set(row.runId, row.title);
      }
    }

    const sessionCounts = { active: 0, idle: 0, suspended: 0, archived: 0, total: 0 };
    for (const row of sessionCountRows) {
      const cnt = Number(row.cnt ?? 0);
      sessionCounts.total += cnt;
      if (row.status === "active") sessionCounts.active += cnt;
      else if (row.status === "idle") sessionCounts.idle += cnt;
      else if (row.status === "suspended") sessionCounts.suspended += cnt;
      else sessionCounts.archived += cnt;
    }

    const pipelineCounts = {
      running: 0,
      waiting: 0,
      waitingConfirmation: 0,
      failed: 0,
      completed: 0,
      cancelled: 0,
      total: 0,
    };
    for (const row of pipelineCountRows) {
      const cnt = Number(row.cnt ?? 0);
      pipelineCounts.total += cnt;
      switch (row.status) {
        case "running":
          pipelineCounts.running += cnt;
          break;
        case "waiting":
          pipelineCounts.waiting += cnt;
          break;
        case "waiting_confirmation":
          pipelineCounts.waitingConfirmation += cnt;
          break;
        case "failed":
          pipelineCounts.failed += cnt;
          break;
        case "completed":
          pipelineCounts.completed += cnt;
          break;
        case "cancelled":
          pipelineCounts.cancelled += cnt;
          break;
      }
    }

    const mapRunItem = (
      row: (typeof waitingConfirmationRows)[number],
    ): ProjectOverviewPipelineRunItem => ({
      runId: row.runId,
      pipelineId: row.pipelineId,
      pipelineVersion: row.pipelineVersion,
      title: row.title,
      currentNodeId: row.currentNodeId,
      status: row.status,
      ...(row.statusSummary ? { statusSummary: row.statusSummary } : {}),
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    });

    const activeSessions: ProjectOverviewSessionItem[] = activeSessionRows.map((row) => ({
      sessionId: row.sessionId,
      ...(row.title ? { title: row.title } : {}),
      status: row.status,
      ...(row.source ? { source: row.source } : {}),
      ...(row.externalChannel ? { externalChannel: row.externalChannel } : {}),
      ...(row.runtime ? { runtime: row.runtime } : {}),
      ...(row.model ? { model: row.model } : {}),
      lastActiveAt: row.lastActiveAt.toISOString(),
    }));

    const activePipelineNodes: ProjectOverviewPipelineNodeItem[] = activeNodeRows.map((row) => {
      const runTitle = runTitleById.get(row.runId);
      return {
        nodeRunId: row.nodeRunId,
        runId: row.runId,
        pipelineId: row.pipelineId,
        ...(runTitle ? { runTitle } : {}),
        nodeId: row.nodeId,
        executorType: row.executorType,
        status: row.status,
        ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
        ...(row.nextPollAt ? { nextPollAt: row.nextPollAt.toISOString() } : {}),
        updatedAt: row.updatedAt.toISOString(),
      };
    });

    const failedTaskExecutions: ProjectOverviewTaskFailureItem[] = failedTaskRows.map((row) => ({
      executionId: row.executionId,
      taskId: row.taskId,
      taskKey: row.taskKey,
      status: row.status,
      ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
      ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
      ...(row.durationMs !== null ? { durationMs: Number(row.durationMs) } : {}),
    }));

    const upcomingJobs: ProjectOverviewScheduledJobItem[] = upcomingJobRows.map((row) => ({
      jobId: row.jobId,
      sessionId: row.sessionId,
      name: row.name,
      triggerAt: row.triggerAt.toISOString(),
      delayMinutes: row.delayMinutes,
    }));

    return {
      sessions: sessionCounts,
      pipelines: pipelineCounts,
      scheduledJobs: {
        pending: Number(pendingJobCountRows[0]?.cnt ?? 0),
      },
      attention: {
        waitingConfirmations: waitingConfirmationRows.map(mapRunItem),
        failedPipelineRuns: failedPipelineRows.map(mapRunItem),
        failedTaskExecutions,
      },
      live: {
        activeSessions,
        activePipelineNodes,
        upcomingJobs,
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

    // 4 concurrent single-purpose pre-aggregation queries (small result sets) -> in-memory rollup
    const [turnRawRows, taskRawRows, pipelineRawRows, sessionRawRows] = await Promise.all([
      // 1. Single scan of turns joined to project sessions, grouped by (day, model, source, channel)
      this.db
        .select({
          day: sql<string>`to_char(${turns.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
          model: sql<string | null>`coalesce(${turns.model}, ${sessions.model})`,
          source: sessions.source,
          externalChannel: sessions.externalChannel,
          turnCount: sql<number>`count(*)::int`,
          inputTokens: sql<string | number>`coalesce(sum(${turns.inputTokens}), 0)`,
          cacheReadTokens: sql<string | number>`coalesce(sum(${turns.cacheReadTokens}), 0)`,
          cacheWriteTokens: sql<string | number>`coalesce(sum(${turns.cacheWriteTokens}), 0)`,
          outputTokens: sql<string | number>`coalesce(sum(${turns.outputTokens}), 0)`,
          reasoningTokens: sql<string | number>`coalesce(sum(${turns.reasoningTokens}), 0)`,
          totalTokens: sql<string | number>`coalesce(sum(${turns.totalTokens}), 0)`,
        })
        .from(turns)
        .innerJoin(
          sessions,
          and(eq(sessions.sessionId, turns.sessionId), eq(sessions.deletedAt, NOT_DELETED)),
        )
        .where(and(eq(sessions.projectId, projectId), gte(turns.createdAt, querySince)))
        .groupBy(sql`1`, sql`2`, sql`3`, sql`4`),

      // 2. Task execution daily counts by status
      this.db
        .select({
          day: sql<string>`to_char(${taskExecutions.startedAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
          status: taskExecutions.status,
          cnt: sql<number>`count(*)::int`,
        })
        .from(taskExecutions)
        .where(
          and(eq(taskExecutions.projectId, projectId), gte(taskExecutions.startedAt, querySince)),
        )
        .groupBy(sql`1`, sql`2`),

      // 3. Pipeline run daily counts by status
      this.db
        .select({
          day: sql<string>`to_char(${pipelineRuns.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
          status: pipelineRuns.status,
          cnt: sql<number>`count(*)::int`,
        })
        .from(pipelineRuns)
        .where(and(eq(pipelineRuns.projectId, projectId), gte(pipelineRuns.createdAt, querySince)))
        .groupBy(sql`1`, sql`2`),

      // 4. Session counts within the window by source & channel
      this.db
        .select({
          source: sessions.source,
          externalChannel: sessions.externalChannel,
          cnt: sql<number>`count(*)::int`,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.projectId, projectId),
            eq(sessions.deletedAt, NOT_DELETED),
            gte(sessions.createdAt, querySince),
          ),
        )
        .groupBy(sessions.source, sessions.externalChannel),
    ]);

    const turnRows: TurnMetricsBucketRow[] = turnRawRows.map((row) => ({
      day: row.day,
      model: row.model,
      source: row.source,
      externalChannel: row.externalChannel,
      turnCount: Number(row.turnCount ?? 0),
      inputTokens: Number(row.inputTokens ?? 0),
      cacheReadTokens: Number(row.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      reasoningTokens: Number(row.reasoningTokens ?? 0),
      totalTokens: Number(row.totalTokens ?? 0),
    }));

    const taskRows: TaskMetricsBucketRow[] = taskRawRows.map((row) => ({
      day: row.day,
      status: row.status,
      count: Number(row.cnt ?? 0),
    }));

    const pipelineRows: PipelineMetricsBucketRow[] = pipelineRawRows.map((row) => ({
      day: row.day,
      status: row.status,
      count: Number(row.cnt ?? 0),
    }));

    const sessionRows: SessionSourceBucketRow[] = sessionRawRows.map((row) => ({
      source: row.source,
      externalChannel: row.externalChannel,
      count: Number(row.cnt ?? 0),
    }));

    return buildProjectMetricsFromAggregates({
      range: options.range,
      days,
      tz,
      dayKeys,
      now,
      turnRows,
      taskRows,
      pipelineRows,
      sessionRows,
    });
  }
}
