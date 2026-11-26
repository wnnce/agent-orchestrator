import { describe, expect, it } from "bun:test";
import {
  PipelineConflictError,
  PipelineValidationError,
  decide,
  type PipelineCommand,
  type PipelineMachineState,
  type PipelineNodeRunRecord,
  type PipelineNodeSnapshot,
  type PipelineRunRecord,
} from "../src/pipeline/index.ts";

const NOW = "2026-11-26T10:00:00.000Z";
const ENV = { now: NOW, newRecordId: "pact_new", newNodeRunId: "pnr_new" };

function node(overrides: Partial<PipelineNodeSnapshot> & { id: string }): PipelineNodeSnapshot {
  return {
    name: overrides.id,
    executor: "agent",
    terminal: false,
    gate: "auto",
    allowPrev: false,
    prevTargets: [],
    maxLoops: 3,
    ...overrides,
  };
}

const NODES: readonly PipelineNodeSnapshot[] = [
  node({ id: "design", gate: "manual" }),
  node({ id: "implement", allowPrev: true, prevTargets: ["design"], maxLoops: 2 }),
  node({ id: "ci", executor: "ts" }),
  node({ id: "done", executor: "terminal", terminal: true }),
];

function state(
  nodeId: string,
  status: PipelineNodeRunRecord["status"],
  overrides?: { run?: Partial<PipelineRunRecord>; nodeRun?: Partial<PipelineNodeRunRecord> },
): PipelineMachineState {
  const executor = NODES.find((n) => n.id === nodeId)!.executor;
  return {
    nodes: NODES,
    run: {
      runId: "prun_1",
      projectId: "p1",
      pipelineId: "delivery",
      pipelineVersion: 1,
      title: "Run",
      data: {},
      metadata: {},
      currentNodeId: nodeId,
      status,
      workspaceStatus: "active",
      loopCounts: {},
      activeNodeRunId: "pnr_1",
      latestNodeOutputs: {},
      createdBy: "api",
      stateVersion: 4,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides?.run,
    },
    nodeRun: {
      nodeRunId: "pnr_1",
      runId: "prun_1",
      projectId: "p1",
      pipelineId: "delivery",
      nodeId,
      attempt: 1,
      sequence: 1,
      executorType: executor,
      status,
      inputContext: {},
      stepState: {},
      pollCount: 0,
      reminderSent: false,
      sessionId: "ses_1",
      agentTurnId: "turn_agent",
      startedAt: "2026-11-26T09:59:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides?.nodeRun,
    },
  };
}

function apply(s: PipelineMachineState, command: PipelineCommand) {
  return decide(s, command, ENV);
}

const next = {
  action: "pipeline_next" as const,
  context: { summary: "done", content: "work" },
};

describe("pipeline state machine", () => {
  describe("a failed run", () => {
    const failed = state("implement", "failed");

    it("refuses flow actions, so chatting with its session cannot move it", () => {
      expect(() => apply(failed, { kind: "register_decision", decision: next })).toThrow(
        PipelineConflictError,
      );
      expect(
        apply(failed, { kind: "turn_finished", turnId: "turn_user", status: "completed" }),
      ).toBeNull();
      expect(() => apply(failed, { kind: "approve", handoff: {} })).toThrow(PipelineConflictError);
    });

    it("can be retried as a new attempt of the same node", () => {
      const t = apply(failed, { kind: "retry", preserveStepState: false })!;
      expect(t.runPatch).toMatchObject({ status: "queued", activeNodeRunId: "pnr_new" });
      expect(t.newNodeRun).toMatchObject({ nodeId: "implement", status: "queued" });
      expect(t.record?.action).toBe("human_retry");
    });
  });

  it("applies an agent's next on a manual gate as a wait for confirmation", () => {
    const s = state("design", "running", { nodeRun: { pendingDecision: next } });
    const t = apply(s, { kind: "turn_finished", turnId: "turn_agent", status: "completed" })!;
    expect(t.runPatch.status).toBe("waiting_confirmation");
    expect(t.nodeRunPatch).toMatchObject({
      status: "waiting_confirmation",
      clearPendingDecision: true,
    });
    expect(t.record).toMatchObject({ action: "pipeline_next", toNodeId: "design" });
    expect(t.newNodeRun).toBeUndefined();
  });

  it("advances an auto node, archives its session and hands its context on", () => {
    const s = state("implement", "running", { nodeRun: { pendingDecision: next } });
    const t = apply(s, { kind: "turn_finished", turnId: "turn_agent", status: "completed" })!;
    expect(t.runPatch).toMatchObject({ currentNodeId: "ci", status: "queued" });
    expect(t.newNodeRun).toMatchObject({
      nodeId: "ci",
      triggeredByRecordId: "pact_new",
      inputContext: {},
    });
    expect(t.record?.context).toEqual(next.context);
    expect(t.effects).toEqual([{ kind: "archive_session", sessionId: "ses_1" }]);
  });

  it("completes the run and removes its workspace on entering the terminal node", () => {
    const t = apply(state("ci", "running"), {
      kind: "ts_result",
      result: { action: "next", summary: "green", content: "ok" },
    })!;
    expect(t.runPatch).toMatchObject({ status: "completed", finishedAt: NOW });
    expect(t.newNodeRun).toMatchObject({ nodeId: "done", status: "completed" });
    expect(t.effects).toContainEqual({ kind: "remove_workspace" });
  });

  it("stops an agent from sending work back more often than maxLoops", () => {
    const prev = {
      action: "pipeline_prev" as const,
      context: { reason: "missing tests", feedback: "add tests" },
    };
    const s = state("implement", "running", {
      run: { loopCounts: { "implement->design": 1 } },
      nodeRun: { pendingDecision: prev },
    });
    const t = apply(s, { kind: "turn_finished", turnId: "turn_agent", status: "completed" })!;
    expect(t.record?.action).toBe("system_loop_breaker");
    expect(t.runPatch).toMatchObject({
      status: "waiting_confirmation",
      loopCounts: { "implement->design": 2 },
    });
  });

  it("lets a person send work back past the loop limit", () => {
    const s = state("implement", "waiting_confirmation", {
      run: { loopCounts: { "implement->design": 5 } },
    });
    const t = apply(s, { kind: "reject", reason: "r", feedback: "f" })!;
    expect(t.record?.action).toBe("human_reject");
    expect(t.runPatch).toMatchObject({ currentNodeId: "design", status: "queued" });
  });

  it("rejects an invalid flow action when it is registered", () => {
    expect(() =>
      apply(state("design", "running"), {
        kind: "register_decision",
        decision: { action: "pipeline_prev", context: { reason: "r", feedback: "f" } },
      }),
    ).toThrow(PipelineValidationError);
  });

  it("accepts one flow action per turn", () => {
    const s = state("implement", "running", { nodeRun: { pendingDecision: next } });
    expect(() => apply(s, { kind: "register_decision", decision: next })).toThrow(
      "already been registered",
    );
  });

  describe("a finished turn without a flow action", () => {
    it("is ignored when a person was chatting", () => {
      const s = state("design", "waiting_confirmation");
      expect(
        apply(s, { kind: "turn_finished", turnId: "turn_user", status: "completed" }),
      ).toBeNull();
    });

    it("drops a flow action registered in a turn that failed", () => {
      const s = state("design", "waiting_confirmation", {
        nodeRun: { pendingDecision: { ...next, turnId: "turn_user" } },
      });
      const t = apply(s, { kind: "turn_finished", turnId: "turn_user", status: "failed" })!;
      expect(t.nodeRunPatch).toEqual({ clearPendingDecision: true });
      expect(t.runPatch).toEqual({});
    });

    it("reminds the agent once, then waits for a person", () => {
      const first = apply(state("implement", "running"), {
        kind: "turn_finished",
        turnId: "turn_agent",
        status: "completed",
      })!;
      expect(first.nodeRunPatch).toEqual({ reminderSent: true });
      expect(first.effects).toEqual([{ kind: "send_reminder", sessionId: "ses_1" }]);

      const reminded = state("implement", "running", { nodeRun: { reminderSent: true } });
      const second = apply(reminded, {
        kind: "turn_finished",
        turnId: "turn_agent",
        status: "completed",
        output: "forgot",
      })!;
      expect(second.record).toMatchObject({
        action: "system_fallback",
        context: { content: "forgot" },
      });
      expect(second.runPatch.status).toBe("waiting_confirmation");
    });
  });

  it("cancels a run from any active state and cleans up after it", () => {
    const t = apply(state("ci", "waiting"), { kind: "cancel", reason: "not needed" })!;
    expect(t.runPatch).toMatchObject({ status: "cancelled", finishedAt: NOW });
    expect(t.effects).toContainEqual({ kind: "remove_workspace" });
    expect(t.effects).toContainEqual({ kind: "stop_node", nodeRunId: "pnr_1", sessionId: "ses_1" });
    expect(() =>
      apply(state("ci", "completed", { run: { status: "completed" } }), {
        kind: "cancel",
        reason: "x",
      }),
    ).toThrow(PipelineConflictError);
  });

  it("fails a node that was running when the service restarted", () => {
    for (const nodeId of ["ci", "implement"]) {
      const t = apply(state(nodeId, "running"), { kind: "recover_after_restart" })!;
      expect(t.runPatch).toMatchObject({ status: "failed", statusSummary: "runtime_restarted" });
      expect(t.nodeRunPatch?.errorMessage).toBe("runtime_restarted");
    }
    expect(apply(state("ci", "waiting"), { kind: "recover_after_restart" })).toBeNull();
  });

  it("only claims queued nodes", () => {
    expect(apply(state("ci", "queued"), { kind: "claim" })?.effects).toEqual([
      { kind: "launch_node" },
    ]);
    expect(() => apply(state("ci", "running"), { kind: "claim" })).toThrow(PipelineConflictError);
  });
});
