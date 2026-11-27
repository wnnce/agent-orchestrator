export type StudioView = "project" | "sessions" | "pipelines" | "tasks" | "jobs";
export type ThemeMode = "dark" | "light" | "cyber";

export interface ProjectSkillMetadata {
  name: string;
  description: string;
  version?: string;
}

export interface ProjectSkill {
  id: string;
  name: string;
  description: string;
  dirPath: string;
  skillFilePath: string;
  metadata?: ProjectSkillMetadata;
}

export interface RuntimeModelOption {
  id: string;
  displayName: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  contextWindow?: number;
}

export interface RuntimeInfo {
  name: string;
  type: string;
  description?: string;
  defaultReasoningEfforts?: string[];
  internal?: boolean;
  models: RuntimeModelOption[];
}

export interface ProjectRuntimeDefault {
  type: string;
  model?: string;
  reasoningEffort?: string;
}

export interface ProjectRouting {
  projectId: string;
  displayName?: string;
  summary?: string;
  /** The project's repository URL. */
  repository?: string;
  runtime?: ProjectRuntimeDefault;
  keywords?: string[];
  routingHints?: string[];
}

export type ProjectMetricsRange = "7d" | "14d" | "30d";

export interface ProjectOverviewSessionItem {
  sessionId: string;
  title?: string;
  status: SessionRoute["status"];
  source?: string;
  externalChannel?: string;
  runtime?: string;
  model?: string;
  lastActiveAt: string;
}

export interface ProjectOverviewPipelineRunItem {
  runId: string;
  pipelineId: string;
  pipelineVersion: number;
  title: string;
  currentNodeId: string;
  status: string;
  statusSummary?: string;
  updatedAt: string;
  createdAt: string;
}

export interface ProjectOverviewPipelineNodeItem {
  nodeRunId: string;
  runId: string;
  pipelineId: string;
  runTitle?: string;
  nodeId: string;
  executorType: string;
  status: string;
  startedAt?: string;
  nextPollAt?: string;
  updatedAt: string;
}

export interface ProjectOverviewTaskFailureItem {
  executionId: string;
  taskId: string;
  taskKey: string;
  status: string;
  errorMessage?: string;
  startedAt?: string;
  durationMs?: number;
}

export interface ProjectOverviewScheduledJobItem {
  jobId: string;
  sessionId: string;
  name: string;
  triggerAt: string;
  delayMinutes: number;
}

export interface ProjectOverviewData {
  generatedAt: string;
  sessions: {
    active: number;
    idle: number;
    suspended: number;
    archived: number;
    total: number;
  };
  pipelines: {
    running: number;
    waiting: number;
    waitingConfirmation: number;
    failed: number;
    completed: number;
    cancelled: number;
    total: number;
  };
  tasks: {
    total: number;
    enabled: number;
  };
  scheduledJobs: {
    pending: number;
  };
  attention: {
    waitingConfirmations: ProjectOverviewPipelineRunItem[];
    failedPipelineRuns: ProjectOverviewPipelineRunItem[];
    failedTaskExecutions: ProjectOverviewTaskFailureItem[];
  };
  live: {
    activeSessions: ProjectOverviewSessionItem[];
    activePipelineNodes: ProjectOverviewPipelineNodeItem[];
    upcomingJobs: ProjectOverviewScheduledJobItem[];
  };
}

export interface ProjectMetricsDailyPoint {
  date: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  turnCount: number;
  taskSuccess: number;
  taskFailed: number;
  pipelineCompleted: number;
  pipelineFailed: number;
}

export interface ProjectMetricsModelBreakdown {
  model: string;
  turnCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
}

export interface ProjectMetricsSourceBreakdown {
  source: string;
  sessionCount: number;
  turnCount: number;
  totalTokens: number;
}

export interface ProjectMetricsData {
  generatedAt: string;
  range: ProjectMetricsRange;
  days: number;
  tz: string;
  since: string;
  summary: {
    turnCount: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cacheHitRate: number | null;
    taskSuccess: number;
    taskFailed: number;
    taskTotal: number;
    taskSuccessRate: number | null;
    pipelineCompleted: number;
    pipelineFailed: number;
    pipelineTotal: number;
  };
  daily: ProjectMetricsDailyPoint[];
  byModel: ProjectMetricsModelBreakdown[];
  bySource: ProjectMetricsSourceBreakdown[];
}

export interface SessionRoute {
  sessionId: string;
  title?: string;
  projectId: string;
  projectRuntimeId?: string;
  runtimeSessionId?: string | null;
  runtime?: string;
  model?: string;
  reasoningEffort?: string;
  configRevision?: number;
  status: "active" | "idle" | "suspended" | "closing" | "closed" | "archived" | "failed";
  source?: string;
  externalChannel?: string;
  externalConversationId?: string;
  externalThreadId?: string;
  lastActiveAt: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: number;
  metadata?: Record<string, any>;
}

export interface TaskRuntimeConfig {
  type?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface TaskDefinition {
  taskKey: string;
  projectId: string;
  taskId: string;
  name: string;
  cron: string;
  timezone?: string;
  enabled: boolean;
  description?: string;
  promptTemplate: string;
  filePath: string;
  sourceFormat?: "markdown" | "typescript";
  type?: string;
  command?: string;
  action?: string;
  actionParams?: Record<string, unknown>;
  timeoutMs?: number;
  runtime?: TaskRuntimeConfig;
  isScheduled?: boolean;
  nextRun?: string | null;
}

export interface TaskExecutionRecord {
  id?: number;
  executionId: string;
  taskKey: string;
  projectId: string;
  taskId: string;
  taskType: string;
  sessionId?: string;
  turnId?: string;
  status: "success" | "failed";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  stateBefore?: Record<string, unknown>;
  stateAfter?: Record<string, unknown>;
  actionsSummary?: Record<string, unknown>;
  errorMessage?: string;
  createdAt?: string;
}

export type TaskExecutionLogLevel = "debug" | "info" | "warn" | "error";

export interface TaskExecutionLogRecord {
  id?: number;
  executionId: string;
  projectId: string;
  taskKey: string;
  sequence: number;
  level: TaskExecutionLogLevel;
  message: string;
  fields?: Record<string, unknown>;
  createdAt: string;
}

export type ScheduledJobStatusCode = 0 | 1 | 2 | 3 | 4;

export interface ScheduledJobRecord {
  id?: number;
  jobId: string;
  projectId: string;
  sessionId: string;
  name: string;
  delayMinutes: number;
  triggerAt: string;
  status: ScheduledJobStatusCode;
  prompt: string;
  metadata?: Record<string, unknown>;
  resultSummary?: string;
  finishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RuntimeEvent {
  id?: string;
  sequence?: number;
  type: string;
  sessionId?: string;
  turnId?: string;
  payload?: any;
  createdAt?: string;
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  projectId?: string;
  turnId?: string;
  kind?: string;
  path: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface CommandExecution {
  id: string;
  command: string;
  output: string;
  status: "running" | "completed" | "failed";
}

export type MessagePart =
  | {
      id: string;
      type: "reasoning";
      content: string;
      status?: "streaming" | "completed";
    }
  | {
      id: string;
      type: "command";
      command: string;
      output: string;
      status: "running" | "completed" | "failed";
    }
  | {
      id: string;
      type: "tool";
      toolName: string;
      serverName?: string;
      args?: Record<string, unknown>;
      result?: unknown;
      status: "running" | "completed" | "failed";
    }
  | {
      id: string;
      type: "text";
      content: string;
      status?: "streaming" | "completed";
    };

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface ModelTokenUsage extends TokenUsage {
  model: string;
  provider?: string;
}

export interface TurnUsage extends TokenUsage {
  model?: string;
  byModel?: ModelTokenUsage[];
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

export interface SessionUsageSummary extends TokenUsage {
  turnCount: number;
  lastModel?: string;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts?: MessagePart[];
  thinking?: string;
  commands?: CommandExecution[];
  usage?: TurnUsage;
  error?: string;
  status?: "pending" | "streaming" | "completed" | "failed" | "interrupted";
  timestamp: number;
}

// =====================================================================
// Project Pipeline Workflow Types
// =====================================================================

export type PipelineNodeExecutorType = "agent" | "ts" | "human" | "terminal";
export type PipelineNodeGate = "auto" | "manual";

export type PipelineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "waiting_confirmation"
  | "failed"
  | "completed"
  | "cancelled";

export type PipelineNodeRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "waiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

export type PipelineWorkspaceStatus = "none" | "active" | "cleaned";

export type PipelineActionName =
  | "pipeline_next"
  | "pipeline_prev"
  | "pipeline_request_confirmation"
  | "pipeline_fail"
  | "human_approve"
  | "human_reject"
  | "human_retry"
  | "human_cancel"
  | "system_fallback"
  | "system_loop_breaker";

export type PipelineActorType = "agent" | "ts" | "human" | "system";

export interface PipelineNodeSnapshot {
  id: string;
  name: string;
  executor: PipelineNodeExecutorType;
  terminal: boolean;
  gate: PipelineNodeGate;
  allowPrev: boolean;
  prevTargets: string[];
  maxLoops: number;
}

export interface PipelineRevisionRecord {
  id?: number;
  projectId: string;
  pipelineId: string;
  version: number;
  topologyHash: string;
  nodesSnapshot: PipelineNodeSnapshot[];
  createdAt: string;
}

export interface PipelineVersionSummary {
  version: number;
  activeRunCount: number;
  totalRunCount: number;
  nodes: PipelineNodeSnapshot[];
}

export interface PipelineSummaryWithVersions {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  currentVersion: number;
  currentTopologyHash: string;
  nodes: PipelineNodeSnapshot[];
  entryInputSchema?: Record<string, unknown>;
  notifyOn: PipelineRunStatus[];
  activeVersions: PipelineVersionSummary[];
}

export interface PipelineNodeOutputSummary {
  nodeId: string;
  attempt: number;
  recordId: string;
  action: PipelineActionName;
  summary: string;
  createdAt: string;
}

export interface PipelineRunRecord {
  id?: number;
  runId: string;
  projectId: string;
  pipelineId: string;
  pipelineVersion: number;
  title: string;
  description?: string;
  externalKey?: string;
  externalUrl?: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: PipelineRunStatus;
  currentNodeId: string;
  activeNodeRunId?: string;
  workspacePath?: string;
  branchName?: string;
  workspaceStatus: PipelineWorkspaceStatus;
  loopCounts: Record<string, number>;
  latestNodeOutputs: Record<string, PipelineNodeOutputSummary>;
  statusSummary?: string;
  createdBy: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface PipelineWaitStateEntry {
  status: "waiting" | "done";
  startedAt: string;
  completedAt?: string;
  value?: unknown;
  summary?: string;
}

export interface PipelineStepCacheEntry {
  value?: unknown;
}

export interface PipelineStepState {
  steps?: Record<string, PipelineStepCacheEntry>;
  waits?: Record<string, PipelineWaitStateEntry>;
}

export interface PipelineActionContextPayload {
  summary?: string;
  content?: string;
  reason?: string;
  feedback?: string;
  question?: string;
  options?: string[];
  targetNodeId?: string;
  artifacts?: string[];
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  humanNote?: string;
}

export interface PipelineAgentDecision {
  action: PipelineActionName;
  context: PipelineActionContextPayload;
  turnId?: string;
}

export interface PipelineNodeRunRecord {
  nodeRunId: string;
  runId: string;
  projectId: string;
  pipelineId: string;
  nodeId: string;
  attempt: number;
  sequence: number;
  executorType: PipelineNodeExecutorType;
  triggeredByRecordId?: string;
  /** W3C traceparent of the operation that created this node run (when tracing is enabled). */
  traceparent?: string;
  status: PipelineNodeRunStatus;
  sessionId?: string;
  inputContext: Record<string, unknown>;
  stepState: PipelineStepState;
  nextPollAt?: string;
  pollCount: number;
  agentTurnId?: string;
  reminderSent: boolean;
  pendingDecision?: PipelineAgentDecision;
  outputSummary?: string;
  finalAction?: PipelineActionName;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineActionRecord {
  id?: number;
  recordId: string;
  runId: string;
  projectId: string;
  sequence: number;
  nodeRunId?: string;
  nodeId: string;
  attempt: number;
  action: PipelineActionName;
  actorType: PipelineActorType;
  actorId?: string;
  fromNodeId: string;
  toNodeId?: string;
  fromStatus: PipelineRunStatus;
  toStatus: PipelineRunStatus;
  context: PipelineActionContextPayload;
  result: Record<string, unknown>;
  createdAt: string;
}

export interface PipelineNodeLogRecord {
  id?: number;
  nodeRunId: string;
  runId: string;
  projectId: string;
  sequence: number;
  level: TaskExecutionLogLevel;
  message: string;
  fields?: Record<string, unknown>;
  createdAt: string;
}

export interface PipelineRunDetail {
  run: PipelineRunRecord;
  revision: PipelineRevisionRecord | null;
  nodeRuns: PipelineNodeRunRecord[];
  actionCount: number;
}

export type PipelineStreamEventType =
  | "pipeline.run.created"
  | "pipeline.run.updated"
  | "pipeline.node.updated"
  | "pipeline.action.recorded"
  | "pipeline.run.completed"
  | "pipeline.run.cancelled";

export interface PipelineStreamEvent {
  id: string;
  type: PipelineStreamEventType;
  projectId: string;
  pipelineId: string;
  pipelineVersion: number;
  runId: string;
  nodeId: string;
  status: PipelineRunStatus;
  payload: Record<string, unknown>;
  createdAt: string;
}
