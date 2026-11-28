import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../src/artifacts/store.ts";
import type { AppConfig } from "../src/config/config.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { createGateway } from "./helpers/gateway.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import {
  PipelineConflictError,
  PipelineEngine,
  PipelineEventHub,
  computeTopologyHash,
  loadProjectPipelines,
  loadSinglePipelineFile,
  toNodesSnapshot,
  type PipelineStreamEvent,
} from "../src/pipeline/index.ts";
import { ProjectManager } from "../src/project/manager.ts";
import { ProjectRuntime } from "../src/project/runtime.ts";
import {
  FAKE_CAPABILITIES,
  type AgentRuntime,
  type ApprovalDecision,
  type RuntimeContext,
  type RuntimeSession,
  type RuntimeTurn,
} from "../src/runtime/runtime.ts";
import type { ToolCallResult } from "../src/tools/types.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

const tempDirs: string[] = [];
const PIPELINE_SDK_PATH = path.resolve(import.meta.dir, "../src/pipeline/index.ts");

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
  runGit("config", "user.email", "pipeline-test@example.com");
  runGit("config", "user.name", "Pipeline Test");
  await writeFile(path.join(repoDir, "README.md"), "# Test Repo\n", "utf8");
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

/**
 * Programmable fake AgentRuntime that calls orchestrator tools through `context.tools`, so tests
 * exercise the full ProjectRuntime tools + PipelineEngine flow.
 */
class ScriptedAgentRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly type = "fake";
  readonly capabilities = FAKE_CAPABILITIES;

  /** The tools each started session was offered. */
  readonly seenToolNames: string[][] = [];
  readonly seenPrompts: Array<{ sessionId: string; input: string }> = [];
  readonly seenWorkspaces: string[] = [];

  private readonly sessionContexts = new Map<string, RuntimeContext>();
  private readonly handlers: Array<
    (args: {
      runtimeSessionId: string;
      turnId: string;
      input: string;
      context: RuntimeContext;
      callAction: (name: string, params: Record<string, unknown>) => Promise<ToolCallResult>;
    }) => Promise<string | void> | string | void
  > = [];

  enqueueTurnHandler(
    handler: (args: {
      runtimeSessionId: string;
      turnId: string;
      input: string;
      context: RuntimeContext;
      callAction: (name: string, params: Record<string, unknown>) => Promise<ToolCallResult>;
    }) => Promise<string | void> | string | void,
  ): void {
    this.handlers.push(handler);
  }

  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    const id = `scripted_${crypto.randomUUID()}`;
    this.seenToolNames.push((context.tools?.specs ?? []).map((spec) => spec.name));
    this.seenWorkspaces.push(context.workspacePath);
    this.sessionContexts.set(id, context);
    return { id, workspacePath: context.workspacePath };
  }

  async resumeSession(context: RuntimeContext, runtimeSessionId: string): Promise<RuntimeSession> {
    this.sessionContexts.set(runtimeSessionId, context);
    return { id: runtimeSessionId, workspacePath: context.workspacePath };
  }

  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const runtimeTurnId = `rt_turn_${crypto.randomUUID()}`;
    this.seenPrompts.push({ sessionId, input });

    const handler = this.handlers.shift();
    queueMicrotask(async () => {
      try {
        await context.onEvent({
          type: "turn.started",
          sessionId,
          turnId,
          payload: { runtimeTurnId },
        });
        let outputText = `Handled: ${input.slice(0, 60)}`;
        if (handler) {
          const maybeText = await handler({
            runtimeSessionId: sessionId,
            turnId,
            input,
            context,
            callAction: async (name, params) => {
              if (!context.tools) throw new Error("the session has no tools");
              return context.tools.call(name, params);
            },
          });
          if (typeof maybeText === "string") outputText = maybeText;
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
  async releaseSession(_ctx: RuntimeContext, sessionId: string): Promise<void> {
    this.sessionContexts.delete(sessionId);
  }
  async stop(): Promise<void> {
    this.sessionContexts.clear();
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("Pipeline Loader & Topology Versioning", () => {
  it("loads valid TypeScript pipelines, checks prompt vars, and hashes only structural skeleton", async () => {
    const projectDir = await makeTempDir("ao-pipe-loader-");
    await mkdir(path.join(projectDir, "pipelines", "prompts"), { recursive: true });
    await mkdir(path.join(projectDir, "pipelines", "handlers"), { recursive: true });

    await writeFile(
      path.join(projectDir, "pipelines", "prompts", "design.md"),
      "Design for {{vars.team}} on {{project.id}}",
      "utf8",
    );
    await writeFile(
      path.join(projectDir, "pipelines", "handlers", "ci.ts"),
      `import { defineHandler } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export const ciHandler = defineHandler({
  async run() {
    return { action: "next", summary: "ok", content: "ok" };
  },
});
`,
      "utf8",
    );
    await writeFile(
      path.join(projectDir, "pipelines", "feature-delivery.ts"),
      `import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
import { ciHandler } from "./handlers/ci.ts";

export default definePipeline({
  name: "Feature Delivery",
  description: "Full delivery workflow",
  nodes: [
    node.agent({
      id: "design",
      name: "Design",
      prompt: "./prompts/design.md",
      gate: "manual",
      concurrency: 2,
    }),
    node.code({
      id: "ci",
      name: "CI Check",
      handler: ciHandler,
      allowPrev: true,
      prevTargets: ["design"],
    }),
    node.end({
      id: "done",
      name: "Done",
    }),
  ],
});
`,
      "utf8",
    );

    const defs = await loadProjectPipelines({
      projectId: "proj-1",
      projectDir,
      projectVars: { team: "Core" },
    });
    expect(defs).toHaveLength(1);
    const def = defs[0]!;
    expect(def.id).toBe("feature-delivery");
    expect(def.nodes).toHaveLength(3);
    expect(def.nodes[0]?.promptTemplate).toContain("{{vars.team}}");
    expect(def.nodes[1]?.prevTargets).toEqual(["design"]);
    expect(typeof def.nodes[1]?.handler).toBe("function");
    expect(def.nodes[2]?.terminal).toBe(true);

    // Prompts, handlers and concurrency are read live, so changing them keeps the revision
    const hashBefore = def.topologyHash;
    const liveOnlyChange = def.nodes.map((n) => ({ ...n, concurrency: 7, promptTemplate: "x" }));
    expect(computeTopologyHash(toNodesSnapshot(liveOnlyChange))).toBe(hashBefore);

    // Runs are bound to every snapshot field, so changing the gate or loop limit makes a revision
    const gateChange = def.nodes.map((n) =>
      n.id === "design" ? { ...n, gate: "auto" as const } : n,
    );
    expect(computeTopologyHash(toNodesSnapshot(gateChange))).not.toBe(hashBefore);
    const loopChange = def.nodes.map((n) => (n.id === "ci" ? { ...n, maxLoops: 9 } : n));
    expect(computeTopologyHash(toNodesSnapshot(loopChange))).not.toBe(hashBefore);

    // Missing project var still loads (non-fatal static warning)
    const missingVarDefs = await loadProjectPipelines({
      projectId: "proj-1",
      projectDir,
      projectVars: {},
      logger: new Logger({ level: "error" }),
    });
    expect(missingVarDefs).toHaveLength(1);
  });

  it("rejects invalid pipeline definitions (bad prevTargets, non-final terminal, path traversal) while allowing any valid identifier as pipelineId", async () => {
    const projectDir = await makeTempDir("ao-pipe-invalid-");
    await mkdir(path.join(projectDir, "pipelines", "prompts"), { recursive: true });
    await writeFile(path.join(projectDir, "pipelines", "prompts", "a.md"), "hello", "utf8");

    // Any valid identifier (including "runs") is permitted since run resources live in /pipeline-runs/*
    const runsNamedPath = path.join(projectDir, "pipelines", "runs.ts");
    await writeFile(
      runsNamedPath,
      `import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Runs Named Pipeline",
  nodes: [
    node.agent({ id: "a", name: "A", prompt: "./prompts/a.md" }),
    node.end({ id: "b", name: "B" }),
  ],
});
`,
      "utf8",
    );

    const badPrevPath = path.join(projectDir, "pipelines", "bad-prev.ts");
    await writeFile(
      badPrevPath,
      `import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Bad Prev",
  nodes: [
    node.agent({ id: "a", name: "A", prompt: "./prompts/a.md", allowPrev: true, prevTargets: ["b"] }),
    node.end({ id: "b", name: "B" }),
  ],
});
`,
      "utf8",
    );

    const badTerminalPath = path.join(projectDir, "pipelines", "bad-terminal.ts");
    await writeFile(
      badTerminalPath,
      `import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Bad Terminal",
  nodes: [
    node.end({ id: "a", name: "A" }),
    node.end({ id: "b", name: "B" }),
  ],
});
`,
      "utf8",
    );

    const traversalPath = path.join(projectDir, "pipelines", "traversal.ts");
    await writeFile(
      traversalPath,
      `import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Traversal",
  nodes: [
    node.agent({ id: "a", name: "A", prompt: "../../../etc/passwd" }),
    node.end({ id: "b", name: "B" }),
  ],
});
`,
      "utf8",
    );

    const opts = {
      projectId: "proj-1",
      projectDir,
      projectVars: {},
      logger: new Logger({ level: "error" }),
    };
    const runsDef = await loadSinglePipelineFile(runsNamedPath, opts);
    expect(runsDef.id).toBe("runs");
    await expect(loadSinglePipelineFile(badPrevPath, opts)).rejects.toThrow(
      "cannot set allowPrev: true",
    );
    await expect(loadSinglePipelineFile(badTerminalPath, opts)).rejects.toThrow(
      "cannot be terminal",
    );
    await expect(loadSinglePipelineFile(traversalPath, opts)).rejects.toThrow(
      "escapes project directory",
    );
  });

  it("loads the repository's projects/example/pipelines/feature-delivery.ts template cleanly", async () => {
    const exampleDir = path.resolve(import.meta.dir, "../projects/example");
    const defs = await loadProjectPipelines({
      projectId: "example",
      projectDir: exampleDir,
      logger: new Logger({ level: "error" }),
    });
    const featureDelivery = defs.find((d) => d.id === "feature-delivery");
    expect(featureDelivery).toBeDefined();
    expect(featureDelivery!.nodes.map((n) => n.id)).toEqual([
      "design",
      "implement",
      "verify",
      "approve",
      "done",
    ]);
    const tsNode = featureDelivery!.nodes.find((n) => n.id === "verify");
    expect(typeof tsNode?.handler).toBe("function");
    expect(tsNode?.inputSchema).toBeDefined();
    expect(tsNode?.inputJsonSchema).toBeDefined();
  });
});

describe("PipelineEngine End-to-End Lifecycle, Concurrency, Durable TS Steps & Fallback", () => {
  async function createTestProjectRuntime(options?: {
    pipelineCode?: string;
    pipelineId?: string;
    tsHandlerCode?: string;
    tsTaskCode?: string;
  }) {
    const rootDir = await makeTempDir("ao-pipe-e2e-");
    const repoDir = await createTempGitRepo(rootDir);
    const projectDir = path.join(rootDir, "project");
    const dataDir = path.join(rootDir, "data");
    const artifactDir = path.join(rootDir, "artifacts");

    await mkdir(path.join(projectDir, "pipelines", "prompts"), { recursive: true });
    await mkdir(path.join(projectDir, "pipelines", "handlers"), { recursive: true });
    await writeFile(
      path.join(projectDir, "pipelines", "prompts", "design.md"),
      "Design prompt",
      "utf8",
    );
    await writeFile(
      path.join(projectDir, "pipelines", "prompts", "impl.md"),
      "Implement prompt",
      "utf8",
    );
    await writeFile(
      path.join(projectDir, "pipelines", "prompts", "review.md"),
      "Review prompt",
      "utf8",
    );

    if (options?.tsHandlerCode) {
      await writeFile(
        path.join(projectDir, "pipelines", "handlers", "ci.ts"),
        options.tsHandlerCode,
        "utf8",
      );
    }
    if (options?.pipelineCode) {
      await writeFile(
        path.join(projectDir, "pipelines", `${options.pipelineId ?? "delivery"}.ts`),
        options.pipelineCode,
        "utf8",
      );
    }
    if (options?.tsTaskCode) {
      await mkdir(path.join(projectDir, "tasks"), { recursive: true });
      await writeFile(path.join(projectDir, "tasks", "trigger.ts"), options.tsTaskCode, "utf8");
    }

    const store = new MemoryStore();
    const logger = new Logger({ level: "error" });

    const project: ProjectConfig = {
      id: "demo",
      displayName: "Demo",
      description: "Demo Project",
      routing: { projectId: "demo", displayName: "Demo", summary: "Demo", keywords: [] },
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

    const runtime = new ScriptedAgentRuntime();
    const artifacts = new ArtifactStore(artifactDir, store);
    const pipelineHub = new PipelineEventHub();
    const projectRuntime = new ProjectRuntime({
      project,
      store,
      agentRuntime: runtime,
      workspaces,
      artifacts,
      logger,
      pipelineEventHub: pipelineHub,
    });
    await projectRuntime.start();
    return {
      rootDir,
      repoDir,
      projectDir,
      dataDir,
      project,
      store,
      workspaces,
      runtime,
      pipelineHub,
      projectRuntime,
    };
  }

  it("executes full agent(manual) -> chat follow-up -> approve -> agent(auto) -> prev loop breaker -> human -> ts(step/waitUntil/signal) -> terminal with shared worktree cleanup", async () => {
    const ciStateFile = path.join(await makeTempDir("ao-ci-flag-"), "ci-state.json");
    await writeFile(ciStateFile, JSON.stringify({ ready: false, stepExecutions: 0 }), "utf8");

    const tsHandlerCode = `
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineHandler } from ${JSON.stringify(PIPELINE_SDK_PATH)};

export const ciHandler = defineHandler({
  async run(ctx) {
    ctx.logger.info("ci handler invoked", { attempt: ctx.node.attempt });
    const artifactFromImpl = await readFile(path.join(ctx.workspace, "feature.txt"), "utf8");

    const triggered = await ctx.step("trigger-ci", async () => {
      const raw = JSON.parse(await readFile(${JSON.stringify(ciStateFile)}, "utf8"));
      raw.stepExecutions += 1;
      await writeFile(${JSON.stringify(ciStateFile)}, JSON.stringify(raw), "utf8");
      return { runNumber: 42, sawFile: artifactFromImpl.trim() };
    });

    await ctx.waitUntil("ci-green", { intervalMs: 60000, summary: "Waiting for CI" }, async () => {
      const raw = JSON.parse(await readFile(${JSON.stringify(ciStateFile)}, "utf8"));
      return raw.ready ? { conclusion: "success" } : false;
    });

    return {
      action: "next",
      summary: "CI passed for run #" + triggered.runNumber,
      content: "Saw shared worktree file: " + triggered.sawFile,
    };
  },
});
`;

    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
import { ciHandler } from "./handlers/ci.ts";

export default definePipeline({
  name: "Full Delivery",
  nodes: [
    node.agent({ id: "design", name: "Design", prompt: "./prompts/design.md", gate: "manual" }),
    node.agent({ id: "implement", name: "Implement", prompt: "./prompts/impl.md", gate: "auto" }),
    node.agent({
      id: "review",
      name: "Review",
      prompt: "./prompts/review.md",
      gate: "auto",
      allowPrev: true,
      prevTargets: ["implement"],
      maxLoops: 1,
    }),
    node.human({ id: "release_gate", name: "Release Gate", allowPrev: true, prevTargets: ["implement"] }),
    node.code({ id: "ci", name: "CI Check", handler: ciHandler }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;

    const env = await createTestProjectRuntime({ pipelineCode, tsHandlerCode });
    const events: PipelineStreamEvent[] = [];
    const unsubscribe = env.pipelineHub.subscribe("demo", (e) => events.push(e));

    // Turn 1 (design): verifies single-turn decision lock (invalid call does NOT lock; 2nd valid call rejected)
    env.runtime.enqueueTurnHandler(async ({ callAction }) => {
      // Invalid action (design has allowPrev: false) should fail WITHOUT locking turn
      const invalidPrev = await callAction("pipeline_prev", {
        reason: "bad",
        feedback: "nope",
      });
      expect(invalidPrev.ok).toBe(false);

      // Valid pipeline_next registers pending decision
      const okNext = await callAction("pipeline_next", {
        summary: "Design ready",
        content: "Detailed design doc",
      });
      expect(okNext.ok).toBe(true);

      // Second valid flow decision in same turn must be rejected by single-turn lock
      const duplicate = await callAction("pipeline_fail", {
        reason: "should be rejected",
      });
      expect(duplicate.ok).toBe(false);
      expect(duplicate.error).toContain("already been registered");
      return "Design completed";
    });

    // Turn 2 (user follow-up chat on design session while waiting_confirmation): no action called, no nagging!
    env.runtime.enqueueTurnHandler(async () => {
      return "Sure, clarified the edge case.";
    });

    // Turn 3 (implement attempt #1): writes a file into the shared Run worktree
    env.runtime.enqueueTurnHandler(async ({ context, callAction }) => {
      await writeFile(
        path.join(context.workspacePath, "feature.txt"),
        "hello-shared-worktree\n",
        "utf8",
      );
      const globalCtx = await callAction("pipeline_get_context", {});
      expect(globalCtx.ok).toBe(true);
      const view = globalCtx.data as { upstreamContext?: { context?: { humanNote?: string } } };
      expect(view.upstreamContext?.context?.humanNote).toBe("Looks great, proceed");
      await callAction("pipeline_next", {
        summary: "Implemented v1",
        content: "Wrote feature.txt",
      });
    });

    // Turn 4 (review attempt #1): rejects back to implement (loop count = 1)
    env.runtime.enqueueTurnHandler(async ({ callAction }) => {
      await callAction("pipeline_prev", {
        reason: "Missing tests",
        feedback: "Please add unit tests",
      });
    });

    // Turn 5 (implement attempt #2): advances back to review
    env.runtime.enqueueTurnHandler(async ({ input, callAction }) => {
      expect(input).toContain("Please add unit tests");
      await callAction("pipeline_next", {
        summary: "Implemented v2 with tests",
        content: "Added unit tests",
      });
    });

    // Turn 6 (review attempt #2): tries to reject again -> hits maxLoops: 1 circuit breaker!
    env.runtime.enqueueTurnHandler(async ({ callAction }) => {
      await callAction("pipeline_prev", {
        reason: "Still nitpicking",
        feedback: "One more tweak",
      });
    });

    try {
      const started = await env.projectRuntime.pipelines.startRun({
        pipelineId: "delivery",
        title: "Build Feature X",
        externalKey: "ISSUE-101",
      });
      expect(started.created).toBe(true);
      const runId = started.run.runId;

      // 1. Wait for design (manual gate) to park in waiting_confirmation
      const atDesign = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(runId);
        return r?.status === "waiting_confirmation" ? r : undefined;
      });
      expect(atDesign.currentNodeId).toBe("design");
      expect(atDesign.workspacePath).toBeDefined();
      expect(existsSync(atDesign.workspacePath!)).toBe(true);
      // The node's agent gets the node's flow tools, not a conversation's
      expect(env.runtime.seenToolNames[0]).toContain("pipeline_next");
      expect(env.runtime.seenToolNames[0]).not.toContain("schedule_job");

      // Pipeline session must be hidden from default listSessions
      const visibleSessions = await env.store.listSessions("demo");
      expect(visibleSessions).toHaveLength(0);

      const designDetail = await env.projectRuntime.pipelines.getRunDetail(runId);
      const designSessionId = designDetail.nodeRuns[0]!.sessionId!;

      // 2. Interactive user follow-up chat during waiting_confirmation (must NOT nag!)
      const followUpTurn = await env.projectRuntime.turns.submit(
        designSessionId,
        "Can you clarify edge case #2?",
      );
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(runId);
        const turn = await env.store.getTurn(followUpTurn.id);
        return turn?.status === "completed" && r?.status === "waiting_confirmation" ? r : undefined;
      });
      // Confirm no reminder turn was sent (design session received exactly 2 turns total)
      const designSession = await env.store.getSession(designSessionId);
      const designPrompts = env.runtime.seenPrompts.filter(
        (p) => p.sessionId === designSession?.runtimeSessionId,
      );
      expect(designPrompts).toHaveLength(2);

      // 3. Approve design -> runs implement -> review (prev) -> implement #2 -> review #2 (loop breaker!)
      await env.projectRuntime.pipelines.approveRun(runId, {
        humanNote: "Looks great, proceed",
      });

      // Previous node's session must be archived read-only, while shared worktree stays intact!
      const archivedDesign = await env.store.getSession(designSessionId);
      expect(archivedDesign?.status).toBe("archived");
      expect(existsSync(atDesign.workspacePath!)).toBe(true);
      await expect(env.projectRuntime.turns.submit(designSessionId, "too late")).rejects.toThrow(
        "archived",
      );

      // Wait for review's loop circuit breaker to pause in waiting_confirmation
      const atCircuitBreaker = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(runId);
        return r?.currentNodeId === "review" && r.status === "waiting_confirmation" ? r : undefined;
      });
      expect(atCircuitBreaker.statusSummary).toContain("Loop limit");

      // All agent nodes reused the exact same shared Run worktree path
      for (const wsPath of env.runtime.seenWorkspaces) {
        expect(wsPath).toBe(atDesign.workspacePath!);
      }

      // 4. Human overrides circuit breaker by approving review -> lands on human release_gate
      await env.projectRuntime.pipelines.approveRun(runId);
      const atHumanGate = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(runId);
        return r?.currentNodeId === "release_gate" && r.status === "waiting_confirmation"
          ? r
          : undefined;
      });
      expect(atHumanGate.currentNodeId).toBe("release_gate");

      // 5. Human approves release_gate -> enters TS node `ci` which runs step + suspends in waitUntil
      await env.projectRuntime.pipelines.approveRun(runId);
      const atCiWaiting = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(runId);
        return r?.currentNodeId === "ci" && r.status === "waiting" ? r : undefined;
      });
      expect(atCiWaiting.statusSummary).toBe("Waiting for CI");

      // Flip external CI condition to ready, then wake via signalRun
      const ciState = JSON.parse(await Bun.file(ciStateFile).text());
      expect(ciState.stepExecutions).toBe(1);
      ciState.ready = true;
      await writeFile(ciStateFile, JSON.stringify(ciState), "utf8");

      const signalRes = await env.projectRuntime.pipelines.signalRun(runId);
      expect(signalRes.woken).toBe(true);

      // 6. Wait for terminal node `done` to auto-complete and clean up shared worktree
      const completed = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(runId);
        return r?.status === "completed" ? r : undefined;
      });
      expect(completed.currentNodeId).toBe("done");
      expect(completed.workspaceStatus).toBe("cleaned");
      expect(existsSync(atDesign.workspacePath!)).toBe(false);

      // Confirm ctx.step was NEVER re-executed on replay (still exactly 1!)
      const finalCiState = JSON.parse(await Bun.file(ciStateFile).text());
      expect(finalCiState.stepExecutions).toBe(1);

      // Confirm TS node logs persisted monotonically across suspend/replay
      const finalDetail = await env.projectRuntime.pipelines.getRunDetail(runId);
      const ciNodeRun = finalDetail.nodeRuns.find((n) => n.nodeId === "ci")!;
      const logs = await env.projectRuntime.pipelines.listNodeRunLogs(ciNodeRun.nodeRunId);
      expect(logs.length).toBeGreaterThanOrEqual(2);
      expect(logs.map((l) => l.sequence)).toEqual([1, 2]);

      // Confirm SSE hub emitted lifecycle events including completion
      expect(events.some((e) => e.type === "pipeline.run.created")).toBe(true);
      expect(events.some((e) => e.type === "pipeline.run.completed")).toBe(true);
    } finally {
      unsubscribe();
      await env.projectRuntime.stop();
    }
  });

  it("reminds once when an automated agent turn misses a flow action, then falls back safely to waiting_confirmation", async () => {
    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Fallback Test",
  nodes: [
    node.agent({ id: "design", name: "Design", prompt: "./prompts/design.md" }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });
    // Both initial turn and reminder turn omit calling any pipeline_* action
    env.runtime.enqueueTurnHandler(async () => "Forgot to call tool #1");
    env.runtime.enqueueTurnHandler(async ({ input }) => {
      expect(input).toContain("[System Reminder]");
      return "Still forgot to call tool #2";
    });

    try {
      const { run } = await env.projectRuntime.pipelines.startRun({
        pipelineId: "delivery",
        title: "Fallback Run",
      });
      const paused = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "waiting_confirmation" ? r : undefined;
      });
      expect(paused.statusSummary).toContain("did not invoke a pipeline action");

      const actions = await env.projectRuntime.pipelines.listRunActions(run.runId);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.action).toBe("system_fallback");
      expect(actions[0]?.context.content).toBe("Still forgot to call tool #2");
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("enforces per-node concurrency cap, recovers waiting/running nodes across restarts, and supports retry preserveStepState + force cancel", async () => {
    const stepLogFile = path.join(await makeTempDir("ao-restart-"), "steps.json");
    await writeFile(
      stepLogFile,
      JSON.stringify({ stepCount: 0, shouldFail: true, ready: false }),
      "utf8",
    );

    const tsHandlerCode = `
import { readFile, writeFile } from "node:fs/promises";
import { defineHandler } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export const ciHandler = defineHandler({
  async run(ctx) {
    await ctx.step("side-effect", async () => {
      const state = JSON.parse(await readFile(${JSON.stringify(stepLogFile)}, "utf8"));
      state.stepCount += 1;
      await writeFile(${JSON.stringify(stepLogFile)}, JSON.stringify(state), "utf8");
      return { done: true };
    });
    const state = JSON.parse(await readFile(${JSON.stringify(stepLogFile)}, "utf8"));
    if (state.shouldFail) {
      throw new Error("transient boom");
    }
    await ctx.waitUntil("wait-ready", { intervalMs: 50, summary: "Waiting after restart" }, async () => {
      const latest = JSON.parse(await readFile(${JSON.stringify(stepLogFile)}, "utf8"));
      return latest.ready ? true : false;
    });
    return { action: "next", summary: "TS done", content: "ok" };
  },
});
`;

    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
import { ciHandler } from "./handlers/ci.ts";
export default definePipeline({
  name: "Durable TS",
  nodes: [
    node.code({ id: "worker", name: "Worker", handler: ciHandler, concurrency: 1 }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode, tsHandlerCode });
    try {
      // 1. Run fails on first attempt AFTER caching step("side-effect")
      const { run } = await env.projectRuntime.pipelines.startRun({
        pipelineId: "delivery",
        title: "Retryable Run",
      });
      const failed = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "failed" ? r : undefined;
      });
      expect(failed.statusSummary).toContain("transient boom");
      expect(JSON.parse(await Bun.file(stepLogFile).text()).stepCount).toBe(1);

      // 2. Retry with preserveStepState: true -> step("side-effect") is NOT re-run, enters waiting
      await writeFile(
        stepLogFile,
        JSON.stringify({ stepCount: 1, shouldFail: false, ready: false }),
        "utf8",
      );
      await env.projectRuntime.pipelines.retryRun(run.runId, { preserveStepState: true });
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "waiting" ? r : undefined;
      });
      expect(JSON.parse(await Bun.file(stepLogFile).text()).stepCount).toBe(1);

      // 3. Simulate process restart: spin up a brand new PipelineEngine backed by the same Store
      await env.projectRuntime.pipelines.stop();

      // Also leave a node `running`, as a crash would: restart recovery must mark it failed
      const now = new Date().toISOString();
      await env.store.pipelines.createRun(
        {
          runId: "prun_stale",
          projectId: "demo",
          pipelineId: "delivery",
          pipelineVersion: 1,
          title: "Stale Running",
          data: {},
          metadata: {},
          currentNodeId: "worker",
          status: "running",
          workspaceStatus: "none",
          loopCounts: {},
          activeNodeRunId: "pnr_stale",
          latestNodeOutputs: {},
          createdBy: "api",
          stateVersion: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          nodeRunId: "pnr_stale",
          runId: "prun_stale",
          projectId: "demo",
          pipelineId: "delivery",
          nodeId: "worker",
          executorType: "ts",
          status: "running",
          inputContext: {},
          stepState: {},
          pollCount: 0,
          reminderSent: false,
          createdAt: now,
          updatedAt: now,
        },
      );

      // Mark external condition ready BEFORE restart wakes the waiting run
      await writeFile(
        stepLogFile,
        JSON.stringify({ stepCount: 1, shouldFail: false, ready: true }),
        "utf8",
      );

      const restartedEngine = new PipelineEngine({
        project: env.project,
        store: env.store.pipelines,
        workspaces: env.workspaces,
        notifications: env.projectRuntime["notifications"],
        createContext: (origin, options) => env.projectRuntime.createContext(origin, options),
        hub: env.pipelineHub,
        logger: new Logger({ level: "error" }),
        minPollCoalesceMs: 10,
        sessions: {
          create: async () => {
            throw new Error("not used");
          },
          runTurn: async () => {
            throw new Error("not used");
          },
          archive: async () => {},
          interrupt: async () => {},
        },
      });
      await restartedEngine.start();

      try {
        // The node cut off by the restart was failed for a person to retry
        const reconciledStale = await env.store.pipelines.getRun("prun_stale");
        expect(reconciledStale?.status).toBe("failed");
        const reconciledNode = await env.store.pipelines.getNodeRun("pnr_stale");
        expect(reconciledNode?.errorMessage).toBe("runtime_restarted");

        // Waiting run woke up automatically on single-alarm poll and completed WITHOUT re-running step
        const completedAfterRestart = await waitFor(async () => {
          const r = await env.store.pipelines.getRun(run.runId);
          return r?.status === "completed" ? r : undefined;
        });
        expect(completedAfterRestart.status).toBe("completed");
        expect(JSON.parse(await Bun.file(stepLogFile).text()).stepCount).toBe(1);

        // 4. Force cancel a waiting run -> cleans up shared worktree and marks cancelled
        await writeFile(
          stepLogFile,
          JSON.stringify({ stepCount: 1, shouldFail: false, ready: false }),
          "utf8",
        );
        const cancelTarget = await restartedEngine.startRun({
          pipelineId: "delivery",
          title: "Cancel Me",
        });
        const waitingForCancel = await waitFor(async () => {
          const r = await env.store.pipelines.getRun(cancelTarget.run.runId);
          return r?.status === "waiting" ? r : undefined;
        });
        expect(existsSync(waitingForCancel.workspacePath!)).toBe(true);

        const cancelled = await restartedEngine.cancelRun(cancelTarget.run.runId, {
          reason: "No longer needed",
        });
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.workspaceStatus).toBe("cleaned");
        expect(existsSync(waitingForCancel.workspacePath!)).toBe(false);
      } finally {
        await restartedEngine.stop();
      }
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("supports TS Task SDK ctx.startPipelineRun with externalKey idempotency", async () => {
    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Task Triggered",
  nodes: [
    node.human({ id: "approve", name: "Approve" }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const tsTaskCode = `
import { defineTask } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/task/sdk.ts"))};
export default defineTask({
  id: "scan",
  name: "Scan & Trigger",
  cron: "0 0 1 1 *",
  enabled: false,
  async run(ctx) {
    const first = await ctx.pipelines.start({
      pipelineId: "delivery",
      title: "From TS Task",
      externalKey: "JIRA-77",
    });
    const second = await ctx.pipelines.start({
      pipelineId: "delivery",
      title: "From TS Task Duplicate",
      externalKey: "JIRA-77",
    });
    const found = await ctx.pipelines.find({ pipelineId: "delivery", externalKey: "JIRA-77" });
    return {
      firstCreated: first.created,
      secondCreated: second.created,
      sameRun: first.run.runId === second.run.runId,
      foundRun: found?.runId === first.run.runId,
      createdBy: first.run.createdBy,
    };
  },
});
`;
    const env = await createTestProjectRuntime({ pipelineCode, tsTaskCode });
    try {
      const dispatched = await env.projectRuntime.tasks.run("scan");
      expect(dispatched).toBe(true);
      await env.projectRuntime.tasks.engine.drain();
      const executions = await env.store.listTaskExecutions("demo:scan", 5, "demo");
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("success");
      expect(executions[0]?.actionsSummary).toEqual({
        firstCreated: true,
        secondCreated: false,
        sameRun: true,
        foundRun: true,
        createdBy: "task:scan",
      });
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("gives code nodes the project context, acting as their node run", async () => {
    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Context Flow",
  nodes: [
    node.code({
      id: "report",
      name: "Report",
      async run(ctx) {
        const text = ctx.render("{{ pipeline.title }} on {{ project.id }} by {{ pipeline.nodeId }}");
        const artifact = await ctx.artifacts.create({ kind: "report", content: text });
        const started = await ctx.sessions.start({ title: "Follow up", prompt: text });
        return {
          action: "next",
          summary: text,
          content: artifact.originKind + ":" + artifact.originId,
          metadata: { sessionId: started.sessionId, nodeRunId: ctx.node.runId },
        };
      },
    }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode, pipelineId: "context-flow" });
    try {
      const { run } = await env.projectRuntime.pipelines.startRun({
        pipelineId: "context-flow",
        title: "Weekly",
      });
      const done = await waitFor(async () => {
        const latest = await env.store.pipelines.getRun(run.runId);
        return latest?.status === "completed" ? latest : undefined;
      });
      const [record] = (
        await env.projectRuntime.pipelines.listRunActions(done.runId, {})
      ).filter((r) => r.action === "pipeline_next");
      expect(record?.context.summary).toBe("Weekly on demo by report");
      const nodeRunId = record?.context.metadata?.nodeRunId as string;
      expect(record?.context.content).toBe(`pipeline:${nodeRunId}`);

      const sessionId = record?.context.metadata?.sessionId as string;
      const session = await env.store.getSession(sessionId);
      expect(session?.metadata).toMatchObject({
        sourcePipelineRunId: run.runId,
        sourcePipelineNodeId: "report",
      });
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("queues excess runs when a node reaches its concurrency cap and drains once a slot frees", async () => {
    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Concurrency Capped",
  nodes: [
    node.agent({ id: "design", name: "Design", prompt: "./prompts/design.md", concurrency: 1 }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });

    let releaseFirstTurn!: () => void;
    const firstTurnStarted = new Promise<void>((resolve) => {
      env.runtime.enqueueTurnHandler(async ({ callAction }) => {
        resolve();
        await new Promise<void>((r) => {
          releaseFirstTurn = r;
        });
        await callAction("pipeline_next", { summary: "first done", content: "ok" });
      });
    });
    env.runtime.enqueueTurnHandler(async ({ callAction }) => {
      await callAction("pipeline_next", { summary: "second done", content: "ok" });
    });

    try {
      const r1 = await env.projectRuntime.pipelines.startRun({
        pipelineId: "delivery",
        title: "Run 1",
      });
      await firstTurnStarted;

      const r2 = await env.projectRuntime.pipelines.startRun({
        pipelineId: "delivery",
        title: "Run 2",
      });

      // Give drainQueues a moment; Run 2 MUST remain queued while Run 1 holds the single slot
      await Bun.sleep(60);
      expect((await env.store.pipelines.getRun(r1.run.runId))?.status).toBe("running");
      expect((await env.store.pipelines.getRun(r2.run.runId))?.status).toBe("queued");

      // Release Run 1 -> both Run 1 and Run 2 complete cleanly
      releaseFirstTurn();
      await waitFor(async () => {
        const a = await env.store.pipelines.getRun(r1.run.runId);
        const b = await env.store.pipelines.getRun(r2.run.runId);
        return a?.status === "completed" && b?.status === "completed" ? true : undefined;
      });
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("lets a person chat with a waiting node while it is approved, without deadlocking", async () => {
    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Chat And Approve",
  nodes: [
    node.agent({ id: "design", name: "Design", prompt: "./prompts/design.md", gate: "manual" }),
    node.human({ id: "sign_off", name: "Sign Off" }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });
    env.runtime.enqueueTurnHandler(async ({ callAction }) => {
      await callAction("pipeline_next", { summary: "Design ready", content: "Doc" });
    });
    env.runtime.enqueueTurnHandler(async () => "Answering the question");
    try {
      const { run } = await env.projectRuntime.pipelines.startRun({
        pipelineId: "delivery",
        title: "Chat during approval",
      });
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "waiting_confirmation" ? r : undefined;
      });
      const { nodeRuns } = await env.projectRuntime.pipelines.getRunDetail(run.runId);
      const sessionId = nodeRuns[0]!.sessionId!;

      // A chat turn and an approval of the same node, at the same time
      const settled = Promise.allSettled([
        env.projectRuntime.turns.submit(sessionId, "One more question?"),
        env.projectRuntime.pipelines.approveRun(run.runId),
      ]);
      const [, approval] = await Promise.race([
        settled,
        Bun.sleep(5_000).then(() => {
          throw new Error("chat and approval deadlocked");
        }),
      ]);
      expect(approval.status).toBe("fulfilled");
      const atSignOff = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.currentNodeId === "sign_off" ? r : undefined;
      });
      expect(atSignOff.status).toBe("waiting_confirmation");
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("never runs more node runs than the node's concurrency, however often the queue is drained", async () => {
    const gateFile = path.join(await makeTempDir("ao-cap-"), "gate.json");
    await writeFile(gateFile, JSON.stringify({ open: false }), "utf8");
    const pipelineCode = `
import { readFile } from "node:fs/promises";
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Capped",
  nodes: [
    node.code({
      id: "worker",
      name: "Worker",
      concurrency: 1,
      async run() {
        while (!JSON.parse(await readFile(${JSON.stringify(gateFile)}, "utf8")).open) {
          await Bun.sleep(10);
        }
        return { action: "next", summary: "done", content: "ok" };
      },
    }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });
    const engine = env.projectRuntime.pipelines;
    try {
      const runs = await Promise.all(
        [1, 2, 3].map((i) => engine.startRun({ pipelineId: "delivery", title: `Run ${i}` })),
      );
      for (let i = 0; i < 20; i += 1) {
        await Promise.all([engine["scheduler"].drain(), engine["scheduler"].drain()]);
        const running = await env.store.pipelines.listNodeRunsByStatus("demo", ["running"]);
        expect(running.length).toBeLessThanOrEqual(1);
      }

      await writeFile(gateFile, JSON.stringify({ open: true }), "utf8");
      await waitFor(async () => {
        const all = await Promise.all(runs.map((r) => env.store.pipelines.getRun(r.run.runId)));
        return all.every((r) => r?.status === "completed") ? true : undefined;
      });
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("does not try to claim queued runs of a node that is already full", async () => {
    const gateFile = path.join(await makeTempDir("ao-backlog-"), "gate.json");
    await writeFile(gateFile, JSON.stringify({ open: false }), "utf8");
    const pipelineCode = `
import { readFile } from "node:fs/promises";
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Backlog",
  nodes: [
    node.code({
      id: "worker",
      name: "Worker",
      concurrency: 1,
      async run() {
        while (!JSON.parse(await readFile(${JSON.stringify(gateFile)}, "utf8")).open) {
          await Bun.sleep(10);
        }
        return { action: "next", summary: "done", content: "ok" };
      },
    }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });
    const engine = env.projectRuntime.pipelines;
    const pipelines = env.store.pipelines;
    try {
      const first = await engine.startRun({ pipelineId: "delivery", title: "Running" });
      await waitFor(async () => {
        const r = await pipelines.getRun(first.run.runId);
        return r?.status === "running" ? r : undefined;
      });
      const backlog = await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          engine.startRun({ pipelineId: "delivery", title: `Queued ${i}` }),
        ),
      );
      await engine["scheduler"].drain();

      let commits = 0;
      const commit = pipelines.commitTransition.bind(pipelines);
      pipelines.commitTransition = (write) => {
        commits += 1;
        return commit(write);
      };
      for (let i = 0; i < 3; i += 1) await engine["scheduler"].drain();
      expect(commits).toBe(0);
      pipelines.commitTransition = commit;

      await writeFile(gateFile, JSON.stringify({ open: true }), "utf8");
      await waitFor(async () => {
        const all = await Promise.all(
          [first, ...backlog].map((r) => pipelines.getRun(r.run.runId)),
        );
        return all.every((r) => r?.status === "completed") ? true : undefined;
      });
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("does not wake the scheduler when an agent registers a flow action", async () => {
    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Quiet Registration",
  nodes: [
    node.agent({ id: "design", name: "Design", prompt: "./prompts/design.md" }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });
    const engine = env.projectRuntime.pipelines;
    const scheduler = engine["scheduler"];
    let refreshes = 0;
    const refresh = scheduler.refresh.bind(scheduler);
    scheduler.refresh = () => {
      refreshes += 1;
      refresh();
    };
    let refreshesDuringRegistration = -1;
    env.runtime.enqueueTurnHandler(async ({ callAction }) => {
      const before = refreshes;
      await callAction("pipeline_next", { summary: "ready", content: "doc" });
      refreshesDuringRegistration = refreshes - before;
    });
    try {
      const { run } = await engine.startRun({ pipelineId: "delivery", title: "Quiet" });
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "completed" ? r : undefined;
      });
      expect(refreshesDuringRegistration).toBe(0);
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("fails a TS node that runs past its timeout even if its handler returns afterwards", async () => {
    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Timeout",
  nodes: [
    node.code({
      id: "slow",
      name: "Slow",
      concurrency: 1,
      timeoutMs: 40,
      async run() {
        await Bun.sleep(150);
        return { action: "next", summary: "late", content: "too late" };
      },
    }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });
    const engine = env.projectRuntime.pipelines;
    try {
      const first = await engine.startRun({ pipelineId: "delivery", title: "First" });
      const failed = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(first.run.runId);
        return r?.status === "failed" ? r : undefined;
      });
      expect(failed.statusSummary).toContain("timed out");

      // The timed-out node no longer holds the node's only slot
      const second = await engine.startRun({ pipelineId: "delivery", title: "Second" });
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(second.run.runId);
        return r?.status === "failed" ? r : undefined;
      });
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("does not let a failed node's session move the run, while retry still works", async () => {
    const pipelineCode = `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Fail Then Retry",
  nodes: [
    node.agent({ id: "design", name: "Design", prompt: "./prompts/design.md" }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });
    const engine = env.projectRuntime.pipelines;
    env.runtime.enqueueTurnHandler(async ({ callAction }) => {
      await callAction("pipeline_fail", { reason: "blocked" });
    });
    env.runtime.enqueueTurnHandler(async ({ callAction }) => {
      await callAction("pipeline_next", { summary: "fixed", content: "ok" });
    });
    try {
      const { run } = await engine.startRun({ pipelineId: "delivery", title: "Fails" });
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "failed" ? r : undefined;
      });
      const { nodeRuns } = await engine.getRunDetail(run.runId);
      const sessionId = nodeRuns[0]!.sessionId!;

      await expect(
        engine.registerAgentDecision({
          nodeRunId: nodeRuns[0]!.nodeRunId,
          action: "pipeline_next",
          context: { summary: "sneaky", content: "skip the retry" },
        }),
      ).rejects.toBeInstanceOf(PipelineConflictError);
      await expect(env.projectRuntime.turns.submit(sessionId, "hello?")).rejects.toThrow("archived");
      expect((await env.store.pipelines.getRun(run.runId))?.status).toBe("failed");

      await engine.retryRun(run.runId);
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "completed" ? r : undefined;
      });
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("runs a step that returns nothing only once across suspends", async () => {
    const countFile = path.join(await makeTempDir("ao-step-"), "count.json");
    await writeFile(countFile, JSON.stringify({ calls: 0, ready: false }), "utf8");
    const pipelineCode = `
import { readFile, writeFile } from "node:fs/promises";
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
const file = ${JSON.stringify(countFile)};
const read = async () => JSON.parse(await readFile(file, "utf8"));
export default definePipeline({
  name: "Step Undefined",
  nodes: [
    node.code({
      id: "worker",
      name: "Worker",
      async run(ctx) {
        await ctx.step("notify", async () => {
          const state = await read();
          state.calls += 1;
          await writeFile(file, JSON.stringify(state), "utf8");
        });
        await ctx.waitUntil("ready", { intervalMs: 20 }, async () => (await read()).ready);
        return { action: "next", summary: "done", content: "ok" };
      },
    }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode });
    const engine = env.projectRuntime.pipelines;
    try {
      const { run } = await engine.startRun({ pipelineId: "delivery", title: "Undefined step" });
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "waiting" ? r : undefined;
      });
      // Wake it a few times while the condition is still false
      for (let i = 0; i < 3; i += 1) {
        await engine.signalRun(run.runId);
        await waitFor(async () => {
          const r = await env.store.pipelines.getRun(run.runId);
          return r?.status === "waiting" ? r : undefined;
        });
      }
      await writeFile(countFile, JSON.stringify({ calls: 1, ready: true }), "utf8");
      await engine.signalRun(run.runId);
      await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "completed" ? r : undefined;
      });
      expect(JSON.parse(await Bun.file(countFile).text()).calls).toBe(1);
    } finally {
      await env.projectRuntime.stop();
    }
  });

  it("starts a new revision when a node's gate changes, so new runs follow the new gate", async () => {
    const makePipeline = (gate: "auto" | "manual") => `
import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Gate Change",
  nodes: [
    node.agent({ id: "design", name: "Design", prompt: "./prompts/design.md", gate: ${JSON.stringify(gate)} }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`;
    const env = await createTestProjectRuntime({ pipelineCode: makePipeline("auto") });
    const engine = env.projectRuntime.pipelines;
    try {
      expect(engine.getCurrentVersion("delivery")).toBe(1);
      await writeFile(path.join(env.projectDir, "pipelines", "delivery.ts"), makePipeline("manual"));
      await engine.syncDefinitions();
      expect(engine.getCurrentVersion("delivery")).toBe(2);

      env.runtime.enqueueTurnHandler(async ({ callAction }) => {
        await callAction("pipeline_next", { summary: "ready", content: "doc" });
      });
      const { run } = await engine.startRun({ pipelineId: "delivery", title: "Gated" });
      const parked = await waitFor(async () => {
        const r = await env.store.pipelines.getRun(run.runId);
        return r?.status === "waiting_confirmation" ? r : undefined;
      });
      expect(parked.pipelineVersion).toBe(2);
    } finally {
      await env.projectRuntime.stop();
    }
  });
});

describe("Gateway /api/v1 Pipeline REST & SSE Endpoints", () => {
  it("handles full REST lifecycle, idempotent 201/200, 404/409 conflicts, and live SSE stream", async () => {
    const rootDir = await makeTempDir("ao-pipe-api-");
    const repoDir = await createTempGitRepo(rootDir);
    const projectDir = path.join(rootDir, "project");
    await mkdir(path.join(projectDir, "pipelines"), { recursive: true });
    await writeFile(
      path.join(projectDir, "pipelines", "release.ts"),
      `import { definePipeline, node } from ${JSON.stringify(PIPELINE_SDK_PATH)};
export default definePipeline({
  name: "Release Flow",
  nodes: [
    node.human({ id: "review", name: "Review" }),
    node.human({ id: "ship", name: "Ship", allowPrev: true, prevTargets: ["review"] }),
    node.end({ id: "done", name: "Done" }),
  ],
});
`,
      "utf8",
    );

    const project: ProjectConfig = {
      id: "api-proj",
      displayName: "API Proj",
      description: "API Proj",
      routing: {
        projectId: "api-proj",
        displayName: "API Proj",
        summary: "API Proj",
        keywords: [],
      },
      projectDir,
      repository: { url: repoDir, baseBranch: "main" },
      runtime: { type: "fake" },
    };
    const config: AppConfig = {
      port: 7070,
      host: "127.0.0.1",
      dataDir: path.join(rootDir, "data"),
      artifactDir: path.join(rootDir, "artifacts"),
      projectConfigPath: projectDir,
      allowUnauthenticated: true,
      routerModel: "gpt-4o",
      routerBaseUrl: "http://localhost:8317/v1",
      logLevel: "error",
      feishu: { enabled: false },
    };

    const store = new MemoryStore();
    const logger = new Logger({ level: "error" });
    const projectManager = new ProjectManager([project], store, config, logger);
    await projectManager.start();
    const gateway = createGateway(config, store, projectManager, logger);

    try {
      // 1. GET /api/v1/projects/:projectId/pipelines
      const listRes = await gateway.handle(
        new Request("http://localhost/api/v1/projects/api-proj/pipelines"),
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        pipelines: Array<{ id: string; currentVersion: number }>;
      };
      expect(listBody.pipelines).toHaveLength(1);
      expect(listBody.pipelines[0]?.id).toBe("release");
      expect(listBody.pipelines[0]?.currentVersion).toBe(1);

      // 2. Subscribe to SSE stream BEFORE creating a run
      const sseController = new AbortController();
      const sseRes = await gateway.handle(
        new Request("http://localhost/api/v1/projects/api-proj/pipeline-events", {
          signal: sseController.signal,
        }),
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      const firstChunk = await reader.read();
      expect(decoder.decode(firstChunk.value)).toContain("event: connected");

      // 3. POST start run (201), then duplicate externalKey (200)
      const createRes = await gateway.handle(
        new Request("http://localhost/api/v1/projects/api-proj/pipelines/release/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Release 1.0", externalKey: "REL-1" }),
        }),
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        created: boolean;
        run: { runId: string; status: string };
      };
      expect(created.created).toBe(true);
      expect(created.run.status).toBe("waiting_confirmation");
      const runId = created.run.runId;

      // SSE receives pipeline.run.created
      const createdEventChunk = await reader.read();
      expect(decoder.decode(createdEventChunk.value)).toContain("pipeline.run.created");
      sseController.abort();
      await reader.cancel().catch(() => {});

      const dupRes = await gateway.handle(
        new Request("http://localhost/api/v1/projects/api-proj/pipelines/release/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Release 1.0 dup", externalKey: "REL-1" }),
        }),
      );
      expect(dupRes.status).toBe(200);
      const dupBody = (await dupRes.json()) as { created: boolean; run: { runId: string } };
      expect(dupBody.created).toBe(false);
      expect(dupBody.run.runId).toBe(runId);

      // 4. GET runs list & run detail
      const runsRes = await gateway.handle(
        new Request("http://localhost/api/v1/projects/api-proj/pipelines/release/runs?version=1"),
      );
      expect(runsRes.status).toBe(200);
      expect(((await runsRes.json()) as { runs: unknown[] }).runs).toHaveLength(1);

      const detailRes = await gateway.handle(
        new Request(`http://localhost/api/v1/pipeline-runs/${runId}`),
      );
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as {
        run: { runId: string };
        revision: { version: number };
        nodeRuns: unknown[];
      };
      expect(detail.revision.version).toBe(1);
      expect(detail.nodeRuns).toHaveLength(1);

      // 5. Invalid state conflict (signal on waiting_confirmation -> 409) & unknown run -> 404
      const conflictSignal = await gateway.handle(
        new Request(`http://localhost/api/v1/pipeline-runs/${runId}/signal`, {
          method: "POST",
        }),
      );
      expect(conflictSignal.status).toBe(409);

      const notFoundRes = await gateway.handle(
        new Request("http://localhost/api/v1/pipeline-runs/prun_missing"),
      );
      expect(notFoundRes.status).toBe(404);

      // 6. Approve review -> ship -> reject back to review -> approve -> approve -> completed
      const approve1 = await gateway.handle(
        new Request(`http://localhost/api/v1/pipeline-runs/${runId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ humanNote: "ship it" }),
        }),
      );
      expect(approve1.status).toBe(200);
      await waitFor(async () => {
        const r = await store.pipelines.getRun(runId);
        return r?.currentNodeId === "ship" && r.status === "waiting_confirmation" ? r : undefined;
      });

      const reject1 = await gateway.handle(
        new Request(`http://localhost/api/v1/pipeline-runs/${runId}/reject`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "typo", feedback: "fix changelog" }),
        }),
      );
      expect(reject1.status).toBe(200);
      await waitFor(async () => {
        const r = await store.pipelines.getRun(runId);
        return r?.currentNodeId === "review" && r.status === "waiting_confirmation" ? r : undefined;
      });

      // Approve twice to reach terminal `done`
      await gateway.handle(
        new Request(`http://localhost/api/v1/pipeline-runs/${runId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      await waitFor(async () => {
        const r = await store.pipelines.getRun(runId);
        return r?.currentNodeId === "ship" && r.status === "waiting_confirmation" ? r : undefined;
      });
      await gateway.handle(
        new Request(`http://localhost/api/v1/pipeline-runs/${runId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      const doneRun = await waitFor(async () => {
        const r = await store.pipelines.getRun(runId);
        return r?.status === "completed" ? r : undefined;
      });
      expect(doneRun.currentNodeId).toBe("done");

      // Actions audit log contains full history
      const actionsRes = await gateway.handle(
        new Request(`http://localhost/api/v1/pipeline-runs/${runId}/actions`),
      );
      expect(actionsRes.status).toBe(200);
      const actionsBody = (await actionsRes.json()) as { actions: Array<{ action: string }> };
      expect(actionsBody.actions.map((a) => a.action)).toEqual([
        "human_approve",
        "human_reject",
        "human_approve",
        "human_approve",
      ]);

      // Paging continues after the last sequence the client has seen
      const pagedRes = await gateway.handle(
        new Request(`http://localhost/api/v1/pipeline-runs/${runId}/actions?afterSeq=2`),
      );
      const paged = (await pagedRes.json()) as { actions: Array<{ sequence: number }> };
      expect(paged.actions.map((a) => a.sequence)).toEqual([3, 4]);
    } finally {
      await projectManager.stop();
    }
  });
});
