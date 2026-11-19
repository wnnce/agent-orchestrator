import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { MemoryStore } from "../src/persistence/store.ts";
import {
  TaskEngine,
  TaskExecutorRegistry,
  ScriptTaskExecutor,
  ActionTaskExecutor,
  AgentTaskExecutor,
  type AgentSessionRunner,
  type TaskDefinition,
} from "../src/task/index.ts";
import { MockTaskExecutor } from "./helpers/mock-executor.ts";
import { ActionRegistry } from "../src/actions/index.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { FakeRuntime } from "../src/runtime/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { Logger } from "../src/observability/logger.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import type { AppConfig } from "../src/config/config.ts";

describe("Task Real-World Scenarios Simulation", () => {
  const baseTask: TaskDefinition = {
    taskKey: "sim-proj:demo-task",
    projectId: "sim-proj",
    taskId: "demo-task",
    name: "Demo Task",
    cron: "*/5 * * * *",
    enabled: true,
    promptTemplate: "Run analysis for {{projectId}} with state: {{state.cursor}}",
    filePath: "/sim-proj/tasks/demo-task.md",
  };

  // --------------------------------------------------------------------------
  // Scenario 1: Incremental State & Cursor Progression + Cold Restart
  // --------------------------------------------------------------------------
  describe("Scenario 1: State & Cursor Progression Across Executions", () => {
    it("progresses cursor state across multiple sequential task executions", async () => {
      const store = new MemoryStore();
      const registry = new TaskExecutorRegistry();

      // Executor that increments cursor on each run
      const mockExec = new MockTaskExecutor({
        handler: async (ctx) => {
          const currentCursor = Number(ctx.stateBefore["cursor"] ?? 0);
          const nextCursor = currentCursor + 15;
          return {
            success: true,
            durationMs: 5,
            stateBefore: ctx.stateBefore,
            stateAfter: {
              cursor: nextCursor,
              batch: Number(ctx.stateBefore["batch"] ?? 0) + 1,
            },
          };
        },
      });
      registry.register(mockExec);

      const engine = new TaskEngine(store, undefined, { registry });
      const task: TaskDefinition = { ...baseTask, type: "mock" };

      // Round 1
      engine.dispatch(task);
      await engine.drain();
      let state = await engine.getState(task.taskKey);
      expect(state["cursor"]).toBe(15);
      expect(state["batch"]).toBe(1);

      // Round 2
      engine.dispatch(task);
      await engine.drain();
      state = await engine.getState(task.taskKey);
      expect(state["cursor"]).toBe(30);
      expect(state["batch"]).toBe(2);

      // Round 3
      engine.dispatch(task);
      await engine.drain();
      state = await engine.getState(task.taskKey);
      expect(state["cursor"]).toBe(45);
      expect(state["batch"]).toBe(3);

      // Verify audit history in Store
      const history = await store.listTaskExecutions(task.taskKey);
      expect(history).toHaveLength(3);
      expect(history[0]?.stateAfter).toEqual({ cursor: 45, batch: 3 });
      expect(history[1]?.stateAfter).toEqual({ cursor: 30, batch: 2 });
      expect(history[2]?.stateAfter).toEqual({ cursor: 15, batch: 1 });
    });

    it("retains previous successful state when an execution fails", async () => {
      const store = new MemoryStore();
      const registry = new TaskExecutorRegistry();

      let shouldFail = false;
      const mockExec = new MockTaskExecutor({
        handler: async (ctx) => {
          if (shouldFail) {
            return {
              success: false,
              durationMs: 2,
              stateBefore: ctx.stateBefore,
              stateAfter: ctx.stateBefore,
              error: "Simulated upstream rate limit exceeded",
            };
          }
          return {
            success: true,
            durationMs: 2,
            stateBefore: ctx.stateBefore,
            stateAfter: { cursor: 100, synced: true },
          };
        },
      });
      registry.register(mockExec);

      const engine = new TaskEngine(store, undefined, { registry });
      const task: TaskDefinition = { ...baseTask, type: "mock" };

      // Round 1 (Success)
      engine.dispatch(task);
      await engine.drain();
      expect(await engine.getState(task.taskKey)).toEqual({ cursor: 100, synced: true });

      // Round 2 (Fails)
      shouldFail = true;
      engine.dispatch(task);
      await engine.drain();

      // State MUST NOT be corrupted by the failure
      const stateAfterFailure = await engine.getState(task.taskKey);
      expect(stateAfterFailure).toEqual({ cursor: 100, synced: true });

      const executions = await store.listTaskExecutions(task.taskKey);
      expect(executions).toHaveLength(2);
      expect(executions[0]?.status).toBe("failed");
      expect(executions[0]?.errorMessage).toBe("Simulated upstream rate limit exceeded");
      expect(executions[1]?.status).toBe("success");
    });

    it("hydrates state on cold restart from audit log in Store", async () => {
      const store = new MemoryStore();

      // 1. First engine runs 2 executions
      const registry1 = new TaskExecutorRegistry();
      registry1.register(
        new MockTaskExecutor({
          handler: async (ctx) => {
            const step = Number(ctx.stateBefore["step"] ?? 0) + 1;
            return {
              success: true,
              durationMs: 1,
              stateBefore: ctx.stateBefore,
              stateAfter: { step, checkpoint: `cp_${step}` },
            };
          },
        }),
      );

      const engine1 = new TaskEngine(store, undefined, { registry: registry1 });
      const task: TaskDefinition = { ...baseTask, type: "mock" };

      engine1.dispatch(task);
      await engine1.drain();
      engine1.dispatch(task);
      await engine1.drain();
      expect(await engine1.getState(task.taskKey)).toEqual({ step: 2, checkpoint: "cp_2" });

      // 2. Simulate complete restart: new Engine instance with same store, empty memory cache
      const registry2 = new TaskExecutorRegistry();
      registry2.register(
        new MockTaskExecutor({
          handler: async (ctx) => {
            const step = Number(ctx.stateBefore["step"] ?? 0) + 1;
            return {
              success: true,
              durationMs: 1,
              stateBefore: ctx.stateBefore,
              stateAfter: { step, checkpoint: `cp_${step}` },
            };
          },
        }),
      );

      const engine2 = new TaskEngine(store, undefined, { registry: registry2 });

      // Engine 2 cold reads state
      const hydrated = await engine2.getState(task.taskKey);
      expect(hydrated).toEqual({ step: 2, checkpoint: "cp_2" });

      // Engine 2 continues running next round
      engine2.dispatch(task);
      await engine2.drain();

      const finalState = await engine2.getState(task.taskKey);
      expect(finalState).toEqual({ step: 3, checkpoint: "cp_3" });
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 2: High-Frequency Concurrent Re-entry & Single-Flight Defense
  // --------------------------------------------------------------------------
  describe("Scenario 2: High-Frequency Concurrent Re-entry Defense", () => {
    it("safely drops concurrent burst dispatches when task is in-flight", async () => {
      const store = new MemoryStore();
      const registry = new TaskExecutorRegistry();

      let resolveRun: () => void = () => {};
      let runCount = 0;

      registry.register(
        new MockTaskExecutor({
          handler: async (ctx) => {
            runCount++;
            await new Promise<void>((r) => {
              resolveRun = r;
            });
            return {
              success: true,
              durationMs: 10,
              stateBefore: ctx.stateBefore,
              stateAfter: { done: true },
            };
          },
        }),
      );

      const engine = new TaskEngine(store, undefined, { registry });
      const task: TaskDefinition = { ...baseTask, type: "mock" };

      // Dispatch #1: Starts running
      const accepted1 = engine.dispatch(task);
      expect(accepted1).toBe(true);
      expect(engine.isTaskRunning(task.taskKey)).toBe(true);

      // Concurrent burst: 10 dispatches while #1 is running
      const burstResults: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        burstResults.push(engine.dispatch(task));
      }

      // All 10 burst triggers must be rejected by single-flight
      expect(burstResults.every((res) => res === false)).toBe(true);

      // Wait a tick for worker to pick up task #1
      await new Promise((r) => setTimeout(r, 5));
      expect(runCount).toBe(1);

      // Finish #1
      resolveRun();
      await engine.drain();

      expect(engine.isTaskRunning(task.taskKey)).toBe(false);

      // Dispatch #2: Should be accepted immediately after #1 finishes
      let resolveRun2: () => void = () => {};
      registry.register(
        new MockTaskExecutor({
          handler: async (ctx) => {
            runCount++;
            resolveRun2();
            return {
              success: true,
              durationMs: 5,
              stateBefore: ctx.stateBefore,
              stateAfter: { done: true },
            };
          },
        }),
      );

      const accepted2 = engine.dispatch(task);
      expect(accepted2).toBe(true);
      await engine.drain();
      expect(runCount).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Worker Concurrency Pool & Saturation Scheduling
  // --------------------------------------------------------------------------
  describe("Scenario 3: Worker Concurrency Pool & FIFO Queue Scheduling", () => {
    it("respects maxConcurrency limit under heavy task load and drains in FIFO", async () => {
      const store = new MemoryStore();
      const registry = new TaskExecutorRegistry();

      let currentActive = 0;
      let maxActiveObserved = 0;
      const executionOrder: string[] = [];

      registry.register(
        new MockTaskExecutor({
          handler: async (ctx) => {
            currentActive++;
            if (currentActive > maxActiveObserved) {
              maxActiveObserved = currentActive;
            }
            await new Promise((r) => setTimeout(r, 15));
            executionOrder.push(ctx.task.taskId);
            currentActive--;
            return {
              success: true,
              durationMs: 15,
              stateBefore: ctx.stateBefore,
              stateAfter: {},
            };
          },
        }),
      );

      // Pool with maxConcurrency = 2
      const engine = new TaskEngine(store, undefined, { maxConcurrency: 2, registry });

      // Create 6 different tasks
      const tasks: TaskDefinition[] = [1, 2, 3, 4, 5, 6].map((i) => ({
        ...baseTask,
        taskKey: `sim-proj:task-${i}`,
        taskId: `task-${i}`,
        type: "mock",
      }));

      for (const t of tasks) {
        engine.dispatch(t);
      }

      await engine.drain();

      expect(maxActiveObserved).toBeLessThanOrEqual(2);
      expect(executionOrder).toHaveLength(6);
      expect(engine.getActiveWorkers()).toBe(0);
      expect(engine.getQueueLength()).toBe(0);
    });

    it("drain times out if a task hangs indefinitely", async () => {
      const registry = new TaskExecutorRegistry();
      registry.register(
        new MockTaskExecutor({
          handler: async () => {
            // Hang forever
            await new Promise(() => {});
            return { success: true, durationMs: 0, stateBefore: {}, stateAfter: {} };
          },
        }),
      );

      const engine = new TaskEngine(undefined, undefined, { registry });
      const task: TaskDefinition = { ...baseTask, type: "mock" };

      engine.dispatch(task);
      expect(engine.drain(50)).rejects.toThrow(/TaskEngine drain timed out after 50ms/);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Task Timeout & AbortSignal Propagation
  // --------------------------------------------------------------------------
  describe("Scenario 4: Task Timeout & AbortSignal Propagation", () => {
    it("forces task to fail when timeoutMs is exceeded in TaskEngine", async () => {
      const store = new MemoryStore();
      const registry = new TaskExecutorRegistry();

      registry.register(
        new MockTaskExecutor({
          handler: async (ctx) => {
            // Wait for 100ms
            await new Promise((r) => setTimeout(r, 100));
            return {
              success: true,
              durationMs: 100,
              stateBefore: ctx.stateBefore,
              stateAfter: { completed: true },
            };
          },
        }),
      );

      const engine = new TaskEngine(store, undefined, { registry });
      const task: TaskDefinition = {
        ...baseTask,
        taskKey: "sim-proj:timeout-task",
        taskId: "timeout-task",
        type: "mock",
        timeoutMs: 30, // 30ms limit
      };

      engine.dispatch(task);
      await engine.drain();

      const executions = await store.listTaskExecutions(task.taskKey);
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("failed");
      expect(executions[0]?.errorMessage).toContain("timed out after 30ms");
    });

    it("ScriptTaskExecutor terminates child process on timeout", async () => {
      const executor = new ScriptTaskExecutor();
      const task: TaskDefinition = {
        ...baseTask,
        type: "script",
        command: "sleep 10",
        timeoutMs: 40,
      };

      const result = await executor.execute({
        task,
        stateBefore: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out after 40ms");
      const summary = result.actionsSummary as Record<string, unknown> | undefined;
      expect(summary?.["timedOut"]).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Script Task Edge Cases
  // --------------------------------------------------------------------------
  describe("Scenario 5: ScriptTaskExecutor Real-World Parsing & Edge Cases", () => {
    it("parses JSON state from the last line of multi-line console output", async () => {
      const executor = new ScriptTaskExecutor();
      const task: TaskDefinition = {
        ...baseTask,
        type: "script",
        command: `
          echo "[2026-11-13 23:25:00] [INFO] Starting synchronization..."
          echo "[2026-11-13 23:25:01] [INFO] Processed 50 records from database"
          echo '{"syncedCount": 50, "lastSeen": 9999}'
        `,
      };

      const result = await executor.execute({
        task,
        stateBefore: { initialSetup: true },
      });

      expect(result.success).toBe(true);
      expect(result.stateAfter).toEqual({
        initialSetup: true,
        syncedCount: 50,
        lastSeen: 9999,
      });
    });

    it("handles plain text output gracefully without changing state", async () => {
      const executor = new ScriptTaskExecutor();
      const task: TaskDefinition = {
        ...baseTask,
        type: "script",
        command: 'echo "System check passed: All services nominal"',
      };

      const result = await executor.execute({
        task,
        stateBefore: { count: 1 },
      });

      expect(result.success).toBe(true);
      expect(result.stateAfter).toEqual({ count: 1 });
      const summary = result.actionsSummary as Record<string, unknown> | undefined;
      expect(String(summary?.["stdout"])).toContain("System check passed");
    });

    it("handles command not found (exit code 127) cleanly", async () => {
      const executor = new ScriptTaskExecutor();
      const task: TaskDefinition = {
        ...baseTask,
        type: "script",
        command: "non_existent_binary_xyz_12345 --foo",
      };

      const result = await executor.execute({
        task,
        stateBefore: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      const summary = result.actionsSummary as Record<string, unknown> | undefined;
      expect(summary?.["exitCode"]).toBe(127);
    });

    it("injects task context into process environment variables", async () => {
      const executor = new ScriptTaskExecutor();
      const task: TaskDefinition = {
        ...baseTask,
        type: "script",
        command:
          'printf \'{"envKey":"%s","envProject":"%s"}\' "$TASK_KEY" "$PROJECT_ID"',
      };

      const result = await executor.execute({
        task,
        stateBefore: {},
      });

      expect(result.success).toBe(true);
      expect(result.stateAfter["envKey"]).toBe("sim-proj:demo-task");
      expect(result.stateAfter["envProject"]).toBe("sim-proj");
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Action Task Invocations & Fault Injections
  // --------------------------------------------------------------------------
  describe("Scenario 6: ActionTaskExecutor Direct Invocations & Fault Injections", () => {
    it("handles Zod schema parameter validation rejection", async () => {
      const registry = new ActionRegistry();
      registry.register({
        name: "send_alert",
        description: "Sends an alert with priority",
        parameters: z.object({
          priority: z.enum(["low", "medium", "high"]),
          message: z.string().min(5),
        }),
        async handler(params) {
          return { sent: true, params };
        },
      });

      const executor = new ActionTaskExecutor(registry);
      const task: TaskDefinition = {
        ...baseTask,
        type: "action",
        action: "send_alert",
        actionParams: {
          priority: "urgent", // Invalid enum value
          message: "Hi", // Too short
        },
      };

      const result = await executor.execute({
        task,
        stateBefore: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Argument validation failed");
    });

    it("handles exceptions thrown inside Action handlers", async () => {
      const registry = new ActionRegistry();
      registry.register({
        name: "failing_action",
        description: "Throws exception",
        parameters: { type: "object" },
        async handler() {
          throw new Error("Downstream PostgreSQL connection refused");
        },
      });

      const executor = new ActionTaskExecutor(registry);
      const task: TaskDefinition = {
        ...baseTask,
        type: "action",
        action: "failing_action",
      };

      const result = await executor.execute({
        task,
        stateBefore: { safe: true },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Downstream PostgreSQL connection refused");
      expect(result.stateAfter).toEqual({ safe: true });
    });

    it("returns descriptive error when action is not registered", async () => {
      const registry = new ActionRegistry();
      const executor = new ActionTaskExecutor(registry);
      const task: TaskDefinition = {
        ...baseTask,
        type: "action",
        action: "unregistered_action_foo",
      };

      const result = await executor.execute({
        task,
        stateBefore: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Action "unregistered_action_foo" not found');
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Agent Task Lifecycle Resilience & Fault Injections
  // --------------------------------------------------------------------------
  describe("Scenario 7: AgentTaskExecutor Lifecycle & Fault Resilience", () => {
    it("renders prompt template with variables and nested state fields", async () => {
      let renderedInput = "";
      const fakeRunner: AgentSessionRunner = {
        createSession: async () => ({ sessionId: "ses_1" }),
        renderPrompt: (tpl, vars) => {
          let out = tpl.replace("{{projectId}}", vars.projectId);
          out = out.replace("{{state.cursor}}", String(vars.state["cursor"] ?? "none"));
          return out;
        },
        runTurn: async (_id, input) => {
          renderedInput = input;
          return { turnId: "turn_1", status: "completed" };
        },
        cleanupSession: async () => {},
        getTaskState: async () => ({ cursor: "cur_xyz" }),
      };

      const executor = new AgentTaskExecutor(fakeRunner);
      const task: TaskDefinition = {
        ...baseTask,
        type: "agent",
        promptTemplate: "Project: {{projectId}}, cursor: {{state.cursor}}",
      };

      const result = await executor.execute({
        task,
        stateBefore: { cursor: "12345" },
      });

      expect(result.success).toBe(true);
      expect(renderedInput).toBe("Project: sim-proj, cursor: 12345");
      expect(result.stateAfter).toEqual({ cursor: "cur_xyz" });
    });

    it("captures turn failure when Codex returns failed status", async () => {
      let cleanedUp = false;
      const fakeRunner: AgentSessionRunner = {
        createSession: async () => ({ sessionId: "ses_fail" }),
        renderPrompt: (tpl) => tpl,
        runTurn: async () => ({
          turnId: "turn_err",
          status: "failed",
          error: "Model rate limit exceeded: TPM quota reached",
        }),
        cleanupSession: async () => {
          cleanedUp = true;
        },
        getTaskState: async () => ({}),
      };

      const executor = new AgentTaskExecutor(fakeRunner);
      const task: TaskDefinition = { ...baseTask, type: "agent" };

      const result = await executor.execute({
        task,
        stateBefore: { preserved: 1 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Model rate limit exceeded: TPM quota reached");
      expect(cleanedUp).toBe(true);
      expect(result.stateAfter).toEqual({ preserved: 1 });
    });

    it("is resilient to cleanupSession failure without crashing", async () => {
      const fakeRunner: AgentSessionRunner = {
        createSession: async () => ({ sessionId: "ses_clean_fail" }),
        renderPrompt: (tpl) => tpl,
        runTurn: async () => ({ turnId: "turn_ok", status: "completed" }),
        cleanupSession: async () => {
          throw new Error("Git worktree locked by external OS process");
        },
        getTaskState: async () => ({ ok: true }),
      };

      const executor = new AgentTaskExecutor(fakeRunner);
      const task: TaskDefinition = { ...baseTask, type: "agent" };

      // Should complete without uncaught rejection
      const result = await executor.execute({
        task,
        stateBefore: {},
      });

      expect(result.success).toBe(true);
      expect(result.stateAfter).toEqual({ ok: true });
    });
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Hybrid Project Runtime with Multiple Task Types
  // --------------------------------------------------------------------------
  describe("Scenario 8: Multi-Type Hybrid Project Runtime Integration", () => {
    it("dispatches and executes script, action, and agent tasks side-by-side in one project", async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hybrid-task-"));
      const store = new MemoryStore();
      const logger = new Logger({ level: "error" });

      const projectConfig: ProjectConfig = {
        id: "hybrid-proj",
        displayName: "Hybrid Project",
        description: "Integration test for mixed task types",
        routing: { projectId: "hybrid-proj" },
        repository: { url: "", baseBranch: "main" },
        projectDir: tmpDir,
      };

      const workspaceManager = new WorkspaceManager(
        path.join(tmpDir, "workspaces"),
        path.join(tmpDir, "bases"),
      );
      const artifactStore = new ArtifactStore(path.join(tmpDir, "artifacts"), store);

      // Create tasks directory with 3 markdown definitions
      const tasksDir = path.join(tmpDir, "tasks");
      await mkdir(tasksDir, { recursive: true });

      // Task 1: script task
      await writeFile(
        path.join(tasksDir, "sync-script.md"),
        `---
id: sync-script
name: Shell Sync Task
cron: "0 * * * *"
type: script
command: 'echo "{\\"synced\\": 100}"'
---
`,
      );

      // Task 2: action task
      await writeFile(
        path.join(tasksDir, "metric-action.md"),
        `---
id: metric-action
name: Metric Action Task
cron: "*/10 * * * *"
type: action
action: report_metrics
---
`,
      );

      // Task 3: agent task
      await writeFile(
        path.join(tasksDir, "analyze-agent.md"),
        `---
id: analyze-agent
name: Agent Analysis Task
cron: "*/30 * * * *"
type: agent
---
Analyze system status.
`,
      );

      const actionRegistry = new ActionRegistry();
      let metricReported = false;
      actionRegistry.register({
        name: "report_metrics",
        description: "Direct metric reporter",
        parameters: { type: "object" },
        async handler() {
          metricReported = true;
          return { status: "healthy", state: { lastMetricCheck: "ok" } };
        },
      });

      const runtime = new ProjectRuntime(
        projectConfig,
        store,
        new FakeRuntime(),
        workspaceManager,
        artifactStore,
        undefined,
        logger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        actionRegistry,
      );

      await runtime.start();

      try {
        const loadedTasks = await runtime.listTasks();
        expect(loadedTasks).toHaveLength(3);

        // 1. Run Script Task
        const ranScript = await runtime.runTask("sync-script");
        expect(ranScript).toBe(true);
        await runtime.taskEngine.drain();

        const scriptExecs = await store.listTaskExecutions("hybrid-proj:sync-script");
        expect(scriptExecs).toHaveLength(1);
        expect(scriptExecs[0]?.status).toBe("success");
        expect(scriptExecs[0]?.stateAfter).toEqual({ synced: 100 });

        // 2. Run Action Task
        const ranAction = await runtime.runTask("metric-action");
        expect(ranAction).toBe(true);
        await runtime.taskEngine.drain();

        expect(metricReported).toBe(true);
        const actionExecs = await store.listTaskExecutions("hybrid-proj:metric-action");
        expect(actionExecs).toHaveLength(1);
        expect(actionExecs[0]?.status).toBe("success");
        expect(actionExecs[0]?.stateAfter).toEqual({ lastMetricCheck: "ok" });

        // 3. Run Agent Task (runs through FakeRuntime)
        const ranAgent = await runtime.runTask("analyze-agent");
        expect(ranAgent).toBe(true);
        await runtime.taskEngine.drain();

        const agentExecs = await store.listTaskExecutions("hybrid-proj:analyze-agent");
        expect(agentExecs).toHaveLength(1);
        expect(agentExecs[0]?.status).toBe("success");
      } finally {
        await runtime.stop();
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("auto-discovers and registers custom executor from project executors directory", async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "custom-exec-proj-"));
      const store = new MemoryStore();
      const logger = new Logger({ level: "error" });

      const projectConfig: ProjectConfig = {
        id: "custom-exec-proj",
        displayName: "Custom Executor Project",
        description: "Tests project-level custom executor auto-discovery",
        routing: { projectId: "custom-exec-proj" },
        repository: { url: "", baseBranch: "main" },
        projectDir: tmpDir,
      };

      const workspaceManager = new WorkspaceManager(
        path.join(tmpDir, "workspaces"),
        path.join(tmpDir, "bases"),
      );
      const artifactStore = new ArtifactStore(path.join(tmpDir, "artifacts"), store);

      // 1. Create a custom executor file in <projectDir>/executors/pipeline.ts
      const executorsDir = path.join(tmpDir, "executors");
      await mkdir(executorsDir, { recursive: true });
      await writeFile(
        path.join(executorsDir, "pipeline.ts"),
        `export default {
          type: "custom-pipeline",
          canHandle(task) {
            return task.executor === "custom-pipeline" || task.type === "custom-pipeline";
          },
          async execute(ctx) {
            return {
              success: true,
              durationMs: 8,
              stateBefore: ctx.stateBefore,
              stateAfter: { pipelineResult: "transformed_records_42" },
              actionsSummary: { customPluginExecuted: true },
            };
          },
        };`,
      );

      // 2. Create a task specifying executor: "custom-pipeline"
      const tasksDir = path.join(tmpDir, "tasks");
      await mkdir(tasksDir, { recursive: true });
      await writeFile(
        path.join(tasksDir, "etl-task.md"),
        `---
id: etl-task
name: Custom Pipeline ETL
cron: "0 * * * *"
executor: custom-pipeline
---
Perform custom data transformation.
`,
      );

      const runtime = new ProjectRuntime(
        projectConfig,
        store,
        new FakeRuntime(),
        workspaceManager,
        artifactStore,
        undefined,
        logger,
      );

      await runtime.start();

      try {
        // Verify custom executor was auto-discovered and registered
        const registry = runtime.getTaskExecutorRegistry();
        expect(registry?.has("custom-pipeline")).toBe(true);

        const tasks = await runtime.listTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.executor).toBe("custom-pipeline");

        // Run the task
        const enqueued = await runtime.runTask("etl-task");
        expect(enqueued).toBe(true);
        await runtime.taskEngine.drain();

        // Verify task executed via custom executor from project directory
        const execs = await store.listTaskExecutions("custom-exec-proj:etl-task");
        expect(execs).toHaveLength(1);
        expect(execs[0]?.status).toBe("success");
        expect(execs[0]?.stateAfter).toEqual({ pipelineResult: "transformed_records_42" });
        expect(execs[0]?.actionsSummary).toEqual({ customPluginExecuted: true });
      } finally {
        await runtime.stop();
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
