import type { ProjectConfig } from "../domain/types.ts";
import type { SessionTools } from "../tools/types.ts";
import type {
  CanonicalEventType,
  CanonicalEventPayloadMap,
} from "../domain/events.ts";

export type RuntimeEvent = {
  sessionId: string;
  turnId?: string | undefined;
} & {
  [K in CanonicalEventType]: {
    type: K;
    payload: CanonicalEventPayloadMap[K];
  };
}[CanonicalEventType];

/** Thrown by `resumeSession` when the runtime no longer has the requested session. */
export class RuntimeSessionNotFoundError extends Error {
  constructor(readonly runtimeSessionId: string) {
    super(`runtime session not found: ${runtimeSessionId}`);
    this.name = "RuntimeSessionNotFoundError";
  }
}

/** A user's answer to `approval.requested`. */
export type ApprovalDecision = "approved" | "rejected";

export interface RuntimeSession {
  id: string;
  workspacePath: string;
}
export interface RuntimeTurn {
  id: string;
}
export interface RuntimeCapabilities {
  streaming: boolean;
  resume: boolean;
  steer: boolean;
  interrupt: boolean;
  compaction: boolean;
  approvals: boolean;
  mcp: boolean;
  structuredOutput: boolean;
  sandbox: boolean;
}
export interface RuntimeContext {
  project: ProjectConfig;
  workspacePath: string;
  /**
   * The orchestrator tools this session's agent is offered. A runtime exposes `tools.specs` to
   * its agent in its own way and runs calls through `tools.call`.
   */
  tools?: SessionTools;
  /**
   * The agent may only read: no file edits and no shell commands (the global project). Each
   * runtime enforces it with its own means, e.g. a read-only sandbox or read-only tools.
   */
  readOnly?: boolean;
  onEvent: (event: RuntimeEvent) => Promise<void> | void;
}

export const FAKE_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  steer: true,
  interrupt: true,
  compaction: true,
  approvals: true,
  mcp: false,
  structuredOutput: true,
  sandbox: true,
};

/**
 * Adapter between the orchestrator and one agent backend.
 *
 * Event contract for `RuntimeContext.onEvent`: a runtime reports what the agent does —
 * content events (`agent.*`, `plan.*`, `command.*`, `file_change.*`, `tool.*`, `mcp_call.*`),
 * `approval.requested`, `compaction.completed`, the turn's terminal event (`turn.completed`,
 * `turn.failed` or `turn.interrupted`) and `runtime.disconnected`. Session lifecycle events
 * (`session.*`) and `turn.queued` / `turn.started` belong to `ProjectRuntime`; runtimes never
 * emit them.
 *
 * A runtime calls `onEvent` in the order events happened, the turn's terminal event last;
 * `ProjectRuntime` handles the calls one at a time in that order. A runtime whose handlers run
 * concurrently (e.g. a backend that does not await its async listeners) queues its events so
 * that a handler's later events cannot overtake another handler's.
 *
 * Each `itemId` is one item of one kind: a shell command (`command.*`), a file change
 * (`file_change.*`), an MCP call (`mcp_call.*`) or another tool call (`tool.*`). A runtime does
 * not report the same item twice under different kinds.
 */
export interface AgentRuntime {
  readonly name: string;
  readonly type: string;
  readonly capabilities: RuntimeCapabilities;
  startSession(context: RuntimeContext): Promise<RuntimeSession>;
  resumeSession(
    context: RuntimeContext,
    runtimeSessionId: string,
  ): Promise<RuntimeSession>;
  startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn>;
  steerTurn(
    context: RuntimeContext,
    sessionId: string,
    runtimeTurnId: string,
    input: string,
  ): Promise<void>;
  interruptTurn(
    context: RuntimeContext,
    sessionId: string,
    runtimeTurnId: string,
  ): Promise<void>;
  compactSession(context: RuntimeContext, sessionId: string): Promise<void>;
  respondToApproval(
    context: RuntimeContext,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  releaseSession(context: RuntimeContext, sessionId: string): Promise<void>;
  stop(): Promise<void>;
}

export class FakeRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly type = "fake" as const;
  readonly capabilities: RuntimeCapabilities = FAKE_CAPABILITIES;
  private readonly turns = new Map<string, { id: string; canceled: boolean }>();
  async startSession(context: RuntimeContext): Promise<RuntimeSession> {
    return {
      id: `fake_${crypto.randomUUID()}`,
      workspacePath: context.workspacePath,
    };
  }
  async resumeSession(
    context: RuntimeContext,
    runtimeSessionId: string,
  ): Promise<RuntimeSession> {
    return { id: runtimeSessionId, workspacePath: context.workspacePath };
  }
  async startTurn(
    context: RuntimeContext,
    sessionId: string,
    turnId: string,
    input: string,
  ): Promise<RuntimeTurn> {
    const runtimeTurnId = `fake_turn_${crypto.randomUUID()}`;
    const state = { id: runtimeTurnId, canceled: false };
    this.turns.set(runtimeTurnId, state);
    await context.onEvent({
      type: "turn.started",
      sessionId,
      turnId,
      payload: { runtimeTurnId },
    });
    await context.onEvent({
      type: "agent.message.delta",
      sessionId,
      turnId,
      payload: { text: `Fake runtime received: ${input}` },
    });
    if (!state.canceled)
      await context.onEvent({
        type: "agent.message.completed",
        sessionId,
        turnId,
        payload: { text: `Fake runtime completed: ${input}` },
      });
    await context.onEvent({
      type: state.canceled ? "turn.interrupted" : "turn.completed",
      sessionId,
      turnId,
      payload: { runtimeTurnId },
    });
    return { id: runtimeTurnId };
  }
  async steerTurn(
    _context: RuntimeContext,
    _sessionId: string,
    _runtimeTurnId: string,
    _input: string,
  ): Promise<void> {}
  async interruptTurn(
    _context: RuntimeContext,
    _sessionId: string,
    runtimeTurnId: string,
  ): Promise<void> {
    const turn = this.turns.get(runtimeTurnId);
    if (turn) turn.canceled = true;
  }
  async compactSession(
    context: RuntimeContext,
    sessionId: string,
  ): Promise<void> {
    await context.onEvent({
      type: "compaction.completed",
      sessionId,
      payload: {},
    });
  }
  async respondToApproval(
    _context: RuntimeContext,
    _requestId: string,
    _decision: ApprovalDecision,
  ): Promise<void> {}
  async releaseSession(
    _context: RuntimeContext,
    _sessionId: string,
  ): Promise<void> {}
  async stop(): Promise<void> {}
}
