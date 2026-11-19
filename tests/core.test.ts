import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { MemoryStore, newSessionRoute } from "../src/persistence/store.ts";
import { ProjectRouter } from "../src/router/project-router.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

const project: ProjectConfig = {
  id: "alpha",
  displayName: "Alpha",
  description: "Alpha repository for issue and API work",
  routing: {
    projectId: "alpha",
    displayName: "Alpha",
    summary: "Alpha repository for issue and API work",
    keywords: ["alpha", "api"],
    routingHints: [],
  },
  runtime: { type: "fake", approvalPolicy: "on-request", sandbox: "workspace-write" },
  repository: { url: "", baseBranch: "main" },
};

describe("project routing", () => {
  test("routes explicit keyword matches without an LLM", async () => {
    const router = new ProjectRouter(undefined, undefined);
    const result = await router.route("please inspect alpha api", [project]);
    expect(result.project.id).toBe("alpha");
  });
  test("rejects ambiguous keyword matches", async () => {
    const router = new ProjectRouter(undefined, undefined);
    const other = {
      ...project,
      id: "beta",
      displayName: "Beta",
      routing: {
        ...project.routing,
        projectId: "beta",
        displayName: "Beta",
        summary: "Alpha repository for issue and API work",
      },
    };
    expect(router.route("api issue", [project, other])).rejects.toThrow("ambiguous");
  });
});

describe("memory store", () => {
  test("persists session routes and ordered events", async () => {
    const store = new MemoryStore();
    const route = newSessionRoute("alpha");
    await store.createSession(route);
    await store.appendEvent({
      id: "e1",
      projectId: "alpha",
      sessionId: route.sessionId,
      sequence: 1,
      type: "session.started",
      runtime: "gateway",
      payload: {},
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    expect((await store.getSession(route.sessionId))?.projectId).toBe("alpha");
    expect((await store.listEvents(route.sessionId))[0]?.sequence).toBe(1);
  });
});

describe("fake project runtime", () => {
  let root: string;
  let store: MemoryStore;
  let runtime: ProjectRuntime;
  beforeEach(async () => {
    root = path.join("/tmp", `agent-orchestrator-test-${crypto.randomUUID()}`);
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
    runtime = new ProjectRuntime(
      { ...project, repository: { url: repo, baseBranch: "main" } },
      store,
      new FakeRuntime(),
      new WorkspaceManager(path.join(root, "workspaces")),
      new ArtifactStore(path.join(root, "artifacts"), store),
    );
  });
  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  test("creates a session, forwards a turn, and records events", async () => {
    const route = await runtime.createSession();
    const turn = await runtime.turn(route.sessionId, "hello");
    expect(turn.status).toBe("queued");

    let completed = false;
    for (let i = 0; i < 50; i++) {
      const events = await runtime.events(route.sessionId);
      if (events.some((event) => event.type === "turn.completed")) {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(completed).toBe(true);
  });
});
