import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/persistence/store.ts";
import {
  parseTaskMarkdown,
  TaskEngine,
  TaskLoader,
  TaskScheduler,
  TaskExecutorRegistry,
  AgentTaskExecutor,
  type AgentSessionRunner,
  type TaskDefinition,
} from "../src/task/index.ts";
import { MockTaskExecutor } from "./helpers/mock-executor.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import type { AppConfig } from "../src/config/config.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { createGateway } from "./helpers/gateway.ts";
import { Logger } from "../src/observability/logger.ts";

describe("TaskLoader", () => {
  it("parses valid task markdown with YAML frontmatter and prompt body", () => {
    const markdown = `---
id: check-pending-pr
name: Check Pending PRs
cron: "*/5 * * * *"
timezone: "Asia/Shanghai"
enabled: true
description: "Checks PRs that need review"
---
Please check github for PRs in project {{project.id}}.
Current state is: {{state}}
`;

    const task = parseTaskMarkdown(
      markdown,
      "/projects/my-project/tasks/check-pending-pr.md",
      "my-project",
    );

    expect(task.taskKey).toBe("my-project:check-pending-pr");
    expect(task.projectId).toBe("my-project");
    expect(task.taskId).toBe("check-pending-pr");
    expect(task.name).toBe("Check Pending PRs");
    expect(task.cron).toBe("*/5 * * * *");
    expect(task.timezone).toBe("Asia/Shanghai");
    expect(task.enabled).toBe(true);
    expect(task.description).toBe("Checks PRs that need review");
    expect(task.promptTemplate).toContain("Please check github for PRs");
    expect(task.filePath).toBe("/projects/my-project/tasks/check-pending-pr.md");
  });

  it("defaults taskId to markdown basename if id is omitted in frontmatter", () => {
    const markdown = `---
name: Auto Cleanup
cron: "0 0 * * *"
---
Run cleanup routine.
`;

    const task = parseTaskMarkdown(
      markdown,
      "/projects/proj-1/tasks/auto-cleanup.md",
      "proj-1",
    );

    expect(task.taskId).toBe("auto-cleanup");
    expect(task.taskKey).toBe("proj-1:auto-cleanup");
    expect(task.enabled).toBe(true);
  });

  it("throws descriptive error when frontmatter is missing", () => {
    const invalid = "Just some markdown content without frontmatter fences";
    expect(() => parseTaskMarkdown(invalid, "/dummy/task.md", "proj")).toThrow(
      /Missing YAML frontmatter block/,
    );
  });

  it("throws error when required fields like cron or name are missing", () => {
    const missingCron = `---
name: Only Name
---
Prompt body
`;
    expect(() => parseTaskMarkdown(missingCron, "/dummy/task.md", "proj")).toThrow(
      /Frontmatter validation failed/,
    );
  });

  it("scans and loads tasks from tasks/*.md directory", async () => {
    const tmpDir = path.resolve(import.meta.dir, ".tmp-tasks-test");
    const tasksDir = path.join(tmpDir, "tasks");
    await mkdir(tasksDir, { recursive: true });

    try {
      await writeFile(
        path.join(tasksDir, "task1.md"),
        `---
name: Task One
cron: "*/10 * * * *"
---
Task one prompt
`,
      );
      await writeFile(
        path.join(tasksDir, "task2.md"),
        `---
name: Task Two
cron: "0 12 * * *"
enabled: false
---
Task two prompt
`,
      );
      // Non-md file should be ignored
      await writeFile(path.join(tasksDir, "notes.txt"), "ignored file");

      const loader = new TaskLoader();
      const tasks = await loader.loadProjectTasks(tmpDir, "test-proj");

      expect(tasks).toHaveLength(2);
      const task1 = tasks.find((t) => t.taskId === "task1");
      const task2 = tasks.find((t) => t.taskId === "task2");

      expect(task1?.name).toBe("Task One");
      expect(task1?.enabled).toBe(true);
      expect(task2?.name).toBe("Task Two");
      expect(task2?.enabled).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array gracefully if tasks directory does not exist", async () => {
    const loader = new TaskLoader();
    const tasks = await loader.loadProjectTasks("/non/existent/dir", "test-proj");
    expect(tasks).toEqual([]);
  });

  it("parses nested runtime, model, and reasoningEffort override from frontmatter", () => {
    const markdown = `---
id: triage-issues
name: Triage Issues
cron: "*/30 * * * *"
runtime:
  type: claude
  model: claude-haiku-5-5
  reasoningEffort: low
---
Inspect open issues.
`;

    const task = parseTaskMarkdown(
      markdown,
      "/projects/my-project/tasks/triage-issues.md",
      "my-project",
    );

    expect(task.runtime).toEqual({
      type: "claude",
      model: "claude-haiku-5-5",
      reasoningEffort: "low",
    });
  });

  it("omits runtime when frontmatter runtime object is empty and rejects invalid keys or effort", () => {
    const emptyRuntime = `---
name: Empty Runtime
cron: "0 * * * *"
runtime: {}
---
Prompt body
`;
    expect(parseTaskMarkdown(emptyRuntime, "/dummy/empty.md", "proj").runtime).toBeUndefined();

    const invalidEffort = `---
name: Bad Effort
cron: "0 * * * *"
runtime:
  type: claude
  reasoningEffort: turbo
---
Prompt body
`;
    expect(() => parseTaskMarkdown(invalidEffort, "/dummy/bad-effort.md", "proj")).toThrow(
      /Frontmatter validation failed/,
    );

    const unknownKey = `---
name: Unknown Runtime Key
cron: "0 * * * *"
runtime:
  type: claude
  mode: claude-haiku-5-5
---
Prompt body
`;
    expect(() => parseTaskMarkdown(unknownKey, "/dummy/bad-key.md", "proj")).toThrow(
      /Frontmatter validation failed/,
    );
  });
});

describe("TaskEngine", () => {
  const dummyTask: TaskDefinition = {
    taskKey: "p1:sync-issues",
    projectId: "p1",
    taskId: "sync-issues",
    name: "Sync Issues",
    cron: "*/5 * * * *",
    enabled: true,
    promptTemplate: "Sync issues",
    type: "agent",
    filePath: "/dummy/path.md",
  };

  it("single-flight prevents overlapping execution", () => {
    const engine = new TaskEngine();

    // Disallow executor from completing immediately
    let finishExecution: () => void = () => {};
    engine.setExecutor(async () => {
      await new Promise<void>((resolve) => {
        finishExecution = resolve;
      });
      return {
        success: true,
        durationMs: 10,
        stateBefore: {},
        stateAfter: { lastRun: 1 },
      };
    });

    const first = engine.dispatch(dummyTask);
    expect(first).toBe(true);
    expect(engine.isTaskRunning(dummyTask.taskKey)).toBe(true);

    // Second dispatch while first is running should be rejected
    const second = engine.dispatch(dummyTask);
    expect(second).toBe(false);

    finishExecution();
  });

  it("processes queue with maxConcurrency limit and records execution into Store", async () => {
    const store = new MemoryStore();
    const engine = new TaskEngine(store, undefined, { maxConcurrency: 2 });

    let runningCount = 0;
    let maxObservedRunning = 0;

    engine.setExecutor(async (_task, state) => {
      runningCount++;
      if (runningCount > maxObservedRunning) {
        maxObservedRunning = runningCount;
      }
      await new Promise((r) => setTimeout(r, 20));
      runningCount--;

      const count = Number(state.count ?? 0) + 1;
      return {
        success: true,
        durationMs: 20,
        stateBefore: state,
        stateAfter: { count },
      };
    });

    const tasks: TaskDefinition[] = [1, 2, 3, 4].map((i) => ({
      taskKey: `p1:task-${i}`,
      projectId: "p1",
      taskId: `task-${i}`,
      name: `Task ${i}`,
      cron: "* * * * *",
      enabled: true,
      promptTemplate: "Run",
      type: "agent",
      filePath: `/p1/task-${i}.md`,
    }));

    for (const t of tasks) {
      engine.dispatch(t);
    }

    await engine.drain();

    expect(maxObservedRunning).toBeLessThanOrEqual(2);
    expect(engine.getActiveWorkers()).toBe(0);
    expect(engine.getQueueLength()).toBe(0);

    // Verify executions were recorded into store
    for (const t of tasks) {
      const executions = await store.listTaskExecutions(t.taskKey);
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("success");
      expect(executions[0]?.stateAfter).toEqual({ count: 1 });
    }
  });

  it("hydrates state on cold start from Store audit logs", async () => {
    const store = new MemoryStore();

    // Pre-populate an execution record
    await store.recordTaskExecution({
      executionId: "exec_old",
      taskKey: "p1:sync",
      projectId: "p1",
      taskId: "sync",
      taskType: "project_task",
      status: "success",
      durationMs: 100,
      stateBefore: {},
      stateAfter: { cursor: "pr_100", lastSyncTime: 1700000000 },
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
    });

    const engine = new TaskEngine(store);

    // Cold start getState should fetch from store
    const state = await engine.getState("p1:sync");
    expect(state).toEqual({ cursor: "pr_100", lastSyncTime: 1700000000 });

    // In-memory update
    engine.updateState("p1:sync", { cursor: "pr_105" });
    const updated = await engine.getState("p1:sync");
    expect(updated).toEqual({ cursor: "pr_105" });
  });
});

describe("TaskScheduler", () => {
  it("schedules, triggers, and unschedules tasks using Croner", async () => {
    const engine = new TaskEngine();
    let dispatched = false;

    // Override engine dispatch to monitor calls
    engine.dispatch = (task) => {
      dispatched = true;
      return true;
    };

    const scheduler = new TaskScheduler(engine);

    const task: TaskDefinition = {
      taskKey: "p1:minutely",
      projectId: "p1",
      taskId: "minutely",
      name: "Minutely Task",
      cron: "* * * * *",
      enabled: true,
      promptTemplate: "Do something",
      type: "agent",
      filePath: "/tasks/minutely.md",
    };

    const scheduled = scheduler.scheduleTask(task);
    expect(scheduled).toBe(true);
    expect(scheduler.isScheduled("p1:minutely")).toBe(true);

    const nextRun = scheduler.getNextRun("p1:minutely");
    expect(nextRun).toBeInstanceOf(Date);
    expect(nextRun!.getTime()).toBeGreaterThan(Date.now());

    const activeList = scheduler.getScheduledTasks();
    expect(activeList).toHaveLength(1);
    expect(activeList[0]?.taskKey).toBe("p1:minutely");

    // Unschedule
    const unscheduled = scheduler.unscheduleTask("p1:minutely");
    expect(unscheduled).toBe(true);
    expect(scheduler.isScheduled("p1:minutely")).toBe(false);

    scheduler.stop();
  });

  it("skips disabled tasks and rejects invalid cron expressions safely", () => {
    const engine = new TaskEngine();
    const scheduler = new TaskScheduler(engine);

    const disabledTask: TaskDefinition = {
      taskKey: "p1:disabled",
      projectId: "p1",
      taskId: "disabled",
      name: "Disabled Task",
      cron: "* * * * *",
      enabled: false,
      promptTemplate: "Do nothing",
      type: "agent",
      filePath: "/tasks/disabled.md",
    };
    expect(scheduler.scheduleTask(disabledTask)).toBe(false);
    expect(scheduler.isScheduled("p1:disabled")).toBe(false);

    const invalidCronTask: TaskDefinition = {
      taskKey: "p1:invalid",
      projectId: "p1",
      taskId: "invalid",
      name: "Invalid Cron Task",
      cron: "invalid cron expression",
      enabled: true,
      promptTemplate: "Fail",
      type: "agent",
      filePath: "/tasks/invalid.md",
    };
    expect(scheduler.scheduleTask(invalidCronTask)).toBe(false);
    expect(scheduler.isScheduled("p1:invalid")).toBe(false);

    scheduler.stop();
  });

  it("reloads tasks diffing added, modified, and removed tasks", () => {
    const engine = new TaskEngine();
    const scheduler = new TaskScheduler(engine);

    const taskA: TaskDefinition = {
      taskKey: "p1:a",
      projectId: "p1",
      taskId: "a",
      name: "Task A",
      cron: "0 * * * *",
      enabled: true,
      promptTemplate: "A",
      type: "agent",
      filePath: "/tasks/a.md",
    };

    const taskB: TaskDefinition = {
      taskKey: "p1:b",
      projectId: "p1",
      taskId: "b",
      name: "Task B",
      cron: "0 0 * * *",
      enabled: true,
      promptTemplate: "B",
      type: "agent",
      filePath: "/tasks/b.md",
    };

    // Initial load: taskA & taskB
    scheduler.reloadTasks([taskA, taskB]);
    expect(scheduler.getScheduledTasks()).toHaveLength(2);

    // Second load: taskA removed, taskB cron modified, taskC added
    const taskBModified: TaskDefinition = {
      ...taskB,
      cron: "*/30 * * * *",
    };
    const taskC: TaskDefinition = {
      taskKey: "p1:c",
      projectId: "p1",
      taskId: "c",
      name: "Task C",
      cron: "0 12 * * *",
      enabled: true,
      promptTemplate: "C",
      type: "agent",
      filePath: "/tasks/c.md",
    };

    scheduler.reloadTasks([taskBModified, taskC]);

    expect(scheduler.isScheduled("p1:a")).toBe(false);
    expect(scheduler.isScheduled("p1:b")).toBe(true);
    expect(scheduler.isScheduled("p1:c")).toBe(true);

    const scheduledB = scheduler.getScheduledTasks().find((t) => t.taskKey === "p1:b");
    expect(scheduledB?.cron).toBe("*/30 * * * *");

    scheduler.stop();
    expect(scheduler.getScheduledTasks()).toHaveLength(0);
  });
});

describe("ProjectRuntime Task Integration", () => {
  it("renders prompt templates with standard variables and field extractions", () => {
    const store = new MemoryStore();
    const project: ProjectConfig = {
      id: "demo",
      displayName: "Demo",
      description: "Demo project",
      routing: { projectId: "demo" },
    };
    const runtime = new ProjectRuntime(
      project,
      store,
      new FakeRuntime(),
      new WorkspaceManager("/tmp"),
      new ArtifactStore("/tmp", store),
    );

    const template = `Project: {{project.id}}
Task: {{task.id}} (Key: {{task.key}}, Name: {{task.name}})
Current PR Cursor: {{state.lastPr}}
Full state:
{{state}}`;

    const rendered = runtime.renderTaskPrompt(template, {
      projectId: "demo",
      taskId: "poll-prs",
      taskKey: "demo:poll-prs",
      taskName: "Poll GitHub PRs",
      state: { lastPr: 42, count: 5 },
    });

    expect(rendered).toContain("Project: demo");
    expect(rendered).toContain("Task: poll-prs (Key: demo:poll-prs, Name: Poll GitHub PRs)");
    expect(rendered).toContain("Current PR Cursor: 42");
    expect(rendered).toContain('"lastPr": 42');
    expect(rendered).toContain('"count": 5');
  });

  it("executes task end-to-end, records audit log in store, and cleans up session workspace", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "task-runtime-test-"));
    const store = new MemoryStore();
    const workspaces = new WorkspaceManager(
      path.join(tmpDir, "workspaces"),
      path.join(tmpDir, "bases"),
    );
    const artifacts = new ArtifactStore(path.join(tmpDir, "artifacts"), store);

    const project: ProjectConfig = {
      id: "test-proj",
      displayName: "Test Project",
      description: "Integration test",
      routing: { projectId: "test-proj" },
      repository: { url: "", baseBranch: "main" },
      projectDir: tmpDir,
    };

    const tasksDir = path.join(tmpDir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    await writeFile(
      path.join(tasksDir, "cleanup-task.md"),
      `---
id: cleanup-task
name: Cleanup Task
cron: "0 0 * * *"
---
Clean up project {{project.id}} with state: {{state}}
`,
    );

    const runtime = new ProjectRuntime(
      project,
      store,
      new FakeRuntime(),
      workspaces,
      artifacts,
    );

    try {
      await runtime.start();

      const task = (await runtime.listTasks())[0]!;
      expect(task).toBeDefined();

      // Set initial state
      runtime.taskEngine.updateState(task.taskKey, { lastCleanedAt: 1000 });

      // Dispatch task via engine
      const dispatchedFirst = runtime.taskEngine.dispatch(task);
      expect(dispatchedFirst).toBe(true);

      await runtime.taskEngine.drain();

      // Verify audit record written to store
      const executions = await store.listTaskExecutions(task.taskKey);
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("success");
      expect(executions[0]?.taskKey).toBe("test-proj:cleanup-task");
      expect(executions[0]?.projectId).toBe("test-proj");
      expect(executions[0]?.taskId).toBe("cleanup-task");
      expect(executions[0]?.stateBefore).toEqual({ lastCleanedAt: 1000 });

      // Verify task session transitioned to closed (retained for audit, but excluded from active chat sessions)
      const execution = executions[0];
      if (!execution?.sessionId) throw new Error("Expected a task execution with a session ID");
      const sessionAfter = await store.getSession(execution.sessionId);
      expect(sessionAfter?.status).toBe("closed");
      const userSessions = await store.listSessions(project.id);
      expect(userSessions.some((s) => s.sessionId === execution.sessionId)).toBe(false);

      // Manually trigger runTask via engine dispatch
      const dispatched = await runtime.runTask("cleanup-task");
      expect(dispatched).toBe(true);

      await runtime.taskEngine.drain();

      const secondExecutions = await store.listTaskExecutions(task.taskKey);
      expect(secondExecutions).toHaveLength(2);
    } finally {
      await runtime.stop();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("gateway exposes tasks listing, manual run trigger, and executions query endpoints", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "task-gateway-test-"));
    const tasksDir = path.join(tmpDir, "tasks");
    await mkdir(tasksDir, { recursive: true });

    await writeFile(
      path.join(tasksDir, "daily-sync.md"),
      `---
id: daily-sync
name: Daily Sync
cron: "0 9 * * *"
---
Sync daily updates.
`,
    );

    const store = new MemoryStore();
    const logger = new Logger();

    const project: ProjectConfig = {
      id: "gw-proj",
      displayName: "Gateway Project",
      description: "Gateway test",
      routing: { projectId: "gw-proj" },
      repository: { url: "", baseBranch: "main" },
      projectDir: tmpDir,
      runtime: { type: "fake" },
    };

    const config: AppConfig = {
      port: 0,
      host: "127.0.0.1",
      dataDir: tmpDir,
      artifactDir: path.join(tmpDir, "artifacts"),
      projectConfigPath: tmpDir,
      allowUnauthenticated: true,
      logLevel: "info",
      routerBaseUrl: "http://localhost:8317/v1",
      feishu: { enabled: false },
    };

    const projectManager = new ProjectManager([project], store, config, logger);
    await projectManager.start();

    const gateway = createGateway(config, store, projectManager, logger);

    try {
      // 1. GET /api/v1/projects/:projectId/tasks
      const listRes = await gateway.app.request("/api/v1/projects/gw-proj/tasks");
      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.projectId).toBe("gw-proj");
      expect(listData.tasks).toHaveLength(1);
      expect(listData.tasks[0].taskId).toBe("daily-sync");
      expect(listData.tasks[0].name).toBe("Daily Sync");
      expect(listData.tasks[0].isScheduled).toBe(true);
      expect(listData.tasks[0].nextRun).toBeDefined();

      // 2. POST /api/v1/projects/:projectId/tasks/:taskId/run
      const runRes = await gateway.app.request(
        "/api/v1/projects/gw-proj/tasks/daily-sync/run",
        { method: "POST" },
      );
      expect(runRes.status).toBe(200);
      const runData = await runRes.json();
      expect(runData.queued).toBe(true);

      const runtime = projectManager.get("gw-proj");
      await runtime.taskEngine.drain();

      // 3. GET /api/v1/projects/:projectId/tasks/:taskId/executions
      const execRes = await gateway.app.request(
        "/api/v1/projects/gw-proj/tasks/daily-sync/executions",
      );
      expect(execRes.status).toBe(200);
      const execData = await execRes.json();
      expect(execData.taskKey).toBe("gw-proj:daily-sync");
      expect(execData.executions).toHaveLength(1);
      expect(execData.executions[0].status).toBe("success");
    } finally {
      await projectManager.stop();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("TaskExecutorRegistry & Modular Executors", () => {
    const dummyTask: TaskDefinition = {
      taskKey: "p1:t1",
      projectId: "p1",
      taskId: "t1",
      name: "T1",
      cron: "* * * * *",
      enabled: true,
      promptTemplate: "Hello",
      type: "agent",
      filePath: "/tasks/t1.md",
    };

    it("TaskExecutorRegistry registers, resolves, and manages executors", () => {
      const registry = new TaskExecutorRegistry();
      const mockExecutor = new MockTaskExecutor();
      registry.register(mockExecutor);

      expect(registry.has("mock")).toBe(true);
      expect(registry.get("mock")).toBe(mockExecutor);
      expect(registry.getAll()).toContain(mockExecutor);

      // Resolves by matching type
      const resolved = registry.resolve({ ...dummyTask, type: "mock" });
      expect(resolved).toBe(mockExecutor);

      // Throws on unhandled type
      expect(() => registry.resolve({ ...dummyTask, type: "unknown" })).toThrow(
        /No task executor found capable of handling task/,
      );

      registry.unregister("mock");
      expect(registry.has("mock")).toBe(false);
    });

    it("MockTaskExecutor executes in 0ms with simulated states and records calls", async () => {
      const store = new MemoryStore();
      const mockExecutor = new MockTaskExecutor({
        success: true,
        stateAfter: { lastCheckedId: 100 },
        actionsSummary: { mocked: true },
      });

      const registry = new TaskExecutorRegistry();
      registry.register(mockExecutor);

      const engine = new TaskEngine(store, undefined, { registry });
      const task: TaskDefinition = {
        ...dummyTask,
        taskKey: "p1:mock-test",
        taskId: "mock-test",
        type: "mock",
      };

      engine.dispatch(task);
      await engine.drain();

      expect(mockExecutor.calls).toHaveLength(1);
      expect(mockExecutor.calls[0]?.task.taskKey).toBe("p1:mock-test");

      // Check store audit log
      const executions = await store.listTaskExecutions("p1:mock-test");
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("success");
      expect(executions[0]?.stateAfter).toEqual({ lastCheckedId: 100 });
      expect(executions[0]?.actionsSummary).toEqual({ mocked: true });
    });

    it("MockTaskExecutor simulates failure and records error into store", async () => {
      const store = new MemoryStore();
      const mockExecutor = new MockTaskExecutor({
        success: false,
        error: "Simulated database connection failure",
      });

      const registry = new TaskExecutorRegistry();
      registry.register(mockExecutor);

      const engine = new TaskEngine(store, undefined, { registry });
      const task: TaskDefinition = {
        ...dummyTask,
        taskKey: "p1:mock-fail",
        taskId: "mock-fail",
        type: "mock",
      };

      engine.dispatch(task);
      await engine.drain();

      const executions = await store.listTaskExecutions("p1:mock-fail");
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("failed");
      expect(executions[0]?.errorMessage).toBe("Simulated database connection failure");
    });

    it("AgentTaskExecutor orchestrates session lifecycle and guarantees cleanup", async () => {
      let sessionCreated = false;
      let turnRun = false;
      let sessionCleanedUp = false;

      const fakeRunner: AgentSessionRunner = {
        createSession: async () => {
          sessionCreated = true;
          return { sessionId: "ses_fake_123" };
        },
        renderPrompt: (template, data) => `${template} for ${data.projectId}`,
        runTurn: async (_sessionId, input) => {
          turnRun = true;
          expect(input).toBe("Analyze issues for p1");
          return { turnId: "turn_1", status: "completed" };
        },
        cleanupSession: async (sessionId) => {
          expect(sessionId).toBe("ses_fake_123");
          sessionCleanedUp = true;
        },
        getTaskState: async () => ({ updated: true }),
      };

      const executor = new AgentTaskExecutor(fakeRunner);
      const task: TaskDefinition = {
        ...dummyTask,
        taskKey: "p1:agent-test",
        taskId: "agent-test",
        type: "agent",
        promptTemplate: "Analyze issues",
      };

      const result = await executor.execute({
        executionId: "exec_test",
        task,
        stateBefore: {},
      });

      expect(result.success).toBe(true);
      expect(sessionCreated).toBe(true);
      expect(turnRun).toBe(true);
      expect(sessionCleanedUp).toBe(true);
      expect(result.stateAfter).toEqual({ updated: true });
    });

    it("AgentTaskExecutor cleans up session even when turn execution throws", async () => {
      let sessionCleanedUp = false;

      const fakeRunner: AgentSessionRunner = {
        createSession: async () => ({ sessionId: "ses_err" }),
        renderPrompt: () => "Prompt",
        runTurn: async () => {
          throw new Error("Codex connection interrupted");
        },
        cleanupSession: async () => {
          sessionCleanedUp = true;
        },
        getTaskState: async () => ({}),
      };

      const executor = new AgentTaskExecutor(fakeRunner);
      const task: TaskDefinition = {
        ...dummyTask,
        taskKey: "p1:agent-fail",
        taskId: "agent-fail",
        type: "agent",
      };

      const result = await executor.execute({
        executionId: "exec_test",
        task,
        stateBefore: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Codex connection interrupted");
      expect(sessionCleanedUp).toBe(true);
    });
  });
});
