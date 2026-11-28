import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { EventRecord, ProjectConfig } from "../src/domain/types.ts";
import { MemoryEventHub } from "../src/events/hub.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { FakeRuntime, type RuntimeContext, type RuntimeTurn } from "../src/runtime/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

class StreamingFakeRuntime extends FakeRuntime {
  override async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const runtimeTurnId = `fake_turn_${crypto.randomUUID()}`;
    await context.onEvent({ type: "turn.started", sessionId, turnId, payload: { runtimeTurnId } });

    // Reasoning deltas
    await context.onEvent({
      type: "agent.reasoning.delta",
      sessionId,
      turnId,
      payload: { text: "Thinking " },
    });
    await context.onEvent({
      type: "agent.reasoning.delta",
      sessionId,
      turnId,
      payload: { text: "deeply..." },
    });

    // Reasoning completed with full content
    await context.onEvent({
      type: "agent.reasoning.completed",
      sessionId,
      turnId,
      payload: { itemId: "item_1", text: "Thinking deeply..." },
    });

    // Message deltas
    await context.onEvent({
      type: "agent.message.delta",
      sessionId,
      turnId,
      payload: { text: "Hello " },
    });
    await context.onEvent({
      type: "agent.message.delta",
      sessionId,
      turnId,
      payload: { text: "world!" },
    });

    // Message completed with full text
    await context.onEvent({
      type: "agent.message.completed",
      sessionId,
      turnId,
      payload: { text: "Hello world!" },
    });

    // Turn completed
    await context.onEvent({
      type: "turn.completed",
      sessionId,
      turnId,
      payload: { runtimeTurnId },
    });

    return { id: runtimeTurnId };
  }
}

describe("Event Stream Optimization: Delta skipping & in-memory sequence", () => {
  let root: string;
  let store: MemoryStore;
  let eventHub: MemoryEventHub;
  let runtime: ProjectRuntime;

  const project: ProjectConfig = {
    id: "stream-opt-proj",
    displayName: "Stream Opt Project",
    description: "Test project for delta event bypass",
    routing: {
      projectId: "stream-opt-proj",
      displayName: "Stream Opt Project",
      summary: "Test project for delta event bypass",
      keywords: ["test"],
    },
  };

  beforeEach(async () => {
    root = path.join("/tmp", `stream-opt-test-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const repo = path.join(root, "repo");
    await mkdir(repo, { recursive: true });

    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "test"],
      ["config", "user.email", "test@example.com"],
      ["commit", "--allow-empty", "-m", "initial"],
    ]) {
      const process = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "pipe" });
      if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
    }

    store = new MemoryStore();
    eventHub = new MemoryEventHub(store);
    runtime = new ProjectRuntime({
      project: { ...project, repository: { url: repo, baseBranch: "main" } },
      store,
      agentRuntime: new StreamingFakeRuntime(),
      workspaces: new WorkspaceManager(path.join(root, "workspaces")),
      artifacts: new ArtifactStore(path.join(root, "artifacts"), store),
      eventHub,
    });
  });

  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("getLatestEventSequence retrieves latest sequence correctly from store", async () => {
    expect(await store.getLatestEventSequence("ses_none")).toBe(0);

    await store.appendEvent({
      id: "evt_1",
      projectId: "stream-opt-proj",
      sessionId: "ses_test",
      sequence: 5,
      type: "session.started",
      runtime: "gateway",
      payload: {},
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    expect(await store.getLatestEventSequence("ses_test")).toBe(5);
  });

  it("broadcasts delta events to eventHub with increasing sequences but skips database persistence", async () => {
    const route = await runtime.createSession();
    const receivedHubEvents: EventRecord[] = [];
    const unsub = eventHub.subscribeSession(route.sessionId, (evt) => {
      receivedHubEvents.push(evt);
    });

    try {
      await runtime.turn(route.sessionId, "Say hello");

      // Wait for turn completion
      let completed = false;
      for (let i = 0; i < 50; i++) {
        if (receivedHubEvents.some((e) => e.type === "turn.completed")) {
          completed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(completed).toBe(true);

      // Verify sequence monotonicity on EventHub (real-time stream received all events)
      expect(receivedHubEvents.length).toBeGreaterThan(5);
      const hubSequences = receivedHubEvents.map((e) => e.sequence);
      for (let i = 1; i < hubSequences.length; i++) {
        const prev = hubSequences[i - 1]!;
        const curr = hubSequences[i]!;
        expect(curr).toBe(prev + 1);
      }

      // Check that delta events WERE received by EventHub subscribers
      const deltaHubEvents = receivedHubEvents.filter((e) => /delta/i.test(e.type));
      expect(deltaHubEvents.length).toBeGreaterThanOrEqual(4); // 2 reasoning deltas + 2 message deltas

      // Check the STORE (Database persistence):
      // Delta events must NOT be in store!
      const storedEvents = await store.listEvents(route.sessionId);
      const storedDeltaEvents = storedEvents.filter((e) => /delta/i.test(e.type));
      expect(storedDeltaEvents.length).toBe(0);

      // But non-delta structured events (turn.queued, turn.started, agent.reasoning.completed, agent.message.completed, turn.completed) MUST be in store!
      const storedTypes = storedEvents.map((e) => e.type);
      expect(storedTypes).toContain("turn.started");
      expect(storedTypes).toContain("agent.reasoning.completed");
      expect(storedTypes).toContain("agent.message.completed");
      expect(storedTypes).toContain("turn.completed");

      // Verify final output is stored on turn
      const turn = await store.getLatestTurn(route.sessionId);
      expect(turn?.output).toBe("Hello world!");
    } finally {
      unsub();
    }
  });
});
