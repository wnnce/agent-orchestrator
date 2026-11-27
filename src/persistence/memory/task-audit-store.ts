import {
  NOT_DELETED,
  ScheduledJobStatus,
  type ActionExecutionFilter,
  type ActionExecutionRecord,
  type ListTaskExecutionLogsFilter,
  type ListTaskExecutionsOptions,
  type NotificationDelivery,
  type ScheduledJobRecord,
  type ScheduledJobStatusCode,
  type TaskExecutionLogRecord,
  type TaskExecutionRecord,
} from "../../domain/types.ts";
import {
  clampLimit,
  type ListNotificationDeliveriesFilter,
  type ListScheduledJobsFilter,
} from "../types.ts";

/** In-memory repository for tasks, scheduled jobs, notification deliveries, and action audits. */
export class MemoryTaskAuditStore {
  readonly notifications = new Map<string, NotificationDelivery>();
  readonly taskExecutions: TaskExecutionRecord[] = [];
  readonly taskExecutionLogs = new Map<string, TaskExecutionLogRecord[]>();
  readonly scheduledJobs = new Map<string, ScheduledJobRecord>();
  readonly actionExecutions: ActionExecutionRecord[] = [];
  private nextTaskExecutionId = 1;

  async recordNotificationDelivery(delivery: NotificationDelivery): Promise<void> {
    this.notifications.set(delivery.id, structuredClone(delivery));
  }

  async listNotificationDeliveries(
    filter?: ListNotificationDeliveriesFilter,
  ): Promise<NotificationDelivery[]> {
    const items: NotificationDelivery[] = [];
    for (const delivery of this.notifications.values()) {
      if (filter?.projectId && delivery.projectId !== filter.projectId) continue;
      if (
        filter?.origin &&
        (delivery.originKind !== filter.origin.kind || delivery.originId !== filter.origin.id)
      )
        continue;
      if (filter?.status && delivery.status !== filter.status) continue;
      items.push(structuredClone(delivery));
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return items.slice(0, clampLimit(filter?.limit, 50, 200));
  }

  async recordTaskExecution(execution: TaskExecutionRecord): Promise<void> {
    const cloned = structuredClone(execution);
    const assignedId = typeof cloned.id === "number" ? cloned.id : this.nextTaskExecutionId++;
    if (assignedId >= this.nextTaskExecutionId) {
      this.nextTaskExecutionId = assignedId + 1;
    }
    this.taskExecutions.unshift({ ...cloned, id: assignedId });
  }

  async getLatestTaskExecutionState(taskKey: string): Promise<Record<string, unknown> | null> {
    const found = this.taskExecutions.find(
      (item) => item.taskKey === taskKey && item.status === "success" && item.stateAfter,
    );
    return found?.stateAfter ? structuredClone(found.stateAfter) : null;
  }

  async listTaskExecutions(
    taskKey?: string | undefined,
    limit = 20,
    projectId?: string | undefined,
    options?: ListTaskExecutionsOptions | undefined,
  ): Promise<TaskExecutionRecord[]> {
    const result: TaskExecutionRecord[] = [];
    const max = clampLimit(limit, 20, 201);
    const beforeId =
      options?.beforeId !== undefined && Number.isFinite(options.beforeId) && options.beforeId > 0
        ? Math.trunc(options.beforeId)
        : undefined;
    for (const item of this.taskExecutions) {
      if (taskKey && item.taskKey !== taskKey) continue;
      if (projectId && item.projectId !== projectId) continue;
      if (options?.status && item.status !== options.status) continue;
      if (beforeId !== undefined && (typeof item.id !== "number" || item.id >= beforeId)) {
        continue;
      }
      result.push(structuredClone(item));
      if (result.length >= max) break;
    }
    return result;
  }

  async appendTaskExecutionLogs(logs: readonly TaskExecutionLogRecord[]): Promise<void> {
    if (logs.length === 0) return;
    for (const entry of logs) {
      const bucket = this.taskExecutionLogs.get(entry.executionId) ?? [];
      if (bucket.some((existing) => existing.sequence === entry.sequence)) {
        continue;
      }
      bucket.push(structuredClone(entry));
      this.taskExecutionLogs.set(entry.executionId, bucket);
    }
    const touchedIds = new Set(logs.map((entry) => entry.executionId));
    for (const executionId of touchedIds) {
      const bucket = this.taskExecutionLogs.get(executionId);
      bucket?.sort((a, b) => a.sequence - b.sequence);
    }
  }

  async listTaskExecutionLogs(
    executionId: string,
    filter?: ListTaskExecutionLogsFilter | undefined,
  ): Promise<TaskExecutionLogRecord[]> {
    const bucket = this.taskExecutionLogs.get(executionId);
    if (!bucket || bucket.length === 0) return [];
    const afterSeq = filter?.afterSequence ?? 0;
    const max = clampLimit(filter?.limit, 200, 1001);
    const result: TaskExecutionLogRecord[] = [];
    for (const entry of bucket) {
      if (entry.sequence <= afterSeq) continue;
      if (filter?.level && entry.level !== filter.level) continue;
      result.push(structuredClone(entry));
      if (result.length >= max) break;
    }
    return result;
  }

  async createScheduledJob(job: ScheduledJobRecord): Promise<void> {
    this.scheduledJobs.set(job.jobId, structuredClone(job));
  }

  async cancelScheduledJob(sessionId: string, identifier: string): Promise<boolean> {
    for (const [id, job] of this.scheduledJobs.entries()) {
      if (
        (job.deletedAt ?? NOT_DELETED) === NOT_DELETED &&
        job.sessionId === sessionId &&
        job.status === ScheduledJobStatus.PENDING &&
        (job.jobId === identifier || job.name === identifier)
      ) {
        this.scheduledJobs.set(id, {
          ...job,
          status: ScheduledJobStatus.CANCELLED,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
    }
    return false;
  }

  async cancelScheduledJobById(jobId: string): Promise<boolean> {
    for (const [id, job] of this.scheduledJobs.entries()) {
      if (
        (job.deletedAt ?? NOT_DELETED) === NOT_DELETED &&
        (job.jobId === jobId || (job.id !== undefined && String(job.id) === jobId)) &&
        job.status === ScheduledJobStatus.PENDING
      ) {
        this.scheduledJobs.set(id, {
          ...job,
          status: ScheduledJobStatus.CANCELLED,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
    }
    return false;
  }

  async listScheduledJobs(filter?: ListScheduledJobsFilter): Promise<ScheduledJobRecord[]> {
    const list: ScheduledJobRecord[] = [];
    for (const item of this.scheduledJobs.values()) {
      if ((item.deletedAt ?? NOT_DELETED) !== NOT_DELETED) continue;
      if (filter?.sessionId && item.sessionId !== filter.sessionId) continue;
      if (filter?.projectId && item.projectId !== filter.projectId) continue;
      if (filter?.status !== undefined && item.status !== filter.status) continue;
      list.push(structuredClone(item));
    }
    list.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    return list.slice(0, clampLimit(filter?.limit, 50, 200));
  }

  async listDueScheduledJobs(
    projectId?: string,
    asOf: Date = new Date(),
  ): Promise<ScheduledJobRecord[]> {
    const threshold = asOf.toISOString();
    const list: ScheduledJobRecord[] = [];
    for (const item of this.scheduledJobs.values()) {
      if ((item.deletedAt ?? NOT_DELETED) !== NOT_DELETED) continue;
      if (item.status !== ScheduledJobStatus.PENDING) continue;
      if (item.triggerAt > threshold) continue;
      if (projectId && item.projectId !== projectId) continue;
      list.push(structuredClone(item));
    }
    return list.sort((a, b) => a.triggerAt.localeCompare(b.triggerAt));
  }

  async updateScheduledJobStatus(
    jobId: string,
    status: ScheduledJobStatusCode,
    summary?: string,
    finishedAt?: string,
  ): Promise<void> {
    const current = this.scheduledJobs.get(jobId);
    if (!current || (current.deletedAt ?? NOT_DELETED) !== NOT_DELETED) return;
    this.scheduledJobs.set(jobId, {
      ...current,
      status,
      ...(summary !== undefined ? { resultSummary: summary } : {}),
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  softDeleteScheduledJobsBySession(sessionId: string, deletedAt = Date.now()): void {
    for (const [id, job] of this.scheduledJobs.entries()) {
      if (job.sessionId === sessionId && (job.deletedAt ?? NOT_DELETED) === NOT_DELETED) {
        this.scheduledJobs.set(id, {
          ...job,
          deletedAt,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  async recordActionExecution(record: ActionExecutionRecord): Promise<void> {
    this.actionExecutions.unshift({
      ...structuredClone(record),
      createdAt: record.createdAt ?? new Date().toISOString(),
    });
  }

  async listActionExecutions(filter?: ActionExecutionFilter): Promise<ActionExecutionRecord[]> {
    const max = clampLimit(filter?.limit, 50, 200);
    const result: ActionExecutionRecord[] = [];
    for (const item of this.actionExecutions) {
      if (filter?.projectId && item.projectId !== filter.projectId) continue;
      if (filter?.sessionId && item.sessionId !== filter.sessionId) continue;
      if (filter?.actionName && item.actionName !== filter.actionName) continue;
      result.push(structuredClone(item));
      if (result.length >= max) break;
    }
    return result;
  }
}
