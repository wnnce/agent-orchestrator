import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  ScheduledJobStatus,
  type ArtifactRecord,
  type EventRecord,
  type ProjectConfig,
  type ScheduledJobRecord,
  type SessionRoute,
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
import { WorkspaceManager } from "../workspace/workspace.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import { NotificationHub, NotificationOutbox } from "../notifications/index.ts";
import { Logger } from "../observability/logger.ts";
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
  ScriptTaskExecutor,
  ActionTaskExecutor,
  type AgentSessionRunner,
  type ITaskExecutor,
  type TaskDefinition,
  type TaskRunResult,
} from "../task/index.ts";
import {
  ActionRegistry,
  defaultActionRegistry,
  createActionContext,
  updateTaskStateAction,
  type ActionContext,
  type ActionScope,
} from "../actions/index.ts";

interface ActiveTurn {
  turn: TurnRecord;
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
}

export class ProjectRuntime {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingTurns = new Map<string, TurnRecord[]>();
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
  readonly actionRegistry: ActionRegistry;

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
    actionRegistry?: ActionRegistry,
  ) {
    this.taskEngine = taskEngine ?? new TaskEngine(store, logger);
    this.taskScheduler =
      taskScheduler ?? new TaskScheduler(this.taskEngine, logger);
    this.taskLoader = taskLoader ?? new TaskLoader(logger);
    this.actionRegistry = actionRegistry ?? defaultActionRegistry;

    const taskRegistry = new TaskExecutorRegistry(logger);
    const agentRunner: AgentSessionRunner = {
      createSession: async (task) => {
        const sessionRoute = await this.createSession(
          undefined,
          {
            title: `Task: ${task.name}`,
            taskKey: task.taskKey,
            taskId: task.taskId,
          },
          "task",
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
      new ScriptTaskExecutor(
        {
          ...(this.project.projectDir
            ? { getWorkdir: () => this.project.projectDir }
            : {}),
        },
        logger,
      ),
    );
    taskRegistry.register(
      new ActionTaskExecutor(this.actionRegistry, logger, (context) =>
        this.createActionContext({
          sessionId: `task_action_${context.task.taskId}`,
          taskKey: context.task.taskKey,
          signal: context.signal,
          workspacePath: this.project.projectDir,
        }),
      ),
    );

    this.taskEngine.setRegistry(taskRegistry);
    if (!this.actionRegistry.has("update_task_state")) {
      this.actionRegistry.register(updateTaskStateAction);
    }
  }

  /**
   * Create enriched ActionContext (notifications, artifacts, workspace sandbox, task state, DI services)
   */
  createActionContext(params: {
    sessionId: string;
    workspacePath?: string | undefined;
    turnId?: string | undefined;
    taskKey?: string | undefined;
    scope?: ActionScope | undefined;
    signal?: AbortSignal | undefined;
  }): ActionContext {
    const workspacePath =
      params.workspacePath ?? this.project.projectDir ?? process.cwd();
    return createActionContext({
      projectId: this.project.id,
      sessionId: params.sessionId,
      turnId: params.turnId,
      taskKey: params.taskKey,
      scope: params.scope ?? (params.taskKey ? "task" : "conversation"),
      workspacePath,
      logger: this.logger,
      signal: params.signal,
      projectNotifications: this.project.notifications,
      services: {
        notifications: this.notifications,
        artifacts: this.artifactStore,
        artifactStore: this.artifactStore,
        store: this.store,
        taskEngine: this.taskEngine,
        eventHub: this.eventHub,
        sessionManager: this.sessionManager,
      },
      onEmit: async (type, payload) => {
        await this.emit(
          { projectId: this.project.id, sessionId: params.sessionId },
          type as any,
          params.taskKey ? "task" : "gateway",
          payload,
        );
      },
      onDispatchTask: async (dispatchParams) => {
        const sessionRoute = await this.createSession(
          dispatchParams.repositoryId,
          {
            title: dispatchParams.title,
            sourceSessionId: params.sessionId,
            ...(params.taskKey ? { sourceTaskKey: params.taskKey } : {}),
            ...(dispatchParams.metadata ? { dispatch: dispatchParams.metadata } : {}),
          },
          "dispatch",
        );
        const turn = await this.turn(
          sessionRoute.sessionId,
          dispatchParams.prompt,
        );
        return { sessionId: sessionRoute.sessionId, turnId: turn.id };
      },
    });
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
    if (
      this.project.runtime?.type === "codex" ||
      this.project.agent?.type === "codex" ||
      !this.project.runtime?.type
    ) {
      const codexHome =
        this.project.runtime?.codexHome ??
        path.resolve(".data/codex", this.project.id);
      await SkillManager.syncSkillsToCodex(
        codexHome,
        this.project,
        this.inheritedSkillsProject,
      ).catch((err) => {
        this.logger.warn("failed to sync project skills on start", {
          projectId: this.project.id,
          error: (err as Error).message,
        });
      });
    }
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

    if (this.project.projectDir) {
      await this.loadProjectCustomExecutors().catch((err) => {
        this.logger.warn("failed to load custom project executors", {
          projectId: this.project.id,
          error: (err as Error).message,
        });
      });
      await this.loadAndScheduleTasks().catch((err) => {
        this.logger.warn("failed to load and schedule project tasks on start", {
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
    await this.taskEngine.drain().catch(() => {});
    await this.notifications.drain().catch(() => {});
    await Promise.allSettled([...this.admissions.values()]);
    for (const id of [...this.pendingTurns.keys()]) await this.cancelQueued(id);
    await this.runtime.stop();
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
   * Creates a session. `source` records who created it and is the only thing that marks a
   * session as a scheduled-task session (`"task"`).
   */
  async createSession(
    repositoryId?: string,
    metadata?: Record<string, unknown>,
    source = "api",
  ): Promise<SessionRoute> {
    if (
      this.project.repositories.length === 0 &&
      this.project.id !== GLOBAL_PROJECT_ID
    )
      throw new Error(`project ${this.project.id} has no repository`);
    const sessionId = `ses_${randomUUID()}`;
    const workspaceInfo = await this.workspaces.ensureSessionWorkspaces(
      this.project,
      sessionId,
    );
    const primaryRepo =
      (repositoryId
        ? this.project.repositories.find((r) => r.id === repositoryId)
        : undefined) ??
      this.project.repositories.find((r) => r.isPrimary) ??
      this.project.repositories[0];
    const workspacePath =
      (primaryRepo && workspaceInfo.repoPaths.get(primaryRepo.id)) ||
      workspaceInfo.primaryPath ||
      workspaceInfo.sessionRoot;

    const taskKey =
      typeof metadata?.taskKey === "string" ? metadata.taskKey : undefined;
    const context = this.context(workspacePath, sessionId, taskKey);
    const runtimeSession = await this.runtime.startSession(context);
    this.boundSessions.add(sessionId);
    const runtimeName = this.runtimeName();
    const route: SessionRoute = {
      sessionId,
      ...(typeof metadata?.title === "string" && metadata.title
        ? { title: metadata.title }
        : {}),
      projectId: this.project.id,
      ...(primaryRepo?.id ? { repositoryId: primaryRepo.id } : {}),
      projectRuntimeId: `project-runtime:${this.project.id}`,
      runtimeSessionId: runtimeSession.id,
      runtime: runtimeName,
      workspacePath,
      configRevision: this.project.revision ?? 1,
      status: "active",
      source,
      lastActiveAt: new Date().toISOString(),
      metadata: { ...(metadata ?? {}), runtime: runtimeName },
    };
    await this.store.createSession(route);
    this.sessionManager.loadOrCreate(route);
    await this.emit(route, "session.started", "gateway", {
      runtimeSessionId: runtimeSession.id,
      workspacePath,
      repositoryId: primaryRepo?.id,
    });
    this.logger.info("session created", {
      projectId: this.project.id,
      sessionId,
      repositoryId: primaryRepo?.id,
      runtimeSessionId: runtimeSession.id,
    });
    return route;
  }

  /** Renames a session at the user's request. */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const cleanTitle = title.trim().slice(0, 255);
    if (!(await this.store.updateSessionTitle(sessionId, cleanTitle))) return false;
    await this.applyTitle(sessionId, cleanTitle);
    return true;
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
    if (!entity || entity.projectId !== this.project.id)
      throw new Error(
        `session ${id} is not owned by project ${this.project.id}`,
      );
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
  async turn(sessionId: string, input: string): Promise<TurnRecord> {
    return this.admit(sessionId, async () => {
      const entity = await this.entity(sessionId);
      if (this.stopping) throw new Error("runtime is stopping");
      if (entity.status === "archived")
        throw new Error(`session ${sessionId} is archived and read-only`);
      if (entity.status === "closing")
        throw new Error(`session ${sessionId} is closing`);
      if (this.maintenance.has(sessionId))
        throw new Error("session maintenance in progress; retry the message");
      if (!input.trim()) throw new Error("input is required");
      const queue = this.pendingTurns.get(sessionId) ?? [];
      if (queue.length >= (this.options.queueLimit ?? 64))
        throw new Error("session queue is full");
      entity.touch();
      if (entity.status !== "suspended") await entity.transitionTo("active");
      await entity.flush(this.store);
      const turn: TurnRecord = {
        id: `turn_${randomUUID()}`,
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
      queue.push(turn);
      this.pendingTurns.set(sessionId, queue);
      this.startPump(sessionId);
      return turn;
    });
  }
  private startPump(id: string): void {
    if (this.pumps.has(id)) return;
    const task = this.pump(id).catch((error) =>
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
      const turn = this.pendingTurns.get(id)?.shift();
      if (!turn) {
        this.pendingTurns.delete(id);
        return;
      }
      const entity = await this.entity(id);
      if (entity.status === "closing" || entity.status === "archived") {
        await this.finishQueued(entity.toRoute(), turn);
        continue;
      }
      let resolve!: () => void;
      const completed = new Promise<void>((r) => {
        resolve = r;
      });
      const active: ActiveTurn = {
        turn,
        starting: true,
        canceled: false,
        settled: false,
        early: [],
        completed,
        resolve,
      };
      this.activeTurns.set(id, active);
      try {
        await this.runTurn(entity.toRoute(), turn);
      } catch (error) {
        await this.finishTurn(id, active, "failed", String(error));
      }
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
    const canceled = queue.filter((t) => !turnId || t.id === turnId);
    this.pendingTurns.set(
      id,
      queue.filter((t) => turnId && t.id !== turnId),
    );
    const route = await this.store.getSession(id);
    if (!route) return;
    for (const turn of canceled) await this.finishQueued(route, turn);
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
    if (!active?.runtimeId || active.settled) throw new Error("no active turn");
    await this.runtime.steerTurn(
      this.context(this.workspacePath(route), sessionId),
      route.runtimeSessionId ?? "",
      active.runtimeId,
      input,
    );
  }
  async interrupt(sessionId: string, turnId?: string): Promise<void> {
    await this.admissions.get(sessionId)?.catch(() => {});
    const route = await this.loadSession(sessionId);
    if (
      turnId &&
      this.pendingTurns.get(sessionId)?.some((t) => t.id === turnId)
    ) {
      await this.cancelQueued(sessionId, turnId);
      return;
    }
    const active = this.activeTurns.get(sessionId);
    if (!active || active.settled || (turnId && active.turn.id !== turnId))
      return;
    if (!active.canceled) {
      active.canceled = true;
      if (active.runtimeId)
        await this.runtime.interruptTurn(
          this.context(this.workspacePath(route), sessionId),
          route.runtimeSessionId ?? "",
          active.runtimeId,
        );
    }
    await this.bounded(
      active.completed,
      "turn interrupt timed out",
    );
  }
  async compact(sessionId: string): Promise<void> {
    const route = await this.loadSession(sessionId);
    await this.runtime.compactSession(
      this.context(this.workspacePath(route), sessionId),
      route.runtimeSessionId ?? "",
    );
  }
  async approve(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const route = await this.loadSession(sessionId);
    await this.runtime.respondToApproval(
      this.context(this.workspacePath(route), sessionId),
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
  async listArtifacts(sessionId: string): Promise<ArtifactRecord[]> {
    await this.loadSession(sessionId);
    return this.store.listArtifacts(sessionId);
  }

  async artifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactRecord> {
    const artifacts = await this.listArtifacts(sessionId);
    const artifact = artifacts.find((item) => item.id === artifactId);
    if (!artifact) throw new Error(`artifact not found: ${artifactId}`);
    return artifact;
  }

  async readArtifact(artifact: ArtifactRecord): Promise<Uint8Array> {
    return this.artifactStore.read(artifact);
  }

  private async runTurn(route: SessionRoute, turn: TurnRecord): Promise<void> {
    const id = route.sessionId;
    const active = this.activeTurns.get(id)!;
    const entity = await this.entity(id);
    const workspacePath = await this.ensureWorkspace(route);
    const taskKey =
      typeof route.metadata?.taskKey === "string"
        ? route.metadata.taskKey
        : undefined;
    const context = this.context(workspacePath, id, taskKey);
    const runtimeSessionId = await this.bindRuntimeSession(entity, context);
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
    await this.emit(entity.toRoute(), "turn.started", this.runtime.type, {
      turnId: turn.id,
    });
    const runtimeTurn = await this.runtime.startTurn(
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
      await this.runtime.interruptTurn(
        context,
        runtimeSessionId,
        runtimeTurn.id,
      );
    await active.completed;
  }
  /**
   * Makes sure the agent runtime holds this session, resuming it at most once per process.
   * When the runtime no longer has the session, or the project switched runtimes, a new runtime
   * session is started and `session.runtime_reset` tells clients the earlier context is gone.
   */
  private async bindRuntimeSession(
    entity: SessionEntity,
    context: RuntimeContext,
  ): Promise<string> {
    const route = entity.toRoute();
    const previousId = route.runtimeSessionId;
    if (previousId && this.boundSessions.has(route.sessionId)) return previousId;

    const runtimeName = this.runtimeName();
    let resetReason: "not_found" | "runtime_changed" | undefined;
    let runtimeSessionId: string | undefined;
    if (previousId && route.runtime && route.runtime !== "unknown" && route.runtime !== runtimeName) {
      resetReason = "runtime_changed";
    } else if (previousId) {
      try {
        runtimeSessionId = (await this.runtime.resumeSession(context, previousId)).id;
      } catch (error) {
        if (!(error instanceof RuntimeSessionNotFoundError)) throw error;
        resetReason = "not_found";
      }
    }
    runtimeSessionId ??= (await this.runtime.startSession(context)).id;
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
    return runtimeSessionId;
  }
  private runtimeName(): string {
    return this.runtime.name ?? this.runtime.type;
  }
  /** Releases the runtime's hold on a session; the next turn resumes it. */
  private async releaseRuntimeSession(route: SessionRoute): Promise<void> {
    this.boundSessions.delete(route.sessionId);
    if (!route.runtimeSessionId) return;
    await this.runtime.releaseSession(
      this.context(this.workspacePath(route), route.sessionId),
      route.runtimeSessionId,
    );
  }
  /**
   * The session's working directory. It is stored when the session is created; sessions created
   * before that was stored get it computed. Never touches git.
   */
  private workspacePath(route: SessionRoute): string {
    if (route.workspacePath) return route.workspacePath;
    const info = this.workspaces.resolveSessionWorkspace(this.project, route.sessionId);
    return (route.repositoryId && info.repoPaths.get(route.repositoryId)) || info.primaryPath;
  }
  /** Recreates the session's worktrees when they are missing, e.g. after the data dir was cleaned. */
  private async ensureWorkspace(route: SessionRoute): Promise<string> {
    if (!this.workspaces.isSessionReady(this.project, route.sessionId)) {
      this.logger.warn("session workspace is missing; recreating it", {
        projectId: this.project.id,
        sessionId: route.sessionId,
      });
      await this.workspaces.ensureSessionWorkspaces(this.project, route.sessionId);
    }
    return this.workspacePath(route);
  }
  private context(
    workspacePath: string,
    sessionId: string,
    taskKey?: string,
  ): RuntimeContext {
    return {
      project: this.project,
      workspacePath,
      ...(taskKey ? { taskKey } : {}),
      onEvent: (event) => this.onRuntimeEvent(sessionId, event),
      createActionContext: (params) =>
        this.createActionContext({
          sessionId,
          workspacePath,
          taskKey,
          turnId: this.activeTurns.get(sessionId)?.turn.id ?? params.turnId,
          signal: params.signal,
        }),
    };
  }
  private async onRuntimeEvent(id: string, event: RuntimeEvent): Promise<void> {
    const active = this.activeTurns.get(id);
    if (active?.starting) {
      active.early.push(event);
      return;
    }
    const previous = this.runtimeEvents.get(id) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => this.processRuntimeEvent(id, event));
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
        undefined,
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
        id,
        active.turn.id,
        "agent-message",
        text,
        "text/plain; charset=utf-8",
      );
    }
    await this.emit(entity.toRoute(), type, this.runtime.type, {
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
    try {
      const entity = await this.entity(id);
      await this.store.updateTurn(active.turn.id, {
        status,
        finishedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
      });
      entity.touch();
      await entity.flush(this.store);
      await this.emit(entity.toRoute(), `turn.${status}`, this.runtime.type, {
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
          id,
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
    } finally {
      if (this.activeTurns.get(id) === active) this.activeTurns.delete(id);
      active.resolve();
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
    const idleTimeout = this.project.runtime?.idleTimeoutMs ?? 30 * 60_000;
    const archiveTimeout =
      this.project.runtime?.archiveTimeoutMs ?? 60 * 60_000;
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
   * Render variables in task prompt template
   */
  renderTaskPrompt(
    template: string,
    vars: {
      state: Record<string, unknown>;
      projectId: string;
      taskId: string;
      taskKey: string;
      taskName: string;
    },
  ): string {
    let result = template;
    result = result.replaceAll("{{projectId}}", vars.projectId);
    result = result.replaceAll("{{taskId}}", vars.taskId);
    result = result.replaceAll("{{taskKey}}", vars.taskKey);
    result = result.replaceAll("{{taskName}}", vars.taskName);
    result = result.replaceAll(
      "{{state}}",
      JSON.stringify(vars.state, null, 2),
    );

    // Support {{state.fieldName}} variable extraction
    result = result.replace(/\{\{state\.([a-zA-Z0-9_]+)\}\}/g, (_, field) => {
      const val = vars.state[field];
      if (val === undefined || val === null) return "";
      return typeof val === "object" ? JSON.stringify(val) : String(val);
    });

    return result;
  }

  /**
   * Discover and load custom project executors (projects/<projectId>/executors/*.ts)
   */
  async loadProjectCustomExecutors(): Promise<void> {
    if (!this.project.projectDir) return;
    const executorsDir = path.resolve(this.project.projectDir, "executors");
    try {
      await access(executorsDir, constants.R_OK);
    } catch {
      return; // Skip if directory does not exist
    }

    const registry = this.taskEngine.getRegistry();
    if (!registry) return;

    try {
      const files = await readdir(executorsDir);
      for (const file of files) {
        if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
        const fullPath = path.join(executorsDir, file);
        try {
          const mod = (await import(fullPath)) as Record<string, unknown>;
          const candidate =
            mod.default ?? mod.executor ?? Object.values(mod)[0];
          if (
            candidate &&
            typeof candidate === "object" &&
            "type" in candidate &&
            typeof (candidate as { execute?: unknown }).execute === "function"
          ) {
            registry.register(candidate as ITaskExecutor);
            this.logger.info("loaded custom task executor", {
              projectId: this.project.id,
              type: (candidate as ITaskExecutor).type,
              file,
            });
          } else if (
            typeof candidate === "function" &&
            candidate.prototype &&
            "execute" in candidate.prototype
          ) {
            const instance = new (candidate as new () => ITaskExecutor)();
            registry.register(instance);
            this.logger.info("instantiated and loaded custom task executor", {
              projectId: this.project.id,
              type: instance.type,
              file,
            });
          }
        } catch (fileErr) {
          const msg =
            fileErr instanceof Error ? fileErr.message : String(fileErr);
          this.logger.warn("failed to load custom executor file", {
            projectId: this.project.id,
            file,
            error: msg,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn("failed to scan project executors directory", {
        projectId: this.project.id,
        error: msg,
      });
    }
  }

  /**
   * Scan and reload all static tasks for the current project
   */
  async loadAndScheduleTasks(): Promise<TaskDefinition[]> {
    if (!this.project.projectDir) return [];
    const tasks = await this.taskLoader.loadProjectTasks(
      this.project.projectDir,
      this.project.id,
    );
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
    return this.taskLoader.loadProjectTasks(
      this.project.projectDir,
      this.project.id,
    );
  }

  /**
   * Manually trigger a task execution
   */
  async runTask(taskId: string): Promise<boolean> {
    const tasks = await this.listTasks();
    const task = tasks.find((t) => t.taskId === taskId || t.taskKey === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found in project ${this.project.id}`);
    }
    return this.taskEngine.dispatch(task);
  }

  /**
   * Execute task entrypoint dispatched to TaskExecutorRegistry
   */
  async executeTask(
    task: TaskDefinition,
    stateBefore: Record<string, unknown>,
  ): Promise<TaskRunResult> {
    const registry = this.taskEngine.getRegistry();
    if (registry) {
      const executor = registry.resolve(task);
      return executor.execute({
        task,
        stateBefore,
        updateState: (newState) =>
          this.taskEngine.updateState(task.taskKey, newState),
      });
    }
    return {
      success: true,
      durationMs: 0,
      stateBefore,
      stateAfter: stateBefore,
    };
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
