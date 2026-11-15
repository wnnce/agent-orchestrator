import type { ChatMessage, MessagePart, RuntimeEvent } from "../types";

export function ensureParts(msg: ChatMessage): MessagePart[] {
  if (!msg.parts) {
    msg.parts = [];
  }
  return msg.parts;
}

function isTurnContentEvent(type: string): boolean {
  return (
    type.startsWith("agent.") ||
    type.startsWith("command.") ||
    type.startsWith("tool.") ||
    type.startsWith("mcp_call.") ||
    type.startsWith("file_change.") ||
    type.startsWith("plan.")
  );
}

/**
 * Applies a single canonical runtime event to the current assistant message.
 * Updates both the chronological timeline `msg.parts` and the summary fields
 * (`msg.thinking`, `msg.commands`, `msg.content`) for display.
 */
export function applyEventToAssistantMessage(msg: ChatMessage, evt: RuntimeEvent): void {
  const parts = ensureParts(msg);
  const payload = (evt.payload as Record<string, any>) ?? {};

  switch (evt.type) {
    // 1. Streaming Reasoning
    case "agent.reasoning.delta": {
      const delta = String(payload.delta || "");
      if (!delta) return;
      const itemId = payload.itemId ? String(payload.itemId) : undefined;

      let target = itemId ? parts.find((p) => p.id === itemId && p.type === "reasoning") : undefined;
      if (!target) {
        target = parts.findLast((p) => p.type === "reasoning" && p.status === "streaming");
      }

      if (target && target.type === "reasoning") {
        target.content += delta;
        target.status = "streaming";
      } else {
        parts.push({
          id: itemId || `reas_${evt.sequence || Date.now()}`,
          type: "reasoning",
          content: delta,
          status: "streaming",
        });
      }

      msg.thinking = (msg.thinking || "") + delta;
      return;
    }

    // 2. Completed Reasoning
    case "agent.reasoning.completed": {
      const itemId = payload.itemId ? String(payload.itemId) : undefined;
      const text = typeof payload.text === "string" ? payload.text : "";

      let target = itemId ? parts.find((p) => p.id === itemId && p.type === "reasoning") : undefined;
      if (!target) {
        target = parts.findLast((p) => p.type === "reasoning" && p.status === "streaming");
      }

      if (target && target.type === "reasoning") {
        if (text) target.content = text;
        target.status = "completed";
      } else if (text) {
        parts.push({
          id: itemId || `reas_${evt.sequence || Date.now()}`,
          type: "reasoning",
          content: text,
          status: "completed",
        });
      }

      if (text && !msg.thinking) {
        msg.thinking = text;
      }
      return;
    }

    // 3. Streaming Assistant Text
    case "agent.message.delta": {
      const delta = String(payload.delta || "");
      if (!delta) return;
      const itemId = payload.itemId ? String(payload.itemId) : undefined;

      let target = itemId ? parts.find((p) => p.id === itemId && p.type === "text") : undefined;
      if (!target) {
        target = parts.findLast((p) => p.type === "text" && p.status === "streaming");
      }

      if (target && target.type === "text") {
        target.content += delta;
        target.status = "streaming";
      } else {
        parts.push({
          id: itemId || `txt_${evt.sequence || Date.now()}`,
          type: "text",
          content: delta,
          status: "streaming",
        });
      }

      msg.content = (msg.content || "") + delta;
      return;
    }

    // 4. Completed Assistant Text
    case "agent.message.completed": {
      const itemId = payload.itemId ? String(payload.itemId) : undefined;
      const text = String(payload.text || "");

      let target = itemId ? parts.find((p) => p.id === itemId && p.type === "text") : undefined;
      if (!target) {
        target = parts.findLast((p) => p.type === "text");
      }

      if (target && target.type === "text") {
        if (text) target.content = text;
        target.status = "completed";
      } else if (text) {
        parts.push({
          id: itemId || `txt_${evt.sequence || Date.now()}`,
          type: "text",
          content: text,
          status: "completed",
        });
      }

      if (text) {
        msg.content = text;
      }
      return;
    }

    // 5. Command Started
    case "command.started": {
      const itemId = String(payload.itemId || `cmd_${evt.sequence || Date.now()}`);
      const command = String(payload.command || "Executing shell command...");

      const existing = parts.find((p) => p.id === itemId && p.type === "command");
      if (!existing) {
        parts.push({
          id: itemId,
          type: "command",
          command,
          output: "",
          status: "running",
        });
      }

      if (!msg.commands) msg.commands = [];
      if (!msg.commands.find((c) => c.id === itemId)) {
        msg.commands.push({
          id: itemId,
          command,
          output: "",
          status: "running",
        });
      }
      return;
    }

    // 6. Command Output Streaming
    case "command.output": {
      const delta = String(payload.delta || "");
      if (!delta) return;
      const itemId = payload.itemId ? String(payload.itemId) : undefined;

      let target = itemId ? parts.find((p) => p.id === itemId && p.type === "command") : undefined;
      if (!target) {
        target = parts.findLast((p) => p.type === "command" && p.status === "running");
      }

      if (target && target.type === "command") {
        target.output += delta;
        target.status = "running";
      }

      if (msg.commands && msg.commands.length > 0) {
        const lastCmd = itemId
          ? msg.commands.find((c) => c.id === itemId) || msg.commands[msg.commands.length - 1]
          : msg.commands[msg.commands.length - 1];
        if (lastCmd) lastCmd.output += delta;
      }
      return;
    }

    // 7. Command Completed
    case "command.completed": {
      const itemId = String(payload.itemId || `cmd_${evt.sequence || Date.now()}`);
      const command = String(payload.command || "Executing shell command...");
      const output = typeof payload.output === "string" ? payload.output : "";
      const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : 0;
      const status: "completed" | "failed" = exitCode === 0 ? "completed" : "failed";

      let target = parts.find((p) => p.id === itemId && p.type === "command");
      if (target && target.type === "command") {
        if (output) target.output = output;
        target.status = status;
      } else {
        parts.push({
          id: itemId,
          type: "command",
          command,
          output,
          status,
        });
      }

      if (!msg.commands) msg.commands = [];
      const existingCmd = msg.commands.find((c) => c.id === itemId);
      if (existingCmd) {
        if (output) existingCmd.output = output;
        existingCmd.status = status;
      } else {
        msg.commands.push({
          id: itemId,
          command,
          output,
          status,
        });
      }
      return;
    }

    // 8. Tool Call Started
    case "mcp_call.started":
    case "tool.call.started": {
      const itemId = String(payload.itemId || payload.callId || `tool_${evt.sequence || Date.now()}`);
      const toolName = String(payload.toolName || "tool");
      const serverName = payload.serverName ? String(payload.serverName) : undefined;
      const args = payload.args || payload.parameters;

      const existing = parts.find((p) => p.id === itemId && p.type === "tool");
      if (!existing) {
        parts.push({
          id: itemId,
          type: "tool",
          toolName,
          serverName,
          args,
          status: "running",
        });
      }
      return;
    }

    // 9. Tool Call Completed
    case "mcp_call.completed":
    case "tool.called": {
      const itemId = String(payload.itemId || payload.callId || `tool_${evt.sequence || Date.now()}`);
      const toolName = String(payload.toolName || "tool");
      const serverName = payload.serverName ? String(payload.serverName) : undefined;
      const status = payload.status === "failure" || payload.error ? "failed" : "completed";
      const result = payload.result ?? payload.error;

      let target = parts.find((p) => p.id === itemId && p.type === "tool");
      if (target && target.type === "tool") {
        target.result = result;
        target.status = status;
      } else {
        parts.push({
          id: itemId,
          type: "tool",
          toolName,
          serverName,
          args: payload.args || payload.parameters,
          result,
          status,
        });
      }
      return;
    }

    // 10. Turn Final Status (Completed / Failed / Interrupted)
    case "turn.completed":
    case "turn.failed":
    case "turn.interrupted": {
      msg.status =
        evt.type === "turn.completed"
          ? "completed"
          : evt.type === "turn.interrupted"
            ? "interrupted"
            : "failed";

      const finalText = typeof payload.finalText === "string" ? payload.finalText.trim() : "";
      if (finalText) {
        msg.content = finalText;
        // Ensure parts array contains matching text part
        let textPart = parts.findLast((p) => p.type === "text");
        if (textPart && textPart.type === "text") {
          textPart.content = finalText;
          textPart.status = "completed";
        } else {
          parts.push({
            id: `txt_final_${evt.sequence || Date.now()}`,
            type: "text",
            content: finalText,
            status: "completed",
          });
        }
      }

      for (const part of parts) {
        if (part.type === "reasoning" || part.type === "text") {
          if (part.status === "streaming") {
            part.status = "completed";
          }
        } else if (part.type === "command" || part.type === "tool") {
          if (part.status === "running") {
            part.status = evt.type === "turn.completed" ? "completed" : "failed";
          }
        }
      }
      return;
    }
  }
}

/**
 * Reconstructs conversation messages from historical runtime events.
 */
export function reconstructMessagesFromEvents(events: RuntimeEvent[]): {
  messages: ChatMessage[];
  isRunning: boolean;
} {
  const messages: ChatMessage[] = [];

  for (const evt of events) {
    if (evt.type === "turn.queued") {
      const input = evt.payload?.input;
      if (typeof input === "string" && input.trim()) {
        messages.push({
          id: evt.payload?.turnId || `usr_${evt.sequence}`,
          role: "user",
          content: input,
          timestamp: new Date(evt.createdAt || Date.now()).getTime(),
        });
      }
    } else if (evt.type === "turn.started") {
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant" || last.status !== "streaming") {
        messages.push({
          id: `asst_${evt.payload?.turnId || evt.sequence}`,
          role: "assistant",
          content: "",
          parts: [],
          status: "streaming",
          timestamp: new Date(evt.createdAt || Date.now()).getTime(),
        });
      }
    } else if (
      evt.type === "turn.completed" ||
      evt.type === "turn.failed" ||
      evt.type === "turn.interrupted"
    ) {
      const last = messages.findLast((m) => m.role === "assistant");
      if (last) {
        applyEventToAssistantMessage(last, evt);
      }
    } else if (isTurnContentEvent(evt.type)) {
      // Append turn content events (reasoning, message, command, tool) to assistant message
      let asst = messages.findLast((m) => m.role === "assistant");
      if (!asst) {
        asst = {
          id: `asst_${evt.sequence}`,
          role: "assistant",
          content: "",
          parts: [],
          status: "streaming",
          timestamp: new Date(evt.createdAt || Date.now()).getTime(),
        };
        messages.push(asst);
      }
      applyEventToAssistantMessage(asst, evt);
    }
    // Meta events (session.*, mcpServer.*, notification.*) do not generate chat messages
  }

  const last = messages[messages.length - 1];
  const isRunning = last?.role === "assistant" && last.status === "streaming";
  return { messages, isRunning };
}
