export * from "./events.ts";

export type SessionStatus =
  | "active"
  | "idle"
  | "suspended"
  | "closing"
  | "closed"
  | "archived"
  | "failed";
export type TurnStatus =
  "queued" | "in_progress" | "completed" | "failed" | "interrupted";

export interface GitIdentity {
  name?: string;
  email?: string;
}

export interface RepoAuthConfig {
  type: "ssh-key" | "token";
  key?: string;
  keyPath?: string;
  keyEnv?: string;
  keyContent?: string;
  keyContentEnv?: string;
  token?: string;
  tokenEnv?: string;
}

/** A project's repository. An empty `url` gives each session a plain directory without git. */
export interface RepositoryConfig {
  url: string;
  baseBranch: string;
  /** A local checkout to use as the base repository, relative to the project directory. */
  path?: string;
  auth?: RepoAuthConfig;
  committer?: GitIdentity;
}

export interface McpServerConfig {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  auth?: string;
  headers?: Record<string, string>;
  http_headers?: Record<string, string>;
  required?: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  enabledTools?: string[];
  disabledTools?: string[];
  approvalMode?: "auto" | "prompt" | "writes" | "approve";
}

export interface ProjectRoutingDescription {
  projectId: string;
  displayName?: string;
  summary?: string;
  keywords?: string[];
  jiraProjectKeys?: string[];
  routingHints?: string[];
}

export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Per-session runtime overrides supplied at session creation time. */
export interface SessionRuntimeOverride {
  readonly runtime?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/**
 * What a project chooses about its agent. Everything else (login, providers, default model,
 * permissions, global MCP servers) comes from the runtime's own configuration.
 */
export interface ProjectRuntimeConfig {
  /** Runtime adapter; defaults to the service's `defaultRuntime`. */
  type?: string;
  /** Interpreted by the runtime; defaults to the runtime's own default model. */
  model?: string;
  /** Runtimes ignore levels they do not support. */
  reasoningEffort?: ReasoningEffort;
  /** Added to the MCP servers of the runtime's own configuration. */
  mcpServers?: McpServerConfig[];
}

/** How long a project's sessions stay open. */
export interface ProjectSessionConfig {
  /** Inactivity after which a session's runtime is released (default 30 minutes). */
  idleTimeoutMs?: number;
  /** Inactivity after which a session is archived and its worktree removed (default 1 hour). */
  archiveTimeoutMs?: number;
}

export interface ProjectMetaConfig {
  id?: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  enabled?: boolean;
}

export interface ProjectConfig {
  id: string;
  revision?: number;
  displayName: string;
  description: string;
  projectDir?: string;
  tags?: string[];
  enabled?: boolean;
  project?: ProjectMetaConfig;
  routing: ProjectRoutingDescription;
  runtime?: ProjectRuntimeConfig;
  session?: ProjectSessionConfig;
  env?: Record<string, string>;
  repository?: RepositoryConfig;
  credentials?: Record<string, string>;
  notifications?: NotificationConfig[];
  notifyOnTurnCompleted?: boolean | undefined;
}

export interface NotificationConfig {
  type: "log" | "webhook" | "feishu" | "wecom" | "telegram" | (string & {});
  name: string;
  url?: string | undefined;
  secret?: string | undefined;
  botToken?: string | undefined;
  chatId?: string | undefined;
  enabled?: boolean | undefined;
}

/** Sentinel value stored in `deletedAt` for active (non-deleted) entities. */
export const NOT_DELETED = 0;

/**
 * Base entity interface with full lifecycle tracking (auto-increment ID, timestamps, soft delete).
 * Applied to core business entities such as projects, sessions, scheduled_jobs.
 */
export interface BaseEntity {
  readonly id?: number | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly deletedAt?: number | undefined; // NOT_DELETED (0) for active, >0 timestamp in ms when soft-deleted
}

/**
 * Base record interface for append-only audit and log tables.
 * Applied to turns, events, artifacts, task_executions.
 */
export interface BaseLogRecord<TId = number> {
  readonly id?: TId | undefined;
  readonly createdAt?: string | undefined;
}

export interface NotificationDeliveryDetail {
  name: string;
  type: string;
  success: boolean;
  error?: string | undefined;
}

export interface NotificationDelivery {
  id: string;
  projectId: string;
  sessionId?: string | undefined;
  configs: NotificationConfig[];
  message: {
    title: string;
    text: string;
    markdown?: string | undefined;
    level?: "info" | "success" | "warning" | "error" | undefined;
    metadata?: Record<string, unknown> | undefined;
  };
  status: "sent" | "partial" | "failed";
  details: NotificationDeliveryDetail[];
  createdAt: string;
}

export interface SessionRoute extends BaseEntity {
  sessionId: string;
  title?: string;
  projectId: string;
  projectRuntimeId: string;
  runtimeSessionId: string | null;
  runtime?: string;
  model?: string;
  reasoningEffort?: string;
  /** Absolute path of the session's working directory, fixed when the session is created. */
  workspacePath?: string;
  configRevision: number;
  status: SessionStatus;
  source?: string;
  externalChannel?: string;
  externalConversationId?: string;
  externalThreadId?: string;
  lastActiveAt: string;
  /**
   * Checkpoint sequences consumed by different sources (e.g. feishu, web, cli).
   */
  cursors?: Record<string, number>;
  /**
   * Session scratchpad or custom context metadata.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Canonical normalized token breakdown using strictly exclusive input buckets.
 *
 * Invariants:
 * - `totalTokens === inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`
 * - `reasoningTokens` is a subset of `outputTokens` (0 when not reported separately)
 * - Cache hit rate: `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`
 */
export interface TokenUsage {
  /** Uncached new input tokens (strictly excludes cacheReadTokens and cacheWriteTokens). */
  readonly inputTokens: number;
  /** Input tokens served from prompt cache. */
  readonly cacheReadTokens: number;
  /** Input tokens written into prompt cache. */
  readonly cacheWriteTokens: number;
  /** Output tokens generated by the model (includes reasoningTokens). */
  readonly outputTokens: number;
  /** Reasoning/thinking tokens within outputTokens (0 if unreported). */
  readonly reasoningTokens: number;
  /** Total tokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens. */
  readonly totalTokens: number;
}

/** Per-model token breakdown for turns that invoke multiple models (e.g., subagents). */
export interface ModelTokenUsage extends TokenUsage {
  readonly model: string;
  readonly provider?: string | undefined;
}

/** Structured extension details stored in `turns.usage_details` JSONB. */
export interface TurnUsageDetails {
  readonly byModel?: readonly ModelTokenUsage[] | undefined;
  /** Context window occupancy at the last LLM call of the turn (high-water level, not summed). */
  readonly contextUsedTokens?: number | undefined;
  /** Model context window size limit. */
  readonly contextWindowTokens?: number | undefined;
}

/** Unified per-turn model usage reported by every runtime adapter. */
export interface TurnUsage extends TokenUsage, TurnUsageDetails {
  /** Primary model identifier for this turn. */
  readonly model?: string | undefined;
}

/** Session-level aggregated usage computed from `turns`. */
export interface SessionUsageSummary extends TokenUsage {
  /** Number of turns with recorded usage. */
  readonly turnCount: number;
  /** Primary model used by the most recent turn with usage. */
  readonly lastModel?: string | undefined;
  /** Context window occupancy reported by the most recent turn. */
  readonly contextUsedTokens?: number | undefined;
  /** Context window limit reported by the most recent turn. */
  readonly contextWindowTokens?: number | undefined;
}

export interface TurnRecord extends BaseLogRecord<string> {
  id: string;
  sessionId: string;
  input: string;
  status: TurnStatus;
  runtimeTurnId?: string;
  output?: string;
  error?: string;
  usage?: TurnUsage | undefined;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface InboundMessageRecord {
  readonly id?: number | undefined;
  messageId: string;
  channel: string;
  conversationId: string;
  threadId?: string;
  sessionId?: string;
  receivedAt: string;
  createdAt?: string | undefined;
}

export interface ArtifactRecord extends BaseLogRecord<string> {
  id: string;
  projectId: string;
  sessionId: string;
  turnId?: string;
  kind: string;
  path: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export type TaskExecutionStatus = "success" | "failed" | "skipped_overlapping" | "timeout";

export interface ListTaskExecutionsOptions {
  readonly beforeId?: number | undefined;
  readonly status?: TaskExecutionStatus | undefined;
}

export interface TaskExecutionRecord extends BaseLogRecord {
  readonly executionId: string;
  readonly taskKey: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskType: "project_task" | "scheduled_job";
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly status: TaskExecutionStatus;
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly stateBefore?: Record<string, unknown> | undefined;
  readonly stateAfter?: Record<string, unknown> | undefined;
  readonly actionsSummary?: Record<string, unknown> | undefined;
  readonly errorMessage?: string | undefined;
}

export type TaskExecutionLogLevel = "debug" | "info" | "warn" | "error";

export interface TaskExecutionLogRecord extends BaseLogRecord {
  readonly executionId: string;
  readonly projectId: string;
  readonly taskKey: string;
  readonly sequence: number;
  readonly level: TaskExecutionLogLevel;
  readonly message: string;
  readonly fields?: Record<string, unknown> | undefined;
  readonly createdAt: string;
}

export interface ListTaskExecutionLogsFilter {
  readonly afterSequence?: number | undefined;
  readonly level?: TaskExecutionLogLevel | undefined;
  readonly limit?: number | undefined;
}

export const ScheduledJobStatus = {
  COMPLETED: 0,
  PENDING: 1,
  RUNNING: 2,
  CANCELLED: 3,
  ABANDONED: 4,
} as const;

export type ScheduledJobStatusCode =
  (typeof ScheduledJobStatus)[keyof typeof ScheduledJobStatus];

export interface ScheduledJobRecord extends BaseEntity {
  readonly jobId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly delayMinutes: number;
  readonly triggerAt: string;
  readonly status: ScheduledJobStatusCode;
  readonly prompt: string;
  readonly metadata: Record<string, unknown>;
  readonly resultSummary?: string | undefined;
  readonly finishedAt?: string | undefined;
}

export interface ActionExecutionRecord {
  readonly id?: string | number | undefined;
  readonly executionId: string;
  readonly projectId: string;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly taskKey?: string | undefined;
  readonly caller: string;
  readonly actionName: string;
  readonly parameters: Record<string, unknown>;
  readonly status: "success" | "failure";
  readonly result?: unknown | undefined;
  readonly errorMessage?: string | undefined;
  readonly durationMs: number;
  readonly createdAt?: string | undefined;
}

export interface ActionExecutionFilter {
  readonly projectId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly actionName?: string | undefined;
  readonly limit?: number | undefined;
}
