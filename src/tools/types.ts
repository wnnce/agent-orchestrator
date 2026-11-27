import type { z } from "zod";
import type { ProjectContext, TaskState } from "../context/types.ts";
import type { PipelineOrigin, SessionOrigin, SessionOwner, TaskOrigin } from "../domain/origin.ts";
import type { ScheduledJobRecord } from "../domain/types.ts";
import type {
  PipelineActionContextPayload,
  PipelineActionRecord,
  PipelineFlowActionName,
  PipelineGlobalContextView,
  PipelineHistoryEntrySummary,
  PipelineHistoryFilter,
} from "../pipeline/types.ts";
import type { PipelineHistoryQuery } from "../pipeline/context.ts";

/**
 * A tool an agent can call. Tools adapt project capabilities for a model: a JSON input schema,
 * a description, and when they are offered. `run` returns its result or throws.
 */
export interface ToolDefinition<TInput extends z.ZodObject = z.ZodObject, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: TInput;
  /** Whether a session is offered this tool. Offered everywhere when omitted. */
  readonly when?: ((site: ToolSite) => boolean) | undefined;
  run(input: z.output<TInput>, ctx: ToolContext): Promise<TOutput>;
}

export function defineTool<TInput extends z.ZodObject, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

export type { SessionOwner };

/** What decides which tools a session gets. */
export interface ToolSite {
  readonly owner?: SessionOwner | undefined;
}

/** The context a tool runs in: the session's project context plus the session and its owner. */
export interface ToolContext extends ProjectContext {
  readonly origin: SessionOrigin;
  readonly session: ToolSession;
  readonly owner?: TaskOwner | PipelineOwner | undefined;
}

export interface ToolSession {
  readonly id: string;
  readonly turnId?: string | undefined;
  /** The session's Git worktree. */
  readonly workspace: string;
  /** Wakes this session later with `prompt` as a new turn. */
  schedule(job: {
    name: string;
    delayMinutes: number;
    prompt: string;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ScheduledJobRecord>;
  /** Cancels a pending wake-up by name or job ID. */
  cancelSchedule(nameOrId: string): Promise<boolean>;
}

/** The task a session works for, with the task's state. */
export interface TaskOwner extends TaskOrigin {
  readonly state: TaskState;
}

/** The pipeline node a session runs, with what its agent may do to the run. */
export interface PipelineOwner extends PipelineOrigin {
  /** Records a flow decision; it is applied when the turn finishes. */
  decide(
    action: PipelineFlowActionName,
    context: PipelineActionContextPayload,
  ): Promise<Record<string, unknown>>;
  context(): Promise<PipelineGlobalContextView>;
  readonly history: {
    list(filter?: PipelineHistoryFilter): Promise<PipelineHistoryEntrySummary[]>;
    get(query: PipelineHistoryQuery): Promise<PipelineActionRecord | null>;
  };
}

/** A tool as a runtime adapter offers it to its agent. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodObject;
  /** `input` as JSON Schema. */
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  readonly ok: boolean;
  /** What the agent sees: the result, or `{ "error": ... }`, as JSON. */
  readonly text: string;
  readonly data?: unknown;
  readonly error?: string | undefined;
}

/**
 * The tools of one session, as runtime adapters see them. Calls run as the session's current
 * turn, with its trace, audit record and project context.
 */
export interface SessionTools {
  readonly specs: readonly ToolSpec[];
  call(
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ToolCallResult>;
}
