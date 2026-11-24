import type { FileChangeCompletedPayload } from "../../domain/events.ts";
import type { TurnUsage } from "../../domain/types.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { PatchChangeKind } from "./generated/v2/PatchChangeKind.ts";
import type { ThreadItem } from "./generated/v2/ThreadItem.ts";
import type { Turn } from "./generated/v2/Turn.ts";
import type { RuntimeEvent } from "../runtime.ts";

type ItemOf<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>;

/** The thread a notification belongs to, when it belongs to one. */
export function notificationThreadId(notification: ServerNotification): string | undefined {
  const params = notification.params as { threadId?: unknown } | undefined;
  return typeof params?.threadId === "string" ? params.threadId : undefined;
}

/** The text of the last agent message in a turn: the turn's final answer. */
export function finalTextOfTurn(turn: Turn): string | undefined {
  const message = turn.items.findLast(
    (item): item is ItemOf<"agentMessage"> => item.type === "agentMessage" && !!item.text.trim(),
  );
  return message?.text;
}

/**
 * Maps one app-server notification to canonical events. Notifications that carry nothing the
 * orchestrator models (token usage, rate limits, realtime audio, ...) map to no events.
 */
export function normalizeCodexNotification(
  notification: ServerNotification,
  sessionId: string,
  turnUsage?: TurnUsage,
): RuntimeEvent[] {
  switch (notification.method) {
    case "turn/completed": {
      const { turn } = notification.params;
      const status =
        turn.status === "failed" || turn.status === "interrupted" ? turn.status : "completed";
      return [
        {
          type: `turn.${status}`,
          sessionId,
          turnId: turn.id,
          payload: {
            turnId: turn.id,
            runtimeTurnId: turn.id,
            status,
            finalText: finalTextOfTurn(turn),
            error: turn.error?.message,
            durationMs: turn.durationMs ?? undefined,
            ...(turnUsage ? { usage: turnUsage } : {}),
          },
        },
      ];
    }
    case "item/agentMessage/delta": {
      const { turnId, itemId, delta } = notification.params;
      return [{ type: "agent.message.delta", sessionId, turnId, payload: { itemId, delta } }];
    }
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta": {
      const { turnId, itemId, delta } = notification.params;
      return [{ type: "agent.reasoning.delta", sessionId, turnId, payload: { itemId, delta } }];
    }
    case "item/commandExecution/outputDelta": {
      const { turnId, itemId, delta } = notification.params;
      return [{ type: "command.output", sessionId, turnId, payload: { itemId, delta } }];
    }
    case "item/started":
      return itemStarted(notification.params.item, sessionId, notification.params.turnId);
    case "item/completed":
      return itemCompleted(notification.params.item, sessionId, notification.params.turnId);
    case "thread/compacted":
      return [{ type: "compaction.completed", sessionId, payload: {} }];
    default:
      return [];
  }
}

function itemStarted(item: ThreadItem, sessionId: string, turnId: string): RuntimeEvent[] {
  switch (item.type) {
    case "commandExecution":
      return [
        {
          type: "command.started",
          sessionId,
          turnId,
          payload: { itemId: item.id, command: item.command, workdir: item.cwd },
        },
      ];
    case "fileChange":
      return item.changes.map((change, index) => ({
        type: "file_change.started",
        sessionId,
        turnId,
        payload: {
          itemId: `${item.id}:${index}`,
          path: change.path,
          kind: changeKind(change.kind),
        },
      }));
    case "mcpToolCall":
      return [
        {
          type: "mcp_call.started",
          sessionId,
          turnId,
          payload: {
            itemId: item.id,
            serverName: item.server,
            toolName: item.tool,
            args: asRecord(item.arguments),
          },
        },
      ];
    default:
      return [];
  }
}

function itemCompleted(item: ThreadItem, sessionId: string, turnId: string): RuntimeEvent[] {
  switch (item.type) {
    case "agentMessage":
      return [
        {
          type: "agent.message.completed",
          sessionId,
          turnId,
          payload: { itemId: item.id, text: item.text },
        },
      ];
    case "reasoning":
      return [
        {
          type: "agent.reasoning.completed",
          sessionId,
          turnId,
          payload: {
            itemId: item.id,
            text: item.content.join("\n"),
            summary: item.summary.join("\n"),
          },
        },
      ];
    case "commandExecution":
      return [
        {
          type: "command.completed",
          sessionId,
          turnId,
          payload: {
            itemId: item.id,
            command: item.command,
            exitCode: item.exitCode ?? (item.status === "completed" ? 0 : 1),
            output: item.aggregatedOutput ?? "",
            durationMs: item.durationMs ?? undefined,
          },
        },
      ];
    case "fileChange":
      return item.changes.map((change, index) => {
        const payload: FileChangeCompletedPayload = {
          itemId: `${item.id}:${index}`,
          path: change.path,
          kind: changeKind(change.kind),
          diff: change.diff,
        };
        return { type: "file_change.completed", sessionId, turnId, payload };
      });
    case "mcpToolCall":
      return [
        {
          type: "mcp_call.completed",
          sessionId,
          turnId,
          payload: {
            itemId: item.id,
            serverName: item.server,
            toolName: item.tool,
            status: item.error ? "failure" : "success",
            result: item.result ?? undefined,
            error: item.error?.message,
            durationMs: item.durationMs ?? undefined,
          },
        },
      ];
    default:
      return [];
  }
}

function changeKind(kind: PatchChangeKind): "create" | "modify" | "delete" {
  if (kind.type === "add") return "create";
  if (kind.type === "delete") return "delete";
  return "modify";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
