import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RuntimeEvent } from "../runtime.ts";

/** The assistant message an event carries, if it carries one. */
export function asAssistantMessage(message: unknown): AssistantMessage | undefined {
  const candidate = message as Partial<AssistantMessage> | undefined;
  return candidate?.role === "assistant" && Array.isArray(candidate.content)
    ? (candidate as AssistantMessage)
    : undefined;
}

/** The text blocks of an assistant message, joined. */
export function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** An item id that stays the same across a message's streaming updates and its end event. */
function messageItemId(message: AssistantMessage): string {
  return `msg_${message.timestamp}`;
}

/**
 * Normalizes Pi Agent native session events into Agent Orchestrator canonical domain events.
 */
export class PiNormalizer {
  /**
   * Translates a single Pi AgentSessionEvent into zero, one, or more canonical RuntimeEvents.
   */
  static normalize(
    event: AgentSessionEvent,
    sessionId: string,
    turnId?: string | undefined,
  ): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];

    switch (event.type) {
      // 1. Streaming message deltas (text and thinking/reasoning)
      case "message_update": {
        const message = asAssistantMessage(event.message);
        const sub = event.assistantMessageEvent;
        if (!message) break;
        const itemId = messageItemId(message);
        if (sub.type === "text_delta") {
          events.push({
            type: "agent.message.delta",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: { itemId, delta: sub.delta },
          });
        } else if (sub.type === "thinking_delta") {
          events.push({
            type: "agent.reasoning.delta",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: { itemId, delta: sub.delta },
          });
        }
        break;
      }

      // 2. Completed messages (final assistant text and reasoning)
      case "message_end": {
        const message = asAssistantMessage(event.message);
        if (!message) break;
        const itemId = messageItemId(message);
        const text = assistantText(message);
        if (text) {
          events.push({
            type: "agent.message.completed",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: { itemId, text },
          });
        }
        const thinking = message.content
          .flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
          .join("");
        if (thinking) {
          events.push({
            type: "agent.reasoning.completed",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: { itemId, text: thinking },
          });
        }
        break;
      }

      // 3. Tool execution start
      case "tool_execution_start": {
        const { toolCallId, toolName, args } = event;
        const safeArgs =
          typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};

        if (toolName === "bash") {
          const command = typeof safeArgs.command === "string" ? safeArgs.command : "";
          const workdir = typeof safeArgs.cwd === "string" ? safeArgs.cwd : undefined;
          events.push({
            type: "command.started",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: {
              itemId: toolCallId,
              command,
              workdir,
            },
          });
        } else if (toolName === "write" || toolName === "edit") {
          const filePath = typeof safeArgs.path === "string" ? safeArgs.path : "";
          events.push({
            type: "file_change.started",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: {
              itemId: toolCallId,
              path: filePath,
              kind: toolName === "write" ? "create" : "modify",
            },
          });
        }

        // Generic tool call started
        events.push({
          type: "tool.call.started",
          sessionId,
          ...(turnId ? { turnId } : {}),
          payload: {
            itemId: toolCallId,
            toolName,
            args: safeArgs,
          },
        });
        break;
      }

      // 4. Tool execution end
      case "tool_execution_end": {
        const { toolCallId, toolName, result, isError, durationMs } = event;
        const output = extractTextContent(result);

        if (toolName === "bash") {
          events.push({
            type: "command.completed",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: {
              itemId: toolCallId,
              command: "",
              exitCode: isError ? 1 : 0,
              output,
              durationMs,
            },
          });
        } else if (toolName === "write" || toolName === "edit") {
          events.push({
            type: "file_change.completed",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: {
              itemId: toolCallId,
              path: "",
              kind: toolName === "write" ? "create" : "modify",
              diff: output,
            },
          });
        }

        // Generic tool call completed
        events.push({
          type: "tool.called",
          sessionId,
          ...(turnId ? { turnId } : {}),
          payload: {
            itemId: toolCallId,
            toolName,
            args: {},
            status: isError ? "failure" : "success",
            result,
            durationMs,
            error: isError ? output : undefined,
          },
        });
        break;
      }

      // 5. Compaction completed
      case "compaction_end": {
        if (!event.aborted) {
          events.push({
            type: "compaction.completed",
            sessionId,
            payload: {},
          });
        }
        break;
      }

      default:
        break;
    }

    return events;
  }
}

/**
 * Extracts a readable string from a tool result object or content array.
 */
export function extractTextContent(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;

  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      return obj.content
        .map((c) =>
          typeof (c as { text?: unknown })?.text === "string" ? (c as { text: string }).text : "",
        )
        .filter(Boolean)
        .join("\n");
    }
    if (typeof obj.output === "string") {
      return obj.output;
    }
    if (typeof obj.error === "string") {
      return obj.error;
    }
    return JSON.stringify(result);
  }

  return String(result);
}
