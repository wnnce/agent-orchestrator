import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config/config.ts";
import type { ContextOptions } from "../src/context/index.ts";
import { ErrorCode, NotFoundError } from "../src/domain/errors.ts";
import type { HookOrigin } from "../src/domain/origin.ts";
import { deliverHook } from "../src/hooks/deliver.ts";
import { loadProjectHooks, type LoadedHook } from "../src/hooks/loader.ts";
import { defineHook, type HookContext, type HookSpec } from "../src/hooks/sdk.ts";
import { Logger } from "../src/observability/logger.ts";
import { setupTracing } from "../src/observability/tracing-setup.ts";
import type { StartPipelineRunParams } from "../src/pipeline/types.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { createGateway } from "./helpers/gateway.ts";
import { contextFactory, testContextServices, testProject } from "./helpers/project-context.ts";

const SDK = path.resolve("src/hooks/sdk.ts");

function hookFile(spec: string): string {
  return `import { defineHook } from ${JSON.stringify(SDK)};
export default defineHook(${spec});
`;
}

describe("loadProjectHooks", () => {
  let projectDir: string;
  const lines: string[] = [];
  const logger = new Logger({ sink: (line) => lines.push(line) });

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "hooks-loader-"));
    const hooksDir = path.join(projectDir, "hooks");
    await mkdir(hooksDir);
    const files: Record<string, string> = {
      "deploys.ts": hookFile(`{ name: "Deploys", handle: () => {} }`),
      "grafana.ts": hookFile(`{ id: "alerts", name: "Grafana", handle: () => {} }`),
      // Declares the same id as grafana.ts but sorts later, so it is skipped.
      "zz-alerts.ts": hookFile(`{ id: "alerts", name: "Other alerts", handle: () => {} }`),
      "nameless.ts": hookFile(`{ handle: () => {} }`),
      "plain.ts": `export default { name: "Plain", handle: () => {} };\n`,
      "broken.ts": `throw new Error("boom");\n`,
      "bad id.ts": hookFile(`{ name: "Bad id", handle: () => {} }`),
      "_shared.ts": `export const helper = 1;\n`,
      "deploys.test.ts": `export default 1;\n`,
      "types.d.ts": `export {};\n`,
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(hooksDir, name), content);
    }
  });
  afterAll(() => rm(projectDir, { recursive: true, force: true }));

  it("loads hooks under their declared id or their file name", async () => {
    const hooks = await loadProjectHooks(projectDir, "demo", logger);
    expect([...hooks.keys()].sort()).toEqual(["alerts", "deploys"]);
    expect(hooks.get("deploys")?.name).toBe("Deploys");
    expect(hooks.get("alerts")?.name).toBe("Grafana");
  });

  it("logs files it skips and why", async () => {
    lines.length = 0;
    await loadProjectHooks(projectDir, "demo", logger);
    const entries = lines.map((line) => JSON.parse(line) as Record<string, string>);
    const failed = entries
      .filter((entry) => entry.message === "failed to load project hook")
      .map((entry) => path.basename(entry.filePath ?? ""))
      .sort();
    expect(failed).toEqual(["bad id.ts", "broken.ts", "nameless.ts", "plain.ts"]);
    const duplicate = entries.find((entry) => entry.message === "duplicate project hook skipped");
    expect(path.basename(duplicate?.skippedFile ?? "")).toBe("zz-alerts.ts");
  });

  it("returns no hooks for a project without a hooks directory", async () => {
    expect((await loadProjectHooks(os.tmpdir(), "none", logger)).size).toBe(0);
  });
});

function loaded(spec: Omit<HookSpec, "name"> & { name?: string }): LoadedHook {
  return { ...defineHook({ name: "Test", ...spec }), id: spec.id ?? "test", filePath: "test.ts" };
}

describe("deliverHook", () => {
  function factory() {
    const started: StartPipelineRunParams[] = [];
    const services = testContextServices(testProject(), {
      pipelines: {
        start: async (params) => {
          started.push(params);
          return { created: true, run: { runId: "run_1" } as never };
        },
        find: async () => null,
        signal: async () => ({ woken: false }),
        list: async () => [],
      },
    });
    const create = contextFactory(services);
    const disposed: HookOrigin[] = [];
    const signals: AbortSignal[] = [];
    return {
      started,
      disposed,
      signals,
      createContext: (origin: HookOrigin, options: ContextOptions) => {
        signals.push(options.signal);
        const scoped = create(origin, options);
        return {
          context: scoped.context,
          dispose: async () => {
            disposed.push(origin);
            await scoped.dispose();
          },
        };
      },
    };
  }

  it("acts as the delivery and returns the hook's response", async () => {
    const env = factory();
    let seen: HookContext | undefined;
    const hook = loaded({
      id: "deploys",
      name: "Deploys",
      async handle(request, ctx) {
        seen = ctx;
        await ctx.pipelines.start({ pipelineId: "p", title: "t" });
        return new Response(await request.text(), { status: 202 });
      },
    });
    const response = await deliverHook(
      hook,
      new Request("http://x/hooks/demo/deploys", { method: "POST", body: "raw body" }),
      env.createContext,
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("raw body");
    expect(seen?.origin).toMatchObject({ kind: "hook", hookId: "deploys" });
    expect(seen?.hook.deliveryId).toMatch(/^dlv_/);
    expect(seen?.origin.deliveryId).toBe(seen?.hook.deliveryId);
    expect(seen?.hook.name).toBe("Deploys");
    expect(env.started[0]?.createdBy).toBe("hook:deploys");
    expect(env.disposed).toHaveLength(1);
  });

  it("answers 204 when the hook returns nothing", async () => {
    const env = factory();
    const response = await deliverHook(
      loaded({ handle: () => {} }),
      new Request("http://x/"),
      env.createContext,
    );
    expect(response.status).toBe(204);
  });

  it("aborts the context when the hook runs past its timeout", async () => {
    const env = factory();
    const hook = loaded({ timeoutMs: 20, handle: () => new Promise<void>(() => {}) });
    await expect(deliverHook(hook, new Request("http://x/"), env.createContext)).rejects.toThrow();
    expect(env.signals[0]?.aborted).toBe(true);
    expect(env.disposed).toHaveLength(1);
  });

  it("disposes the context when the hook throws", async () => {
    const env = factory();
    const hook = loaded({
      handle: () => {
        throw new Error("bad payload");
      },
    });
    await expect(deliverHook(hook, new Request("http://x/"), env.createContext)).rejects.toThrow(
      "bad payload",
    );
    expect(env.disposed).toHaveLength(1);
  });
});

describe("ProjectRuntime hooks", () => {
  let projectDir: string;
  let manager: ProjectManager;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "hooks-runtime-"));
    await mkdir(path.join(projectDir, "hooks"));
    await writeFile(
      path.join(projectDir, "hooks", "ping.ts"),
      hookFile(`{
        name: "Ping",
        description: "Answers pong",
        handle: (_request, ctx) => Response.json({ pong: ctx.hook.id, project: ctx.project.id }),
      }`),
    );
    const config = {
      dataDir: path.join(projectDir, "data"),
      artifactDir: path.join(projectDir, "artifacts"),
    } as AppConfig;
    const project = testProject({ runtime: { type: "fake" }, projectDir });
    manager = new ProjectManager(
      [project],
      new MemoryStore(),
      config,
      new Logger({ sink: () => {} }),
    );
    await manager.start();
  });
  afterAll(async () => {
    await manager.stop();
    await rm(projectDir, { recursive: true, force: true });
  });

  it("serves the hooks it loaded at start", async () => {
    const runtime = manager.get("demo");
    expect(runtime.hooks.list()).toEqual([
      { id: "ping", name: "Ping", description: "Answers pong" },
    ]);
    const response = await runtime.hooks.handle("ping", new Request("http://x/hooks/demo/ping"));
    expect(await response.json()).toEqual({ pong: "ping", project: "demo" });
  });

  it("reports unknown hooks as not found", async () => {
    const missing = manager.get("demo").hooks.handle("nope", new Request("http://x/"));
    await expect(missing).rejects.toBeInstanceOf(NotFoundError);
    await expect(missing).rejects.toMatchObject({ code: ErrorCode.HOOK_NOT_FOUND });
  });
});

describe("/hooks gateway routes", () => {
  let projectDir: string;
  let manager: ProjectManager;
  let gateway: ReturnType<typeof createGateway>;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "hooks-gateway-"));
    const hooksDir = path.join(projectDir, "hooks");
    await mkdir(hooksDir);
    const hooks: Record<string, string> = {
      "echo.ts": `{
        name: "Echo",
        handle: async (request) =>
          new Response(request.method + " " + (await request.text()), {
            status: 202,
            headers: { "content-type": "text/plain" },
          }),
      }`,
      "boom.ts": `{ name: "Boom", handle: () => { throw new Error("hook exploded"); } }`,
    };
    for (const [name, spec] of Object.entries(hooks)) {
      await writeFile(path.join(hooksDir, name), hookFile(spec));
    }
    const config = {
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join(projectDir, "data"),
      artifactDir: path.join(projectDir, "artifacts"),
      routerBaseUrl: "http://localhost:1/v1",
      allowUnauthenticated: false,
      apiToken: "api-token",
      feishu: { enabled: false },
    } as AppConfig;
    const store = new MemoryStore();
    const logger = new Logger({ sink: () => {} });
    const project = testProject({ runtime: { type: "fake" }, projectDir });
    manager = new ProjectManager([project], store, config, logger);
    await manager.start();
    gateway = createGateway(config, store, manager, logger);
  });
  afterAll(async () => {
    await manager.stop();
    await rm(projectDir, { recursive: true, force: true });
  });

  it("passes requests of any method to the hook without the API token", async () => {
    const post = await gateway.handle(
      new Request("http://localhost/hooks/demo/echo", { method: "POST", body: '{"raw": true}' }),
    );
    expect(post.status).toBe(202);
    expect(post.headers.get("content-type")).toBe("text/plain");
    expect(await post.text()).toBe('POST {"raw": true}');

    const get = await gateway.handle(new Request("http://localhost/hooks/demo/echo"));
    expect(await get.text()).toBe("GET ");

    const api = await gateway.handle(new Request("http://localhost/api/v1/projects"));
    expect(api.status).toBe(401);
  });

  it("answers 404 for unknown projects, hooks, and malformed /hooks paths", async () => {
    const unknownProject = await gateway.handle(new Request("http://localhost/hooks/nope/echo"));
    expect(unknownProject.status).toBe(404);
    expect(((await unknownProject.json()) as { error: string }).error).toBe("project_not_found");

    const unknownHook = await gateway.handle(new Request("http://localhost/hooks/demo/nope"));
    expect(unknownHook.status).toBe(404);
    expect(((await unknownHook.json()) as { error: string }).error).toBe("hook_not_found");

    const missingHookSegment = await gateway.handle(new Request("http://localhost/hooks/demo"));
    expect(missingHookSegment.status).toBe(404);
    expect(missingHookSegment.headers.get("content-type") ?? "").not.toContain("text/html");

    const extraSegment = await gateway.handle(
      new Request("http://localhost/hooks/demo/echo/extra"),
    );
    expect(extraSegment.status).toBe(404);
    expect(extraSegment.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("answers 500 without leaking internal error details when a hook throws and keeps serving", async () => {
    const failed = await gateway.handle(
      new Request("http://localhost/hooks/demo/boom", { method: "POST" }),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "internal_error" });
    const next = await gateway.handle(new Request("http://localhost/hooks/demo/echo"));
    expect(next.status).toBe(202);
  });

  it("lists the project's hooks with their paths", async () => {
    const response = await gateway.handle(
      new Request("http://localhost/api/v1/projects/demo/hooks", {
        headers: { authorization: "Bearer api-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId: "demo",
      hooks: [
        { id: "boom", name: "Boom", path: "/hooks/demo/boom" },
        { id: "echo", name: "Echo", path: "/hooks/demo/echo" },
      ],
    });
  });

  it("traces each delivery under the hook route", async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = setupTracing(
      { enabled: true, headers: {}, sampleRate: 1 },
      { spanProcessor: new SimpleSpanProcessor({ exporter }) },
    );
    try {
      const response = await gateway.handle(
        new Request("http://localhost/hooks/demo/echo", { method: "POST", body: "x" }),
      );
      const [span] = exporter.getFinishedSpans();
      expect(span?.name).toBe("POST /hooks/:projectId/:hookId");
      expect(span?.attributes).toMatchObject({
        "project.id": "demo",
        "hook.id": "echo",
        "http.response.status_code": 202,
      });
      expect(String(span?.attributes["hook.delivery_id"])).toMatch(/^dlv_/);
      expect(response.headers.get("x-trace-id")).toBe(span?.spanContext().traceId ?? null);
    } finally {
      await tracing.shutdown();
    }
  });
});
