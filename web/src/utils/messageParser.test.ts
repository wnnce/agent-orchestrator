import { test, expect } from "bun:test";
import { reconstructMessagesFromEvents, applyEventToAssistantMessage } from "./messageParser";
import {
  calculateCacheHitRate,
  formatTokenCount,
  mergeTurnUsageIntoSummary,
} from "./formatters";
import type { ChatMessage, RuntimeEvent } from "../types";

test("reconstructMessagesFromEvents properly interleaves canonical reasoning, commands, and text parts chronologically", () => {
  const events: RuntimeEvent[] = [
    {
      sequence: 1,
      type: "turn.queued",
      payload: { turnId: "turn_1", input: "analyze the repo and fix the bug" },
      createdAt: "2026-11-08T04:00:00.000Z",
    },
    {
      sequence: 2,
      type: "turn.started",
      payload: { turnId: "turn_1" },
      createdAt: "2026-11-08T04:00:01.000Z",
    },
    // 1. Initial reasoning step
    {
      sequence: 3,
      type: "agent.reasoning.delta",
      payload: { itemId: "item_reas_1", delta: "First I need to check git status." },
    },
    {
      sequence: 4,
      type: "agent.reasoning.completed",
      payload: { itemId: "item_reas_1", text: "First I need to check git status." },
    },
    // 2. Command execution 1
    {
      sequence: 5,
      type: "command.started",
      payload: { itemId: "item_cmd_1", command: "git status" },
    },
    {
      sequence: 6,
      type: "command.output",
      payload: { itemId: "item_cmd_1", delta: "On branch main\nnothing to commit" },
    },
    {
      sequence: 7,
      type: "command.completed",
      payload: {
        itemId: "item_cmd_1",
        command: "git status",
        exitCode: 0,
        output: "On branch main\nnothing to commit",
        durationMs: 120,
      },
    },
    // 3. Second reasoning step
    {
      sequence: 8,
      type: "agent.reasoning.delta",
      payload: { itemId: "item_reas_2", delta: "Now checking the package.json file." },
    },
    {
      sequence: 9,
      type: "agent.reasoning.completed",
      payload: { itemId: "item_reas_2", text: "Now checking the package.json file." },
    },
    // 4. Command execution 2
    {
      sequence: 10,
      type: "command.started",
      payload: { itemId: "item_cmd_2", command: "cat package.json" },
    },
    {
      sequence: 11,
      type: "command.output",
      payload: { itemId: "item_cmd_2", delta: '{"name": "test"}' },
    },
    {
      sequence: 12,
      type: "command.completed",
      payload: { itemId: "item_cmd_2", exitCode: 0, output: '{"name": "test"}', durationMs: 45 },
    },
    // 5. Final answer
    {
      sequence: 13,
      type: "agent.message.delta",
      payload: { itemId: "item_msg_1", delta: "Analysis completed successfully." },
    },
    {
      sequence: 14,
      type: "agent.message.completed",
      payload: {
        itemId: "item_msg_1",
        text: "Analysis completed successfully.",
      },
    },
    {
      sequence: 15,
      type: "turn.completed",
      payload: { turnId: "turn_1", status: "completed", finalText: "Analysis completed successfully." },
    },
  ];

  const { messages, isRunning } = reconstructMessagesFromEvents(events);
  expect(isRunning).toBe(false);
  expect(messages.length).toBe(2);

  const [userMsg, asstMsg] = messages;
  expect(userMsg.role).toBe("user");
  expect(userMsg.content).toBe("analyze the repo and fix the bug");

  expect(asstMsg.role).toBe("assistant");
  expect(asstMsg.status).toBe("completed");
  expect(asstMsg.parts).toBeDefined();
  expect(asstMsg.parts!.length).toBe(5);

  const [p1, p2, p3, p4, p5] = asstMsg.parts!;

  // Part 1: Reasoning 1
  expect(p1.type).toBe("reasoning");
  expect((p1 as any).content).toBe("First I need to check git status.");
  expect(p1.status).toBe("completed");

  // Part 2: Command 1
  expect(p2.type).toBe("command");
  expect((p2 as any).command).toBe("git status");
  expect((p2 as any).output).toBe("On branch main\nnothing to commit");
  expect(p2.status).toBe("completed");

  // Part 3: Reasoning 2
  expect(p3.type).toBe("reasoning");
  expect((p3 as any).content).toBe("Now checking the package.json file.");
  expect(p3.status).toBe("completed");

  // Part 4: Command 2
  expect(p4.type).toBe("command");
  expect((p4 as any).command).toBe("cat package.json");
  expect((p4 as any).output).toBe('{"name": "test"}');
  expect(p4.status).toBe("completed");

  // Part 5: Final text message
  expect(p5.type).toBe("text");
  expect((p5 as any).content).toBe("Analysis completed successfully.");
  expect(p5.status).toBe("completed");
});

test("applyEventToAssistantMessage handles live incremental streaming and deltas with canonical events", () => {
  const asstMsg: ChatMessage = {
    id: "asst_123",
    role: "assistant",
    content: "",
    status: "streaming",
    parts: [],
    timestamp: Date.now(),
  };

  // Streaming reasoning
  applyEventToAssistantMessage(asstMsg, {
    type: "agent.reasoning.delta",
    payload: { itemId: "reas_live_1", delta: "Thinking step A" },
  });
  expect(asstMsg.parts?.length).toBe(1);
  expect(asstMsg.parts?.[0].status).toBe("streaming");
  expect((asstMsg.parts?.[0] as any).content).toBe("Thinking step A");

  applyEventToAssistantMessage(asstMsg, {
    type: "agent.reasoning.completed",
    payload: { itemId: "reas_live_1", text: "Thinking step A" },
  });
  expect(asstMsg.parts?.[0].status).toBe("completed");

  // Streaming command
  applyEventToAssistantMessage(asstMsg, {
    type: "command.started",
    payload: { itemId: "cmd_live_1", command: "echo 123" },
  });
  expect(asstMsg.parts?.length).toBe(2);
  expect(asstMsg.parts?.[1].status).toBe("running");

  applyEventToAssistantMessage(asstMsg, {
    type: "command.output",
    payload: { itemId: "cmd_live_1", delta: "123\n" },
  });
  expect((asstMsg.parts?.[1] as any).output).toBe("123\n");

  applyEventToAssistantMessage(asstMsg, {
    type: "command.completed",
    payload: { itemId: "cmd_live_1", command: "echo 123", exitCode: 0, output: "123\n" },
  });
  expect(asstMsg.parts?.[1].status).toBe("completed");

  // Streaming commentary / final message
  applyEventToAssistantMessage(asstMsg, {
    type: "agent.message.delta",
    payload: { itemId: "txt_live_1", delta: "All done!" },
  });
  expect(asstMsg.parts?.length).toBe(3);
  expect((asstMsg.parts?.[2] as any).content).toBe("All done!");

  applyEventToAssistantMessage(asstMsg, {
    type: "agent.message.completed",
    payload: { itemId: "txt_live_1", text: "All done!" },
  });
  expect(asstMsg.parts?.[2].status).toBe("completed");

  applyEventToAssistantMessage(asstMsg, {
    type: "turn.completed",
    payload: { finalText: "All done!" },
  });
  expect(asstMsg.status).toBe("completed");
  expect(asstMsg.content).toBe("All done!");
});

test("reconstructMessagesFromEvents and applyEventToAssistantMessage handle turn.interrupted cleanly", () => {
  const events: RuntimeEvent[] = [
    {
      sequence: 1,
      type: "turn.queued",
      payload: { turnId: "turn_int_1", input: "long running prompt" },
    },
    {
      sequence: 2,
      type: "turn.started",
      payload: { turnId: "turn_int_1" },
    },
    {
      sequence: 3,
      type: "command.started",
      payload: { itemId: "cmd_running", command: "sleep 100" },
    },
    {
      sequence: 4,
      type: "turn.interrupted",
      payload: { turnId: "turn_int_1" },
    },
  ];

  const { messages, isRunning } = reconstructMessagesFromEvents(events);
  expect(isRunning).toBe(false);
  expect(messages.length).toBe(2);

  const asst = messages[1];
  expect(asst.status).toBe("interrupted");
  expect(asst.parts?.length).toBe(1);
  expect(asst.parts?.[0].status).toBe("failed");
});

test("session lifecycle events (session.started, etc.) do NOT create fake assistant messages or set isRunning", () => {
  const events: RuntimeEvent[] = [
    {
      sequence: 1,
      type: "session.started",
      payload: { workspacePath: "/work" },
    },
    {
      sequence: 2,
      type: "notification.queued",
      payload: { title: "Ready" },
    },
  ];

  const { messages, isRunning } = reconstructMessagesFromEvents(events);
  expect(isRunning).toBe(false);
  expect(messages.length).toBe(0);
});

test("tool calls (mcp_call and tool.call) are recorded and rendered as tool parts", () => {
  const events: RuntimeEvent[] = [
    {
      sequence: 1,
      type: "turn.queued",
      payload: { turnId: "turn_tool", input: "check jira" },
    },
    {
      sequence: 2,
      type: "turn.started",
      payload: { turnId: "turn_tool" },
    },
    {
      sequence: 3,
      type: "mcp_call.started",
      payload: { itemId: "mcp_1", toolName: "search_issues", serverName: "jira", args: { jql: "assignee = currentUser()" } },
    },
    {
      sequence: 4,
      type: "mcp_call.completed",
      payload: { itemId: "mcp_1", toolName: "search_issues", serverName: "jira", status: "success", result: { total: 5 } },
    },
    {
      sequence: 5,
      type: "turn.completed",
      payload: { turnId: "turn_tool", status: "completed", finalText: "Found 5 issues." },
    },
  ];

  const { messages, isRunning } = reconstructMessagesFromEvents(events);
  expect(isRunning).toBe(false);
  expect(messages.length).toBe(2);

  const asst = messages[1];
  expect(asst.status).toBe("completed");
  expect(asst.content).toBe("Found 5 issues.");
  expect(asst.parts?.length).toBe(2);

  const toolPart = asst.parts![0];
  expect(toolPart.type).toBe("tool");
  expect((toolPart as any).toolName).toBe("search_issues");
  expect((toolPart as any).serverName).toBe("jira");
  expect(toolPart.status).toBe("completed");

  const textPart = asst.parts![1];
  expect(textPart.type).toBe("text");
  expect((textPart as any).content).toBe("Found 5 issues.");
  expect(textPart.status).toBe("completed");
});

test("preserves chronological ordering when assistant outputs preliminary text, followed by tools, followed by final reply", () => {
  const events: RuntimeEvent[] = [
    {
      sequence: 1,
      type: "turn.queued",
      payload: { turnId: "turn_multi", input: "check issues" },
    },
    {
      sequence: 2,
      type: "turn.started",
      payload: { turnId: "turn_multi" },
    },
    // 1. Thinking
    {
      sequence: 3,
      type: "agent.reasoning.completed",
      payload: { itemId: "reas_1", text: "I need to check the issues first." },
    },
    // 2. Preliminary text before tools
    {
      sequence: 4,
      type: "agent.message.completed",
      payload: { itemId: "txt_prelim", text: "I will now query the database." },
    },
    // 3. Tool execution
    {
      sequence: 5,
      type: "command.started",
      payload: { itemId: "cmd_1", command: "check_db.sh" },
    },
    {
      sequence: 6,
      type: "command.completed",
      payload: { itemId: "cmd_1", command: "check_db.sh", exitCode: 0, output: "DB OK" },
    },
    // 4. Final formal reply
    {
      sequence: 7,
      type: "agent.message.completed",
      payload: { itemId: "txt_final", text: "Everything looks good in the database." },
    },
    // 5. Turn completed
    {
      sequence: 8,
      type: "turn.completed",
      payload: { turnId: "turn_multi", status: "completed", finalText: "Everything looks good in the database." },
    },
  ];

  const { messages } = reconstructMessagesFromEvents(events);
  expect(messages.length).toBe(2);

  const asst = messages[1];
  expect(asst.parts?.length).toBe(4);

  // Chronological verification: Think -> Prelim Text -> Command -> Final Reply
  expect(asst.parts![0].type).toBe("reasoning");
  expect((asst.parts![0] as any).content).toBe("I need to check the issues first.");

  expect(asst.parts![1].type).toBe("text");
  expect((asst.parts![1] as any).content).toBe("I will now query the database.");

  expect(asst.parts![2].type).toBe("command");
  expect((asst.parts![2] as any).command).toBe("check_db.sh");

  expect(asst.parts![3].type).toBe("text");
  expect((asst.parts![3] as any).content).toBe("Everything looks good in the database.");
});

test("extracts TurnUsage from turn.completed events and formats usage metrics cleanly", () => {
  const usage = {
    model: "gemini-4-neon",
    inputTokens: 15709,
    cacheReadTokens: 11432,
    cacheWriteTokens: 0,
    outputTokens: 124,
    reasoningTokens: 109,
    totalTokens: 27265,
    contextUsedTokens: 27265,
    contextWindowTokens: 1048576,
  };

  const events: RuntimeEvent[] = [
    { sequence: 1, type: "turn.queued", payload: { turnId: "t_u1", input: "hello" } },
    { sequence: 2, type: "turn.started", payload: { turnId: "t_u1" } },
    {
      sequence: 3,
      type: "turn.completed",
      payload: { turnId: "t_u1", status: "completed", finalText: "hi", usage },
    },
  ];

  const { messages } = reconstructMessagesFromEvents(events);
  expect(messages[1].usage).toEqual(usage);
  expect(formatTokenCount(124)).toBe("124");
  expect(formatTokenCount(15709)).toBe("15.7k");
  expect(formatTokenCount(1048576)).toBe("1.0M");
  expect(calculateCacheHitRate(usage)).toBe(42);

  const summary1 = mergeTurnUsageIntoSummary(null, usage);
  expect(summary1.turnCount).toBe(1);
  expect(summary1.lastModel).toBe("gemini-4-neon");
  expect(summary1.totalTokens).toBe(27265);

  const summary2 = mergeTurnUsageIntoSummary(summary1, {
    ...usage,
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    cacheReadTokens: 3000,
    outputTokens: 200,
    reasoningTokens: 0,
    totalTokens: 4200,
    contextUsedTokens: 31000,
    contextWindowTokens: 200000,
  });
  expect(summary2).toEqual({
    turnCount: 2,
    inputTokens: 16709,
    cacheReadTokens: 14432,
    cacheWriteTokens: 0,
    outputTokens: 324,
    reasoningTokens: 109,
    totalTokens: 31465,
    lastModel: "claude-sonnet-4-6",
    contextUsedTokens: 31000,
    contextWindowTokens: 200000,
  });
});
