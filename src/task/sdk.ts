import { z } from "zod";
import type {
  ActionResult,
  CreateArtifactParams,
  DispatchTaskParams,
  DispatchTaskResult,
  UpdateTaskStateOptions,
} from "../actions/types.ts";
import type { ArtifactRecord, ProjectVarValue } from "../domain/types.ts";
import type { McpToolCallOptions, McpToolInfo, McpToolResult } from "../mcp/index.ts";
import type { NotificationMessage, NotificationOptions } from "../notifications/index.ts";
import type { Logger } from "../observability/logger.ts";

/**
 * Optional structured return value from a TypeScript task handler.
 */
export interface TsTaskResult {
  /** Incremental state patch (or full state when `mergeState: false`) to persist on success. */
  readonly state?: Record<string, unknown> | undefined;
  /** Whether to shallow-merge `state` into the current state (default: true). */
  readonly mergeState?: boolean | undefined;
  /** Optional structured summary recorded in `task_executions.actionsSummary`. */
  readonly summary?: Record<string, unknown> | undefined;
}

/**
 * Runtime capability context dynamically injected into every TypeScript task `run(ctx)` call.
 */
export interface TaskRunContext {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly taskName: string;
  readonly workdir: string;
  readonly env: Readonly<Record<string, string>>;
  /** Non-sensitive project variables from `project.yaml` `vars:`. */
  readonly vars: Readonly<Record<string, ProjectVarValue>>;
  readonly logger: Logger;
  readonly signal?: AbortSignal | undefined;
  /** Snapshot of the task's persisted incremental state before execution. */
  readonly state: Readonly<Record<string, unknown>>;

  /** Render a prompt template using this task's standard project/vars/task/state/now scopes. */
  renderPrompt(template: string, extraScopes?: Readonly<Record<string, unknown>>): string;

  /** Read the task's current incremental state. */
  getState(): Promise<Record<string, unknown>>;

  /** Update the task's incremental state (shallow-merged by default). */
  updateState(
    delta: Record<string, unknown>,
    options?: UpdateTaskStateOptions,
  ): Promise<Record<string, unknown>>;

  /** Send a notification through the project's configured NotificationOutbox. */
  notify(message: NotificationMessage, options?: NotificationOptions): Promise<void>;

  /** Persist an artifact to ArtifactStore. */
  createArtifact(params: CreateArtifactParams): Promise<ArtifactRecord>;

  /** Emit a custom event on the project's EventHub. */
  emit(type: string, payload: unknown): Promise<void>;

  /**
   * Dispatch a new independent Agent session in the current project.
   * Dispatched sessions always follow the project's default runtime, model, and reasoningEffort.
   */
  dispatchTask(params: DispatchTaskParams): Promise<DispatchTaskResult>;

  /** Invoke any registered Action in the project's ActionRegistry. */
  invokeAction<T = unknown>(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult<T>>;

  /**
   * Call a tool on a project-configured MCP server (from `project.yaml` `runtime.mcpServers`).
   * Connections are lazily created and reused for the duration of this task execution.
   */
  callMcpTool<T = unknown>(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>,
    options?: McpToolCallOptions,
  ): Promise<McpToolResult<T>>;

  /** List allowed tools exposed by a project-configured MCP server. */
  listMcpTools(serverName: string, options?: McpToolCallOptions): Promise<readonly McpToolInfo[]>;
}

export type TsTaskHandler = (
  ctx: TaskRunContext,
) => Promise<TsTaskResult | void> | TsTaskResult | void;

/**
 * Definition object passed to `api.registerTask(...)` inside a TypeScript task module.
 */
export interface TsTaskRegistration {
  /**
   * Short unique task identifier within the project.
   * Optional when the file registers only a single task (defaults to filename without `.ts`);
   * required when a file registers multiple tasks.
   */
  readonly id?: string | undefined;
  readonly name: string;
  readonly cron: string;
  readonly timezone?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly description?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly run: TsTaskHandler;
}

/**
 * Pi-style dynamic injection API passed to `export default function (api: TaskExtensionAPI)`.
 */
export interface TaskExtensionAPI {
  readonly projectId: string;
  readonly workdir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logger: Logger;
  registerTask(task: TsTaskRegistration): void;
}

export type TaskExtensionFactory = (api: TaskExtensionAPI) => void | Promise<void>;

/**
 * Strict validation schema for `api.registerTask(...)` definitions.
 */
export const tsTaskRegistrationSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1),
    cron: z.string().trim().min(1),
    timezone: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional().default(true),
    description: z.string().optional(),
    timeoutMs: z.number().positive().optional(),
    run: z.custom<TsTaskHandler>((value) => typeof value === "function", {
      message: "run must be a function",
    }),
  })
  .strict();

export type ValidatedTsTaskRegistration = z.infer<typeof tsTaskRegistrationSchema>;
