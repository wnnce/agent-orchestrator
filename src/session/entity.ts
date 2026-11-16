import type { SessionRoute, SessionStatus } from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import type { SessionLifecycleHook } from "./hooks.ts";
import { Logger } from "../observability/logger.ts";

/** The single mutable session state. Consumers receive detached snapshots. */
export class SessionEntity {
  private readonly route: SessionRoute;
  private readonly cursors = new Map<string, number>();
  private revision = 0;
  private savedRevision = 0;
  private saving: Promise<void> = Promise.resolve();
  private readonly hooks: SessionLifecycleHook[];

  constructor(
    route: SessionRoute,
    hooks: SessionLifecycleHook[] = [],
    private readonly logger = new Logger(),
  ) {
    this.route = structuredClone(route);
    for (const [source, sequence] of Object.entries(route.cursors ?? {})) {
      if (typeof sequence === "number") this.cursors.set(source, sequence);
    }
    this.hooks = [...hooks];
  }
  get id(): string {
    return this.route.sessionId;
  }
  get sessionId(): string {
    return this.id;
  }
  get projectId(): string {
    return this.route.projectId;
  }
  get status(): SessionStatus {
    return this.route.status;
  }
  get lastActiveAt(): string {
    return this.route.lastActiveAt;
  }
  addHook(hook: SessionLifecycleHook): () => void {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }
  getCursor(source = "default", explicitAfter?: number): number {
    if (explicitAfter !== undefined) return Math.max(0, explicitAfter);
    return this.cursors.get(source) ?? 0;
  }
  ack(source: string, sequence: number): void {
    if (sequence <= (this.cursors.get(source) ?? 0)) return;
    this.cursors.set(source, sequence);
    this.revision++;
    for (const hook of [...this.hooks]) {
      try {
        hook.onCursorAck?.(this, source, sequence);
      } catch (error) {
        this.logger.warn("session observer failed", { sessionId: this.id, error });
      }
    }
  }
  touch(at = new Date().toISOString()): void {
    this.route.lastActiveAt = at;
    this.revision++;
  }
  setTitle(title: string): void {
    this.route.title = title;
    this.revision++;
  }
  bindRuntime(id: string): void {
    this.route.runtimeSessionId = id;
    this.revision++;
  }
  bindExternal(ref: { channel: string; conversationId: string; threadId?: string }): void {
    this.route.externalChannel = ref.channel;
    this.route.externalConversationId = ref.conversationId;
    if (ref.threadId) this.route.externalThreadId = ref.threadId;
    else delete this.route.externalThreadId;
    this.revision++;
  }
  async transitionTo(status: SessionStatus): Promise<void> {
    const from = this.route.status;
    if (from === status) return;
    if (from === "archived" && status !== "closing")
      throw new Error(`session ${this.id} is archived and read-only`);
    if (from === "closing" && status !== "archived" && status !== "closed")
      throw new Error(`session ${this.id} is closing`);
    this.route.status = status;
    this.revision++;
    await this.notify((h) => h.onStateChanged?.(this, from, status));
  }
  async notifyTurnStarted(turnId: string, input: string): Promise<void> {
    await this.notify((h) => h.onTurnStarted?.(this, turnId, input));
  }
  async notifyTurnCompleted(
    turnId: string,
    status: "completed" | "failed" | "interrupted",
  ): Promise<void> {
    await this.notify((h) => h.onTurnCompleted?.(this, turnId, status));
  }
  async notifyDestroyed(): Promise<void> {
    await this.notify((h) => h.onDestroyed?.(this));
  }
  private async notify(call: (hook: SessionLifecycleHook) => unknown): Promise<void> {
    for (const hook of [...this.hooks]) {
      try {
        await call(hook);
      } catch (error) {
        this.logger.warn("session observer failed", { sessionId: this.id, error });
      }
    }
  }
  /** Saves are ordered; a concurrent mutation stays dirty until its own save. */
  async flush(store: Store): Promise<void> {
    const task = this.saving
      .catch(() => {})
      .then(async () => {
        if (this.revision === this.savedRevision) return;
        const revision = this.revision;
        await store.updateSession(this.toRoute());
        this.savedRevision = revision;
      });
    this.saving = task;
    await task;
  }
  toRoute(): SessionRoute {
    return structuredClone({ ...this.route, cursors: Object.fromEntries(this.cursors) });
  }
}
