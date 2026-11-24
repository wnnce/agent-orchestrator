import type {
  ActionExecutionRecord,
  ArtifactRecord,
  EventRecord,
  NotificationDelivery,
  ScheduledJobRecord,
  SessionRoute,
  TaskExecutionLogRecord,
  TaskExecutionRecord,
  TurnRecord,
  TurnUsage,
} from "../../domain/types.ts";
import type {
  ActionExecutionRow,
  ArtifactRow,
  EventRow,
  NotificationDeliveryRow,
  ScheduledJobRow,
  SessionRow,
  TaskExecutionLogRow,
  TaskExecutionRow,
  TurnRow,
} from "../schema.ts";

export function toSessionRoute(row: SessionRow): SessionRoute {
  const cursors = row.cursors ?? {};
  const metadata = row.metadata ?? {};
  const runtimeFromMeta =
    typeof metadata.runtime === "string" ? metadata.runtime : undefined;

  return {
    id: row.id,
    sessionId: row.sessionId,
    ...(row.title !== null ? { title: row.title } : {}),
    projectId: row.projectId,
    projectRuntimeId: row.projectRuntimeId,
    runtimeSessionId: row.runtimeSessionId,
    runtime: row.runtime ?? runtimeFromMeta ?? "unknown",
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.reasoningEffort !== null ? { reasoningEffort: row.reasoningEffort } : {}),
    ...(row.workspacePath !== null ? { workspacePath: row.workspacePath } : {}),
    configRevision: row.configRevision,
    status: row.status,
    source: row.source ?? "unknown",
    ...(row.externalChannel !== null ? { externalChannel: row.externalChannel } : {}),
    ...(row.externalConversationId !== null
      ? { externalConversationId: row.externalConversationId }
      : {}),
    ...(row.externalThreadId !== null ? { externalThreadId: row.externalThreadId } : {}),
    lastActiveAt: row.lastActiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt,
    ...(Object.keys(cursors).length > 0 ? { cursors } : {}),
    metadata,
  };
}

export function toTurnRecord(row: TurnRow): TurnRecord {
  const details = row.usageDetails;
  const hasUsage = row.totalTokens > 0 || row.model !== null || details !== null;
  const usage: TurnUsage | undefined = hasUsage
    ? {
        ...(row.model !== null ? { model: row.model } : {}),
        inputTokens: row.inputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        totalTokens: row.totalTokens,
        ...(details?.byModel !== undefined ? { byModel: details.byModel } : {}),
        ...(details?.contextUsedTokens !== undefined
          ? { contextUsedTokens: details.contextUsedTokens }
          : {}),
        ...(details?.contextWindowTokens !== undefined
          ? { contextWindowTokens: details.contextWindowTokens }
          : {}),
      }
    : undefined;

  return {
    id: row.turnId,
    sessionId: row.sessionId,
    input: row.input,
    status: row.status,
    ...(row.runtimeTurnId !== null ? { runtimeTurnId: row.runtimeTurnId } : {}),
    ...(row.output !== null ? { output: row.output } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(usage !== undefined ? { usage } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt !== null ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.finishedAt !== null ? { finishedAt: row.finishedAt.toISOString() } : {}),
  };
}

export function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.eventId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    sequence: row.sequence,
    type: row.type,
    runtime: row.runtime,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    schemaVersion: row.schemaVersion,
  };
}

export function toArtifactRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.artifactId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    kind: row.kind,
    path: row.path,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toNotificationDelivery(row: NotificationDeliveryRow): NotificationDelivery {
  return {
    id: row.deliveryId,
    projectId: row.projectId,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    configs: row.configs,
    message: row.message,
    status: row.status,
    details: row.details ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

export function toTaskExecutionRecord(row: TaskExecutionRow): TaskExecutionRecord {
  return {
    id: row.id,
    executionId: row.executionId,
    taskKey: row.taskKey,
    projectId: row.projectId,
    taskId: row.taskId,
    taskType: row.taskType,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    ...(row.finishedAt !== null ? { finishedAt: row.finishedAt.toISOString() } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    ...(row.stateBefore !== null ? { stateBefore: row.stateBefore } : {}),
    ...(row.stateAfter !== null ? { stateAfter: row.stateAfter } : {}),
    actionsSummary: row.actionsSummary,
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toTaskExecutionLogRecord(row: TaskExecutionLogRow): TaskExecutionLogRecord {
  return {
    id: row.id,
    executionId: row.executionId,
    projectId: row.projectId,
    taskKey: row.taskKey,
    sequence: row.sequence,
    level: row.level,
    message: row.message,
    ...(row.fields !== null ? { fields: row.fields } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toScheduledJobRecord(row: ScheduledJobRow): ScheduledJobRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    name: row.name,
    delayMinutes: row.delayMinutes,
    triggerAt: row.triggerAt.toISOString(),
    status: row.status,
    prompt: row.prompt,
    metadata: row.metadata ?? {},
    ...(row.resultSummary !== null ? { resultSummary: row.resultSummary } : {}),
    ...(row.finishedAt !== null ? { finishedAt: row.finishedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt,
  };
}

export function toActionExecutionRecord(row: ActionExecutionRow): ActionExecutionRecord {
  return {
    id: row.id,
    executionId: row.executionId,
    projectId: row.projectId,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    ...(row.taskKey !== null ? { taskKey: row.taskKey } : {}),
    caller: row.caller,
    actionName: row.actionName,
    parameters: row.parameters ?? {},
    status: row.status,
    ...(row.result !== null ? { result: row.result } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}
