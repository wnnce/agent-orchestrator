import type { ArtifactStore } from "../artifacts/store.ts";
import type { ProjectConfig } from "../domain/types.ts";
import { ProjectMcpClientPool, type McpClientFactory } from "../mcp/index.ts";
import type { NotificationOutbox } from "../notifications/index.ts";
import type { Logger } from "../observability/logger.ts";
import type { PipelineStore } from "../persistence/types.ts";
import { buildGlobalContext, getHistoryDetail, listHistory } from "./context.ts";
import { PipelineNodeLogBuffer } from "./log-buffer.ts";
import type {
  PipelineNodeConfig,
  PipelineNodeRunRecord,
  PipelineNodeSnapshot,
  PipelineReworkInfo,
  PipelineRunRecord,
  PipelineStepCacheEntry,
  PipelineStepState,
  PipelineTsResult,
  PipelineTsRunContext,
  PipelineWaitStateEntry,
  PipelineWaitUntilOptions,
} from "./types.ts";

/** How one execution of a TS node ended. */
export type TsNodeOutcome =
  | { readonly kind: "result"; readonly result: PipelineTsResult }
  | {
      readonly kind: "suspend";
      readonly intervalMs: number;
      readonly summary?: string | undefined;
      readonly stepState: PipelineStepState;
    }
  | { readonly kind: "failed"; readonly reason: string }
  /** Stopped from outside (the run was cancelled or the service is stopping). */
  | { readonly kind: "aborted" };

export interface TsNodeExecution {
  readonly store: PipelineStore;
  readonly project: ProjectConfig;
  readonly run: PipelineRunRecord;
  readonly nodes: readonly PipelineNodeSnapshot[];
  readonly nodeRun: PipelineNodeRunRecord;
  readonly node: PipelineNodeConfig;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly artifacts: ArtifactStore;
  readonly notifications: NotificationOutbox;
  readonly mcpClientFactory?: McpClientFactory | undefined;
}

class SuspendSignal extends Error {
  constructor(
    readonly intervalMs: number,
    readonly summary?: string | undefined,
  ) {
    super("pipeline ts node suspended");
    this.name = "SuspendSignal";
  }
}

/**
 * Runs a TS node's handler once. `ctx.step` and `ctx.waitUntil` persist their results, so a node
 * that suspends, or restarts after a crash, replays its handler without repeating finished steps.
 */
export async function runTsNode(execution: TsNodeExecution): Promise<TsNodeOutcome> {
  const { store, project, run, nodeRun, node } = execution;

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(execution.signal.reason);
  execution.signal.addEventListener("abort", forwardAbort, { once: true });
  let timedOut = false;
  const timer =
    node.timeoutMs && node.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`timed out after ${node.timeoutMs}ms`));
        }, node.timeoutMs)
      : undefined;

  const logBuffer = new PipelineNodeLogBuffer({
    nodeRunId: nodeRun.nodeRunId,
    runId: run.runId,
    projectId: run.projectId,
    initialSequence: await store.getLatestNodeLogSequence(nodeRun.nodeRunId),
    writer: (entries) => store.appendNodeLogs(entries),
    hostLogger: execution.logger,
  });
  const logger = execution.logger.withListener(
    { projectId: run.projectId, runId: run.runId, nodeId: node.id, nodeRunId: nodeRun.nodeRunId },
    (entry) => logBuffer.push(entry),
    { captureAllLevels: true },
  );
  const env = Object.freeze({ ...(project.env ?? {}) });
  const mcpPool = new ProjectMcpClientPool({
    servers: project.runtime?.mcpServers ?? [],
    workdir: execution.workspacePath,
    env,
    signal: controller.signal,
    logger,
    ...(execution.mcpClientFactory ? { clientFactory: execution.mcpClientFactory } : {}),
  });

  const steps: Record<string, PipelineStepCacheEntry> = { ...nodeRun.stepState.steps };
  const waits: Record<string, PipelineWaitStateEntry> = { ...nodeRun.stepState.waits };
  const saveStepState = () =>
    store.updateNodeRunProgress(nodeRun.nodeRunId, { stepState: { steps, waits } });
  const throwIfAborted = () => {
    if (controller.signal.aborted) throw new Error("pipeline node aborted");
  };

  const upstreamAction = nodeRun.triggeredByRecordId
    ? await store.getActionRecord(nodeRun.triggeredByRecordId)
    : null;
  const data = Object.freeze({ ...nodeRun.inputContext });
  const metadata = Object.freeze({
    ...run.metadata,
    ...(upstreamAction?.context.metadata ?? {}),
  });
  const rework: PipelineReworkInfo | undefined =
    upstreamAction &&
    (upstreamAction.action === "pipeline_prev" || upstreamAction.action === "human_reject")
      ? Object.freeze({
          fromNodeId: upstreamAction.fromNodeId,
          reason: upstreamAction.context.reason ?? "",
          feedback: upstreamAction.context.feedback ?? "",
        })
      : undefined;

  const ctx: PipelineTsRunContext = {
    projectId: run.projectId,
    pipelineId: run.pipelineId,
    runId: run.runId,
    nodeId: node.id,
    nodeRunId: nodeRun.nodeRunId,
    attempt: nodeRun.attempt,
    workdir: execution.workspacePath,
    ...(run.branchName ? { branchName: run.branchName } : {}),
    data,
    metadata,
    ...(rework ? { rework } : {}),
    env,
    vars: Object.freeze({ ...(project.vars ?? {}) }),
    logger,
    signal: controller.signal,

    step: async <T>(key: string, fn: () => Promise<T> | T): Promise<T> => {
      throwIfAborted();
      const cached = steps[key];
      if (cached) return cached.value as T;
      const value = await fn();
      steps[key] = { value };
      await saveStepState();
      return value;
    },

    waitUntil: async <T = true>(
      key: string,
      options: PipelineWaitUntilOptions,
      check: () => Promise<T | false> | T | false,
    ): Promise<T> => {
      throwIfAborted();
      const existing = waits[key];
      if (existing?.status === "done") return existing.value as T;
      const startedAt = existing?.startedAt ?? new Date().toISOString();
      if (options.timeoutMs && Date.now() - Date.parse(startedAt) >= options.timeoutMs) {
        const detail = options.summary ? `: ${options.summary}` : "";
        throw new Error(`waitUntil("${key}") timed out after ${options.timeoutMs}ms${detail}`);
      }
      const summary = options.summary !== undefined ? { summary: options.summary } : {};

      const result = await check();
      if (result === false) {
        waits[key] = { status: "waiting", startedAt, ...summary };
        await saveStepState();
        throw new SuspendSignal(options.intervalMs, options.summary);
      }
      waits[key] = {
        status: "done",
        startedAt,
        completedAt: new Date().toISOString(),
        value: result,
        ...summary,
      };
      await saveStepState();
      return result;
    },

    getContext: async () =>
      buildGlobalContext(store, (await store.getRun(run.runId)) ?? run, execution.nodes, nodeRun),
    listHistory: (filter) => listHistory(store, run.runId, filter),
    getHistoryDetail: (query) => getHistoryDetail(store, run.runId, query),
    notify: async (message, options) => {
      await execution.notifications.queue(
        run.projectId,
        run.runId,
        project.notifications,
        message,
        options,
      );
    },
    createArtifact: (params) =>
      execution.artifacts.write(
        run.projectId,
        nodeRun.nodeRunId,
        undefined,
        params.kind,
        params.content,
        params.contentType ?? "text/plain",
      ),
    callMcpTool: (serverName, toolName, args, options) =>
      mcpPool.callTool(serverName, toolName, args, options),
    listMcpTools: (serverName, options) => mcpPool.listTools(serverName, options),
  };

  let outcome: TsNodeOutcome;
  try {
    const handler = node.handler;
    if (!handler) {
      throw new Error(`TS pipeline node "${node.id}" has no handler function`);
    }
    outcome = { kind: "result", result: validateTsResult(node.id, await handler(ctx)) };
  } catch (error) {
    outcome =
      error instanceof SuspendSignal
        ? {
            kind: "suspend",
            intervalMs: error.intervalMs,
            ...(error.summary !== undefined ? { summary: error.summary } : {}),
            stepState: { steps, waits },
          }
        : { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
    execution.signal.removeEventListener("abort", forwardAbort);
    await mcpPool.close();
    await logBuffer.flush();
  }

  // What the handler did after its time ran out does not count, whatever it returned.
  if (timedOut) {
    return {
      kind: "failed",
      reason: `TS pipeline node "${node.id}" timed out after ${node.timeoutMs}ms`,
    };
  }
  if (execution.signal.aborted) return { kind: "aborted" };
  return outcome;
}

function validateTsResult(nodeId: string, result: unknown): PipelineTsResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(
      `TS pipeline node "${nodeId}" must return a structured PipelineTsResult object`,
    );
  }
  const value = result as Record<string, unknown>;
  const required: Record<string, readonly string[]> = {
    next: ["summary", "content"],
    prev: ["reason", "feedback"],
    request_confirmation: ["summary", "question"],
    fail: ["reason"],
  };
  const action = String(value.action);
  const fields = Object.hasOwn(required, action) ? required[action] : undefined;
  if (!fields) {
    throw new Error(`TS pipeline node "${nodeId}" returned unsupported action "${action}"`);
  }
  for (const field of fields) {
    const text = value[field];
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(
        `TS pipeline node "${nodeId}" action "${action}" requires non-empty ${field}`,
      );
    }
  }
  return value as unknown as PipelineTsResult;
}
