import type { PipelineStreamEvent } from "./types.ts";

export type PipelineEventListener = (event: PipelineStreamEvent) => void;

/**
 * In-memory pub/sub hub for project-scoped pipeline SSE streams.
 */
export class PipelineEventHub {
  private readonly projectListeners = new Map<string, Set<PipelineEventListener>>();

  publish(event: PipelineStreamEvent): void {
    const listeners = this.projectListeners.get(event.projectId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber errors from engine transitions.
      }
    }
  }

  subscribe(projectId: string, listener: PipelineEventListener): () => void {
    let set = this.projectListeners.get(projectId);
    if (!set) {
      set = new Set();
      this.projectListeners.set(projectId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.projectListeners.delete(projectId);
      }
    };
  }

  async *stream(projectId: string, signal?: AbortSignal): AsyncIterable<PipelineStreamEvent> {
    if (signal?.aborted) return;
    const queue: PipelineStreamEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;

    const wake = () => {
      const fn = notify;
      notify = null;
      fn?.();
    };

    const unsubscribe = this.subscribe(projectId, (event) => {
      queue.push(event);
      wake();
    });

    const onAbort = () => {
      done = true;
      wake();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!done) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }
        while (queue.length > 0 && !done) {
          yield queue.shift()!;
        }
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
