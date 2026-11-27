import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeNormalizer, toolKind } from "../src/runtime/claude/normalizer.ts";

const sdk = (message: Record<string, unknown>) => message as unknown as SDKMessage;
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  sdk({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id: `msg_${id}`, content: [{ type: "tool_use", id, name, input }] },
  });
const toolResult = (id: string, content: unknown, isError = false) =>
  sdk({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
  });

function run(...messages: SDKMessage[]) {
  const normalizer = new ClaudeNormalizer("session-1", "/work");
  return messages.flatMap((message) => normalizer.normalize(message, "turn-1"));
}

describe("ClaudeNormalizer", () => {
  test("classifies tools", () => {
    expect(toolKind("Bash")).toEqual({ kind: "command" });
    expect(toolKind("Write")).toEqual({ kind: "file_change", change: "create" });
    expect(toolKind("Edit")).toEqual({ kind: "file_change", change: "modify" });
    expect(toolKind("TodoWrite")).toEqual({ kind: "plan" });
    expect(toolKind("mcp__orchestrator__notify")).toEqual({
      kind: "orchestrator",
      orchestratorTool: "notify",
    });
    expect(toolKind("mcp__linear__create_issue")).toEqual({
      kind: "mcp",
      serverName: "linear",
      toolName: "create_issue",
    });
    expect(toolKind("Read")).toEqual({ kind: "tool" });
  });

  test("streamed and completed blocks share item ids across per-block messages", () => {
    const events = run(
      sdk({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "message_start", message: { id: "msg_1" } },
      }),
      sdk({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      }),
      sdk({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
      }),
      sdk({
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg_1", content: [{ type: "thinking", thinking: "hmm, ok" }] },
      }),
      sdk({
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg_1", content: [{ type: "text", text: "Hi there" }] },
      }),
    );
    expect(events.map((e) => [e.type, (e.payload as { itemId?: string }).itemId])).toEqual([
      ["agent.reasoning.delta", "msg_1:0"],
      ["agent.message.delta", "msg_1:1"],
      ["agent.reasoning.completed", "msg_1:0"],
      ["agent.message.completed", "msg_1:1"],
    ]);
    expect(events.every((e) => e.sessionId === "session-1" && e.turnId === "turn-1")).toBe(true);
  });

  test("a command and its output", () => {
    const events = run(
      toolUse("t1", "Bash", { command: "ls" }),
      toolResult("t1", [{ type: "text", text: "a.txt" }]),
    );
    expect(events[0]).toMatchObject({
      type: "command.started",
      payload: { itemId: "t1", command: "ls", workdir: "/work" },
    });
    expect(events[1]).toMatchObject({
      type: "command.completed",
      payload: { itemId: "t1", command: "ls", exitCode: 0, output: "a.txt" },
    });
  });

  test("file edits, plans, actions and MCP calls", () => {
    const events = run(
      toolUse("t1", "Edit", { file_path: "/work/a.ts", old_string: "a", new_string: "b" }),
      toolResult("t1", "ok"),
      toolUse("t2", "TodoWrite", {
        todos: [
          { content: "Read code", status: "completed" },
          { content: "Fix bug", status: "in_progress" },
        ],
      }),
      toolUse("t3", "mcp__orchestrator__notify", { message: "hi" }),
      toolResult("t3", "{}"),
      toolUse("t4", "mcp__linear__create_issue", { title: "x" }),
      toolResult("t4", "denied", true),
    );
    expect(events.map((e) => e.type)).toEqual([
      "file_change.started",
      "file_change.completed",
      "plan.updated",
      "tool.call.started",
      "tool.called",
      "mcp_call.started",
      "mcp_call.completed",
    ]);
    expect(events[1]!.payload).toMatchObject({ path: "/work/a.ts", kind: "modify" });
    expect(events[2]!.payload).toMatchObject({
      steps: [
        { title: "Read code", status: "completed" },
        { title: "Fix bug", status: "in_progress" },
      ],
    });
    expect(events[4]!.payload).toMatchObject({ toolName: "notify", status: "success" });
    expect(events[6]!.payload).toMatchObject({
      serverName: "linear",
      status: "failure",
      error: "denied",
    });
  });

  test("subagent messages, unknown types and prompt echoes produce no events", () => {
    const events = run(
      sdk({
        type: "assistant",
        parent_tool_use_id: "task-1",
        message: { id: "msg_sub", content: [{ type: "text", text: "inside subagent" }] },
      }),
      sdk({ type: "system", subtype: "task_started" }),
      sdk({ type: "rate_limit_event" }),
      sdk({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "hello" } }),
      toolResult("unknown-tool", "orphan"),
    );
    expect(events).toEqual([]);
  });
});
