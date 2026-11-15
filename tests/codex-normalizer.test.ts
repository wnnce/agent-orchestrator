import { describe, expect, test } from "bun:test";
import {
  normalizeCodexMessage,
  extractFinalTextFromTurnItems,
} from "../src/runtime/codex-normalizer.ts";
import type {
  AgentMessageDeltaPayload,
  AgentMessageCompletedPayload,
  AgentReasoningDeltaPayload,
  AgentReasoningCompletedPayload,
  CommandStartedPayload,
  CommandOutputPayload,
  CommandCompletedPayload,
  FileChangeCompletedPayload,
  McpCallCompletedPayload,
  ApprovalRequestedPayload,
  TurnCompletedPayload,
  RuntimeUnmappedPayload,
} from "../src/domain/events.ts";

describe("Codex Message Normalizer (Adapter)", () => {
  test("extracts finalText from turn.items reversed", () => {
    const items = [
      { type: "reasoning", text: "thinking..." },
      { type: "agentMessage", text: "First reply" },
      { type: "commandExecution", command: "echo test" },
      {
        type: "agentMessage",
        content: [{ type: "text", text: "Final conclusive answer" }],
      },
    ];

    expect(extractFinalTextFromTurnItems(items)).toBe("Final conclusive answer");
    expect(extractFinalTextFromTurnItems([])).toBeUndefined();
    expect(extractFinalTextFromTurnItems(null)).toBeUndefined();
  });

  test("normalizes turn/completed and extracts finalText", () => {
    const event = normalizeCodexMessage(
      "turn/completed",
      {
        threadId: "thr_1",
        turn: {
          id: "turn_101",
          status: "completed",
          items: [
            { type: "agentMessage", text: "Hello! Here is your answer." },
          ],
        },
      },
      "thr_1",
    );

    expect(event.type).toBe("turn.completed");
    expect(event.sessionId).toBe("thr_1");
    expect(event.turnId).toBe("turn_101");
    const payload = event.payload as TurnCompletedPayload;
    expect(payload.turnId).toBe("turn_101");
    expect(payload.status).toBe("completed");
    expect(payload.finalText).toBe("Hello! Here is your answer.");
    expect(payload.metadata?.itemCount).toBe(1);
  });

  test("normalizes turn/completed when status is failed or interrupted", () => {
    const failedEvent = normalizeCodexMessage(
      "turn/completed",
      {
        threadId: "thr_1",
        turn: {
          id: "turn_fail",
          status: "failed",
          error: { message: "Context window exceeded" },
        },
      },
      "thr_1",
    );
    expect(failedEvent.type).toBe("turn.failed");
    expect((failedEvent.payload as TurnCompletedPayload).error).toBe("Context window exceeded");

    const interruptedEvent = normalizeCodexMessage(
      "turn/completed",
      {
        threadId: "thr_1",
        turn: {
          id: "turn_int",
          status: "interrupted",
        },
      },
      "thr_1",
    );
    expect(interruptedEvent.type).toBe("turn.interrupted");
    expect((interruptedEvent.payload as TurnCompletedPayload).status).toBe("interrupted");
  });

  test("normalizes item/agentMessage/delta", () => {
    const event = normalizeCodexMessage(
      "item/agentMessage/delta",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "msg_1",
        delta: "streaming token...",
      },
      "thr_1",
    );

    expect(event.type).toBe("agent.message.delta");
    const payload = event.payload as AgentMessageDeltaPayload;
    expect(payload.itemId).toBe("msg_1");
    expect(payload.delta).toBe("streaming token...");
  });

  test("normalizes item/completed for agentMessage", () => {
    const event = normalizeCodexMessage(
      "item/completed",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          id: "msg_full",
          type: "agentMessage",
          text: "Full response generated.",
        },
      },
      "thr_1",
    );

    expect(event.type).toBe("agent.message.completed");
    const payload = event.payload as AgentMessageCompletedPayload;
    expect(payload.itemId).toBe("msg_full");
    expect(payload.text).toBe("Full response generated.");
  });

  test("normalizes reasoning events (delta and completed)", () => {
    const deltaEvent = normalizeCodexMessage(
      "item/reasoning/textDelta",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "reas_1",
        delta: "I need to check file.ts",
      },
      "thr_1",
    );
    expect(deltaEvent.type).toBe("agent.reasoning.delta");
    expect((deltaEvent.payload as AgentReasoningDeltaPayload).delta).toBe("I need to check file.ts");

    const fullEvent = normalizeCodexMessage(
      "item/completed",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          id: "reas_1",
          type: "reasoning",
          content: ["Step 1: Check code", "Step 2: Fix bug"],
          summary: ["Root cause identified"],
        },
      },
      "thr_1",
    );
    expect(fullEvent.type).toBe("agent.reasoning.completed");
    const fullPayload = fullEvent.payload as AgentReasoningCompletedPayload;
    expect(fullPayload.text).toBe("Step 1: Check code\nStep 2: Fix bug");
    expect(fullPayload.summary).toBe("Root cause identified");
  });

  test("normalizes command execution lifecycle", () => {
    const startEvent = normalizeCodexMessage(
      "item/started",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          id: "cmd_1",
          type: "commandExecution",
          command: "bun test",
          workdir: "/app",
        },
      },
      "thr_1",
    );
    expect(startEvent.type).toBe("command.started");
    expect((startEvent.payload as CommandStartedPayload).command).toBe("bun test");
    expect((startEvent.payload as CommandStartedPayload).workdir).toBe("/app");

    const outputEvent = normalizeCodexMessage(
      "item/commandExecution/outputDelta",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "cmd_1",
        delta: "PASS: test 1\n",
      },
      "thr_1",
    );
    expect(outputEvent.type).toBe("command.output");
    expect((outputEvent.payload as CommandOutputPayload).delta).toBe("PASS: test 1\n");
    expect((outputEvent.payload as CommandOutputPayload).stream).toBe("stdout");

    const completeEvent = normalizeCodexMessage(
      "item/completed",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          id: "cmd_1",
          type: "commandExecution",
          command: "bun test",
          exitCode: 0,
          output: "PASS: test 1\nDone in 5ms\n",
          durationMs: 50,
        },
      },
      "thr_1",
    );
    expect(completeEvent.type).toBe("command.completed");
    const completePayload = completeEvent.payload as CommandCompletedPayload;
    expect(completePayload.exitCode).toBe(0);
    expect(completePayload.command).toBe("bun test");
    expect(completePayload.output).toContain("Done in 5ms");
    expect(completePayload.durationMs).toBe(50);
  });

  test("normalizes file changes", () => {
    const fileEvent = normalizeCodexMessage(
      "item/completed",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          id: "file_mod",
          type: "fileChange",
          path: "src/main.ts",
          diff: "@@ -1,2 +1,2 @@",
          totalLinesAdded: 5,
          totalLinesRemoved: 2,
        },
      },
      "thr_1",
    );
    expect(fileEvent.type).toBe("file_change.completed");
    const payload = fileEvent.payload as FileChangeCompletedPayload;
    expect(payload.path).toBe("src/main.ts");
    expect(payload.diff).toBe("@@ -1,2 +1,2 @@");
    expect(payload.totalLinesAdded).toBe(5);
    expect(payload.totalLinesRemoved).toBe(2);
  });

  test("normalizes MCP tool call", () => {
    const mcpEvent = normalizeCodexMessage(
      "item/completed",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        item: {
          id: "mcp_1",
          type: "mcpToolCall",
          server: "github",
          tool: "create_issue",
          result: { number: 42 },
        },
      },
      "thr_1",
    );
    expect(mcpEvent.type).toBe("mcp_call.completed");
    const payload = mcpEvent.payload as McpCallCompletedPayload;
    expect(payload.serverName).toBe("github");
    expect(payload.toolName).toBe("create_issue");
    expect(payload.status).toBe("success");
    expect(payload.result).toEqual({ number: 42 });
  });

  test("normalizes approval requested", () => {
    const appEvent = normalizeCodexMessage(
      "approval/requested",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        requestId: "app_99",
        command: "rm -rf /data",
        description: "Dangerous file deletion",
      },
      "thr_1",
    );
    expect(appEvent.type).toBe("approval.requested");
    const payload = appEvent.payload as ApprovalRequestedPayload;
    expect(payload.requestId).toBe("app_99");
    expect(payload.actionType).toBe("command");
    expect(payload.description).toBe("Dangerous file deletion");
  });

  test("falls back gracefully for unknown methods to runtime.unmapped without leaking raw fields to root", () => {
    const event = normalizeCodexMessage(
      "custom/vendor/notification",
      {
        threadId: "thr_1",
        turnId: "turn_1",
        customData: 123,
      },
      "thr_1",
    );
    expect(event.type).toBe("runtime.unmapped");
    const payload = event.payload as RuntimeUnmappedPayload;
    expect(payload.metadata.rawMethod).toBe("custom/vendor/notification");
    expect((payload.metadata.raw as any).customData).toBe(123);
  });
});
