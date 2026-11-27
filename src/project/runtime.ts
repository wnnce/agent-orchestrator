import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  ConflictError,
  ErrorCode,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  ValidationError,
} from "../domain/errors.ts";
import {
  ScheduledJobStatus,
  type ArtifactRecord,
  type EventRecord,
  type ProjectConfig,
  type ReasoningEffort,
  type ScheduledJobRecord,
  type SessionRoute,
  type SessionRuntimeOverride,
  type TurnRecord,
} from "../domain/types.ts";
import { isTransientEvent } from "../domain/events.ts";
import type { Store } from "../persistence/store.ts";
import type {
  AgentRuntime,
  ApprovalDecision,
  RuntimeContext,
  RuntimeEvent,
} from "../runtime/runtime.ts";
import { RuntimeSessionNotFoundError } from "../runtime/runtime.ts";
import { isTurnUsage } from "../runtime/usage.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import { NotificationHub, NotificationOutbox } from "../notifications/index.ts";
import { Logger } from "../observability/logger.ts";
import {
  buildNowPromptScope,
  buildProjectPromptScope,
  renderPromptTemplate,
} from "../prompt/template.ts";
import { MemoryEventHub, type EventHub } from "../events/hub.ts";
import { SkillManager, type ProjectSkill } from "./skills.ts";
import { GLOBAL_PROJECT_ID } from "./global.ts";
import { SessionManager, type SessionEntity } from "../session/index.ts";
import {
  TaskEngine,
  TaskLoader,
  TaskScheduler,
  TaskExecutorRegistry,
  AgentTaskExecutor,
  TsTaskExecutor,
  type AgentSessionRunner,
  type TaskDefinition,
  type TaskRunResult,
} from "../task/index.ts";
import {
  builtinTools,
  loadProjectTools,
  ToolRegistry,
  type PipelineOwner,
  type SessionTools,
  type TaskOwner,
  type ToolContext,
  type ToolDefinition,
  type ToolSession,
} from "../tools/index.ts";
import {
  PipelineEngine,
  PipelineEventHub,
} from "../pipeline/index.ts";
import {
  captureTraceContext,
  detached,
  withSpan,
  withTraceContext,
  type Context,
} from "../observability/tracing.ts";
import { TurnTrace } from "./turn-trace.ts";
import {
  createProjectContext,
  type ContextOptions,
  type ScopedContext,
  type StartSessionParams,
  type StartedSession,
} from "../context/index.ts";
import type { Origin, SessionOrigin, SessionOwner } from "../domain/origin.ts";
import type { McpClientFactory } from "../mcp/index.ts";

interface QueuedTurn {
  readonly turn: TurnRecord;
  /** Trace of whoever queued the turn; the turn's span continues it. */
  readonly traceContext: Context;
}

interface ActiveTurn {
  turn: TurnRecord;
  trace: TurnTrace;
  runtimeId?: string;
  starting: boolean;
  canceled: boolean;
  settled: boolean;
  early: RuntimeEvent[];
  completed: Promise<void>;
  resolve: () => void;
}
export interface SessionExecutionOptions {
  queueLimit?: number;
  controlTimeoutMs?: number;
  scheduledJobPollIntervalMs?: number;
  /** Optional lazy factory for creating additional runtimes requested at session creation time. */
  runtimeFactory?: ((runtimeType: string) => AgentRuntime) | undefined;
  /** Optional shared PipelineEventHub across all ProjectRuntimes. */
  pipelineEventHub?: PipelineEventHub | undefined;
  /** Replaces how project contexts connect to MCP servers (tests). */
  mcpClientFactory?: McpClientFactory | undefined;
  /** Replaces the tools the project's agents are offered (tests). */
  tools?: readonly ToolDefinition[] | undefined;
}

function toSessionRuntimeOverride(
  config?: {
    readonly type?: string | undefined;
    readonly model?: string | undefined;
    readonly reasoningEffort?: string | undefined;
  },
): SessionRuntimeOverride | undefined {
  if (!config) return undefined;
  return {
    runtime: config.type,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  };
}

/** What a session started by `origin` records about where it came from. */
function sessionSourceMetadata(origin: Origin): Record<string, string> {
  switch (origin.kind) {
    case "session":
      return { sourceSessionId: origin.sessionId };
    case "task":
      return { sourceTaskId: origin.taskId, sourceTaskExecutionId: origin.executionId };
    case "pipeline":
      return { sourcePipelineRunId: origin.runId, sourcePipelineNodeId: origin.nodeId };
    case "hook":
      return {
        sourceHookId: origin.hookId,
        ...(origin.deliveryId ? { sourceHookDeliveryId: origin.deliveryId } : {}),
      };
  }
}

export class ProjectRuntime {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingTurns = new Map<string, QueuedTurn[]>();
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Promise<unknown>>();
  private readonly maintenance = new Set<string>();
  private readonly closes = new Map<string, Promise<void>>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly runtimeEvents = new Map<string, Promise<void>>();
  private readonly sessionSequences = new Map<string, number>();
  /** Sessions the agent runtime currently holds in this process. */
  private readonly boundSessions = new Set<string>();
  private readonly timers: Timer[] = [];
  private stopping = false;

  readonly taskEngine: TaskEngine;
  readonly taskScheduler: TaskScheduler;
  readonly taskLoader: TaskLoader;
  /** The tools this project's agents are offered. */
  readonly tools: ToolRegistry;
  readonly pipelineEventHub: PipelineEventHub;
  readonly pipelineEngine: PipelineEngine;

  constructor(
    readonly project: ProjectConfig,
    private readonly store: Store,
    private readonly runtime: AgentRuntime,
    private readonly workspaces: WorkspaceManager,
    private readonly artifactStore: ArtifactStore,
    private readonly notifications = new NotificationOutbox(
      store,
      new NotificationHub(),
    ),
    private readonly logger = new Logger(),
    private readonly eventHub: EventHub = new MemoryEventHub(store),
    readonly sessionManager: SessionManager = new SessionManager(store),
    private readonly options: SessionExecutionOptions = {},
    private readonly inheritedSkillsProject?: ProjectConfig,
    taskEngine?: TaskEngine,
    taskScheduler?: TaskScheduler,
    taskLoader?: TaskLoader,
  ) {
    this.taskEngine = taskEngine ?? new TaskEngine(store, logger);
    this.taskScheduler =
      taskScheduler ?? new TaskScheduler(this.taskEngine, logger);
    this.taskLoader = taskLoader ?? new TaskLoader(logger);
    // The global project only reads; its agents get no tools that act on projects.
    this.tools = new ToolRegistry(
      options.tools ?? (project.id === GLOBAL_PROJECT_ID ? [] : builtinTools),
      logger,
      (record) => store.recordToolExecution(record),
    );
    this.pipelineEventHub = options.pipelineEventHub ?? new PipelineEventHub();
    this.pipelineEngine = new PipelineEngine({
      project: this.project,
      store: this.store.pipelines,
      workspaces: this.workspaces,
      notifications: this.notifications,
      hub: this.pipelineEventHub,
      logger: this.logger,
      createContext: (origin, options) => this.createContext(origin, options),
      sessions: {
        create: ({ workspacePath, title, owner, runtimeOverride }) =>
          this.createSession({ title }, "pipeline", toSessionRuntimeOverride(runtimeOverride), {
            externalWorkspacePath: workspacePath,
            owner,
          }),
        runTurn: async (sessionId, input, turnId) => {
          await this.enqueueTurn(sessionId, input, turnId);
        },
        archive: (sessionId) => this.archivePipelineSession(sessionId),
        interrupt: (sessionId) => this.interrupt(sessionId),
      },
    });
    this.runtimes.set(this.runtimeName(this.runtime), this.runtime);

    const taskRegistry = new TaskExecutorRegistry(logger);
    const agentRunner: AgentSessionRunner = {
      createSession: async (task, executionId) => {
        const sessionRoute = await this.createSession(
          { title: `Task: ${task.name}` },
          "task",
          toSessionRuntimeOverride(task.runtime),
          {
            owner: {
              kind: "task",
              taskId: task.taskId,
              taskKey: task.taskKey,
              executionId,
            },
          },
        );
        return { sessionId: sessionRoute.sessionId };
      },
      renderPrompt: (template, data) => this.renderTaskPrompt(template, data),
      runTurn: async (sessionId, input) => {
        const queuedTurn = await this.turn(sessionId, input);
        await this.waitForIdle(sessionId);
        const finalTurn = await this.store.getTurn(queuedTurn.id);
        return {
          turnId: queuedTurn.id,
          status: finalTurn?.status ?? "completed",
          ...(finalTurn?.error !== undefined ? { error: finalTurn.error } : {}),
        };
      },
      cleanupSession: async (sessionId) => {
        await this.cleanupSession(sessionId, { deleteFromStore: false });
      },
      getTaskState: async (taskKey) => {
        return this.taskEngine.getState(taskKey);
      },
    };

    taskRegistry.register(new AgentTaskExecutor(agentRunner, logger));
    taskRegistry.register(
      new TsTaskExecutor(
        {
          resolveHandler: (task) => this.taskLoader.resolveTsHandler(task),
          createContext: (origin, options) => this.createContext(origin, options),
          appendLogs: (logs) => this.store.appendTaskExecutionLogs(logs),
        },
        logger,
      ),
    );

    this.taskEngine.setRegistry(taskRegistry);
  }

  /**
   * The project's capabilities acting as `origin`. Every task, pipeline node, agent tool and hook
   * context is built on one of these.
   */
  createContext(origin: Origin, options: ContextOptions): ScopedContext {
    return createProjectContext(
      {
        project: this.project,
        logger: this.logger,
        notifications: this.notifications,
        artifacts: this.artifactStore,
        sessions: { start: (params, from) => this.startSessionFor(params, from) },
        pipelines: {
          start: (params) => this.pipelineEngine.startRun(params),
          find: (pipelineId, externalKey) =>
            this.store.pipelines.findRunByExternalKey(this.project.id, pipelineId, externalKey),
          signal: (runId) => this.pipelineEngine.signalRun(runId),
          list: () => this.pipelineEngine.listPipelinesWithVersions(),
        },
        mcpClientFactory: this.options.mcpClientFactory,
      },
      origin,
      options,
    );
  }

  /**
   * A session started by project code or an agent tool. It is an ordinary session that remembers
   * where it came from; unless told otherwise it uses the project's runtime and model.
   */
  private async startSessionFor(
    params: StartSessionParams,
    origin: Origin,
  ): Promise<StartedSession> {
    const route = await this.createSession(
      {
        title: params.title,
        ...sessionSourceMetadata(origin),
        ...(params.metadata ? { dispatch: params.metadata } : {}),
      },
      "dispatch",
      {
        ...(params.runtime ? { runtime: params.runtime } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
      },
    );
    const turn = await this.turn(route.sessionId, params.prompt);
    return { sessionId: route.sessionId, turnId: turn.id };
  }

  /**
   * The tools a session's agent is offered. A call runs as the session's current turn: in its
   * trace, attributed to it, with its owner's task state or pipeline node.
   */
  private sessionTools(
    sessionId: string,
    workspacePath: string,
    owner: SessionOwner | undefined,
  ): SessionTools {
    const site = { owner };
    const pipelineNext =
      owner?.kind === "pipeline"
        ? this.pipelineEngine.pipelineNextInput(owner.pipelineId, owner.nodeId)
        : undefined;
    const inputs = pipelineNext ? { pipeline_next: pipelineNext } : undefined;
    return {
      specs: this.tools.specs(site, inputs),
      call: async (name, args, options) => {
        const active = this.activeTurns.get(sessionId);
        const origin: SessionOrigin = {
          kind: "session",
          sessionId,
          ...(active ? { turnId: active.turn.id } : {}),
        };
        const scoped = this.createContext(origin, {
          signal: options?.signal ?? new AbortController().signal,
        });
        try {
          const ctx: ToolContext = {
            ...scoped.context,
            origin,
            session: this.toolSession(origin, workspacePath, scoped.context.logger),
            ...(owner ? { owner: await this.toolOwner(owner, origin.turnId) } : {}),
          };
          return await this.tools.call(name, args, ctx, {
            input: inputs?.[name as keyof typeof inputs],
            traceContext: active?.trace.context,
          });
        } finally {
          await scoped.dispose();
        }
      },
    };
  }

  private toolSession(origin: SessionOrigin, workspace: string, logger: Logger): ToolSession {
    const { sessionId, turnId } = origin;
    return {
      id: sessionId,
      ...(turnId ? { turnId } : {}),
      workspace,
      schedule: async (job) => {
        const triggerAt = new Date(Date.now() + job.delayMinutes * 60_000).toISOString();
        const record: ScheduledJobRecord = {
          jobId: `job_${randomUUID()}`,
          projectId: this.project.id,
          sessionId,
          name: job.name,
          createdAt: new Date().toISOString(),
          delayMinutes: job.delayMinutes,
          triggerAt,
          status: ScheduledJobStatus.PENDING,
          prompt: job.prompt,
          metadata: { ...(job.metadata ?? {}), ...(turnId ? { createdTurnId: turnId } : {}) },
        };
        await this.store.createScheduledJob(record);
        logger.info("scheduled job created for session", {
          jobId: record.jobId,
          name: job.name,
          delayMinutes: job.delayMinutes,
          triggerAt,
        });
        return record;
      },
      cancelSchedule: async (nameOrId) => {
        const cancelled = await this.store.cancelScheduledJob(sessionId, nameOrId);
        logger.info("scheduled job cancellation requested", { name: nameOrId, cancelled });
        return cancelled;
      },
    };
  }

  /** The task or pipeline node a session works for, with what its tools may do to it. */
  private async toolOwner(
    owner: SessionOwner,
    turnId: string | undefined,
  ): Promise<TaskOwner | PipelineOwner> {
    if (owner.kind === "task") {
      const engine = this.taskEngine;
      let state = await engine.getState(owner.taskKey);
      return {
        ...owner,
        state: {
          get: () => state,
          set: (next) => {
            state = { ...next };
            engine.updateState(owner.taskKey, state);
          },
          merge: (patch) => {
            state = { ...state, ...patch };
            engine.updateState(owner.taskKey, state);
          },
        },
      };
    }
    const engine = this.pipelineEngine;
    return {
      ...owner,
      decide: (action, context) =>
        engine.registerAgentDecision({
          nodeRunId: owner.nodeRunId,
          ...(turnId ? { turnId } : {}),
          action,
          context,
        }),
      context: () => engine.getContextForNodeRun(owner.nodeRunId),
      history: {
        list: (filter) => engine.listHistory(owner.runId, filter),
        get: (query) => engine.getHistoryDetail(owner.runId, query),
      },
    };
  }

  get hub(): EventHub {
    return this.eventHub;
  }

  getTaskExecutorRegistry(): TaskExecutorRegistry | undefined {
    return this.taskEngine.getRegistry();
  }

  async start(): Promise<void> {
    this.logger.info("project runtime started", {
      projectId: this.project.id,
      runtime: this.runtime.type,
    });
    await this.reconcileSessions();
    this.timers.push(
      setInterval(() => void this.manageSessionLifecycles(), 60_000),
    );
    this.timers.push(
      setInterval(
        () => void this.pollScheduledJobs(),
        this.options.scheduledJobPollIntervalMs ?? 30_000,
      ),
    );

    if (this.project.projectDir && this.project.id !== GLOBAL_PROJECT_ID && !this.options.tools) {
      const customTools = await loadProjectTools(
        this.project.projectDir,
        this.project.id,
        this.logger,
      );
      if (customTools.length > 0) {
        this.tools.register(customTools, { override: true });
        this.logger.info("project custom tools loaded", {
          projectId: this.project.id,
          tools: customTools.map((tool) => tool.name),
        });
      }
    }

    if (this.project.projectDir) {
      await this.loadAndScheduleTasks().catch((err) => {
        this.logger.warn("failed to load and schedule project tasks on start", {
          projectId: this.project.id,
          error: (err as Error).message,
        });
      });
    }
    if (this.project.id !== GLOBAL_PROJECT_ID) {
      await this.pipelineEngine.start().catch((err) => {
        this.logger.warn("failed to start pipeline engine", {
          projectId: this.project.id,
          error: (err as Error).message,
        });
      });
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.taskScheduler.stop();
    await this.pipelineEngine.stop().catch(() => {});
    await this.taskEngine.drain().catch(() => {});
    await this.notifications.drain().catch(() => {});
    await Promise.allSettled([...this.admissions.values()]);
    for (const id of [...this.pendingTurns.keys()]) await this.cancelQueued(id);
    await Promise.allSettled([...this.runtimes.values()].map((rt) => rt.stop()));
    this.boundSessions.clear();
    for (const [id, active] of [...this.activeTurns]) {
      await this.finishTurn(id, active, "failed", "runtime stopped");
    }
    await Promise.allSettled([...this.pumps.values()]);
    this.logger.info("project runtime stopped", { projectId: this.project.id });
  }

  /**
   * Cleans up what a previous process left behind: closes it started but never completed, and
   * scheduled-task sessions it was running when it stopped.
   */
  private async reconcileSessions(): Promise<void> {
    const sessions = await this.store.listSessions(this.project.id, {
      includeTasks: true,
      includePipelines: true,
    });
    for (const session of sessions) {
      const abandonedTask =
        session.source === "task" && session.status !== "closed" && session.status !== "archived";
      if (session.status !== "closing" && !abandonedTask) continue;
      this.logger.info("cleaning up session left over from a previous run", {
        projectId: this.project.id,
        sessionId: session.sessionId,
      });
      await this.cleanupSession(session.sessionId, { deleteFromStore: false });
    }
  }

  async listSkills(): Promise<ProjectSkill[]> {
    return SkillManager.listProjectSkills(this.project);
  }

  /**
   * Creates a session. `source` records who created it (e.g. `"api"`, `"task"`, `"pipeline"`).
   */
  async createSession(
    metadata?: Record<string, unknown>,
    source = "api",
    runtimeOverride?: SessionRuntimeOverride,
    options?: {
      externalWorkspacePath?: string | undefined;
      /** The task execution or pipeline node the session works for. */
      owner?: SessionOwner | undefined;
    },
  ): Promise<SessionRoute> {
    if (!this.project.repository && this.project.id !== GLOBAL_PROJECT_ID)
      throw new Error(`project ${this.project.id} has no repository`);

    const requestedRuntime = runtimeOverride?.runtime?.trim().toLowerCase() || undefined;
    const targetRuntime = this.resolveRuntime(requestedRuntime);
    const runtimeName = this.runtimeName(targetRuntime);
    const isDefaultRuntime = runtimeName === this.runtimeName(this.runtime);
    const explicitModel = runtimeOverride?.model?.trim() || undefined;
    const explicitEffort = runtimeOverride?.reasoningEffort?.trim() || undefined;
    const model = explicitModel ?? (isDefaultRuntime ? this.project.runtime?.model : undefined);
    const reasoningEffort =
      explicitEffort ?? (isDefaultRuntime ? this.project.runtime?.reasoningEffort : undefined);

    const sessionId = `ses_${randomUUID()}`;
    const workspacePath =
      options?.externalWorkspacePath ??
      (await this.workspaces.ensureSessionWorkspace(this.project, sessionId));

    const owner = options?.owner;
    const context = this.context(
      workspacePath,
      sessionId,
      { runtime: runtimeName, model, reasoningEffort },
      owner,
    );
    const runtimeSession = await targetRuntime.startSession(context);
    this.boundSessions.add(sessionId);
    const route: SessionRoute = {
      sessionId,
      ...(typeof metadata?.title === "string" && metadata.title
        ? { title: metadata.title }
        : {}),
      projectId: this.project.id,
      projectRuntimeId: `project-runtime:${this.project.id}`,
      runtimeSessionId: runtimeSession.id,
      runtime: runtimeName,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      workspacePath,
      configRevision: this.project.revision ?? 1,
      status: "active",
      source,
      ...(owner ? { owner } : {}),
      lastActiveAt: new Date().toISOString(),
      metadata: {
        ...(metadata ?? {}),
        runtime: runtimeName,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    };
    await this.store.createSession(route);
    this.sessionManager.loadOrCreate(route);
    await this.emit(route, "session.started", "gateway", {
      runtimeSessionId: runtimeSession.id,
      workspacePath,
      runtime: runtimeName,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    this.logger.info("session created", {
      projectId: this.project.id,
      sessionId,
      runtimeSessionId: runtimeSession.id,
      runtime: runtimeName,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    return route;
  }

  /** Renames a session at the user's request. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const cleanTitle = title.trim().slice(0, 255);
    if (!(await this.store.updateSessionTitle(sessionId, cleanTitle))) {
      throw new NotFoundError(`Session ${sessionId} not found`, ErrorCode.SESSION_NOT_FOUND);
    }
    await this.applyTitle(sessionId, cleanTitle);
  }
  /** Sets an automatically generated title unless the session got one in the meantime. */
  async setGeneratedTitle(sessionId: string, title: string): Promise<void> {
    if (await this.store.setTitleIfEmpty(sessionId, title)) {
      await this.applyTitle(sessionId, title);
    }
  }
  private async applyTitle(sessionId: string, title: string): Promise<void> {
    this.sessionManager.get(sessionId)?.setTitle(title);
    const route = await this.store.getSession(sessionId);
    if (route) await this.emit(route, "session.renamed", "gateway", { title });
    this.logger.info("session renamed", { sessionId, title });
  }

  async cleanupSession(
    sessionId: string,
    options?: { deleteFromStore?: boolean },
  ): Promise<void> {
    const previous = this.closes.get(sessionId);
    if (previous) return previous;
    const task = this.closeSession(sessionId, options);
    this.closes.set(sessionId, task);
    try {
      await task;
    } finally {
      this.closes.delete(sessionId);
    }
  }
  private async closeSession(
    sessionId: string,
    options?: { deleteFromStore?: boolean },
  ): Promise<void> {
    let entity: SessionEntity | undefined;
    try {
      entity = await this.entity(sessionId);
      await entity.transitionTo("closing");
      await entity.flush(this.store);
    } catch (e) {
      this.logger.warn("failed to transition session to closing", {
        sessionId,
        error: e,
      });
    }
    await this.admissions.get(sessionId)?.catch(() => {});
    await this.cancelQueued(sessionId);
    await this.stopActiveTurn(sessionId);
    try {
      await this.bounded(
        this.pumps.get(sessionId) ?? Promise.resolve(),
        "session close timed out",
      );
    } catch (e) {
      this.logger.warn("session pump wait timed out during close", {
        sessionId,
        error: e,
      });
    }
    const route = entity?.toRoute() ?? (await this.store.getSession(sessionId));
    if (route) {
      try {
        await this.releaseRuntimeSession(route);
      } catch (e) {
        this.logger.warn("runtime releaseSession failed during close", {
          sessionId,
          error: e,
        });
      }
    }
    try {
      await this.workspaces.removeSession(this.project, sessionId);
    } catch (e) {
      this.logger.warn("workspaces removeSession failed during close", {
        sessionId,
        error: e,
      });
    }
    if (route) {
      await this.emit(route, "session.closed", "gateway", {});
    }

    if (options?.deleteFromStore === false) {
      try {
        if (entity) {
          await entity.transitionTo("closed");
          await entity.flush(this.store);
        } else if (route) {
          await this.store.updateSession({ ...route, status: "closed" });
        }
      } catch (err) {
        this.logger.warn("failed to transition session to closed", {
          sessionId,
          error: err,
        });
      }
    } else {
      await this.store.deleteSession(sessionId);
    }

    await this.sessionManager.remove(sessionId);
    this.eventQueues.delete(sessionId);
    this.runtimeEvents.delete(sessionId);
    this.sessionSequences.delete(sessionId);
    this.logger.info("session cleaned up", {
      projectId: this.project.id,
      sessionId,
      retained: options?.deleteFromStore === false,
    });
  }
  /**
   * Interrupts the running turn during close. A runtime that does not confirm in time must not
   * block the close, so the turn is then settled as interrupted on our side.
   */
  private async stopActiveTurn(sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId);
    if (!active) return;
    try {
      await this.interrupt(sessionId);
    } catch (error) {
      this.logger.warn("turn did not stop during close; settling it as interrupted", {
        sessionId,
        turnId: active.turn.id,
        error,
      });
      await this.finishTurn(sessionId, active, "interrupted", "interrupt timed out during close");
    }
  }
  private async entity(id: string): Promise<SessionEntity> {
    const entity = await this.sessionManager.getOrLoad(id);
    if (!entity || entity.projectId !== this.project.id) {
      throw new NotFoundError(
        `session ${id} is not owned by project ${this.project.id}`,
        ErrorCode.SESSION_NOT_FOUND,
      );
    }
    return entity;
  }
  async loadSession(id: string): Promise<SessionRoute> {
    return (await this.entity(id)).toRoute();
  }
  async getSession(id: string): Promise<SessionRoute> {
    return this.loadSession(id);
  }
  async bindExternal(
    id: string,
    external: { channel: string; conversationId: string; threadId?: string },
  ): Promise<SessionRoute> {
    const entity = await this.entity(id);
    entity.bindExternal(external);
    await entity.flush(this.store);
    return entity.toRoute();
  }
  private async admit<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.admissions.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.admissions.set(id, next);
    try {
      return await next;
    } finally {
      if (this.admissions.get(id) === next) this.admissions.delete(id);
    }
  }
  /**
   * Archives a pipeline session as read-only WITHOUT deleting its shared pipeline worktree.
   */
  async archivePipelineSession(sessionId: string): Promise<void> {
    const existing = await this.store.getSession(sessionId);
    if (!existing) return;
    if (existing.status === "archived" || existing.status === "closed") {
      this.boundSessions.delete(sessionId);
      return;
    }
    await this.admissions.get(sessionId)?.catch(() => {});
    await this.cancelQueued(sessionId);
    await this.stopActiveTurn(sessionId);
    try {
      await this.bounded(
        this.pumps.get(sessionId) ?? Promise.resolve(),
        "pipeline session archive timed out",
      );
    } catch (e) {
      this.logger.warn("pipeline session pump wait timed out during archive", {
        sessionId,
        error: e,
      });
    }
    const entity = await this.entity(sessionId);
    const route = entity.toRoute();
    try {
      await this.releaseRuntimeSession(route);
    } catch (e) {
      this.logger.warn("runtime releaseSession failed during pipeline archive", {
        sessionId,
        error: e,
      });
    }
    if (entity.status !== "archived") {
      await entity.transitionTo("archived");
      await entity.flush(this.store);
    }
    await this.emit(entity.toRoute(), "session.archived", "gateway", {
      reason: "pipeline_node_completed",
    });
  }

  async turn(sessionId: string, input: string): Promise<TurnRecord> {
    return this.enqueueTurn(sessionId, input);
  }

  /** `turnId` lets a caller record the turn before it can start, as the pipeline engine does. */
  private async enqueueTurn(
    sessionId: string,
    input: string,
    turnId: string = `turn_${randomUUID()}`,
  ): Promise<TurnRecord> {
    return this.admit(sessionId, async () => {
      const entity = await this.entity(sessionId);
      if (this.stopping) throw new ServiceUnavailableError("runtime is stopping");
      if (entity.status === "archived") {
        throw new ConflictError(
          `session ${sessionId} is archived and read-only`,
          ErrorCode.SESSION_ARCHIVED,
        );
      }
      if (entity.status === "closing") {
        throw new ConflictError(`session ${sessionId} is closing`, ErrorCode.SESSION_CLOSING);
      }
      if (this.maintenance.has(sessionId)) {
        throw new ServiceUnavailableError("session maintenance in progress; retry the message");
      }
      if (!input.trim()) throw new ValidationError("input is required");
      const queue = this.pendingTurns.get(sessionId) ?? [];
      if (queue.length >= (this.options.queueLimit ?? 64)) {
        throw new TooManyRequestsError("session queue is full", ErrorCode.QUEUE_FULL);
      }
      entity.touch();
      if (entity.status !== "suspended") await entity.transitionTo("active");
      await entity.flush(this.store);
      const turn: TurnRecord = {
        id: turnId,
        sessionId,
        input,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      await this.store.createTurn(turn);
      await this.emit(entity.toRoute(), "turn.queued", "gateway", {
        turnId: turn.id,
        input,
      });
      queue.push({ turn, traceContext: captureTraceContext() });
      this.pendingTurns.set(sessionId, queue);
      this.startPump(sessionId);
      return turn;
    });
  }
  private startPump(id: string): void {
    if (this.pumps.has(id)) return;
    // Each turn continues the trace it was queued from, not the one that started the pump.
    const task = detached(() => this.pump(id)).catch((error) =>
      this.logger.error("session pump failed", { sessionId: id, error }),
    );
    this.pumps.set(id, task);
    void task.finally(() => {
      this.pumps.delete(id);
      if (this.pendingTurns.get(id)?.length && !this.stopping)
        this.startPump(id);
    });
  }
  private async pump(id: string): Promise<void> {
    while (!this.stopping) {
      const queued = this.pendingTurns.get(id)?.shift();
      if (!queued) {
        this.pendingTurns.delete(id);
        return;
      }
      const { turn } = queued;
      const entity = await this.entity(id);
      if (entity.status === "closing" || entity.status === "archived") {
        await this.finishQueued(entity.toRoute(), turn);
        continue;
      }
      const route = entity.toRoute();
      let resolve!: () => void;
      const completed = new Promise<void>((r) => {
        resolve = r;
      });
      const active: ActiveTurn = {
        turn,
        trace: new TurnTrace(queued.traceContext, {
          projectId: this.project.id,
          sessionId: id,
          turnId: turn.id,
          source: route.source,
        }),
        starting: true,
        canceled: false,
        settled: false,
        early: [],
        completed,
        resolve,
      };
      this.activeTurns.set(id, active);
      await withTraceContext(active.trace.context, async () => {
        try {
          await this.runTurn(route, turn);
        } catch (error) {
          await this.finishTurn(id, active, "failed", String(error));
        }
      });
      await completed;
    }
  }
  private async finishQueued(
    route: SessionRoute,
    turn: TurnRecord,
  ): Promise<void> {
    await this.store.updateTurn(turn.id, {
      status: "interrupted",
      finishedAt: new Date().toISOString(),
    });
    await this.emit(route, "turn.interrupted", "gateway", {
      turnId: turn.id,
      reason: "canceled_before_start",
    });
  }
  private async cancelQueued(id: string, turnId?: string): Promise<void> {
    const queue = this.pendingTurns.get(id) ?? [];
    const canceled = queue.filter(({ turn }) => !turnId || turn.id === turnId);
    this.pendingTurns.set(
      id,
      queue.filter(({ turn }) => turnId && turn.id !== turnId),
    );
    const route = await this.store.getSession(id);
    if (!route) return;
    for (const { turn } of canceled) await this.finishQueued(route, turn);
  }
  async waitForIdle(id: string): Promise<void> {
    await this.admissions.get(id)?.catch(() => {});
    await this.pumps.get(id);
  }
  private async bounded(
    task: Promise<unknown>,
    message: string,
  ): Promise<void> {
    let timer: Timer | undefined;
    try {
      await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(message)),
            this.options.controlTimeoutMs ?? 10_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async steer(sessionId: string, input: string): Promise<void> {
    const route = await this.loadSession(sessionId);
    const active = this.activeTurns.get(sessionId);
    if (!active?.runtimeId || active.settled) throw new ConflictError("no active turn");
    const runtime = this.runtimeForRoute(route);
    await runtime.steerTurn(
      this.context(this.workspacePath(route), sessionId, route, route.owner),
      route.runtimeSessionId ?? "",
      active.runtimeId,
      input,
    );
  }
  async interrupt(sessionId: string, turnId?: string): Promise<void> {
    await this.admissions.get(sessionId)?.catch(() => {});
    const route = await this.loadSession(sessionId);
    if (turnId && this.pendingTurns.get(sessionId)?.some(({ turn }) => turn.id === turnId)) {
      await this.cancelQueued(sessionId, turnId);
      return;
    }
    const active = this.activeTurns.get(sessionId);
    if (!active || active.settled || (turnId && active.turn.id !== turnId))
      return;
    if (!active.canceled) {
      active.canceled = true;
      if (active.runtimeId) {
        const runtime = this.runtimeForRoute(route);
        await runtime.interruptTurn(
          this.context(this.workspacePath(route), sessionId, route, route.owner),
          route.runtimeSessionId ?? "",
          active.runtimeId,
        );
      }
    }
    await this.bounded(
      active.completed,
      "turn interrupt timed out",
    );
  }
  async compact(sessionId: string): Promise<void> {
    const route = await this.loadSession(sessionId);
    const active = this.activeTurns.get(sessionId);
    if (active && !active.settled) {
      throw new ConflictError("cannot compact while a turn is running");
    }
    const runtime = this.runtimeForRoute(route);
    await runtime.compactSession(
      this.context(this.workspacePath(route), sessionId, route, route.owner),
      route.runtimeSessionId ?? "",
    );
  }
  async approve(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const route = await this.loadSession(sessionId);
    const runtime = this.runtimeForRoute(route);
    await runtime.respondToApproval(
      this.context(this.workspacePath(route), sessionId, route, route.owner),
      requestId,
      decision,
    );
    await this.emit(route, "approval.resolved", "gateway", {
      requestId,
      decision,
    });
  }
  async events(sessionId: string, after = 0): Promise<EventRecord[]> {
    await this.loadSession(sessionId);
    return this.store.listEvents(sessionId, after);
  }
  /**
   * Artifacts a session produced. Internal ones (`agent-message`, the agent's own message log)
   * are left out unless `includeInternal` is set.
   */
  async listArtifacts(
    sessionId: string,
    options: { includeInternal?: boolean } = {},
  ): Promise<ArtifactRecord[]> {
    await this.loadSession(sessionId);
    const artifacts = await this.store.listArtifacts({ kind: "session", id: sessionId });
    return options.includeInternal
      ? artifacts
      : artifacts.filter((artifact) => artifact.kind !== "agent-message");
  }

  async artifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactRecord> {
    const artifacts = await this.listArtifacts(sessionId, { includeInternal: true });
    const artifact = artifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      throw new NotFoundError(`artifact not found: ${artifactId}`, ErrorCode.ARTIFACT_NOT_FOUND);
    }
    return artifact;
  }

  async readArtifact(artifact: ArtifactRecord): Promise<Uint8Array> {
    return this.artifactStore.read(artifact);
  }

  private async runTurn(route: SessionRoute, turn: TurnRecord): Promise<void> {
    const id = route.sessionId;
    const active = this.activeTurns.get(id)!;
    const entity = await this.entity(id);
    const workspacePath = await withSpan("workspace.prepare", {}, () =>
      this.ensureWorkspace(route),
    );
    const { runtimeSessionId, runtime: sessionRuntime } = await withSpan(
      "runtime.bind_session",
      {},
      () => this.bindRuntimeSession(entity, workspacePath),
    );
    const boundRoute = entity.toRoute();
    const context = this.context(workspacePath, id, boundRoute, boundRoute.owner);
    active.trace.bindRuntime(sessionRuntime.type, context.project.runtime?.model);
    if (entity.status !== "closing") await entity.transitionTo("active");
    entity.touch();
    await entity.flush(this.store);
    if (active.canceled || entity.status === "closing") {
      await this.finishTurn(id, active, "interrupted");
      return;
    }
    await this.store.updateTurn(turn.id, {
      status: "in_progress",
      startedAt: new Date().toISOString(),
    });
    await entity.notifyTurnStarted(turn.id, turn.input);
    await this.emit(boundRoute, "turn.started", sessionRuntime.type, {
      turnId: turn.id,
    });
    const runtimeTurn = await sessionRuntime.startTurn(
      context,
      runtimeSessionId,
      turn.id,
      turn.input,
    );
    active.runtimeId = runtimeTurn.id;
    await this.store.updateTurn(turn.id, { runtimeTurnId: runtimeTurn.id });
    while (active.early.length)
      await this.processRuntimeEvent(id, active.early.shift()!);
    active.starting = false;
    if (active.canceled && !active.settled)
      await sessionRuntime.interruptTurn(
        context,
        runtimeSessionId,
        runtimeTurn.id,
      );
    await active.completed;
  }
  /**
   * Makes sure the agent runtime holds this session, resuming it at most once per process.
   * When the session's recorded runtime is still available in this process, that runtime resumes
   * it directly. When the runtime no longer has the session or is no longer available, a new
   * session is started on the project's default runtime and `session.runtime_reset` is emitted.
   */
  private async bindRuntimeSession(
    entity: SessionEntity,
    workspacePath: string,
  ): Promise<{ runtimeSessionId: string; runtime: AgentRuntime }> {
    const route = entity.toRoute();
    const previousId = route.runtimeSessionId;
    const requestedRuntime =
      route.runtime && route.runtime !== "unknown" ? route.runtime : undefined;
    const resolved = this.tryResolveRuntime(requestedRuntime);
    if (previousId && this.boundSessions.has(route.sessionId) && resolved) {
      return { runtimeSessionId: previousId, runtime: resolved };
    }

    const targetRuntime = resolved ?? this.runtime;
    const runtimeName = this.runtimeName(targetRuntime);
    let resetReason: "not_found" | "runtime_changed" | undefined;
    let runtimeSessionId: string | undefined;
    const context = this.context(
      workspacePath,
      route.sessionId,
      {
        runtime: runtimeName,
        model: resolved ? route.model : undefined,
        reasoningEffort: resolved ? route.reasoningEffort : undefined,
      },
      route.owner,
    );

    if (previousId && requestedRuntime && !resolved) {
      resetReason = "runtime_changed";
    } else if (previousId) {
      try {
        runtimeSessionId = (await targetRuntime.resumeSession(context, previousId)).id;
      } catch (error) {
        if (!(error instanceof RuntimeSessionNotFoundError)) throw error;
        resetReason = "not_found";
      }
    }
    runtimeSessionId ??= (await targetRuntime.startSession(context)).id;
    entity.bindRuntime(runtimeSessionId, runtimeName);
    this.boundSessions.add(route.sessionId);

    if (previousId && resetReason) {
      this.logger.warn("runtime session reset; earlier agent context is lost", {
        sessionId: route.sessionId,
        reason: resetReason,
        runtime: runtimeName,
        previousRuntimeSessionId: previousId,
        runtimeSessionId,
      });
      await this.emit(route, "session.runtime_reset", "gateway", {
        reason: resetReason,
        runtime: runtimeName,
        previousRuntimeSessionId: previousId,
        runtimeSessionId,
      });
    }
    return { runtimeSessionId, runtime: targetRuntime };
  }
  private runtimeName(runtime: AgentRuntime = this.runtime): string {
    return runtime.name ?? runtime.type;
  }
  private resolveRuntime(runtimeType?: string): AgentRuntime {
    const resolved = this.tryResolveRuntime(runtimeType);
    if (resolved) return resolved;
    throw new ValidationError(
      `runtime not available for project ${this.project.id}: ${runtimeType}`,
    );
  }
  private tryResolveRuntime(runtimeType?: string): AgentRuntime | undefined {
    const normalized = runtimeType?.trim().toLowerCase();
    if (!normalized || normalized === "unknown") return this.runtime;
    const defaultName = this.runtimeName(this.runtime).toLowerCase();
    if (normalized === defaultName || normalized === this.runtime.type.toLowerCase()) {
      return this.runtime;
    }
    const cached = this.runtimes.get(normalized);
    if (cached) return cached;
    if (!this.options.runtimeFactory) return undefined;
    try {
      const created = this.options.runtimeFactory(normalized);
      this.runtimes.set(normalized, created);
      return created;
    } catch {
      return undefined;
    }
  }
  private runtimeForRoute(route: Pick<SessionRoute, "runtime">): AgentRuntime {
    return this.tryResolveRuntime(route.runtime) ?? this.runtime;
  }
  private effectiveProjectFor(override?: SessionRuntimeOverride): ProjectConfig {
    const defaultType = this.runtimeName(this.runtime);
    const targetType =
      override?.runtime && override.runtime !== "unknown" ? override.runtime : defaultType;
    const isDefaultRuntime = targetType.toLowerCase() === defaultType.toLowerCase();
    const model = override?.model ?? (isDefaultRuntime ? this.project.runtime?.model : undefined);
    const reasoningEffort =
      override?.reasoningEffort ??
      (isDefaultRuntime ? this.project.runtime?.reasoningEffort : undefined);

    return {
      ...this.project,
      runtime: {
        ...(this.project.runtime?.mcpServers
          ? { mcpServers: this.project.runtime.mcpServers }
          : {}),
        type: targetType,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffort } : {}),
      },
    };
  }
  /** Releases the runtime's hold on a session; the next turn resumes it. */
  private async releaseRuntimeSession(route: SessionRoute): Promise<void> {
    this.boundSessions.delete(route.sessionId);
    if (!route.runtimeSessionId) return;
    const runtime = this.runtimeForRoute(route);
    await runtime.releaseSession(
      this.context(this.workspacePath(route), route.sessionId, route, route.owner),
      route.runtimeSessionId,
    );
  }
  /**
   * The session's working directory. It is stored when the session is created; sessions created
   * before that was stored get it computed. Never touches git.
   */
  private workspacePath(route: SessionRoute): string {
    return route.workspacePath ?? this.workspaces.sessionPath(this.project, route.sessionId);
  }
  /** Recreates the session's worktrees when they are missing, e.g. after the data dir was cleaned. */
  private async ensureWorkspace(route: SessionRoute): Promise<string> {
    if (route.source === "pipeline") {
      const wsPath = route.workspacePath;
      if (!wsPath) {
        throw new Error(`pipeline session ${route.sessionId} has no workspacePath`);
      }
      try {
        await access(wsPath, constants.F_OK);
      } catch {
        throw new Error(`pipeline workspace is missing or already cleaned: ${wsPath}`);
      }
      return wsPath;
    }
    if (!this.workspaces.isSessionReady(this.project, route.sessionId)) {
      this.logger.warn("session workspace is missing; recreating it", {
        projectId: this.project.id,
        sessionId: route.sessionId,
      });
      await this.workspaces.ensureSessionWorkspace(this.project, route.sessionId);
    }
    return this.workspacePath(route);
  }
  private context(
    workspacePath: string,
    sessionId: string,
    runtimeOverride?: SessionRuntimeOverride,
    owner?: SessionOwner,
  ): RuntimeContext {
    return {
      project: this.effectiveProjectFor(runtimeOverride),
      workspacePath,
      tools: this.sessionTools(sessionId, workspacePath, owner),
      ...(this.project.id === GLOBAL_PROJECT_ID ? { readOnly: true } : {}),
      onEvent: (event) => this.onRuntimeEvent(sessionId, event),
    };
  }
  private async onRuntimeEvent(id: string, event: RuntimeEvent): Promise<void> {
    const active = this.activeTurns.get(id);
    if (active?.starting) {
      active.early.push(event);
      return;
    }
    const previous = this.runtimeEvents.get(id) ?? Promise.resolve();
    // Runtimes call back from their own context; handle the event inside the turn's trace.
    const traceContext = active?.trace.context;
    const task = previous
      .catch(() => {})
      .then(() =>
        traceContext
          ? withTraceContext(traceContext, () => this.processRuntimeEvent(id, event))
          : this.processRuntimeEvent(id, event),
      );
    this.runtimeEvents.set(id, task);
    try {
      await task;
    } catch (error) {
      this.logger.error("runtime event processing failed", {
        sessionId: id,
        error,
      });
      if (active && !active.settled)
        await this.finishTurn(id, active, "failed", String(error));
    }
  }
  private async processRuntimeEvent(
    id: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const entity = this.sessionManager.get(id);
    if (!entity) return;
    const active = this.activeTurns.get(id);
    const type = event.type as EventRecord["type"];
    // Session lifecycle events are ours to emit; see the contract on AgentRuntime.
    if (event.type.startsWith("session.")) return;
    if (event.type === "runtime.disconnected") {
      this.boundSessions.delete(id);
      if (active)
        await this.finishTurn(id, active, "failed", "agent runtime exited");
      return;
    }
    if (
      event.turnId &&
      (!active ||
        (event.turnId !== active.runtimeId && event.turnId !== active.turn.id))
    )
      return;
    if (type === "turn.started") return;
    active?.trace.record(event);
    if (
      active &&
      (type === "turn.completed" ||
        type === "turn.failed" ||
        type === "turn.interrupted")
    ) {
      await this.finishTurn(
        id,
        active,
        type === "turn.completed"
          ? "completed"
          : type === "turn.failed"
            ? "failed"
            : "interrupted",
        // The runtime's reason for a failed turn is the turn's error.
        event.type === "turn.failed" ? event.payload.error : undefined,
        event,
      );
      return;
    }
    if (
      active &&
      event.type === "agent.message.completed" &&
      event.payload.text
    ) {
      const text = event.payload.text;
      await this.store.updateTurn(active.turn.id, { output: text });
      await this.artifactStore.write(
        entity.projectId,
        { kind: "session", id },
        active.turn.id,
        "agent-message",
        text,
        "text/plain; charset=utf-8",
      );
    }
    const route = entity.toRoute();
    const sessionRuntime = this.runtimeForRoute(route);
    await this.emit(route, type, sessionRuntime.type, {
      ...event.payload,
      ...(active ? { turnId: active.turn.id } : {}),
      runtimeSessionId: event.sessionId,
      runtimeTurnId: event.turnId,
    });
  }
  private async finishTurn(
    id: string,
    active: ActiveTurn,
    status: "completed" | "failed" | "interrupted",
    error?: string,
    event?: RuntimeEvent,
  ): Promise<void> {
    if (active.settled) return;
    active.settled = true;
    let pipelineNotification:
      | {
          readonly sessionId: string;
          readonly turnId: string;
          readonly status: "completed" | "failed" | "interrupted";
          readonly output?: string | undefined;
          readonly error?: string | undefined;
        }
      | undefined;
    try {
      const entity = await this.entity(id);
      const rawUsage =
        event?.payload && typeof event.payload === "object" && "usage" in event.payload
          ? (event.payload as { usage?: unknown }).usage
          : undefined;
      const usage = isTurnUsage(rawUsage) ? rawUsage : undefined;
      active.trace.finish(status, usage, error);
      await this.store.updateTurn(active.turn.id, {
        status,
        finishedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
        ...(usage ? { usage } : {}),
      });
      entity.touch();
      await entity.flush(this.store);
      const route = entity.toRoute();
      const sessionRuntime = this.runtimeForRoute(route);
      await this.emit(route, `turn.${status}`, sessionRuntime.type, {
        ...((event?.payload ?? {}) as Record<string, unknown>),
        turnId: active.turn.id,
        runtimeTurnId: active.runtimeId,
        ...(error ? { error } : {}),
      });
      await entity.notifyTurnCompleted(active.turn.id, status);
      await this.emit(entity.toRoute(), "notification.queued", "notification", {
        kind: status,
        turnId: active.turn.id,
      });
      if (this.project.notifyOnTurnCompleted) {
        await this.notifications.queue(
          entity.projectId,
          { kind: "session", id },
          this.project.notifications,
          {
            title: `Turn ${status}`,
            text: `Session ${id} finished with status ${status}.`,
            metadata: {
              projectId: this.project.id,
              sessionId: id,
              turnId: active.turn.id,
            },
          },
        );
      }
      if (route.source === "pipeline" && !this.stopping) {
        const storedTurn = await this.store.getTurn(active.turn.id);
        pipelineNotification = {
          sessionId: id,
          turnId: active.turn.id,
          status,
          ...(storedTurn?.output !== undefined ? { output: storedTurn.output } : {}),
          ...(error !== undefined ? { error } : {}),
        };
      }
    } finally {
      if (this.activeTurns.get(id) === active) this.activeTurns.delete(id);
      active.resolve();
    }

    if (pipelineNotification) {
      // Reported after the turn has settled, without waiting: the engine's reaction may archive
      // this session or queue another turn on it, and both wait for the session to become idle.
      void this.pipelineEngine.onSessionTurnFinished(pipelineNotification).catch((err) => {
        this.logger.error("pipeline turn completion hook failed", {
          projectId: this.project.id,
          sessionId: id,
          turnId: active.turn.id,
          error: (err as Error).message,
        });
      });
    }
  }
  private async emit(
    route: Pick<SessionRoute, "projectId" | "sessionId">,
    type: EventRecord["type"],
    runtime: EventRecord["runtime"],
    payload: unknown,
  ): Promise<EventRecord> {
    const previous = this.eventQueues.get(route.sessionId) ?? Promise.resolve();
    let result!: EventRecord;
    const tracked = previous.then(async () => {
      let seq = this.sessionSequences.get(route.sessionId);
      if (seq === undefined) {
        seq = await this.store.getLatestEventSequence(route.sessionId);
      }
      seq += 1;
      this.sessionSequences.set(route.sessionId, seq);

      result = {
        id: `evt_${randomUUID()}`,
        projectId: route.projectId,
        sessionId: route.sessionId,
        sequence: seq,
        type,
        runtime,
        ...(payload &&
        typeof payload === "object" &&
        typeof (payload as any).turnId === "string"
          ? { turnId: (payload as any).turnId }
          : {}),
        payload,
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
      };

      const isTransient = isTransientEvent(type);
      if (!isTransient) {
        await this.store.appendEvent(result);
      }
      this.eventHub.publish(result);
    });
    this.eventQueues.set(
      route.sessionId,
      tracked.then(
        () => undefined,
        () => undefined,
      ),
    );
    await tracked;
    return result;
  }
  async checkLifecycles(): Promise<void> {
    await this.manageSessionLifecycles();
  }

  private async manageSessionLifecycles(): Promise<void> {
    if (this.stopping) return;
    const idleTimeout = this.project.session?.idleTimeoutMs ?? 30 * 60_000;
    const archiveTimeout = this.project.session?.archiveTimeoutMs ?? 60 * 60_000;
    for (const stored of await this.store.listSessions(this.project.id)) {
      const id = stored.sessionId;
      if (
        this.activeTurns.has(id) ||
        this.pendingTurns.get(id)?.length ||
        this.admissions.has(id) ||
        this.maintenance.has(id)
      )
        continue;
      this.maintenance.add(id);
      try {
        const entity = await this.entity(id);
        if (entity.status === "archived" || entity.status === "closing")
          continue;
        const idle = Date.now() - Date.parse(entity.lastActiveAt);
        const shouldSuspend = entity.status === "active" && idle >= idleTimeout;
        let archive = idle >= archiveTimeout;
        if (archive && (await this.hasPendingScheduledJobs(id))) {
          archive = false;
          this.logger.info(
            "session archive deferred for pending scheduled job",
            {
              sessionId: id,
              idleDurationMs: idle,
            },
          );
        }
        if (!archive && !shouldSuspend) continue;
        await this.releaseRuntimeSession(entity.toRoute());
        if (archive) await this.workspaces.removeSession(this.project, id);
        await entity.transitionTo(archive ? "archived" : "suspended");
        await entity.flush(this.store);
        await this.emit(
          entity.toRoute(),
          archive ? "session.archived" : "session.suspended",
          "gateway",
          { idleDurationMs: idle },
        );
      } catch (error) {
        this.logger.warn("session lifecycle transition failed", {
          sessionId: id,
          error,
        });
      } finally {
        this.maintenance.delete(id);
      }
    }
  }

  private async hasPendingScheduledJobs(sessionId: string): Promise<boolean> {
    const jobs = await this.store.listScheduledJobs({
      sessionId,
      projectId: this.project.id,
      status: ScheduledJobStatus.PENDING,
      limit: 1,
    });
    return jobs.length > 0;
  }

  /**
   * Render variables in task prompt template using standard namespaces:
   * `project.*`, `vars.*`, `task.*`, `state` / `state.*`, and `now.*`.
   */
  renderTaskPrompt(
    template: string,
    vars: {
      state: Record<string, unknown>;
      projectId: string;
      taskId: string;
      taskKey: string;
      taskName: string;
      cron?: string | undefined;
      timezone?: string | undefined;
    },
  ): string {
    const projectScope = buildProjectPromptScope(this.project);
    const { rendered, missingVars } = renderPromptTemplate(template, {
      project: projectScope,
      vars: this.project.vars ?? {},
      task: {
        id: vars.taskId,
        key: vars.taskKey,
        name: vars.taskName,
        cron: vars.cron ?? "",
        timezone: vars.timezone ?? "",
      },
      state: vars.state,
      now: buildNowPromptScope(vars.timezone),
    });

    if (missingVars.length > 0) {
      this.logger.warn("task prompt contains unresolved variables", {
        projectId: this.project.id,
        taskKey: vars.taskKey,
        missingVars,
      });
    }

    return rendered;
  }

  /**
   * Scan and reload all static tasks for the current project
   */
  async loadAndScheduleTasks(): Promise<TaskDefinition[]> {
    if (!this.project.projectDir) return [];
    const tasks = await this.taskLoader.loadProjectTasks(this.project.projectDir, this.project.id, {
      vars: this.project.vars,
    });
    this.taskScheduler.reloadTasks(tasks);
    this.logger.info("project tasks loaded and scheduled", {
      projectId: this.project.id,
      taskCount: tasks.length,
    });
    return tasks;
  }

  /**
   * List configured tasks for current project
   */
  async listTasks(): Promise<TaskDefinition[]> {
    if (!this.project.projectDir) return [];
    return this.taskLoader.loadProjectTasks(this.project.projectDir, this.project.id, {
      vars: this.project.vars,
    });
  }

  /**
   * Manually trigger a task execution
   */
  async runTask(taskId: string): Promise<boolean> {
    const tasks = await this.listTasks();
    const task = tasks.find((t) => t.taskId === taskId || t.taskKey === taskId);
    if (!task) {
      throw new NotFoundError(
        `Task ${taskId} not found in project ${this.project.id}`,
        ErrorCode.TASK_NOT_FOUND,
      );
    }
    return this.taskEngine.dispatch(task);
  }

  /**
   * Poll and execute due in-session scheduled jobs
   */
  async pollScheduledJobs(asOf: Date = new Date()): Promise<void> {
    if (this.stopping) return;
    try {
      const dueJobs = await this.store.listDueScheduledJobs(
        this.project.id,
        asOf,
      );
      for (const job of dueJobs) {
        await this.processDueScheduledJob(job);
      }
    } catch (err) {
      this.logger.error("error polling scheduled jobs", {
        projectId: this.project.id,
        error: String(err),
      });
    }
  }

  private async processDueScheduledJob(job: ScheduledJobRecord): Promise<void> {
    // Guard 1: Verify target session is active
    const session = await this.store.getSession(job.sessionId);
    if (
      !session ||
      session.status === "closing" ||
      session.status === "archived" ||
      session.status === "failed"
    ) {
      this.logger.info(
        "scheduled job abandoned because session is closed or archived",
        {
          jobId: job.jobId,
          sessionId: job.sessionId,
          status: session?.status,
        },
      );
      await this.store.updateScheduledJobStatus(
        job.jobId,
        ScheduledJobStatus.ABANDONED,
        "session_closed",
        new Date().toISOString(),
      );
      return;
    }

    // Guard 2: Stale turn protection (ensure session has not progressed with a new turn)
    const latestTurn = await this.store.getLatestTurn(job.sessionId);
    const createdTurnId =
      typeof job.metadata.createdTurnId === "string"
        ? job.metadata.createdTurnId
        : undefined;

    const matchesCreatedTurn =
      !createdTurnId ||
      !latestTurn ||
      latestTurn.id === createdTurnId ||
      latestTurn.runtimeTurnId === createdTurnId;

    if (!matchesCreatedTurn) {
      this.logger.info(
        "scheduled job abandoned because session has progressed with new turn",
        {
          jobId: job.jobId,
          sessionId: job.sessionId,
          createdTurnId,
          latestTurnId: latestTurn?.id,
          latestRuntimeTurnId: latestTurn?.runtimeTurnId,
        },
      );
      await this.store.updateScheduledJobStatus(
        job.jobId,
        ScheduledJobStatus.ABANDONED,
        "stale_turn_superceded",
        new Date().toISOString(),
      );
      return;
    }

    // Guard passed: mark running and launch conversation turn
    await this.store.updateScheduledJobStatus(
      job.jobId,
      ScheduledJobStatus.RUNNING,
    );
    this.logger.info("waking up session for scheduled job", {
      jobId: job.jobId,
      sessionId: job.sessionId,
      name: job.name,
    });

    try {
      const queuedTurn = await this.turn(job.sessionId, job.prompt);
      await this.waitForIdle(job.sessionId);
      const finalTurn = await this.store.getTurn(queuedTurn.id);

      if (finalTurn?.status === "completed") {
        await this.store.updateScheduledJobStatus(
          job.jobId,
          ScheduledJobStatus.COMPLETED,
          "completed",
          new Date().toISOString(),
        );
        this.logger.info("scheduled job completed successfully", {
          jobId: job.jobId,
          turnId: queuedTurn.id,
        });
      } else {
        await this.store.updateScheduledJobStatus(
          job.jobId,
          ScheduledJobStatus.ABANDONED,
          finalTurn?.error ?? "turn_failed",
          new Date().toISOString(),
        );
      }
    } catch (err) {
      this.logger.error("scheduled job turn execution failed", {
        jobId: job.jobId,
        sessionId: job.sessionId,
        error: String(err),
      });
      await this.store.updateScheduledJobStatus(
        job.jobId,
        ScheduledJobStatus.ABANDONED,
        String(err),
        new Date().toISOString(),
      );
    }
  }
}
