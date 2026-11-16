import { randomUUID } from "node:crypto";
import { Logger } from "../observability/logger.ts";
import type { NotificationConfig, ArtifactRecord } from "../domain/types.ts";
import type { NotificationMessage, NotificationOptions } from "../notifications/index.ts";
import type {
  ActionContext,
  ActionScope,
  ActionServicesMap,
  CreateArtifactParams,
  UpdateTaskStateOptions,
} from "./types.ts";

export interface CreateActionContextParams {
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly taskKey?: string | undefined;
  readonly scope?: ActionScope | undefined;
  readonly workdir?: string | undefined;
  readonly workspacePath?: string | undefined;
  readonly logger?: Logger | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly services?: (Partial<ActionServicesMap> & Record<string, unknown>) | undefined;
  readonly projectNotifications?: NotificationConfig[] | undefined;

  // Custom lifecycle hooks for runtime bridging or test mocking
  readonly onNotify?:
    | ((message: NotificationMessage, options?: NotificationOptions) => Promise<void>)
    | undefined;
  readonly onCreateArtifact?: ((params: CreateArtifactParams) => Promise<ArtifactRecord>) | undefined;
  readonly onGetTaskState?: (() => Promise<Record<string, unknown>>) | undefined;
  readonly onUpdateTaskState?: ((
    delta: Record<string, unknown>,
    options?: UpdateTaskStateOptions,
  ) => Promise<Record<string, unknown>>) | undefined;
  readonly onEmit?: ((type: string, payload: unknown) => Promise<void>) | undefined;
  readonly onDispatchTask?: ((params: import("./types.ts").DispatchTaskParams) => Promise<import("./types.ts").DispatchTaskResult>) | undefined;
}

/**
 * Creates a unified ActionContext instance.
 */
export function createActionContext(params: CreateActionContextParams): ActionContext {
  const projectId = params.projectId;
  const sessionId = params.sessionId;
  const turnId = params.turnId;
  const taskKey = params.taskKey;
  const scope: ActionScope = params.scope ?? (taskKey ? "task" : "all");
  const workdir = params.workdir ?? params.workspacePath;
  const logger = params.logger ?? new Logger();
  const signal = params.signal;
  const services = params.services;
  let sequenceCounter = 0;

  function getService<T = unknown>(token: string): T | undefined {
    if (!services) return undefined;
    if (token in services) {
      return services[token] as T;
    }
    // Compatible aliases
    if (token === "artifacts") return services.artifactStore as T | undefined;
    if (token === "artifactStore") return services.artifacts as T | undefined;
    return undefined;
  }

  function requireService<T = unknown>(token: string): T {
    const inst = getService<T>(token);
    if (inst === undefined || inst === null) {
      throw new Error(`Required service "${token}" not found in ActionContext`);
    }
    return inst;
  }

  return {
    projectId,
    sessionId,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(taskKey !== undefined ? { taskKey } : {}),
    scope,
    ...(workdir !== undefined ? { workdir } : {}),
    logger,
    ...(signal !== undefined ? { signal } : {}),

    async notify(message: NotificationMessage, options?: NotificationOptions): Promise<void> {
      if (params.onNotify) {
        await params.onNotify(message, options);
        return;
      }
      const outbox = services?.notifications;
      if (outbox) {
        await outbox.queue(projectId, sessionId, params.projectNotifications, message, options);
        return;
      }
      logger.info("notification sent via action context (no outbox configured)", {
        projectId,
        sessionId,
        title: message.title,
        target: options?.target ?? "all",
      });
    },

    async createArtifact(artifactParams: CreateArtifactParams): Promise<ArtifactRecord> {
      if (params.onCreateArtifact) {
        return await params.onCreateArtifact(artifactParams);
      }
      const store = services?.artifactStore ?? services?.artifacts;
      if (!store) {
        throw new Error("ArtifactStore is not configured in ActionContext");
      }
      return await store.write(
        projectId,
        sessionId,
        turnId,
        artifactParams.kind,
        artifactParams.content,
        artifactParams.contentType ?? "text/plain",
      );
    },

    async getTaskState(): Promise<Record<string, unknown>> {
      if (params.onGetTaskState) {
        return await params.onGetTaskState();
      }
      if (!taskKey) {
        throw new Error(
          "Cannot get task state outside of a task execution context (taskKey is undefined)",
        );
      }
      const engine = services?.taskEngine;
      if (engine) {
        return await engine.getState(taskKey);
      }
      return {};
    },

    async updateTaskState(
      delta: Record<string, unknown>,
      options?: UpdateTaskStateOptions,
    ): Promise<Record<string, unknown>> {
      if (params.onUpdateTaskState) {
        return await params.onUpdateTaskState(delta, options);
      }
      if (!taskKey) {
        throw new Error(
          "Cannot update task state outside of a task execution context (taskKey is undefined)",
        );
      }
      const engine = services?.taskEngine;
      if (!engine) {
        throw new Error("TaskEngine is not configured in ActionContext");
      }
      let newState: Record<string, unknown>;
      if (options?.merge !== false) {
        const existing = await engine.getState(taskKey);
        newState = { ...existing, ...delta };
      } else {
        newState = delta;
      }
      engine.updateState(taskKey, newState);
      return newState;
    },

    async emit(type: string, payload: unknown): Promise<void> {
      if (params.onEmit) {
        await params.onEmit(type, payload);
        return;
      }
      const hub = services?.eventHub;
      if (hub) {
        if (sequenceCounter === 0) {
          const store = services?.store;
          if (store && typeof store.getLatestEventSequence === "function") {
            try {
              sequenceCounter = await store.getLatestEventSequence(sessionId);
            } catch {
              sequenceCounter = 0;
            }
          }
        }
        sequenceCounter = Math.max(sequenceCounter + 1, 1);
        hub.publish({
          id: `evt_${randomUUID()}`,
          projectId,
          sessionId,
          ...(turnId !== undefined ? { turnId } : {}),
          sequence: sequenceCounter,
          type: type as any,
          runtime: taskKey ? "task" : "gateway",
          payload,
          createdAt: new Date().toISOString(),
          schemaVersion: 1,
        });
        return;
      }
      logger.debug("event emitted without EventHub configured", { type, payload });
    },

    async dispatchTask(dispatchParams: import("./types.ts").DispatchTaskParams): Promise<import("./types.ts").DispatchTaskResult> {
      if (params.onDispatchTask) {
        return await params.onDispatchTask(dispatchParams);
      }
      throw new Error("Task dispatching is not configured or supported in this ActionContext");
    },

    service<T = unknown>(token: string): T | undefined {
      return getService<T>(token);
    },

    requireService<T = unknown>(token: string): T {
      return requireService<T>(token);
    },
  };
}
