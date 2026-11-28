import type { ContextOptions, ScopedContext } from "../context/index.ts";
import type { Origin, SessionOrigin, SessionOwner } from "../domain/origin.ts";
import type { PipelineEngine } from "../pipeline/index.ts";
import type { ScheduledJobs } from "../session/scheduled-jobs.ts";
import type { SessionTurns } from "../session/turns.ts";
import type { TaskEngine } from "../task/index.ts";
import type {
  PipelineOwner,
  SessionTools,
  TaskOwner,
  ToolContext,
  ToolRegistry,
  ToolSession,
} from "../tools/index.ts";

export interface AgentToolsDeps {
  readonly registry: ToolRegistry;
  readonly createContext: (origin: Origin, options: ContextOptions) => ScopedContext;
  readonly turns: Pick<SessionTurns, "activeTurn">;
  readonly scheduledJobs: ScheduledJobs;
  readonly taskEngine: TaskEngine;
  readonly pipelineEngine: PipelineEngine;
}

/** The orchestrator tools a project's agents are offered, bound to the session calling them. */
export class AgentTools {
  constructor(private readonly deps: AgentToolsDeps) {}

  /**
   * The tools a session's agent is offered. A call runs as the session's current turn: in its
   * trace, attributed to it, with its owner's task state or pipeline node.
   */
  forSession(
    sessionId: string,
    workspacePath: string,
    owner: SessionOwner | undefined,
  ): SessionTools {
    const { registry, pipelineEngine } = this.deps;
    const pipelineNext =
      owner?.kind === "pipeline"
        ? pipelineEngine.pipelineNextInput(owner.pipelineId, owner.nodeId)
        : undefined;
    const inputs = pipelineNext ? { pipeline_next: pipelineNext } : undefined;
    return {
      specs: registry.specs({ owner }, inputs),
      call: async (name, args, options) => {
        const active = this.deps.turns.activeTurn(sessionId);
        const origin: SessionOrigin = {
          kind: "session",
          sessionId,
          ...(active ? { turnId: active.turnId } : {}),
        };
        const scoped = this.deps.createContext(origin, {
          signal: options?.signal ?? new AbortController().signal,
        });
        try {
          const ctx: ToolContext = {
            ...scoped.context,
            origin,
            session: this.session(origin, workspacePath),
            ...(owner ? { owner: await this.owner(owner, origin.turnId) } : {}),
          };
          return await registry.call(name, args, ctx, {
            input: inputs?.[name as keyof typeof inputs],
            traceContext: active?.traceContext,
          });
        } finally {
          await scoped.dispose();
        }
      },
    };
  }

  /** The calling session, as its tools see it. */
  session(origin: SessionOrigin, workspace: string): ToolSession {
    const { sessionId, turnId } = origin;
    const { scheduledJobs } = this.deps;
    return {
      id: sessionId,
      ...(turnId ? { turnId } : {}),
      workspace,
      schedule: (job) => scheduledJobs.schedule(sessionId, turnId, job),
      cancelSchedule: (nameOrId) => scheduledJobs.cancel(sessionId, nameOrId),
    };
  }

  /** The task or pipeline node a session works for, with what its tools may do to it. */
  private async owner(
    owner: SessionOwner,
    turnId: string | undefined,
  ): Promise<TaskOwner | PipelineOwner> {
    if (owner.kind === "task") {
      const engine = this.deps.taskEngine;
      let state = await engine.getState(owner.taskKey);
      return {
        ...owner,
        state: {
          get: () => state,
          set: (next) => {
            state = { ...next };
            engine.updateState(owner.taskKey, state);
          },
          merge: (patch) => {
            state = { ...state, ...patch };
            engine.updateState(owner.taskKey, state);
          },
        },
      };
    }
    const engine = this.deps.pipelineEngine;
    return {
      ...owner,
      decide: (action, context) =>
        engine.registerAgentDecision({
          nodeRunId: owner.nodeRunId,
          ...(turnId ? { turnId } : {}),
          action,
          context,
        }),
      context: () => engine.getContextForNodeRun(owner.nodeRunId),
      history: {
        list: (filter) => engine.listHistory(owner.runId, filter),
        get: (query) => engine.getHistoryDetail(owner.runId, query),
      },
    };
  }
}
