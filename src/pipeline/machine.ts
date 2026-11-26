import { PipelineConflictError, PipelineValidationError } from "./errors.ts";
import {
  isActivePipelineRunStatus,
  type NewPipelineActionRecord,
  type NewPipelineNodeRun,
  type PipelineActionContextPayload,
  type PipelineActionName,
  type PipelineActorType,
  type PipelineAgentDecision,
  type PipelineFlowActionName,
  type PipelineNodeRunPatch,
  type PipelineNodeRunRecord,
  type PipelineNodeRunStatus,
  type PipelineNodeSnapshot,
  type PipelineRunRecord,
  type PipelineRunStatePatch,
  type PipelineRunStatus,
  type PipelineStepState,
  type PipelineTsResult,
} from "./types.ts";

/**
 * The pipeline state machine: given a run, its active node run and the revision the run is bound
 * to, it decides what a command changes. It does no IO. The engine stores the returned write in
 * one transaction and then carries out the returned effects.
 */

export interface PipelineMachineState {
  readonly run: PipelineRunRecord;
  /** The run's active node run. */
  readonly nodeRun: PipelineNodeRunRecord;
  /** The nodes of the revision the run is bound to. */
  readonly nodes: readonly PipelineNodeSnapshot[];
}

/** Values a transition needs from outside, passed in so that `decide` stays deterministic. */
export interface PipelineMachineEnv {
  readonly now: string;
  readonly newRecordId: string;
  readonly newNodeRunId: string;
}

export type PipelineCommand =
  /** The scheduler starts a queued node. */
  | { readonly kind: "claim" }
  /** A TS node's `waitUntil` condition is not met yet. */
  | {
      readonly kind: "suspend";
      readonly nextPollAt: string;
      readonly summary?: string | undefined;
      readonly stepState: PipelineStepState;
    }
  /** A waiting TS node is due for another poll, or was signalled. */
  | { readonly kind: "wake"; readonly reason: "poll_due" | "signal" }
  /** An agent called a flow action; it is kept until the turn finishes. */
  | { readonly kind: "register_decision"; readonly decision: PipelineAgentDecision }
  /** A turn on the node's session finished. */
  | {
      readonly kind: "turn_finished";
      readonly turnId: string;
      readonly status: "completed" | "failed" | "interrupted";
      readonly output?: string | undefined;
      readonly error?: string | undefined;
    }
  /** A TS handler returned a flow result. */
  | { readonly kind: "ts_result"; readonly result: PipelineTsResult }
  /** The node's executor failed outside the agent's or handler's own decision. */
  | { readonly kind: "fail"; readonly actorType: "system" | "ts"; readonly reason: string }
  | {
      readonly kind: "approve";
      /** What the approved node hands to the next one. */
      readonly handoff: PipelineActionContextPayload;
      readonly humanNote?: string | undefined;
      readonly actorId?: string | undefined;
    }
  | {
      readonly kind: "reject";
      readonly reason: string;
      readonly feedback: string;
      readonly targetNodeId?: string | undefined;
      readonly actorId?: string | undefined;
    }
  | {
      readonly kind: "retry";
      readonly preserveStepState: boolean;
      readonly actorId?: string | undefined;
    }
  | { readonly kind: "cancel"; readonly reason: string; readonly actorId?: string | undefined }
  /** The service restarted while the node was running. */
  | { readonly kind: "recover_after_restart" };

export type PipelineEffect =
  /** Prepare the workspace and start the claimed node's agent session or TS handler. */
  | { readonly kind: "launch_node" }
  /** Ask the agent, once, to call a flow action it forgot. */
  | { readonly kind: "send_reminder"; readonly sessionId: string }
  /** Abort a running TS handler or interrupt the node's agent turn. */
  | { readonly kind: "stop_node"; readonly nodeRunId: string; readonly sessionId?: string }
  /** Make a finished node's session read-only. The shared workspace stays. */
  | { readonly kind: "archive_session"; readonly sessionId: string }
  /** Remove the run's shared workspace. */
  | { readonly kind: "remove_workspace" };

export interface PipelineTransition {
  readonly runPatch: PipelineRunStatePatch;
  readonly nodeRunPatch?: PipelineNodeRunPatch | undefined;
  readonly newNodeRun?: NewPipelineNodeRun | undefined;
  readonly record?: NewPipelineActionRecord | undefined;
  readonly effects: readonly PipelineEffect[];
}

export const RUNTIME_RESTARTED = "runtime_restarted";

/** Decides a command. Returns null when it changes nothing; throws when the state forbids it. */
export function decide(
  state: PipelineMachineState,
  command: PipelineCommand,
  env: PipelineMachineEnv,
): PipelineTransition | null {
  const { run, nodeRun } = state;
  switch (command.kind) {
    case "claim":
      requireNodeStatus(nodeRun, ["queued"], "start");
      return {
        runPatch: { status: "running", clearStatusSummary: true },
        nodeRunPatch: { status: "running", startedAt: nodeRun.startedAt ?? env.now },
        effects: [{ kind: "launch_node" }],
      };

    case "suspend":
      requireNodeStatus(nodeRun, ["running"], "suspend");
      return {
        runPatch: {
          status: "waiting",
          statusSummary: command.summary ?? `Waiting until ${command.nextPollAt}`,
        },
        nodeRunPatch: {
          status: "waiting",
          nextPollAt: command.nextPollAt,
          pollCount: nodeRun.pollCount + 1,
          stepState: command.stepState,
        },
        effects: [],
      };

    case "wake":
      requireNodeStatus(nodeRun, ["waiting"], "wake");
      return {
        runPatch: { status: "queued", clearStatusSummary: true },
        nodeRunPatch: { status: "queued", clearNextPollAt: true },
        effects: [],
      };

    case "register_decision": {
      requireNodeStatus(nodeRun, ["running", "waiting_confirmation"], "accept a flow action on");
      if (nodeRun.pendingDecision) {
        throw new PipelineConflictError(
          `A flow transition action (${nodeRun.pendingDecision.action}) has already been registered for this turn. Complete your response without calling another flow action.`,
        );
      }
      validateFlowAction(state, command.decision.action, command.decision.context);
      return {
        runPatch: {},
        nodeRunPatch: { pendingDecision: command.decision },
        effects: [],
      };
    }

    case "turn_finished":
      return decideTurnFinished(state, command, env);

    case "ts_result": {
      requireNodeStatus(nodeRun, ["running"], "apply a TS result to");
      const decision = tsResultToDecision(command.result);
      return applyFlowAction(state, "ts", decision.action, decision.context, env);
    }

    case "fail":
      requireNodeStatus(nodeRun, ["running"], "fail");
      return failNode(state, command.actorType, command.reason, env);

    case "approve": {
      requireRunStatus(run, "waiting_confirmation", "approve");
      const context: PipelineActionContextPayload = {
        ...command.handoff,
        summary:
          command.handoff.summary ||
          nodeRun.outputSummary ||
          `Approved at node "${currentNode(state).node.name}"`,
        ...(command.humanNote?.trim() ? { humanNote: command.humanNote.trim() } : {}),
      };
      return advance(state, "human_approve", "human", context, env, command.actorId);
    }

    case "reject": {
      requireRunStatus(run, "waiting_confirmation", "reject");
      const target = resolvePrevTarget(state, command.targetNodeId);
      const context: PipelineActionContextPayload = {
        reason: command.reason,
        feedback: command.feedback,
        targetNodeId: target.id,
        humanNote: command.feedback,
      };
      // A person's decision to send work back is never stopped by the loop breaker.
      return routeBack(state, target, "human_reject", "human", context, env, command.actorId);
    }

    case "retry":
      requireRunStatus(run, "failed", "retry");
      return retry(state, command.preserveStepState, env, command.actorId);

    case "cancel":
      if (!isActivePipelineRunStatus(run.status)) {
        throw new PipelineConflictError(`pipeline run ${run.runId} is already ${run.status}`);
      }
      return cancel(state, command.reason, env, command.actorId);

    case "recover_after_restart":
      if (nodeRun.status !== "running") return null;
      // Whatever the node was doing may or may not have reached the outside world (a TS step can
      // finish its side effect before its result is saved), so a person decides whether to retry.
      return failNode(state, "system", RUNTIME_RESTARTED, env);
  }
}

/** Initial records of a new run: the first node is entered right away. */
export function planNewRun(params: {
  readonly run: Omit<
    PipelineRunRecord,
    | "currentNodeId"
    | "status"
    | "activeNodeRunId"
    | "statusSummary"
    | "workspaceStatus"
    | "loopCounts"
    | "latestNodeOutputs"
    | "stateVersion"
  >;
  readonly firstNode: PipelineNodeSnapshot;
  readonly nodeRunId: string;
}): { readonly run: PipelineRunRecord; readonly firstNodeRun: NewPipelineNodeRun } {
  const { run, firstNode, nodeRunId } = params;
  const entered = enterNode(
    { runId: run.runId, projectId: run.projectId, pipelineId: run.pipelineId },
    firstNode,
    nodeRunId,
    { inputContext: { initialInput: run.input } },
    run.createdAt,
  );
  return {
    run: {
      ...run,
      currentNodeId: firstNode.id,
      status: entered.runStatus,
      ...(entered.statusSummary ? { statusSummary: entered.statusSummary } : {}),
      activeNodeRunId: nodeRunId,
      workspaceStatus: "none",
      loopCounts: {},
      latestNodeOutputs: {},
      stateVersion: 0,
    },
    firstNodeRun: entered.nodeRun,
  };
}

function decideTurnFinished(
  state: PipelineMachineState,
  command: Extract<PipelineCommand, { kind: "turn_finished" }>,
  env: PipelineMachineEnv,
): PipelineTransition | null {
  const { nodeRun } = state;
  if (nodeRun.status !== "running" && nodeRun.status !== "waiting_confirmation") return null;

  const pending = nodeRun.pendingDecision;
  const decision =
    pending && (!pending.turnId || pending.turnId === command.turnId) ? pending : undefined;
  if (command.status === "completed" && decision) {
    return applyFlowAction(state, "agent", decision.action, decision.context, env);
  }

  // Only the turns the engine started drive the node. A person's follow-up chat changes nothing,
  // except that a flow action registered in a turn that did not complete is dropped.
  const isAgentTurn = command.turnId === nodeRun.agentTurnId;
  if (nodeRun.status !== "running" || !isAgentTurn) {
    return decision
      ? { runPatch: {}, nodeRunPatch: { clearPendingDecision: true }, effects: [] }
      : null;
  }

  if (command.status === "failed") {
    return failNode(state, "system", command.error ?? "Agent turn failed", env);
  }
  if (command.status === "interrupted") {
    return {
      runPatch: {
        status: "waiting_confirmation",
        statusSummary: "Turn interrupted; awaiting user input or action",
      },
      nodeRunPatch: { status: "waiting_confirmation", clearPendingDecision: true },
      effects: [],
    };
  }
  if (!nodeRun.reminderSent && nodeRun.sessionId) {
    return {
      runPatch: {},
      nodeRunPatch: { reminderSent: true },
      effects: [{ kind: "send_reminder", sessionId: nodeRun.sessionId }],
    };
  }
  const summary =
    command.output?.trim().slice(0, 400) || "Agent finished without invoking a pipeline action.";
  return park(
    state,
    "system_fallback",
    "system",
    {
      summary,
      ...(command.output ? { content: command.output } : {}),
      reason: "missing_pipeline_action",
    },
    "Agent did not invoke a pipeline action; awaiting manual confirmation",
    env,
  );
}

function tsResultToDecision(result: PipelineTsResult): {
  action: PipelineFlowActionName;
  context: PipelineActionContextPayload;
} {
  const data = result.data ? { data: result.data } : {};
  switch (result.action) {
    case "next":
      return {
        action: "pipeline_next",
        context: {
          summary: result.summary.trim(),
          content: result.content.trim(),
          ...(result.artifacts ? { artifacts: result.artifacts } : {}),
          ...data,
        },
      };
    case "prev":
      return {
        action: "pipeline_prev",
        context: {
          reason: result.reason.trim(),
          feedback: result.feedback.trim(),
          ...(result.targetNodeId ? { targetNodeId: result.targetNodeId } : {}),
          ...data,
        },
      };
    case "request_confirmation":
      return {
        action: "pipeline_request_confirmation",
        context: {
          summary: result.summary.trim(),
          question: result.question.trim(),
          ...(result.options ? { options: result.options } : {}),
          ...(result.content !== undefined ? { content: result.content } : {}),
          ...(result.artifacts ? { artifacts: result.artifacts } : {}),
          ...data,
        },
      };
    case "fail":
      return {
        action: "pipeline_fail",
        context: {
          reason: result.reason.trim(),
          ...(result.summary !== undefined ? { summary: result.summary } : {}),
          ...data,
        },
      };
  }
}

/** Checks what can be checked before the flow action is applied, so a model can correct itself. */
function validateFlowAction(
  state: PipelineMachineState,
  action: PipelineFlowActionName,
  context: PipelineActionContextPayload,
): void {
  if (action === "pipeline_next") {
    const { node, index } = currentNode(state);
    if (node.terminal || index >= state.nodes.length - 1) {
      throw new PipelineValidationError(`node "${node.id}" has no next node`);
    }
  } else if (action === "pipeline_prev") {
    resolvePrevTarget(state, context.targetNodeId);
  }
}

function applyFlowAction(
  state: PipelineMachineState,
  actorType: "agent" | "ts",
  action: PipelineFlowActionName,
  context: PipelineActionContextPayload,
  env: PipelineMachineEnv,
): PipelineTransition {
  validateFlowAction(state, action, context);
  const { node } = currentNode(state);
  switch (action) {
    case "pipeline_next":
      if (node.gate === "manual") {
        return park(
          state,
          action,
          actorType,
          context,
          context.summary ?? `Ready for manual confirmation at "${node.name}"`,
          env,
        );
      }
      return advance(state, action, actorType, context, env);
    case "pipeline_prev": {
      const target = resolvePrevTarget(state, context.targetNodeId);
      return routeBack(
        state,
        target,
        action,
        actorType,
        { ...context, targetNodeId: target.id },
        env,
      );
    }
    case "pipeline_request_confirmation":
      return park(
        state,
        action,
        actorType,
        context,
        context.question ?? context.summary ?? `Awaiting human input at "${node.name}"`,
        env,
      );
    case "pipeline_fail":
      return failNode(state, actorType, context.reason ?? "Node declared failure", env, context);
  }
}

function advance(
  state: PipelineMachineState,
  action: PipelineActionName,
  actorType: PipelineActorType,
  context: PipelineActionContextPayload,
  env: PipelineMachineEnv,
  actorId?: string,
): PipelineTransition {
  const { run, nodeRun } = state;
  const { node, index } = currentNode(state);
  const nextNode = state.nodes[index + 1];
  if (node.terminal || !nextNode) {
    throw new PipelineConflictError(`node "${node.id}" has no next node`);
  }

  const entered = enterNode(
    run,
    nextNode,
    env.newNodeRunId,
    {
      triggeredByRecordId: env.newRecordId,
      inputContext: {
        handoffFrom: node.id,
        handoffRecordId: env.newRecordId,
        handoffAction: action,
        context,
      },
    },
    env.now,
  );
  const summary = context.summary ?? nodeRun.outputSummary ?? `Completed ${node.name}`;
  return {
    runPatch: {
      currentNodeId: nextNode.id,
      status: entered.runStatus,
      activeNodeRunId: env.newNodeRunId,
      latestNodeOutputs: withNodeOutput(state, action, summary, env),
      ...(entered.statusSummary
        ? { statusSummary: entered.statusSummary }
        : { clearStatusSummary: true }),
      ...(entered.runStatus === "completed" ? { finishedAt: env.now } : {}),
    },
    nodeRunPatch: finishNodeRun(nodeRun, "completed", action, summary, env),
    newNodeRun: entered.nodeRun,
    record: actionRecord(state, env, {
      action,
      actorType,
      actorId,
      toNodeId: nextNode.id,
      toStatus: entered.runStatus,
      context,
      result: { nextNodeId: nextNode.id, terminal: nextNode.terminal },
    }),
    effects: [
      ...archiveSession(nodeRun),
      ...(entered.runStatus === "completed" ? [{ kind: "remove_workspace" } as const] : []),
    ],
  };
}

function routeBack(
  state: PipelineMachineState,
  target: PipelineNodeSnapshot,
  action: PipelineActionName,
  actorType: PipelineActorType,
  context: PipelineActionContextPayload,
  env: PipelineMachineEnv,
  actorId?: string,
): PipelineTransition {
  const { run, nodeRun } = state;
  const { node } = currentNode(state);
  const edge = `${node.id}->${target.id}`;
  const loopCount = (run.loopCounts[edge] ?? 0) + 1;
  const loopCounts = { ...run.loopCounts, [edge]: loopCount };

  // Only agents and handlers are stopped from bouncing work back and forth forever.
  if (actorType !== "human" && loopCount >= node.maxLoops) {
    const transition = park(
      state,
      "system_loop_breaker",
      "system",
      { ...context, summary: `Loop breaker tripped on ${edge} (${loopCount}/${node.maxLoops})` },
      `Loop limit reached (${edge}: ${loopCount}/${node.maxLoops}); awaiting human decision`,
      env,
    );
    return { ...transition, runPatch: { ...transition.runPatch, loopCounts } };
  }

  const entered = enterNode(
    run,
    target,
    env.newNodeRunId,
    {
      triggeredByRecordId: env.newRecordId,
      inputContext: {
        handoffFrom: node.id,
        handoffRecordId: env.newRecordId,
        handoffAction: action,
        isRejection: true,
        context,
      },
    },
    env.now,
  );
  const summary = context.reason ?? context.summary ?? `Returned to ${target.name}`;
  return {
    runPatch: {
      currentNodeId: target.id,
      status: entered.runStatus,
      activeNodeRunId: env.newNodeRunId,
      loopCounts,
      latestNodeOutputs: withNodeOutput(state, action, summary, env),
      ...(entered.statusSummary
        ? { statusSummary: entered.statusSummary }
        : { clearStatusSummary: true }),
    },
    nodeRunPatch: finishNodeRun(nodeRun, "completed", action, summary, env),
    newNodeRun: entered.nodeRun,
    record: actionRecord(state, env, {
      action,
      actorType,
      actorId,
      toNodeId: target.id,
      toStatus: entered.runStatus,
      context,
      result: { targetNodeId: target.id, loopCount },
    }),
    effects: archiveSession(nodeRun),
  };
}

/** Keeps the node and its session, waiting for a person to approve, reject or chat. */
function park(
  state: PipelineMachineState,
  action: PipelineActionName,
  actorType: PipelineActorType,
  context: PipelineActionContextPayload,
  statusSummary: string,
  env: PipelineMachineEnv,
): PipelineTransition {
  const summary = context.summary ?? statusSummary;
  return {
    runPatch: {
      status: "waiting_confirmation",
      statusSummary,
      latestNodeOutputs: withNodeOutput(state, action, summary, env),
    },
    nodeRunPatch: {
      status: "waiting_confirmation",
      finalAction: action,
      outputSummary: summary,
      clearNextPollAt: true,
      clearPendingDecision: true,
    },
    record: actionRecord(state, env, {
      action,
      actorType,
      toNodeId: state.nodeRun.nodeId,
      toStatus: "waiting_confirmation",
      context,
      result: { waitingConfirmation: true },
    }),
    effects: [],
  };
}

function failNode(
  state: PipelineMachineState,
  actorType: PipelineActorType,
  reason: string,
  env: PipelineMachineEnv,
  context?: PipelineActionContextPayload,
): PipelineTransition {
  const { nodeRun } = state;
  const summary = context?.summary ?? reason;
  return {
    runPatch: { status: "failed", statusSummary: reason },
    nodeRunPatch: {
      ...finishNodeRun(nodeRun, "failed", "pipeline_fail", summary, env),
      errorMessage: reason,
    },
    record: actionRecord(state, env, {
      action: "pipeline_fail",
      actorType,
      toStatus: "failed",
      context: {
        reason,
        ...(context?.summary !== undefined ? { summary: context.summary } : {}),
        ...(context?.data ? { data: context.data } : {}),
      },
      result: { failed: true },
    }),
    effects: archiveSession(nodeRun),
  };
}

function retry(
  state: PipelineMachineState,
  preserveStepState: boolean,
  env: PipelineMachineEnv,
  actorId?: string,
): PipelineTransition {
  const { run, nodeRun } = state;
  const { node } = currentNode(state);
  const entered = enterNode(
    run,
    node,
    env.newNodeRunId,
    {
      // The retry keeps what the failed attempt was handed.
      triggeredByRecordId: nodeRun.triggeredByRecordId ?? env.newRecordId,
      inputContext: nodeRun.inputContext,
      stepState: preserveStepState && node.executor === "ts" ? nodeRun.stepState : {},
    },
    env.now,
  );
  return {
    runPatch: {
      status: entered.runStatus,
      activeNodeRunId: env.newNodeRunId,
      ...(entered.statusSummary
        ? { statusSummary: entered.statusSummary }
        : { clearStatusSummary: true }),
    },
    newNodeRun: entered.nodeRun,
    record: actionRecord(state, env, {
      action: "human_retry",
      actorType: "human",
      actorId,
      toNodeId: node.id,
      toStatus: entered.runStatus,
      context: {
        summary: `Retrying node "${node.name}"`,
        data: { preserveStepState },
      },
      result: { nextNodeRunId: env.newNodeRunId },
    }),
    effects: [],
  };
}

function cancel(
  state: PipelineMachineState,
  reason: string,
  env: PipelineMachineEnv,
  actorId?: string,
): PipelineTransition {
  const { nodeRun } = state;
  const nodeIsLive = nodeRun.status !== "completed" && nodeRun.status !== "failed";
  return {
    runPatch: { status: "cancelled", statusSummary: reason, finishedAt: env.now },
    ...(nodeIsLive
      ? { nodeRunPatch: finishNodeRun(nodeRun, "cancelled", "human_cancel", reason, env) }
      : {}),
    record: actionRecord(state, env, {
      action: "human_cancel",
      actorType: "human",
      actorId,
      toStatus: "cancelled",
      context: { reason, summary: reason },
      result: {},
    }),
    effects: [
      ...(nodeIsLive
        ? [
            {
              kind: "stop_node",
              nodeRunId: nodeRun.nodeRunId,
              ...(nodeRun.sessionId ? { sessionId: nodeRun.sessionId } : {}),
            } as const,
          ]
        : []),
      ...archiveSession(nodeRun),
      { kind: "remove_workspace" },
    ],
  };
}

/** A new node run for `node`: terminal nodes finish at once, human nodes wait for a person. */
function enterNode(
  run: Pick<PipelineRunRecord, "runId" | "projectId" | "pipelineId">,
  node: PipelineNodeSnapshot,
  nodeRunId: string,
  input: {
    readonly triggeredByRecordId?: string | undefined;
    readonly inputContext: Record<string, unknown>;
    readonly stepState?: PipelineStepState | undefined;
  },
  now: string,
): {
  readonly nodeRun: NewPipelineNodeRun;
  readonly runStatus: PipelineRunStatus;
  readonly statusSummary?: string | undefined;
} {
  const status: PipelineNodeRunStatus = node.terminal
    ? "completed"
    : node.executor === "human"
      ? "waiting_confirmation"
      : "queued";
  return {
    nodeRun: {
      nodeRunId,
      runId: run.runId,
      projectId: run.projectId,
      pipelineId: run.pipelineId,
      nodeId: node.id,
      executorType: node.executor,
      ...(input.triggeredByRecordId ? { triggeredByRecordId: input.triggeredByRecordId } : {}),
      status,
      inputContext: input.inputContext,
      stepState: input.stepState ?? {},
      pollCount: 0,
      reminderSent: false,
      ...(status !== "queued" ? { startedAt: now } : {}),
      ...(node.terminal ? { finishedAt: now, durationMs: 0 } : {}),
      createdAt: now,
      updatedAt: now,
    },
    runStatus: status,
    ...(node.terminal ? { statusSummary: "Completed" } : {}),
    ...(node.executor === "human"
      ? { statusSummary: `Waiting for human approval at "${node.name}"` }
      : {}),
  };
}

function finishNodeRun(
  nodeRun: PipelineNodeRunRecord,
  status: PipelineNodeRunStatus,
  action: PipelineActionName,
  summary: string,
  env: PipelineMachineEnv,
): PipelineNodeRunPatch {
  const startedMs = nodeRun.startedAt ? Date.parse(nodeRun.startedAt) : Number.NaN;
  const durationMs = Number.isFinite(startedMs)
    ? Math.max(0, Date.parse(env.now) - startedMs)
    : undefined;
  return {
    status,
    finalAction: action,
    outputSummary: summary,
    finishedAt: env.now,
    ...(durationMs !== undefined ? { durationMs } : {}),
    clearNextPollAt: true,
    clearPendingDecision: true,
  };
}

function withNodeOutput(
  state: PipelineMachineState,
  action: PipelineActionName,
  summary: string,
  env: PipelineMachineEnv,
): PipelineRunRecord["latestNodeOutputs"] {
  const { run, nodeRun } = state;
  return {
    ...run.latestNodeOutputs,
    [nodeRun.nodeId]: {
      nodeId: nodeRun.nodeId,
      attempt: nodeRun.attempt,
      recordId: env.newRecordId,
      action,
      summary,
      createdAt: env.now,
    },
  };
}

function actionRecord(
  state: PipelineMachineState,
  env: PipelineMachineEnv,
  params: {
    readonly action: PipelineActionName;
    readonly actorType: PipelineActorType;
    readonly actorId?: string | undefined;
    readonly toNodeId?: string | undefined;
    readonly toStatus: PipelineRunStatus;
    readonly context: PipelineActionContextPayload;
    readonly result: Record<string, unknown>;
  },
): NewPipelineActionRecord {
  const { run, nodeRun } = state;
  return {
    recordId: env.newRecordId,
    runId: run.runId,
    projectId: run.projectId,
    nodeRunId: nodeRun.nodeRunId,
    nodeId: nodeRun.nodeId,
    attempt: nodeRun.attempt,
    action: params.action,
    actorType: params.actorType,
    ...(params.actorId ? { actorId: params.actorId } : {}),
    fromNodeId: nodeRun.nodeId,
    ...(params.toNodeId ? { toNodeId: params.toNodeId } : {}),
    fromStatus: run.status,
    toStatus: params.toStatus,
    context: params.context,
    result: params.result,
    createdAt: env.now,
  };
}

function archiveSession(nodeRun: PipelineNodeRunRecord): PipelineEffect[] {
  return nodeRun.sessionId ? [{ kind: "archive_session", sessionId: nodeRun.sessionId }] : [];
}

function currentNode(state: PipelineMachineState): {
  node: PipelineNodeSnapshot;
  index: number;
} {
  const index = state.nodes.findIndex((n) => n.id === state.nodeRun.nodeId);
  if (index === -1) {
    throw new PipelineConflictError(
      `node "${state.nodeRun.nodeId}" is not part of pipeline ${state.run.pipelineId}@v${state.run.pipelineVersion}`,
    );
  }
  return { node: state.nodes[index]!, index };
}

function resolvePrevTarget(
  state: PipelineMachineState,
  requestedTargetId: string | undefined,
): PipelineNodeSnapshot {
  const { node, index } = currentNode(state);
  if (!node.allowPrev || node.prevTargets.length === 0) {
    throw new PipelineValidationError(`node "${node.id}" does not allow returning upstream`);
  }
  const targetId = requestedTargetId?.trim() || singleTarget(node);
  if (!node.prevTargets.includes(targetId)) {
    throw new PipelineValidationError(
      `targetNodeId "${targetId}" is not in allowed prevTargets [${node.prevTargets.join(", ")}] for node "${node.id}"`,
    );
  }
  const targetIndex = state.nodes.findIndex((n) => n.id === targetId);
  if (targetIndex === -1 || targetIndex >= index) {
    throw new PipelineValidationError(
      `targetNodeId "${targetId}" must strictly precede node "${node.id}"`,
    );
  }
  return state.nodes[targetIndex]!;
}

function singleTarget(node: PipelineNodeSnapshot): string {
  if (node.prevTargets.length === 1) return node.prevTargets[0]!;
  throw new PipelineValidationError(
    `node "${node.id}" has multiple prevTargets (${node.prevTargets.join(", ")}); targetNodeId is required`,
  );
}

function requireRunStatus(run: PipelineRunRecord, status: PipelineRunStatus, verb: string): void {
  if (run.status !== status) {
    throw new PipelineConflictError(
      `cannot ${verb} pipeline run ${run.runId} in status "${run.status}" (expected "${status}")`,
    );
  }
}

function requireNodeStatus(
  nodeRun: PipelineNodeRunRecord,
  statuses: readonly PipelineNodeRunStatus[],
  verb: string,
): void {
  if (!statuses.includes(nodeRun.status)) {
    throw new PipelineConflictError(
      `cannot ${verb} node run ${nodeRun.nodeRunId} in status "${nodeRun.status}"`,
    );
  }
}
