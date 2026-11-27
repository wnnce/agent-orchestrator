/**
 * Who is acting on behalf of a project: an agent session, a task execution, a pipeline node or
 * an HTTP hook delivery. Attribution, audit, notification sources, artifact owners, `createdBy`
 * labels, log fields and span attributes all follow from it.
 */
export type Origin = SessionOrigin | TaskOrigin | PipelineOrigin | HookOrigin;

export interface SessionOrigin {
  readonly kind: "session";
  readonly sessionId: string;
  readonly turnId?: string | undefined;
}

export interface TaskOrigin {
  readonly kind: "task";
  readonly taskId: string;
  /** `<projectId>:<taskId>`, the key the task engine stores state under. */
  readonly taskKey: string;
  readonly executionId: string;
}

export interface PipelineOrigin {
  readonly kind: "pipeline";
  readonly pipelineId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeRunId: string;
}

export interface HookOrigin {
  readonly kind: "hook";
  readonly hookId: string;
  readonly deliveryId?: string | undefined;
}

export type OriginKind = Origin["kind"];

/** The task execution or pipeline node a session works for. Ordinary sessions have none. */
export type SessionOwner = TaskOrigin | PipelineOrigin;

/** How a record stores its origin: the kind and the most specific identifier of that kind. */
export interface OriginRef {
  readonly kind: OriginKind;
  readonly id: string;
}

export function originRef(origin: Origin): OriginRef {
  switch (origin.kind) {
    case "session":
      return { kind: "session", id: origin.sessionId };
    case "task":
      return { kind: "task", id: origin.executionId };
    case "pipeline":
      return { kind: "pipeline", id: origin.nodeRunId };
    case "hook":
      return { kind: "hook", id: origin.deliveryId ?? origin.hookId };
  }
}

/** The `createdBy` label of things an origin starts, e.g. `task:nightly`. */
export function originLabel(origin: Origin): string {
  switch (origin.kind) {
    case "session":
      return `session:${origin.sessionId}`;
    case "task":
      return `task:${origin.taskId}`;
    case "pipeline":
      return `pipeline:${origin.runId}`;
    case "hook":
      return `hook:${origin.hookId}`;
  }
}

/** Log fields describing an origin. */
export function originLogFields(origin: Origin): Record<string, string> {
  switch (origin.kind) {
    case "session":
      return { sessionId: origin.sessionId, ...(origin.turnId ? { turnId: origin.turnId } : {}) };
    case "task":
      return { taskId: origin.taskId, executionId: origin.executionId };
    case "pipeline":
      return {
        pipelineId: origin.pipelineId,
        runId: origin.runId,
        nodeId: origin.nodeId,
        nodeRunId: origin.nodeRunId,
      };
    case "hook":
      return {
        hookId: origin.hookId,
        ...(origin.deliveryId ? { deliveryId: origin.deliveryId } : {}),
      };
  }
}

/** Span attributes describing an origin. */
export function originSpanAttributes(origin: Origin): Record<string, string> {
  switch (origin.kind) {
    case "session":
      return {
        "session.id": origin.sessionId,
        ...(origin.turnId ? { "turn.id": origin.turnId } : {}),
      };
    case "task":
      return { "task.id": origin.taskId, "task.execution_id": origin.executionId };
    case "pipeline":
      return {
        "pipeline.id": origin.pipelineId,
        "pipeline.run_id": origin.runId,
        "pipeline.node_id": origin.nodeId,
        "pipeline.node_run_id": origin.nodeRunId,
      };
    case "hook":
      return {
        "hook.id": origin.hookId,
        ...(origin.deliveryId ? { "hook.delivery_id": origin.deliveryId } : {}),
      };
  }
}
