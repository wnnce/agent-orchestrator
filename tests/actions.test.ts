import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import {
  ActionRegistry,
  createActionContext,
  type ActionContext,
  type ActionDefinition,
} from "../src/actions/index.ts";

describe("ActionRegistry Mechanism", () => {
  const dummyContext: ActionContext = createActionContext({
    projectId: "test-proj",
    sessionId: "test-sess-123",
    turnId: "turn-1",
    taskKey: "test-proj:sync-issues",
  });

  test("should register, unregister and check actions", () => {
    const logs: string[] = [];
    const logger = new Logger({ sink: (line) => logs.push(line) });
    const registry = new ActionRegistry(logger);

    const action: ActionDefinition<{ text: string }, { echo: string }> = {
      name: "echo_action",
      description: "Echo test action",
      parameters: z.object({ text: z.string() }),
      handler: async (params) => ({ echo: params.text }),
    };

    registry.register(action);
    expect(registry.has("echo_action")).toBe(true);
    expect(registry.get("echo_action")?.name).toBe("echo_action");

    // Overwrite test - should log warning through logger
    registry.register(action);
    expect(logs.some((l) => l.includes("overwriting existing action registration"))).toBe(true);

    // Unregister test
    expect(registry.unregister("echo_action")).toBe(true);
    expect(registry.has("echo_action")).toBe(false);
  });

  test("should filter actions by scope", () => {
    const registry = new ActionRegistry();

    registry.register({
      name: "task_only",
      description: "Only visible during task execution",
      parameters: z.object({ foo: z.string() }),
      scopes: ["task"],
      handler: async (p) => ({ echo: p.foo }),
    });

    registry.register({
      name: "conv_only",
      description: "Only visible during conversation",
      parameters: z.object({ bar: z.number() }),
      scopes: ["conversation"],
      handler: async (p) => ({ num: p.bar }),
    });

    registry.register({
      name: "universal",
      description: "Visible in all contexts",
      parameters: z.object({}),
      scopes: ["all"],
      handler: async () => ({ ok: true }),
    });

    expect(registry.list("all").length).toBe(3);

    const taskActions = registry.list("task");
    expect(taskActions.map((a) => a.name)).toEqual(["task_only", "universal"]);

    const convActions = registry.list("conversation");
    expect(convActions.map((a) => a.name)).toEqual(["conv_only", "universal"]);
  });

  test("should generate Codex dynamic_tools schema correctly", () => {
    const registry = new ActionRegistry();
    registry.register({
      name: "inspect_repo",
      description: "Inspect repository files",
      parameters: z.object({
        path: z.string().describe("Target file path"),
        depth: z.number().int().optional().describe("Scan depth"),
      }),
      handler: async () => ({}),
    });

    const codexTools = registry.toCodexTools();
    expect(codexTools.length).toBe(1);
    expect(codexTools[0]?.type).toBe("function");
    expect(codexTools[0]?.name).toBe("inspect_repo");
    expect(codexTools[0]?.description).toBe("Inspect repository files");

    const schema = (codexTools[0]?.inputSchema ?? {}) as any;
    expect(schema.type).toBe("object");
    expect(schema.properties.path.type).toBe("string");
    expect(schema.properties.path.description).toBe("Target file path");
    expect(schema.required).toContain("path");
  });

  test("should generate OpenAI function calling tools schema correctly", () => {
    const registry = new ActionRegistry();
    registry.register({
      name: "send_alert",
      description: "Send alert message",
      parameters: z.object({ severity: z.enum(["low", "high"]) }),
      handler: async () => ({}),
    });

    const openAiTools = registry.toOpenAITools();
    expect(openAiTools.length).toBe(1);
    expect(openAiTools[0]?.type).toBe("function");
    expect(openAiTools[0]?.function.name).toBe("send_alert");
    expect(openAiTools[0]?.function.parameters).toBeDefined();
  });

  test("should execute action with valid args and handle json string parsing", async () => {
    const registry = new ActionRegistry();
    registry.register({
      name: "add",
      description: "Add two numbers",
      parameters: z.object({
        a: z.number(),
        b: z.number(),
      }),
      handler: async (p) => ({ sum: p.a + p.b }),
    });

    // Object args
    const okRes = await registry.execute<{ sum: number }>("add", { a: 10, b: 20 }, dummyContext);
    expect(okRes.success).toBe(true);
    expect(okRes.data?.sum).toBe(30);

    // JSON string args
    const strRes = await registry.execute<{ sum: number }>(
      "add",
      JSON.stringify({ a: 7, b: 8 }),
      dummyContext,
    );
    expect(strRes.success).toBe(true);
    expect(strRes.data?.sum).toBe(15);
  });

  test("should return error for invalid arguments or missing action", async () => {
    const registry = new ActionRegistry();
    registry.register({
      name: "validate_me",
      description: "Validation test",
      parameters: z.object({ count: z.number().min(1) }),
      handler: async (p) => p,
    });

    // Validation failure
    const failRes = await registry.execute("validate_me", { count: 0 }, dummyContext);
    expect(failRes.success).toBe(false);
    expect(failRes.error).toContain("Argument validation failed");

    // Malformed JSON string
    const badJsonRes = await registry.execute("validate_me", "{ bad json ", dummyContext);
    expect(badJsonRes.success).toBe(false);
    expect(badJsonRes.error).toContain("Failed to parse arguments JSON");

    // Action not found
    const notFoundRes = await registry.execute("non_existent", {}, dummyContext);
    expect(notFoundRes.success).toBe(false);
    expect(notFoundRes.error).toContain("not found in registry");
  });

  test("should catch and encapsulate errors thrown inside handlers", async () => {
    const registry = new ActionRegistry();
    registry.register({
      name: "crash_action",
      description: "Action that throws",
      parameters: z.object({}),
      handler: async () => {
        throw new Error("Deliberate internal failure");
      },
    });

    const res = await registry.execute("crash_action", {}, dummyContext);
    expect(res.success).toBe(false);
    expect(res.error).toBe("Deliberate internal failure");
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/artifacts/store.ts";
import { NotificationOutbox, NotificationHub } from "../src/notifications/index.ts";
import { TaskEngine } from "../src/task/engine.ts";
import { MemoryEventHub } from "../src/events/hub.ts";
import { defaultActionRegistry } from "../src/actions/index.ts";
import type { EventRecord } from "../src/domain/types.ts";

describe("ActionContext Unified Capabilities & Escape Hatch", () => {
  test("facade notify and createArtifact integrate smoothly with underlying subsystems", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "action-ctx-test-"));
    try {
      const store = new MemoryStore();
      const artifactStore = new ArtifactStore(tempDir, store);
      const hub = new NotificationHub();
      const outbox = new NotificationOutbox(store, hub);

      const ctx = createActionContext({
        projectId: "proj_media",
        sessionId: "ses_media_01",
        turnId: "turn_01",
        workspacePath: tempDir,
        services: {
          artifacts: artifactStore,
          artifactStore,
          notifications: outbox,
        },
        projectNotifications: [
          {
            name: "test-log",
            type: "log",
            enabled: true,
          },
        ],
      });

      // 1. Test notify facade method
      await ctx.notify({
        title: "Build Success",
        text: "Project build succeeded in 4.2s",
      });
      await outbox.drain();
      const deliveries = await store.listNotificationDeliveries({ projectId: "proj_media" });
      expect(deliveries.length).toBe(1);
      expect(deliveries[0]?.message.title).toBe("Build Success");

      // 2. Test createArtifact facade method
      const art = await ctx.createArtifact({
        kind: "build_summary",
        content: JSON.stringify({ status: "ok", duration: 4.2 }),
        contentType: "application/json",
      });
      expect(art.id).toMatch(/^art_/);
      expect(art.projectId).toBe("proj_media");
      expect(art.sessionId).toBe("ses_media_01");
      expect(art.turnId).toBe("turn_01");
      expect(art.kind).toBe("build_summary");

      const readBack = await artifactStore.read(art);
      expect(JSON.parse(new TextDecoder().decode(readBack))).toEqual({
        status: "ok",
        duration: 4.2,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("facade getTaskState and updateTaskState manage persistent task cursors", async () => {
    const engine = new TaskEngine();
    const taskKey = "proj_sync:github_issues";
    engine.updateState(taskKey, { lastIssueId: 100, page: 1 });

    const ctx = createActionContext({
      projectId: "proj_sync",
      sessionId: "ses_sync_01",
      taskKey,
      services: {
        taskEngine: engine,
      },
    });

    // Read initial state
    const initial = await ctx.getTaskState();
    expect(initial).toEqual({ lastIssueId: 100, page: 1 });

    // Incremental merge update (merge: true, default)
    const merged = await ctx.updateTaskState({ lastIssueId: 150 });
    expect(merged).toEqual({ lastIssueId: 150, page: 1 });
    expect(await engine.getState(taskKey)).toEqual({ lastIssueId: 150, page: 1 });

    // Full replacement update (merge: false)
    const replaced = await ctx.updateTaskState({ reset: true }, { merge: false });
    expect(replaced).toEqual({ reset: true });
    expect(await engine.getState(taskKey)).toEqual({ reset: true });
  });

  test("facade emit publishes events into EventHub", async () => {
    const store = new MemoryStore();
    const eventHub = new MemoryEventHub(store);
    const captured: EventRecord[] = [];
    eventHub.subscribeSession("ses_event_test", (evt) => captured.push(evt));

    const ctx = createActionContext({
      projectId: "proj_evt",
      sessionId: "ses_event_test",
      services: {
        eventHub,
      },
    });

    await ctx.emit("custom.action.completed", { step: "data_clean", rows: 42 });

    expect(captured.length).toBe(1);
    expect(captured[0]?.type).toBe("custom.action.completed");
    expect(captured[0]?.sequence).toBeGreaterThan(0);
    expect(captured[0]?.payload).toEqual({ step: "data_clean", rows: 42 });
  });

  test("escape hatch service() and requireService() provide strongly typed raw service access", () => {
    const store = new MemoryStore();
    const engine = new TaskEngine();

    const customDatabase = { query: () => "mocked-data" };

    const ctx = createActionContext({
      projectId: "proj_di",
      sessionId: "ses_di",
      services: {
        store,
        taskEngine: engine,
        db: customDatabase,
      },
    });

    // 1. Resolve registered standard services
    const resolvedStore = ctx.service("store");
    expect(resolvedStore).toBe(store);

    const requiredEngine = ctx.requireService("taskEngine");
    expect(requiredEngine).toBe(engine);

    // 2. Resolve custom injected service
    const resolvedDb = ctx.service<typeof customDatabase>("db");
    expect(resolvedDb?.query()).toBe("mocked-data");

    // 3. Unregistered service degradation and error handling
    expect(ctx.service("notifications")).toBeUndefined();
    expect(() => ctx.requireService("notifications")).toThrow(
      /Required service "notifications" not found in ActionContext/,
    );
  });
});

describe("Builtin Actions Execution", () => {
  test("send_notification action executes correctly via ActionRegistry", async () => {
    const store = new MemoryStore();
    const hub = new NotificationHub();
    const outbox = new NotificationOutbox(store, hub);

    const ctx = createActionContext({
      projectId: "proj_notify",
      sessionId: "ses_notify",
      services: {
        notifications: outbox,
      },
      projectNotifications: [{ name: "test-log", type: "log", enabled: true }],
    });

    const result = await defaultActionRegistry.execute(
      "send_notification",
      {
        title: "Alert: High Memory",
        text: "Memory usage exceeded 85%",
        markdown: "**Warning**: Memory usage high",
      },
      ctx,
    );

    expect(result.success).toBe(true);
    await outbox.drain();
    const deliveries = await store.listNotificationDeliveries({ projectId: "proj_notify" });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.message.title).toBe("Alert: High Memory");
  });

  test("create_artifact action stores file and returns artifact metadata", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "artifact-action-test-"));
    try {
      const store = new MemoryStore();
      const artifactStore = new ArtifactStore(tempDir, store);

      const ctx = createActionContext({
        projectId: "proj_art",
        sessionId: "ses_art",
        workspacePath: tempDir,
        services: {
          artifactStore,
        },
      });

      const result = await defaultActionRegistry.execute<{
        artifactId: string;
        path: string;
        sizeBytes: number;
      }>(
        "create_artifact",
        {
          kind: "audit_report",
          content: "Audit passed with 0 vulnerabilities",
          contentType: "text/markdown",
        },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.data?.artifactId).toMatch(/^art_/);
      expect(result.data?.sizeBytes).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("update_task_state action updates engine cursor via ctx facade", async () => {
    const engine = new TaskEngine();
    engine.updateState("proj_state:task1", { cursor: 10 });

    const ctx = createActionContext({
      projectId: "proj_state",
      sessionId: "ses_state",
      taskKey: "proj_state:task1",
      services: {
        taskEngine: engine,
      },
    });

    const res = await defaultActionRegistry.execute(
      "update_task_state",
      { state: { cursor: 20, done: true } },
      ctx,
    );

    expect(res.success).toBe(true);
    expect(await engine.getState("proj_state:task1")).toEqual({ cursor: 20, done: true });
  });

  test("dispatch_agent_task action executes correctly via ActionRegistry", async () => {
    let dispatchedParams: any = null;
    const ctx = createActionContext({
      projectId: "proj_dispatch",
      sessionId: "ses_dispatch_source",
      onDispatchTask: async (params) => {
        dispatchedParams = params;
        return { sessionId: "ses_dispatched_123", turnId: "turn_dispatched_456" };
      },
    });

    const res = await defaultActionRegistry.execute<{
      sessionId: string;
      turnId: string;
      title: string;
    }>(
      "dispatch_agent_task",
      {
        title: "Fix Issue #105: 502 Error",
        prompt: "Locate and fix the bug in redirect logic",
        metadata: { issue_id: 105 },
      },
      ctx,
    );

    expect(res.success).toBe(true);
    expect(res.data?.sessionId).toBe("ses_dispatched_123");
    expect(res.data?.turnId).toBe("turn_dispatched_456");
    expect(res.data?.title).toBe("Fix Issue #105: 502 Error");
    expect(dispatchedParams).toEqual({
      title: "Fix Issue #105: 502 Error",
      prompt: "Locate and fix the bug in redirect logic",
      metadata: { issue_id: 105 },
    });
  });

  describe("Action Execution Audit Logging", () => {
    test("automatically records successful action execution in store", async () => {
      const store = new MemoryStore();
      const registry = new ActionRegistry(new Logger(), store);

      registry.register({
        name: "test_calc",
        description: "Calculate sum",
        parameters: z.object({ a: z.number(), b: z.number() }),
        handler: async (params) => ({ sum: params.a + params.b }),
      });

      const ctx = createActionContext({
        projectId: "proj_audit",
        sessionId: "ses_audit_1",
        turnId: "turn_1",
      });

      const res = await registry.execute<{ sum: number }>("test_calc", { a: 10, b: 20 }, ctx);
      expect(res.success).toBe(true);
      expect(res.data?.sum).toBe(30);

      // Verify audit record in store
      const logs = await store.listActionExecutions({ projectId: "proj_audit" });
      expect(logs.length).toBe(1);
      const log0 = logs[0]!;
      expect(log0.actionName).toBe("test_calc");
      expect(log0.status).toBe("success");
      expect(log0.caller).toBe("model");
      expect(log0.parameters).toEqual({ a: 10, b: 20 });
      expect(log0.result).toEqual({ sum: 30 });
      expect(log0.durationMs).toBeGreaterThanOrEqual(0);
      expect(log0.executionId).toMatch(/^act_/);
    });

    test("automatically records failed action execution on validation error", async () => {
      const store = new MemoryStore();
      const registry = new ActionRegistry(new Logger(), store);

      registry.register({
        name: "test_strict",
        description: "Strict validation action",
        parameters: z.object({ email: z.string().email() }),
        handler: async (params) => ({ ok: true }),
      });

      const ctx = createActionContext({
        projectId: "proj_fail",
        sessionId: "ses_fail_1",
        taskKey: "proj_fail:task_worker",
      });

      const res = await registry.execute("test_strict", { email: "not-an-email" }, ctx);
      expect(res.success).toBe(false);

      const logs = await store.listActionExecutions({ projectId: "proj_fail" });
      expect(logs.length).toBe(1);
      const log0 = logs[0]!;
      expect(log0.actionName).toBe("test_strict");
      expect(log0.status).toBe("failure");
      expect(log0.caller).toBe("task");
      expect(log0.errorMessage).toContain("Argument validation failed");
    });

    test("automatically records failure when action throws in handler", async () => {
      const store = new MemoryStore();
      const registry = new ActionRegistry(new Logger(), store);

      registry.register({
        name: "test_throw",
        description: "Throwing action",
        parameters: z.object({ msg: z.string() }),
        handler: async (params) => {
          throw new Error(`Boom: ${params.msg}`);
        },
      });

      const ctx = createActionContext({
        projectId: "proj_throw",
        sessionId: "ses_throw_1",
      });

      const res = await registry.execute("test_throw", { msg: "critical error" }, ctx);
      expect(res.success).toBe(false);

      const logs = await store.listActionExecutions({ projectId: "proj_throw" });
      expect(logs.length).toBe(1);
      const log0 = logs[0]!;
      expect(log0.status).toBe("failure");
      expect(log0.errorMessage).toBe("Boom: critical error");
    });

    test("safely truncates massive payload in audit logs", async () => {
      const store = new MemoryStore();
      const registry = new ActionRegistry(new Logger(), store);

      const hugeString = "A".repeat(10000);
      registry.register({
        name: "test_huge",
        description: "Huge payload",
        parameters: z.object({ data: z.string() }),
        handler: async (params) => ({ response: params.data }),
      });

      const ctx = createActionContext({
        projectId: "proj_huge",
        sessionId: "ses_huge_1",
      });

      await registry.execute("test_huge", { data: hugeString }, ctx);

      const logs = await store.listActionExecutions({ projectId: "proj_huge" });
      expect(logs.length).toBe(1);
      const recordedParam = (logs[0]!.parameters as any).data;
      expect(recordedParam).toContain("... [Truncated");
      expect(recordedParam.length).toBeLessThan(5000);
    });

    test("resolves store from context.service('store') if not explicitly passed to registry", async () => {
      const store = new MemoryStore();
      const registry = new ActionRegistry(); // no store passed in constructor

      registry.register({
        name: "test_service_store",
        description: "Context store action",
        parameters: z.object({ val: z.string() }),
        handler: async (params) => ({ ok: params.val }),
      });

      const ctx = createActionContext({
        projectId: "proj_ctx_store",
        sessionId: "ses_ctx_1",
        services: {
          store,
        },
      });

      const res = await registry.execute("test_service_store", { val: "via_context" }, ctx);
      expect(res.success).toBe(true);

      const logs = await store.listActionExecutions({ projectId: "proj_ctx_store" });
      expect(logs.length).toBe(1);
      const log0 = logs[0]!;
      expect(log0.actionName).toBe("test_service_store");
      expect(log0.status).toBe("success");
    });
  });
});
