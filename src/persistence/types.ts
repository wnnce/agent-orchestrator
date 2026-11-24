import { randomUUID } from "node:crypto";
import type {
  ActionExecutionFilter,
  ActionExecutionRecord,
  ArtifactRecord,
  EventRecord,
  InboundMessageRecord,
  NotificationDelivery,
  ScheduledJobRecord,
  ScheduledJobStatusCode,
  SessionRoute,
  SessionUsageSummary,
  TaskExecutionRecord,
  TurnRecord,
} from "../domain/types.ts";

export interface ListSessionsOptions {
  includeTasks?: boolean | undefined;
}

export type TurnPatch = Partial<
  Pick<
    TurnRecord,
    "status" | "runtimeTurnId" | "output" | "error" | "usage" | "startedAt" | "finishedAt"
  >
>;

export interface ListNotificationDeliveriesFilter {
  projectId?: string | undefined;
  sessionId?: string | undefined;
  status?: "sent" | "partial" | "failed" | undefined;
  limit?: number | undefined;
}

export interface ListScheduledJobsFilter {
  sessionId?: string | undefined;
  projectId?: string | undefined;
  status?: ScheduledJobStatusCode | undefined;
  limit?: number | undefined;
}

export interface Store {
  createSession(route: SessionRoute): Promise<SessionRoute>;
  getSession(sessionId: string): Promise<SessionRoute | null>;
  listSessions(projectId?: string, options?: ListSessionsOptions): Promise<SessionRoute[]>;
  /** Saves session state. Titles are not written here; see updateSessionTitle and setTitleIfEmpty. */
  updateSession(route: SessionRoute): Promise<void>;
  updateSessionTitle(sessionId: string, title: string): Promise<boolean>;
  /** Sets the title only while the session has none; returns whether it was set. */
  setTitleIfEmpty(sessionId: string, title: string): Promise<boolean>;
  findSessionByExternal(
    channel: string,
    conversationId: string,
    threadId?: string,
  ): Promise<SessionRoute | null>;
  claimInboundMessage(message: InboundMessageRecord): Promise<boolean>;
  releaseInboundMessage(messageId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  createTurn(turn: TurnRecord): Promise<void>;
  getTurn(turnId: string): Promise<TurnRecord | null>;
  getLatestTurn(sessionId: string): Promise<TurnRecord | null>;
  updateTurn(turnId: string, patch: TurnPatch): Promise<void>;
  getSessionUsage(sessionId: string): Promise<SessionUsageSummary | null>;
  appendEvent(event: EventRecord): Promise<EventRecord>;
  getLatestEventSequence(sessionId: string): Promise<number>;
  listEvents(sessionId: string, afterSequence?: number): Promise<EventRecord[]>;
  addArtifact(artifact: ArtifactRecord): Promise<void>;
  listArtifacts(sessionId: string): Promise<ArtifactRecord[]>;
  recordNotificationDelivery(delivery: NotificationDelivery): Promise<void>;
  listNotificationDeliveries(
    filter?: ListNotificationDeliveriesFilter,
  ): Promise<NotificationDelivery[]>;
  recordTaskExecution(execution: TaskExecutionRecord): Promise<void>;
  getLatestTaskExecutionState(taskKey: string): Promise<Record<string, unknown> | null>;
  listTaskExecutions(
    taskKey?: string | undefined,
    limit?: number | undefined,
    projectId?: string | undefined,
  ): Promise<TaskExecutionRecord[]>;
  createScheduledJob(job: ScheduledJobRecord): Promise<void>;
  cancelScheduledJob(sessionId: string, identifier: string): Promise<boolean>;
  cancelScheduledJobById(jobId: string): Promise<boolean>;
  listDueScheduledJobs(projectId?: string, asOf?: Date): Promise<ScheduledJobRecord[]>;
  listScheduledJobs(filter?: ListScheduledJobsFilter): Promise<ScheduledJobRecord[]>;
  updateScheduledJobStatus(
    jobId: string,
    status: ScheduledJobStatusCode,
    summary?: string,
    finishedAt?: string,
  ): Promise<void>;
  recordActionExecution(record: ActionExecutionRecord): Promise<void>;
  listActionExecutions(filter?: ActionExecutionFilter): Promise<ActionExecutionRecord[]>;
  close(): Promise<void>;
}

/** Clamps a query limit to `[1, maxLimit]`, falling back to `defaultLimit` when omitted. */
export function clampLimit(
  limit: number | undefined,
  defaultLimit = 50,
  maxLimit = 200,
): number {
  if (limit === undefined || !Number.isFinite(limit)) return defaultLimit;
  return Math.max(1, Math.min(Math.trunc(limit), maxLimit));
}

export function newSessionRoute(projectId: string, configRevision = 1): SessionRoute {
  return {
    sessionId: `ses_${randomUUID()}`,
    projectId,
    projectRuntimeId: `project-runtime:${projectId}`,
    runtimeSessionId: null,
    configRevision,
    status: "active",
    lastActiveAt: new Date().toISOString(),
  };
}
