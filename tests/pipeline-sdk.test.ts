import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ActionRegistry, builtinActions } from "../src/actions/index.ts";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import {
  PipelineEventHub,
  PipelineValidationError,
  compilePipelineBlueprint,
  defineHandler,
  definePipeline,
  node,
} from "../src/pipeline/index.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import { actionToJsonSchema, resolveActionsForSite } from "../src/runtime/action-bridge.ts";
import { ACPMcpBridge } from "../src/runtime/acp/mcp-bridge.ts";
import { bridgeActionsToPiTools } from "../src/runtime/pi/tools.ts";
import {
  FAKE_CAPABILITIES,
  type AgentRuntime,
  type ApprovalDecision,
  type RuntimeContext,
  type RuntimeSession,
  type RuntimeTurn,
} from "../src/runtime/runtime.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

const tempDirs: string[] = [];
const SDK_PATH = path.resolve(import.meta.dir, "../src/pipeline/index.ts");

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createTempGitRepo(rootDir: string): Promise<string> {
  const repoDir = path.join(rootDir, "origin-repo");
  await mkdir(repoDir, { recursive: true });
  const runGit = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
    }
  };
  runGit("init", "-b", "main");
  runGit("config", "user.email", "pipeline-sdk-test@example.com");
  runGit("config", "user.name", "Pipeline SDK Test");
  await writeFile(path.join(repoDir, "README.md"), "# SDK Test Repo\n", "utf8");
  runGit("add", "README.md");
  runGit("commit", "-m", "initial commit");
  return repoDir;
}

async function waitFor<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 5_000,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await check();
    if (res) return res;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

class InspectableScriptedRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly type = "fake";
  readonly capabilities = FAKE_CAPABILITIES;

  readonly seenContexts: RuntimeContext[] = [];
  readonly seenPrompts: string[] = [];

  private readonly handlers: Array<
    (args: {
      input: string;
      context: RuntimeContext;
      callAction: (name: string, params: Record<string, unknown>) => Promise<unknown>;
    }) => Promise<string | void> | string | void
  > = [];

  constructor(private readonly actionRegistry: ActionRegistry) {}

  enqueue(
    handler: (args: {
      input: string;
      context: RuntimeContext;
      callAction: (name: string, params: Record<string, unknown>) => Promise<unknown>;
    }) => Promise<string | void> | string | void,
  ): void {
    this.handlers.push(handler);
  }

  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    this.seenContexts.push(context);
    return { id: `rt_${crypto.randomUUID()}`, workspacePath: context.workspacePath };
  }
  async resumeSession(context: RuntimeContext, id: string): Promise<RuntimeSession> {
    this.seenContexts.push(context);
    return { id, workspacePath: context.workspacePath };
  }
  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    this.seenPrompts.push(input);
    const runtimeTurnId = `turn_${crypto.randomUUID()}`;
    const handler = this.handlers.shift();
    queueMicrotask(async () => {
      try {
        await context.onEvent({
          type: "turn.started",
          sessionId,
          turnId,
          payload: { runtimeTurnId },
        });
        let outputText = "ok";
        if (handler) {
          const maybe = await handler({
            input,
            context,
            callAction: async (name, params) => {
              const actionCtx = context.createActionContext?.({ turnId });
              if (!actionCtx) throw new Error("missing createActionContext");
              return this.actionRegistry.execute(name, params, actionCtx, {
                parameterOverride: context.actionParameterOverrides?.[name],
              });
            },
          });
          if (typeof maybe === "string") outputText = maybe;
        }
        await context.onEvent({
          type: "agent.message.completed",
          sessionId,
          turnId,
          payload: { text: outputText },
        });
        await context.onEvent({
          type: "turn.completed",
          sessionId,
          turnId,
          payload: { runtimeTurnId },
        });
      } catch (err) {
        await context.onEvent({
          type: "turn.failed",
          sessionId,
          turnId,
          payload: { runtimeTurnId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    });
    return { id: runtimeTurnId };
  }
  async steerTurn(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async compactSession(): Promise<void> {}
  async respondToApproval(
    _ctx: RuntimeContext,
    _req: string,
    _d: ApprovalDecision,
  ): Promise<void> {}
  async releaseSession(): Promise<void> {}
  async stop(): Promise<void> {}
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("Typed Pipeline SDK (`definePipeline`, `defineHandler`, `node.*`)", () => {
  it("supports inline and external `node.code`, and rejects mixing `handler` with `input` or `run`", () => {
    const ext = defineHandler({
      input: z.object({ prNumber: z.number().int().positive() }),
      async run(ctx) {
        return { action: "next", summary: `PR #${ctx.data.prNumber}`, content: "ok" };
      },
    });

    const inlineNode = node.code({
      id: "inline",
      name: "Inline",
      input: z.object({ tag: z.string() }),
      async run(ctx) {
        return { action: "next", summary: ctx.data.tag, content: "ok" };
      },
    });
    const externalNode = node.code({ id: "external", name: "External", handler: ext });

    expect(inlineNode.executor).toBe("ts");
    expect(externalNode.executor).toBe("ts");
    expect(externalNode.input).toBe(ext.input);

    expect(() =>
      // Runtime guard against JS callers mixing handler + input
      (node.code as unknown as (cfg: Record<string, unknown>) => unknown)({
        id: "bad1",
        name: "Bad 1",
        handler: ext,
        input: z.object({ other: z.string() }),
      }),
    ).toThrow(PipelineValidationError);

    expect(() =>
      (node.code as unknown as (cfg: Record<string, unknown>) => unknown)({
        id: "bad2",
        name: "Bad 2",
        handler: ext,
        run: async () => ({ action: "next", summary: "x", content: "y" }),
      }),
    ).toThrow(PipelineValidationError);
  });

  it("statically validates `{{ data.xxx }}` prompt refs against declared node `input` at load time", async () => {
    const projectDir = await makeTempDir("ao-pipe-static-");

    // 1. Valid refs (declared field + fallback default for undeclared)
    const valid = definePipeline({
      id: "valid",
      name: "Valid",
      nodes: [
        node.agent({
          id: "design",
          name: "Design",
          input: z.object({ repo: z.string(), issueNumber: z.number() }),
          prompt: "Repo: {{ data.repo }} #{{ data.issueNumber }} ({{ data.optionalNote | none }})",
        }),
        node.end({ id: "done", name: "Done" }),
      ],
    });
    const compiled = await compilePipelineBlueprint(valid, {
      projectId: "p1",
      projectDir,
      filePath: path.join(projectDir, "pipelines", "valid.ts"),
    });
    expect(compiled.nodes[0]?.inputJsonSchema).toBeDefined();

    // 2. Undeclared data field without default -> fails fast!
    const missingField = definePipeline({
      id: "missing-field",
      name: "Missing Field",
      nodes: [
        node.agent({
          id: "design",
          name: "Design",
          input: z.object({ repo: z.string() }),
          prompt: "Issue: {{ data.issueNumber }}",
        }),
        node.end({ id: "done", name: "Done" }),
      ],
    });
    await expect(
      compilePipelineBlueprint(missingField, {
        projectId: "p1",
        projectDir,
        filePath: path.join(projectDir, "pipelines", "missing-field.ts"),
      }),
    ).rejects.toThrow("undeclared data fields");

    // 3. No input schema declared at all, yet prompt references {{ data.repo }} -> fails fast!
    const noSchema = definePipeline({
      id: "no-schema",
      name: "No Schema",
      nodes: [
        node.agent({
          id: "design",
          name: "Design",
          prompt: "Repo: {{ data.repo }}",
        }),
        node.end({ id: "done", name: "Done" }),
      ],
    });
    await expect(
      compilePipelineBlueprint(noSchema, {
        projectId: "p1",
        projectDir,
        filePath: path.join(projectDir, "pipelines", "no-schema.ts"),
      }),
    ).rejects.toThrow("undeclared data fields");
  });

  it("keeps topologyHash stable when only a node's `input` schema changes (live contract)", async () => {
    const projectDir = await makeTempDir("ao-pipe-hash-");
    const opts = {
      projectId: "p1",
      projectDir,
      filePath: path.join(projectDir, "pipelines", "ver.ts"),
    };

    const v1 = await compilePipelineBlueprint(
      definePipeline({
        id: "ver",
        name: "Ver",
        nodes: [
          node.agent({ id: "a", name: "A", prompt: "hi", input: z.object({ issue: z.number() }) }),
          node.end({ id: "done", name: "Done" }),
        ],
      }),
      opts,
    );
    const v2 = await compilePipelineBlueprint(
      definePipeline({
        id: "ver",
        name: "Ver",
        nodes: [
          node.agent({
            id: "a",
            name: "A",
            prompt: "hi",
            input: z.object({ issue: z.number(), repo: z.string() }),
          }),
          node.end({ id: "done", name: "Done" }),
        ],
      }),
      opts,
    );
    expect(v1.topologyHash).toBe(v2.topologyHash);
  });

  it("enforces dynamic per-session `pipeline_next` schemas, `{{ data.xxx }}` rendering, free `metadata`, and rework data inheritance end-to-end", async () => {
    const rootDir = await makeTempDir("ao-pipe-sdk-e2e-");
    const repoDir = await createTempGitRepo(rootDir);
    const projectDir = path.join(rootDir, "project");
    const dataDir = path.join(rootDir, "data");
    const artifactDir = path.join(rootDir, "artifacts");
    const observedFile = path.join(rootDir, "observed.json");

    await mkdir(path.join(projectDir, "pipelines"), { recursive: true });
    await writeFile(
      path.join(projectDir, "pipelines", "typed-flow.ts"),
      `import { readFile, writeFile } from "node:fs/promises";
import { defineHandler, definePipeline, node, z } from ${JSON.stringify(SDK_PATH)};

const observedFile = ${JSON.stringify(observedFile)};

const watchPr = defineHandler({
  input: z.object({
    prNumber: z.number().int().positive(),
    branch: z.string().min(1),
  }),
  async run(ctx) {
    const log = JSON.parse(await readFile(observedFile, "utf8").catch(() => "[]"));
    log.push({
      node: ctx.nodeId,
      attempt: ctx.attempt,
      data: ctx.data,
      metadata: ctx.metadata,
      rework: ctx.rework ?? null,
    });
    await writeFile(observedFile, JSON.stringify(log), "utf8");

    if (ctx.attempt === 1) {
      return {
        action: "prev",
        targetNodeId: "implement",
        reason: "Needs lint fix",
        feedback: "Fix formatting on PR #" + ctx.data.prNumber,
        metadata: { reviewRound: 1 },
      };
    }

    return {
      action: "next",
      summary: "Merged PR #" + ctx.data.prNumber,
      content: "Branch " + ctx.data.branch + " merged.",
      metadata: { merged: true },
    };
  },
});

export default definePipeline({
  id: "typed-flow",
  name: "Typed Flow",
  nodes: [
    node.agent({
      id: "design",
      name: "Design",
      input: z.object({
        issueNumber: z.number().int().positive(),
        repo: z.string().default("acme/demo"),
      }),
      prompt: "Design for {{ data.repo }}#{{ data.issueNumber }} (source={{ metadata.source | unknown }})",
    }),
    node.agent({
      id: "implement",
      name: "Implement",
      input: z.object({
        suggestedBranch: z.string().min(1),
      }),
      prompt: "Implement on branch {{ data.suggestedBranch }}",
      allowPrev: true,
      prevTargets: ["design"],
    }),
    node.code({
      id: "untyped_step",
      name: "Untyped Step",
      async run(ctx) {
        const log = JSON.parse(await readFile(observedFile, "utf8").catch(() => "[]"));
        log.push({
          node: ctx.nodeId,
          attempt: ctx.attempt,
          data: ctx.data,
          metadata: ctx.metadata,
        });
        await writeFile(observedFile, JSON.stringify(log), "utf8");
        return {
          action: "next",
          summary: "Opened PR",
          content: "Created PR #99",
          data: { prNumber: 99, branch: "feat/issue-42" },
          metadata: { prUrl: "https://github.com/acme/demo/pull/99" },
        };
      },
    }),
    node.code({
      id: "watch_pr",
      name: "Watch PR",
      handler: watchPr,
      allowPrev: true,
      prevTargets: ["implement"],
    }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`,
      "utf8",
    );

    const store = new MemoryStore();
    const logger = new Logger({ level: "error" });
    const actionRegistry = new ActionRegistry(logger, store);
    actionRegistry.registerAll(builtinActions);

    const project: ProjectConfig = {
      id: "sdk-demo",
      displayName: "SDK Demo",
      description: "SDK Demo",
      routing: {
        projectId: "sdk-demo",
        displayName: "SDK Demo",
        summary: "SDK Demo",
        keywords: [],
      },
      projectDir,
      repository: { url: repoDir, baseBranch: "main" },
      runtime: { type: "fake" },
    };

    const workspaces = new WorkspaceManager(
      path.join(dataDir, "projects"),
      path.join(dataDir, "bases"),
      path.join(dataDir, "secrets"),
      logger,
      path.join(dataDir, "pipelines"),
    );
    await workspaces.syncBase(project);

    const runtime = new InspectableScriptedRuntime(actionRegistry);
    const artifacts = new ArtifactStore(artifactDir, store);
    const pipelineHub = new PipelineEventHub();
    const projectRuntime = new ProjectRuntime(
      project,
      store,
      runtime,
      workspaces,
      artifacts,
      undefined,
      logger,
      undefined,
      undefined,
      { pipelineEventHub: pipelineHub },
      undefined,
      undefined,
      undefined,
      undefined,
      actionRegistry,
    );
    await projectRuntime.start();

    try {
      const engine = projectRuntime.pipelineEngine;

      // 1. startRun validates first node's declared `input` schema
      await expect(
        engine.startRun({
          pipelineId: "typed-flow",
          title: "Missing issueNumber",
          data: {},
        }),
      ).rejects.toBeInstanceOf(PipelineValidationError);

      // 2. Verify dynamic tool schemas across runtimes (resolveActionsForSite / Pi / ACP)
      const designOverrides = engine.getActionParameterOverridesForNode("typed-flow", "design");
      const designActions = resolveActionsForSite(actionRegistry, {
        actionScope: "pipeline",
        actionParameterOverrides: designOverrides,
      });
      const designNextJson = actionToJsonSchema(
        designActions.find((a) => a.name === "pipeline_next")!.parameters,
      ) as { properties?: Record<string, unknown>; required?: string[] };
      expect(designNextJson.required).toContain("data");
      expect(designNextJson.properties?.data).toMatchObject({
        type: "object",
        required: ["suggestedBranch"],
      });

      // For `implement` -> next node is `untyped_step` (no input schema) -> `data` is omitted!
      const implOverrides = engine.getActionParameterOverridesForNode("typed-flow", "implement");
      const piImplTools = bridgeActionsToPiTools(actionRegistry, () => ({
        project,
        workspacePath: "/tmp",
        sessionId: "ses_impl",
        actionScope: "pipeline",
        actionParameterOverrides: implOverrides,
      }));
      const piNextParams = piImplTools.find((t) => t.name === "pipeline_next")!.parameters as unknown as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(piNextParams.properties?.data).toBeUndefined();
      expect(piNextParams.properties?.metadata).toBeDefined();

      // Verify ACP MCP bridge also exposes per-session overridden schema on tools/list
      const acpBridge = new ACPMcpBridge(actionRegistry);
      acpBridge.registerSession("bridge-design", () => ({
        project,
        workspacePath: "/tmp",
        sessionId: "ses_design",
        actionScope: "pipeline",
        actionParameterOverrides: designOverrides,
      }));
      const mcpServer = acpBridge.mcpServerForSession("bridge-design", undefined, "pipeline");
      expect(mcpServer && "type" in mcpServer ? mcpServer.type : undefined).toBe("http");
      if (mcpServer && "type" in mcpServer && mcpServer.type === "http") {
        const res = await fetch(mcpServer.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: mcpServer.headers[0]!.value,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        const body = (await res.json()) as {
          result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> };
        };
        const nextTool = body.result.tools.find((t) => t.name === "pipeline_next");
        expect(nextTool?.inputSchema.required).toContain("data");
      }
      acpBridge.stop();

      // 3. Script the full run:
      //    Turn 1 (design): receives rendered {{ data.repo }}#42 (default applied!) + metadata,
      //    fails first pipeline_next missing `data.suggestedBranch`, then succeeds with valid `data`.
      runtime.enqueue(async ({ input, callAction }) => {
        expect(input).toContain("Design for acme/demo#42 (source=github-webhook)");

        const rejected = (await callAction("pipeline_next", {
          summary: "missing data",
          content: "forgot data",
        })) as { success: boolean; error?: string };
        expect(rejected.success).toBe(false);

        const accepted = (await callAction("pipeline_next", {
          summary: "Design ready",
          content: "Use feat/issue-42",
          data: { suggestedBranch: "feat/issue-42" },
          metadata: { designTag: "v1" },
        })) as { success: boolean };
        expect(accepted.success).toBe(true);
      });

      //    Turn 2 (implement attempt #1): receives {{ data.suggestedBranch }}, advances to untyped_step
      runtime.enqueue(async ({ input, callAction }) => {
        expect(input).toContain("Implement on branch feat/issue-42");
        const ok = (await callAction("pipeline_next", {
          summary: "Implemented v1",
          content: "Code done",
          metadata: { commitSha: "abc123" },
        })) as { success: boolean };
        expect(ok.success).toBe(true);
      });

      //    Turn 3 (implement attempt #2 after watch_pr prev rework):
      //    watch_pr did NOT pass `suggestedBranch`, yet implement AUTOMATICALLY INHERITED it!
      runtime.enqueue(async ({ input, callAction }) => {
        expect(input).toContain("Implement on branch feat/issue-42");
        expect(input).toContain("Fix formatting on PR #99");
        const ok = (await callAction("pipeline_next", {
          summary: "Implemented v2",
          content: "Lint fixed",
          metadata: { commitSha: "def456" },
        })) as { success: boolean };
        expect(ok.success).toBe(true);
      });

      const started = await engine.startRun({
        pipelineId: "typed-flow",
        title: "Issue #42",
        data: { issueNumber: 42 },
        metadata: { source: "github-webhook" },
      });
      expect(started.created).toBe(true);
      expect(started.run.data).toEqual({ issueNumber: 42, repo: "acme/demo" });
      expect(started.run.metadata).toEqual({ source: "github-webhook" });

      const completed = await waitFor(async () => {
        const r = await store.pipelines.getRun(started.run.runId);
        return r?.status === "completed" ? r : undefined;
      });
      expect(completed.currentNodeId).toBe("done");

      const observed = JSON.parse(await Bun.file(observedFile).text()) as Array<{
        node: string;
        attempt: number;
        data: Record<string, unknown>;
        metadata: Record<string, unknown>;
      }>;
      // untyped_step declared NO input -> its ctx.data MUST be strictly {} while metadata passes through!
      const untyped1 = observed.find((e) => e.node === "untyped_step" && e.attempt === 1)!;
      expect(untyped1.data).toEqual({});
      expect(untyped1.metadata).toMatchObject({ source: "github-webhook", commitSha: "abc123" });

      // watch_pr declared input { prNumber, branch } -> received strongly-typed data + merged metadata!
      const watch1 = observed.find((e) => e.node === "watch_pr" && e.attempt === 1)!;
      expect(watch1.data).toEqual({ prNumber: 99, branch: "feat/issue-42" });
      expect(watch1.metadata).toMatchObject({
        source: "github-webhook",
        prUrl: "https://github.com/acme/demo/pull/99",
      });
    } finally {
      await projectRuntime.stop();
    }
  });
});
