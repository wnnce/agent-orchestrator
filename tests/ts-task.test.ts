import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config/config.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Gateway } from "../src/gateway/server.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { RuntimeRegistry } from "../src/runtime/registry.ts";
import {
  FAKE_CAPABILITIES,
  FakeRuntime,
  type AgentRuntime,
  type ApprovalDecision,
  type RuntimeContext,
  type RuntimeSession,
  type RuntimeTurn,
} from "../src/runtime/runtime.ts";
import { isTsTaskFile, loadTsTaskModule, TaskLoader } from "../src/task/index.ts";

class CapturingRuntime implements AgentRuntime {
  readonly name: string;
  readonly type: string;
  readonly capabilities = FAKE_CAPABILITIES;
  private readonly inner = new FakeRuntime();
  readonly startedContexts: RuntimeContext[] = [];
  readonly turnContexts: RuntimeContext[] = [];

  constructor(type: string) {
    this.name = type;
    this.type = type;
  }

  startSession(context: RuntimeContext): Promise<RuntimeSession> {
    this.startedContexts.push(context);
    return this.inner.startSession(context);
  }

  resumeSession(context: RuntimeContext, runtimeSessionId: string): Promise<RuntimeSession> {
    return this.inner.resumeSession(context, runtimeSessionId);
  }

  startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    this.turnContexts.push(context);
    return this.inner.startTurn(context, sessionId, turnId, input);
  }

  steerTurn(context: RuntimeContext, sessionId: string, runtimeTurnId: string, input: string) {
    return this.inner.steerTurn(context, sessionId, runtimeTurnId, input);
  }

  interruptTurn(context: RuntimeContext, sessionId: string, runtimeTurnId: string) {
    return this.inner.interruptTurn(context, sessionId, runtimeTurnId);
  }

  compactSession(context: RuntimeContext, sessionId: string) {
    return this.inner.compactSession(context, sessionId);
  }

  respondToApproval(context: RuntimeContext, requestId: string, decision: ApprovalDecision) {
    return this.inner.respondToApproval(context, requestId, decision);
  }

  releaseSession(context: RuntimeContext, sessionId: string) {
    return this.inner.releaseSession(context, sessionId);
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }
}

describe("TypeScript task module contract & loader", () => {
  let root: string;
  const silentLogger = new Logger({ sink: () => {} });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ao-ts-task-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("isTsTaskFile filters helper, declaration, and test files", () => {
    expect(isTsTaskFile("sync-issues.ts")).toBe(true);
    expect(isTsTaskFile("_helpers.ts")).toBe(false);
    expect(isTsTaskFile("types.d.ts")).toBe(false);
    expect(isTsTaskFile("sync-issues.test.ts")).toBe(false);
    expect(isTsTaskFile("sync-issues.spec.ts")).toBe(false);
    expect(isTsTaskFile("sync-issues.md")).toBe(false);
  });

  test("loads single-task module with default id and multi-task module with shared api context", async () => {
    const tasksDir = path.join(root, "tasks");
    await mkdir(tasksDir, { recursive: true });

    const singleFile = path.join(tasksDir, "ping-health.ts");
    await writeFile(
      singleFile,
      `
export default function (api) {
  api.registerTask({
    name: "Ping Health",
    cron: "*/5 * * * *",
    enabled: false,
    async run() {
      return { summary: { ok: true, project: api.projectId } };
    },
  });
}
`,
    );

    const single = await loadTsTaskModule(singleFile, "demo", { env: { API_TOKEN: "sec" } }, silentLogger);
    expect(single.tasks).toHaveLength(1);
    expect(single.tasks[0]?.taskId).toBe("ping-health");
    expect(single.tasks[0]?.taskKey).toBe("demo:ping-health");
    expect(single.tasks[0]?.type).toBe("ts");
    expect(single.tasks[0]?.sourceFormat).toBe("typescript");

    const multiFile = path.join(tasksDir, "github-suite.ts");
    await writeFile(
      multiFile,
      `
export default async function (api) {
  const token = api.env.GITHUB_TOKEN ?? "";
  api.registerTask({
    id: "scan-issues",
    name: "Scan Issues",
    cron: "*/10 * * * *",
    async run() {
      return { summary: { tokenPresent: Boolean(token), kind: "issues" } };
    },
  });
  api.registerTask({
    id: "scan-prs",
    name: "Scan PRs",
    cron: "*/15 * * * *",
    timezone: "Asia/Shanghai",
    enabled: false,
    async run() {
      return { summary: { tokenPresent: Boolean(token), kind: "prs" } };
    },
  });
}
`,
    );

    const multi = await loadTsTaskModule(
      multiFile,
      "demo",
      { env: { GITHUB_TOKEN: "tok_123" } },
      silentLogger,
    );
    expect(multi.tasks.map((t) => t.taskId)).toEqual(["scan-issues", "scan-prs"]);
    expect(multi.tasks[1]?.timezone).toBe("Asia/Shanghai");
    expect(multi.tasks[1]?.enabled).toBe(false);
    expect(multi.handlers.size).toBe(2);
  });

  test("rejects modules that violate the Pi-style injection contract", async () => {
    const tasksDir = path.join(root, "tasks");
    await mkdir(tasksDir, { recursive: true });

    // 1. Missing default function export
    const noDefault = path.join(tasksDir, "no-default.ts");
    await writeFile(noDefault, `export const foo = 1;`);
    await expect(loadTsTaskModule(noDefault, "demo", {}, silentLogger)).rejects.toThrow(
      /must default-export a factory function/,
    );

    // 2. Factory registers nothing
    const emptyFactory = path.join(tasksDir, "empty-factory.ts");
    await writeFile(emptyFactory, `export default function (api) {}`);
    await expect(loadTsTaskModule(emptyFactory, "demo", {}, silentLogger)).rejects.toThrow(
      /did not register any task/,
    );

    // 3. Multi-task registration missing explicit id
    const multiNoId = path.join(tasksDir, "multi-no-id.ts");
    await writeFile(
      multiNoId,
      `
export default function (api) {
  api.registerTask({ id: "t1", name: "T1", cron: "* * * * *", run() {} });
  api.registerTask({ name: "T2", cron: "* * * * *", run() {} });
}
`,
    );
    await expect(loadTsTaskModule(multiNoId, "demo", {}, silentLogger)).rejects.toThrow(
      /every task must specify an explicit "id"/,
    );

    // 4. Duplicate id inside same file
    const dupId = path.join(tasksDir, "dup-id.ts");
    await writeFile(
      dupId,
      `
export default function (api) {
  api.registerTask({ id: "same", name: "T1", cron: "* * * * *", run() {} });
  api.registerTask({ id: "same", name: "T2", cron: "* * * * *", run() {} });
}
`,
    );
    await expect(loadTsTaskModule(dupId, "demo", {}, silentLogger)).rejects.toThrow(
      /Duplicate task id "same"/,
    );

    // 5. Unknown extra property or non-function run
    const badSchema = path.join(tasksDir, "bad-schema.ts");
    await writeFile(
      badSchema,
      `
export default function (api) {
  api.registerTask({ name: "Bad", cron: "* * * * *", unknownField: true, run() {} });
}
`,
    );
    await expect(loadTsTaskModule(badSchema, "demo", {}, silentLogger)).rejects.toThrow(
      /Invalid TS task registration/,
    );

    const badRun = path.join(tasksDir, "bad-run.ts");
    await writeFile(
      badRun,
      `
export default function (api) {
  api.registerTask({ name: "BadRun", cron: "* * * * *", run: "not-a-fn" });
}
`,
    );
    await expect(loadTsTaskModule(badRun, "demo", {}, silentLogger)).rejects.toThrow(
      /run must be a function/,
    );
  });

  test("TaskLoader loads .md and .ts together, skips helpers/invalid files, and prevents duplicate taskId collisions", async () => {
    const tasksDir = path.join(root, "tasks");
    await mkdir(tasksDir, { recursive: true });

    await writeFile(path.join(tasksDir, "_shared.ts"), `export const PREFIX = "ok";`);
    await writeFile(path.join(tasksDir, "invalid.ts"), `export default 123;`);
    await writeFile(
      path.join(tasksDir, "a-markdown.md"),
      `---
id: shared-id
name: Markdown Task
cron: "0 * * * *"
enabled: false
---
Markdown prompt.
`,
    );
    await writeFile(
      path.join(tasksDir, "b-typescript.ts"),
      `
import { PREFIX } from "./_shared.ts";
export default function (api) {
  api.registerTask({
    id: "shared-id",
    name: "Colliding TS Task",
    cron: "0 * * * *",
    run() {},
  });
  api.registerTask({
    id: "unique-ts",
    name: "Unique TS Task",
    cron: "0 * * * *",
    enabled: false,
    run() {
      return { summary: { prefix: PREFIX } };
    },
  });
}
`,
    );

    const loader = new TaskLoader(silentLogger);
    const tasks = await loader.loadProjectTasks(root, "demo");
    expect(tasks.map((t) => `${t.taskId}:${t.sourceFormat}`)).toEqual([
      "shared-id:markdown",
      "unique-ts:typescript",
    ]);
  });
});

describe("TypeScript task end-to-end execution, dispatch, timeout, and hot reload", () => {
  let root: string;
  let projectDir: string;
  let store: MemoryStore;
  let codexMock: CapturingRuntime;
  let manager: ProjectManager;
  let gateway: Gateway;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ao-ts-e2e-"));
    projectDir = path.join(root, "projects", "demo");
    await mkdir(path.join(projectDir, "tasks"), { recursive: true });

    store = new MemoryStore();
    codexMock = new CapturingRuntime("codex");
    const logger = new Logger({ sink: () => {} });
    const registry = new RuntimeRegistry(logger);
    registry.register("codex", () => codexMock);

    const project: ProjectConfig = {
      id: "demo",
      displayName: "Demo",
      description: "Demo project",
      projectDir,
      routing: { projectId: "demo", displayName: "Demo" },
      repository: { url: "", baseBranch: "main" },
      env: {
        CUSTOM_API_TOKEN: "secret_token_xyz",
      },
      runtime: {
        type: "codex",
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
      },
    };

    const config: AppConfig = {
      defaultRuntime: "codex",
      host: "127.0.0.1",
      port: 7070,
      logLevel: "error",
      dataDir: path.join(root, "data"),
      artifactDir: path.join(root, "artifacts"),
      projectConfigPath: path.join(root, "projects"),
      allowUnauthenticated: true,
      routerBaseUrl: "http://localhost:8317/v1",
      feishu: { enabled: false },
    };

    manager = new ProjectManager([project], store, config, logger, undefined, undefined, registry);
    await manager.start();
    gateway = new Gateway(config, store, manager, logger);
  });

  afterEach(async () => {
    await gateway.stop();
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("executes multi-task TS module with injected capabilities, persists state, and dispatches sessions with project defaults", async () => {
    const taskFile = path.join(projectDir, "tasks", "pipeline.ts");
    await writeFile(
      taskFile,
      `
export default function (api) {
  api.registerTask({
    id: "poll-and-dispatch",
    name: "Poll and Dispatch",
    cron: "0 0 * * *",
    enabled: false,
    description: "Deterministic TS polling that dispatches an agent session on demand",
    async run(ctx) {
      const prev = await ctx.getState();
      const count = typeof prev.count === "number" ? prev.count + 1 : 1;
      const dispatched = await ctx.dispatchTask({
        title: "dev(ts-poll): handle #" + count,
        prompt: "Process item #" + count + " using token " + Boolean(ctx.env.CUSTOM_API_TOKEN),
        metadata: { runCount: count },
      });
      await ctx.createArtifact({
        kind: "poll-report",
        content: "count=" + count,
        contentType: "text/plain",
      });
      await ctx.notify({
        title: "TS Task Dispatched",
        text: "Dispatched session " + dispatched.sessionId,
        level: "info",
      });
      return {
        state: { count, lastSessionId: dispatched.sessionId },
        summary: {
          count,
          tokenSeen: ctx.env.CUSTOM_API_TOKEN === "secret_token_xyz",
          dispatchedSessionId: dispatched.sessionId,
        },
      };
    },
  });

  api.registerTask({
    id: "check-counter",
    name: "Check Counter",
    cron: "0 0 * * *",
    enabled: false,
    async run(ctx) {
      await ctx.updateState({ checked: true });
      return { summary: { projectId: ctx.projectId, taskId: ctx.taskId } };
    },
  });
}
`,
    );

    // 1. Verify GET /api/v1/projects/demo/tasks exposes clean JSON metadata for both TS tasks
    const listRes = await gateway.app.request("/api/v1/projects/demo/tasks");
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as {
      tasks: Array<{ taskId: string; type?: string; sourceFormat?: string }>;
    };
    expect(listData.tasks.map((t) => t.taskId)).toEqual(["poll-and-dispatch", "check-counter"]);
    expect(listData.tasks[0]?.type).toBe("ts");
    expect(listData.tasks[0]?.sourceFormat).toBe("typescript");

    // 2. Run first task twice to verify incremental state persistence & dispatched session config
    const projectRt = manager.get("demo");
    await projectRt.runTask("poll-and-dispatch");
    await projectRt.taskEngine.drain();

    const execs1 = await store.listTaskExecutions("demo:poll-and-dispatch", 10);
    expect(execs1).toHaveLength(1);
    expect(execs1[0]?.status).toBe("success");
    expect(execs1[0]?.stateAfter?.count).toBe(1);
    expect(execs1[0]?.actionsSummary?.tokenSeen).toBe(true);

    const dispatchedId = execs1[0]?.stateAfter?.lastSessionId as string;
    expect(dispatchedId).toBeTruthy();
    await projectRt.waitForIdle(dispatchedId);

    const dispatchedSession = await store.getSession(dispatchedId);
    expect(dispatchedSession?.source).toBe("dispatch");
    expect(dispatchedSession?.runtime).toBe("codex");
    expect(dispatchedSession?.model).toBe("gpt-5.6-terra");
    expect(dispatchedSession?.reasoningEffort).toBe("high");
    expect(codexMock.startedContexts[0]?.project.runtime).toMatchObject({
      type: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });

    // Run a second time -> state.count increments to 2
    await projectRt.runTask("poll-and-dispatch");
    await projectRt.taskEngine.drain();
    const execs2 = await store.listTaskExecutions("demo:poll-and-dispatch", 10);
    expect(execs2).toHaveLength(2);
    expect(execs2[0]?.stateBefore?.count).toBe(1);
    expect(execs2[0]?.stateAfter?.count).toBe(2);

    // Run the second registered task in the same file
    await projectRt.runTask("check-counter");
    await projectRt.taskEngine.drain();
    const counterExecs = await store.listTaskExecutions("demo:check-counter", 10);
    expect(counterExecs).toHaveLength(1);
    expect(counterExecs[0]?.status).toBe("success");
    expect(counterExecs[0]?.stateAfter).toEqual({ checked: true });
    expect(counterExecs[0]?.actionsSummary).toEqual({
      projectId: "demo",
      taskId: "check-counter",
    });
  });

  test("hot-reloads TS task code when file mtime changes and enforces timeoutMs", async () => {
    const taskFile = path.join(projectDir, "tasks", "hot-reload.ts");
    await writeFile(
      taskFile,
      `
export default function (api) {
  api.registerTask({
    id: "hot-reload",
    name: "Hot Reload Task",
    cron: "0 0 * * *",
    enabled: false,
    async run() {
      return { state: { version: 1 }, summary: { version: 1 } };
    },
  });
}
`,
    );

    const projectRt = manager.get("demo");
    await projectRt.runTask("hot-reload");
    await projectRt.taskEngine.drain();

    let execs = await store.listTaskExecutions("demo:hot-reload", 10);
    expect(execs[0]?.stateAfter).toEqual({ version: 1 });

    // Edit file on disk and bump mtime explicitly to guarantee mtime delta on fast filesystems
    await writeFile(
      taskFile,
      `
export default function (api) {
  api.registerTask({
    id: "hot-reload",
    name: "Hot Reload Task",
    cron: "0 0 * * *",
    enabled: false,
    async run() {
      return { state: { version: 2 }, summary: { version: 2 } };
    },
  });
}
`,
    );
    const future = new Date(Date.now() + 2000);
    await utimes(taskFile, future, future);

    await projectRt.runTask("hot-reload");
    await projectRt.taskEngine.drain();

    execs = await store.listTaskExecutions("demo:hot-reload", 10);
    expect(execs[0]?.status).toBe("success");
    expect(execs[0]?.stateAfter).toEqual({ version: 2 });

    // Timeout enforcement test: uncooperative async handler aborts cleanly without mutating state
    const timeoutFile = path.join(projectDir, "tasks", "slow-task.ts");
    await writeFile(
      timeoutFile,
      `
export default function (api) {
  api.registerTask({
    id: "slow-task",
    name: "Slow Task",
    cron: "0 0 * * *",
    enabled: false,
    timeoutMs: 80,
    async run() {
      await new Promise(() => {});
    },
  });
}
`,
    );

    await projectRt.runTask("slow-task");
    await projectRt.taskEngine.drain();

    const timeoutExecs = await store.listTaskExecutions("demo:slow-task", 10);
    expect(timeoutExecs).toHaveLength(1);
    expect(timeoutExecs[0]?.status).toBe("failed");
    expect(timeoutExecs[0]?.errorMessage).toMatch(/timed out/i);
  });
});
