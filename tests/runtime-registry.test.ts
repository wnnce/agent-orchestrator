import { describe, expect, test } from "bun:test";
import {
  RuntimeRegistry,
  createDefaultRuntimeRegistry,
  defaultRuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeFactoryContext,
} from "../src/runtime/registry.ts";
import {
  FakeRuntime,
  type AgentRuntime,
  type RuntimeContext,
  type RuntimeSession,
} from "../src/runtime/runtime.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { Logger } from "../src/observability/logger.ts";
import type { AppConfig } from "../src/config/config.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { createGateway } from "./helpers/gateway.ts";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

function createSampleProject(id: string, runtimeType?: string): ProjectConfig {
  return {
    id,
    displayName: `Project ${id}`,
    description: `Description for ${id}`,
    routing: {
      projectId: id,
      displayName: `Project ${id}`,
      summary: `Summary for ${id}`,
      keywords: [id],
    },
    ...(runtimeType ? { runtime: { type: runtimeType } } : {}),
  };
}

function createSampleConfig(dataDir: string, artifactDir: string): AppConfig {
  return {
    port: 7070,
    host: "127.0.0.1",
    dataDir,
    artifactDir,
    projectConfigPath: path.join(dataDir, "projects"),
    allowUnauthenticated: true,
    routerModel: "gpt-4o",
    routerBaseUrl: "http://localhost:8317/v1",
    logLevel: "info",
    feishu: { enabled: false },
  };
}

describe("RuntimeRegistry", () => {
  test("registers, checks, lists, and creates runtimes via factory function", () => {
    const registry = new RuntimeRegistry();
    expect(registry.has("custom")).toBe(false);

    let created = false;
    registry.register("custom", (ctx) => {
      created = true;
      expect(ctx.project.id).toBe("test-proj");
      return new FakeRuntime();
    });

    expect(registry.has("custom")).toBe(true);
    expect(registry.has("CUSTOM")).toBe(true);
    expect(registry.list()).toEqual(["custom"]);

    const dummyProject = createSampleProject("test-proj");
    const dummyConfig = createSampleConfig("/tmp/data", "/tmp/artifacts");

    const runtime = registry.create("custom", {
      project: dummyProject,
      logger: new Logger(),
      config: dummyConfig,
    });

    expect(created).toBe(true);
    expect(runtime).toBeInstanceOf(FakeRuntime);
  });

  test("registers runtimes via RuntimeAdapter object", () => {
    const registry = new RuntimeRegistry();

    class CustomAdapter implements RuntimeAdapter {
      readonly type = "custom-adapter";
      create(_context: RuntimeFactoryContext): AgentRuntime {
        return new FakeRuntime();
      }
    }

    registry.register(new CustomAdapter());
    expect(registry.has("custom-adapter")).toBe(true);
    expect(registry.has("CUSTOM-ADAPTER")).toBe(true);

    const runtime = registry.create("custom-adapter", {
      project: createSampleProject("p1"),
      logger: new Logger(),
      config: createSampleConfig("/tmp", "/tmp"),
    });
    expect(runtime).toBeInstanceOf(FakeRuntime);
  });

  test("unregisters runtimes correctly", () => {
    const registry = new RuntimeRegistry();
    registry.register("temp", () => new FakeRuntime());
    expect(registry.has("temp")).toBe(true);

    const deleted = registry.unregister("temp");
    expect(deleted).toBe(true);
    expect(registry.has("temp")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  test("throws informative error when creating unregistered runtime", () => {
    const registry = new RuntimeRegistry();
    expect(() =>
      registry.create("non-existent", {
        project: createSampleProject("p-error"),
        logger: new Logger(),
        config: createSampleConfig("/tmp", "/tmp"),
      }),
    ).toThrow(
      "no runtime adapter registered for project p-error: non-existent",
    );
  });

  test("defaultRuntimeRegistry contains built-in codex, pi, and fake runtimes with metadata", () => {
    expect(defaultRuntimeRegistry.has("codex")).toBe(true);
    expect(defaultRuntimeRegistry.has("fake")).toBe(true);
    expect(defaultRuntimeRegistry.has("pi")).toBe(true);

    const runtimes = defaultRuntimeRegistry.listRuntimes();
    expect(runtimes.length).toBeGreaterThanOrEqual(3);

    const fakeMeta = runtimes.find((r) => r.name === "fake");
    expect(fakeMeta).toBeDefined();
    expect(fakeMeta?.capabilities?.streaming).toBe(true);
    expect(fakeMeta?.description).toContain("In-memory mock runtime");

    const codexMeta = runtimes.find((r) => r.name === "codex");
    expect(codexMeta).toBeDefined();
    expect(codexMeta?.capabilities?.mcp).toBe(true);

    const piMeta = runtimes.find((r) => r.name === "pi");
    expect(piMeta).toBeDefined();
    expect(piMeta?.capabilities?.streaming).toBe(true);
    expect(piMeta?.capabilities?.resume).toBe(true);

    const fake = defaultRuntimeRegistry.create("fake", {
      project: createSampleProject("sample"),
      logger: new Logger(),
      config: createSampleConfig("/tmp", "/tmp"),
    });
    expect(fake).toBeInstanceOf(FakeRuntime);
    expect(fake.name).toBe("fake");
    expect(fake.type).toBe("fake");
  });

  test("createDefaultRuntimeRegistry returns an isolated registry instance", () => {
    const isolated = createDefaultRuntimeRegistry();
    expect(isolated.has("fake")).toBe(true);

    isolated.register("isolated-only", () => new FakeRuntime());
    expect(isolated.has("isolated-only")).toBe(true);
    expect(defaultRuntimeRegistry.has("isolated-only")).toBe(false);
  });
});

describe("ProjectManager Runtime Extensibility", () => {
  test("allows registering a new Agent runtime without modifying ProjectManager", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "orchestrator-runtime-test-"),
    );
    const dataDir = path.join(tmpDir, "data");
    const artifactDir = path.join(tmpDir, "artifacts");

    const customRegistry = createDefaultRuntimeRegistry();

    // Define a brand new agent runtime
    class ThirdPartyAgentRuntime implements AgentRuntime {
      readonly name = "third-party";
      readonly type = "third-party" as const;
      readonly capabilities = {
        streaming: true,
        resume: true,
        steer: false,
        interrupt: true,
        compaction: false,
        approvals: false,
        mcp: true,
        structuredOutput: false,
        sandbox: true,
      };

      async startSession(context: RuntimeContext): Promise<RuntimeSession> {
        return { id: "tp_session_1", workspacePath: context.workspacePath };
      }
      async resumeSession(
        context: RuntimeContext,
        runtimeSessionId: string,
      ): Promise<RuntimeSession> {
        return { id: runtimeSessionId, workspacePath: context.workspacePath };
      }
      async startTurn(): Promise<{ id: string }> {
        return { id: "tp_turn_1" };
      }
      async steerTurn(): Promise<void> {}
      async interruptTurn(): Promise<void> {}
      async compactSession(): Promise<void> {}
      async respondToApproval(): Promise<void> {}
      async releaseSession(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    // Register it into the registry
    customRegistry.register("third-party", (ctx) => {
      expect(ctx.project.id).toBe("custom-project");
      expect(ctx.project.runtime?.type).toBe("third-party");
      return new ThirdPartyAgentRuntime();
    });

    const project: ProjectConfig = {
      id: "custom-project",
      displayName: "Custom Agent Project",
      description: "Custom Agent Project Description",
      routing: {
        projectId: "custom-project",
        displayName: "Custom Agent Project",
        summary: "Custom Agent Project Summary",
        keywords: ["custom"],
      },
      runtime: { type: "third-party" },
    };

    const store = new MemoryStore();
    const config = createSampleConfig(dataDir, artifactDir);
    const logger = new Logger();

    // Pass custom registry to ProjectManager
    const manager = new ProjectManager(
      [project],
      store,
      config,
      logger,
      undefined,
      undefined,
      customRegistry,
    );
    await manager.start();

    const runtime = manager.get("custom-project");
    expect(runtime).toBeDefined();

    await manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("throws error when project specifies unknown runtime type", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "orchestrator-runtime-fail-"),
    );
    const dataDir = path.join(tmpDir, "data");
    const artifactDir = path.join(tmpDir, "artifacts");

    const project: ProjectConfig = {
      id: "unsupported-proj",
      displayName: "Unsupported Project",
      description: "Unsupported Project Description",
      routing: {
        projectId: "unsupported-proj",
        displayName: "Unsupported Project",
        summary: "Unsupported Project Summary",
        keywords: ["unsupported"],
      },
      runtime: {
        type: "non-existent-agent-type",
      },
    };

    const store = new MemoryStore();
    const config = createSampleConfig(dataDir, artifactDir);
    const logger = new Logger();

    const manager = new ProjectManager([project], store, config, logger);
    await expect(manager.start()).rejects.toThrow(
      "no runtime adapter registered for project unsupported-proj: non-existent-agent-type",
    );

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("sessions track and persist their runtime type during creation and lifecycle", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "orchestrator-session-runtime-"),
    );
    const dataDir = path.join(tmpDir, "data");
    const artifactDir = path.join(tmpDir, "artifacts");

    const project: ProjectConfig = {
      id: "runtime-track-proj",
      displayName: "Runtime Track Project",
      description: "Testing session runtime tracking",
      routing: {
        projectId: "runtime-track-proj",
        displayName: "Runtime Track Project",
        summary: "Testing session runtime tracking",
        keywords: ["track"],
      },
      runtime: {
        type: "fake",
      },
      repository: { url: "", baseBranch: "main" },
    };

    const store = new MemoryStore();
    const config = createSampleConfig(dataDir, artifactDir);
    const logger = new Logger();

    const manager = new ProjectManager([project], store, config, logger);
    await manager.start();

    const projectRuntime = manager.get("runtime-track-proj");
    const session = await projectRuntime.sessions.create();

    expect(session.runtime).toBe("fake");
    expect(session.metadata?.runtime).toBe("fake");

    // Retrieve from store to ensure persistence
    const loaded = await store.getSession(session.sessionId);
    expect(loaded?.runtime).toBe("fake");

    await manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe("Gateway /runtimes API", () => {
  test("GET /runtimes returns registered runtime metadata without authentication", async () => {
    const project = createSampleProject("p-gw", "fake");
    const store = new MemoryStore();
    const config = createSampleConfig("/tmp/gw-data", "/tmp/gw-artifacts");
    const logger = new Logger();
    const projectManager = new ProjectManager([project], store, config, logger);
    const gateway = createGateway(config, store, projectManager, logger);

    const res = await gateway.app.request("/api/v1/runtimes");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { runtimes: Array<{ name: string }> };
    expect(Array.isArray(data.runtimes)).toBe(true);
    expect(data.runtimes.some((r) => r.name === "fake")).toBe(true);
    expect(data.runtimes.some((r) => r.name === "codex")).toBe(true);
  });
});
