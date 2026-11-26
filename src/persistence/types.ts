import { randomUUID } from "node:crypto";
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
} from "../domain/types.ts";
import type {
  ListPipelineActionsFilter,
  ListPipelineNodeLogsFilter,
  ListPipelineRunsFilter,
  NewPipelineNodeRun,
  PipelineActionRecord,
  PipelineNodeLogRecord,
  PipelineNodeRunPatch,
  PipelineNodeRunRecord,
  PipelineNodeRunStatus,
  PipelineRevisionRecord,
  PipelineRunRecord,
  PipelineRunWorkspacePatch,
  PipelineTransitionResult,
  PipelineTransitionWrite,
  PipelineVersionRunCounts,
} from "../pipeline/types.ts";

export interface ListSessionsOptions {
  includeTasks?: boolean | undefined;
  includePipelines?: boolean | undefined;
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

/** Persistence of pipeline revisions, runs, node runs, action records and node logs. */
export interface PipelineStore {
  createRevision(revision: PipelineRevisionRecord): Promise<PipelineRevisionRecord>;
  getRevision(
    projectId: string,
    pipelineId: string,
    version: number,
  ): Promise<PipelineRevisionRecord | null>;
  getLatestRevision(projectId: string, pipelineId: string): Promise<PipelineRevisionRecord | null>;
  listRevisions(projectId: string, pipelineId: string): Promise<PipelineRevisionRecord[]>;

  /** Creates a run together with its first node run. */
  createRun(run: PipelineRunRecord, firstNodeRun: NewPipelineNodeRun): Promise<PipelineRunRecord>;
  getRun(runId: string): Promise<PipelineRunRecord | null>;
  findRunByExternalKey(
    projectId: string,
    pipelineId: string,
    externalKey: string,
  ): Promise<PipelineRunRecord | null>;
  listRuns(filter?: ListPipelineRunsFilter): Promise<PipelineRunRecord[]>;
  countRunsByVersion(projectId: string, pipelineId: string): Promise<PipelineVersionRunCounts[]>;
  /** Records where the run's shared workspace is; never changes the run's state. */
  updateRunWorkspace(runId: string, patch: PipelineRunWorkspacePatch): Promise<void>;

  /** Applies one state transition atomically; see `PipelineTransitionWrite`. */
  commitTransition(write: PipelineTransitionWrite): Promise<PipelineTransitionResult>;

  getNodeRun(nodeRunId: string): Promise<PipelineNodeRunRecord | null>;
  findNodeRunBySession(sessionId: string): Promise<PipelineNodeRunRecord | null>;
  listNodeRuns(runId: string): Promise<PipelineNodeRunRecord[]>;
  listNodeRunsByStatus(
    projectId: string,
    statuses: readonly PipelineNodeRunStatus[],
  ): Promise<PipelineNodeRunRecord[]>;
  listDueNodeRuns(projectId: string, asOf: Date): Promise<PipelineNodeRunRecord[]>;
  getNextPollAt(projectId: string): Promise<string | null>;
  /** Records what a node's executor did (session, turn, step state); never changes its status. */
  updateNodeRunProgress(
    nodeRunId: string,
    patch: Pick<PipelineNodeRunPatch, "sessionId" | "agentTurnId" | "stepState">,
  ): Promise<void>;

  listActionRecords(
    runId: string,
    filter?: ListPipelineActionsFilter,
  ): Promise<PipelineActionRecord[]>;
  getActionRecord(recordId: string): Promise<PipelineActionRecord | null>;
  getLatestActionSequence(runId: string): Promise<number>;

  appendNodeLogs(logs: readonly PipelineNodeLogRecord[]): Promise<void>;
  listNodeLogs(
    nodeRunId: string,
    filter?: ListPipelineNodeLogsFilter,
  ): Promise<PipelineNodeLogRecord[]>;
  getLatestNodeLogSequence(nodeRunId: string): Promise<number>;
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
    options?: ListTaskExecutionsOptions | undefined,
  ): Promise<TaskExecutionRecord[]>;
  appendTaskExecutionLogs(logs: readonly TaskExecutionLogRecord[]): Promise<void>;
  listTaskExecutionLogs(
    executionId: string,
    filter?: ListTaskExecutionLogsFilter | undefined,
  ): Promise<TaskExecutionLogRecord[]>;
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
  readonly pipelines: PipelineStore;
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
