import type { z } from "zod";
import type { Logger } from "../observability/logger.ts";
import type { Context } from "../observability/tracing.ts";
import type {
  NotificationMessage,
  NotificationOptions,
  NotificationOutbox,
  NotificationHub,
} from "../notifications/index.ts";
import type { ArtifactRecord } from "../domain/types.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { Store } from "../persistence/store.ts";
import type { TaskEngine } from "../task/engine.ts";
import type { EventHub } from "../events/hub.ts";
import type { SessionManager } from "../session/manager.ts";
import type { PipelineEngine } from "../pipeline/engine.ts";

/**
 * Action applicability scope:
 * - task: Available only in project static task execution sessions
 * - conversation: Available only in interactive chat sessions
 * - pipeline: Available only in project pipeline agent node sessions
 * - all: Available in all contexts (default)
 */
export type ActionScope = "task" | "conversation" | "pipeline" | "all";

/**
 * Underlying system services map for dependency injection.
 */
export interface ActionServicesMap {
  readonly notifications: NotificationOutbox;
  readonly notificationHub: NotificationHub;
  readonly artifacts: ArtifactStore;
  readonly artifactStore: ArtifactStore;
  readonly store: Store;
  readonly taskEngine: TaskEngine;
  readonly eventHub: EventHub;
  readonly sessionManager: SessionManager;
  readonly pipelineEngine: PipelineEngine;
}

export type ActionServiceToken = keyof ActionServicesMap;

/**
 * Artifact creation parameters.
 */
export interface CreateArtifactParams {
  readonly kind: string;
  readonly content: string | Uint8Array;
  readonly contentType?: string | undefined;
}

/**
 * Task state update options.
 */
export interface UpdateTaskStateOptions {
  readonly merge?: boolean | undefined;
}

/**
 * Dispatch agent task parameters.
 */
export interface DispatchTaskParams {
  readonly title: string;
  readonly prompt: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface DispatchTaskResult {
  readonly sessionId: string;
  readonly turnId?: string | undefined;
}

/**
 * Unified action execution context.
 */
export interface ActionContext {
  // Identity & execution metadata
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly taskKey?: string | undefined;
  readonly scope: ActionScope;
  readonly workdir?: string | undefined;

  // Observability & lifecycle
  readonly logger: Logger;
  readonly signal?: AbortSignal | undefined;
  /**
   * Trace the action's span belongs to, e.g. the agent turn that called it. Runtimes invoke
   * actions from their own callbacks, whose active context says nothing about the caller.
   */
  readonly traceContext?: Context | undefined;

  // First-class business APIs
  /**
   * Enqueue a business notification to NotificationOutbox.
   */
  notify(message: NotificationMessage, options?: NotificationOptions): Promise<void>;

  /**
   * Create and persist an artifact to ArtifactStore.
   */
  createArtifact(params: CreateArtifactParams): Promise<ArtifactRecord>;

  /**
   * Retrieve incremental persisted state/cursor for current task.
   */
  getTaskState(): Promise<Record<string, unknown>>;

  /**
   * Update incremental persisted state/cursor for current task.
   */
  updateTaskState(
    delta: Record<string, unknown>,
    options?: UpdateTaskStateOptions,
  ): Promise<Record<string, unknown>>;

  /**
   * Emit a custom domain event to EventHub.
   */
  emit(type: string, payload: unknown): Promise<void>;

  /**
   * Dispatch an isolated agent session and execute initial turn prompt.
   */
  dispatchTask(params: DispatchTaskParams): Promise<DispatchTaskResult>;

  // Service locator escape hatch
  /**
   * Get underlying service instance (e.g., "notifications", "artifacts", "store").
   */
  service<K extends keyof ActionServicesMap>(token: K): ActionServicesMap[K] | undefined;
  service<T = unknown>(token: string): T | undefined;

  /**
   * Get underlying service instance or throw if missing.
   */
  requireService<K extends keyof ActionServicesMap>(token: K): ActionServicesMap[K];
  requireService<T = unknown>(token: string): T;
}

/**
 * Action definition specification.
 */
export interface ActionDefinition<TParams = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType<TParams> | Record<string, unknown>;
  readonly scopes?: readonly ActionScope[] | undefined;
  handler(params: TParams, context: ActionContext): Promise<TResult>;
}

/**
 * Codex App-Server dynamic tool specification.
 */
export interface CodexDynamicToolSpec {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * OpenAI Function Calling specification.
 */
export interface OpenAIFunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * Unified action execution result envelope.
 */
export interface ActionResult<T = unknown> {
  readonly success: boolean;
  readonly data?: T | undefined;
  readonly error?: string | undefined;
}
