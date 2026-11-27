import { and, asc, desc, eq, gt, isNotNull, lt, lte, or } from "drizzle-orm";
import {
  NOT_DELETED,
  ScheduledJobStatus,
  type ToolExecutionFilter,
  type ToolExecutionRecord,
  type ListTaskExecutionLogsFilter,
  type ListTaskExecutionsOptions,
  type NotificationDelivery,
  type ScheduledJobRecord,
  type ScheduledJobStatusCode,
  type TaskExecutionLogRecord,
  type TaskExecutionRecord,
} from "../../domain/types.ts";
import type { DrizzleDatabase } from "../db.ts";
import {
  toolExecutions,
  notificationDeliveries,
  scheduledJobs,
  taskExecutionLogs,
  taskExecutions,
} from "../schema.ts";
import {
  clampLimit,
  type ListNotificationDeliveriesFilter,
  type ListScheduledJobsFilter,
} from "../types.ts";
import {
  toToolExecutionRecord,
  toNotificationDelivery,
  toScheduledJobRecord,
  toTaskExecutionLogRecord,
  toTaskExecutionRecord,
} from "./mappers.ts";

/** Drizzle repository for task executions, scheduled jobs, notification deliveries, and action audits. */
export class PostgresTaskAuditRepo {
  constructor(private readonly db: DrizzleDatabase) {}

  async recordNotificationDelivery(delivery: NotificationDelivery): Promise<void> {
    await this.db
      .insert(notificationDeliveries)
      .values({
        deliveryId: delivery.id,
        projectId: delivery.projectId,
        originKind: delivery.originKind ?? null,
        originId: delivery.originId ?? null,
        configs: delivery.configs,
        message: delivery.message,
        status: delivery.status,
        details: delivery.details ?? [],
        createdAt: new Date(delivery.createdAt),
      })
      .onConflictDoUpdate({
        target: notificationDeliveries.deliveryId,
        set: {
          status: delivery.status,
          details: delivery.details ?? [],
        },
      });
  }

  async listNotificationDeliveries(
    filter?: ListNotificationDeliveriesFilter,
  ): Promise<NotificationDelivery[]> {
    const conditions = [];
    if (filter?.projectId) {
      conditions.push(eq(notificationDeliveries.projectId, filter.projectId));
    }
    if (filter?.origin) {
      conditions.push(eq(notificationDeliveries.originKind, filter.origin.kind));
      conditions.push(eq(notificationDeliveries.originId, filter.origin.id));
    }
    if (filter?.status) {
      conditions.push(eq(notificationDeliveries.status, filter.status));
    }

    const rows = await this.db
      .select()
      .from(notificationDeliveries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(notificationDeliveries.createdAt))
      .limit(clampLimit(filter?.limit, 50, 200));

    return rows.map(toNotificationDelivery);
  }

  async recordTaskExecution(execution: TaskExecutionRecord): Promise<void> {
    const now = new Date();
    await this.db.insert(taskExecutions).values({
      executionId: execution.executionId,
      taskKey: execution.taskKey,
      projectId: execution.projectId,
      taskId: execution.taskId,
      taskType: execution.taskType,
      sessionId: execution.sessionId ?? null,
      turnId: execution.turnId ?? null,
      status: execution.status,
      startedAt: execution.startedAt ? new Date(execution.startedAt) : now,
      finishedAt: execution.finishedAt ? new Date(execution.finishedAt) : null,
      durationMs: execution.durationMs ?? null,
      stateBefore: execution.stateBefore ?? null,
      stateAfter: execution.stateAfter ?? null,
      actionsSummary: execution.actionsSummary ?? {},
      errorMessage: execution.errorMessage ?? null,
      createdAt: execution.createdAt ? new Date(execution.createdAt) : now,
    });
  }

  async getLatestTaskExecutionState(taskKey: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db
      .select({ stateAfter: taskExecutions.stateAfter })
      .from(taskExecutions)
      .where(
        and(
          eq(taskExecutions.taskKey, taskKey),
          eq(taskExecutions.status, "success"),
          isNotNull(taskExecutions.stateAfter),
        ),
      )
      .orderBy(desc(taskExecutions.id))
      .limit(1);

    return rows[0]?.stateAfter ?? null;
  }

  async listTaskExecutions(
    taskKey?: string | undefined,
    limit = 20,
    projectId?: string | undefined,
    options?: ListTaskExecutionsOptions | undefined,
  ): Promise<TaskExecutionRecord[]> {
    const conditions = [];
    if (taskKey) {
      conditions.push(eq(taskExecutions.taskKey, taskKey));
    }
    if (projectId) {
      conditions.push(eq(taskExecutions.projectId, projectId));
    }
    if (options?.status) {
      conditions.push(eq(taskExecutions.status, options.status));
    }
    if (
      options?.beforeId !== undefined &&
      Number.isFinite(options.beforeId) &&
      options.beforeId > 0
    ) {
      conditions.push(lt(taskExecutions.id, Math.trunc(options.beforeId)));
    }

    const rows = await this.db
      .select()
      .from(taskExecutions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(taskExecutions.id))
      .limit(clampLimit(limit, 20, 201));

    return rows.map(toTaskExecutionRecord);
  }

  async appendTaskExecutionLogs(logs: readonly TaskExecutionLogRecord[]): Promise<void> {
    if (logs.length === 0) return;

    // Chunk at 1024 rows per multi-row INSERT to stay well below PostgreSQL's 65,535 bind param limit.
    const chunkSize = 1024;
    for (let offset = 0; offset < logs.length; offset += chunkSize) {
      const chunk = logs.slice(offset, offset + chunkSize);
      await this.db
        .insert(taskExecutionLogs)
        .values(
          chunk.map((entry) => ({
            executionId: entry.executionId,
            projectId: entry.projectId,
            taskKey: entry.taskKey,
            sequence: entry.sequence,
            level: entry.level,
            message: entry.message,
            fields: entry.fields ?? null,
            createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
          })),
        )
        .onConflictDoNothing({
          target: [taskExecutionLogs.executionId, taskExecutionLogs.sequence],
        });
    }
  }

  async listTaskExecutionLogs(
    executionId: string,
    filter?: ListTaskExecutionLogsFilter | undefined,
  ): Promise<TaskExecutionLogRecord[]> {
    const conditions = [eq(taskExecutionLogs.executionId, executionId)];
    if (filter?.afterSequence !== undefined && filter.afterSequence > 0) {
      conditions.push(gt(taskExecutionLogs.sequence, filter.afterSequence));
    }
    if (filter?.level) {
      conditions.push(eq(taskExecutionLogs.level, filter.level));
    }

    const rows = await this.db
      .select()
      .from(taskExecutionLogs)
      .where(and(...conditions))
      .orderBy(asc(taskExecutionLogs.sequence))
      .limit(clampLimit(filter?.limit, 200, 1001));

    return rows.map(toTaskExecutionLogRecord);
  }

  async createScheduledJob(job: ScheduledJobRecord): Promise<void> {
    const now = new Date();
    await this.db.insert(scheduledJobs).values({
      jobId: job.jobId,
      projectId: job.projectId,
      sessionId: job.sessionId,
      name: job.name,
      delayMinutes: job.delayMinutes,
      triggerAt: new Date(job.triggerAt),
      status: job.status,
      prompt: job.prompt,
      metadata: job.metadata ?? {},
      resultSummary: job.resultSummary ?? null,
      finishedAt: job.finishedAt ? new Date(job.finishedAt) : null,
      createdAt: job.createdAt ? new Date(job.createdAt) : now,
      updatedAt: job.updatedAt ? new Date(job.updatedAt) : now,
      deletedAt: NOT_DELETED,
    });
  }

  async cancelScheduledJob(sessionId: string, identifier: string): Promise<boolean> {
    const updated = await this.db
      .update(scheduledJobs)
      .set({ status: ScheduledJobStatus.CANCELLED, updatedAt: new Date() })
      .where(
        and(
          eq(scheduledJobs.sessionId, sessionId),
          eq(scheduledJobs.status, ScheduledJobStatus.PENDING),
          or(eq(scheduledJobs.jobId, identifier), eq(scheduledJobs.name, identifier)),
          eq(scheduledJobs.deletedAt, NOT_DELETED),
        ),
      )
      .returning({ id: scheduledJobs.id });

    return updated.length > 0;
  }

  async cancelScheduledJobById(jobId: string): Promise<boolean> {
    const numericId = /^\d+$/.test(jobId) ? Number(jobId) : undefined;
    const matchExpr =
      numericId !== undefined && Number.isSafeInteger(numericId)
        ? or(eq(scheduledJobs.jobId, jobId), eq(scheduledJobs.id, numericId))
        : eq(scheduledJobs.jobId, jobId);

    const updated = await this.db
      .update(scheduledJobs)
      .set({ status: ScheduledJobStatus.CANCELLED, updatedAt: new Date() })
      .where(
        and(
          matchExpr,
          eq(scheduledJobs.status, ScheduledJobStatus.PENDING),
          eq(scheduledJobs.deletedAt, NOT_DELETED),
        ),
      )
      .returning({ id: scheduledJobs.id });

    return updated.length > 0;
  }

  async listDueScheduledJobs(
    projectId?: string,
    asOf: Date = new Date(),
  ): Promise<ScheduledJobRecord[]> {
    const conditions = [
      eq(scheduledJobs.status, ScheduledJobStatus.PENDING),
      lte(scheduledJobs.triggerAt, asOf),
      eq(scheduledJobs.deletedAt, NOT_DELETED),
    ];
    if (projectId) {
      conditions.push(eq(scheduledJobs.projectId, projectId));
    }

    const rows = await this.db
      .select()
      .from(scheduledJobs)
      .where(and(...conditions))
      .orderBy(asc(scheduledJobs.triggerAt));

    return rows.map(toScheduledJobRecord);
  }

  async listScheduledJobs(filter?: ListScheduledJobsFilter): Promise<ScheduledJobRecord[]> {
    const conditions = [eq(scheduledJobs.deletedAt, NOT_DELETED)];
    if (filter?.sessionId) {
      conditions.push(eq(scheduledJobs.sessionId, filter.sessionId));
    }
    if (filter?.projectId) {
      conditions.push(eq(scheduledJobs.projectId, filter.projectId));
    }
    if (filter?.status !== undefined) {
      conditions.push(eq(scheduledJobs.status, filter.status));
    }

    const rows = await this.db
      .select()
      .from(scheduledJobs)
      .where(and(...conditions))
      .orderBy(desc(scheduledJobs.id))
      .limit(clampLimit(filter?.limit, 50, 200));

    return rows.map(toScheduledJobRecord);
  }

  async updateScheduledJobStatus(
    jobId: string,
    status: ScheduledJobStatusCode,
    summary?: string,
    finishedAt?: string,
  ): Promise<void> {
    await this.db
      .update(scheduledJobs)
      .set({
        status,
        ...(summary !== undefined ? { resultSummary: summary } : {}),
        ...(finishedAt !== undefined ? { finishedAt: new Date(finishedAt) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(scheduledJobs.jobId, jobId), eq(scheduledJobs.deletedAt, NOT_DELETED)));
  }

  async recordToolExecution(record: ToolExecutionRecord): Promise<void> {
    await this.db.insert(toolExecutions).values({
      executionId: record.executionId,
      projectId: record.projectId,
      sessionId: record.sessionId,
      turnId: record.turnId ?? null,
      ownerKind: record.ownerKind ?? null,
      ownerId: record.ownerId ?? null,
      toolName: record.toolName,
      parameters: record.parameters ?? {},
      status: record.status,
      result: record.result ?? null,
      errorMessage: record.errorMessage ?? null,
      durationMs: record.durationMs ?? 0,
      createdAt: record.createdAt ? new Date(record.createdAt) : new Date(),
    });
  }

  async listToolExecutions(filter?: ToolExecutionFilter): Promise<ToolExecutionRecord[]> {
    const conditions = [];
    if (filter?.projectId) {
      conditions.push(eq(toolExecutions.projectId, filter.projectId));
    }
    if (filter?.sessionId) {
      conditions.push(eq(toolExecutions.sessionId, filter.sessionId));
    }
    if (filter?.toolName) {
      conditions.push(eq(toolExecutions.toolName, filter.toolName));
    }
    if (filter?.ownerKind) {
      conditions.push(eq(toolExecutions.ownerKind, filter.ownerKind));
    }
    if (filter?.ownerId) {
      conditions.push(eq(toolExecutions.ownerId, filter.ownerId));
    }

    const rows = await this.db
      .select()
      .from(toolExecutions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(toolExecutions.id))
      .limit(clampLimit(filter?.limit, 50, 200));

    return rows.map(toToolExecutionRecord);
  }
}
