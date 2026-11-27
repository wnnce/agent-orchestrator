import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PlanStepItem } from "../../domain/events.ts";
import type { RuntimeEvent } from "../runtime.ts";
import { TOOL_SERVER_NAME } from "./options.ts";

/** How a Claude Code tool call is shown: as a command, a file change, a plan or a tool call. */
export type ToolKind =
  | { kind: "command" }
  | { kind: "file_change"; change: "create" | "modify" }
  | { kind: "plan" }
  | { kind: "orchestrator"; orchestratorTool: string }
  | { kind: "mcp"; serverName: string; toolName: string }
  | { kind: "tool" };

export function toolKind(name: string): ToolKind {
  switch (name) {
    case "Bash":
      return { kind: "command" };
    case "Write":
      return { kind: "file_change", change: "create" };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "file_change", change: "modify" };
    case "TodoWrite":
      return { kind: "plan" };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return { kind: "tool" };
  const [, serverName = "", toolName = ""] = mcp;
  return serverName === TOOL_SERVER_NAME
    ? { kind: "orchestrator", orchestratorTool: toolName }
    : { kind: "mcp", serverName, toolName };
}

interface ToolCall {
  name: string;
  kind: ToolKind;
  input: Record<string, unknown>;
  startedAt: number;
}

/**
 * Turns Claude Agent SDK messages into canonical events for one session.
 *
 * Only the main thread is shown: messages from subagents (`parent_tool_use_id` set) are dropped,
 * the subagent call itself appears as a tool call. Turn boundaries (`result` messages) are
 * handled by the session, and messages without a canonical meaning produce no events.
 *
 * Text and thinking blocks are identified as `<API message id>:<block index>`, so streamed
 * deltas and the completed block share an item id.
 */
export class ClaudeNormalizer {
  private streamingMessageId: string | undefined;
  private readonly blocksSeen = new Map<string, number>();
  private readonly toolCalls = new Map<string, ToolCall>();

  constructor(
    private readonly sessionId: string,
    private readonly workspacePath: string,
  ) {}

  normalize(message: SDKMessage, turnId: string | undefined): RuntimeEvent[] {
    switch (message.type) {
      case "stream_event":
        return message.parent_tool_use_id ? [] : this.streamEvent(message, turnId);
      case "assistant":
        return message.parent_tool_use_id ? [] : this.assistant(message, turnId);
      case "user":
        return message.parent_tool_use_id ? [] : this.toolResults(message, turnId);
      case "system":
        if (message.subtype !== "compact_boundary") return [];
        return [
          this.event("compaction.completed", turnId, {
            tokensBefore: message.compact_metadata.pre_tokens,
            tokensAfter: message.compact_metadata.post_tokens,
            metadata: { trigger: message.compact_metadata.trigger },
          }),
        ];
      default:
        return [];
    }
  }

  /** Forgets per-turn bookkeeping once a turn has ended. */
  endTurn(): void {
    this.streamingMessageId = undefined;
    this.blocksSeen.clear();
    this.toolCalls.clear();
  }

  private streamEvent(message: SDKPartialAssistantMessage, turnId: string | undefined) {
    const event = message.event;
    if (event.type === "message_start") {
      this.streamingMessageId = event.message.id;
      return [];
    }
    if (event.type !== "content_block_delta" || !this.streamingMessageId) return [];
    const itemId = `${this.streamingMessageId}:${event.index}`;
    if (event.delta.type === "text_delta") {
      return [this.event("agent.message.delta", turnId, { itemId, delta: event.delta.text })];
    }
    if (event.delta.type === "thinking_delta") {
      return [this.event("agent.reasoning.delta", turnId, { itemId, delta: event.delta.thinking })];
    }
    return [];
  }

  private assistant(message: SDKAssistantMessage, turnId: string | undefined): RuntimeEvent[] {
    const messageId = message.message.id;
    const events: RuntimeEvent[] = [];
    // Claude Code delivers a message's blocks in order, possibly one block per SDK message.
    let index = this.blocksSeen.get(messageId) ?? 0;
    for (const block of message.message.content) {
      const itemId = `${messageId}:${index++}`;
      if (block.type === "text") {
        events.push(this.event("agent.message.completed", turnId, { itemId, text: block.text }));
      } else if (block.type === "thinking") {
        events.push(
          this.event("agent.reasoning.completed", turnId, { itemId, text: block.thinking }),
        );
      } else if (block.type === "tool_use") {
        events.push(...this.toolStarted(block.id, block.name, asRecord(block.input), turnId));
      }
    }
    this.blocksSeen.set(messageId, index);
    return events;
  }

  private toolStarted(
    itemId: string,
    name: string,
    input: Record<string, unknown>,
    turnId: string | undefined,
  ): RuntimeEvent[] {
    const kind = toolKind(name);
    this.toolCalls.set(itemId, { name, kind, input, startedAt: Date.now() });
    switch (kind.kind) {
      case "command":
        return [
          this.event("command.started", turnId, {
            itemId,
            command: String(input.command ?? ""),
            workdir: this.workspacePath,
          }),
        ];
      case "file_change":
        return [
          this.event("file_change.started", turnId, {
            itemId,
            path: filePath(input),
            kind: kind.change,
          }),
        ];
      case "plan":
        return [this.event("plan.updated", turnId, { planId: itemId, steps: planSteps(input) })];
      case "orchestrator":
        return [
          this.event("tool.call.started", turnId, {
            itemId,
            toolName: kind.orchestratorTool,
            args: input,
          }),
        ];
      case "mcp":
        return [
          this.event("mcp_call.started", turnId, {
            itemId,
            serverName: kind.serverName,
            toolName: kind.toolName,
            args: input,
          }),
        ];
      case "tool":
        return [this.event("tool.call.started", turnId, { itemId, toolName: name, args: input })];
    }
  }

  private toolResults(message: SDKUserMessage, turnId: string | undefined): RuntimeEvent[] {
    const content = message.message.content;
    if (typeof content === "string") return [];
    const events: RuntimeEvent[] = [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const call = this.toolCalls.get(block.tool_use_id);
      if (!call) continue;
      this.toolCalls.delete(block.tool_use_id);
      events.push(
        ...this.toolCompleted(
          block.tool_use_id,
          call,
          resultText(block.content),
          !!block.is_error,
          turnId,
        ),
      );
    }
    return events;
  }

  private toolCompleted(
    itemId: string,
    call: ToolCall,
    output: string,
    failed: boolean,
    turnId: string | undefined,
  ): RuntimeEvent[] {
    const durationMs = Date.now() - call.startedAt;
    const status = failed ? ("failure" as const) : ("success" as const);
    const outcome = failed ? { error: output } : { result: output };
    switch (call.kind.kind) {
      case "command":
        return [
          this.event("command.completed", turnId, {
            itemId,
            command: String(call.input.command ?? ""),
            exitCode: failed ? 1 : 0,
            output,
            durationMs,
          }),
        ];
      case "file_change":
        return [
          this.event("file_change.completed", turnId, {
            itemId,
            path: filePath(call.input),
            kind: call.kind.change,
            ...(failed ? { metadata: { status, error: output } } : {}),
          }),
        ];
      case "plan":
        return [];
      case "orchestrator":
        return [
          this.event("tool.called", turnId, {
            itemId,
            toolName: call.kind.orchestratorTool,
            args: call.input,
            status,
            ...outcome,
            durationMs,
          }),
        ];
      case "mcp":
        return [
          this.event("mcp_call.completed", turnId, {
            itemId,
            serverName: call.kind.serverName,
            toolName: call.kind.toolName,
            status,
            ...outcome,
            durationMs,
          }),
        ];
      case "tool":
        return [
          this.event("tool.called", turnId, {
            itemId,
            toolName: call.name,
            args: call.input,
            status,
            ...outcome,
            durationMs,
          }),
        ];
    }
  }

  private event<K extends RuntimeEvent["type"]>(
    type: K,
    turnId: string | undefined,
    payload: Extract<RuntimeEvent, { type: K }>["payload"],
  ): RuntimeEvent {
    return { type, sessionId: this.sessionId, turnId, payload } as RuntimeEvent;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function filePath(input: Record<string, unknown>): string {
  return String(input.file_path ?? input.notebook_path ?? "");
}

function planSteps(input: Record<string, unknown>): PlanStepItem[] {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos.map((todo, index) => {
    const item = asRecord(todo);
    const status = item.status;
    return {
      id: String(index),
      title: String(item.content ?? ""),
      status: status === "in_progress" || status === "completed" ? status : "pending",
    };
  });
}

/** Tool results are a string or a list of content blocks; only their text is kept. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (asRecord(block).type === "text" ? String(asRecord(block).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}
