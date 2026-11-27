import type { SessionStatus, TaskExecutionRecord } from "../domain/types.ts";
import type {
  PipelineNodeExecutorType,
  PipelineNodeRunStatus,
  PipelineRunStatus,
} from "../pipeline/types.ts";

export type ProjectMetricsRange = "7d" | "14d" | "30d";

export interface ProjectOverviewQueryOptions {
  /** Max items per preview list (attention / live). Defaults to 5. */
  limit?: number | undefined;
  /** Lookback window in days for recent failed executions/runs. Defaults to 7. */
  failureLookbackDays?: number | undefined;
  /** Reference timestamp for deterministic tests. Defaults to `new Date()`. */
  now?: Date | undefined;
}

export interface ProjectMetricsQueryOptions {
  range: ProjectMetricsRange;
  /** Validated IANA time zone (e.g. `Asia/Shanghai`, `UTC`). Defaults to `UTC`. */
  tz?: string | undefined;
  /** Reference timestamp for deterministic tests. Defaults to `new Date()`. */
  now?: Date | undefined;
}

export interface ProjectOverviewSessionItem {
  sessionId: string;
  title?: string;
  status: SessionStatus;
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
  status: PipelineRunStatus;
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
  executorType: PipelineNodeExecutorType;
  status: PipelineNodeRunStatus;
  startedAt?: string;
  nextPollAt?: string;
  updatedAt: string;
}

export interface ProjectOverviewTaskFailureItem {
  executionId: string;
  taskId: string;
  taskKey: string;
  status: TaskExecutionRecord["status"];
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

/** Store-level snapshot of live project state (without in-memory ProjectManager task definitions). */
export interface ProjectOverviewStoreSnapshot {
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

export interface ProjectOverviewData extends ProjectOverviewStoreSnapshot {
  generatedAt: string;
  tasks: {
    total: number;
    enabled: number;
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
