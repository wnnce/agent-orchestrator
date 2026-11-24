import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

    const project: ProjectConfig = {
      id: "demo",
      displayName: "Demo",
      description: "Demo project",
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
});
