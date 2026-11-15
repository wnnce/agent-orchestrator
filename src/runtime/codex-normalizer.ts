import type {
  AgentMessageDeltaPayload,
  AgentMessageCompletedPayload,
  AgentReasoningDeltaPayload,
  AgentReasoningCompletedPayload,
  CommandStartedPayload,
  CommandOutputPayload,
  CommandCompletedPayload,
  FileChangeStartedPayload,
  FileChangeCompletedPayload,
  McpCallStartedPayload,
  McpCallCompletedPayload,
  ApprovalRequestedPayload,
  TurnCompletedPayload,
  RuntimeUnmappedPayload,
} from "../domain/events.ts";
import type { RuntimeEvent } from "./runtime.ts";

function object(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null ? (value as Record<string, any>) : {};
}

/**
 * Extracts the final plain-text response text by scanning turn items in reverse
 */
export function extractFinalTextFromTurnItems(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it || typeof it !== "object") continue;
    const itemType = String(it.type ?? "");
    if (
      itemType === "agentMessage" ||
      itemType === "agent_message" ||
      typeof it.text === "string"
    ) {
      if (typeof it.text === "string" && it.text.trim()) {
        return it.text;
      }
      if (Array.isArray(it.content)) {
        const textObj = it.content.find(
          (c: any) => c && typeof c === "object" && typeof c.text === "string",
        );
        if (textObj && typeof textObj.text === "string" && textObj.text.trim()) {
          return textObj.text;
        }
      }
    }
  }
  return undefined;
}

/**
 * Normalizes private JSON-RPC messages from Codex app-server into canonical domain events
 */
export function normalizeCodexMessage(
  method: string,
  params: Record<string, any>,
  sessionId: string,
): RuntimeEvent {
  const turn = object(params.turn);
  const turnId =
    typeof turn.id === "string"
      ? turn.id
      : typeof params.turnId === "string"
        ? params.turnId
        : undefined;

  const item = object(params.item);
  const itemType = typeof item.type === "string" ? item.type : undefined;

  // 1. turn/completed (final status handling and response extraction)
  if (method === "turn/completed" || method === "turn.completed") {
    const rawStatus = String(turn.status ?? params.status ?? "completed");
    const status: "completed" | "failed" | "interrupted" =
      rawStatus === "failed"
        ? "failed"
        : rawStatus === "interrupted"
          ? "interrupted"
          : "completed";
    const eventType =
      status === "failed"
        ? "turn.failed"
        : status === "interrupted"
          ? "turn.interrupted"
          : "turn.completed";
    const finalText = extractFinalTextFromTurnItems(turn.items ?? params.items);
    const errorMsg =
      typeof turn.error === "string"
        ? turn.error
        : typeof turn.error?.message === "string"
          ? turn.error.message
          : typeof params.error === "string"
            ? params.error
            : undefined;

    const payload: TurnCompletedPayload = {
      turnId: turnId ?? "",
      status,
      runtimeTurnId: typeof turn.id === "string" ? turn.id : undefined,
      finalText,
      error: errorMsg,
      metadata: {
        rawStatus,
        itemCount: Array.isArray(turn.items) ? turn.items.length : 0,
      },
    };
    return { type: eventType, sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 2. item/agentMessage/delta (streaming text delta)
  if (method === "item/agentMessage/delta" || method === "item.agentMessage.delta") {
    const delta = String(params.delta ?? params.text ?? item.text ?? "");
    const itemId = String(params.itemId ?? item.id ?? `txt_${Date.now()}`);
    const payload: AgentMessageDeltaPayload = {
      itemId,
      delta,
      metadata: params.metadata ? object(params.metadata) : undefined,
    };
    return { type: "agent.message.delta", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 3. item/agentMessage or item/completed (text message completed)
  if (
    method === "item/agentMessage" ||
    (method === "item/completed" && (itemType === "agent_message" || itemType === "agentMessage"))
  ) {
    const itemId = String(item.id ?? params.itemId ?? `txt_${Date.now()}`);
    let text =
      typeof item.text === "string"
        ? item.text
        : typeof params.text === "string"
          ? params.text
          : "";
    if (!text && Array.isArray(item.content)) {
      const textItem = item.content.find((c: any) => c && typeof c.text === "string");
      if (textItem) text = textItem.text;
    }
    const payload: AgentMessageCompletedPayload = {
      itemId,
      text,
      metadata: {
        rawItemType: itemType,
      },
    };
    return { type: "agent.message.completed", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 4. item/reasoning/textDelta (reasoning streaming delta)
  if (
    method === "item/reasoning/textDelta" ||
    method === "item.reasoning.textDelta" ||
    (method === "item/reasoning" && (params.delta || params.text))
  ) {
    const delta = String(params.delta ?? params.text ?? "");
    const itemId = String(params.itemId ?? item.id ?? `reas_${Date.now()}`);
    const payload: AgentReasoningDeltaPayload = {
      itemId,
      delta,
    };
    return { type: "agent.reasoning.delta", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 5. item/reasoning or item/completed (reasoning process completed)
  if (
    method === "item/reasoning" ||
    (method === "item/completed" && itemType === "reasoning")
  ) {
    const itemId = String(item.id ?? params.itemId ?? `reas_${Date.now()}`);
    const text =
      typeof params.text === "string"
        ? params.text
        : Array.isArray(item.content)
          ? item.content.join("\n")
          : Array.isArray(item.summary)
            ? item.summary.join("\n")
            : String(item.text ?? "");
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : undefined;
    const payload: AgentReasoningCompletedPayload = {
      itemId,
      text,
      summary,
    };
    return { type: "agent.reasoning.completed", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 6. item/started (command started)
  if (
    method === "command.started" ||
    (method === "item/started" && (itemType === "command_execution" || itemType === "commandExecution"))
  ) {
    const itemId = String(item.id ?? params.itemId ?? `cmd_${Date.now()}`);
    const command = String(item.command ?? params.command ?? "");
    const workdir = item.workdir ? String(item.workdir) : undefined;
    const payload: CommandStartedPayload = {
      itemId,
      command,
      workdir,
    };
    return { type: "command.started", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 7. item/commandExecution/outputDelta (command output delta)
  if (
    method === "item/commandExecution/outputDelta" ||
    method === "command.output" ||
    method === "item.commandExecution.outputDelta"
  ) {
    const itemId = String(params.itemId ?? item.id ?? `cmd_${Date.now()}`);
    const delta = String(params.delta ?? params.output ?? "");
    const payload: CommandOutputPayload = {
      itemId,
      delta,
      stream: "stdout",
    };
    return { type: "command.output", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 8. item/completed (command completed)
  if (
    method === "command.completed" ||
    (method === "item/completed" && (itemType === "command_execution" || itemType === "commandExecution"))
  ) {
    const itemId = String(item.id ?? params.itemId ?? `cmd_${Date.now()}`);
    const command = String(item.command ?? params.command ?? "");
    const exitCode =
      typeof item.exitCode === "number"
        ? item.exitCode
        : typeof params.exitCode === "number"
          ? params.exitCode
          : 0;
    const output = String(item.output ?? params.output ?? "");
    const durationMs = typeof item.durationMs === "number" ? item.durationMs : undefined;
    const payload: CommandCompletedPayload = {
      itemId,
      command,
      exitCode,
      output,
      durationMs,
    };
    return { type: "command.completed", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 9. item/started (file change started)
  if (
    method === "file_change.started" ||
    (method === "item/started" && (itemType === "file_change" || itemType === "fileChange"))
  ) {
    const itemId = String(item.id ?? params.itemId ?? `file_${Date.now()}`);
    const path = String(item.path ?? params.path ?? "");
    const kind = (item.kind as any) ?? "modify";
    const payload: FileChangeStartedPayload = {
      itemId,
      path,
      kind,
    };
    return { type: "file_change.started", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 10. item/completed (file change completed) or item/fileChange
  if (
    method === "item/fileChange" ||
    method === "file_change.completed" ||
    (method === "item/completed" && (itemType === "file_change" || itemType === "fileChange"))
  ) {
    const itemId = String(item.id ?? params.itemId ?? `file_${Date.now()}`);
    const path = String(item.path ?? params.path ?? "");
    const kind = (item.kind as any) ?? "modify";
    const diff = item.diff ? String(item.diff) : params.diff ? String(params.diff) : undefined;
    const totalLinesAdded =
      typeof item.totalLinesAdded === "number" ? item.totalLinesAdded : undefined;
    const totalLinesRemoved =
      typeof item.totalLinesRemoved === "number" ? item.totalLinesRemoved : undefined;
    const payload: FileChangeCompletedPayload = {
      itemId,
      path,
      kind,
      diff,
      totalLinesAdded,
      totalLinesRemoved,
    };
    return { type: "file_change.completed", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 11. item/started (MCP tool call started)
  if (
    method === "mcp_call.started" ||
    (method === "item/started" && (itemType === "mcp_tool_call" || itemType === "mcpToolCall"))
  ) {
    const itemId = String(item.id ?? params.itemId ?? `mcp_${Date.now()}`);
    const serverName = String(item.server ?? item.serverName ?? params.server ?? "mcp");
    const toolName = String(item.tool ?? item.toolName ?? params.tool ?? "");
    const args = object(item.arguments ?? item.args ?? params.arguments ?? {});
    const payload: McpCallStartedPayload = {
      itemId,
      serverName,
      toolName,
      args,
    };
    return { type: "mcp_call.started", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 12. item/completed (MCP tool call completed) or item/mcpToolCall
  if (
    method === "item/mcpToolCall" ||
    method === "mcp_call.completed" ||
    (method === "item/completed" && (itemType === "mcp_tool_call" || itemType === "mcpToolCall"))
  ) {
    const itemId = String(item.id ?? params.itemId ?? `mcp_${Date.now()}`);
    const serverName = String(item.server ?? item.serverName ?? params.server ?? "mcp");
    const toolName = String(item.tool ?? item.toolName ?? params.tool ?? "");
    const isError = Boolean(item.error || params.error);
    const payload: McpCallCompletedPayload = {
      itemId,
      serverName,
      toolName,
      status: isError ? "failure" : "success",
      result: item.result ?? params.result,
      error: item.error ? String(item.error) : params.error ? String(params.error) : undefined,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
    };
    return { type: "mcp_call.completed", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 13. approval/requested (approval requested)
  if (method === "approval/requested" || method === "approval.requested") {
    const requestId = String(params.requestId ?? params.id ?? "");
    const actionType = (params.actionType as any) ?? (params.command ? "command" : "custom");
    const description = String(params.description ?? params.reason ?? "Action approval required");
    const payload: ApprovalRequestedPayload = {
      requestId,
      actionType,
      description,
      payload: object(params.payload ?? params),
    };
    return { type: "approval.requested", sessionId, ...(turnId ? { turnId } : {}), payload };
  }

  // 14. Fallback for unmapped methods to prevent event loss without breaking canonical type safety
  const payload: RuntimeUnmappedPayload = {
    metadata: {
      rawMethod: method,
      raw: params,
    },
  };
  return {
    type: "runtime.unmapped",
    sessionId,
    ...(turnId ? { turnId } : {}),
    payload,
  };
}
