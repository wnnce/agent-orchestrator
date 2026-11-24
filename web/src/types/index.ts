export type StudioView = "project" | "sessions" | "tasks" | "jobs";
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
  type?: string;
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
