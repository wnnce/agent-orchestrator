import type { ArtifactRecord, ProjectVarValue } from "../domain/types.ts";
import type { Origin } from "../domain/origin.ts";
import type { McpToolCallOptions, McpToolInfo, McpToolResult } from "../mcp/index.ts";
import type { NotificationMessage, NotificationOptions } from "../notifications/index.ts";
import type { Logger } from "../observability/logger.ts";
import type {
  PipelineRunRecord,
  PipelineSummaryWithVersions,
  StartPipelineRunParams,
  StartPipelineRunResult,
} from "../pipeline/types.ts";

/**
 * What code acting for a project can do. Tasks, pipeline code nodes, agent tools and hooks all
 * receive a `ProjectContext`, extended with what is specific to them; `origin` says which of them
 * is acting and decides attribution.
 */
export interface ProjectContext {
  readonly project: ProjectInfo;
  readonly origin: Origin;
  /** Carries the project and origin fields and the active trace. */
  readonly logger: Logger;
  /** Aborts when the work is canceled or times out; capabilities refuse to start after that. */
  readonly signal: AbortSignal;

  notify(message: NotificationMessage, options?: NotificationOptions): Promise<void>;
  readonly artifacts: ProjectArtifacts;
  readonly mcp: ProjectMcp;
  readonly sessions: ProjectSessions;
  readonly pipelines: ProjectPipelines;

  /** Renders a prompt template with `project`, `vars`, `now` and the origin's own variables. */
  render(template: string, extra?: Readonly<Record<string, unknown>>): string;
}

/** A task's persistent state, carried from one execution to the next. */
export interface TaskState<S extends object = Record<string, unknown>> {
  get(): Readonly<S>;
  /** Replaces the state. */
  set(next: S): void;
  /** Shallow-merges `patch` into the state. */
  merge(patch: Partial<S>): void;
}

export interface ProjectInfo {
  readonly id: string;
  /** The project's configuration directory (`projects/<id>/`), not its code repository. */
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly vars: Readonly<Record<string, ProjectVarValue>>;
}

export interface CreateArtifactParams {
  readonly kind: string;
  readonly content: string | Uint8Array;
  readonly contentType?: string | undefined;
}

export interface ProjectArtifacts {
  create(params: CreateArtifactParams): Promise<ArtifactRecord>;
}

export interface ProjectMcp {
  /** Calls a tool on one of the project's MCP servers (`project.yaml` `runtime.mcpServers`). */
  call<T = unknown>(
    server: string,
    tool: string,
    args?: Record<string, unknown>,
    options?: McpToolCallOptions,
  ): Promise<McpToolResult<T>>;
  list(server: string, options?: McpToolCallOptions): Promise<readonly McpToolInfo[]>;
}

export interface StartSessionParams {
  readonly title: string;
  readonly prompt: string;
  /** Defaults to the project's runtime, model and reasoning effort. */
  readonly runtime?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface StartedSession {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface ProjectSessions {
  /** Creates an agent session and submits its first turn. */
  start(params: StartSessionParams): Promise<StartedSession>;
}

export type PipelineRunQuery =
  { readonly runId: string } | { readonly pipelineId: string; readonly externalKey: string };

export interface ProjectPipelines {
  /** Starts a run, or returns the existing one with the same `externalKey`. */
  start(params: StartPipelineRunParams): Promise<StartPipelineRunResult>;
  find(query: { pipelineId: string; externalKey: string }): Promise<PipelineRunRecord | null>;
  /** The project's pipelines with their versions and entry input schemas. */
  list(): Promise<PipelineSummaryWithVersions[]>;
  /** Wakes the run's waiting node so it checks its `waitUntil` condition now. */
  signal(query: PipelineRunQuery): Promise<{ woken: boolean }>;
}
