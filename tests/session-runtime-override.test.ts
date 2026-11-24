import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

class CapturingRuntime implements AgentRuntime {
  readonly name: string;
  readonly type: string;
  readonly capabilities = FAKE_CAPABILITIES;
  private readonly inner = new FakeRuntime();
  readonly startedContexts: RuntimeContext[] = [];
  readonly resumedContexts: Array<{ id: string; context: RuntimeContext }> = [];
  readonly turnContexts: RuntimeContext[] = [];
  stopped = false;

  constructor(type: string) {
    this.name = type;
    this.type = type;
  }

  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    this.startedContexts.push(context);
    return this.inner.startSession(context);
  }

  async resumeSession(
    context: RuntimeContext,
    runtimeSessionId: string,
  ): Promise<RuntimeSession> {
    this.resumedContexts.push({ id: runtimeSessionId, context });
    return this.inner.resumeSession(context, runtimeSessionId);
  }

  async startTurn(
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

  async stop(): Promise<void> {
    this.stopped = true;
    await this.inner.stop();
  }
}

describe("dynamic session runtime, model, and reasoningEffort selection", () => {
  let root: string;
  let store: MemoryStore;
  let codexMock: CapturingRuntime;
  let claudeMock: CapturingRuntime;
  let manager: ProjectManager;
  let gateway: Gateway;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ao-session-rt-"));
    store = new MemoryStore();
    codexMock = new CapturingRuntime("codex");
    claudeMock = new CapturingRuntime("claude");
    const logger = new Logger({ sink: () => {} });

    const registry = new RuntimeRegistry(logger);
    registry.register("codex", () => codexMock);
    registry.register("claude", () => claudeMock);

    const projectDir = path.join(root, "projects", "demo");
    await mkdir(path.join(projectDir, "tasks"), { recursive: true });

    const project: ProjectConfig = {
      id: "demo",
      displayName: "Demo",
      description: "Demo project",
      projectDir,
      routing: { projectId: "demo", displayName: "Demo" },
      repository: { url: "", baseBranch: "main" },
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

  test("GET /projects includes each project's default runtime config", async () => {
    const res = await gateway.app.request("/projects");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      projects: Array<{
        projectId: string;
        runtime?: { type: string; model?: string; reasoningEffort?: string };
      }>;
    };
    expect(data.projects[0]?.runtime).toEqual({
      type: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
  });

  test("POST /sessions overrides runtime, model, and reasoningEffort and routes turns to the chosen runtime", async () => {
    const createRes = await gateway.app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "demo",
        runtime: "claude",
        model: "claude-opus-5-5",
        reasoningEffort: "max",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      session: {
        sessionId: string;
        runtime?: string;
        model?: string;
        reasoningEffort?: string;
      };
    };

    expect(created.session.runtime).toBe("claude");
    expect(created.session.model).toBe("claude-opus-5-5");
    expect(created.session.reasoningEffort).toBe("max");
    expect(codexMock.startedContexts).toHaveLength(0);
    expect(claudeMock.startedContexts).toHaveLength(1);
    expect(claudeMock.startedContexts[0]?.project.runtime).toMatchObject({
      type: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "max",
    });

    const projectRt = manager.get("demo");
    await projectRt.turn(created.session.sessionId, "ping claude");
    await projectRt.waitForIdle(created.session.sessionId);

    expect(claudeMock.turnContexts).toHaveLength(1);
    expect(claudeMock.turnContexts[0]?.project.runtime).toMatchObject({
      type: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "max",
    });
    expect(codexMock.turnContexts).toHaveLength(0);
  });

  test("switching runtime without specifying model does not leak the project's default runtime model", async () => {
    const createRes = await gateway.app.request("/projects/demo/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: "claude",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      session: { runtime?: string; model?: string; reasoningEffort?: string };
    };

    expect(created.session.runtime).toBe("claude");
    expect(created.session.model).toBeUndefined();
    expect(created.session.reasoningEffort).toBeUndefined();
    expect(claudeMock.startedContexts[0]?.project.runtime?.model).toBeUndefined();
    expect(claudeMock.startedContexts[0]?.project.runtime?.reasoningEffort).toBeUndefined();
  });

  test("rejects unknown runtime with 400 error", async () => {
    const res = await gateway.app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "demo",
        runtime: "nonexistent-runtime",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("resumes a previously persisted cross-runtime session with its own runtime without resetting", async () => {
    await store.createSession({
      sessionId: "ses_persisted_claude",
      projectId: "demo",
      projectRuntimeId: "project-runtime:demo",
      runtimeSessionId: "claude-sess-42",
      runtime: "claude",
      model: "claude-sonnet-5-5",
      reasoningEffort: "medium",
      configRevision: 1,
      status: "suspended",
      source: "web",
      lastActiveAt: new Date().toISOString(),
    });

    const projectRt = manager.get("demo");
    await projectRt.turn("ses_persisted_claude", "resume me");
    await projectRt.waitForIdle("ses_persisted_claude");

    expect(claudeMock.resumedContexts).toHaveLength(1);
    expect(claudeMock.resumedContexts[0]?.id).toBe("claude-sess-42");
    expect(claudeMock.resumedContexts[0]?.context.project.runtime).toMatchObject({
      type: "claude",
      model: "claude-sonnet-5-5",
      reasoningEffort: "medium",
    });
    const events = await projectRt.events("ses_persisted_claude");
    expect(events.some((e) => e.type === "session.runtime_reset")).toBe(false);
  });

  test("project task uses its configured runtime/model/reasoningEffort while action-dispatched sessions follow project defaults", async () => {
    const projectRt = manager.get("demo");
    const tasksDir = path.join(projectRt.project.projectDir!, "tasks");
    await writeFile(
      path.join(tasksDir, "issue-triage.md"),
      `---
id: issue-triage
name: Issue Triage
cron: "0 0 * * *"
enabled: false
runtime:
  type: claude
  model: claude-haiku-5-5
  reasoningEffort: low
---
Triage open issues for {{project.id}}.
`,
    );

    // Verify GET /projects/:projectId/tasks exposes task runtime configuration
    const listRes = await gateway.app.request("/projects/demo/tasks");
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as {
      tasks: Array<{
        taskId: string;
        runtime?: { type?: string; model?: string; reasoningEffort?: string };
      }>;
    };
    expect(listData.tasks).toHaveLength(1);
    expect(listData.tasks[0]?.runtime).toEqual({
      type: "claude",
      model: "claude-haiku-5-5",
      reasoningEffort: "low",
    });

    // Trigger task execution and wait for completion
    const queued = await projectRt.runTask("issue-triage");
    expect(queued).toBe(true);
    await projectRt.taskEngine.drain();

    // Task session must have run on claude with overridden model & effort
    expect(claudeMock.startedContexts).toHaveLength(1);
    expect(claudeMock.turnContexts).toHaveLength(1);
    expect(claudeMock.startedContexts[0]?.project.runtime).toMatchObject({
      type: "claude",
      model: "claude-haiku-5-5",
      reasoningEffort: "low",
    });
    expect(codexMock.startedContexts).toHaveLength(0);

    const taskSessions = await store.listSessions("demo", { includeTasks: true });
    expect(taskSessions).toHaveLength(1);
    expect(taskSessions[0]?.source).toBe("task");
    expect(taskSessions[0]?.runtime).toBe("claude");
    expect(taskSessions[0]?.model).toBe("claude-haiku-5-5");
    expect(taskSessions[0]?.reasoningEffort).toBe("low");

    // Simulate the task invoking `dispatch_agent_task` via its runtime's ActionContext
    const taskTurnContext = claudeMock.turnContexts[0]!;
    const actionCtx = taskTurnContext.createActionContext!({});
    const dispatchRes = await projectRt.actionRegistry.execute(
      "dispatch_agent_task",
      {
        title: "dev(issue-#42): implement feature",
        prompt: "Implement feature #42 on main.",
      },
      actionCtx,
    );
    expect(dispatchRes.success).toBe(true);
    const dispatchedSessionId = (dispatchRes.data as { sessionId: string }).sessionId;
    await projectRt.waitForIdle(dispatchedSessionId);

    // Dispatched session MUST follow project default config (codex / gpt-5.6-terra / high)
    const dispatchedSession = await store.getSession(dispatchedSessionId);
    expect(dispatchedSession?.source).toBe("dispatch");
    expect(dispatchedSession?.runtime).toBe("codex");
    expect(dispatchedSession?.model).toBe("gpt-5.6-terra");
    expect(dispatchedSession?.reasoningEffort).toBe("high");
    expect(codexMock.startedContexts).toHaveLength(1);
    expect(codexMock.turnContexts).toHaveLength(1);
    expect(codexMock.startedContexts[0]?.project.runtime).toMatchObject({
      type: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
  });

  test("project task overriding only model stays on project default runtime, and overriding only runtime.type does not leak project default model", async () => {
    const projectRt = manager.get("demo");
    const tasksDir = path.join(projectRt.project.projectDir!, "tasks");
    await writeFile(
      path.join(tasksDir, "model-only.md"),
      `---
id: model-only
name: Model Only Task
cron: "0 0 * * *"
enabled: false
runtime:
  model: gpt-5.6-mini
  reasoningEffort: low
---
Run cheap check.
`,
    );
    await writeFile(
      path.join(tasksDir, "runtime-only.md"),
      `---
id: runtime-only
name: Runtime Only Task
cron: "0 0 * * *"
enabled: false
runtime:
  type: claude
---
Run on claude default model.
`,
    );

    await projectRt.runTask("model-only");
    await projectRt.taskEngine.drain();

    expect(codexMock.startedContexts).toHaveLength(1);
    expect(codexMock.startedContexts[0]?.project.runtime).toMatchObject({
      type: "codex",
      model: "gpt-5.6-mini",
      reasoningEffort: "low",
    });

    await projectRt.runTask("runtime-only");
    await projectRt.taskEngine.drain();

    expect(claudeMock.startedContexts).toHaveLength(1);
    expect(claudeMock.startedContexts[0]?.project.runtime?.type).toBe("claude");
    expect(claudeMock.startedContexts[0]?.project.runtime?.model).toBeUndefined();
    expect(claudeMock.startedContexts[0]?.project.runtime?.reasoningEffort).toBeUndefined();
  });
});
