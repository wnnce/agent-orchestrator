import type {
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { PlanStepItem } from "../../domain/events.ts";
import type { RuntimeEvent } from "../runtime.ts";

interface TrackedToolCall {
  readonly id: string;
  name: string;
  kind: ToolKind | undefined;
  title: string;
  args: Record<string, unknown>;
  started: boolean;
  finished: boolean;
  mcp?: { serverName: string; toolName: string } | undefined;
  command?: string | undefined;
  filePath?: string | undefined;
  fileKind?: "create" | "modify" | "delete" | undefined;
}

const MCP_TOOL_PREFIX = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/;

function parseMcpToolName(name: string | null | undefined): { serverName: string; toolName: string } | undefined {
  if (!name) return undefined;
  const match = MCP_TOOL_PREFIX.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  return { serverName: match[1], toolName: match[2] };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractToolText(
  content: readonly ToolCallContent[] | null | undefined,
  rawOutput: unknown,
): string {
  const parts: string[] = [];
  if (content) {
    for (const entry of content) {
      if (entry.type === "content" && entry.content.type === "text") {
        parts.push(entry.content.text);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");
  const raw = asRecord(rawOutput);
  if (typeof raw.output === "string") return raw.output;
  if (typeof raw.text === "string") return raw.text;
  if (typeof rawOutput === "string") return rawOutput;
  return "";
}

function extractDiff(content: readonly ToolCallContent[] | null | undefined): string | undefined {
  if (!content) return undefined;
  for (const entry of content) {
    if (entry.type === "diff") {
      return entry.oldText != null
        ? `--- ${entry.path}\n+++ ${entry.path}\n@@\n-${entry.oldText}\n+${entry.newText}`
        : `+++ ${entry.path}\n${entry.newText}`;
    }
  }
  return undefined;
}

function extractFilePath(
  locations: readonly ToolCallLocation[] | null | undefined,
  content: readonly ToolCallContent[] | null | undefined,
  args: Record<string, unknown>,
  fallback: string,
): string {
  const firstLocation = locations?.[0]?.path;
  if (firstLocation) return firstLocation;
  if (content) {
    for (const entry of content) {
      if (entry.type === "diff" && entry.path) return entry.path;
    }
  }
  for (const key of ["path", "filePath", "file_path", "TargetFile", "AbsolutePath"]) {
    const val = args[key];
    if (typeof val === "string" && val) return val;
  }
  return fallback;
}

function extractCommand(args: Record<string, unknown>, fallbackTitle: string): string {
  for (const key of ["command", "CommandLine", "cmd"]) {
    const val = args[key];
    if (typeof val === "string" && val) return val;
  }
  return fallbackTitle;
}

function mapPlanStatus(status: PlanEntry["status"]): PlanStepItem["status"] {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    default:
      return "pending";
  }
}

function mapFileChangeKind(kind: ToolKind | undefined): "create" | "modify" | "delete" {
  return kind === "delete" ? "delete" : "modify";
}

/**
 * Converts ACP `session/update` notifications into canonical `RuntimeEvent`s for one session.
 */
export class ACPNormalizer {
  private openMessageId: string | undefined;
  private openMessageText = "";
  private openReasoningId: string | undefined;
  private openReasoningText = "";
  private readonly toolCalls = new Map<string, TrackedToolCall>();

  /** Normalizes a single ACP `SessionUpdate` notification into zero or more canonical events. */
  normalize(update: SessionUpdate, sessionId: string, turnId?: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];

    switch (update.sessionUpdate) {
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return events;
        this.closeMessage(events, sessionId, turnId);
        if (!this.openReasoningId) {
          this.openReasoningId = `acp_reason_${crypto.randomUUID()}`;
        }
        const itemId = this.openReasoningId;
        const delta = update.content.text;
        this.openReasoningText += delta;
        events.push({
          type: "agent.reasoning.delta",
          sessionId,
          turnId,
          payload: { itemId, delta },
        });
        return events;
      }

      case "agent_message_chunk": {
        if (update.content.type !== "text") return events;
        this.closeReasoning(events, sessionId, turnId);
        if (!this.openMessageId) {
          this.openMessageId = `acp_msg_${crypto.randomUUID()}`;
        }
        const itemId = this.openMessageId;
        const delta = update.content.text;
        this.openMessageText += delta;
        events.push({
          type: "agent.message.delta",
          sessionId,
          turnId,
          payload: { itemId, delta },
        });
        return events;
      }

      case "plan": {
        events.push({
          type: "plan.updated",
          sessionId,
          turnId,
          payload: {
            steps: update.entries.map((entry, idx) => ({
              id: `step_${idx + 1}`,
              title: entry.content,
              status: mapPlanStatus(entry.status),
            })),
          },
        });
        return events;
      }

      case "tool_call":
      case "tool_call_update": {
        this.closeOpenStreams(events, sessionId, turnId);
        this.handleToolUpdate(update, events, sessionId, turnId);
        return events;
      }

      case "compaction_update": {
        if (update.status === "completed") {
          events.push({
            type: "compaction.completed",
            sessionId,
            turnId,
            payload: {},
          });
        }
        return events;
      }

      case "user_message_chunk":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
      case "notice":
      default:
        return events;
    }
  }

  /** Flushes any open reasoning or message stream before a turn terminates. */
  flush(sessionId: string, turnId?: string): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    this.closeOpenStreams(events, sessionId, turnId);
    this.toolCalls.clear();
    return events;
  }

  /** Returns the accumulated text of the currently open assistant message (if any). */
  currentMessageText(): string {
    return this.openMessageText;
  }

  private closeOpenStreams(events: RuntimeEvent[], sessionId: string, turnId?: string): void {
    this.closeReasoning(events, sessionId, turnId);
    this.closeMessage(events, sessionId, turnId);
  }

  private closeReasoning(events: RuntimeEvent[], sessionId: string, turnId?: string): void {
    if (!this.openReasoningId) return;
    events.push({
      type: "agent.reasoning.completed",
      sessionId,
      turnId,
      payload: { itemId: this.openReasoningId, text: this.openReasoningText },
    });
    this.openReasoningId = undefined;
    this.openReasoningText = "";
  }

  private closeMessage(events: RuntimeEvent[], sessionId: string, turnId?: string): void {
    if (!this.openMessageId) return;
    events.push({
      type: "agent.message.completed",
      sessionId,
      turnId,
      payload: { itemId: this.openMessageId, text: this.openMessageText },
    });
    this.openMessageId = undefined;
    this.openMessageText = "";
  }

  private handleToolUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
    events: RuntimeEvent[],
    sessionId: string,
    turnId?: string,
  ): void {
    const id = update.toolCallId;
    const rawArgs = asRecord(update.rawInput);
    const existing = this.toolCalls.get(id);
    const name =
      (typeof update.name === "string" && update.name) || existing?.name || update.title || "tool";
    const kind = update.kind ?? existing?.kind;
    const title = update.title ?? existing?.title ?? name;
    const args = Object.keys(rawArgs).length > 0 ? rawArgs : (existing?.args ?? {});
    const mcp = existing?.mcp ?? parseMcpToolName(name);

    const tracked: TrackedToolCall = existing ?? {
      id,
      name,
      kind,
      title,
      args,
      started: false,
      finished: false,
      mcp,
    };
    tracked.name = name;
    tracked.kind = kind;
    tracked.title = title;
    tracked.args = args;
    tracked.mcp = mcp;
    this.toolCalls.set(id, tracked);

    const status = update.status ?? "in_progress";

    if (!tracked.started) {
      tracked.started = true;
      if (tracked.mcp) {
        events.push({
          type: "mcp_call.started",
          sessionId,
          turnId,
          payload: {
            itemId: id,
            serverName: tracked.mcp.serverName,
            toolName: tracked.mcp.toolName,
            args,
          },
        });
      } else if (kind === "execute") {
        tracked.command = extractCommand(args, title);
        events.push({
          type: "command.started",
          sessionId,
          turnId,
          payload: { itemId: id, command: tracked.command },
        });
      } else if (kind === "edit" || kind === "delete" || kind === "move") {
        tracked.filePath = extractFilePath(update.locations, update.content, args, title);
        tracked.fileKind = mapFileChangeKind(kind);
        events.push({
          type: "file_change.started",
          sessionId,
          turnId,
          payload: { itemId: id, path: tracked.filePath, kind: tracked.fileKind },
        });
      } else {
        events.push({
          type: "tool.call.started",
          sessionId,
          turnId,
          payload: { itemId: id, toolName: name, args },
        });
      }
    }

    if ((status === "completed" || status === "failed") && !tracked.finished) {
      tracked.finished = true;
      const isFailure = status === "failed";
      const outputText = extractToolText(update.content, update.rawOutput);
      const rawOut = asRecord(update.rawOutput);

      if (tracked.mcp) {
        events.push({
          type: "mcp_call.completed",
          sessionId,
          turnId,
          payload: {
            itemId: id,
            serverName: tracked.mcp.serverName,
            toolName: tracked.mcp.toolName,
            status: isFailure ? "failure" : "success",
            ...(outputText ? { result: outputText } : update.rawOutput !== undefined ? { result: update.rawOutput } : {}),
            ...(isFailure && outputText ? { error: outputText } : {}),
          },
        });
      } else if (kind === "execute") {
        const exitCode =
          typeof rawOut.exit_code === "number"
            ? rawOut.exit_code
            : typeof rawOut.exitCode === "number"
              ? rawOut.exitCode
              : isFailure
                ? 1
                : 0;
        events.push({
          type: "command.completed",
          sessionId,
          turnId,
          payload: {
            itemId: id,
            command: tracked.command ?? extractCommand(args, title),
            exitCode,
            output: outputText,
          },
        });
      } else if (kind === "edit" || kind === "delete" || kind === "move") {
        const diff = extractDiff(update.content);
        events.push({
          type: "file_change.completed",
          sessionId,
          turnId,
          payload: {
            itemId: id,
            path: tracked.filePath ?? extractFilePath(update.locations, update.content, args, title),
            kind: tracked.fileKind ?? mapFileChangeKind(kind),
            ...(diff !== undefined ? { diff } : {}),
          },
        });
      } else {
        events.push({
          type: "tool.called",
          sessionId,
          turnId,
          payload: {
            itemId: id,
            toolName: name,
            args,
            status: isFailure ? "failure" : "success",
            ...(outputText ? { result: outputText } : update.rawOutput !== undefined ? { result: update.rawOutput } : {}),
            ...(isFailure && outputText ? { error: outputText } : {}),
          },
        });
      }
    }
  }
}
