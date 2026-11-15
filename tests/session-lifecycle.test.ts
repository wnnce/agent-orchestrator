import { describe, expect, it, test } from "bun:test";
import { SessionManager } from "../src/session/manager.ts";
import { MemoryStore, newSessionRoute } from "../src/persistence/store.ts";
import { MemoryEventHub } from "../src/events/hub.ts";
import { SessionEntity } from "../src/session/entity.ts";
import type { SessionRoute } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
const logger = new Logger({ sink: () => {} });

describe("single-owner session state", () => {
  test("snapshots cannot mutate the entity and stale load requests cannot replace state", async () => {
    const store = new MemoryStore();
    const route = newSessionRoute("test");
    await store.createSession(route);
    const manager = new SessionManager(store, logger);
    const entity = manager.loadOrCreate(route);
    entity.bindRuntime("new-thread");
    await entity.transitionTo("suspended");
    const snapshot = entity.toRoute();
    snapshot.status = "active";
    expect(manager.loadOrCreate({ ...route, runtimeSessionId: "old-thread" })).toBe(entity);
    await entity.flush(store);
    expect((await store.getSession(route.sessionId))?.runtimeSessionId).toBe("new-thread");
    expect((await store.getSession(route.sessionId))?.status).toBe("suspended");
  });
  test("serializes saves without losing mutations made during a write", async () => {
    const store = new MemoryStore();
    const route = newSessionRoute("test");
    await store.createSession(route);
    const manager = new SessionManager(store, logger);
    const entity = manager.loadOrCreate(route);
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.updateSession.bind(store);
    let calls = 0;
    store.updateSession = async (snapshot) => {
      if (++calls === 1) {
        started();
        await gate;
      }
      await original(snapshot);
    };
    entity.bindRuntime("first");
    const first = entity.flush(store);
    await writing;
    entity.bindRuntime("second");
    const second = entity.flush(store);
    release();
    await Promise.all([first, second]);
    expect((await store.getSession(route.sessionId))?.runtimeSessionId).toBe("second");
  });
  test("observer failures do not fail state transitions; unregister removes hooks", async () => {
    const store = new MemoryStore();
    const manager = new SessionManager(store, logger);
    const entity = manager.loadOrCreate(newSessionRoute("test"));
    let calls = 0;
    const remove = manager.registerHook({
      onTurnStarted: () => {
        calls++;
        throw new Error("observer failed");
      },
    });
    await entity.notifyTurnStarted("a", "one");
    remove();
    await entity.notifyTurnStarted("b", "two");
    expect(calls).toBe(1);
  });
});

describe("Session Architecture & Lifecycle Management", () => {
  it("manages multi-source cursors in memory and evaluates reading priority correctly", () => {
    const route: SessionRoute = {
      sessionId: "ses_multi_source",
      projectId: "proj_1",
      projectRuntimeId: "rt_1",
      runtimeSessionId: "rts_1",
      configRevision: 1,
      status: "active",
      lastActiveAt: new Date().toISOString(),
      cursors: { feishu: 100, web: 150 },
    };

    const session = new SessionEntity(route);

    // 1. Fallback to source cursor when after is omitted
    expect(session.getCursor("feishu")).toBe(100);
    expect(session.getCursor("web")).toBe(150);
    expect(session.getCursor("unknown_source")).toBe(0);

    // 2. Explicit after > 0 overrides session cursor
    expect(session.getCursor("feishu", 50)).toBe(50);
    expect(session.getCursor("feishu", 200)).toBe(200);

    // 3. Explicit after <= 0 (e.g. 0 or -1) forces full replay from beginning
    expect(session.getCursor("feishu", 0)).toBe(0);
    expect(session.getCursor("feishu", -1)).toBe(0);

    // 4. Pure in-memory ack updates cursor without disk I/O
    session.ack("feishu", 120);
    expect(session.getCursor("feishu")).toBe(120);
    // Web cursor must remain isolated and untouched
    expect(session.getCursor("web")).toBe(150);

    // Monotonicity: a lower sequence should not regress cursor
    session.ack("feishu", 90);
    expect(session.getCursor("feishu")).toBe(120);
  });

  it("triggers lifecycle hooks and automatically flushes dirty checkpoints to store on turn completion", async () => {
    const store = new MemoryStore();
    const manager = new SessionManager(store);

    const route: SessionRoute = {
      sessionId: "ses_hook_test",
      projectId: "proj_1",
      projectRuntimeId: "rt_1",
      runtimeSessionId: "rts_1",
      configRevision: 1,
      status: "active",
      lastActiveAt: new Date().toISOString(),
    };
    await store.createSession(route);

    const session = manager.loadOrCreate(route);

    const observedEvents: string[] = [];
    session.addHook({
      onTurnStarted: (_s, turnId) => {
        observedEvents.push(`turn_started:${turnId}`);
      },
      onCursorAck: (_s, source, seq) => {
        observedEvents.push(`ack:${source}:${seq}`);
      },
      onTurnCompleted: (_s, turnId, status) => {
        observedEvents.push(`turn_completed:${turnId}:${status}`);
      },
      onStateChanged: (_s, from, to) => {
        observedEvents.push(`state:${from}->${to}`);
      },
    });

    // 1. Start Turn
    await session.notifyTurnStarted("turn_1", "Hello");
    expect(observedEvents).toContain("turn_started:turn_1");

    // 2. Consume events in memory
    session.ack("feishu", 42);
    expect(observedEvents).toContain("ack:feishu:42");

    // Before turn completion, store has not been written yet (zero unnecessary I/O)
    const midStored = await store.getSession(route.sessionId);
    expect(midStored?.cursors?.feishu).toBeUndefined();

    // 3. Complete Turn -> triggers PersistenceCheckpointHook and commits cursors to Store
    await session.notifyTurnCompleted("turn_1", "completed");
    expect(observedEvents).toContain("turn_completed:turn_1:completed");

    const finalStored = await store.getSession(route.sessionId);
    expect(finalStored?.cursors?.feishu).toBe(42);
  });

  it("stream automatically isolates multi-turn events and prevents Turn 1 event replay in Turn 2", async () => {
    const store = new MemoryStore();
    const manager = new SessionManager(store);
    const hub = new MemoryEventHub(store, manager);

    const sessionId = "ses_stream_isolation";
    const route: SessionRoute = {
      sessionId,
      projectId: "proj_weather",
      projectRuntimeId: "rt_weather",
      runtimeSessionId: "rts_weather",
      configRevision: 1,
      status: "active",
      lastActiveAt: new Date().toISOString(),
    };
    await store.createSession(route);
    const session = manager.loadOrCreate(route);

    // --- Turn 1: "What are the projects?" ---
    await session.notifyTurnStarted("turn_1", "项目分别是干什么的？");

    // Turn 1 events: sequences 1, 2, 3
    const turn1Events = [
      {
        id: "evt_1",
        projectId: "proj_weather",
        sessionId,
        sequence: 1,
        type: "thought" as const,
        runtime: "codex" as const,
        payload: { text: "thinking..." },
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
      },
      {
        id: "evt_2",
        projectId: "proj_weather",
        sessionId,
        sequence: 2,
        type: "agent.message.completed" as const,
        runtime: "codex" as const,
        payload: { item: { phase: "final_answer", text: "这里有两个项目：A 和 B" } },
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
      },
      {
        id: "evt_3",
        projectId: "proj_weather",
        sessionId,
        sequence: 3,
        type: "turn.completed" as const,
        runtime: "codex" as const,
        payload: { turnId: "turn_1" },
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
      },
    ];

    for (const evt of turn1Events) {
      await store.appendEvent(evt);
      hub.publish(evt);
    }

    // Feishu consumes Turn 1
    const feishuTurn1Received: any[] = [];
    for await (const evt of hub.stream(sessionId, { source: "feishu" })) {
      feishuTurn1Received.push(evt);
      if (evt.type === "turn.completed") break;
    }

    expect(feishuTurn1Received.length).toBe(3);
    expect(session.getCursor("feishu")).toBe(3);

    // Turn 1 completes and commits checkpoint
    await session.notifyTurnCompleted("turn_1", "completed");
    const checkpoint1 = await store.getSession(sessionId);
    expect(checkpoint1?.cursors?.feishu).toBe(3);

    // --- Turn 2: "Check Chongqing weather" ---
    await session.notifyTurnStarted("turn_2", "查一下明天重庆的天气");

    // Turn 2 events: sequences 4, 5
    const turn2Events = [
      {
        id: "evt_4",
        projectId: "proj_weather",
        sessionId,
        sequence: 4,
        type: "command.completed" as const,
        runtime: "codex" as const,
        payload: { command: "curl wttr.in/Chongqing" },
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
      },
      {
        id: "evt_5",
        projectId: "proj_weather",
        sessionId,
        sequence: 5,
        type: "turn.completed" as const,
        runtime: "codex" as const,
        payload: { turnId: "turn_2", output: "重庆明天阴转多云" },
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
      },
    ];

    for (const evt of turn2Events) {
      await store.appendEvent(evt);
      hub.publish(evt);
    }

    // Feishu consumes Turn 2 without passing `after` -> must automatically start after sequence 3!
    const feishuTurn2Received: any[] = [];
    for await (const evt of hub.stream(sessionId, { source: "feishu" })) {
      feishuTurn2Received.push(evt);
      if (evt.type === "turn.completed") break;
    }

    // MUST ONLY receive Turn 2 events (4 and 5) and MUST NOT replay Turn 1 events (1, 2, 3)!
    expect(feishuTurn2Received.length).toBe(2);
    expect(feishuTurn2Received[0].sequence).toBe(4);
    expect(feishuTurn2Received[1].sequence).toBe(5);
    expect(session.getCursor("feishu")).toBe(5);

    // --- Web consumer with explicit after: 0 forces replay of ALL history ---
    const webAllReceived: any[] = [];
    for await (const evt of hub.stream(sessionId, { source: "web", after: 0 })) {
      webAllReceived.push(evt);
      if (evt.sequence === 5) break;
    }

    // Web gets all 5 events (1, 2, 3, 4, 5)
    expect(webAllReceived.length).toBe(5);
    expect(webAllReceived.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);

    // Feishu cursor remains unaffected
    expect(session.getCursor("feishu")).toBe(5);
  });
});
