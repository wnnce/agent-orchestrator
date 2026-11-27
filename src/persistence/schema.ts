import type { OriginKind, SessionOwner } from "../domain/origin.ts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import {
  NOT_DELETED,
  ScheduledJobStatus,
  type ToolExecutionRecord,
  type NotificationConfig,
  type NotificationDelivery,
  type NotificationDeliveryDetail,
  type ScheduledJobStatusCode,
  type SessionStatus,
  type TaskExecutionLogLevel,
  type TaskExecutionRecord,
  type TurnStatus,
  type TurnUsageDetails,
} from "../domain/types.ts";
import type {
  PipelineActionContextPayload,
  PipelineActionName,
  PipelineAgentDecision,
  PipelineActorType,
  PipelineNodeExecutorType,
  PipelineNodeOutputSummary,
  PipelineNodeRunStatus,
  PipelineNodeSnapshot,
  PipelineRunStatus,
  PipelineStepState,
  PipelineWorkspaceStatus,
} from "../pipeline/types.ts";

export const sessions = pgTable(
  "sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: varchar("session_id", { length: 100 }).notNull(),
    title: varchar("title", { length: 255 }),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    projectRuntimeId: varchar("project_runtime_id", { length: 100 }).notNull(),
    runtimeSessionId: varchar("runtime_session_id", { length: 100 }),
    configRevision: integer("config_revision").notNull().default(1),
    status: varchar("status", { length: 50 }).$type<SessionStatus>().notNull(),
    source: varchar("source", { length: 50 }).notNull().default("unknown"),
    runtime: varchar("runtime", { length: 50 }).notNull().default("unknown"),
    model: varchar("model", { length: 150 }),
    reasoningEffort: varchar("reasoning_effort", { length: 30 }),
    workspacePath: text("workspace_path"),
    externalChannel: varchar("external_channel", { length: 50 }),
    externalConversationId: varchar("external_conversation_id", { length: 255 }),
    externalThreadId: varchar("external_thread_id", { length: 255 }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    cursors: jsonb("cursors").$type<Record<string, number>>().notNull().default({}),
    owner: jsonb("owner").$type<SessionOwner>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: bigint("deleted_at", { mode: "number" }).notNull().default(NOT_DELETED),
  },
  (table) => [
    uniqueIndex("idx_sessions_session_id").on(table.sessionId, table.deletedAt),
    index("idx_sessions_project").on(table.projectId, table.deletedAt),
    index("idx_sessions_external").on(
      table.externalChannel,
      table.externalConversationId,
      table.externalThreadId,
      table.deletedAt,
    ),
    index("idx_sessions_source").on(table.source),
    index("idx_sessions_project_source").on(table.projectId, table.source, table.deletedAt),
  ],
);

export const turns = pgTable(
  "turns",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    turnId: varchar("turn_id", { length: 100 }).notNull(),
    sessionId: varchar("session_id", { length: 100 }).notNull(),
    input: text("input").notNull(),
    status: varchar("status", { length: 50 }).$type<TurnStatus>().notNull(),
    runtimeTurnId: varchar("runtime_turn_id", { length: 100 }),
    output: text("output"),
    error: text("error"),
    model: varchar("model", { length: 150 }),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    usageDetails: jsonb("usage_details").$type<TurnUsageDetails>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_turns_turn_id").on(table.turnId),
    index("idx_turns_session").on(table.sessionId, table.createdAt.desc(), table.id.desc()),
  ],
);

export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    messageId: varchar("message_id", { length: 100 }).notNull(),
    channel: varchar("channel", { length: 50 }).notNull(),
    conversationId: varchar("conversation_id", { length: 255 }).notNull(),
    threadId: varchar("thread_id", { length: 255 }),
    sessionId: varchar("session_id", { length: 100 }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_inbound_messages_message_id").on(table.messageId),
    index("idx_inbound_messages_conversation").on(
      table.channel,
      table.conversationId,
      table.threadId,
      table.receivedAt,
    ),
  ],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: varchar("event_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    sessionId: varchar("session_id", { length: 100 }).notNull(),
    turnId: varchar("turn_id", { length: 100 }),
    sequence: integer("sequence").notNull(),
    type: varchar("type", { length: 100 }).notNull(),
    runtime: varchar("runtime", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    schemaVersion: integer("schema_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_events_event_id").on(table.eventId),
    uniqueIndex("idx_events_session_sequence").on(table.sessionId, table.sequence),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    artifactId: varchar("artifact_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    originKind: varchar("origin_kind", { length: 20 }).$type<OriginKind>().notNull(),
    originId: varchar("origin_id", { length: 100 }).notNull(),
    turnId: varchar("turn_id", { length: 100 }),
    kind: varchar("kind", { length: 100 }).notNull(),
    path: text("path").notNull(),
    contentType: varchar("content_type", { length: 255 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_artifacts_artifact_id").on(table.artifactId),
    index("idx_artifacts_origin_created").on(table.originKind, table.originId, table.createdAt),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deliveryId: varchar("delivery_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    originKind: varchar("origin_kind", { length: 20 }).$type<OriginKind>(),
    originId: varchar("origin_id", { length: 100 }),
    configs: jsonb("configs").$type<NotificationConfig[]>().notNull(),
    message: jsonb("message").$type<NotificationDelivery["message"]>().notNull(),
    status: varchar("status", { length: 50 }).$type<NotificationDelivery["status"]>().notNull(),
    details: jsonb("details").$type<NotificationDeliveryDetail[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_notification_deliveries_delivery_id").on(table.deliveryId)],
);

export const taskExecutions = pgTable(
  "task_executions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    executionId: varchar("execution_id", { length: 100 }).notNull(),
    taskKey: varchar("task_key", { length: 255 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    taskId: varchar("task_id", { length: 100 }).notNull(),
    taskType: varchar("task_type", { length: 30 })
      .$type<TaskExecutionRecord["taskType"]>()
      .notNull(),
    sessionId: varchar("session_id", { length: 100 }),
    turnId: varchar("turn_id", { length: 100 }),
    status: varchar("status", { length: 30 }).$type<TaskExecutionRecord["status"]>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    stateBefore: jsonb("state_before").$type<Record<string, unknown>>(),
    stateAfter: jsonb("state_after").$type<Record<string, unknown>>(),
    actionsSummary: jsonb("actions_summary").$type<Record<string, unknown>>().notNull().default({}),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_task_executions_execution_id").on(table.executionId),
    index("idx_task_executions_task_key").on(table.taskKey, table.id.desc()),
    index("idx_task_executions_project").on(table.projectId, table.id.desc()),
    index("idx_task_executions_state_recovery")
      .on(table.taskKey, table.id.desc())
      .where(sql`status = 'success'`),
  ],
);

export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: varchar("job_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    sessionId: varchar("session_id", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    delayMinutes: integer("delay_minutes").notNull().default(0),
    triggerAt: timestamp("trigger_at", { withTimezone: true }).notNull(),
    status: smallint("status")
      .$type<ScheduledJobStatusCode>()
      .notNull()
      .default(ScheduledJobStatus.PENDING),
    prompt: text("prompt").notNull().default(""),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    resultSummary: text("result_summary"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: bigint("deleted_at", { mode: "number" }).notNull().default(NOT_DELETED),
  },
  (table) => [
    uniqueIndex("idx_scheduled_jobs_job_id").on(table.jobId, table.deletedAt),
    index("idx_scheduled_jobs_poll")
      .on(table.status, table.triggerAt)
      .where(sql.raw(`status = ${ScheduledJobStatus.PENDING} AND deleted_at = ${NOT_DELETED}`)),
    index("idx_scheduled_jobs_session")
      .on(table.sessionId, table.status)
      .where(sql.raw(`deleted_at = ${NOT_DELETED}`)),
  ],
);

export const toolExecutions = pgTable(
  "tool_executions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    executionId: varchar("execution_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    sessionId: varchar("session_id", { length: 100 }).notNull(),
    turnId: varchar("turn_id", { length: 100 }),
    ownerKind: varchar("owner_kind", { length: 20 }).$type<OriginKind>(),
    ownerId: varchar("owner_id", { length: 100 }),
    toolName: varchar("tool_name", { length: 100 }).notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 20 }).$type<ToolExecutionRecord["status"]>().notNull(),
    result: jsonb("result").$type<unknown>(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_tool_executions_exec_id").on(table.executionId),
    index("idx_tool_executions_session").on(table.sessionId, table.id.desc()),
    index("idx_tool_executions_project").on(table.projectId, table.id.desc()),
    index("idx_tool_executions_name").on(table.toolName, table.id.desc()),
    index("idx_tool_executions_owner").on(table.ownerKind, table.ownerId, table.id.desc()),
  ],
);

export const taskExecutionLogs = pgTable(
  "task_execution_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    executionId: varchar("execution_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    taskKey: varchar("task_key", { length: 255 }).notNull(),
    sequence: integer("sequence").notNull(),
    level: varchar("level", { length: 16 }).$type<TaskExecutionLogLevel>().notNull(),
    message: text("message").notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_task_execution_logs_exec_seq").on(table.executionId, table.sequence),
    index("idx_task_execution_logs_task_key").on(table.taskKey, table.id.desc()),
  ],
);

export const pipelineRevisions = pgTable(
  "pipeline_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    pipelineId: varchar("pipeline_id", { length: 100 }).notNull(),
    version: integer("version").notNull(),
    topologyHash: varchar("topology_hash", { length: 64 }).notNull(),
    nodesSnapshot: jsonb("nodes_snapshot").$type<PipelineNodeSnapshot[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_pipeline_revisions_version").on(
      table.projectId,
      table.pipelineId,
      table.version,
    ),
    index("idx_pipeline_revisions_lookup").on(
      table.projectId,
      table.pipelineId,
      table.version.desc(),
    ),
  ],
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: varchar("run_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    pipelineId: varchar("pipeline_id", { length: 100 }).notNull(),
    pipelineVersion: integer("pipeline_version").notNull(),
    externalKey: varchar("external_key", { length: 255 }),
    externalUrl: text("external_url"),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    currentNodeId: varchar("current_node_id", { length: 100 }).notNull(),
    status: varchar("status", { length: 40 }).$type<PipelineRunStatus>().notNull(),
    workspacePath: text("workspace_path"),
    branchName: varchar("branch_name", { length: 255 }),
    workspaceStatus: varchar("workspace_status", { length: 30 })
      .$type<PipelineWorkspaceStatus>()
      .notNull()
      .default("none"),
    loopCounts: jsonb("loop_counts").$type<Record<string, number>>().notNull().default({}),
    statusSummary: text("status_summary"),
    activeNodeRunId: varchar("active_node_run_id", { length: 100 }),
    latestNodeOutputs: jsonb("latest_node_outputs")
      .$type<Record<string, PipelineNodeOutputSummary>>()
      .notNull()
      .default({}),
    createdBy: varchar("created_by", { length: 100 }).notNull().default("system"),
    stateVersion: integer("state_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_pipeline_runs_run_id").on(table.runId),
    uniqueIndex("idx_pipeline_runs_external_key")
      .on(table.projectId, table.pipelineId, table.externalKey)
      .where(sql`external_key IS NOT NULL`),
    index("idx_pipeline_runs_board").on(
      table.projectId,
      table.pipelineId,
      table.pipelineVersion,
      table.currentNodeId,
      table.id.desc(),
    ),
    index("idx_pipeline_runs_status").on(table.projectId, table.status, table.id.desc()),
  ],
);

export const pipelineNodeRuns = pgTable(
  "pipeline_node_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeRunId: varchar("node_run_id", { length: 100 }).notNull(),
    runId: varchar("run_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    pipelineId: varchar("pipeline_id", { length: 100 }).notNull(),
    nodeId: varchar("node_id", { length: 100 }).notNull(),
    attempt: integer("attempt").notNull(),
    sequence: integer("sequence").notNull(),
    executorType: varchar("executor_type", { length: 30 })
      .$type<PipelineNodeExecutorType>()
      .notNull(),
    sessionId: varchar("session_id", { length: 100 }),
    triggeredByRecordId: varchar("triggered_by_record_id", { length: 100 }),
    traceparent: varchar("traceparent", { length: 55 }),
    status: varchar("status", { length: 40 }).$type<PipelineNodeRunStatus>().notNull(),
    inputContext: jsonb("input_context").$type<Record<string, unknown>>().notNull().default({}),
    finalAction: varchar("final_action", { length: 50 }).$type<PipelineActionName>(),
    outputSummary: text("output_summary"),
    errorMessage: text("error_message"),
    stepState: jsonb("step_state").$type<PipelineStepState>().notNull().default({}),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    pollCount: integer("poll_count").notNull().default(0),
    agentTurnId: varchar("agent_turn_id", { length: 100 }),
    reminderSent: boolean("reminder_sent").notNull().default(false),
    pendingDecision: jsonb("pending_decision").$type<PipelineAgentDecision>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: bigint("duration_ms", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_pipeline_node_runs_id").on(table.nodeRunId),
    uniqueIndex("idx_pipeline_node_runs_run_seq").on(table.runId, table.sequence),
    index("idx_pipeline_node_runs_session").on(table.sessionId),
    // Only queued and running rows: the scheduler, restart recovery and the capacity check read
    // these, and they stay few however much history a project collects.
    index("idx_pipeline_node_runs_active")
      .on(table.projectId, table.status, table.id)
      .where(sql`status IN ('queued', 'running')`),
    index("idx_pipeline_node_runs_poll")
      .on(table.projectId, table.nextPollAt)
      .where(sql`status = 'waiting' AND next_poll_at IS NOT NULL`),
  ],
);

export const pipelineActionRecords = pgTable(
  "pipeline_action_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recordId: varchar("record_id", { length: 100 }).notNull(),
    runId: varchar("run_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    sequence: integer("sequence").notNull(),
    nodeRunId: varchar("node_run_id", { length: 100 }),
    nodeId: varchar("node_id", { length: 100 }).notNull(),
    attempt: integer("attempt").notNull(),
    action: varchar("action", { length: 50 }).$type<PipelineActionName>().notNull(),
    actorType: varchar("actor_type", { length: 20 }).$type<PipelineActorType>().notNull(),
    actorId: varchar("actor_id", { length: 100 }),
    fromNodeId: varchar("from_node_id", { length: 100 }).notNull(),
    toNodeId: varchar("to_node_id", { length: 100 }),
    fromStatus: varchar("from_status", { length: 40 }).$type<PipelineRunStatus>().notNull(),
    toStatus: varchar("to_status", { length: 40 }).$type<PipelineRunStatus>().notNull(),
    context: jsonb("context").$type<PipelineActionContextPayload>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_pipeline_action_records_id").on(table.recordId),
    uniqueIndex("idx_pipeline_action_records_run_seq").on(table.runId, table.sequence),
    index("idx_pipeline_action_records_node").on(table.runId, table.nodeId, table.attempt),
  ],
);

export const pipelineNodeLogs = pgTable(
  "pipeline_node_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeRunId: varchar("node_run_id", { length: 100 }).notNull(),
    runId: varchar("run_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    sequence: integer("sequence").notNull(),
    level: varchar("level", { length: 16 }).$type<TaskExecutionLogLevel>().notNull(),
    message: text("message").notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_pipeline_node_logs_run_seq").on(table.nodeRunId, table.sequence),
    index("idx_pipeline_node_logs_run_id").on(table.runId, table.id.desc()),
  ],
);

export const schema = {
  sessions,
  turns,
  inboundMessages,
  events,
  artifacts,
  notificationDeliveries,
  taskExecutions,
  taskExecutionLogs,
  scheduledJobs,
  toolExecutions,
  pipelineRevisions,
  pipelineRuns,
  pipelineNodeRuns,
  pipelineActionRecords,
  pipelineNodeLogs,
};

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type TurnRow = typeof turns.$inferSelect;
export type NewTurnRow = typeof turns.$inferInsert;
export type InboundMessageRow = typeof inboundMessages.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
export type TaskExecutionRow = typeof taskExecutions.$inferSelect;
export type TaskExecutionLogRow = typeof taskExecutionLogs.$inferSelect;
export type NewTaskExecutionLogRow = typeof taskExecutionLogs.$inferInsert;
export type ScheduledJobRow = typeof scheduledJobs.$inferSelect;
export type ToolExecutionRow = typeof toolExecutions.$inferSelect;
export type PipelineRevisionRow = typeof pipelineRevisions.$inferSelect;
export type PipelineRunRow = typeof pipelineRuns.$inferSelect;
export type PipelineNodeRunRow = typeof pipelineNodeRuns.$inferSelect;
export type PipelineActionRecordRow = typeof pipelineActionRecords.$inferSelect;
export type PipelineNodeLogRow = typeof pipelineNodeLogs.$inferSelect;
