import { describe, expect, test } from "bun:test";
import {
  createProjectContext,
  type ProjectContextServices,
  type StartSessionParams,
} from "../src/context/index.ts";
import type { Origin } from "../src/domain/origin.ts";
import type { ArtifactRecord, ProjectConfig } from "../src/domain/types.ts";
import type { McpClientLike } from "../src/mcp/index.ts";
import { Logger } from "../src/observability/logger.ts";
import type { PipelineRunRecord, StartPipelineRunParams } from "../src/pipeline/types.ts";

const project: ProjectConfig = {
  id: "shop",
  displayName: "Shop",
  description: "test",
  routing: { projectId: "shop" },
  repository: { url: "", baseBranch: "main" },
  projectDir: "/projects/shop",
  env: { TOKEN: "t" },
  vars: { team: "payments" },
  notifications: [{ name: "log", type: "log", enabled: true }],
  runtime: { type: "fake", mcpServers: [{ name: "jira", command: "jira-mcp" }] },
};

const taskOrigin: Origin = {
  kind: "task",
  taskId: "nightly",
  taskKey: "shop:nightly",
  executionId: "texe_1",
};
const nodeOrigin: Origin = {
  kind: "pipeline",
  pipelineId: "deploy",
  runId: "run_1",
  nodeId: "build",
  nodeRunId: "nr_1",
};

function harness() {
  const queued: unknown[][] = [];
  const written: unknown[][] = [];
  const startedSessions: Array<{ params: StartSessionParams; origin: Origin }> = [];
  const startedRuns: StartPipelineRunParams[] = [];
  const signalled: string[] = [];
  const runs = new Map<string, PipelineRunRecord>();
  const lines: string[] = [];
  const closedClients: string[] = [];

  const services: ProjectContextServices = {
    project,
    logger: new Logger({ sink: (line) => lines.push(line) }),
    notifications: {
      queue: async (...args: unknown[]) => {
        queued.push(args);
        return "delivery_1";
      },
    },
    artifacts: {
      write: async (...args: unknown[]) => {
        written.push(args);
        return { id: "art_1" } as ArtifactRecord;
      },
    },
    sessions: {
      start: async (params, origin) => {
        startedSessions.push({ params, origin });
        return { sessionId: "ses_new", turnId: "turn_new" };
      },
    },
    pipelines: {
      start: async (params) => {
        startedRuns.push(params);
        return { created: true, run: { runId: "run_new" } as PipelineRunRecord };
      },
      find: async (pipelineId, externalKey) => runs.get(`${pipelineId}/${externalKey}`) ?? null,
      list: async () => [],
      signal: async (runId) => {
        signalled.push(runId);
        return { woken: true };
      },
    },
    mcpClientFactory: async (server) =>
      ({
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        listTools: async () => ({ tools: [] }),
        close: async () => {
          closedClients.push(server.name);
        },
      }) satisfies McpClientLike,
  };
  return {
    services,
    queued,
    written,
    startedSessions,
    startedRuns,
    signalled,
    runs,
    lines,
    closedClients,
  };
}

describe("project context", () => {
  test("notifications and artifacts belong to the origin", async () => {
    const h = harness();
    const task = createProjectContext(h.services, taskOrigin, {
      signal: new AbortController().signal,
    }).context;
    await task.notify({ title: "Done", text: "nightly finished" });
    expect(h.queued[0]?.slice(0, 3)).toEqual([
      "shop",
      { kind: "task", id: "texe_1" },
      project.notifications,
    ]);

    const node = createProjectContext(h.services, nodeOrigin, {
      signal: new AbortController().signal,
    }).context;
    await node.artifacts.create({ kind: "report", content: "# ok" });
    expect(h.written[0]).toEqual([
      "shop",
      { kind: "pipeline", id: "nr_1" },
      undefined,
      "report",
      "# ok",
      "text/plain",
    ]);

    const session = createProjectContext(
      h.services,
      { kind: "session", sessionId: "ses_1", turnId: "turn_1" },
      { signal: new AbortController().signal },
    ).context;
    await session.artifacts.create({ kind: "log", content: "x", contentType: "text/x-log" });
    expect(h.written[1]?.slice(1, 3)).toEqual([{ kind: "session", id: "ses_1" }, "turn_1"]);
  });

  test("pipelines it starts are created by the origin unless the caller says otherwise", async () => {
    const h = harness();
    const { context } = createProjectContext(h.services, taskOrigin, {
      signal: new AbortController().signal,
    });
    await context.pipelines.start({ pipelineId: "deploy", title: "Deploy" });
    await context.pipelines.start({ pipelineId: "deploy", title: "Deploy", createdBy: "someone" });
    expect(h.startedRuns.map((run) => run.createdBy)).toEqual(["task:nightly", "someone"]);
  });

  test("a run is signalled by its external key, and an unknown key wakes nothing", async () => {
    const h = harness();
    h.runs.set("issue-to-pr/gh-7", { runId: "run_7" } as PipelineRunRecord);
    const { context } = createProjectContext(h.services, taskOrigin, {
      signal: new AbortController().signal,
    });
    expect(
      await context.pipelines.signal({ pipelineId: "issue-to-pr", externalKey: "gh-7" }),
    ).toEqual({ woken: true });
    expect(
      await context.pipelines.signal({ pipelineId: "issue-to-pr", externalKey: "gh-8" }),
    ).toEqual({ woken: false });
    await context.pipelines.signal({ runId: "run_9" });
    expect(h.signalled).toEqual(["run_7", "run_9"]);
  });

  test("sessions it starts know their origin", async () => {
    const h = harness();
    const { context } = createProjectContext(h.services, nodeOrigin, {
      signal: new AbortController().signal,
    });
    await context.sessions.start({ title: "Fix", prompt: "fix it", model: "m" });
    expect(h.startedSessions).toEqual([
      { params: { title: "Fix", prompt: "fix it", model: "m" }, origin: nodeOrigin },
    ]);
  });

  test("nothing starts after the signal aborts", async () => {
    const h = harness();
    const controller = new AbortController();
    const { context } = createProjectContext(h.services, taskOrigin, { signal: controller.signal });
    controller.abort();
    await expect(context.notify({ title: "x", text: "y" })).rejects.toThrow();
    await expect(context.artifacts.create({ kind: "k", content: "c" })).rejects.toThrow();
    await expect(context.sessions.start({ title: "t", prompt: "p" })).rejects.toThrow();
    await expect(context.pipelines.start({ pipelineId: "p", title: "t" })).rejects.toThrow();
    expect(h.queued).toHaveLength(0);
    expect(h.startedSessions).toHaveLength(0);
  });

  test("MCP connections are opened on use and closed when the context is disposed", async () => {
    const h = harness();
    const scoped = createProjectContext(h.services, taskOrigin, {
      signal: new AbortController().signal,
    });
    await scoped.context.mcp.call("jira", "search", { jql: "x" });
    expect(h.closedClients).toEqual([]);
    await scoped.dispose();
    expect(h.closedClients).toEqual(["jira"]);
  });

  test("logs carry the project and origin", () => {
    const h = harness();
    const { context } = createProjectContext(h.services, nodeOrigin, {
      signal: new AbortController().signal,
    });
    context.logger.info("building");
    expect(JSON.parse(h.lines[0]!)).toMatchObject({
      projectId: "shop",
      runId: "run_1",
      nodeId: "build",
      nodeRunId: "nr_1",
    });
  });

  test("templates see the project, its vars and the origin's own variables", () => {
    const h = harness();
    let state = { cursor: 1 };
    const { context } = createProjectContext(h.services, taskOrigin, {
      signal: new AbortController().signal,
      renderScopes: () => ({ state }),
    });
    state = { cursor: 2 };
    expect(
      context.render("{{project.id}} {{vars.team}} {{state.cursor}} {{issue}}", { issue: "#7" }),
    ).toBe("shop payments 2 #7");
  });
});
