import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { FakeRuntime, type RuntimeContext } from "../src/runtime/runtime.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { Logger } from "../src/observability/logger.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { createGlobalProjectConfig } from "../src/project/global.ts";

class ControlledRuntime extends FakeRuntime {
  starts: Array<{ context: RuntimeContext; session: string; id: string; input: string }> = [];
  released: string[] = [];
  early = false;
  acknowledgeInterrupt = true;
  failStart = false;
  private waiters: Array<() => void> = [];
  override async startTurn(context: RuntimeContext, session: string, id: string, input: string) {
    if (this.failStart) {
      this.failStart = false;
      throw new Error("start failed");
    }
    const runtimeId = `runtime-${id}`;
    this.starts.push({ context, session, id: runtimeId, input });
    for (const notify of this.waiters.splice(0)) notify();
    if (this.early)
      await context.onEvent({
        type: "turn.completed",
        sessionId: session,
        turnId: runtimeId,
        payload: {},
      });
    return { id: runtimeId };
  }
  async started(count: number) {
    while (this.starts.length < count)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  async finish(index: number, status: "completed" | "failed" | "interrupted" = "completed") {
    const start = this.starts[index]!;
    await start.context.onEvent({
      type: `turn.${status}` as "turn.completed" | "turn.failed" | "turn.interrupted",
      sessionId: start.session,
      turnId: start.id,
      payload: {},
    });
  }
  override async interruptTurn(context: RuntimeContext, session: string, id: string) {
    if (this.acknowledgeInterrupt)
      await context.onEvent({
        type: "turn.interrupted",
        sessionId: session,
        turnId: id,
        payload: {},
      });
  }
  override async releaseSession(_context: RuntimeContext, id: string) {
    this.released.push(id);
  }
}

describe("global project", () => {
  test("its sessions run read-only", async () => {
    const root = await mkdtemp("/tmp/session-global-");
    const store = new MemoryStore();
    const agent = new ControlledRuntime();
    const runtime = new ProjectRuntime({
      project: createGlobalProjectConfig(path.join(root, "projects"), "fake"),
      store,
      agentRuntime: agent,
      workspaces: new WorkspaceManager(path.join(root, "workspaces")),
      artifacts: new ArtifactStore(path.join(root, "artifacts"), store),
      logger: new Logger({ sink: () => {} }),
    });
    try {
      const session = await runtime.createSession();
      await runtime.turn(session.sessionId, "what projects are there?");
      await agent.started(1);
      expect(agent.starts[0]!.context.readOnly).toBe(true);
      await agent.finish(0);
    } finally {
      await runtime.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("session execution and control", () => {
  let root: string;
  let store: MemoryStore;
  let agent: ControlledRuntime;
  let runtime: ProjectRuntime;
  let sessionId: string;
  beforeEach(async () => {
    root = await mkdtemp("/tmp/session-execution-");
    store = new MemoryStore();
    agent = new ControlledRuntime();
    const project: ProjectConfig = {
      id: "execution",
      displayName: "Execution",
      description: "test",
      routing: { projectId: "execution" },
      repository: { url: "", baseBranch: "main" },
      runtime: { type: "fake" },
      session: { idleTimeoutMs: 1000, archiveTimeoutMs: 2000 },
    };
    runtime = new ProjectRuntime({
      project,
      store,
      agentRuntime: agent,
      workspaces: new WorkspaceManager(path.join(root, "workspaces")),
      artifacts: new ArtifactStore(path.join(root, "artifacts"), store),
      logger: new Logger({ sink: () => {} }),
      controlTimeoutMs: 30,
      queueLimit: 2,
    });
    sessionId = (await runtime.createSession()).sessionId;
  });
  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("does not start the next turn before the previous terminal event", async () => {
    const first = await runtime.turn(sessionId, "first");
    await agent.started(1);
    const second = await runtime.turn(sessionId, "second");
    expect(agent.starts).toHaveLength(1);
    expect((await store.getTurn(second.id))?.status).toBe("queued");
    await agent.finish(0);
    await agent.started(2);
    expect((await store.getTurn(first.id))?.status).toBe("completed");
    await agent.finish(1);
    await runtime.waitForIdle(sessionId);
    expect((await store.getTurn(second.id))?.status).toBe("completed");
  });
  test("compaction is rejected while a turn is running", async () => {
    await runtime.turn(sessionId, "long");
    await agent.started(1);
    await expect(runtime.compact(sessionId)).rejects.toThrow(
      "cannot compact while a turn is running",
    );
    await agent.finish(0);
    await runtime.waitForIdle(sessionId);
    await runtime.compact(sessionId);
  });
  test("correlates a terminal event arriving before startTurn returns", async () => {
    agent.early = true;
    const turn = await runtime.turn(sessionId, "instant");
    await runtime.waitForIdle(sessionId);
    expect((await store.getTurn(turn.id))?.status).toBe("completed");
    expect((await runtime.events(sessionId)).find((e) => e.type === "turn.completed")?.turnId).toBe(
      turn.id,
    );
  });
  test("cancel bypasses queued work and the next normal turn can continue", async () => {
    const first = await runtime.turn(sessionId, "long");
    await agent.started(1);
    const second = await runtime.turn(sessionId, "next");
    await runtime.interrupt(sessionId);
    await agent.started(2);
    expect((await store.getTurn(first.id))?.status).toBe("interrupted");
    await agent.finish(1);
    await runtime.waitForIdle(sessionId);
    expect((await store.getTurn(second.id))?.status).toBe("completed");
  });
  test("turn completion retains the notification event and project metadata", async () => {
    runtime.project.notifyOnTurnCompleted = true;
    runtime.project.notifications = [{ type: "log", name: "completion" }];
    const turn = await runtime.turn(sessionId, "finish with notification");
    await agent.started(1);
    await agent.finish(0);
    await runtime.waitForIdle(sessionId);
    const queued = (await runtime.events(sessionId)).find(
      (event) => event.type === "notification.queued",
    );
    expect(queued?.turnId).toBe(turn.id);
    const deliveries = await store.listNotificationDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.message.metadata).toEqual({
      projectId: "execution",
      sessionId,
      turnId: turn.id,
    });
  });
  test("no notification event is recorded when the project does not notify", async () => {
    await runtime.turn(sessionId, "finish quietly");
    await agent.started(1);
    await agent.finish(0);
    await runtime.waitForIdle(sessionId);
    const types = (await runtime.events(sessionId)).map((event) => event.type);
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("notification.queued");
    expect(await store.listNotificationDeliveries()).toHaveLength(0);
  });
  test("a turn the runtime reports as failed keeps the runtime's reason", async () => {
    const turn = await runtime.turn(sessionId, "fail please");
    await agent.started(1);
    const start = agent.starts[0]!;
    await start.context.onEvent({
      type: "turn.failed",
      sessionId: start.session,
      turnId: start.id,
      payload: { status: "failed", error: "Not logged in" },
    });
    await runtime.waitForIdle(sessionId);
    expect(await store.getTurn(turn.id)).toMatchObject({
      status: "failed",
      error: "Not logged in",
    });
  });
  test("canceling a queued turn does not cancel the active turn", async () => {
    const first = await runtime.turn(sessionId, "long");
    await agent.started(1);
    const second = await runtime.turn(sessionId, "queued");
    await runtime.interrupt(sessionId, second.id);
    expect((await store.getTurn(second.id))?.status).toBe("interrupted");
    expect((await store.getTurn(first.id))?.status).toBe("in_progress");
    await agent.finish(0);
    await runtime.waitForIdle(sessionId);
    expect(agent.starts).toHaveLength(1);
  });
  test("close cancels the queue and releases resources only after interrupt confirmation", async () => {
    await runtime.turn(sessionId, "long");
    await agent.started(1);
    await runtime.turn(sessionId, "queued");
    await runtime.cleanupSession(sessionId);
    expect(agent.starts).toHaveLength(1);
    expect(agent.released).toHaveLength(1);
    expect(await store.getSession(sessionId)).toBeNull();
  });
  test("close completes even when the runtime never confirms the interrupt", async () => {
    agent.acknowledgeInterrupt = false;
    const turn = await runtime.turn(sessionId, "long");
    await agent.started(1);
    await runtime.cleanupSession(sessionId, { deleteFromStore: false });
    expect((await store.getTurn(turn.id))?.status).toBe("interrupted");
    expect((await store.getSession(sessionId))?.status).toBe("closed");
    expect(agent.released).toHaveLength(1);
  });
  test("start finishes closes left over from a previous run", async () => {
    const stored = (await store.getSession(sessionId))!;
    await store.updateSession({ ...stored, status: "closing" });
    await runtime.sessionManager.remove(sessionId);
    await runtime.start();
    expect((await store.getSession(sessionId))?.status).toBe("closed");
  });
  test("dispatched sessions are regular sessions", async () => {
    const { context } = runtime.createContext(
      { kind: "session", sessionId },
      { signal: new AbortController().signal },
    );
    const dispatched = await context.sessions.start({
      title: "Child",
      prompt: "work",
      metadata: { taskKey: "spoofed" },
    });
    const route = await store.getSession(dispatched.sessionId);
    expect(route?.source).toBe("dispatch");
    expect(route?.metadata?.taskKey).toBeUndefined();
    expect(route?.metadata?.sourceSessionId).toBe(sessionId);
    const listed = await store.listSessions("execution");
    expect(listed.map((s) => s.sessionId)).toContain(dispatched.sessionId);
  });
  test("a session started from a project context records where it came from", async () => {
    const { context, dispose } = runtime.createContext(
      { kind: "task", taskId: "nightly", taskKey: "execution:nightly", executionId: "texe_1" },
      { signal: new AbortController().signal },
    );
    const started = await context.sessions.start({
      title: "Fix flaky test",
      prompt: "fix it",
      model: "fast",
      metadata: { issue: 7 },
    });
    await dispose();
    const route = await store.getSession(started.sessionId);
    expect(route).toMatchObject({ source: "dispatch", model: "fast" });
    expect(route?.metadata).toMatchObject({
      title: "Fix flaky test",
      sourceTaskId: "nightly",
      sourceTaskExecutionId: "texe_1",
      dispatch: { issue: 7 },
    });
    await agent.started(1);
    expect(agent.starts[0]!.input).toBe("fix it");
    await agent.finish(0);
    await runtime.waitForIdle(started.sessionId);
    expect((await store.getTurn(started.turnId))?.status).toBe("completed");
  });
  test("a task's session updates the task's state through its tools", async () => {
    runtime.taskEngine.updateState("execution:nightly", { cursor: 1 });
    const route = await runtime.createSession({ title: "Task: nightly" }, "task", undefined, {
      owner: {
        kind: "task",
        taskId: "nightly",
        taskKey: "execution:nightly",
        executionId: "exec_1",
      },
    });
    expect((await store.getSession(route.sessionId))?.owner).toMatchObject({ kind: "task" });

    await runtime.turn(route.sessionId, "sync");
    await agent.started(1);
    const tools = agent.starts[0]!.context.tools!;
    expect(tools.specs.map((spec) => spec.name)).toContain("update_task_state");
    const result = await tools.call("update_task_state", { state: { since: "t1" } });
    expect(result.ok).toBe(true);
    expect(await runtime.taskEngine.getState("execution:nightly")).toEqual({
      cursor: 1,
      since: "t1",
    });
    const [audit] = await store.listToolExecutions({ sessionId: route.sessionId });
    expect(audit).toMatchObject({
      toolName: "update_task_state",
      turnId: agent.starts[0]!.id.replace("runtime-", ""),
      ownerKind: "task",
      ownerId: "exec_1",
    });
    await agent.finish(0);
    await runtime.waitForIdle(route.sessionId);
  });
  test("start cleans up task sessions abandoned by a previous run", async () => {
    const task = await runtime.createSession({ taskKey: "execution:nightly" }, "task");
    await runtime.sessionManager.remove(task.sessionId);
    await runtime.start();
    expect((await store.getSession(task.sessionId))?.status).toBe("closed");
  });
  test("runtime disconnect completes the active turn as failed", async () => {
    const turn = await runtime.turn(sessionId, "long");
    await agent.started(1);
    const current = agent.starts[0]!;
    await current.context.onEvent({
      type: "runtime.disconnected",
      sessionId: current.session,
      payload: {},
    });
    await runtime.waitForIdle(sessionId);
    expect((await store.getTurn(turn.id))?.status).toBe("failed");
  });
  test("failed startup does not stall the next turn", async () => {
    agent.failStart = true;
    const first = await runtime.turn(sessionId, "fail");
    const second = await runtime.turn(sessionId, "next");
    await agent.started(1);
    await agent.finish(0);
    await runtime.waitForIdle(sessionId);
    expect((await store.getTurn(first.id))?.status).toBe("failed");
    expect((await store.getTurn(second.id))?.status).toBe("completed");
  });
  test("suspending one session releases its thread without stopping the project", async () => {
    const entity = runtime.sessionManager.get(sessionId)!;
    entity.touch(new Date(Date.now() - 1500).toISOString());
    await runtime.sessionManager.save(sessionId);
    await runtime.checkLifecycles();
    expect(entity.status).toBe("suspended");
    expect(agent.released).toHaveLength(1);
    const turn = await runtime.turn(sessionId, "resume");
    await agent.started(1);
    await agent.finish(0);
    await runtime.waitForIdle(sessionId);
    expect(entity.status).toBe("active");
    expect((await store.getTurn(turn.id))?.status).toBe("completed");
  });
  test("active work cannot be archived and completing work refreshes idle time", async () => {
    await runtime.turn(sessionId, "long");
    await agent.started(1);
    const entity = runtime.sessionManager.get(sessionId)!;
    entity.touch(new Date(Date.now() - 10000).toISOString());
    await runtime.sessionManager.save(sessionId);
    await runtime.checkLifecycles();
    expect(entity.status).toBe("active");
    await agent.finish(0);
    await runtime.waitForIdle(sessionId);
    await runtime.checkLifecycles();
    expect(entity.status).toBe("active");
    expect(Date.now() - Date.parse(entity.lastActiveAt)).toBeLessThan(1000);
  });
});
