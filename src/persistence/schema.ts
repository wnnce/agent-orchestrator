import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
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
import type {
  ActionExecutionRecord,
  NotificationConfig,
  NotificationDelivery,
  NotificationDeliveryDetail,
  ScheduledJobStatusCode,
  SessionStatus,
  TaskExecutionRecord,
  TurnStatus,
} from "../domain/types.ts";

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
    workspacePath: text("workspace_path"),
    externalChannel: varchar("external_channel", { length: 50 }),
    externalConversationId: varchar("external_conversation_id", { length: 255 }),
    externalThreadId: varchar("external_thread_id", { length: 255 }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    cursors: jsonb("cursors").$type<Record<string, number>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: bigint("deleted_at", { mode: "number" }).notNull().default(0),
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
    sessionId: varchar("session_id", { length: 100 }).notNull(),
    turnId: varchar("turn_id", { length: 100 }),
    kind: varchar("kind", { length: 100 }).notNull(),
    path: text("path").notNull(),
    contentType: varchar("content_type", { length: 255 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_artifacts_artifact_id").on(table.artifactId),
    index("idx_artifacts_session_created").on(table.sessionId, table.createdAt),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deliveryId: varchar("delivery_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    sessionId: varchar("session_id", { length: 100 }),
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
    status: smallint("status").$type<ScheduledJobStatusCode>().notNull().default(1),
    prompt: text("prompt").notNull().default(""),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    resultSummary: text("result_summary"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: bigint("deleted_at", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    uniqueIndex("idx_scheduled_jobs_job_id").on(table.jobId, table.deletedAt),
    index("idx_scheduled_jobs_poll")
      .on(table.status, table.triggerAt)
      .where(sql`status = 1 AND deleted_at = 0`),
    index("idx_scheduled_jobs_session")
      .on(table.sessionId, table.status)
      .where(sql`deleted_at = 0`),
  ],
);

export const actionExecutions = pgTable(
  "action_executions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    executionId: varchar("execution_id", { length: 100 }).notNull(),
    projectId: varchar("project_id", { length: 100 }).notNull(),
    sessionId: varchar("session_id", { length: 100 }),
    turnId: varchar("turn_id", { length: 100 }),
    taskKey: varchar("task_key", { length: 255 }),
    caller: varchar("caller", { length: 50 }).notNull().default("unknown"),
    actionName: varchar("action_name", { length: 100 }).notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    status: varchar("status", { length: 20 }).$type<ActionExecutionRecord["status"]>().notNull(),
    result: jsonb("result").$type<unknown>(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_action_executions_exec_id").on(table.executionId),
    index("idx_action_executions_session").on(table.sessionId, table.id.desc()),
    index("idx_action_executions_project").on(table.projectId, table.id.desc()),
    index("idx_action_executions_name").on(table.actionName, table.id.desc()),
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
  scheduledJobs,
  actionExecutions,
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
export type ScheduledJobRow = typeof scheduledJobs.$inferSelect;
export type ActionExecutionRow = typeof actionExecutions.$inferSelect;
