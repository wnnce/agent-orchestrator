import type { ArtifactStore } from "../artifacts/store.ts";
import {
  createProjectContext,
  type ContextOptions,
  type ScopedContext,
  type StartSessionParams,
  type StartedSession,
} from "../context/index.ts";
import type { Origin } from "../domain/origin.ts";
import type { ProjectConfig, SessionRuntimeOverride } from "../domain/types.ts";
import { MemoryEventHub, type EventHub } from "../events/hub.ts";
import { ProjectHooks } from "../hooks/registry.ts";
import type { McpClientFactory } from "../mcp/index.ts";
import { NotificationHub, NotificationOutbox } from "../notifications/index.ts";
import { Logger } from "../observability/logger.ts";
import type { Store } from "../persistence/store.ts";
import { PipelineEngine, PipelineEventHub } from "../pipeline/index.ts";
import type { AgentRuntime } from "../runtime/runtime.ts";
import { AgentRuntimes } from "../session/agents.ts";
import { SessionEvents } from "../session/events.ts";
import { SessionLifecycle } from "../session/lifecycle.ts";
import { SessionManager } from "../session/manager.ts";
import { ScheduledJobs } from "../session/scheduled-jobs.ts";
import { SessionTurns, type TurnFinished } from "../session/turns.ts";
import { SessionWorkspaces } from "../session/workspaces.ts";
import { ProjectTasks } from "../task/index.ts";
import {
  builtinTools,
  loadProjectTools,
  ToolRegistry,
  type ToolDefinition,
} from "../tools/index.ts";
import type { WorkspaceManager } from "../workspace/workspace.ts";
import { AgentTools } from "./agent-tools.ts";
import { GLOBAL_PROJECT_ID } from "./global.ts";
import { SkillManager, type ProjectSkill } from "./skills.ts";

export interface ProjectRuntimeDeps {
  readonly project: ProjectConfig;
  readonly store: Store;
  /** The project's default agent runtime. */
  readonly agentRuntime: AgentRuntime;
  readonly workspaces: WorkspaceManager;
  readonly artifacts: ArtifactStore;
  readonly notifications?: NotificationOutbox | undefined;
  readonly logger?: Logger | undefined;
  readonly eventHub?: EventHub | undefined;
  readonly sessionManager?: SessionManager | undefined;
  /** Creates the other runtimes a session may ask for by type. */
  readonly runtimeFactory?: ((runtimeType: string) => AgentRuntime) | undefined;
  /** Shared by all projects, so pipeline event streams can span them. */
  readonly pipelineEventHub?: PipelineEventHub | undefined;
  /** Replaces how project contexts connect to MCP servers (tests). */
  readonly mcpClientFactory?: McpClientFactory | undefined;
  /** Replaces the tools the project's agents are offered (tests). */
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly queueLimit?: number | undefined;
  readonly controlTimeoutMs?: number | undefined;
  readonly scheduledJobPollIntervalMs?: number | undefined;
}

const SWEEP_INTERVAL_MS = 60_000;
const SCHEDULED_JOB_POLL_INTERVAL_MS = 30_000;

/** A pipeline node's or task's runtime config, as a session asks for it. */
function runtimeRequest(config?: {
  readonly type?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): SessionRuntimeOverride | undefined {
  if (!config) return undefined;
  return { runtime: config.type, model: config.model, reasoningEffort: config.reasoningEffort };
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

/**
 * One project at run time. It puts the project's parts together and starts and stops them; the
 * parts do the work:
 *
 * - `sessions`: creating, reading and ending sessions;
 * - `turns`: running the sessions' turns on their agent runtimes;
 * - `scheduledJobs`: the wake-ups agents schedule for their sessions;
 * - `tasks`, `pipelines`, `hooks`: the project's tasks, pipelines and HTTP hooks;
 * - `tools`, `agentTools`: the tools the project's agents are offered.
 */
export class ProjectRuntime {
  readonly project: ProjectConfig;
  readonly sessionManager: SessionManager;
  readonly sessions: SessionLifecycle;
  readonly turns: SessionTurns;
  readonly scheduledJobs: ScheduledJobs;
  readonly tasks: ProjectTasks;
  readonly pipelines: PipelineEngine;
  readonly pipelineEvents: PipelineEventHub;
  readonly hooks: ProjectHooks;
  /** The tools this project's agents are offered. */
  readonly tools: ToolRegistry;
  /** The same tools, bound to the session calling them. */
  readonly agentTools: AgentTools;

  private readonly store: Store;
  private readonly logger: Logger;
  private readonly notifications: NotificationOutbox;
  private readonly artifacts: ArtifactStore;
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly deps: ProjectRuntimeDeps) {
    const { project, store } = deps;
    const logger = deps.logger ?? new Logger();
    const isGlobal = project.id === GLOBAL_PROJECT_ID;
    this.project = project;
    this.store = store;
    this.logger = logger;
    this.artifacts = deps.artifacts;
    this.notifications = deps.notifications ?? new NotificationOutbox(store, new NotificationHub());
    this.sessionManager = deps.sessionManager ?? new SessionManager(store);
    // The global project only reads; its agents get no tools that act on projects.
    this.tools = new ToolRegistry(deps.tools ?? (isGlobal ? [] : builtinTools), logger, (record) =>
      store.recordToolExecution(record),
    );

    const events = new SessionEvents(store, deps.eventHub ?? new MemoryEventHub(store));
    const workspaces = new SessionWorkspaces(project, deps.workspaces, logger);
    const agents = new AgentRuntimes({
      project,
      defaultRuntime: deps.agentRuntime,
      runtimeFactory: deps.runtimeFactory,
      readOnly: isGlobal,
      events,
      logger,
      toolsFor: (sessionId, workspacePath, owner) =>
        this.agentTools.forSession(sessionId, workspacePath, owner),
      onEvent: (sessionId, event) => this.turns.handleRuntimeEvent(sessionId, event),
    });
    this.turns = new SessionTurns({
      project,
      store,
      sessions: this.sessionManager,
      agents,
      workspaces,
      events,
      artifacts: deps.artifacts,
      notifications: this.notifications,
      logger,
      queueLimit: deps.queueLimit,
      controlTimeoutMs: deps.controlTimeoutMs,
      onTurnFinished: (finished) => this.reportTurnFinished(finished),
    });
    this.scheduledJobs = new ScheduledJobs({
      projectId: project.id,
      store,
      turns: this.turns,
      logger,
    });
    this.sessions = new SessionLifecycle({
      project,
      store,
      sessions: this.sessionManager,
      agents,
      turns: this.turns,
      workspaces,
      events,
      artifacts: deps.artifacts,
      logger,
      hasPendingJobs: (sessionId) => this.scheduledJobs.hasPending(sessionId),
      allowWithoutRepository: isGlobal,
    });
    this.tasks = new ProjectTasks({
      project,
      store,
      logger,
      createContext: (origin, options) => this.createContext(origin, options),
      sessions: {
        createSession: async (task, executionId) => {
          const session = await this.sessions.create({
            title: `Task: ${task.name}`,
            source: "task",
            runtime: runtimeRequest(task.runtime),
            owner: { kind: "task", taskId: task.taskId, taskKey: task.taskKey, executionId },
          });
          return { sessionId: session.sessionId };
        },
        runTurn: async (sessionId, input) => {
          const queued = await this.turns.submit(sessionId, input);
          await this.turns.waitForIdle(sessionId);
          const turn = await store.getTurn(queued.id);
          return {
            turnId: queued.id,
            status: turn?.status ?? "completed",
            ...(turn?.error !== undefined ? { error: turn.error } : {}),
          };
        },
        cleanupSession: (sessionId) => this.sessions.close(sessionId, { retain: true }),
      },
    });
    this.pipelineEvents = deps.pipelineEventHub ?? new PipelineEventHub();
    this.pipelines = new PipelineEngine({
      project,
      store: store.pipelines,
      workspaces: deps.workspaces,
      notifications: this.notifications,
      hub: this.pipelineEvents,
      logger,
      createContext: (origin, options) => this.createContext(origin, options),
      sessions: {
        create: ({ workspacePath, title, owner, runtimeOverride }) =>
          this.sessions.create({
            title,
            source: "pipeline",
            runtime: runtimeRequest(runtimeOverride),
            owner,
            workspacePath,
          }),
        runTurn: async (sessionId, input, turnId) => {
          await this.turns.submit(sessionId, input, { turnId });
        },
        archive: (sessionId) => this.sessions.archive(sessionId, "pipeline_node_completed"),
        interrupt: (sessionId) => this.turns.interrupt(sessionId),
      },
    });
    this.hooks = new ProjectHooks(
      project.id,
      (origin, options) => this.createContext(origin, options),
      logger,
    );
    this.agentTools = new AgentTools({
      registry: this.tools,
      createContext: (origin, options) => this.createContext(origin, options),
      turns: this.turns,
      scheduledJobs: this.scheduledJobs,
      taskEngine: this.tasks.engine,
      pipelineEngine: this.pipelines,
    });
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
        artifacts: this.artifacts,
        sessions: { start: (params, from) => this.startSessionFor(params, from) },
        pipelines: {
          start: (params) => this.pipelines.startRun(params),
          find: (pipelineId, externalKey) =>
            this.store.pipelines.findRunByExternalKey(this.project.id, pipelineId, externalKey),
          signal: (runId) => this.pipelines.signalRun(runId),
          list: () => this.pipelines.listPipelinesWithVersions(),
        },
        mcpClientFactory: this.deps.mcpClientFactory,
      },
      origin,
      options,
    );
  }

  listSkills(): Promise<ProjectSkill[]> {
    return SkillManager.listProjectSkills(this.project);
  }

  async start(): Promise<void> {
    const { project, logger } = this;
    logger.info("project runtime started", {
      projectId: project.id,
      runtime: this.deps.agentRuntime.type,
    });
    await this.sessions.reconcile();
    this.timers.push(
      setInterval(() => void this.sessions.sweepIdle(), SWEEP_INTERVAL_MS),
      setInterval(
        () => void this.scheduledJobs.poll(),
        this.deps.scheduledJobPollIntervalMs ?? SCHEDULED_JOB_POLL_INTERVAL_MS,
      ),
    );

    const isGlobal = project.id === GLOBAL_PROJECT_ID;
    if (project.projectDir && !isGlobal) {
      if (!this.deps.tools) await this.loadProjectTools(project.projectDir);
      await this.hooks.load(project.projectDir);
    }
    if (project.projectDir) {
      await this.tasks.reload().catch((err) => {
        logger.warn("failed to load and schedule project tasks on start", {
          projectId: project.id,
          error: (err as Error).message,
        });
      });
    }
    if (!isGlobal) {
      await this.pipelines.start().catch((err) => {
        logger.warn("failed to start pipeline engine", {
          projectId: project.id,
          error: (err as Error).message,
        });
      });
    }
  }

  /**
   * Stops the project. Running turns may finish while tasks and pipelines wind down; after that
   * the agent runtimes are stopped and the turns still running fail.
   */
  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.turns.stopAccepting();
    await this.pipelines.stop().catch(() => {});
    await this.tasks.stop();
    await this.notifications.drain().catch(() => {});
    await this.turns.stop();
    await this.scheduledJobs.stop();
    this.logger.info("project runtime stopped", { projectId: this.project.id });
  }

  private async loadProjectTools(projectDir: string): Promise<void> {
    const tools = await loadProjectTools(projectDir, this.project.id, this.logger);
    if (tools.length === 0) return;
    this.tools.register(tools, { override: true });
    this.logger.info("project custom tools loaded", {
      projectId: this.project.id,
      tools: tools.map((tool) => tool.name),
    });
  }

  /**
   * A session started by project code or an agent tool. It is an ordinary session that remembers
   * where it came from; unless told otherwise it uses the project's runtime and model.
   */
  private async startSessionFor(
    params: StartSessionParams,
    origin: Origin,
  ): Promise<StartedSession> {
    const session = await this.sessions.create({
      title: params.title,
      source: "dispatch",
      runtime: {
        runtime: params.runtime,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
      },
      metadata: {
        ...sessionSourceMetadata(origin),
        ...(params.metadata ? { dispatch: params.metadata } : {}),
      },
    });
    const turn = await this.turns.submit(session.sessionId, params.prompt);
    return { sessionId: session.sessionId, turnId: turn.id };
  }

  /** A pipeline session's turn moves its node run on. */
  private reportTurnFinished(finished: TurnFinished): void {
    if (finished.session.source !== "pipeline") return;
    const { session, ...result } = finished;
    void this.pipelines
      .onSessionTurnFinished({ sessionId: session.sessionId, ...result })
      .catch((err) => {
        this.logger.error("pipeline turn completion hook failed", {
          projectId: this.project.id,
          sessionId: session.sessionId,
          turnId: finished.turnId,
          error: (err as Error).message,
        });
      });
  }
}
