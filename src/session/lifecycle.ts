import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/store.ts";
import { ErrorCode, NotFoundError } from "../domain/errors.ts";
import type { SessionOwner } from "../domain/origin.ts";
import type {
  ArtifactRecord,
  EventRecord,
  ProjectConfig,
  SessionRoute,
  SessionRuntimeOverride,
} from "../domain/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { Store } from "../persistence/store.ts";
import type { AgentRuntimes } from "./agents.ts";
import type { SessionEntity } from "./entity.ts";
import type { SessionEvents } from "./events.ts";
import type { SessionManager } from "./manager.ts";
import type { SessionTurns } from "./turns.ts";
import type { SessionWorkspaces } from "./workspaces.ts";

export interface CreateSessionParams {
  readonly title?: string | undefined;
  /** Who created the session: `api`, `task`, `pipeline`, `dispatch`… Defaults to `api`. */
  readonly source?: string | undefined;
  /** The runtime, model and effort the session asks for; see {@link AgentRuntimes}. */
  readonly runtime?: SessionRuntimeOverride | undefined;
  /** The task execution or pipeline node the session works for. */
  readonly owner?: SessionOwner | undefined;
  /** A worktree the session works in (a pipeline run's); otherwise it gets its own. */
  readonly workspacePath?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface SessionLifecycleDeps {
  readonly project: ProjectConfig;
  readonly store: Store;
  readonly sessions: SessionManager;
  readonly agents: AgentRuntimes;
  readonly turns: SessionTurns;
  readonly workspaces: SessionWorkspaces;
  readonly events: SessionEvents;
  readonly artifacts: ArtifactStore;
  readonly logger: Logger;
  /** Whether a session still has a wake-up pending; such a session is not archived. */
  readonly hasPendingJobs: (sessionId: string) => Promise<boolean>;
  /** Sessions may be created without a repository (the global project). */
  readonly allowWithoutRepository?: boolean | undefined;
}

/**
 * Creates, reads and ends the sessions of one project. Idle sessions are suspended and, later,
 * archived; see {@link SessionLifecycle.sweepIdle}.
 */
export class SessionLifecycle {
  private readonly closes = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionLifecycleDeps) {}

  async create(params: CreateSessionParams = {}): Promise<SessionRoute> {
    const { project, agents, store, events, logger } = this.deps;
    if (!project.repository && !this.deps.allowWithoutRepository) {
      throw new Error(`project ${project.id} has no repository`);
    }
    const settings = agents.settingsFor(params.runtime);
    const sessionId = `ses_${randomUUID()}`;
    const workspacePath = params.workspacePath ?? (await this.deps.workspaces.create(sessionId));
    const runtimeSessionId = await agents.start(sessionId, workspacePath, settings, params.owner);
    const agent = {
      runtime: settings.runtime.name,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    };
    const route: SessionRoute = {
      sessionId,
      ...(params.title ? { title: params.title } : {}),
      projectId: project.id,
      projectRuntimeId: `project-runtime:${project.id}`,
      runtimeSessionId,
      ...agent,
      workspacePath,
      configRevision: project.revision ?? 1,
      status: "active",
      source: params.source ?? "api",
      ...(params.owner ? { owner: params.owner } : {}),
      lastActiveAt: new Date().toISOString(),
      metadata: {
        ...(params.metadata ?? {}),
        ...(params.title ? { title: params.title } : {}),
        ...agent,
      },
    };
    await store.createSession(route);
    this.deps.sessions.loadOrCreate(route);
    await events.emit(route, "session.started", "gateway", {
      runtimeSessionId,
      workspacePath,
      ...agent,
    });
    logger.info("session created", {
      projectId: project.id,
      sessionId,
      runtimeSessionId,
      ...agent,
    });
    return route;
  }

  async get(sessionId: string): Promise<SessionRoute> {
    return (await this.entity(sessionId)).toRoute();
  }

  /** Renames a session at the user's request. */
  async rename(sessionId: string, title: string): Promise<void> {
    const cleanTitle = title.trim().slice(0, 255);
    if (!(await this.deps.store.updateSessionTitle(sessionId, cleanTitle))) {
      throw new NotFoundError(`Session ${sessionId} not found`, ErrorCode.SESSION_NOT_FOUND);
    }
    await this.titleChanged(sessionId, cleanTitle);
  }

  /** Sets an automatically generated title unless the session got one in the meantime. */
  async setGeneratedTitle(sessionId: string, title: string): Promise<void> {
    if (await this.deps.store.setTitleIfEmpty(sessionId, title)) {
      await this.titleChanged(sessionId, title);
    }
  }

  async bindExternal(
    sessionId: string,
    external: { channel: string; conversationId: string; threadId?: string },
  ): Promise<SessionRoute> {
    const entity = await this.entity(sessionId);
    entity.bindExternal(external);
    await entity.flush(this.deps.store);
    return entity.toRoute();
  }

  async events(sessionId: string, after = 0): Promise<EventRecord[]> {
    await this.entity(sessionId);
    return this.deps.events.list(sessionId, after);
  }

  /**
   * Artifacts a session produced. Internal ones (`agent-message`, the agent's own message log)
   * are left out unless `includeInternal` is set.
   */
  async artifacts(
    sessionId: string,
    options: { includeInternal?: boolean } = {},
  ): Promise<ArtifactRecord[]> {
    await this.entity(sessionId);
    const artifacts = await this.deps.store.listArtifacts({ kind: "session", id: sessionId });
    return options.includeInternal
      ? artifacts
      : artifacts.filter((artifact) => artifact.kind !== "agent-message");
  }

  async artifact(sessionId: string, artifactId: string): Promise<ArtifactRecord> {
    const artifacts = await this.artifacts(sessionId, { includeInternal: true });
    const artifact = artifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      throw new NotFoundError(`artifact not found: ${artifactId}`, ErrorCode.ARTIFACT_NOT_FOUND);
    }
    return artifact;
  }

  readArtifact(artifact: ArtifactRecord): Promise<Uint8Array> {
    return this.deps.artifacts.read(artifact);
  }

  /**
   * Ends a session: stops its turns, releases it from the runtime and removes its worktree. The
   * session is deleted, or with `retain` kept as `closed`. Concurrent calls share one close.
   */
  close(sessionId: string, options: { retain?: boolean } = {}): Promise<void> {
    const pending = this.closes.get(sessionId);
    if (pending) return pending;
    const close = this.runClose(sessionId, options.retain ?? false).finally(() =>
      this.closes.delete(sessionId),
    );
    this.closes.set(sessionId, close);
    return close;
  }

  /**
   * Makes a session read-only: stops its turns and releases it from the runtime, keeping its
   * worktree, which a pipeline run shares between its sessions.
   */
  async archive(sessionId: string, reason: string): Promise<void> {
    const { store, turns, events, logger } = this.deps;
    const existing = await store.getSession(sessionId);
    if (!existing) return;
    if (existing.status === "archived" || existing.status === "closed") {
      this.deps.agents.forget(sessionId);
      return;
    }
    await turns.quiesce(sessionId);
    const entity = await this.entity(sessionId);
    try {
      await this.release(entity.toRoute());
    } catch (error) {
      logger.warn("runtime releaseSession failed during archive", { sessionId, error });
    }
    await entity.transitionTo("archived");
    await entity.flush(store);
    await events.emit(entity.toRoute(), "session.archived", "gateway", { reason });
  }

  /**
   * Suspends sessions idle for `session.idleTimeoutMs` (30 min) and archives those idle for
   * `session.archiveTimeoutMs` (60 min), unless a wake-up is pending for them.
   */
  async sweepIdle(): Promise<void> {
    const { project, store } = this.deps;
    const idleTimeout = project.session?.idleTimeoutMs ?? 30 * 60_000;
    const archiveTimeout = project.session?.archiveTimeoutMs ?? 60 * 60_000;
    for (const stored of await store.listSessions(project.id)) {
      const sessionId = stored.sessionId;
      await this.deps.turns.maintain(sessionId, async () => {
        try {
          await this.sweep(sessionId, idleTimeout, archiveTimeout);
        } catch (error) {
          this.deps.logger.warn("session lifecycle transition failed", { sessionId, error });
        }
      });
    }
  }

  /**
   * Cleans up what a previous process left behind: closes it started but never completed, and
   * task sessions it was running when it stopped.
   */
  async reconcile(): Promise<void> {
    const { project, store, logger } = this.deps;
    const sessions = await store.listSessions(project.id, {
      includeTasks: true,
      includePipelines: true,
    });
    for (const session of sessions) {
      const abandonedTask =
        session.source === "task" && session.status !== "closed" && session.status !== "archived";
      if (session.status !== "closing" && !abandonedTask) continue;
      logger.info("cleaning up session left over from a previous run", {
        projectId: project.id,
        sessionId: session.sessionId,
      });
      await this.close(session.sessionId, { retain: true });
    }
  }

  private async sweep(sessionId: string, idleTimeout: number, archiveTimeout: number) {
    const entity = await this.entity(sessionId);
    if (entity.status === "archived" || entity.status === "closing") return;
    const idle = Date.now() - Date.parse(entity.lastActiveAt);
    const suspend = entity.status === "active" && idle >= idleTimeout;
    let archive = idle >= archiveTimeout;
    if (archive && (await this.deps.hasPendingJobs(sessionId))) {
      archive = false;
      this.deps.logger.info("session archive deferred for pending scheduled job", {
        sessionId,
        idleDurationMs: idle,
      });
    }
    if (!archive && !suspend) return;
    await this.release(entity.toRoute());
    if (archive) await this.deps.workspaces.remove(sessionId);
    await entity.transitionTo(archive ? "archived" : "suspended");
    await entity.flush(this.deps.store);
    await this.deps.events.emit(
      entity.toRoute(),
      archive ? "session.archived" : "session.suspended",
      "gateway",
      { idleDurationMs: idle },
    );
  }

  private async runClose(sessionId: string, retain: boolean): Promise<void> {
    const { store, turns, events, logger } = this.deps;
    let entity: SessionEntity | undefined;
    try {
      entity = await this.entity(sessionId);
      await entity.transitionTo("closing");
      await entity.flush(store);
    } catch (error) {
      logger.warn("failed to transition session to closing", { sessionId, error });
    }
    await turns.quiesce(sessionId);
    const route = entity?.toRoute() ?? (await store.getSession(sessionId));
    if (route) {
      try {
        await this.release(route);
      } catch (error) {
        logger.warn("runtime releaseSession failed during close", { sessionId, error });
      }
    }
    try {
      await this.deps.workspaces.remove(sessionId);
    } catch (error) {
      logger.warn("workspaces removeSession failed during close", { sessionId, error });
    }
    if (route) await events.emit(route, "session.closed", "gateway", {});

    if (retain) {
      try {
        if (entity) {
          await entity.transitionTo("closed");
          await entity.flush(store);
        } else if (route) {
          await store.updateSession({ ...route, status: "closed" });
        }
      } catch (error) {
        logger.warn("failed to transition session to closed", { sessionId, error });
      }
    } else {
      await store.deleteSession(sessionId);
    }

    await this.deps.sessions.remove(sessionId);
    events.forget(sessionId);
    logger.info("session cleaned up", {
      projectId: this.deps.project.id,
      sessionId,
      retained: retain,
    });
  }

  private release(route: SessionRoute): Promise<void> {
    return this.deps.agents.release(route, this.deps.workspaces.path(route));
  }

  private async titleChanged(sessionId: string, title: string): Promise<void> {
    this.deps.sessions.get(sessionId)?.setTitle(title);
    const route = await this.deps.store.getSession(sessionId);
    if (route) await this.deps.events.emit(route, "session.renamed", "gateway", { title });
    this.deps.logger.info("session renamed", { sessionId, title });
  }

  private entity(sessionId: string): Promise<SessionEntity> {
    return this.deps.sessions.getOwned(sessionId, this.deps.project.id);
  }
}
