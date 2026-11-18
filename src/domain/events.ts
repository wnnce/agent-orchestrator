import type { BaseLogRecord } from "./types.ts";

/**
 * ============================================================================
 * Canonical Domain Event Protocol
 * ============================================================================
 * 
 * Core Design Principles:
 * 1. Discriminated Union: Each event `type` strictly binds to a typed `payload`.
 * 2. Canonical Dot-Notation: Follows `{domain}.{object}.{action/state}` naming pattern.
 * 3. Controlled Extensibility: Core properties are first-class fields; an optional
 *    `metadata?: Record<string, unknown>` carries runtime-specific or debug context.
 * 4. Boundary Normalization: Runtime-specific protocols are converted by adapters
 *    at the gateway boundary; consumers operate exclusively on this schema.
 */

// ============================================================================
// 1. Message & Reasoning
// ============================================================================

/**
 * Streaming text delta payload
 */
export interface AgentMessageDeltaPayload {
  readonly itemId?: string | undefined;
  readonly delta?: string | undefined;
  readonly text?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Completed text message payload
 */
export interface AgentMessageCompletedPayload {
  readonly itemId?: string | undefined;
  readonly text?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Streaming reasoning/monologue delta payload
 */
export interface AgentReasoningDeltaPayload {
  readonly itemId?: string | undefined;
  readonly delta?: string | undefined;
  readonly text?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Completed reasoning/monologue payload
 */
export interface AgentReasoningCompletedPayload {
  readonly itemId?: string | undefined;
  readonly text?: string | undefined;
  readonly summary?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Plan change payload
 */
export interface PlanStepItem {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in_progress" | "completed" | "failed";
}

export interface PlanUpdatedPayload {
  readonly planId?: string | undefined;
  readonly steps: readonly PlanStepItem[];
  readonly metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// 2. Command Execution
// ============================================================================

/**
 * Command execution start payload
 */
export interface CommandStartedPayload {
  readonly itemId: string;
  readonly command: string;
  readonly workdir?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Incremental command stdout/stderr output payload
 */
export interface CommandOutputPayload {
  readonly itemId: string;
  readonly delta: string;
  readonly stream?: "stdout" | "stderr" | "mixed" | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Completed command execution payload
 */
export interface CommandCompletedPayload {
  readonly itemId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
  readonly durationMs?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// 3. Workspace & File Changes
// ============================================================================

/**
 * File change start payload
 */
export interface FileChangeStartedPayload {
  readonly itemId: string;
  readonly path: string;
  readonly kind: "create" | "modify" | "delete";
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Completed file change payload
 */
export interface FileChangeCompletedPayload {
  readonly itemId: string;
  readonly path: string;
  readonly kind: "create" | "modify" | "delete";
  readonly diff?: string | undefined;
  readonly totalLinesAdded?: number | undefined;
  readonly totalLinesRemoved?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// 4. Tools, MCP & Actions
// ============================================================================

/**
 * Tool call start payload
 */
export interface ToolCallStartedPayload {
  readonly itemId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Completed tool or action invocation payload
 */
export interface ToolCallCompletedPayload {
  readonly itemId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly status: "success" | "failure";
  readonly result?: unknown | undefined;
  readonly error?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * MCP tool call start payload
 */
export interface McpCallStartedPayload {
  readonly itemId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Completed MCP tool call payload
 */
export interface McpCallCompletedPayload {
  readonly itemId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly status: "success" | "failure";
  readonly result?: unknown | undefined;
  readonly error?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// 5. Human-in-the-Loop & Approvals
// ============================================================================

/**
 * Action approval request payload
 */
export interface ApprovalRequestedPayload {
  readonly requestId: string;
  readonly actionType: "command" | "file_change" | "tool_call" | "custom";
  readonly description: string;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Approval decision payload
 */
export interface ApprovalResolvedPayload {
  readonly requestId: string;
  readonly decision: "approved" | "rejected";
  readonly reason?: string | undefined;
  readonly resolvedBy?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// 6. Session & Turn Lifecycle
// ============================================================================

export interface TurnQueuedPayload {
  readonly turnId?: string | undefined;
  readonly input?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface TurnStartedPayload {
  readonly turnId?: string | undefined;
  readonly input?: string | undefined;
  readonly runtimeTurnId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface TurnCompletedPayload {
  readonly turnId?: string | undefined;
  readonly status?: "completed" | "failed" | "interrupted" | undefined;
  readonly runtimeTurnId?: string | undefined;
  /**
   * Final synthesized assistant response text assembled by Runtime normalizer
   */
  readonly finalText?: string | undefined;
  readonly error?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface SessionStartedPayload {
  readonly sessionId?: string | undefined;
  readonly workspacePath?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface SessionResumedPayload {
  readonly sessionId?: string | undefined;
  readonly workspacePath?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** The runtime lost the session (or the project switched runtimes); a new one was started. */
export interface SessionRuntimeResetPayload {
  readonly reason: "not_found" | "runtime_changed";
  readonly runtime: string;
  readonly previousRuntimeSessionId: string;
  readonly runtimeSessionId: string;
}

export interface SessionSuspendedPayload {
  readonly sessionId?: string | undefined;
  readonly reason?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface SessionArchivedPayload {
  readonly sessionId?: string | undefined;
  readonly reason?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface SessionClosedPayload {
  readonly sessionId?: string | undefined;
  readonly reason?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// 7. Artifacts, Notifications & Compaction
// ============================================================================

export interface ArtifactCreatedPayload {
  readonly artifactId: string;
  readonly kind: string;
  readonly path: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface NotificationQueuedPayload {
  readonly deliveryId: string;
  readonly kind: string;
  readonly title: string;
  readonly turnId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface NotificationSentPayload {
  readonly deliveryId: string;
  readonly status: "sent" | "partial" | "failed";
  readonly sent: number;
  readonly failed: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface CompactionStartedPayload {
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface CompactionCompletedPayload {
  readonly tokensBefore?: number | undefined;
  readonly tokensAfter?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// 8. Runtime Fallback & System Disconnect Events
// ============================================================================

export interface RuntimeUnmappedPayload {
  readonly metadata: {
    readonly rawMethod: string;
    readonly raw: unknown;
    readonly [key: string]: unknown;
  };
}

export interface RuntimeDisconnectedPayload {
  readonly error?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

// ============================================================================
// Canonical Event Registry & Discriminated Union
// ============================================================================

export interface CanonicalEventPayloadMap {
  // 1. Message & Reasoning
  "agent.message.delta": AgentMessageDeltaPayload;
  "agent.message.completed": AgentMessageCompletedPayload;
  "agent.reasoning.delta": AgentReasoningDeltaPayload;
  "agent.reasoning.completed": AgentReasoningCompletedPayload;
  "agent.reasoning": AgentReasoningCompletedPayload; // compatibility alias
  "plan.updated": PlanUpdatedPayload;

  // 2. Command execution
  "command.started": CommandStartedPayload;
  "command.output": CommandOutputPayload;
  "command.completed": CommandCompletedPayload;

  // 3. File changes
  "file_change.started": FileChangeStartedPayload;
  "file_change.completed": FileChangeCompletedPayload;

  // 4. Tools & Actions
  "tool.call.started": ToolCallStartedPayload;
  "tool.called": ToolCallCompletedPayload;
  "mcp_call.started": McpCallStartedPayload;
  "mcp_call.completed": McpCallCompletedPayload;

  // 5. Approvals
  "approval.requested": ApprovalRequestedPayload;
  "approval.resolved": ApprovalResolvedPayload;

  // 6. Lifecycle
  "turn.queued": TurnQueuedPayload;
  "turn.started": TurnStartedPayload;
  "turn.completed": TurnCompletedPayload;
  "turn.failed": TurnCompletedPayload;
  "turn.interrupted": TurnCompletedPayload;
  "session.started": SessionStartedPayload;
  "session.resumed": SessionResumedPayload;
  "session.runtime_reset": SessionRuntimeResetPayload;
  "session.suspended": SessionSuspendedPayload;
  "session.archived": SessionArchivedPayload;
  "session.closed": SessionClosedPayload;

  // 7. Artifacts & Notifications
  "artifact.created": ArtifactCreatedPayload;
  "notification.queued": NotificationQueuedPayload;
  "notification.sent": NotificationSentPayload;
  "compaction.started": CompactionStartedPayload;
  "compaction.completed": CompactionCompletedPayload;

  // 8. Unmapped provider events fallback & runtime disconnection
  "runtime.unmapped": RuntimeUnmappedPayload;
  "runtime.disconnected": RuntimeDisconnectedPayload;
}

export type CanonicalEventType = keyof CanonicalEventPayloadMap;

/**
 * Authoritative set of high-frequency transient streaming events that should
 * only be broadcast via EventHub without being appended to persistent store tables.
 */
export const TRANSIENT_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "agent.message.delta",
  "agent.reasoning.delta",
  "command.output",
  "item.reasoning.textDelta", // legacy alias for backward compatibility
]);

/**
 * Checks whether an event type is a transient streaming event.
 */
export function isTransientEvent(type: string): boolean {
  return TRANSIENT_EVENT_TYPES.has(type);
}

/**
 * Universal canonical event envelope
 */
export interface CanonicalEventEnvelope<T extends CanonicalEventType = CanonicalEventType> {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly sequence: number;
  readonly type: T;
  readonly runtime: string;
  readonly payload: CanonicalEventPayloadMap[T];
  readonly createdAt: string;
  readonly schemaVersion: 1;
}

/**
 * Discriminated union of all canonical domain events
 */
export type CanonicalDomainEvent = {
  [K in CanonicalEventType]: CanonicalEventEnvelope<K>;
}[CanonicalEventType];

/**
 * Type guard narrowing event and payload based on event type
 */
export function isCanonicalEventType<T extends CanonicalEventType>(
  event: { type: string; payload: unknown },
  expectedType: T,
): event is { type: T; payload: CanonicalEventPayloadMap[T] } {
  return event.type === expectedType;
}

/**
 * Legacy event names retained for backward compatibility
 */
export type LegacyEventType =
  | "thought"
  | "item.reasoning"
  | "item.started"
  | "command.execution";

/**
 * Union of canonical, legacy, and custom event types
 */
export type EventType = CanonicalEventType | LegacyEventType | (string & {});

/**
 * Universal persistence and memory record structure for events
 */
export interface EventRecord<T extends string = EventType, P = unknown>
  extends BaseLogRecord<string> {
  id: string;
  projectId: string;
  sessionId: string;
  turnId?: string | undefined;
  sequence: number;
  type: T;
  runtime: string;
  payload: P;
  createdAt: string;
  schemaVersion: number;
}
