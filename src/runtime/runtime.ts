import type { ProjectConfig } from "../domain/types.ts";
import type { ActionContext } from "../actions/types.ts";
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
  taskKey?: string;
  onEvent: (event: RuntimeEvent) => Promise<void> | void;
  createActionContext?: (params: {
    turnId?: string | undefined;
    signal?: AbortSignal | undefined;
  }) => ActionContext;
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
    result: unknown,
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
    const id = `fake_${crypto.randomUUID()}`;
    await context.onEvent({
      type: "session.started",
      sessionId: id,
      payload: { workspacePath: context.workspacePath },
    });
    return { id, workspacePath: context.workspacePath };
  }
  async resumeSession(
    context: RuntimeContext,
    runtimeSessionId: string,
  ): Promise<RuntimeSession> {
    await context.onEvent({
      type: "session.resumed",
      sessionId: runtimeSessionId,
      payload: { workspacePath: context.workspacePath },
    });
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
    context: RuntimeContext,
    sessionId: string,
    runtimeTurnId: string,
    input: string,
  ): Promise<void> {
    await context.onEvent({
      type: "agent.message.delta",
      sessionId,
      turnId: runtimeTurnId,
      payload: { text: `Steered: ${input}` },
    });
  }
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
    _result: unknown,
  ): Promise<void> {}
  async releaseSession(
    _context: RuntimeContext,
    _sessionId: string,
  ): Promise<void> {}
  async stop(): Promise<void> {}
}
