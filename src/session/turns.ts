import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../artifacts/store.ts";
import {
  ConflictError,
  ErrorCode,
  ServiceUnavailableError,
  TooManyRequestsError,
  ValidationError,
} from "../domain/errors.ts";
import type { EventRecord, ProjectConfig, SessionRoute, TurnRecord } from "../domain/types.ts";
import type { NotificationOutbox } from "../notifications/index.ts";
import type { Logger } from "../observability/logger.ts";
import {
  captureTraceContext,
  detached,
  withSpan,
  withTraceContext,
  type Context,
} from "../observability/tracing.ts";
import type { Store } from "../persistence/store.ts";
import type { ApprovalDecision, RuntimeEvent } from "../runtime/runtime.ts";
import { isTurnUsage } from "../runtime/usage.ts";
import type { AgentRuntimes } from "./agents.ts";
import type { SessionEntity } from "./entity.ts";
import type { SessionEvents } from "./events.ts";
import type { SessionManager } from "./manager.ts";
import { TurnTrace, type TurnOutcome } from "./turn-trace.ts";
import type { SessionWorkspaces } from "./workspaces.ts";

/** A turn that has finished, as reported to `onTurnFinished`. */
export interface TurnFinished {
  readonly session: SessionRoute;
  readonly turnId: string;
  readonly status: TurnOutcome;
  /** The agent's last message in the turn. */
  readonly output?: string | undefined;
  readonly error?: string | undefined;
}

export interface SessionTurnsDeps {
  readonly project: ProjectConfig;
  readonly store: Store;
  readonly sessions: SessionManager;
  readonly agents: AgentRuntimes;
  readonly workspaces: SessionWorkspaces;
  readonly events: SessionEvents;
  readonly artifacts: ArtifactStore;
  readonly notifications: NotificationOutbox;
  readonly logger: Logger;
  /** How many turns a session may have waiting; 64 by default. */
  readonly queueLimit?: number | undefined;
  /** How long interrupting a turn or stopping a session may take; 10s by default. */
  readonly controlTimeoutMs?: number | undefined;
  /**
   * Called once a turn has settled, without waiting. A reaction may queue another turn on the
   * session or close it, and both wait for the session to become idle.
   */
  readonly onTurnFinished?: ((finished: TurnFinished) => void) | undefined;
}

interface QueuedTurn {
  readonly turn: TurnRecord;
  /** Trace of whoever queued the turn; the turn's span continues it. */
  readonly traceContext: Context;
}

interface ActiveTurn {
  readonly turn: TurnRecord;
  readonly trace: TurnTrace;
  /** The runtime's ID for the turn, once it has started there. */
  runtimeId?: string;
  /** Until the runtime has accepted the turn, its events wait in `early`. */
  starting: boolean;
  readonly early: RuntimeEvent[];
  canceled: boolean;
  settled: boolean;
  output?: string;
  readonly completed: Promise<void>;
  readonly resolve: () => void;
}

/** What is going on in one session in this process. A session with nothing going on has none. */
class SessionSlot {
  readonly queue: QueuedTurn[] = [];
  active: ActiveTurn | undefined;
  /** Runs the queued turns one after another. */
  pump: Promise<void> | undefined;
  /** Serializes the checks and writes that admit a turn. */
  admission: Promise<unknown> | undefined;
  /** Serializes the handling of the runtime's events. */
  runtimeEvents: Promise<void> | undefined;
  /** Idle housekeeping (suspend, archive) is under way; new turns are refused. */
  maintenance = false;

  get busy(): boolean {
    return Boolean(
      this.active || this.queue.length || this.pump || this.admission || this.maintenance,
    );
  }

  get idle(): boolean {
    return !this.busy && !this.runtimeEvents;
  }
}

/**
 * Runs the turns of one project's sessions: each session's turns run one at a time in the order
 * they were queued, on the agent runtime the session is bound to.
 */
export class SessionTurns {
  private readonly slots = new Map<string, SessionSlot>();
  private stopping = false;

  constructor(private readonly deps: SessionTurnsDeps) {}

  /** Queues a turn. `turnId` lets a caller record the turn before it can start. */
  submit(sessionId: string, input: string, options: { turnId?: string } = {}): Promise<TurnRecord> {
    const turnId = options.turnId ?? `turn_${randomUUID()}`;
    return this.admit(sessionId, async (slot) => {
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
      if (slot.maintenance) {
        throw new ServiceUnavailableError("session maintenance in progress; retry the message");
      }
      if (!input.trim()) throw new ValidationError("input is required");
      if (slot.queue.length >= (this.deps.queueLimit ?? 64)) {
        throw new TooManyRequestsError("session queue is full", ErrorCode.QUEUE_FULL);
      }
      entity.touch();
      if (entity.status !== "suspended") await entity.transitionTo("active");
      await entity.flush(this.deps.store);
      const turn: TurnRecord = {
        id: turnId,
        sessionId,
        input,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.createTurn(turn);
      await this.deps.events.emit(entity.toRoute(), "turn.queued", "gateway", {
        turnId: turn.id,
        input,
      });
      slot.queue.push({ turn, traceContext: captureTraceContext() });
      this.startPump(sessionId, slot);
      return turn;
    });
  }

  async steer(sessionId: string, input: string): Promise<void> {
    const route = await this.route(sessionId);
    const active = this.slots.get(sessionId)?.active;
    if (!active?.runtimeId || active.settled) throw new ConflictError("no active turn");
    const { runtime, context } = this.runtimeFor(route);
    await runtime.steerTurn(context, route.runtimeSessionId ?? "", active.runtimeId, input);
  }

  /**
   * Interrupts the running turn, or the given one, and waits for it to stop. A turn that is still
   * queued is dropped instead.
   */
  async interrupt(sessionId: string, turnId?: string): Promise<void> {
    await this.slots.get(sessionId)?.admission?.catch(() => {});
    const route = await this.route(sessionId);
    const slot = this.slots.get(sessionId);
    if (turnId && slot?.queue.some(({ turn }) => turn.id === turnId)) {
      await this.cancelQueued(sessionId, turnId);
      return;
    }
    const active = slot?.active;
    if (!active || active.settled || (turnId && active.turn.id !== turnId)) return;
    if (!active.canceled) {
      active.canceled = true;
      if (active.runtimeId) {
        const { runtime, context } = this.runtimeFor(route);
        await runtime.interruptTurn(context, route.runtimeSessionId ?? "", active.runtimeId);
      }
    }
    await this.bounded(active.completed, "turn interrupt timed out");
  }

  async compact(sessionId: string): Promise<void> {
    const route = await this.route(sessionId);
    const active = this.slots.get(sessionId)?.active;
    if (active && !active.settled) {
      throw new ConflictError("cannot compact while a turn is running");
    }
    const { runtime, context } = this.runtimeFor(route);
    await runtime.compactSession(context, route.runtimeSessionId ?? "");
  }

  async approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const route = await this.route(sessionId);
    const { runtime, context } = this.runtimeFor(route);
    await runtime.respondToApproval(context, requestId, decision);
    await this.deps.events.emit(route, "approval.resolved", "gateway", { requestId, decision });
  }

  /** Waits until the turns queued so far have run. */
  async waitForIdle(sessionId: string): Promise<void> {
    await this.slots.get(sessionId)?.admission?.catch(() => {});
    await this.slots.get(sessionId)?.pump;
  }

  /** The turn running in a session, if any. */
  activeTurn(sessionId: string): { turnId: string; traceContext: Context } | undefined {
    const active = this.slots.get(sessionId)?.active;
    return active ? { turnId: active.turn.id, traceContext: active.trace.context } : undefined;
  }

  /** Whether a session has a turn running or waiting, or is being admitted or maintained. */
  isBusy(sessionId: string): boolean {
    return this.slots.get(sessionId)?.busy ?? false;
  }

  /**
   * Runs idle housekeeping on a session, refusing new turns meanwhile. Does nothing when the
   * session is busy.
   */
  async maintain(sessionId: string, operation: () => Promise<void>): Promise<void> {
    if (this.isBusy(sessionId)) return;
    const slot = this.slot(sessionId);
    slot.maintenance = true;
    try {
      await operation();
    } finally {
      slot.maintenance = false;
      this.release(sessionId);
    }
  }

  /**
   * Stops everything going on in a session: drops its queued turns and interrupts the running one.
   * A runtime that does not confirm in time must not block, so the turn is then settled as
   * interrupted on our side.
   */
  async quiesce(sessionId: string): Promise<void> {
    await this.slots.get(sessionId)?.admission?.catch(() => {});
    await this.cancelQueued(sessionId);
    const active = this.slots.get(sessionId)?.active;
    if (active) {
      try {
        await this.interrupt(sessionId);
      } catch (error) {
        this.deps.logger.warn("turn did not stop in time; settling it as interrupted", {
          sessionId,
          turnId: active.turn.id,
          error,
        });
        await this.finishTurn(sessionId, active, "interrupted", "interrupt timed out");
      }
    }
    const pump = this.slots.get(sessionId)?.pump;
    if (!pump) return;
    try {
      await this.bounded(pump, "session did not stop in time");
    } catch (error) {
      this.deps.logger.warn("session did not stop in time", { sessionId, error });
    }
  }

  /** Handles an event the agent runtime reports for a session. */
  async handleRuntimeEvent(sessionId: string, event: RuntimeEvent): Promise<void> {
    const slot = this.slot(sessionId);
    const active = slot.active;
    if (active?.starting) {
      active.early.push(event);
      return;
    }
    // Runtimes call back from their own context; handle the event inside the turn's trace.
    const traceContext = active?.trace.context;
    const handle = (): Promise<void> =>
      traceContext
        ? withTraceContext(traceContext, () => this.processRuntimeEvent(sessionId, event))
        : this.processRuntimeEvent(sessionId, event);
    const task = (slot.runtimeEvents ?? Promise.resolve()).catch(() => {}).then(handle);
    slot.runtimeEvents = task;
    try {
      await task;
    } catch (error) {
      this.deps.logger.error("runtime event processing failed", { sessionId, error });
      if (active && !active.settled)
        await this.finishTurn(sessionId, active, "failed", String(error));
    } finally {
      if (slot.runtimeEvents === task) {
        slot.runtimeEvents = undefined;
        this.release(sessionId);
      }
    }
  }

  /** Refuses new turns from now on; sessions finish the turn they are running. */
  stopAccepting(): void {
    this.stopping = true;
  }

  /** Drops the queued turns, stops the agent runtimes and fails the turns still running. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.slots.values()].map((slot) => slot.admission));
    for (const id of [...this.slots.keys()]) await this.cancelQueued(id);
    await this.deps.agents.stop();
    for (const [id, slot] of [...this.slots]) {
      if (slot.active) await this.finishTurn(id, slot.active, "failed", "runtime stopped");
    }
    await Promise.allSettled([...this.slots.values()].map((slot) => slot.pump));
  }

  private slot(sessionId: string): SessionSlot {
    let slot = this.slots.get(sessionId);
    if (!slot) {
      slot = new SessionSlot();
      this.slots.set(sessionId, slot);
    }
    return slot;
  }

  /** Forgets a session's slot once nothing is going on in it. */
  private release(sessionId: string): void {
    if (this.slots.get(sessionId)?.idle) this.slots.delete(sessionId);
  }

  private async admit<T>(
    sessionId: string,
    operation: (slot: SessionSlot) => Promise<T>,
  ): Promise<T> {
    const slot = this.slot(sessionId);
    const next = (slot.admission ?? Promise.resolve()).catch(() => {}).then(() => operation(slot));
    slot.admission = next;
    try {
      return await next;
    } finally {
      if (slot.admission === next) {
        slot.admission = undefined;
        this.release(sessionId);
      }
    }
  }

  private startPump(sessionId: string, slot: SessionSlot): void {
    if (slot.pump) return;
    // Each turn continues the trace it was queued from, not the one that started the pump.
    const pump = detached(() => this.pump(sessionId, slot)).catch((error) =>
      this.deps.logger.error("session pump failed", { sessionId, error }),
    );
    slot.pump = pump;
    void pump.finally(() => {
      slot.pump = undefined;
      if (slot.queue.length && !this.stopping) this.startPump(sessionId, slot);
      else this.release(sessionId);
    });
  }

  private async pump(sessionId: string, slot: SessionSlot): Promise<void> {
    while (!this.stopping) {
      const queued = slot.queue.shift();
      if (!queued) return;
      const { turn } = queued;
      const entity = await this.entity(sessionId);
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
          projectId: this.deps.project.id,
          sessionId,
          turnId: turn.id,
          source: route.source,
        }),
        starting: true,
        early: [],
        canceled: false,
        settled: false,
        completed,
        resolve,
      };
      slot.active = active;
      await withTraceContext(active.trace.context, async () => {
        try {
          await this.runTurn(route, active);
        } catch (error) {
          await this.finishTurn(sessionId, active, "failed", String(error));
        }
      });
      await completed;
    }
  }

  private async runTurn(route: SessionRoute, active: ActiveTurn): Promise<void> {
    const { store, events } = this.deps;
    const sessionId = route.sessionId;
    const { turn } = active;
    const entity = await this.entity(sessionId);
    const workspacePath = await withSpan("workspace.prepare", {}, () =>
      this.deps.workspaces.prepare(route),
    );
    const { runtimeSessionId, runtime, context } = await withSpan("runtime.bind_session", {}, () =>
      this.deps.agents.bind(entity, workspacePath),
    );
    active.trace.bindRuntime(runtime.type, context.project.runtime?.model);
    if (entity.status !== "closing") await entity.transitionTo("active");
    entity.touch();
    await entity.flush(store);
    if (active.canceled || entity.status === "closing") {
      await this.finishTurn(sessionId, active, "interrupted");
      return;
    }
    await store.updateTurn(turn.id, { status: "in_progress", startedAt: new Date().toISOString() });
    await entity.notifyTurnStarted(turn.id, turn.input);
    await events.emit(entity.toRoute(), "turn.started", runtime.type, { turnId: turn.id });
    const runtimeTurn = await runtime.startTurn(context, runtimeSessionId, turn.id, turn.input);
    active.runtimeId = runtimeTurn.id;
    await store.updateTurn(turn.id, { runtimeTurnId: runtimeTurn.id });
    for (let event = active.early.shift(); event; event = active.early.shift()) {
      await this.processRuntimeEvent(sessionId, event);
    }
    active.starting = false;
    if (active.canceled && !active.settled) {
      await runtime.interruptTurn(context, runtimeSessionId, runtimeTurn.id);
    }
    await active.completed;
  }

  private async processRuntimeEvent(sessionId: string, event: RuntimeEvent): Promise<void> {
    const entity = this.deps.sessions.get(sessionId);
    if (!entity) return;
    const active = this.slots.get(sessionId)?.active;
    // Session lifecycle events are ours to emit; see the contract on AgentRuntime.
    if (event.type.startsWith("session.")) return;
    if (event.type === "runtime.disconnected") {
      this.deps.agents.forget(sessionId);
      if (active) await this.finishTurn(sessionId, active, "failed", "agent runtime exited");
      return;
    }
    if (
      event.turnId &&
      (!active || (event.turnId !== active.runtimeId && event.turnId !== active.turn.id))
    ) {
      return;
    }
    if (event.type === "turn.started") return;
    active?.trace.record(event);
    const outcome = turnOutcome(event.type);
    if (active && outcome) {
      // The runtime's reason for a failed turn is the turn's error.
      const error = event.type === "turn.failed" ? event.payload.error : undefined;
      await this.finishTurn(sessionId, active, outcome, error, event);
      return;
    }
    if (active && event.type === "agent.message.completed" && event.payload.text) {
      const text = event.payload.text;
      active.output = text;
      await this.deps.store.updateTurn(active.turn.id, { output: text });
      await this.deps.artifacts.write(
        entity.projectId,
        { kind: "session", id: sessionId },
        active.turn.id,
        "agent-message",
        text,
        "text/plain; charset=utf-8",
      );
    }
    const route = entity.toRoute();
    await this.deps.events.emit(
      route,
      event.type as EventRecord["type"],
      this.deps.agents.runtimeFor(route).type,
      {
        ...event.payload,
        ...(active ? { turnId: active.turn.id } : {}),
        runtimeSessionId: event.sessionId,
        runtimeTurnId: event.turnId,
      },
    );
  }

  /** Settles a turn: records how it ended, announces it and reports it to `onTurnFinished`. */
  private async finishTurn(
    sessionId: string,
    active: ActiveTurn,
    status: TurnOutcome,
    error?: string,
    event?: RuntimeEvent,
  ): Promise<void> {
    if (active.settled) return;
    active.settled = true;
    let finished: TurnFinished | undefined;
    try {
      const { store, events } = this.deps;
      const entity = await this.entity(sessionId);
      const usage = usageOf(event);
      active.trace.finish(status, usage, error);
      await store.updateTurn(active.turn.id, {
        status,
        finishedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
        ...(usage ? { usage } : {}),
      });
      entity.touch();
      await entity.flush(store);
      const route = entity.toRoute();
      await events.emit(route, `turn.${status}`, this.deps.agents.runtimeFor(route).type, {
        ...((event?.payload ?? {}) as Record<string, unknown>),
        turnId: active.turn.id,
        runtimeTurnId: active.runtimeId,
        ...(error ? { error } : {}),
      });
      await entity.notifyTurnCompleted(active.turn.id, status);
      await this.notifyFinished(entity, active.turn.id, status);
      finished = {
        session: route,
        turnId: active.turn.id,
        status,
        ...(active.output !== undefined ? { output: active.output } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    } finally {
      const slot = this.slots.get(sessionId);
      if (slot?.active === active) slot.active = undefined;
      active.resolve();
    }
    if (finished && !this.stopping) this.deps.onTurnFinished?.(finished);
  }

  /** Sends the project's turn notification, when the project asks for one. */
  private async notifyFinished(
    entity: SessionEntity,
    turnId: string,
    status: TurnOutcome,
  ): Promise<void> {
    const { project, events, notifications } = this.deps;
    if (!project.notifyOnTurnCompleted) return;
    await notifications.queue(
      entity.projectId,
      { kind: "session", id: entity.id },
      project.notifications,
      {
        title: `Turn ${status}`,
        text: `Session ${entity.id} finished with status ${status}.`,
        metadata: { projectId: project.id, sessionId: entity.id, turnId },
      },
    );
    await events.emit(entity.toRoute(), "notification.queued", "notification", {
      kind: status,
      turnId,
    });
  }

  private async finishQueued(route: SessionRoute, turn: TurnRecord): Promise<void> {
    await this.deps.store.updateTurn(turn.id, {
      status: "interrupted",
      finishedAt: new Date().toISOString(),
    });
    await this.deps.events.emit(route, "turn.interrupted", "gateway", {
      turnId: turn.id,
      reason: "canceled_before_start",
    });
  }

  /** Drops a session's queued turns, or only `turnId`. */
  private async cancelQueued(sessionId: string, turnId?: string): Promise<void> {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    const canceled = slot.queue.filter(({ turn }) => !turnId || turn.id === turnId);
    if (!canceled.length) return;
    const kept = slot.queue.filter((queued) => !canceled.includes(queued));
    slot.queue.splice(0, slot.queue.length, ...kept);
    const route = await this.deps.store.getSession(sessionId);
    if (!route) return;
    for (const { turn } of canceled) await this.finishQueued(route, turn);
  }

  private runtimeFor(route: SessionRoute) {
    return this.deps.agents.forRoute(route, this.deps.workspaces.path(route));
  }

  private entity(sessionId: string): Promise<SessionEntity> {
    return this.deps.sessions.getOwned(sessionId, this.deps.project.id);
  }

  private async route(sessionId: string): Promise<SessionRoute> {
    return (await this.entity(sessionId)).toRoute();
  }

  private async bounded(task: Promise<unknown>, message: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(message)),
            this.deps.controlTimeoutMs ?? 10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function turnOutcome(type: string): TurnOutcome | undefined {
  switch (type) {
    case "turn.completed":
      return "completed";
    case "turn.failed":
      return "failed";
    case "turn.interrupted":
      return "interrupted";
    default:
      return undefined;
  }
}

function usageOf(event: RuntimeEvent | undefined) {
  const payload = event?.payload;
  const usage =
    payload && typeof payload === "object" && "usage" in payload
      ? (payload as { usage?: unknown }).usage
      : undefined;
  return isTurnUsage(usage) ? usage : undefined;
}
