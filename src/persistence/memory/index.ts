import type {
  ActionExecutionFilter,
  ActionExecutionRecord,
  ArtifactRecord,
  EventRecord,
  InboundMessageRecord,
  ListTaskExecutionLogsFilter,
  NotificationDelivery,
  ScheduledJobRecord,
  ScheduledJobStatusCode,
  SessionRoute,
  SessionUsageSummary,
  TaskExecutionLogRecord,
  TaskExecutionRecord,
  TurnRecord,
} from "../../domain/types.ts";
import type {
  ListNotificationDeliveriesFilter,
  ListScheduledJobsFilter,
  ListSessionsOptions,
  Store,
  TurnPatch,
} from "../types.ts";
import { MemorySessionStore } from "./session-store.ts";
import { MemoryTaskAuditStore } from "./task-audit-store.ts";
import { MemoryTurnEventStore } from "./turn-event-store.ts";

/** In-memory `Store` implementation for tests and zero-database local development. */
export class MemoryStore implements Store {
  private readonly sessionStore = new MemorySessionStore();
  private readonly turnEventStore = new MemoryTurnEventStore();
  private readonly taskAuditStore = new MemoryTaskAuditStore();

  get sessions(): Map<string, SessionRoute> {
    return this.sessionStore.sessions;
  }

  get inboundMessages(): Map<string, string | undefined> {
    return this.sessionStore.inboundMessages;
  }

  get turns(): Map<string, TurnRecord> {
    return this.turnEventStore.turns;
  }

  get events(): Map<string, EventRecord[]> {
    return this.turnEventStore.events;
  }

  get artifacts(): ArtifactRecord[] {
    return this.turnEventStore.artifacts;
  }

  get notifications(): Map<string, NotificationDelivery> {
    return this.taskAuditStore.notifications;
  }

  get taskExecutions(): TaskExecutionRecord[] {
    return this.taskAuditStore.taskExecutions;
  }

  get taskExecutionLogs(): Map<string, TaskExecutionLogRecord[]> {
    return this.taskAuditStore.taskExecutionLogs;
  }

  get scheduledJobs(): Map<string, ScheduledJobRecord> {
    return this.taskAuditStore.scheduledJobs;
  }

  get actionExecutions(): ActionExecutionRecord[] {
    return this.taskAuditStore.actionExecutions;
  }

  createSession(route: SessionRoute): Promise<SessionRoute> {
    return this.sessionStore.createSession(route);
  }

  getSession(sessionId: string): Promise<SessionRoute | null> {
    return this.sessionStore.getSession(sessionId);
  }

  listSessions(projectId?: string, options?: ListSessionsOptions): Promise<SessionRoute[]> {
    return this.sessionStore.listSessions(projectId, options);
  }

  updateSession(route: SessionRoute): Promise<void> {
    return this.sessionStore.updateSession(route);
  }

  updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
    return this.sessionStore.updateSessionTitle(sessionId, title);
  }

  setTitleIfEmpty(sessionId: string, title: string): Promise<boolean> {
    return this.sessionStore.setTitleIfEmpty(sessionId, title);
  }

  findSessionByExternal(
    channel: string,
    conversationId: string,
    threadId?: string,
  ): Promise<SessionRoute | null> {
    return this.sessionStore.findSessionByExternal(channel, conversationId, threadId);
  }

  claimInboundMessage(message: InboundMessageRecord): Promise<boolean> {
    return this.sessionStore.claimInboundMessage(message);
  }

  releaseInboundMessage(messageId: string): Promise<void> {
    return this.sessionStore.releaseInboundMessage(messageId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessionStore.deleteBySession(sessionId);
    this.turnEventStore.deleteBySession(sessionId);
  }

  createTurn(turn: TurnRecord): Promise<void> {
    return this.turnEventStore.createTurn(turn);
  }

  getTurn(turnId: string): Promise<TurnRecord | null> {
    return this.turnEventStore.getTurn(turnId);
  }

  getLatestTurn(sessionId: string): Promise<TurnRecord | null> {
    return this.turnEventStore.getLatestTurn(sessionId);
  }

  updateTurn(turnId: string, patch: TurnPatch): Promise<void> {
    return this.turnEventStore.updateTurn(turnId, patch);
  }

  getSessionUsage(sessionId: string): Promise<SessionUsageSummary | null> {
    return this.turnEventStore.getSessionUsage(sessionId);
  }

  appendEvent(event: EventRecord): Promise<EventRecord> {
    return this.turnEventStore.appendEvent(event);
  }

  getLatestEventSequence(sessionId: string): Promise<number> {
    return this.turnEventStore.getLatestEventSequence(sessionId);
  }

  listEvents(sessionId: string, afterSequence?: number): Promise<EventRecord[]> {
    return this.turnEventStore.listEvents(sessionId, afterSequence);
  }

  addArtifact(artifact: ArtifactRecord): Promise<void> {
    return this.turnEventStore.addArtifact(artifact);
  }

  listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    return this.turnEventStore.listArtifacts(sessionId);
  }

  recordNotificationDelivery(delivery: NotificationDelivery): Promise<void> {
    return this.taskAuditStore.recordNotificationDelivery(delivery);
  }

  listNotificationDeliveries(
    filter?: ListNotificationDeliveriesFilter,
  ): Promise<NotificationDelivery[]> {
    return this.taskAuditStore.listNotificationDeliveries(filter);
  }

  recordTaskExecution(execution: TaskExecutionRecord): Promise<void> {
    return this.taskAuditStore.recordTaskExecution(execution);
  }

  getLatestTaskExecutionState(taskKey: string): Promise<Record<string, unknown> | null> {
    return this.taskAuditStore.getLatestTaskExecutionState(taskKey);
  }

  listTaskExecutions(
    taskKey?: string | undefined,
    limit?: number | undefined,
    projectId?: string | undefined,
  ): Promise<TaskExecutionRecord[]> {
    return this.taskAuditStore.listTaskExecutions(taskKey, limit, projectId);
  }

  appendTaskExecutionLogs(logs: readonly TaskExecutionLogRecord[]): Promise<void> {
    return this.taskAuditStore.appendTaskExecutionLogs(logs);
  }

  listTaskExecutionLogs(
    executionId: string,
    filter?: ListTaskExecutionLogsFilter | undefined,
  ): Promise<TaskExecutionLogRecord[]> {
    return this.taskAuditStore.listTaskExecutionLogs(executionId, filter);
  }

  createScheduledJob(job: ScheduledJobRecord): Promise<void> {
    return this.taskAuditStore.createScheduledJob(job);
  }

  cancelScheduledJob(sessionId: string, identifier: string): Promise<boolean> {
    return this.taskAuditStore.cancelScheduledJob(sessionId, identifier);
  }

  cancelScheduledJobById(jobId: string): Promise<boolean> {
    return this.taskAuditStore.cancelScheduledJobById(jobId);
  }

  listDueScheduledJobs(projectId?: string, asOf?: Date): Promise<ScheduledJobRecord[]> {
    return this.taskAuditStore.listDueScheduledJobs(projectId, asOf);
  }

  listScheduledJobs(filter?: ListScheduledJobsFilter): Promise<ScheduledJobRecord[]> {
    return this.taskAuditStore.listScheduledJobs(filter);
  }

  updateScheduledJobStatus(
    jobId: string,
    status: ScheduledJobStatusCode,
    summary?: string,
    finishedAt?: string,
  ): Promise<void> {
    return this.taskAuditStore.updateScheduledJobStatus(jobId, status, summary, finishedAt);
  }

  recordActionExecution(record: ActionExecutionRecord): Promise<void> {
    return this.taskAuditStore.recordActionExecution(record);
  }

  listActionExecutions(filter?: ActionExecutionFilter): Promise<ActionExecutionRecord[]> {
    return this.taskAuditStore.listActionExecutions(filter);
  }

  async close(): Promise<void> {}
}
