import { EventEmitter } from "node:events";
import type { EventRecord } from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import type { SessionManager } from "../session/manager.ts";

export type EventCallback = (event: EventRecord) => void;
export type Unsubscribe = () => void;

export interface StreamOptions {
  after?: number;
  source?: string;
  signal?: AbortSignal;
  onAck?: (sequence: number) => void;
}

export interface EventHub {
  publish(event: EventRecord): void;
  subscribeSession(sessionId: string, callback: EventCallback): Unsubscribe;
  subscribeProject(projectId: string, callback: EventCallback): Unsubscribe;
  subscribeAll(callback: EventCallback): Unsubscribe;
  stream(sessionId: string, options?: StreamOptions): AsyncIterable<EventRecord>;
}

export class MemoryEventHub implements EventHub {
  private readonly emitter = new EventEmitter();
  private readonly streamControllers = new Map<string, Set<AbortController>>();
  private readonly closedSessions = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly sessionManager?: SessionManager,
  ) {
    this.emitter.setMaxListeners(0);
    this.sessionManager?.observe(async (event) => {
      if (event.type === "destroyed") this.closeSession(event.session.sessionId);
    });
  }

  private closeSession(sessionId: string): void {
    this.closedSessions.add(sessionId);
    for (const controller of this.streamControllers.get(sessionId) ?? []) controller.abort();
    this.streamControllers.delete(sessionId);
    this.emitter.removeAllListeners(`session:${sessionId}`);
  }

  publish(event: EventRecord): void {
    this.emitter.emit(`session:${event.sessionId}`, event);
    this.emitter.emit(`project:${event.projectId}`, event);
    this.emitter.emit("*", event);
  }

  subscribeSession(sessionId: string, callback: EventCallback): Unsubscribe {
    const channel = `session:${sessionId}`;
    this.emitter.on(channel, callback);
    return () => {
      this.emitter.off(channel, callback);
    };
  }

  subscribeProject(projectId: string, callback: EventCallback): Unsubscribe {
    const channel = `project:${projectId}`;
    this.emitter.on(channel, callback);
    return () => {
      this.emitter.off(channel, callback);
    };
  }

  subscribeAll(callback: EventCallback): Unsubscribe {
    const channel = "*";
    this.emitter.on(channel, callback);
    return () => {
      this.emitter.off(channel, callback);
    };
  }

  async *stream(sessionId: string, options: StreamOptions = {}): AsyncIterable<EventRecord> {
    const { after, source = "default", signal, onAck } = options;
    if (signal?.aborted || this.closedSessions.has(sessionId)) return;

    const controller = new AbortController();
    const controllers = this.streamControllers.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.streamControllers.set(sessionId, controllers);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    let highestSequence: number;
    if (after !== undefined) {
      // Explicit parameter takes precedence: fetch from sequence offset
      highestSequence = Math.max(0, after);
    } else {
      // Default to reading the latest consumed cursor for this source in the session
      const sessionEntity = this.sessionManager?.get(sessionId);
      if (sessionEntity) {
        highestSequence = sessionEntity.getCursor(source);
      } else {
        const stored = await this.store.getSession(sessionId);
        highestSequence = stored?.cursors?.[source] ?? 0;
      }
    }

    const realtimeBuffer: EventRecord[] = [];
    let resolveWait: (() => void) | null = null;

    // 1. Subscribe to realtime events first to prevent race condition window
    const unsubscribe = this.subscribeSession(sessionId, (event) => {
      realtimeBuffer.push(event);
      if (resolveWait) {
        const resolve = resolveWait;
        resolveWait = null;
        resolve();
      }
    });

    const onAbort = () => {
      if (resolveWait) {
        const resolve = resolveWait;
        resolveWait = null;
        resolve();
      }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });

    const emitEvent = (event: EventRecord): EventRecord => {
      highestSequence = event.sequence;
      // Advance in-memory cursor upon successful delivery (zero I/O overhead)
      if (this.sessionManager) {
        const sessionEntity = this.sessionManager.get(sessionId);
        sessionEntity?.ack(source, event.sequence);
      }
      onAck?.(event.sequence);
      return event;
    };

    try {
      // 2. Query historical events from store
      const historical = await this.store.listEvents(sessionId, highestSequence);
      for (const event of historical) {
        if (controller.signal.aborted) return;
        if (event.sequence > highestSequence) {
          yield emitEvent(event);
        }
      }

      // 3. Process realtime events and stream them
      while (!controller.signal.aborted) {
        while (realtimeBuffer.length > 0) {
          if (controller.signal.aborted) return;
          const event = realtimeBuffer.shift()!;
          if (event.sequence > highestSequence) {
            yield emitEvent(event);
          }
        }

        if (controller.signal.aborted) return;

        // Wait until new event is buffered or aborted
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      controllers.delete(controller);
      if (controllers.size === 0) this.streamControllers.delete(sessionId);
    }
  }
}
