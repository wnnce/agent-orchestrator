import { describe, expect, test } from "bun:test";
import {
  finalTextOfTurn,
  normalizeCodexNotification,
  notificationThreadId,
} from "../src/runtime/codex/normalizer.ts";
import type { ServerNotification } from "../src/runtime/codex/generated/ServerNotification.ts";
import type { ThreadItem } from "../src/runtime/codex/generated/v2/ThreadItem.ts";
import type { Turn } from "../src/runtime/codex/generated/v2/Turn.ts";

const THREAD = "thread-1";
const TURN = "turn-1";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: TURN,
    rootTurnId: null,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: 1200,
    ...overrides,
  } as Turn;
}

function agentMessage(id: string, text: string): ThreadItem {
  return {
    type: "agentMessage",
    id,
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
}

function normalize(notification: unknown) {
  return normalizeCodexNotification(notification as ServerNotification, THREAD);
}

describe("Codex notification normalizer", () => {
  test("reads the thread id of thread-scoped notifications", () => {
    const delta = {
      method: "item/agentMessage/delta",
      params: { threadId: THREAD, turnId: TURN, itemId: "m1", delta: "hi" },
    } as ServerNotification;
    expect(notificationThreadId(delta)).toBe(THREAD);
    expect(
      notificationThreadId({ method: "skills/changed", params: {} } as ServerNotification),
    ).toBeUndefined();
  });

  test("final text is the last non-empty agent message of the turn", () => {
    const items = [
      agentMessage("m1", "first"),
      agentMessage("m2", "final"),
      agentMessage("m3", " "),
    ];
    expect(finalTextOfTurn(turn({ items }))).toBe("final");
    expect(finalTextOfTurn(turn())).toBeUndefined();
  });

  test("turn/completed maps the turn status and final text", () => {
    const [completed] = normalize({
      method: "turn/completed",
      params: { threadId: THREAD, turn: turn({ items: [agentMessage("m1", "done")] }) },
    });
    expect(completed).toMatchObject({
      type: "turn.completed",
      turnId: TURN,
      payload: { status: "completed", finalText: "done", runtimeTurnId: TURN, durationMs: 1200 },
    });

    const [failed] = normalize({
      method: "turn/completed",
      params: {
        threadId: THREAD,
        turn: turn({
          status: "failed",
          error: {
            message: "quota exceeded",
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null,
          },
        }),
      },
    });
    expect(failed).toMatchObject({ type: "turn.failed", payload: { error: "quota exceeded" } });

    const [interrupted] = normalize({
      method: "turn/completed",
      params: { threadId: THREAD, turn: turn({ status: "interrupted" }) },
    });
    expect(interrupted?.type).toBe("turn.interrupted");
  });

  test("streams message, reasoning and command output deltas", () => {
    const params = { threadId: THREAD, turnId: TURN, itemId: "i1", delta: "x" };
    expect(normalize({ method: "item/agentMessage/delta", params })[0]).toMatchObject({
      type: "agent.message.delta",
      payload: { itemId: "i1", delta: "x" },
    });
    expect(
      normalize({ method: "item/reasoning/textDelta", params: { ...params, contentIndex: 0 } })[0]
        ?.type,
    ).toBe("agent.reasoning.delta");
    expect(
      normalize({
        method: "item/reasoning/summaryTextDelta",
        params: { ...params, summaryIndex: 0 },
      })[0]?.type,
    ).toBe("agent.reasoning.delta");
    expect(normalize({ method: "item/commandExecution/outputDelta", params })[0]?.type).toBe(
      "command.output",
    );
  });

  test("command execution start and completion", () => {
    const command = {
      type: "commandExecution",
      id: "c1",
      command: "bun test",
      cwd: "/work",
      status: "completed",
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 40,
    };
    const base = { threadId: THREAD, turnId: TURN };
    expect(
      normalize({ method: "item/started", params: { ...base, item: command, startedAtMs: 0 } })[0],
    ).toMatchObject({
      type: "command.started",
      payload: { itemId: "c1", command: "bun test", workdir: "/work" },
    });
    expect(
      normalize({
        method: "item/completed",
        params: { ...base, item: command, completedAtMs: 0 },
      })[0],
    ).toMatchObject({
      type: "command.completed",
      payload: { itemId: "c1", exitCode: 0, output: "ok", durationMs: 40 },
    });
  });

  test("a file change item yields one event per changed file", () => {
    const item = {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [
        { path: "a.ts", kind: { type: "add" }, diff: "+a" },
        { path: "b.ts", kind: { type: "update", move_path: null }, diff: "-b\n+b" },
      ],
    };
    const events = normalize({
      method: "item/completed",
      params: { threadId: THREAD, turnId: TURN, item, completedAtMs: 0 },
    });
    expect(events.map((e) => e.payload)).toEqual([
      { itemId: "f1:0", path: "a.ts", kind: "create", diff: "+a" },
      { itemId: "f1:1", path: "b.ts", kind: "modify", diff: "-b\n+b" },
    ]);
  });

  test("agent message, reasoning and MCP tool call completions", () => {
    const base = { threadId: THREAD, turnId: TURN, completedAtMs: 0 };
    expect(
      normalize({
        method: "item/completed",
        params: { ...base, item: agentMessage("m1", "hi") },
      })[0],
    ).toMatchObject({ type: "agent.message.completed", payload: { itemId: "m1", text: "hi" } });

    const reasoning = { type: "reasoning", id: "r1", summary: ["short"], content: ["long"] };
    expect(
      normalize({ method: "item/completed", params: { ...base, item: reasoning } })[0],
    ).toMatchObject({
      type: "agent.reasoning.completed",
      payload: { text: "long", summary: "short" },
    });

    const mcp = {
      type: "mcpToolCall",
      id: "t1",
      server: "github",
      tool: "search",
      arguments: { q: "x" },
      result: null,
      error: { message: "denied" },
      durationMs: 5,
    };
    expect(
      normalize({ method: "item/completed", params: { ...base, item: mcp } })[0],
    ).toMatchObject({
      type: "mcp_call.completed",
      payload: { serverName: "github", toolName: "search", status: "failure", error: "denied" },
    });
  });

  test("thread compaction and notifications without a canonical event", () => {
    expect(
      normalize({ method: "thread/compacted", params: { threadId: THREAD, turnId: TURN } })[0]
        ?.type,
    ).toBe("compaction.completed");
    expect(
      normalize({ method: "thread/tokenUsage/updated", params: { threadId: THREAD } }),
    ).toEqual([]);
  });
});
