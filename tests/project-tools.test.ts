import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { AppConfig } from "../src/config/config.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { createGateway } from "./helpers/gateway.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { GLOBAL_PROJECT_ID } from "../src/project/global.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import {
  FakeRuntime,
  RuntimeRegistry,
  type RuntimeContext,
  type RuntimeTurn,
} from "../src/runtime/index.ts";
import {
  builtinTools,
  isProjectToolFile,
  loadProjectTools,
  ToolRegistry,
} from "../src/tools/index.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

const TOOLS_SDK_PATH = path.resolve(import.meta.dir, "../src/tools/index.ts");
const cleanups: Array<() => Promise<void>> = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("project custom tools loader", () => {
  test("filters project tool filenames accurately", () => {
    expect(isProjectToolFile("query-stats.ts")).toBe(true);
    expect(isProjectToolFile("_helper.ts")).toBe(false);
    expect(isProjectToolFile("query.test.ts")).toBe(false);
    expect(isProjectToolFile("query.spec.ts")).toBe(false);
    expect(isProjectToolFile("types.d.ts")).toBe(false);
    expect(isProjectToolFile("README.md")).toBe(false);
  });

  test("loads single and array defineTool exports, skips invalid files and duplicate custom names", async () => {
    const projectDir = await tempDir("ao-project-tools-");
    const toolsDir = path.join(projectDir, "tools");
    await mkdir(toolsDir, { recursive: true });

    await writeFile(
      path.join(toolsDir, "_shared.ts"),
      `export const greeting = "hello";\n`,
      "utf8",
    );
    await writeFile(
      path.join(toolsDir, "a-single.ts"),
      `import { defineTool, z } from ${JSON.stringify(TOOLS_SDK_PATH)};
import { greeting } from "./_shared.ts";
export default defineTool({
  name: "greet_user",
  description: "Greet a user",
  input: z.object({ who: z.string() }),
  async run({ who }) {
    return { message: greeting + " " + who };
  },
});
`,
      "utf8",
    );
    await writeFile(
      path.join(toolsDir, "b-multi.ts"),
      `import { defineTool, z } from ${JSON.stringify(TOOLS_SDK_PATH)};
export default [
  defineTool({
    name: "greet_user",
    description: "Duplicate should be skipped in favor of a-single.ts",
    input: z.object({ who: z.string() }),
    async run() {
      return { message: "duplicate" };
    },
  }),
  defineTool({
    name: "ping_service",
    description: "Ping internal service",
    input: z.object({}),
    async run() {
      return { pong: true };
    },
  }),
];
`,
      "utf8",
    );
    await writeFile(
      path.join(toolsDir, "c-broken.ts"),
      `import { defineTool, z } from ${JSON.stringify(TOOLS_SDK_PATH)};
export default defineTool({
  name: "invalid tool name!",
  description: "Should fail validation",
  input: z.object({}),
  async run() { return {}; },
});
`,
      "utf8",
    );

    const logs: Array<{ level: string; message: string; tool?: string }> = [];
    const logger = new Logger({
      sink: (line) =>
        logs.push(JSON.parse(line) as { level: string; message: string; tool?: string }),
    });

    const loaded = await loadProjectTools(projectDir, "demo", logger);
    expect(loaded.map((t) => t.name)).toEqual(["greet_user", "ping_service"]);
    expect(loaded.every((t) => t.source === "project")).toBe(true);
    expect(builtinTools.every((t) => t.source === "builtin")).toBe(true);
    expect(
      logs.some((l) => l.level === "warn" && l.message.includes("duplicate custom project tool")),
    ).toBe(true);
    expect(
      logs.some((l) => l.level === "error" && l.message.includes("failed to load project tool")),
    ).toBe(true);
  });

  test("project custom tools override built-in tools with the same name", async () => {
    const projectDir = await tempDir("ao-tool-override-");
    const toolsDir = path.join(projectDir, "tools");
    await mkdir(toolsDir, { recursive: true });

    await writeFile(
      path.join(toolsDir, "custom-notify.ts"),
      `import { defineTool, z } from ${JSON.stringify(TOOLS_SDK_PATH)};
export default defineTool({
  name: "send_notification",
  description: "Project-customized notification tool",
  input: z.object({ title: z.string(), text: z.string() }),
  async run({ title, text }, ctx) {
    return { custom: true, prefix: ctx.project.env.NOTIFY_PREFIX, title, text };
  },
});
`,
      "utf8",
    );

    const logs: Array<{ level: string; message: string; tool?: string }> = [];
    const logger = new Logger({
      sink: (line) =>
        logs.push(JSON.parse(line) as { level: string; message: string; tool?: string }),
    });
    const registry = new ToolRegistry(builtinTools, logger);
    const custom = await loadProjectTools(projectDir, "shop", logger);
    expect(() => registry.register(custom)).toThrow("duplicate tool: send_notification");
    registry.register(custom, { override: true });

    expect(
      logs.some(
        (l) =>
          l.level === "info" && l.message === "tool overridden" && l.tool === "send_notification",
      ),
    ).toBe(true);
    const spec = registry.specs({}).find((s) => s.name === "send_notification");
    expect(spec?.description).toBe("Project-customized notification tool");
  });

  test("loads and executes the repository's projects/example/tools/current-time.ts template cleanly", async () => {
    const exampleDir = path.resolve(import.meta.dir, "../projects/example");
    const loaded = await loadProjectTools(exampleDir, "example", new Logger({ sink: () => {} }));
    const timeTool = loaded.find((t) => t.name === "get_current_time");
    expect(timeTool).toBeDefined();

    const parsed = timeTool!.input.parse({ timezone: "Asia/Shanghai" });
    const result = (await timeTool!.run(parsed, {} as never)) as Record<string, unknown>;
    expect(result.timezone).toBe("Asia/Shanghai");
    expect(typeof result.iso).toBe("string");
    expect(typeof result.unixMs).toBe("number");
    expect(String(result.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(result.time)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(String(result.formatted)).toContain("(Asia/Shanghai)");
  });
});

class ToolInvokingRuntime extends FakeRuntime {
  lastResult: unknown;
  seenToolNames: string[] = [];

  constructor(
    private readonly toolName: string,
    private readonly toolArgs: Record<string, unknown>,
  ) {
    super();
  }

  override async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
  ): Promise<RuntimeTurn> {
    this.seenToolNames = context.tools?.specs.map((s) => s.name) ?? [];
    const runtimeTurnId = `rt_${turnId}`;
    setTimeout(() => {
      void (async () => {
        this.lastResult = await context.tools?.call(this.toolName, this.toolArgs);
        await context.onEvent({
          type: "turn.completed",
          sessionId,
          turnId: runtimeTurnId,
          payload: {},
        });
      })();
    }, 5);
    return { id: runtimeTurnId };
  }
}

describe("ProjectRuntime custom tools integration", () => {
  test("loads project custom tools on start, overrides built-ins, and records audit", async () => {
    const root = await tempDir("ao-rt-tools-");
    const projectDir = path.join(root, "project");
    const toolsDir = path.join(projectDir, "tools");
    await mkdir(toolsDir, { recursive: true });

    await writeFile(
      path.join(toolsDir, "custom.ts"),
      `import { defineTool, z } from ${JSON.stringify(TOOLS_SDK_PATH)};
export default [
  defineTool({
    name: "lookup_env",
    description: "Read a project env value",
    input: z.object({ key: z.string() }),
    async run({ key }, ctx) {
      return { value: ctx.project.env[key] ?? null, projectId: ctx.project.id };
    },
  }),
  defineTool({
    name: "send_notification",
    description: "Overridden notification tool",
    input: z.object({ title: z.string(), text: z.string() }),
    async run({ title, text }) {
      return { overridden: true, title, text };
    },
  }),
];
`,
      "utf8",
    );

    const store = new MemoryStore();
    const logger = new Logger({ sink: () => {} });
    const agent = new ToolInvokingRuntime("send_notification", { title: "Hi", text: "Body" });
    const project: ProjectConfig = {
      id: "shop",
      displayName: "Shop",
      description: "Test",
      projectDir,
      env: { API_REGION: "cn-shanghai" },
      routing: { projectId: "shop" },
      repository: { url: "", baseBranch: "main" },
      runtime: { type: "fake" },
    };
    const runtime = new ProjectRuntime(
      project,
      store,
      agent,
      new WorkspaceManager(path.join(root, "workspaces")),
      new ArtifactStore(path.join(root, "artifacts"), store),
      undefined,
      logger,
    );
    await runtime.start();
    cleanups.push(() => runtime.stop());

    const session = await runtime.createSession({ title: "Custom Tool Test" }, "web");
    await runtime.turn(session.sessionId, "run custom override");
    await runtime.waitForIdle(session.sessionId);

    expect(agent.seenToolNames).toContain("lookup_env");
    expect(agent.seenToolNames).toContain("send_notification");
    expect(agent.lastResult).toMatchObject({
      ok: true,
      data: { overridden: true, title: "Hi", text: "Body" },
    });

    const audits = await store.listToolExecutions({
      projectId: "shop",
      sessionId: session.sessionId,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.toolName).toBe("send_notification");
    expect(audits[0]?.status).toBe("success");
  });

  test("global read-only project does not load custom tools", async () => {
    const root = await tempDir("ao-global-tools-");
    const projectDir = path.join(root, "project");
    await mkdir(path.join(projectDir, "tools"), { recursive: true });
    await writeFile(
      path.join(projectDir, "tools", "extra.ts"),
      `import { defineTool, z } from ${JSON.stringify(TOOLS_SDK_PATH)};
export default defineTool({
  name: "extra_tool",
  description: "Should not load in global",
  input: z.object({}),
  async run() { return {}; },
});
`,
      "utf8",
    );

    const store = new MemoryStore();
    const runtime = new ProjectRuntime(
      {
        id: GLOBAL_PROJECT_ID,
        displayName: "Global",
        description: "Global",
        projectDir,
        routing: { projectId: GLOBAL_PROJECT_ID },
        repository: { url: "", baseBranch: "main" },
        runtime: { type: "fake" },
      },
      store,
      new FakeRuntime(),
      new WorkspaceManager(path.join(root, "workspaces")),
      new ArtifactStore(path.join(root, "artifacts"), store),
      undefined,
      new Logger({ sink: () => {} }),
    );
    await runtime.start();
    cleanups.push(() => runtime.stop());

    expect(runtime.tools.specs({})).toEqual([]);
  });
});

describe("GET /api/v1/projects/:projectId/tools", () => {
  test("returns only project custom tools (excluding built-ins) with overridesBuiltin and inputSchema", async () => {
    const root = await tempDir("ao-gw-tools-");
    const shopDir = path.join(root, "projects", "shop");
    const emptyDir = path.join(root, "projects", "empty");
    await mkdir(path.join(shopDir, "tools"), { recursive: true });
    await mkdir(emptyDir, { recursive: true });

    await writeFile(
      path.join(shopDir, "tools", "custom.ts"),
      `import { defineTool, z } from ${JSON.stringify(TOOLS_SDK_PATH)};
export default [
  defineTool({
    name: "lookup_env",
    description: "Read a project env value",
    source: "builtin",
    input: z.object({
      key: z.string().describe("Environment variable key"),
      fallback: z.string().optional(),
    }),
    when: () => false,
    async run({ key }, ctx) {
      return { value: ctx.project.env[key] ?? null };
    },
  }),
  defineTool({
    name: "send_notification",
    description: "Custom project notification override",
    input: z.object({ title: z.string(), text: z.string() }),
    async run() {
      return { ok: true };
    },
  }),
];
`,
      "utf8",
    );

    const store = new MemoryStore();
    const logger = new Logger({ sink: () => {} });
    const registry = new RuntimeRegistry();
    registry.register({
      type: "fake",
      name: "fake",
      description: "Fake test runtime",
      create: () => new FakeRuntime(),
    });

    const config: AppConfig = {
      defaultRuntime: "fake",
      host: "127.0.0.1",
      port: 7070,
      logLevel: "error",
      dataDir: path.join(root, "data"),
      artifactDir: path.join(root, "artifacts"),
      projectConfigPath: path.join(root, "projects"),
      allowUnauthenticated: true,
      routerBaseUrl: "http://localhost",
      feishu: { enabled: false },
    };

    const projectsConfig: ProjectConfig[] = [
      {
        id: "shop",
        displayName: "Shop",
        description: "Shop project",
        projectDir: shopDir,
        routing: { projectId: "shop" },
        repository: { url: "", baseBranch: "main" },
        runtime: { type: "fake" },
      },
      {
        id: "empty",
        displayName: "Empty",
        description: "No custom tools",
        projectDir: emptyDir,
        routing: { projectId: "empty" },
        repository: { url: "", baseBranch: "main" },
        runtime: { type: "fake" },
      },
    ];

    const projects = new ProjectManager(
      projectsConfig,
      store,
      config,
      logger,
      undefined,
      undefined,
      registry,
    );
    await projects.start();
    cleanups.push(() => projects.stop());

    const gateway = createGateway(config, store, projects, logger);

    const shopRes = await gateway.app.request("/api/v1/projects/shop/tools");
    expect(shopRes.status).toBe(200);
    const shopBody = (await shopRes.json()) as {
      projectId: string;
      tools: Array<{
        name: string;
        description: string;
        source: string;
        overridesBuiltin: boolean;
        inputSchema: {
          type?: string;
          properties?: Record<string, { type?: string; description?: string }>;
          required?: string[];
        };
      }>;
    };

    expect(shopBody.projectId).toBe("shop");
    expect(shopBody.tools.map((t) => t.name)).toEqual(["send_notification", "lookup_env"]);

    // Built-in tools that were not overridden must not be exposed
    expect(shopBody.tools.some((t) => t.name === "create_artifact")).toBe(false);
    expect(shopBody.tools.some((t) => t.name === "dispatch_agent_task")).toBe(false);
    expect(shopBody.tools.some((t) => t.name === "pipeline_next")).toBe(false);

    const lookupTool = shopBody.tools.find((t) => t.name === "lookup_env");
    expect(lookupTool).toMatchObject({
      name: "lookup_env",
      description: "Read a project env value",
      source: "project",
      overridesBuiltin: false,
    });
    expect(lookupTool?.inputSchema.type).toBe("object");
    expect(lookupTool?.inputSchema.properties?.key).toMatchObject({
      type: "string",
      description: "Environment variable key",
    });
    expect(lookupTool?.inputSchema.required).toEqual(["key"]);

    const overrideTool = shopBody.tools.find((t) => t.name === "send_notification");
    expect(overrideTool).toMatchObject({
      name: "send_notification",
      description: "Custom project notification override",
      source: "project",
      overridesBuiltin: true,
    });

    const emptyRes = await gateway.app.request("/api/v1/projects/empty/tools");
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json()).toEqual({ projectId: "empty", tools: [] });

    const missingRes = await gateway.app.request("/api/v1/projects/does-not-exist/tools");
    expect(missingRes.status).toBe(404);
  });
});
