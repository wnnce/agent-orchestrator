import { describe, expect, it } from "bun:test";
import { MemoryEventHub } from "../src/events/hub.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { SessionManager } from "../src/session/manager.ts";
import type { EventRecord } from "../src/domain/types.ts";

function createEvent(
  sessionId: string,
  sequence: number,
  projectId = "test-project",
  type: EventRecord["type"] = "thought",
): EventRecord {
  return {
    id: `evt_${sequence}`,
    projectId,
    sessionId,
    sequence,
    type,
    runtime: "codex",
    payload: { seq: sequence },
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

describe("MemoryEventHub", () => {
  it("publishes and delivers events to session subscribers", () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);

    const receivedA: EventRecord[] = [];
    const receivedB: EventRecord[] = [];

    const unsubA = hub.subscribeSession("ses_1", (evt) => receivedA.push(evt));
    const unsubB = hub.subscribeSession("ses_2", (evt) => receivedB.push(evt));

    const evt1 = createEvent("ses_1", 1);
    const evt2 = createEvent("ses_2", 1);
    const evt3 = createEvent("ses_1", 2);

    hub.publish(evt1);
    hub.publish(evt2);
    hub.publish(evt3);

    expect(receivedA).toEqual([evt1, evt3]);
    expect(receivedB).toEqual([evt2]);

    // Test unsubscribe
    unsubA();
    hub.publish(createEvent("ses_1", 3));
    expect(receivedA.length).toBe(2);

    unsubB();
  });

  it("publishes to project subscribers and global subscribers", () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);

    const projectEvents: EventRecord[] = [];
    const allEvents: EventRecord[] = [];

    const unsubProject = hub.subscribeProject("project-alpha", (evt) => projectEvents.push(evt));
    const unsubAll = hub.subscribeAll((evt) => allEvents.push(evt));

    const evt1 = createEvent("ses_1", 1, "project-alpha");
    const evt2 = createEvent("ses_2", 1, "project-beta");

    hub.publish(evt1);
    hub.publish(evt2);

    expect(projectEvents).toEqual([evt1]);
    expect(allEvents).toEqual([evt1, evt2]);

    unsubProject();
    unsubAll();
  });

  it("streams historical and realtime events via AsyncIterable", async () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);

    // Seed historical events in store
    const hist1 = createEvent("ses_stream", 1);
    const hist2 = createEvent("ses_stream", 2);
    await store.appendEvent(hist1);
    await store.appendEvent(hist2);

    const ac = new AbortController();
    const streamed: EventRecord[] = [];

    const streamPromise = (async () => {
      for await (const evt of hub.stream("ses_stream", { after: 0, signal: ac.signal })) {
        streamed.push(evt);
        if (evt.sequence === 4) {
          ac.abort();
        }
      }
    })();

    // Allow generator to yield historical events and enter realtime wait
    await new Promise((r) => setTimeout(r, 50));

    // Publish realtime events
    const real3 = createEvent("ses_stream", 3);
    const real4 = createEvent("ses_stream", 4);
    hub.publish(real3);
    hub.publish(real4);

    await streamPromise;

    expect(streamed.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("deduplicates events if already emitted in history", async () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);

    const hist1 = createEvent("ses_dedup", 1);
    const hist2 = createEvent("ses_dedup", 2);
    await store.appendEvent(hist1);
    await store.appendEvent(hist2);

    const ac = new AbortController();
    const streamed: EventRecord[] = [];

    const streamPromise = (async () => {
      for await (const evt of hub.stream("ses_dedup", { after: 1, signal: ac.signal })) {
        streamed.push(evt);
        if (evt.sequence === 3) ac.abort();
      }
    })();

    await new Promise((r) => setTimeout(r, 20));

    // Publish event with sequence 2 (already in history) and sequence 3
    hub.publish(hist2);
    hub.publish(createEvent("ses_dedup", 3));

    await streamPromise;

    // Because after: 1 was requested, hist1 is skipped, hist2 is yielded once, real3 is yielded
    expect(streamed.map((e) => e.sequence)).toEqual([2, 3]);
  });

  it("streams only events published after a liveOnly stream starts", async () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);
    await store.appendEvent(createEvent("ses_live", 1));
    await store.appendEvent(createEvent("ses_live", 2));

    const iterator = hub.stream("ses_live", { liveOnly: true })[Symbol.asyncIterator]();
    const first = iterator.next();
    // Published synchronously after the first next(): the subscription must already be in place.
    hub.publish(createEvent("ses_live", 3));

    expect((await first).value?.sequence).toBe(3);
    await iterator.return?.();
  });

  it("aborts Session streams when SessionManager destroys the Session", async () => {
    const store = new MemoryStore();
    const manager = new SessionManager(store);
    const route = {
      sessionId: "ses_destroyed",
      projectId: "p",
      projectRuntimeId: "r",
      runtimeSessionId: null,
      configRevision: 1,
      status: "active" as const,
      lastActiveAt: new Date().toISOString(),
    };
    await store.createSession(route);
    manager.loadOrCreate(route);
    const hub = new MemoryEventHub(store, manager);
    const iterator = hub.stream(route.sessionId, { after: 0 })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.remove(route.sessionId);
    expect((await pending).done).toBe(true);
  });
});
