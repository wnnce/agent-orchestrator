import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExportResultCode } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { z } from "zod";
import { ActionRegistry, pipelineActions } from "../src/actions/index.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { AppConfig } from "../src/config/config.ts";
import { loadConfig } from "../src/config/service.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Gateway } from "../src/gateway/server.ts";
import { Logger } from "../src/observability/logger.ts";
import {
  activeTraceIds,
  activeTraceparent,
  detached,
  withSpan,
} from "../src/observability/tracing.ts";
import { setupTracing, type TracingHandle } from "../src/observability/tracing-setup.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import {
  FakeRuntime,
  type RuntimeContext,
  type RuntimeEvent,
  type RuntimeTurn,
} from "../src/runtime/runtime.ts";
import { TaskEngine } from "../src/task/engine.ts";
import type { TaskDefinition } from "../src/task/types.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

const PIPELINE_SDK_PATH = path.resolve(import.meta.dir, "../src/pipeline/index.ts");

let exporter: InMemorySpanExporter;
let tracing: TracingHandle | undefined;
const cleanups: Array<() => Promise<void>> = [];

function enableTracing(): void {
  exporter = new InMemorySpanExporter();
  tracing = setupTracing(
    { enabled: true, headers: {}, sampleRate: 1 },
    { spanProcessor: new SimpleSpanProcessor({ exporter }) },
  );
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await tracing?.shutdown();
  tracing = undefined;
});

function finished(name: string | RegExp): ReadableSpan[] {
  return exporter
    .getFinishedSpans()
    .filter((span) => (typeof name === "string" ? span.name === name : name.test(span.name)));
}

function only(name: string | RegExp): ReadableSpan {
  const matches = finished(name);
  expect(matches.map((span) => span.name)).toHaveLength(1);
  return matches[0]!;
}

function isChild(child: ReadableSpan, parent: ReadableSpan): boolean {
  return (
    child.spanContext().traceId === parent.spanContext().traceId &&
    child.parentSpanContext?.spanId === parent.spanContext().spanId
  );
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error("waitFor timed out");
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const echoAction = {
  name: "echo",
  description: "Echo",
  parameters: z.object({ fail: z.boolean().default(false) }),
  async handler(params: { fail: boolean }) {
    if (params.fail) throw new Error("echo failed");
    return { ok: true };
  },
};

describe("tracing setup", () => {
  test("everything is a no-op until tracing is enabled", async () => {
    tracing = setupTracing(undefined);
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line) });

    const value = await withSpan("work", {}, () => {
      logger.info("inside");
      return { traceIds: activeTraceIds(), traceparent: activeTraceparent() };
    });

    expect(value).toEqual({ traceIds: undefined, traceparent: undefined });
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("traceId");
  });

  test("reads the tracing section of the service config", async () => {
    const dir = await tempDir("ao-tracing-config-");
    const file = path.join(dir, "config.yaml");
    await writeFile(file, "tracing:\n  enabled: true\n  sampleRate: 0.25\n", "utf8");
    expect((await loadConfig(file)).tracing).toEqual({
      enabled: true,
      headers: {},
      sampleRate: 0.25,
    });

    await writeFile(file, "server:\n  port: 7071\n", "utf8");
    expect((await loadConfig(file)).tracing).toEqual({
      enabled: false,
      headers: {},
      sampleRate: 1,
    });
  });

  test("failed exports are logged and do not stop shutdown", async () => {
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line) });
    const rejecting: SpanExporter = {
      export: (_spans, done) =>
        done({ code: ExportResultCode.FAILED, error: new Error("collector said no") }),
      shutdown: async () => {
        throw new Error("final flush failed");
      },
    };
    tracing = setupTracing(
      { enabled: true, headers: {}, sampleRate: 1 },
      { logger, spanProcessor: new SimpleSpanProcessor({ exporter: rejecting }) },
    );

    await withSpan("work", {}, () => {});
    await tracing.shutdown();
    tracing = undefined;

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.some((e) => e.level === "error" && e.message.startsWith("opentelemetry:"))).toBe(
      true,
    );
    expect(entries.at(-1)).toMatchObject({
      level: "warn",
      message: "tracing shutdown could not export the remaining spans",
    });
  });

  test("log lines inside a span carry its trace and span IDs", async () => {
    enableTracing();
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line) });

    await withSpan("work", {}, () => logger.info("inside"));
    logger.info("outside");

    const span = only("work");
    expect(JSON.parse(lines[0]!)).toMatchObject({
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    });
    expect(JSON.parse(lines[1]!)).not.toHaveProperty("traceId");
  });
});

describe("HTTP tracing", () => {
  function createGateway(lines: string[]): Gateway {
    const config: AppConfig = {
      port: 7070,
      host: "127.0.0.1",
      dataDir: "/tmp/tracing-gateway-data",
      artifactDir: "/tmp/tracing-gateway-artifacts",
      projectConfigPath: "/tmp/tracing-gateway-projects",
      allowUnauthenticated: true,
      routerBaseUrl: "http://localhost:8317/v1",
      logLevel: "info",
      feishu: { enabled: false },
    };
    const store = new MemoryStore();
    const logger = new Logger({ sink: (line) => lines.push(line) });
    return new Gateway(config, store, new ProjectManager([], store, config, logger), logger);
  }

  test("continues the caller's trace and names the span after the route", async () => {
    enableTracing();
    const lines: string[] = [];
    const gateway = createGateway(lines);
    const callerTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    const res = await gateway.handle(
      new Request("http://localhost/api/v1/sessions/ses_missing?verbose=1", {
        headers: { traceparent: `00-${callerTraceId}-00f067aa0ba902b7-01` },
      }),
    );

    expect(res.status).toBe(404);
    const span = only("GET /api/v1/sessions/:sessionId");
    expect(span.spanContext().traceId).toBe(callerTraceId);
    expect(span.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(span.attributes).toMatchObject({
      "http.route": "/api/v1/sessions/:sessionId",
      "url.path": "/api/v1/sessions/ses_missing",
      "http.response.status_code": 404,
    });
    expect(res.headers.get("x-trace-id")).toBe(callerTraceId);
    const requestLog = lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.message === "gateway request completed");
    expect(requestLog.traceId).toBe(callerTraceId);
  });

  test("leaves health checks and other non-API paths untraced", async () => {
    enableTracing();
    const gateway = createGateway([]);

    await gateway.handle(new Request("http://localhost/healthz"));

    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

/** Emits each turn's events from outside any trace, as a runtime's own I/O callbacks do. */
class ToolCallingRuntime extends FakeRuntime {
  private gate = Promise.resolve();
  private openGate: () => void = () => {};

  constructor(private readonly actions: ActionRegistry) {
    super();
  }

  /** Makes the next turns wait until `release()`. */
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate();
  }

  override async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
  ): Promise<RuntimeTurn> {
    const runtimeTurnId = `rt_${turnId}`;
    const gate = this.gate;
    const emit = (type: string, payload: unknown) =>
      context.onEvent({ type, sessionId, turnId: runtimeTurnId, payload } as RuntimeEvent);
    setTimeout(() =>
      detached(async () => {
        await gate;
        await emit("agent.message.delta", { delta: "Working" });
        await emit("tool.call.started", { itemId: "tool-1", toolName: "echo", args: {} });
        await this.actions.execute("echo", {}, context.createActionContext!({ turnId }));
        await emit("tool.called", {
          itemId: "tool-1",
          toolName: "echo",
          args: {},
          status: "success",
        });
        await emit("command.started", { itemId: "cmd-1", command: "curl -H 'token: x'" });
        await emit("command.completed", {
          itemId: "cmd-1",
          command: "curl -H 'token: x'",
          exitCode: 7,
          output: "",
        });
        await emit("turn.completed", {
          usage: {
            model: "gpt-test",
            inputTokens: 100,
            cacheReadTokens: 20,
            cacheWriteTokens: 5,
            outputTokens: 40,
            reasoningTokens: 0,
            totalTokens: 165,
          },
        });
      }),
    );
    return { id: runtimeTurnId };
  }
}

describe("agent turn tracing", () => {
  async function createRuntime(): Promise<{
    runtime: ProjectRuntime;
    agent: ToolCallingRuntime;
    sessionId: string;
  }> {
    const root = await tempDir("ao-tracing-turn-");
    const store = new MemoryStore();
    const logger = new Logger({ sink: () => {} });
    const actions = new ActionRegistry(logger);
    actions.register(echoAction);
    const agent = new ToolCallingRuntime(actions);
    const project: ProjectConfig = {
      id: "traced",
      displayName: "Traced",
      description: "test",
      routing: { projectId: "traced" },
      repository: { url: "", baseBranch: "main" },
      runtime: { type: "fake", model: "gpt-test" },
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
    cleanups.push(() => runtime.stop());
    const sessionId = (await runtime.createSession()).sessionId;
    return { runtime, agent, sessionId };
  }

  test("a turn continues the request that queued it and contains its tools and commands", async () => {
    enableTracing();
    const { runtime, sessionId } = await createRuntime();

    await withSpan("request", {}, () => runtime.turn(sessionId, "do it"));
    await runtime.waitForIdle(sessionId);

    const request = only("request");
    const turn = only("invoke_agent fake");
    expect(isChild(turn, request)).toBe(true);
    expect(turn.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.conversation.id": sessionId,
      "gen_ai.request.model": "gpt-test",
      "gen_ai.response.model": "gpt-test",
      "gen_ai.usage.input_tokens": 125,
      "gen_ai.usage.cache_read.input_tokens": 20,
      "gen_ai.usage.cache_creation.input_tokens": 5,
      "gen_ai.usage.output_tokens": 40,
      "turn.status": "completed",
    });
    expect(turn.events.map((event) => event.name)).toEqual(["first_output"]);

    expect(isChild(only("workspace.prepare"), turn)).toBe(true);
    expect(isChild(only("runtime.bind_session"), turn)).toBe(true);
    const tool = only("execute_tool echo");
    expect(isChild(tool, turn)).toBe(true);
    expect(tool.attributes["gen_ai.tool.call.id"]).toBe("tool-1");
    // Called from outside any trace, the action still lands in the turn that called it.
    expect(isChild(only("action echo"), turn)).toBe(true);

    const command = only("command");
    expect(isChild(command, turn)).toBe(true);
    expect(command.status.code).toBe(2);
    expect(command.attributes["process.exit.code"]).toBe(7);
    expect(JSON.stringify(command.attributes)).not.toContain("token");
  });

  test("each queued turn keeps the trace it was queued from", async () => {
    enableTracing();
    const { runtime, agent, sessionId } = await createRuntime();

    agent.hold();
    await withSpan("first request", {}, () => runtime.turn(sessionId, "first"));
    await withSpan("second request", {}, () => runtime.turn(sessionId, "second"));
    agent.release();
    await runtime.waitForIdle(sessionId);

    const turns = finished("invoke_agent fake");
    expect(turns).toHaveLength(2);
    expect(isChild(turns[0]!, only("first request"))).toBe(true);
    expect(isChild(turns[1]!, only("second request"))).toBe(true);
  });
});

describe("action and task tracing", () => {
  test("a failed action marks its span as an error", async () => {
    enableTracing();
    const actions = new ActionRegistry(new Logger({ sink: () => {} }));
    actions.register(echoAction);

    const result = await actions.execute(
      "echo",
      { fail: true },
      { projectId: "p", sessionId: "s", scope: "conversation" },
    );

    expect(result.success).toBe(false);
    const span = only("action echo");
    expect(span.status).toMatchObject({ code: 2, message: "echo failed" });
    expect(span.attributes).toMatchObject({ "action.name": "echo", "project.id": "p" });
  });

  test("each queued task continues the trace that dispatched it", async () => {
    enableTracing();
    const engine = new TaskEngine(undefined, new Logger({ sink: () => {} }), {
      maxConcurrency: 1,
    });
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    engine.setExecutor(async (task, stateBefore) => {
      if (task.taskId === "first") await firstBlocked;
      return { success: task.taskId === "first", durationMs: 0, stateBefore, stateAfter: {} };
    });
    const task = (taskId: string): TaskDefinition => ({
      taskKey: `p:${taskId}`,
      projectId: "p",
      taskId,
      name: taskId,
      cron: "* * * * *",
      enabled: true,
      promptTemplate: "",
      filePath: `${taskId}.yaml`,
    });

    await withSpan("cron tick", {}, () => engine.dispatch(task("first")));
    await withSpan("api request", {}, () => engine.dispatch(task("second")));
    releaseFirst();
    await engine.drain();

    expect(isChild(only("task p:first"), only("cron tick"))).toBe(true);
    const second = only("task p:second");
    expect(isChild(second, only("api request"))).toBe(true);
    expect(second.status.code).toBe(2);
  });
});

/** Ends every agent turn by calling `pipeline_next`, from outside any trace. */
class AdvancingRuntime extends FakeRuntime {
  constructor(private readonly actions: ActionRegistry) {
    super();
  }

  override async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
  ): Promise<RuntimeTurn> {
    const runtimeTurnId = `rt_${turnId}`;
    setTimeout(() =>
      detached(async () => {
        await this.actions.execute(
          "pipeline_next",
          { summary: "Drafted", content: "Draft done" },
          context.createActionContext!({ turnId }),
          { parameterOverride: context.actionParameterOverrides?.pipeline_next },
        );
        await context.onEvent({
          type: "turn.completed",
          sessionId,
          turnId: runtimeTurnId,
          payload: {},
        });
      }),
    );
    return { id: runtimeTurnId };
  }
}

describe("pipeline tracing", () => {
  test("each node launch is its own trace, linked to what created the node run", async () => {
    enableTracing();
    const root = await tempDir("ao-tracing-pipeline-");
    const projectDir = path.join(root, "project");
    await mkdir(path.join(projectDir, "pipelines"), { recursive: true });
    await writeFile(
      path.join(projectDir, "pipelines", "flow.ts"),
      `import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Flow",
  nodes: [
    node.agent({ id: "draft", name: "Draft", prompt: "Draft it", gate: "auto" }),
    node.code({
      id: "check",
      name: "Check",
      async run() {
        return { action: "next", summary: "Checked", content: "ok" };
      },
    }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`,
      "utf8",
    );
    const store = new MemoryStore();
    const logger = new Logger({ sink: () => {} });
    const actions = new ActionRegistry(logger, store);
    actions.registerAll(pipelineActions);
    const project: ProjectConfig = {
      id: "traced",
      displayName: "Traced",
      description: "test",
      routing: { projectId: "traced" },
      projectDir,
      repository: { url: "", baseBranch: "main" },
      runtime: { type: "fake" },
    };
    const dataDir = path.join(root, "data");
    const runtime = new ProjectRuntime(
      project,
      store,
      new AdvancingRuntime(actions),
      new WorkspaceManager(
        path.join(dataDir, "projects"),
        path.join(dataDir, "bases"),
        path.join(dataDir, "secrets"),
        logger,
        path.join(dataDir, "pipelines"),
      ),
      new ArtifactStore(path.join(root, "artifacts"), store),
      undefined,
      logger,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      actions,
    );
    await runtime.start();
    cleanups.push(() => runtime.stop());

    const { run } = await withSpan("start request", {}, () =>
      runtime.pipelineEngine.startRun({ pipelineId: "flow", title: "Traced run" }),
    );
    await waitFor(async () => {
      const latest = await store.pipelines.getRun(run.runId);
      return latest?.status === "completed" ? latest : undefined;
    });
    await waitFor(() => (finished("pipeline.node check").length > 0 ? true : undefined));

    const startRequest = only("start request");
    const draftNode = only("pipeline.node draft");
    expect(draftNode.parentSpanContext).toBeUndefined();
    expect(draftNode.links.map((link) => link.context.spanId)).toEqual([
      startRequest.spanContext().spanId,
    ]);
    expect(draftNode.attributes).toMatchObject({
      "pipeline.id": "flow",
      "pipeline.run_id": run.runId,
      "pipeline.node_id": "draft",
      "pipeline.node.executor": "agent",
    });

    // The agent's turn runs in the node's trace; its pipeline_next call lands in the turn.
    const turn = only("invoke_agent fake");
    expect(isChild(turn, draftNode)).toBe(true);
    expect(isChild(only("action pipeline_next"), turn)).toBe(true);

    // The turn finishing created the next node run, so the next launch links to the turn.
    const checkNode = only("pipeline.node check");
    expect(checkNode.parentSpanContext).toBeUndefined();
    expect(checkNode.links.map((link) => link.context.spanId)).toEqual([turn.spanContext().spanId]);
    const nodeRuns = await store.pipelines.listNodeRuns(run.runId);
    expect(nodeRuns.find((nodeRun) => nodeRun.nodeId === "check")?.traceparent).toContain(
      turn.spanContext().spanId,
    );
  });
});
