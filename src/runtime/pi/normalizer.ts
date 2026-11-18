import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../runtime.ts";

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
        const sub = event.assistantMessageEvent;
        const msg = event.message as any;
        const itemId = msg?.id ?? `msg_${Date.now()}`;

        if (sub.type === "text_delta") {
          events.push({
            type: "agent.message.delta",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: {
              itemId,
              delta: sub.delta,
              text: sub.delta,
            },
          });
        } else if (sub.type === "thinking_delta") {
          events.push({
            type: "agent.reasoning.delta",
            sessionId,
            ...(turnId ? { turnId } : {}),
            payload: {
              itemId,
              delta: sub.delta,
              text: sub.delta,
            },
          });
        }
        break;
      }

      // 2. Completed messages (final assistant text and reasoning)
      case "message_end": {
        const message = event.message as any;
        if (!message) break;
        const itemId = message.id ?? `msg_${Date.now()}`;

        if (message.role === "assistant" && Array.isArray(message.content)) {
          const text = message.content
            .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("");

          if (text) {
            events.push({
              type: "agent.message.completed",
              sessionId,
              ...(turnId ? { turnId } : {}),
              payload: {
                itemId,
                text,
              },
            });
          }

          const thinking = message.content
            .filter((c: any) => c && c.type === "thinking" && typeof c.thinking === "string")
            .map((c: any) => c.thinking)
            .join("");

          if (thinking) {
            events.push({
              type: "agent.reasoning.completed",
              sessionId,
              ...(turnId ? { turnId } : {}),
              payload: {
                itemId,
                text: thinking,
              },
            });
          }
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
        .map((c: any) => (c && typeof c.text === "string" ? c.text : ""))
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
