import { ErrorCode, NotFoundError } from "../domain/errors.ts";
import type { SessionRoute } from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import { SessionEntity } from "./entity.ts";
import {
  PersistenceCheckpointHook,
  type SessionLifecycleHook,
  type SessionObserver,
} from "./hooks.ts";
import { Logger } from "../observability/logger.ts";

export class SessionManager {
  private readonly entities = new Map<string, SessionEntity>();
  private readonly loading = new Map<string, Promise<SessionEntity | null>>();
  private readonly hooks = new Set<SessionLifecycleHook>();
  private readonly observers = new Set<SessionObserver>();
  constructor(
    private readonly store: Store,
    private readonly logger = new Logger(),
  ) {
    this.registerHook(new PersistenceCheckpointHook(store));
  }
  registerHook(hook: SessionLifecycleHook): () => void {
    this.hooks.add(hook);
    return () => {
      this.hooks.delete(hook);
    };
  }
  observe(observer: SessionObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  async notifyObservers(event: Parameters<SessionObserver>[0]): Promise<void> {
    for (const observer of this.observers) {
      try {
        await observer(event);
      } catch (error) {
        this.logger.warn("session observer failed", { sessionId: event.session.id, error });
      }
    }
  }
  get(sessionId: string): SessionEntity | undefined {
    return this.entities.get(sessionId);
  }
  loadOrCreate(route: SessionRoute): SessionEntity {
    const existing = this.entities.get(route.sessionId);
    if (existing) return existing;
    const entity = new SessionEntity(route, [], this.logger);
    // Invoke the current global hook set, including hooks registered after creation.
    entity.addHook({
      onStateChanged: async (session, from, to) => {
        await this.invoke((h) => h.onStateChanged?.(session, from, to));
        await this.notifyObservers({ type: "state.changed", session, from, to });
      },
      onTurnStarted: async (session, turnId, input) => {
        await this.invoke((h) => h.onTurnStarted?.(session, turnId, input));
        await this.notifyObservers({ type: "turn.started", session, turnId, input });
      },
      onTurnCompleted: async (session, turnId, status) => {
        await this.invoke((h) => h.onTurnCompleted?.(session, turnId, status));
        await this.notifyObservers({ type: "turn.completed", session, turnId, status });
      },
      onCursorAck: (session, source, sequence) => {
        void this.invoke((h) => h.onCursorAck?.(session, source, sequence));
        void this.notifyObservers({ type: "cursor.advanced", session, source, sequence });
      },
      onDestroyed: async (session) => {
        await this.invoke((h) => h.onDestroyed?.(session));
        await this.notifyObservers({ type: "destroyed", session });
      },
    });
    this.entities.set(route.sessionId, entity);
    return entity;
  }
  private async invoke(call: (hook: SessionLifecycleHook) => unknown): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await call(hook);
      } catch (error) {
        this.logger.warn("session hook failed", { error });
      }
    }
  }
  async getOrLoad(id: string): Promise<SessionEntity | null> {
    const existing = this.get(id);
    if (existing) return existing;
    const pending = this.loading.get(id);
    if (pending) return pending;
    const task = this.store
      .getSession(id)
      .then((route) => (route ? this.loadOrCreate(route) : null));
    this.loading.set(id, task);
    try {
      return await task;
    } finally {
      this.loading.delete(id);
    }
  }
  /** The session, which must belong to `projectId`. */
  async getOwned(id: string, projectId: string): Promise<SessionEntity> {
    const entity = await this.getOrLoad(id);
    if (!entity || entity.projectId !== projectId) {
      throw new NotFoundError(
        `session ${id} is not owned by project ${projectId}`,
        ErrorCode.SESSION_NOT_FOUND,
      );
    }
    return entity;
  }
  async remove(id: string): Promise<void> {
    const entity = this.entities.get(id);
    if (entity) await entity.notifyDestroyed();
    this.entities.delete(id);
  }
  async save(id: string): Promise<void> {
    await this.entities.get(id)?.flush(this.store);
  }
}
