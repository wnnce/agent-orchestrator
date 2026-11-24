import { Pool } from "pg";
import type {
  ActionExecutionFilter,
  ActionExecutionRecord,
  ArtifactRecord,
  EventRecord,
  InboundMessageRecord,
  ListTaskExecutionLogsFilter,
  ListTaskExecutionsOptions,
  NotificationDelivery,
  ScheduledJobRecord,
  ScheduledJobStatusCode,
  SessionRoute,
  SessionUsageSummary,
  TaskExecutionLogRecord,
  TaskExecutionRecord,
  TurnRecord,
} from "../../domain/types.ts";
import { createDrizzleDb, type DrizzleDatabase } from "../db.ts";
import type {
  ListNotificationDeliveriesFilter,
  ListScheduledJobsFilter,
  ListSessionsOptions,
  Store,
  TurnPatch,
} from "../types.ts";
import { PostgresSessionRepo } from "./session-repo.ts";
import { PostgresTaskAuditRepo } from "./task-audit-repo.ts";
import { PostgresTurnEventRepo } from "./turn-event-repo.ts";

/** Drizzle ORM-backed PostgreSQL `Store` implementation. */
export class PostgresStore implements Store {
  private readonly sessionRepo: PostgresSessionRepo;
  private readonly turnEventRepo: PostgresTurnEventRepo;
  private readonly taskAuditRepo: PostgresTaskAuditRepo;
  private readonly onClose: () => Promise<void>;

  constructor(pool: Pool);
  constructor(db: DrizzleDatabase, onClose?: () => Promise<void>);
  constructor(poolOrDb: Pool | DrizzleDatabase, onClose?: () => Promise<void>) {
    if (poolOrDb instanceof Pool) {
      const db = createDrizzleDb(poolOrDb);
      this.sessionRepo = new PostgresSessionRepo(db);
      this.turnEventRepo = new PostgresTurnEventRepo(db);
      this.taskAuditRepo = new PostgresTaskAuditRepo(db);
      this.onClose = () => poolOrDb.end();
    } else {
      this.sessionRepo = new PostgresSessionRepo(poolOrDb);
      this.turnEventRepo = new PostgresTurnEventRepo(poolOrDb);
      this.taskAuditRepo = new PostgresTaskAuditRepo(poolOrDb);
      this.onClose = onClose ?? (async () => {});
    }
  }

  static fromUrl(databaseUrl: string): PostgresStore {
    return new PostgresStore(new Pool({ connectionString: databaseUrl, max: 10 }));
  }

  static fromDrizzle(db: DrizzleDatabase, onClose?: () => Promise<void>): PostgresStore {
    return new PostgresStore(db, onClose);
  }

  createSession(route: SessionRoute): Promise<SessionRoute> {
    return this.sessionRepo.createSession(route);
  }

  getSession(sessionId: string): Promise<SessionRoute | null> {
    return this.sessionRepo.getSession(sessionId);
  }

  listSessions(projectId?: string, options?: ListSessionsOptions): Promise<SessionRoute[]> {
    return this.sessionRepo.listSessions(projectId, options);
  }

  updateSession(route: SessionRoute): Promise<void> {
    return this.sessionRepo.updateSession(route);
  }

  updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
    return this.sessionRepo.updateSessionTitle(sessionId, title);
  }

  setTitleIfEmpty(sessionId: string, title: string): Promise<boolean> {
    return this.sessionRepo.setTitleIfEmpty(sessionId, title);
  }

  findSessionByExternal(
    channel: string,
    conversationId: string,
    threadId?: string,
  ): Promise<SessionRoute | null> {
    return this.sessionRepo.findSessionByExternal(channel, conversationId, threadId);
  }

  claimInboundMessage(message: InboundMessageRecord): Promise<boolean> {
    return this.sessionRepo.claimInboundMessage(message);
  }

  releaseInboundMessage(messageId: string): Promise<void> {
    return this.sessionRepo.releaseInboundMessage(messageId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.sessionRepo.deleteSession(sessionId);
  }

  createTurn(turn: TurnRecord): Promise<void> {
    return this.turnEventRepo.createTurn(turn);
  }

  getTurn(turnId: string): Promise<TurnRecord | null> {
    return this.turnEventRepo.getTurn(turnId);
  }

  getLatestTurn(sessionId: string): Promise<TurnRecord | null> {
    return this.turnEventRepo.getLatestTurn(sessionId);
  }

  updateTurn(turnId: string, patch: TurnPatch): Promise<void> {
    return this.turnEventRepo.updateTurn(turnId, patch);
  }

  getSessionUsage(sessionId: string): Promise<SessionUsageSummary | null> {
    return this.turnEventRepo.getSessionUsage(sessionId);
  }

  appendEvent(event: EventRecord): Promise<EventRecord> {
    return this.turnEventRepo.appendEvent(event);
  }

  getLatestEventSequence(sessionId: string): Promise<number> {
    return this.turnEventRepo.getLatestEventSequence(sessionId);
  }

  listEvents(sessionId: string, afterSequence?: number): Promise<EventRecord[]> {
    return this.turnEventRepo.listEvents(sessionId, afterSequence);
  }

  addArtifact(artifact: ArtifactRecord): Promise<void> {
    return this.turnEventRepo.addArtifact(artifact);
  }

  listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    return this.turnEventRepo.listArtifacts(sessionId);
  }

  recordNotificationDelivery(delivery: NotificationDelivery): Promise<void> {
    return this.taskAuditRepo.recordNotificationDelivery(delivery);
  }

  listNotificationDeliveries(
    filter?: ListNotificationDeliveriesFilter,
  ): Promise<NotificationDelivery[]> {
    return this.taskAuditRepo.listNotificationDeliveries(filter);
  }

  recordTaskExecution(execution: TaskExecutionRecord): Promise<void> {
    return this.taskAuditRepo.recordTaskExecution(execution);
  }

  getLatestTaskExecutionState(taskKey: string): Promise<Record<string, unknown> | null> {
    return this.taskAuditRepo.getLatestTaskExecutionState(taskKey);
  }

  listTaskExecutions(
    taskKey?: string | undefined,
    limit?: number | undefined,
    projectId?: string | undefined,
    options?: ListTaskExecutionsOptions | undefined,
  ): Promise<TaskExecutionRecord[]> {
    return this.taskAuditRepo.listTaskExecutions(taskKey, limit, projectId, options);
  }

  appendTaskExecutionLogs(logs: readonly TaskExecutionLogRecord[]): Promise<void> {
    return this.taskAuditRepo.appendTaskExecutionLogs(logs);
  }

  listTaskExecutionLogs(
    executionId: string,
    filter?: ListTaskExecutionLogsFilter | undefined,
  ): Promise<TaskExecutionLogRecord[]> {
    return this.taskAuditRepo.listTaskExecutionLogs(executionId, filter);
  }

  createScheduledJob(job: ScheduledJobRecord): Promise<void> {
    return this.taskAuditRepo.createScheduledJob(job);
  }

  cancelScheduledJob(sessionId: string, identifier: string): Promise<boolean> {
    return this.taskAuditRepo.cancelScheduledJob(sessionId, identifier);
  }

  cancelScheduledJobById(jobId: string): Promise<boolean> {
    return this.taskAuditRepo.cancelScheduledJobById(jobId);
  }

  listDueScheduledJobs(projectId?: string, asOf?: Date): Promise<ScheduledJobRecord[]> {
    return this.taskAuditRepo.listDueScheduledJobs(projectId, asOf);
  }

  listScheduledJobs(filter?: ListScheduledJobsFilter): Promise<ScheduledJobRecord[]> {
    return this.taskAuditRepo.listScheduledJobs(filter);
  }

  updateScheduledJobStatus(
    jobId: string,
    status: ScheduledJobStatusCode,
    summary?: string,
    finishedAt?: string,
  ): Promise<void> {
    return this.taskAuditRepo.updateScheduledJobStatus(jobId, status, summary, finishedAt);
  }

  recordActionExecution(record: ActionExecutionRecord): Promise<void> {
    return this.taskAuditRepo.recordActionExecution(record);
  }

  listActionExecutions(filter?: ActionExecutionFilter): Promise<ActionExecutionRecord[]> {
    return this.taskAuditRepo.listActionExecutions(filter);
  }

  close(): Promise<void> {
    return this.onClose();
  }
}
