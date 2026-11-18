import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { ProjectConfig, SessionRoute } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import {
  FakeRuntime,
  RuntimeSessionNotFoundError,
  type RuntimeContext,
  type RuntimeSession,
} from "../src/runtime/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

class ResumableRuntime extends FakeRuntime {
  resumed: string[] = [];
  resumeError: Error | undefined;
  override async resumeSession(
    context: RuntimeContext,
    runtimeSessionId: string,
  ): Promise<RuntimeSession> {
    this.resumed.push(runtimeSessionId);
    if (this.resumeError) throw this.resumeError;
    return super.resumeSession(context, runtimeSessionId);
  }
}

describe("runtime session binding", () => {
  let root: string;
  let store: MemoryStore;
  let agent: ResumableRuntime;
  let runtime: ProjectRuntime;

  beforeEach(async () => {
    root = await mkdtemp("/tmp/runtime-reset-");
    store = new MemoryStore();
    agent = new ResumableRuntime();
    const project: ProjectConfig = {
      id: "reset",
      displayName: "Reset",
      description: "test",
      routing: { projectId: "reset" },
      repositories: [{ id: "main", url: "", baseBranch: "main" }],
      runtime: { type: "fake" },
    };
    runtime = new ProjectRuntime(
      project,
      store,
      agent,
      new WorkspaceManager(path.join(root, "workspaces")),
      new ArtifactStore(path.join(root, "artifacts"), store),
      undefined,
      new Logger({ sink: () => {} }),
    );
  });

  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });

  /** A session persisted by an earlier process: the runtime does not hold it yet. */
  async function storedSession(runtimeName = "fake"): Promise<SessionRoute> {
    const route: SessionRoute = {
      sessionId: "ses_previous",
      projectId: "reset",
      projectRuntimeId: "project-runtime:reset",
      runtimeSessionId: "old-runtime-session",
      runtime: runtimeName,
      configRevision: 1,
      status: "suspended",
      source: "web",
      lastActiveAt: new Date().toISOString(),
    };
    await store.createSession(route);
    return route;
  }

  async function runTurn(sessionId: string, input: string) {
    const turn = await runtime.turn(sessionId, input);
    await runtime.waitForIdle(sessionId);
    return store.getTurn(turn.id);
  }

  test("resumes a stored session once per process", async () => {
    const route = await storedSession();
    await runTurn(route.sessionId, "first");
    await runTurn(route.sessionId, "second");
    expect(agent.resumed).toEqual(["old-runtime-session"]);
    const events = await runtime.events(route.sessionId);
    expect(events.some((e) => e.type === "session.runtime_reset")).toBe(false);
  });

  test("starts a new runtime session when the old one is gone", async () => {
    const route = await storedSession();
    agent.resumeError = new RuntimeSessionNotFoundError("old-runtime-session");
    const turn = await runTurn(route.sessionId, "hello");
    expect(turn?.status).toBe("completed");

    const reset = (await runtime.events(route.sessionId)).find(
      (e) => e.type === "session.runtime_reset",
    );
    expect(reset?.payload).toMatchObject({
      reason: "not_found",
      previousRuntimeSessionId: "old-runtime-session",
    });
    const stored = await store.getSession(route.sessionId);
    expect(stored?.runtimeSessionId).not.toBe("old-runtime-session");
  });

  test("other resume errors fail the turn instead of starting over", async () => {
    const route = await storedSession();
    agent.resumeError = new Error("runtime unavailable");
    const turn = await runTurn(route.sessionId, "hello");
    expect(turn?.status).toBe("failed");
    expect((await store.getSession(route.sessionId))?.runtimeSessionId).toBe(
      "old-runtime-session",
    );
  });

  test("a session from another runtime is not handed to this one", async () => {
    const route = await storedSession("codex");
    await runTurn(route.sessionId, "hello");
    expect(agent.resumed).toEqual([]);
    const reset = (await runtime.events(route.sessionId)).find(
      (e) => e.type === "session.runtime_reset",
    );
    expect(reset?.payload).toMatchObject({ reason: "runtime_changed", runtime: "fake" });
    expect((await store.getSession(route.sessionId))?.runtime).toBe("fake");
  });
});
