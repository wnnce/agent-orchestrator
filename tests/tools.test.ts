import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createProjectContext,
  type ProjectContextServices,
  type StartSessionParams,
} from "../src/context/index.ts";
import type { SessionOrigin, SessionOwner } from "../src/domain/origin.ts";
import type { ArtifactRecord, ProjectConfig, ToolExecutionRecord } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import type { PipelineRunRecord } from "../src/pipeline/types.ts";
import {
  builtinTools,
  defineTool,
  type PipelineOwner,
  type TaskOwner,
  type ToolContext,
  ToolRegistry,
} from "../src/tools/index.ts";

const project: ProjectConfig = {
  id: "shop",
  displayName: "Shop",
  description: "test",
  routing: { projectId: "shop" },
  repository: { url: "", baseBranch: "main" },
  notifications: [{ name: "log", type: "log", enabled: true }],
};

const taskOwner: SessionOwner = {
  kind: "task",
  taskId: "nightly",
  taskKey: "shop:nightly",
  executionId: "exec_1",
};
const pipelineOwner: SessionOwner = {
  kind: "pipeline",
  pipelineId: "deploy",
  runId: "run_1",
  nodeId: "build",
  nodeRunId: "pnr_1",
};

interface Harness {
  ctx: ToolContext;
  notified: unknown[][];
  startedSessions: StartSessionParams[];
  decisions: unknown[][];
  taskState: Record<string, unknown>;
}

function harness(owner?: SessionOwner): Harness {
  const notified: unknown[][] = [];
  const startedSessions: StartSessionParams[] = [];
  const decisions: unknown[][] = [];
  let taskState: Record<string, unknown> = { cursor: 1 };
  const services: ProjectContextServices = {
    project,
    logger: new Logger({ sink: () => {} }),
    notifications: {
      queue: async (...args: unknown[]) => {
        notified.push(args);
        return "delivery_1";
      },
    },
    artifacts: {
      write: async () => ({ id: "art_1", path: "/a", sizeBytes: 3 }) as ArtifactRecord,
    },
    sessions: {
      start: async (params) => {
        startedSessions.push(params);
        return { sessionId: "ses_new", turnId: "turn_new" };
      },
    },
    pipelines: {
      start: async () => ({ created: true, run: { runId: "run_new" } as PipelineRunRecord }),
      find: async () => null,
      signal: async () => ({ woken: true }),
      list: async () => [],
    },
  };
  const origin: SessionOrigin = { kind: "session", sessionId: "ses_1", turnId: "turn_1" };
  const { context } = createProjectContext(services, origin, {
    signal: new AbortController().signal,
  });
  const richOwner: TaskOwner | PipelineOwner | undefined =
    owner?.kind === "task"
      ? {
          ...owner,
          state: {
            get: () => taskState,
            set: (next) => {
              taskState = next;
            },
            merge: (patch) => {
              taskState = { ...taskState, ...patch };
            },
          },
        }
      : owner?.kind === "pipeline"
        ? {
            ...owner,
            decide: async (action, payload) => {
              decisions.push([action, payload]);
              return { accepted: true, action };
            },
            context: async () => ({}) as never,
            history: { list: async () => [], get: async () => null },
          }
        : undefined;
  const ctx: ToolContext = {
    ...context,
    origin,
    session: {
      id: "ses_1",
      turnId: "turn_1",
      workspace: "/ws",
      schedule: async () => {
        throw new Error("not used");
      },
      cancelSchedule: async () => false,
    },
    ...(richOwner ? { owner: richOwner } : {}),
  };
  return {
    ctx,
    notified,
    startedSessions,
    decisions,
    get taskState() {
      return taskState;
    },
  } as Harness;
}

const echoTool = defineTool({
  name: "echo",
  description: "Echoes its input",
  input: z.object({ text: z.string(), times: z.number().int().optional() }),
  run: async (input) => ({ echoed: input.text.repeat(input.times ?? 1) }),
});

const failingTool = defineTool({
  name: "explode",
  description: "Always fails",
  input: z.object({}),
  run: async () => {
    throw new Error("boom");
  },
});

function registry(audit?: (record: ToolExecutionRecord) => Promise<void>) {
  return new ToolRegistry([echoTool, failingTool], new Logger({ sink: () => {} }), audit);
}

describe("which tools a session is offered", () => {
  const names = (owner?: SessionOwner) =>
    new ToolRegistry(builtinTools, new Logger({ sink: () => {} }))
      .list({ owner })
      .map((tool) => tool.name)
      .sort();

  test("a conversation can notify, dispatch, schedule wake-ups and start pipelines", () => {
    expect(names()).toEqual([
      "cancel_job",
      "create_artifact",
      "dispatch_agent_task",
      "dispatch_pipeline_run",
      "list_project_pipelines",
      "schedule_job",
      "send_notification",
    ]);
  });

  test("a task's session can also update the task's state, but not schedule wake-ups", () => {
    expect(names(taskOwner)).toEqual([
      "create_artifact",
      "dispatch_agent_task",
      "dispatch_pipeline_run",
      "list_project_pipelines",
      "send_notification",
      "update_task_state",
    ]);
  });

  test("a pipeline node's agent gets the node's flow tools and does not start other pipelines", () => {
    expect(names(pipelineOwner)).toEqual([
      "create_artifact",
      "dispatch_agent_task",
      "pipeline_fail",
      "pipeline_get_context",
      "pipeline_get_history_detail",
      "pipeline_list_history",
      "pipeline_next",
      "pipeline_prev",
      "pipeline_request_confirmation",
      "send_notification",
    ]);
  });

  test("specs carry JSON Schema, and a per-session input replaces a tool's own", () => {
    const tools = registry();
    const [spec] = tools.specs({}, { echo: z.object({ text: z.literal("hi") }) });
    expect(spec).toMatchObject({ name: "echo", description: "Echoes its input" });
    expect(spec?.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { const: "hi" } },
    });
  });
});

describe("calling a tool", () => {
  test("validated input reaches the tool, and JSON-encoded arguments are parsed", async () => {
    const { ctx } = harness();
    const result = await registry().call("echo", '{"text":"ab","times":2}', ctx);
    expect(result).toMatchObject({ ok: true, data: { echoed: "abab" } });
    expect(JSON.parse(result.text)).toEqual({ echoed: "abab" });
  });

  test("invalid arguments, unknown tools and thrown errors come back as failures", async () => {
    const { ctx } = harness();
    const tools = registry();
    expect(await tools.call("echo", { times: 2 }, ctx)).toMatchObject({ ok: false });
    expect(await tools.call("echo", "{not json", ctx)).toMatchObject({ ok: false });
    expect(await tools.call("missing", {}, ctx)).toMatchObject({
      ok: false,
      error: 'tool "missing" is not available',
    });
    const thrown = await tools.call("explode", {}, ctx);
    expect(thrown).toMatchObject({ ok: false, error: "boom" });
    expect(JSON.parse(thrown.text)).toEqual({ error: "boom" });
  });

  test("a tool the session is not offered cannot be called", async () => {
    const { ctx } = harness();
    const tools = new ToolRegistry(builtinTools, new Logger({ sink: () => {} }));
    expect(await tools.call("update_task_state", { state: { a: 1 } }, ctx)).toMatchObject({
      ok: false,
      error: 'tool "update_task_state" is not available',
    });
  });

  test("a per-session input is what the call is validated against", async () => {
    const { ctx } = harness();
    const result = await registry().call("echo", { text: "bye" }, ctx, {
      input: z.object({ text: z.literal("hi") }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("tool audit", () => {
  test("each call is recorded with its session, turn and owner", async () => {
    const records: ToolExecutionRecord[] = [];
    const { ctx } = harness(taskOwner);
    const tools = registry(async (record) => {
      records.push(record);
    });
    await tools.call("echo", { text: "x" }, ctx);
    await tools.call("explode", {}, ctx);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      projectId: "shop",
      sessionId: "ses_1",
      turnId: "turn_1",
      ownerKind: "task",
      ownerId: "exec_1",
      toolName: "echo",
      parameters: { text: "x" },
      status: "success",
      result: { echoed: "x" },
    });
    expect(records[1]).toMatchObject({ status: "failure", errorMessage: "boom" });
  });

  test("large payloads are truncated in the audit record", async () => {
    const records: ToolExecutionRecord[] = [];
    const { ctx } = harness();
    await registry(async (record) => {
      records.push(record);
    }).call("echo", { text: "a".repeat(5000) }, ctx);
    expect(String(records[0]?.parameters.text)).toContain("[Truncated 904 chars]");
  });

  test("a failing audit does not change what the agent sees", async () => {
    const { ctx } = harness();
    const result = await registry(async () => {
      throw new Error("db down");
    }).call("echo", { text: "x" }, ctx);
    expect(result.ok).toBe(true);
  });
});

describe("built-in tools", () => {
  const tools = () => new ToolRegistry(builtinTools, new Logger({ sink: () => {} }));

  test("send_notification notifies as the session", async () => {
    const h = harness();
    await tools().call("send_notification", { title: "Done", text: "ok", level: "success" }, h.ctx);
    expect(h.notified[0]?.slice(0, 2)).toEqual(["shop", { kind: "session", id: "ses_1" }]);
    expect(h.notified[0]?.[3]).toEqual({ title: "Done", text: "ok", level: "success" });
  });

  test("dispatch_agent_task starts a session", async () => {
    const h = harness();
    const result = await tools().call(
      "dispatch_agent_task",
      { title: "Fix #7", prompt: "fix it" },
      h.ctx,
    );
    expect(result.data).toMatchObject({ sessionId: "ses_new", turnId: "turn_new" });
    expect(h.startedSessions).toEqual([{ title: "Fix #7", prompt: "fix it", metadata: undefined }]);
  });

  test("update_task_state merges into the owning task's state unless told to replace it", async () => {
    const h = harness(taskOwner);
    await tools().call("update_task_state", { state: { since: "t1" } }, h.ctx);
    expect(h.taskState).toEqual({ cursor: 1, since: "t1" });
    await tools().call("update_task_state", { state: { since: "t2" }, merge: false }, h.ctx);
    expect(h.taskState).toEqual({ since: "t2" });
  });

  test("pipeline_next records the decision on the owning node", async () => {
    const h = harness(pipelineOwner);
    const result = await tools().call(
      "pipeline_next",
      { summary: "built", content: "all green" },
      h.ctx,
    );
    expect(result.ok).toBe(true);
    expect(h.decisions[0]?.[0]).toBe("pipeline_next");
    expect(h.decisions[0]?.[1]).toMatchObject({ summary: "built", content: "all green" });
  });
});
