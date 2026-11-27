import type { z } from "zod";
import type { ProjectContext } from "../context/types.ts";
import type { PipelineOrigin } from "../domain/origin.ts";
import type { ReasoningEffort, TaskExecutionLogLevel } from "../domain/types.ts";

export type PipelineInputSchema = z.ZodObject<z.ZodRawShape>;

export type InferNodeData<TInput> = TInput extends z.ZodObject<z.ZodRawShape>
  ? Readonly<z.infer<TInput>>
  : Readonly<Record<string, never>>;

export type PipelineNodeExecutorType = "agent" | "ts" | "human" | "terminal";
export type PipelineNodeGate = "auto" | "manual";

export type PipelineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "waiting_confirmation"
  | "failed"
  | "completed"
  | "cancelled";

export type PipelineNodeRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "waiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

/** A run that has not been completed or cancelled. A failed run is still active: it can be retried. */
export function isActivePipelineRunStatus(status: PipelineRunStatus): boolean {
  return status !== "completed" && status !== "cancelled";
}

export type PipelineWorkspaceStatus = "none" | "active" | "cleaned";

export type PipelineActionName =
  | "pipeline_next"
  | "pipeline_prev"
  | "pipeline_request_confirmation"
  | "pipeline_fail"
  | "human_approve"
  | "human_reject"
  | "human_retry"
  | "human_cancel"
  | "system_fallback"
  | "system_loop_breaker";

export type PipelineActorType = "agent" | "ts" | "human" | "system";

export interface PipelineNodeRuntimeConfig {
  readonly type?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

export interface PipelineNodeConfig {
  readonly id: string;
  readonly name: string;
  readonly executor: PipelineNodeExecutorType;
  readonly terminal: boolean;
  readonly description?: string | undefined;
  readonly promptPath?: string | undefined;
  readonly promptTemplate?: string | undefined;
  /** Executable handler for `ts` (`node.code`) nodes, bound directly from the TS definition. */
  readonly handler?: PipelineTsHandler<Record<string, unknown>> | undefined;
  /** Explicit Zod input contract declared by this node. Absent means `data` is always `{}`. */
  readonly inputSchema?: PipelineInputSchema | undefined;
  /** Standard JSON Schema representation of `inputSchema` (included in topology snapshots). */
  readonly inputJsonSchema?: Record<string, unknown> | undefined;
  readonly runtime?: PipelineNodeRuntimeConfig | undefined;
  readonly concurrency: number;
  readonly gate: PipelineNodeGate;
  readonly allowPrev: boolean;
  readonly prevTargets: readonly string[];
  readonly maxLoops: number;
  readonly timeoutMs?: number | undefined;
}

export interface PipelineDefinition {
  readonly projectId: string;
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly enabled: boolean;
  readonly notifyOn: readonly PipelineRunStatus[];
  readonly nodes: readonly PipelineNodeConfig[];
  readonly filePath: string;
  readonly topologyHash: string;
}

/**
 * The part of a node that a PipelineRun is bound to for its whole life. Every field here takes
 * part in the topology hash, so editing any of them creates a new revision instead of silently
 * changing the rules of runs already in flight. Prompts, handlers, input schemas, runtimes and
 * concurrency are read from the live definition instead.
 */
export interface PipelineNodeSnapshot {
  readonly id: string;
  readonly name: string;
  readonly executor: PipelineNodeExecutorType;
  readonly terminal: boolean;
  readonly gate: PipelineNodeGate;
  readonly allowPrev: boolean;
  readonly prevTargets: readonly string[];
  readonly maxLoops: number;
}

export interface PipelineRevisionRecord {
  readonly id?: number | undefined;
  readonly projectId: string;
  readonly pipelineId: string;
  readonly version: number;
  readonly topologyHash: string;
  readonly nodesSnapshot: readonly PipelineNodeSnapshot[];
  readonly createdAt: string;
}

export interface PipelineNodeOutputSummary {
  readonly nodeId: string;
  readonly attempt: number;
  readonly recordId: string;
  readonly action: PipelineActionName;
  readonly summary: string;
  readonly createdAt: string;
}

export interface PipelineRunRecord {
  readonly id?: number | undefined;
  readonly runId: string;
  readonly projectId: string;
  readonly pipelineId: string;
  readonly pipelineVersion: number;
  readonly externalKey?: string | undefined;
  readonly externalUrl?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  /** Validated entry `data` bound to the pipeline's first node (`{}` if first node declares no input). */
  readonly data: Record<string, unknown>;
  /** Free-form arbitrary run-level metadata passed at start time. */
  readonly metadata: Record<string, unknown>;
  readonly currentNodeId: string;
  readonly status: PipelineRunStatus;
  readonly workspacePath?: string | undefined;
  readonly branchName?: string | undefined;
  readonly workspaceStatus: PipelineWorkspaceStatus;
  readonly loopCounts: Record<string, number>;
  readonly statusSummary?: string | undefined;
  readonly activeNodeRunId?: string | undefined;
  readonly latestNodeOutputs: Record<string, PipelineNodeOutputSummary>;
  readonly createdBy: string;
  /** Incremented by every state transition; transitions commit only against the version they read. */
  readonly stateVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string | undefined;
}

export interface PipelineWaitStateEntry {
  readonly status: "waiting" | "done";
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly value?: unknown;
  readonly summary?: string | undefined;
}

/**
 * A completed `ctx.step`. The value is wrapped so that a step returning `undefined` is still
 * recorded as done after a JSON round trip, which drops `undefined` properties.
 */
export interface PipelineStepCacheEntry {
  readonly value?: unknown;
}

export interface PipelineStepState {
  readonly steps?: Record<string, PipelineStepCacheEntry> | undefined;
  readonly waits?: Record<string, PipelineWaitStateEntry> | undefined;
}

export type PipelineFlowActionName =
  | "pipeline_next"
  | "pipeline_prev"
  | "pipeline_request_confirmation"
  | "pipeline_fail";

/** A flow action an agent called during a turn; it takes effect when that turn finishes. */
export interface PipelineAgentDecision {
  readonly action: PipelineFlowActionName;
  readonly context: PipelineActionContextPayload;
  readonly turnId?: string | undefined;
}

export interface PipelineNodeRunRecord {
  readonly id?: number | undefined;
  readonly nodeRunId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly pipelineId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly executorType: PipelineNodeExecutorType;
  readonly sessionId?: string | undefined;
  readonly triggeredByRecordId?: string | undefined;
  /** W3C `traceparent` of the operation that created this node run; its launches link to it. */
  readonly traceparent?: string | undefined;
  readonly status: PipelineNodeRunStatus;
  /** Validated strong-typed `data` for this node attempt (`{}` if node declares no input). */
  readonly inputContext: Record<string, unknown>;
  readonly finalAction?: PipelineActionName | undefined;
  readonly outputSummary?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly stepState: PipelineStepState;
  readonly nextPollAt?: string | undefined;
  readonly pollCount: number;
  /** The turn the engine itself started on the node's session (the node prompt or the reminder). */
  readonly agentTurnId?: string | undefined;
  /** Whether the agent was already reminded once to call a flow action. */
  readonly reminderSent: boolean;
  /** The flow action registered during the current turn, applied when the turn finishes. */
  readonly pendingDecision?: PipelineAgentDecision | undefined;
  readonly startedAt?: string | undefined;
  readonly finishedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PipelineActionContextPayload {
  readonly summary?: string | undefined;
  readonly content?: string | undefined;
  readonly reason?: string | undefined;
  readonly feedback?: string | undefined;
  readonly question?: string | undefined;
  readonly options?: readonly string[] | undefined;
  readonly targetNodeId?: string | undefined;
  readonly artifacts?: readonly string[] | undefined;
  /** Structured strong-typed handoff data for the target node's declared `input` schema. */
  readonly data?: Record<string, unknown> | undefined;
  /** Free-form arbitrary metadata passed alongside this action (never schema-restricted). */
  readonly metadata?: Record<string, unknown> | undefined;
  readonly humanNote?: string | undefined;
}

export interface PipelineActionRecord {
  readonly id?: number | undefined;
  readonly recordId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly nodeRunId?: string | undefined;
  readonly nodeId: string;
  readonly attempt: number;
  readonly action: PipelineActionName;
  readonly actorType: PipelineActorType;
  readonly actorId?: string | undefined;
  readonly fromNodeId: string;
  readonly toNodeId?: string | undefined;
  readonly fromStatus: PipelineRunStatus;
  readonly toStatus: PipelineRunStatus;
  readonly context: PipelineActionContextPayload;
  readonly result: Record<string, unknown>;
  readonly createdAt: string;
}

export interface PipelineNodeLogRecord {
  readonly id?: number | undefined;
  readonly nodeRunId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly level: TaskExecutionLogLevel;
  readonly message: string;
  readonly fields?: Record<string, unknown> | undefined;
  readonly createdAt: string;
}

// =====================================================================
// Query Filters & Patches
// =====================================================================

export interface ListPipelineRunsFilter {
  readonly projectId?: string | undefined;
  readonly pipelineId?: string | undefined;
  readonly version?: number | undefined;
  readonly nodeId?: string | undefined;
  readonly status?: PipelineRunStatus | undefined;
  readonly beforeId?: number | undefined;
  readonly limit?: number | undefined;
}

export interface ListPipelineActionsFilter {
  readonly afterSequence?: number | undefined;
  readonly nodeId?: string | undefined;
  readonly action?: PipelineActionName | undefined;
  readonly limit?: number | undefined;
}

export interface ListPipelineNodeLogsFilter {
  readonly afterSequence?: number | undefined;
  readonly level?: TaskExecutionLogLevel | undefined;
  readonly limit?: number | undefined;
}

export interface PipelineVersionRunCounts {
  readonly version: number;
  readonly activeRunCount: number;
  readonly totalRunCount: number;
}

/** Fields of a run that change only through a state transition. */
export type PipelineRunStatePatch = Partial<
  Pick<
    PipelineRunRecord,
    | "currentNodeId"
    | "status"
    | "loopCounts"
    | "statusSummary"
    | "activeNodeRunId"
    | "latestNodeOutputs"
    | "finishedAt"
  >
> & {
  readonly clearStatusSummary?: boolean | undefined;
};

/** Bookkeeping fields of a run that effects record after a transition, outside the state machine. */
export type PipelineRunWorkspacePatch = Partial<
  Pick<PipelineRunRecord, "workspacePath" | "branchName" | "workspaceStatus">
>;

export type PipelineNodeRunPatch = Partial<
  Pick<
    PipelineNodeRunRecord,
    | "sessionId"
    | "status"
    | "finalAction"
    | "outputSummary"
    | "errorMessage"
    | "stepState"
    | "nextPollAt"
    | "pollCount"
    | "agentTurnId"
    | "reminderSent"
    | "pendingDecision"
    | "startedAt"
    | "finishedAt"
    | "durationMs"
  >
> & {
  readonly clearNextPollAt?: boolean | undefined;
  readonly clearPendingDecision?: boolean | undefined;
};

export type NewPipelineNodeRun = Omit<PipelineNodeRunRecord, "id" | "attempt" | "sequence">;
export type NewPipelineActionRecord = Omit<PipelineActionRecord, "id" | "sequence">;

/**
 * Everything one state transition writes. The store applies it atomically and only when the run
 * is still at `expectedStateVersion`; it assigns the action record's sequence and the new node
 * run's sequence and attempt itself.
 */
export interface PipelineTransitionWrite {
  readonly runId: string;
  readonly expectedStateVersion: number;
  readonly runPatch: PipelineRunStatePatch;
  readonly nodeRunPatch?: { readonly nodeRunId: string; readonly patch: PipelineNodeRunPatch };
  readonly newNodeRun?: NewPipelineNodeRun | undefined;
  readonly record?: NewPipelineActionRecord | undefined;
  /** Commit only while fewer than `limit` node runs of this node are running. */
  readonly capacity?:
    | {
        readonly projectId: string;
        readonly pipelineId: string;
        readonly nodeId: string;
        readonly limit: number;
      }
    | undefined;
}

export type PipelineTransitionResult =
  | {
      readonly status: "committed";
      readonly run: PipelineRunRecord;
      readonly record?: PipelineActionRecord | undefined;
    }
  | { readonly status: "conflict" }
  | { readonly status: "no_capacity" };

// =====================================================================
// Code (`node.code`) Pipeline Handler SDK Types
// =====================================================================

export interface PipelineWaitUntilOptions {
  readonly intervalMs: number;
  readonly timeoutMs?: number | undefined;
  readonly summary?: string | undefined;
}

export interface PipelineHistoryEntrySummary {
  readonly recordId: string;
  readonly sequence: number;
  readonly nodeId: string;
  readonly attempt: number;
  readonly action: PipelineActionName;
  readonly actorType: PipelineActorType;
  readonly fromNodeId: string;
  readonly toNodeId?: string | undefined;
  readonly summary?: string | undefined;
  readonly reason?: string | undefined;
  readonly createdAt: string;
}

export interface PipelineReworkInfo {
  readonly fromNodeId: string;
  readonly reason: string;
  readonly feedback: string;
}

export interface PipelineHistoryFilter {
  readonly nodeId?: string | undefined;
  readonly action?: PipelineActionName | undefined;
}

export interface PipelineGlobalContextView {
  readonly runId: string;
  readonly projectId: string;
  readonly pipelineId: string;
  readonly pipelineVersion: number;
  readonly title: string;
  readonly description?: string | undefined;
  readonly externalKey?: string | undefined;
  readonly externalUrl?: string | undefined;
  readonly data: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly branchName?: string | undefined;
  readonly workspacePath?: string | undefined;
  readonly currentNodeId: string;
  readonly currentAttempt: number;
  readonly status: PipelineRunStatus;
  readonly nodes: readonly PipelineNodeSnapshot[];
  readonly upstreamContext?: PipelineActionRecord | undefined;
  readonly latestNodeOutputs: Record<string, PipelineNodeOutputSummary>;
}

export type PipelineTsResult =
  | {
      readonly action: "next";
      readonly summary: string;
      readonly content: string;
      readonly artifacts?: readonly string[] | undefined;
      readonly data?: Record<string, unknown> | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    }
  | {
      readonly action: "prev";
      readonly reason: string;
      readonly feedback: string;
      readonly targetNodeId?: string | undefined;
      readonly data?: Record<string, unknown> | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    }
  | {
      readonly action: "request_confirmation";
      readonly summary: string;
      readonly question: string;
      readonly options?: readonly string[] | undefined;
      readonly content?: string | undefined;
      readonly artifacts?: readonly string[] | undefined;
      readonly data?: Record<string, unknown> | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    }
  | {
      readonly action: "fail";
      readonly reason: string;
      readonly summary?: string | undefined;
      readonly data?: Record<string, unknown> | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    };

/**
 * What a pipeline code node's handler receives: the project context acting as this node run, the
 * node's typed input, and durable steps and waits that survive suspension and restarts.
 */
export interface NodeContext<TData = Readonly<Record<string, unknown>>> extends ProjectContext {
  readonly origin: PipelineOrigin;
  readonly run: {
    readonly id: string;
    readonly pipelineId: string;
    readonly branchName?: string | undefined;
  };
  readonly node: {
    readonly id: string;
    readonly runId: string;
    readonly attempt: number;
  };
  /** Validated strong-typed `data` for this node (strictly `{}` if no `input` schema declared). */
  readonly data: TData;
  /** Free-form metadata passed into this node (from upstream handoff or initial run metadata). */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Present when this attempt was triggered by an upstream rejection/rework. */
  readonly rework?: PipelineReworkInfo | undefined;
  /** The run's Git worktree. */
  readonly workspace: string;

  /** Durable step cache: runs `fn` once, persists result in `stepState.steps[key]`, returns cached value on replay. */
  step<T>(key: string, fn: () => Promise<T> | T): Promise<T>;

  /**
   * Durable asynchronous wait: returns cached value once completed; otherwise runs `check()`.
   * Returning `false` suspends the node (`status = "waiting"`), releases concurrency slot, and schedules wakeup.
   * Returning `true` or any non-false truthy value persists and continues linearly.
   */
  waitUntil<T = true>(
    key: string,
    options: PipelineWaitUntilOptions,
    check: () => Promise<T | false> | T | false,
  ): Promise<T>;

  /** What happened in this run so far. Reads only. */
  readonly history: {
    /** Global pipeline overview, upstream handoff and latest node summaries. */
    context(): Promise<PipelineGlobalContextView>;
    /** Historical action records for this run. */
    list(filter?: PipelineHistoryFilter): Promise<readonly PipelineHistoryEntrySummary[]>;
    /** Complete saved context and engine result for one historical record. */
    get(query: {
      readonly recordId?: string | undefined;
      readonly sequence?: number | undefined;
      readonly nodeId?: string | undefined;
      readonly attempt?: number | undefined;
    }): Promise<PipelineActionRecord | null>;
  };
}

export type PipelineTsHandler<TData = Readonly<Record<string, unknown>>> = (
  ctx: NodeContext<TData>,
) => Promise<PipelineTsResult> | PipelineTsResult;

// =====================================================================
// Start / Human Operation Inputs & SSE Stream Events
// =====================================================================

export interface StartPipelineRunParams {
  readonly pipelineId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly externalKey?: string | undefined;
  readonly externalUrl?: string | undefined;
  /** Structured entry `data` validated against the first node's declared `input` schema. */
  readonly data?: Record<string, unknown> | undefined;
  /** Free-form arbitrary run-level metadata (not schema-restricted). */
  readonly metadata?: Record<string, unknown> | undefined;
  readonly createdBy?: string | undefined;
}

export interface StartPipelineRunResult {
  readonly created: boolean;
  readonly run: PipelineRunRecord;
}

export type PipelineStreamEventType =
  | "pipeline.run.created"
  | "pipeline.run.updated"
  | "pipeline.node.updated"
  | "pipeline.action.recorded"
  | "pipeline.run.completed"
  | "pipeline.run.cancelled";

export interface PipelineStreamEvent {
  readonly id: string;
  readonly type: PipelineStreamEventType;
  readonly projectId: string;
  readonly pipelineId: string;
  readonly pipelineVersion: number;
  readonly runId: string;
  readonly nodeId: string;
  readonly status: PipelineRunStatus;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface PipelineSummaryWithVersions {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly enabled: boolean;
  readonly currentVersion: number;
  readonly currentTopologyHash: string;
  readonly nodes: readonly PipelineNodeSnapshot[];
  /** Live JSON Schema of the entry node's declared `input` contract, if any. */
  readonly entryInputSchema?: Record<string, unknown> | undefined;
  readonly notifyOn: readonly PipelineRunStatus[];
  readonly activeVersions: readonly {
    readonly version: number;
    readonly activeRunCount: number;
    readonly totalRunCount: number;
    readonly nodes: readonly PipelineNodeSnapshot[];
  }[];
}
