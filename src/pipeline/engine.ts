import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { pipelineNextInput } from "../tools/builtin/pipeline-node.ts";
import type { PipelineOrigin } from "../domain/origin.ts";
import type { ProjectConfig, SessionRoute } from "../domain/types.ts";
import type { ContextOptions, ScopedContext } from "../context/index.ts";
import type { NotificationOutbox } from "../notifications/index.ts";
import type { Logger } from "../observability/logger.ts";
import { activeTraceparent, detached, linksTo, withSpan } from "../observability/tracing.ts";
import type { PipelineStore } from "../persistence/types.ts";
import type { WorkspaceManager } from "../workspace/workspace.ts";
import {
  MISSING_ACTION_REMINDER,
  buildAgentNodePrompt,
  buildGlobalContext,
  getHistoryDetail,
  listHistory,
  resolveApprovalHandoff,
  type PipelineHistoryQuery,
} from "./context.ts";
import { PipelineConflictError, PipelineNotFoundError, PipelineValidationError } from "./errors.ts";
import type { PipelineEventHub } from "./hub.ts";
import { loadProjectPipelines, toNodesSnapshot } from "./loader.ts";
import {
  decide,
  planNewRun,
  type PipelineCommand,
  type PipelineEffect,
  type PipelineMachineState,
  type PipelineTransition,
} from "./machine.ts";
import { PipelineScheduler, type PipelineClaimResult } from "./scheduler.ts";
import { validateNodeInputData } from "./sdk.ts";
import { runTsNode } from "./ts-node.ts";
import type {
  ListPipelineActionsFilter,
  ListPipelineNodeLogsFilter,
  ListPipelineRunsFilter,
  NewPipelineNodeRun,
  PipelineActionContextPayload,
  PipelineActionName,
  PipelineHistoryFilter,
  PipelineActionRecord,
  PipelineDefinition,
  PipelineFlowActionName,
  PipelineGlobalContextView,
  PipelineHistoryEntrySummary,
  PipelineNodeConfig,
  PipelineNodeLogRecord,
  PipelineNodeRunRecord,
  PipelineNodeRuntimeConfig,
  PipelineNodeSnapshot,
  PipelineRevisionRecord,
  PipelineRunRecord,
  PipelineStreamEventType,
  PipelineSummaryWithVersions,
  StartPipelineRunParams,
  StartPipelineRunResult,
} from "./types.ts";

/** The session operations the engine needs from the project runtime. */
export interface PipelineSessionPort {
  create(params: {
    readonly workspacePath: string;
    readonly title: string;
    /** The node run the session's agent works on. */
    readonly owner: PipelineOrigin;
    readonly runtimeOverride?: PipelineNodeRuntimeConfig | undefined;
  }): Promise<SessionRoute>;
  /** Queues a turn under the given id, so the engine can record it before the turn can finish. */
  runTurn(sessionId: string, input: string, turnId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
}

export interface PipelineEngineDeps {
  readonly project: ProjectConfig;
  readonly store: PipelineStore;
  readonly workspaces: WorkspaceManager;
  /** Sends the run's own notifications (completion, failure). */
  readonly notifications: NotificationOutbox;
  readonly hub: PipelineEventHub;
  readonly logger: Logger;
  readonly sessions: PipelineSessionPort;
  /** The project's capabilities acting as one node run, for code nodes. */
  readonly createContext: (origin: PipelineOrigin, options: ContextOptions) => ScopedContext;
  /** Polls of waiting TS nodes are aligned to this window so nearby polls run together. */
  readonly minPollCoalesceMs?: number | undefined;
}

/** How often a transition is recomputed when the run changed between reading and committing. */
const MAX_TRANSITION_ATTEMPTS = 5;

/**
 * Runs a project's pipelines. Every state change goes the same way: read the run, let the state
 * machine (`machine.ts`) decide, commit the result in one transaction that only succeeds if the
 * run did not change meanwhile, then carry out the effects (sessions, TS handlers, workspaces).
 * The engine holds no lock while it does that, and no state the store does not have.
 */
export class PipelineEngine {
  private readonly definitions = new Map<string, PipelineDefinition>();
  private readonly currentVersions = new Map<string, number>();
  /** Revisions never change once written. */
  private readonly revisionNodes = new Map<string, readonly PipelineNodeSnapshot[]>();
  private readonly tsExecutions = new Map<string, AbortController>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly scheduler: PipelineScheduler;
  private readonly minPollCoalesceMs: number;

  constructor(private readonly deps: PipelineEngineDeps) {
    this.minPollCoalesceMs = Math.max(10, deps.minPollCoalesceMs ?? 1000);
    this.scheduler = new PipelineScheduler({
      projectId: deps.project.id,
      store: deps.store,
      logger: deps.logger,
      capacityOf: (nodeRun) => this.capacityOf(nodeRun),
      claim: (nodeRun) => this.claim(nodeRun),
      wake: (nodeRun) =>
        this.transitionQuietly(nodeRun, { kind: "wake", reason: "poll_due" }).then(() => {}),
    });
  }

  get eventHub(): PipelineEventHub {
    return this.deps.hub;
  }

  /** Loads the project's pipeline definitions, recovers work cut off by a restart, and starts. */
  async start(explicitDefinitions?: readonly PipelineDefinition[]): Promise<void> {
    await this.syncDefinitions(explicitDefinitions);
    for (const nodeRun of await this.deps.store.listNodeRunsByStatus(this.deps.project.id, [
      "running",
    ])) {
      await this.transitionQuietly(nodeRun, { kind: "recover_after_restart" });
    }
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
    for (const controller of this.tsExecutions.values()) {
      controller.abort(new Error("pipeline engine stopping"));
    }
    await Promise.allSettled([...this.inFlight]);
  }

  async syncDefinitions(explicitDefinitions?: readonly PipelineDefinition[]): Promise<void> {
    const { project, store, logger } = this.deps;
    const loaded =
      explicitDefinitions ??
      (project.projectDir
        ? await loadProjectPipelines({
            projectId: project.id,
            projectDir: project.projectDir,
            projectVars: project.vars,
            logger,
          })
        : []);

    this.definitions.clear();
    this.currentVersions.clear();
    for (const def of loaded) {
      this.definitions.set(def.id, def);
      const latest = await store.getLatestRevision(project.id, def.id);
      if (latest?.topologyHash === def.topologyHash) {
        this.currentVersions.set(def.id, latest.version);
        continue;
      }
      const version = (latest?.version ?? 0) + 1;
      await store.createRevision({
        projectId: project.id,
        pipelineId: def.id,
        version,
        topologyHash: def.topologyHash,
        nodesSnapshot: toNodesSnapshot(def.nodes),
        createdAt: new Date().toISOString(),
      });
      this.currentVersions.set(def.id, version);
      logger.info("registered new pipeline topology revision", {
        projectId: project.id,
        pipelineId: def.id,
        version,
        topologyHash: def.topologyHash.slice(0, 12),
      });
    }
  }

  getDefinition(pipelineId: string): PipelineDefinition | undefined {
    return this.definitions.get(pipelineId);
  }

  listDefinitions(): PipelineDefinition[] {
    return [...this.definitions.values()];
  }

  getCurrentVersion(pipelineId: string): number | undefined {
    return this.currentVersions.get(pipelineId);
  }

  /**
   * Returns per-session action parameter overrides for an agent executing `nodeId` in `pipelineId`.
   * Tailors `pipeline_next` natively to the next node's declared `input` schema (or omits `data`
   * when the next node does not declare an input contract).
   */
  /**
   * The `pipeline_next` input for an agent at `nodeId`: its `data` follows the next node's
   * declared input. Undefined when the pipeline or node is unknown.
   */
  pipelineNextInput(pipelineId: string, nodeId: string): z.ZodObject | undefined {
    const def = this.definitions.get(pipelineId);
    if (!def) return undefined;
    const index = def.nodes.findIndex((n) => n.id === nodeId);
    if (index < 0) return undefined;
    return pipelineNextInput(def.nodes[index + 1]?.inputSchema);
  }

  async listPipelinesWithVersions(): Promise<PipelineSummaryWithVersions[]> {
    const { project, store } = this.deps;
    const summaries: PipelineSummaryWithVersions[] = [];
    for (const def of this.definitions.values()) {
      const currentVersion = this.currentVersions.get(def.id) ?? 1;
      const [revisions, counts] = await Promise.all([
        store.listRevisions(project.id, def.id),
        store.countRunsByVersion(project.id, def.id),
      ]);
      const countsByVersion = new Map(counts.map((c) => [c.version, c]));
      summaries.push({
        id: def.id,
        name: def.name,
        ...(def.description !== undefined ? { description: def.description } : {}),
        enabled: def.enabled,
        currentVersion,
        currentTopologyHash: def.topologyHash,
        nodes: toNodesSnapshot(def.nodes),
        ...(def.nodes[0]?.inputJsonSchema ? { entryInputSchema: def.nodes[0].inputJsonSchema } : {}),
        notifyOn: def.notifyOn,
        activeVersions: revisions
          .filter((rev) => rev.version === currentVersion || countsByVersion.has(rev.version))
          .map((rev) => ({
            version: rev.version,
            activeRunCount: countsByVersion.get(rev.version)?.activeRunCount ?? 0,
            totalRunCount: countsByVersion.get(rev.version)?.totalRunCount ?? 0,
            nodes: rev.nodesSnapshot,
          })),
      });
    }
    return summaries;
  }

  // =====================================================================
  // Runs
  // =====================================================================

  async startRun(params: StartPipelineRunParams): Promise<StartPipelineRunResult> {
    const { project, store } = this.deps;
    const def = this.definitions.get(params.pipelineId);
    if (!def) {
      throw new PipelineNotFoundError(`pipeline not found: ${project.id}/${params.pipelineId}`);
    }
    if (!def.enabled) throw new PipelineConflictError(`pipeline "${def.id}" is disabled`);

    const externalKey = params.externalKey?.trim() || undefined;
    const findExisting = () =>
      externalKey ? store.findRunByExternalKey(project.id, def.id, externalKey) : null;
    const existing = await findExisting();
    if (existing) return { created: false, run: existing };

    const version = this.currentVersions.get(def.id) ?? 1;
    const nodes = await this.nodesOf(def.id, version);
    const firstNodeCfg = def.nodes[0];
    const validatedData = validateNodeInputData(
      firstNodeCfg?.id ?? nodes[0]!.id,
      firstNodeCfg?.inputSchema,
      params.data,
    );
    const now = new Date().toISOString();
    const planned = planNewRun({
      run: {
        runId: `prun_${randomUUID()}`,
        projectId: project.id,
        pipelineId: def.id,
        pipelineVersion: version,
        ...(externalKey ? { externalKey } : {}),
        ...(params.externalUrl ? { externalUrl: params.externalUrl } : {}),
        title: params.title.trim(),
        ...(params.description !== undefined ? { description: params.description } : {}),
        data: validatedData,
        metadata: params.metadata ?? {},
        createdBy: params.createdBy?.trim() || "api",
        createdAt: now,
        updatedAt: now,
      },
      firstNode: nodes[0]!,
      nodeRunId: `pnr_${randomUUID()}`,
    });

    let run: PipelineRunRecord;
    try {
      run = await store.createRun(planned.run, withTraceparent(planned.firstNodeRun));
    } catch (error) {
      // Another caller created the run for this externalKey first.
      const raced = await findExisting();
      if (raced) return { created: false, run: raced };
      throw error;
    }
    this.publish("pipeline.run.created", run, { nodeRunId: run.activeNodeRunId });
    await this.notifyStatus(run);
    this.scheduler.refresh();
    return { created: true, run };
  }

  async listRuns(
    pipelineId: string,
    filter?: Omit<ListPipelineRunsFilter, "projectId" | "pipelineId">,
  ): Promise<PipelineRunRecord[]> {
    return this.deps.store.listRuns({ ...filter, projectId: this.deps.project.id, pipelineId });
  }

  async getRunDetail(runId: string): Promise<{
    run: PipelineRunRecord;
    revision: PipelineRevisionRecord | null;
    nodeRuns: PipelineNodeRunRecord[];
    actionCount: number;
  }> {
    const { store } = this.deps;
    const run = await this.requireRun(runId);
    const [revision, nodeRuns, actionCount] = await Promise.all([
      store.getRevision(run.projectId, run.pipelineId, run.pipelineVersion),
      store.listNodeRuns(run.runId),
      store.getLatestActionSequence(run.runId),
    ]);
    return { run, revision, nodeRuns, actionCount };
  }

  async listRunActions(
    runId: string,
    filter?: ListPipelineActionsFilter,
  ): Promise<PipelineActionRecord[]> {
    await this.requireRun(runId);
    return this.deps.store.listActionRecords(runId, filter);
  }

  async listNodeRunLogs(
    nodeRunId: string,
    filter?: ListPipelineNodeLogsFilter,
  ): Promise<PipelineNodeLogRecord[]> {
    const nodeRun = await this.deps.store.getNodeRun(nodeRunId);
    if (nodeRun?.projectId !== this.deps.project.id) {
      throw new PipelineNotFoundError(`pipeline node run not found: ${nodeRunId}`);
    }
    return this.deps.store.listNodeLogs(nodeRunId, filter);
  }

  // =====================================================================
  // Agent sessions
  // =====================================================================

  async getContextForNodeRun(nodeRunId: string): Promise<PipelineGlobalContextView> {
    const nodeRun = await this.requireNodeRun(nodeRunId);
    const run = await this.requireRun(nodeRun.runId);
    return buildGlobalContext(this.deps.store, run, await this.nodesOfRun(run), nodeRun);
  }

  async listHistory(
    runId: string,
    filter?: PipelineHistoryFilter,
  ): Promise<PipelineHistoryEntrySummary[]> {
    await this.requireRun(runId);
    return listHistory(this.deps.store, runId, filter);
  }

  async getHistoryDetail(
    runId: string,
    query: PipelineHistoryQuery,
  ): Promise<PipelineActionRecord | null> {
    await this.requireRun(runId);
    return getHistoryDetail(this.deps.store, runId, query);
  }

  /**
   * Records a flow action an agent called. It is checked now, so the model can correct an invalid
   * call within the same turn, and applied when the turn finishes.
   */
  async registerAgentDecision(params: {
    readonly nodeRunId: string;
    readonly turnId?: string | undefined;
    readonly action: PipelineFlowActionName;
    readonly context: PipelineActionContextPayload;
  }): Promise<Record<string, unknown>> {
    const nodeRun = await this.requireNodeRun(params.nodeRunId);
    await this.transition(nodeRun.runId, {
      nodeRunId: nodeRun.nodeRunId,
      command: {
        kind: "register_decision",
        decision: {
          action: params.action,
          context: params.context,
          ...(params.turnId ? { turnId: params.turnId } : {}),
        },
      },
    });
    return {
      accepted: true,
      action: params.action,
      runId: nodeRun.runId,
      nodeId: nodeRun.nodeId,
      deferredUntilTurnComplete: true,
    };
  }

  /** Called by the project runtime after any turn of a pipeline session has finished. */
  async onSessionTurnFinished(params: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly status: "completed" | "failed" | "interrupted";
    readonly output?: string | undefined;
    readonly error?: string | undefined;
  }): Promise<void> {
    const nodeRun = await this.deps.store.findNodeRunBySession(params.sessionId);
    if (!nodeRun) return;
    await this.transitionQuietly(nodeRun, {
      kind: "turn_finished",
      turnId: params.turnId,
      status: params.status,
      ...(params.output !== undefined ? { output: params.output } : {}),
      ...(params.error !== undefined ? { error: params.error } : {}),
    });
  }

  // =====================================================================
  // Human operations
  // =====================================================================

  async approveRun(
    runId: string,
    options?: {
      readonly humanNote?: string | undefined;
      readonly data?: Record<string, unknown> | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
      readonly actorId?: string | undefined;
    },
  ): Promise<PipelineRunRecord> {
    return this.transition(runId, {
      command: async (state) => ({
        kind: "approve",
        handoff: await resolveApprovalHandoff(this.deps.store, state.nodeRun),
        humanNote: options?.humanNote,
        data: options?.data,
        metadata: options?.metadata,
        actorId: options?.actorId,
      }),
    });
  }

  async rejectRun(
    runId: string,
    params: {
      readonly reason: string;
      readonly feedback: string;
      readonly targetNodeId?: string | undefined;
      readonly data?: Record<string, unknown> | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
      readonly actorId?: string | undefined;
    },
  ): Promise<PipelineRunRecord> {
    const reason = params.reason.trim();
    const feedback = params.feedback.trim();
    if (!reason || !feedback) {
      throw new PipelineValidationError(
        "reason and feedback are required to reject a pipeline run",
      );
    }
    return this.transition(runId, {
      command: {
        kind: "reject",
        reason,
        feedback,
        targetNodeId: params.targetNodeId,
        data: params.data,
        metadata: params.metadata,
        actorId: params.actorId,
      },
    });
  }

  async retryRun(
    runId: string,
    options?: {
      readonly preserveStepState?: boolean | undefined;
      readonly actorId?: string | undefined;
    },
  ): Promise<PipelineRunRecord> {
    return this.transition(runId, {
      command: {
        kind: "retry",
        preserveStepState: options?.preserveStepState ?? false,
        actorId: options?.actorId,
      },
    });
  }

  /** Stops the run for good: interrupts its node, archives its session, removes its workspace. */
  async cancelRun(
    runId: string,
    options?: { readonly reason?: string | undefined; readonly actorId?: string | undefined },
  ): Promise<PipelineRunRecord> {
    return this.transition(runId, {
      command: {
        kind: "cancel",
        reason: options?.reason?.trim() || "Terminated by human",
        actorId: options?.actorId,
      },
    });
  }

  /** Wakes a waiting TS node now instead of at its next poll. */
  async signalRun(runId: string): Promise<{ woken: boolean; run: PipelineRunRecord }> {
    const run = await this.transition(runId, { command: { kind: "wake", reason: "signal" } });
    return { woken: true, run };
  }

  // =====================================================================
  // Transitions
  // =====================================================================

  /**
   * Applies a command to a run and returns the run afterwards. `nodeRunId` names the node run the
   * command is about; the command is refused when that node run is no longer the active one.
   */
  private async transition(
    runId: string,
    request: {
      readonly nodeRunId?: string | undefined;
      readonly command:
        | PipelineCommand
        | ((state: PipelineMachineState) => Promise<PipelineCommand> | PipelineCommand);
      readonly capacity?: number | undefined;
    },
  ): Promise<PipelineRunRecord> {
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt += 1) {
      const state = await this.loadState(runId);
      if (request.nodeRunId && state.nodeRun.nodeRunId !== request.nodeRunId) {
        throw new PipelineConflictError(
          `node run ${request.nodeRunId} is no longer the active node of run ${runId}`,
        );
      }
      const command =
        typeof request.command === "function" ? await request.command(state) : request.command;
      const def = this.definitions.get(state.run.pipelineId);
      const nodeRuns = await this.deps.store.listNodeRuns(runId);
      const latestDataByNodeId = new Map<string, Record<string, unknown>>();
      for (const nr of nodeRuns) {
        latestDataByNodeId.set(nr.nodeId, nr.inputContext);
      }
      const resolveNodeData = (
        targetNodeId: string,
        rawData: Record<string, unknown> | undefined,
        mode: "advance" | "rework",
      ): Record<string, unknown> => {
        const nodeCfg = def?.nodes.find((n) => n.id === targetNodeId);
        if (!nodeCfg?.inputSchema) return {};
        const candidate =
          mode === "rework"
            ? { ...(latestDataByNodeId.get(targetNodeId) ?? {}), ...(rawData ?? {}) }
            : rawData;
        return validateNodeInputData(targetNodeId, nodeCfg.inputSchema, candidate);
      };
      const now = new Date().toISOString();
      const transition = decide(state, command, {
        now,
        newRecordId: `pact_${randomUUID()}`,
        newNodeRunId: `pnr_${randomUUID()}`,
        resolveNodeData,
      });
      if (!transition) return state.run;

      const result = await this.deps.store.commitTransition({
        runId,
        expectedStateVersion: state.run.stateVersion,
        runPatch: transition.runPatch,
        ...(transition.nodeRunPatch
          ? { nodeRunPatch: { nodeRunId: state.nodeRun.nodeRunId, patch: transition.nodeRunPatch } }
          : {}),
        ...(transition.newNodeRun ? { newNodeRun: withTraceparent(transition.newNodeRun) } : {}),
        ...(transition.record ? { record: transition.record } : {}),
        ...(request.capacity !== undefined
          ? {
              capacity: {
                projectId: state.run.projectId,
                pipelineId: state.run.pipelineId,
                nodeId: state.nodeRun.nodeId,
                limit: request.capacity,
              },
            }
          : {}),
      });
      if (result.status === "conflict") continue;
      if (result.status === "no_capacity") return state.run;

      if (result.record)
        this.publish("pipeline.action.recorded", result.run, { record: result.record });
      this.publish(runEventType(result.run), result.run, {
        nodeRunId: result.run.activeNodeRunId,
        ...(result.record ? { action: result.record.action } : {}),
      });
      if (result.record || result.run.status !== state.run.status) {
        await this.notifyStatus(result.run);
      }
      const run = await this.runEffects(state, result.run, transition.effects);
      if (changesSchedule(transition)) this.scheduler.refresh();
      return run;
    }
    throw new PipelineConflictError(`pipeline run ${runId} kept changing; try again`);
  }

  /**
   * A transition the engine starts on its own (a turn finished, a handler returned, a poll is due).
   * When the run has moved on in the meantime, there is nothing left to do.
   */
  private async transitionQuietly(
    nodeRun: Pick<PipelineNodeRunRecord, "runId" | "nodeRunId">,
    command: PipelineCommand,
  ): Promise<void> {
    try {
      await this.transition(nodeRun.runId, { nodeRunId: nodeRun.nodeRunId, command });
    } catch (error) {
      if (!(error instanceof PipelineConflictError)) throw error;
      this.deps.logger.debug("pipeline transition no longer applies", {
        projectId: this.deps.project.id,
        runId: nodeRun.runId,
        nodeRunId: nodeRun.nodeRunId,
        command: command.kind,
        reason: error.message,
      });
    }
  }

  private capacityOf(nodeRun: PipelineNodeRunRecord): number {
    return this.nodeConfig(nodeRun)?.concurrency ?? 1;
  }

  /** Starts a queued node run if its node has a free slot. */
  private async claim(nodeRun: PipelineNodeRunRecord): Promise<PipelineClaimResult> {
    try {
      const run = await this.transition(nodeRun.runId, {
        nodeRunId: nodeRun.nodeRunId,
        command: { kind: "claim" },
        capacity: this.capacityOf(nodeRun),
      });
      // A refused claim leaves the run as it was: still queued on this node run.
      return run.status === "running" ? "started" : "no_capacity";
    } catch (error) {
      if (!(error instanceof PipelineConflictError)) throw error;
      return "skipped";
    }
  }

  private async loadState(runId: string): Promise<PipelineMachineState> {
    const run = await this.requireRun(runId);
    const nodeRun = run.activeNodeRunId
      ? await this.deps.store.getNodeRun(run.activeNodeRunId)
      : null;
    if (!nodeRun) {
      throw new PipelineNotFoundError(`active node run of pipeline run ${runId} not found`);
    }
    return { run, nodeRun, nodes: await this.nodesOfRun(run) };
  }

  // =====================================================================
  // Effects
  // =====================================================================

  private async runEffects(
    state: PipelineMachineState,
    committed: PipelineRunRecord,
    effects: readonly PipelineEffect[],
  ): Promise<PipelineRunRecord> {
    let run = committed;
    for (const effect of effects) {
      try {
        switch (effect.kind) {
          case "launch_node":
            // The launch runs in the background, outside the trace of this transition.
            this.track(detached(() => this.launchNode(run.runId, state.nodeRun.nodeRunId)));
            break;
          case "send_reminder":
            await this.sendReminder(state.nodeRun, effect.sessionId);
            break;
          case "stop_node":
            this.tsExecutions.get(effect.nodeRunId)?.abort(new Error("pipeline run cancelled"));
            if (effect.sessionId) await this.deps.sessions.interrupt(effect.sessionId);
            break;
          case "archive_session":
            await this.deps.sessions.archive(effect.sessionId);
            break;
          case "remove_workspace":
            run = await this.removeWorkspace(run);
            break;
        }
      } catch (error) {
        this.deps.logger.warn("pipeline effect failed", {
          projectId: run.projectId,
          runId: run.runId,
          effect: effect.kind,
          error: (error as Error).message,
        });
      }
    }
    return run;
  }

  /** Prepares the shared workspace, then starts the claimed node's agent or TS handler. */
  private async launchNode(runId: string, nodeRunId: string): Promise<void> {
    try {
      const state = await this.loadState(runId);
      if (state.nodeRun.nodeRunId !== nodeRunId || state.nodeRun.status !== "running") return;
      const node = this.nodeConfig(state.nodeRun);
      if (!node) {
        throw new Error(`node "${state.nodeRun.nodeId}" is not defined in pipeline "${runId}"`);
      }

      // A run can last days and wait on people, so each launch is a trace of its own, linked to
      // the operation that created the node run; `pipeline.run_id` gathers a run's traces.
      await withSpan(
        `pipeline.node ${node.id}`,
        {
          root: true,
          links: linksTo(state.nodeRun.traceparent),
          attributes: {
            "project.id": state.run.projectId,
            "pipeline.id": state.run.pipelineId,
            "pipeline.version": state.run.pipelineVersion,
            "pipeline.run_id": runId,
            "pipeline.node_id": node.id,
            "pipeline.node_run_id": nodeRunId,
            "pipeline.node.executor": node.executor,
            "pipeline.node.attempt": state.nodeRun.attempt,
          },
        },
        () => this.startNode(state, node),
      );
    } catch (error) {
      await this.transitionQuietly(
        { runId, nodeRunId },
        { kind: "fail", actorType: "system", reason: (error as Error).message },
      );
    }
  }

  private async startNode(state: PipelineMachineState, node: PipelineNodeConfig): Promise<void> {
    const run = await withSpan("workspace.prepare", {}, () => this.ensureWorkspace(state.run));
    if (!(await this.isRunning(state.nodeRun))) {
      // The run was cancelled while its workspace was being prepared.
      const latest = await this.requireRun(run.runId);
      if (latest.status === "cancelled") await this.removeWorkspace(latest);
      return;
    }
    if (node.executor === "agent") {
      await this.startAgentNode(run, state, node);
    } else {
      await this.executeTsNode(run, state, node);
    }
  }

  private async startAgentNode(
    run: PipelineRunRecord,
    state: PipelineMachineState,
    node: PipelineNodeConfig,
  ): Promise<void> {
    const { store, sessions } = this.deps;
    const session = await sessions.create({
      workspacePath: run.workspacePath!,
      title: `[${run.pipelineId}/${node.name}] ${run.title}`,
      owner: {
        kind: "pipeline",
        pipelineId: run.pipelineId,
        runId: run.runId,
        nodeId: node.id,
        nodeRunId: state.nodeRun.nodeRunId,
      },
      ...(node.runtime ? { runtimeOverride: node.runtime } : {}),
    });
    await store.updateNodeRunProgress(state.nodeRun.nodeRunId, { sessionId: session.sessionId });
    if (!(await this.isRunning(state.nodeRun))) {
      await sessions.archive(session.sessionId);
      return;
    }

    const nodeRun = { ...state.nodeRun, sessionId: session.sessionId };
    const defNodes = this.definitions.get(run.pipelineId)?.nodes;
    const defIndex = defNodes ? defNodes.findIndex((n) => n.id === node.id) : -1;
    const nextNode = defIndex >= 0 ? defNodes?.[defIndex + 1] : undefined;
    const prompt = await buildAgentNodePrompt({
      store,
      project: this.deps.project,
      run,
      nodes: state.nodes,
      nodeRun,
      node,
      nextNode,
    });
    await this.startAgentTurn(nodeRun, session.sessionId, prompt);
  }

  private async sendReminder(nodeRun: PipelineNodeRunRecord, sessionId: string): Promise<void> {
    try {
      await this.startAgentTurn(nodeRun, sessionId, MISSING_ACTION_REMINDER);
    } catch (error) {
      this.deps.logger.warn("failed to send pipeline reminder turn", {
        projectId: this.deps.project.id,
        nodeRunId: nodeRun.nodeRunId,
        error: (error as Error).message,
      });
      // The reminder counts as sent, so finishing the agent's turn again now falls back to
      // manual confirmation.
      const latest = await this.deps.store.getNodeRun(nodeRun.nodeRunId);
      if (!latest?.agentTurnId) return;
      await this.transitionQuietly(latest, {
        kind: "turn_finished",
        turnId: latest.agentTurnId,
        status: "completed",
      });
    }
  }

  /** Records the turn as the engine's own before queueing it, so it cannot finish unrecognized. */
  private async startAgentTurn(
    nodeRun: PipelineNodeRunRecord,
    sessionId: string,
    input: string,
  ): Promise<void> {
    const turnId = `turn_${randomUUID()}`;
    await this.deps.store.updateNodeRunProgress(nodeRun.nodeRunId, { agentTurnId: turnId });
    await this.deps.sessions.runTurn(sessionId, input, turnId);
  }

  private async executeTsNode(
    run: PipelineRunRecord,
    state: PipelineMachineState,
    node: PipelineNodeConfig,
  ): Promise<void> {
    const controller = new AbortController();
    this.tsExecutions.set(state.nodeRun.nodeRunId, controller);
    try {
      const outcome = await runTsNode({
        store: this.deps.store,
        run,
        nodes: state.nodes,
        nodeRun: state.nodeRun,
        node,
        workspacePath: run.workspacePath!,
        signal: controller.signal,
        logger: this.deps.logger,
        createContext: this.deps.createContext,
      });
      switch (outcome.kind) {
        case "result":
          try {
            await this.transitionQuietly(state.nodeRun, {
              kind: "ts_result",
              result: outcome.result,
            });
          } catch (error) {
            if (!(error instanceof PipelineValidationError)) throw error;
            // The handler asked for a transition its node does not allow.
            await this.transitionQuietly(state.nodeRun, {
              kind: "fail",
              actorType: "ts",
              reason: error.message,
            });
          }
          break;
        case "suspend":
          await this.transitionQuietly(state.nodeRun, {
            kind: "suspend",
            nextPollAt: this.nextPollAt(outcome.intervalMs),
            summary: outcome.summary,
            stepState: outcome.stepState,
          });
          break;
        case "failed":
          await this.transitionQuietly(state.nodeRun, {
            kind: "fail",
            actorType: "ts",
            reason: outcome.reason,
          });
          break;
        case "aborted":
          break;
      }
    } finally {
      this.tsExecutions.delete(state.nodeRun.nodeRunId);
    }
  }

  private async ensureWorkspace(run: PipelineRunRecord): Promise<PipelineRunRecord> {
    if (run.workspaceStatus === "active" && run.workspacePath) return run;
    const { workspacePath, branchName } = await this.deps.workspaces.ensurePipelineWorkspace(
      this.deps.project,
      run.runId,
    );
    const patch = {
      workspacePath,
      ...(branchName ? { branchName } : {}),
      workspaceStatus: "active" as const,
    };
    await this.deps.store.updateRunWorkspace(run.runId, patch);
    return { ...run, ...patch };
  }

  private async removeWorkspace(run: PipelineRunRecord): Promise<PipelineRunRecord> {
    if (run.workspaceStatus !== "active") return run;
    await this.deps.workspaces.removePipelineWorkspace(this.deps.project, run.runId);
    await this.deps.store.updateRunWorkspace(run.runId, { workspaceStatus: "cleaned" });
    return { ...run, workspaceStatus: "cleaned" };
  }

  private async isRunning(nodeRun: PipelineNodeRunRecord): Promise<boolean> {
    const latest = await this.deps.store.getNodeRun(nodeRun.nodeRunId);
    return latest?.status === "running";
  }

  /** Aligns polls to the coalescing window so nearby waits wake up in one batch. */
  private nextPollAt(intervalMs: number): string {
    const window = this.minPollCoalesceMs;
    const target = Date.now() + Math.max(window, intervalMs);
    return new Date(Math.ceil(target / window) * window).toISOString();
  }

  /** Runs work in the background; `stop()` waits for it. */
  private track(task: Promise<void>): void {
    const tracked = task
      .catch((error) =>
        this.deps.logger.error("pipeline background work failed", {
          projectId: this.deps.project.id,
          error: (error as Error).message,
        }),
      )
      .finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  // =====================================================================
  // Helpers
  // =====================================================================

  private nodeConfig(nodeRun: PipelineNodeRunRecord): PipelineNodeConfig | undefined {
    return this.definitions.get(nodeRun.pipelineId)?.nodes.find((n) => n.id === nodeRun.nodeId);
  }

  private async nodesOfRun(run: PipelineRunRecord): Promise<readonly PipelineNodeSnapshot[]> {
    return this.nodesOf(run.pipelineId, run.pipelineVersion);
  }

  private async nodesOf(
    pipelineId: string,
    version: number,
  ): Promise<readonly PipelineNodeSnapshot[]> {
    const key = `${pipelineId}@${version}`;
    const cached = this.revisionNodes.get(key);
    if (cached) return cached;
    const revision = await this.deps.store.getRevision(this.deps.project.id, pipelineId, version);
    if (!revision) throw new PipelineNotFoundError(`pipeline revision not found: ${key}`);
    this.revisionNodes.set(key, revision.nodesSnapshot);
    return revision.nodesSnapshot;
  }

  private async requireRun(runId: string): Promise<PipelineRunRecord> {
    const run = await this.deps.store.getRun(runId);
    if (run?.projectId !== this.deps.project.id) {
      throw new PipelineNotFoundError(`pipeline run not found: ${runId}`);
    }
    return run;
  }

  private async requireNodeRun(nodeRunId: string): Promise<PipelineNodeRunRecord> {
    const nodeRun = await this.deps.store.getNodeRun(nodeRunId);
    if (nodeRun?.projectId !== this.deps.project.id) {
      throw new PipelineNotFoundError(`pipeline node run not found: ${nodeRunId}`);
    }
    return nodeRun;
  }

  private publish(
    type: PipelineStreamEventType,
    run: PipelineRunRecord,
    payload: Record<string, unknown>,
  ): void {
    this.deps.hub.publish({
      id: `pevt_${randomUUID()}`,
      type,
      projectId: run.projectId,
      pipelineId: run.pipelineId,
      pipelineVersion: run.pipelineVersion,
      runId: run.runId,
      nodeId: run.currentNodeId,
      status: run.status,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  private async notifyStatus(run: PipelineRunRecord): Promise<void> {
    const def = this.definitions.get(run.pipelineId);
    if (!def?.notifyOn.includes(run.status)) return;
    const detail = run.statusSummary ? `: ${run.statusSummary}` : "";
    const text =
      run.status === "completed"
        ? `Pipeline "${def.name}" completed: ${run.title}`
        : run.status === "cancelled"
          ? `Pipeline run "${run.title}" was cancelled${detail}`
          : `Pipeline "${def.name}" is ${run.status} at "${run.currentNodeId}"${detail}`;
    try {
      await this.deps.notifications.queue(
        run.projectId,
        undefined,
        this.deps.project.notifications,
        {
          title: `[Pipeline: ${def.name}] ${run.title}`,
          text,
          level:
            run.status === "failed" ? "error" : run.status === "completed" ? "success" : "info",
          metadata: {
            projectId: run.projectId,
            pipelineId: run.pipelineId,
            runId: run.runId,
            nodeId: run.currentNodeId,
            status: run.status,
          },
        },
      );
    } catch (error) {
      this.deps.logger.warn("failed to enqueue pipeline notification", {
        projectId: run.projectId,
        runId: run.runId,
        error: (error as Error).message,
      });
    }
  }
}

/**
 * Whether the scheduler has something new to look at: queued work appeared, a node left `running`
 * and freed its slot, or a poll time changed. Starting a node, registering a flow action or
 * sending a reminder does none of that.
 */
function changesSchedule(transition: PipelineTransition): boolean {
  const status = transition.nodeRunPatch?.status;
  return transition.newNodeRun !== undefined || (status !== undefined && status !== "running");
}

function runEventType(run: PipelineRunRecord): PipelineStreamEventType {
  if (run.status === "completed") return "pipeline.run.completed";
  if (run.status === "cancelled") return "pipeline.run.cancelled";
  return "pipeline.run.updated";
}

/** Stamps a new node run with the active trace, so launching it can link back to its cause. */
function withTraceparent(nodeRun: NewPipelineNodeRun): NewPipelineNodeRun {
  const traceparent = activeTraceparent();
  return traceparent ? { ...nodeRun, traceparent } : nodeRun;
}
