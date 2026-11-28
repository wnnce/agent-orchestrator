import { ValidationError } from "../domain/errors.ts";
import type { SessionOwner } from "../domain/origin.ts";
import type {
  ProjectConfig,
  ReasoningEffort,
  SessionRoute,
  SessionRuntimeOverride,
} from "../domain/types.ts";
import type { Logger } from "../observability/logger.ts";
import {
  RuntimeSessionNotFoundError,
  type AgentRuntime,
  type RuntimeContext,
  type RuntimeEvent,
} from "../runtime/runtime.ts";
import type { SessionTools } from "../tools/index.ts";
import type { SessionEntity } from "./entity.ts";
import type { SessionEvents } from "./events.ts";

/** Which agent runtime runs a session, and with what model. */
export interface AgentSettings {
  readonly runtime: AgentRuntime;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** How a session's runtime, model and effort are asked for: what a session records or requests. */
export type AgentRequest = Pick<SessionRuntimeOverride, "runtime" | "model" | "reasoningEffort">;

export interface AgentRuntimesDeps {
  readonly project: ProjectConfig;
  readonly defaultRuntime: AgentRuntime;
  /** Creates the other runtimes a session may ask for by type. */
  readonly runtimeFactory?: ((type: string) => AgentRuntime) | undefined;
  /** The project's agents may only read (the global project). */
  readonly readOnly: boolean;
  readonly events: SessionEvents;
  readonly logger: Logger;
  /** The tools a session's agent is offered. */
  readonly toolsFor: (
    sessionId: string,
    workspacePath: string,
    owner: SessionOwner | undefined,
  ) => SessionTools;
  /** Where the runtime's events for a session go. */
  readonly onEvent: (sessionId: string, event: RuntimeEvent) => Promise<void>;
}

/** A runtime name as asked for: trimmed and lowercased; blank and `unknown` mean "not asked". */
export function normalizeRuntimeName(name: string | undefined): string | undefined {
  const normalized = name?.trim().toLowerCase();
  return normalized && normalized !== "unknown" ? normalized : undefined;
}

/**
 * The agent runtimes of one project, and which sessions they hold in this process.
 *
 * A session asks for a runtime by name, and for a model and reasoning effort. Only a session on
 * the project's default runtime inherits the project's model and effort; another runtime gets
 * what the session asked for or its own defaults.
 */
export class AgentRuntimes {
  private readonly created = new Map<string, AgentRuntime>();
  /** Sessions the agent runtime currently holds in this process. */
  private readonly bound = new Set<string>();

  constructor(private readonly deps: AgentRuntimesDeps) {}

  get default(): AgentRuntime {
    return this.deps.defaultRuntime;
  }

  /** The settings for a new session; asking for a runtime that is not available is an error. */
  settingsFor(request: AgentRequest | undefined): AgentSettings {
    const runtime = this.find(request?.runtime);
    if (!runtime) {
      throw new ValidationError(
        `runtime not available for project ${this.deps.project.id}: ${request?.runtime}`,
      );
    }
    return this.settings(runtime, request);
  }

  /**
   * The settings a stored session runs with. When the runtime it recorded is no longer available,
   * it runs on the project's default runtime with the project's model.
   */
  settingsForRoute(route: SessionRoute): AgentSettings {
    const runtime = this.find(route.runtime);
    return runtime ? this.settings(runtime, route) : this.settings(this.default, undefined);
  }

  /** Starts a runtime session for a new session and returns the runtime's session ID. */
  async start(
    sessionId: string,
    workspacePath: string,
    settings: AgentSettings,
    owner: SessionOwner | undefined,
  ): Promise<string> {
    const context = this.context(sessionId, workspacePath, settings, owner);
    const started = await settings.runtime.startSession(context);
    this.bound.add(sessionId);
    return started.id;
  }

  /**
   * Makes sure the agent runtime holds this session, resuming it at most once per process. When
   * the session's recorded runtime is still available, that runtime resumes it. When the runtime
   * no longer has the session, or the recorded runtime is no longer available, a new runtime
   * session is started and `session.runtime_reset` is emitted: the agent's earlier context is lost.
   */
  async bind(
    entity: SessionEntity,
    workspacePath: string,
  ): Promise<{ runtimeSessionId: string; runtime: AgentRuntime; context: RuntimeContext }> {
    const route = entity.toRoute();
    const previousId = route.runtimeSessionId;
    const recorded = this.find(route.runtime);
    const settings = this.settingsForRoute(route);
    const context = this.context(route.sessionId, workspacePath, settings, route.owner);
    const { runtime } = settings;
    if (previousId && recorded && this.bound.has(route.sessionId)) {
      return { runtimeSessionId: previousId, runtime, context };
    }

    let resetReason: "not_found" | "runtime_changed" | undefined;
    let runtimeSessionId: string | undefined;
    if (previousId && !recorded) {
      resetReason = "runtime_changed";
    } else if (previousId) {
      try {
        runtimeSessionId = (await runtime.resumeSession(context, previousId)).id;
      } catch (error) {
        if (!(error instanceof RuntimeSessionNotFoundError)) throw error;
        resetReason = "not_found";
      }
    }
    runtimeSessionId ??= (await runtime.startSession(context)).id;
    entity.bindRuntime(runtimeSessionId, runtime.name);
    this.bound.add(route.sessionId);

    if (previousId && resetReason) {
      const details = {
        reason: resetReason,
        runtime: runtime.name,
        previousRuntimeSessionId: previousId,
        runtimeSessionId,
      };
      this.deps.logger.warn("runtime session reset; earlier agent context is lost", {
        sessionId: route.sessionId,
        ...details,
      });
      await this.deps.events.emit(route, "session.runtime_reset", "gateway", details);
    }
    return { runtimeSessionId, runtime, context };
  }

  /** The runtime a stored session runs on, with the context its calls take. */
  forRoute(
    route: SessionRoute,
    workspacePath: string,
  ): { runtime: AgentRuntime; context: RuntimeContext } {
    const settings = this.settingsForRoute(route);
    return {
      runtime: settings.runtime,
      context: this.context(route.sessionId, workspacePath, settings, route.owner),
    };
  }

  /** The runtime a stored session runs on. */
  runtimeFor(route: Pick<SessionRoute, "runtime">): AgentRuntime {
    return this.find(route.runtime) ?? this.default;
  }

  /** Releases the runtime's hold on a session; the next turn resumes it. */
  async release(route: SessionRoute, workspacePath: string): Promise<void> {
    this.bound.delete(route.sessionId);
    if (!route.runtimeSessionId) return;
    const { runtime, context } = this.forRoute(route, workspacePath);
    await runtime.releaseSession(context, route.runtimeSessionId);
  }

  /** Forgets that the runtime holds a session, e.g. after the runtime exited. */
  forget(sessionId: string): void {
    this.bound.delete(sessionId);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.default, ...this.created.values()].map((rt) => rt.stop()));
    this.bound.clear();
  }

  private settings(runtime: AgentRuntime, request: AgentRequest | undefined): AgentSettings {
    const inherited = runtime === this.default ? this.deps.project.runtime : undefined;
    return {
      runtime,
      model: request?.model?.trim() || inherited?.model,
      reasoningEffort: request?.reasoningEffort?.trim() || inherited?.reasoningEffort,
    };
  }

  /** The runtime asked for by `name`: the default one when none is asked for. */
  private find(name: string | undefined): AgentRuntime | undefined {
    const normalized = normalizeRuntimeName(name);
    const fallback = this.default;
    if (
      !normalized ||
      normalized === fallback.name.toLowerCase() ||
      normalized === fallback.type.toLowerCase()
    ) {
      return fallback;
    }
    const cached = this.created.get(normalized);
    if (cached || !this.deps.runtimeFactory) return cached;
    try {
      const created = this.deps.runtimeFactory(normalized);
      this.created.set(normalized, created);
      return created;
    } catch {
      return undefined;
    }
  }

  private context(
    sessionId: string,
    workspacePath: string,
    settings: AgentSettings,
    owner: SessionOwner | undefined,
  ): RuntimeContext {
    const { project } = this.deps;
    return {
      project: {
        ...project,
        runtime: {
          ...(project.runtime?.mcpServers ? { mcpServers: project.runtime.mcpServers } : {}),
          type: settings.runtime.name,
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.reasoningEffort
            ? { reasoningEffort: settings.reasoningEffort as ReasoningEffort }
            : {}),
        },
      },
      workspacePath,
      tools: this.deps.toolsFor(sessionId, workspacePath, owner),
      ...(this.deps.readOnly ? { readOnly: true } : {}),
      onEvent: (event) => this.deps.onEvent(sessionId, event),
    };
  }
}
