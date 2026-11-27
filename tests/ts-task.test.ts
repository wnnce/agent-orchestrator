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

const SDK = JSON.stringify(path.resolve(import.meta.dir, "../src/task/sdk.ts"));

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

  test("loads a single task with the file name as id, and an array of tasks with their ids", async () => {
    const tasksDir = path.join(root, "tasks");
    await mkdir(tasksDir, { recursive: true });

    const singleFile = path.join(tasksDir, "ping-health.ts");
    await writeFile(
      singleFile,
      `import { defineTask } from ${SDK};
export default defineTask({
  name: "Ping Health",
  cron: "*/5 * * * *",
  enabled: false,
  run(ctx) {
    return { ok: true, project: ctx.project.id };
  },
});
`,
    );

    const single = await loadTsTaskModule(singleFile, "demo");
    expect(single.tasks).toHaveLength(1);
    expect(single.tasks[0]?.taskId).toBe("ping-health");
    expect(single.tasks[0]?.taskKey).toBe("demo:ping-health");
    expect(single.tasks[0]?.type).toBe("ts");
    expect(single.tasks[0]?.sourceFormat).toBe("typescript");

    const multiFile = path.join(tasksDir, "github-suite.ts");
    await writeFile(
      multiFile,
      `import { defineTask } from ${SDK};
export default [
  defineTask({ id: "scan-issues", name: "Scan Issues", cron: "*/10 * * * *", run() {} }),
  defineTask({
    id: "scan-prs",
    name: "Scan PRs",
    cron: "*/15 * * * *",
    timezone: "Asia/Shanghai",
    enabled: false,
    run() {},
  }),
];
`,
    );

    const multi = await loadTsTaskModule(multiFile, "demo");
    expect(multi.tasks.map((t) => t.taskId)).toEqual(["scan-issues", "scan-prs"]);
    expect(multi.tasks[1]?.timezone).toBe("Asia/Shanghai");
    expect(multi.tasks[1]?.enabled).toBe(false);
    expect(multi.handlers.size).toBe(2);
  });

  test("rejects modules that do not export defineTask tasks", async () => {
    const tasksDir = path.join(root, "tasks");
    await mkdir(tasksDir, { recursive: true });
    const write = async (name: string, body: string) => {
      const file = path.join(tasksDir, name);
      await writeFile(file, `import { defineTask } from ${SDK};\n${body}`);
      return file;
    };

    // 1. No default export, or something other than defineTask(...)
    for (const body of [
      "export const foo = 1;",
      "export default [];",
      'export default { name: "T", cron: "* * * * *", run() {} };',
      "export default function (api) {}",
    ]) {
      const file = await write("not-a-task.ts", body);
      await expect(loadTsTaskModule(file, "demo")).rejects.toThrow(
        /must default-export defineTask/,
      );
    }

    // 2. Several tasks without explicit ids
    const multiNoId = await write(
      "multi-no-id.ts",
      `export default [
  defineTask({ id: "t1", name: "T1", cron: "* * * * *", run() {} }),
  defineTask({ name: "T2", cron: "* * * * *", run() {} }),
];`,
    );
    await expect(loadTsTaskModule(multiNoId, "demo")).rejects.toThrow(
      /every task must specify an explicit "id"/,
    );

    // 3. Duplicate id inside the same file
    const dupId = await write(
      "dup-id.ts",
      `export default [
  defineTask({ id: "same", name: "T1", cron: "* * * * *", run() {} }),
  defineTask({ id: "same", name: "T2", cron: "* * * * *", run() {} }),
];`,
    );
    await expect(loadTsTaskModule(dupId, "demo")).rejects.toThrow(/Duplicate task id "same"/);

    // 4. Unknown properties or a run that is not a function
    const badSchema = await write(
      "bad-schema.ts",
      `export default defineTask({ name: "Bad", cron: "* * * * *", unknownField: true, run() {} });`,
    );
    await expect(loadTsTaskModule(badSchema, "demo")).rejects.toThrow(/Invalid task #1/);
    const badRun = await write(
      "bad-run.ts",
      `export default defineTask({ name: "BadRun", cron: "* * * * *", run: "not-a-fn" });`,
    );
    await expect(loadTsTaskModule(badRun, "demo")).rejects.toThrow(/run must be a function/);
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
      `import { defineTask } from ${SDK};
import { PREFIX } from "./_shared.ts";
export default [
  defineTask({ id: "shared-id", name: "Colliding TS Task", cron: "0 * * * *", run() {} }),
  defineTask({
    id: "unique-ts",
    name: "Unique TS Task",
    cron: "0 * * * *",
    enabled: false,
    run() {
      return { prefix: PREFIX };
    },
  }),
];
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
      `import { defineTask } from ${SDK};
export default [
  defineTask({
    id: "poll-and-dispatch",
    name: "Poll and Dispatch",
    cron: "0 0 * * *",
    enabled: false,
    description: "Deterministic TS polling that starts an agent session on demand",
    async run(ctx) {
      const prev = ctx.state.get();
      const count = typeof prev.count === "number" ? prev.count + 1 : 1;
      const started = await ctx.sessions.start({
        title: "dev(ts-poll): handle #" + count,
        prompt: "Process item #" + count + " using token " + Boolean(ctx.project.env.CUSTOM_API_TOKEN),
        metadata: { runCount: count },
      });
      await ctx.artifacts.create({
        kind: "poll-report",
        content: "count=" + count,
        contentType: "text/plain",
      });
      await ctx.notify({
        title: "TS Task Started",
        text: "Started session " + started.sessionId,
        level: "info",
      });
      ctx.state.set({ count, lastSessionId: started.sessionId });
      return {
        count,
        tokenSeen: ctx.project.env.CUSTOM_API_TOKEN === "secret_token_xyz",
        startedSessionId: started.sessionId,
      };
    },
  }),
  defineTask({
    id: "check-counter",
    name: "Check Counter",
    cron: "0 0 * * *",
    enabled: false,
    run(ctx) {
      ctx.state.merge({ checked: true });
      return { projectId: ctx.project.id, taskId: ctx.task.id, origin: ctx.origin.kind };
    },
  }),
];
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
    expect(dispatchedSession?.metadata?.sourceTaskId).toBe("poll-and-dispatch");
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
      origin: "task",
    });
  });

  test("hot-reloads TS task code when file mtime changes and enforces timeoutMs", async () => {
    const taskFile = path.join(projectDir, "tasks", "hot-reload.ts");
    await writeFile(
      taskFile,
      `import { defineTask } from ${SDK};
export default defineTask({
  id: "hot-reload",
  name: "Hot Reload Task",
  cron: "0 0 * * *",
  enabled: false,
  run(ctx) {
    ctx.state.set({ version: 1 });
    return { version: 1 };
  },
});
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
      `import { defineTask } from ${SDK};
export default defineTask({
  id: "hot-reload",
  name: "Hot Reload Task",
  cron: "0 0 * * *",
  enabled: false,
  run(ctx) {
    ctx.state.set({ version: 2 });
    return { version: 2 };
  },
});
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
      `import { defineTask } from ${SDK};
export default defineTask({
  id: "slow-task",
  name: "Slow Task",
  cron: "0 0 * * *",
  enabled: false,
  timeoutMs: 80,
  async run(ctx) {
    ctx.state.set({ touched: true });
    await new Promise(() => {});
  },
});
`,
    );

    await projectRt.runTask("slow-task");
    await projectRt.taskEngine.drain();

    const timeoutExecs = await store.listTaskExecutions("demo:slow-task", 10);
    expect(timeoutExecs).toHaveLength(1);
    expect(timeoutExecs[0]?.status).toBe("failed");
    expect(timeoutExecs[0]?.errorMessage).toMatch(/timed out/i);
    // A failed execution keeps the state it started with
    expect(timeoutExecs[0]?.stateAfter).toEqual({});
  });
});
