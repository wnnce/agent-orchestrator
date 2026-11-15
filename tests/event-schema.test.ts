import { describe, expect, test } from "bun:test";
import {
  isCanonicalEventType,
  isTransientEvent,
  TRANSIENT_EVENT_TYPES,
  type AgentMessageDeltaPayload,
  type AgentMessageCompletedPayload,
  type CommandOutputPayload,
  type CommandCompletedPayload,
  type TurnCompletedPayload,
  type RuntimeUnmappedPayload,
  type CanonicalDomainEvent,
  type CanonicalEventEnvelope,
} from "../src/domain/events.ts";

describe("Canonical Domain Event Protocol", () => {
  test("type narrowing with isCanonicalEventType works accurately", () => {
    const rawEvent = {
      type: "agent.message.delta",
      payload: {
        itemId: "item_123",
        delta: "Hello, world!",
        metadata: { tokens: 5 },
      },
    };

    if (isCanonicalEventType(rawEvent, "agent.message.delta")) {
      // TypeScript narrows rawEvent.payload to AgentMessageDeltaPayload
      const payload: AgentMessageDeltaPayload = rawEvent.payload;
      expect(payload.itemId).toBe("item_123");
      expect(payload.delta).toBe("Hello, world!");
      expect(payload.metadata?.tokens).toBe(5);
    } else {
      throw new Error("Should have narrowed to agent.message.delta");
    }
  });

  test("TurnCompletedPayload contains canonical finalText and durationMs", () => {
    const event: CanonicalEventEnvelope<"turn.completed"> = {
      id: "evt_1",
      projectId: "proj_1",
      sessionId: "ses_1",
      sequence: 1,
      type: "turn.completed",
      runtime: "codex",
      payload: {
        turnId: "turn_1",
        status: "completed",
        finalText: "All tasks completed successfully.",
        durationMs: 1540,
        metadata: { rawItemsCount: 4 },
      },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    expect(event.type).toBe("turn.completed");
    expect(event.payload.status).toBe("completed");
    expect(event.payload.finalText).toBe("All tasks completed successfully.");
    expect(event.payload.durationMs).toBe(1540);
  });

  test("CommandCompletedPayload contains exitCode, command, output, durationMs", () => {
    const event: CanonicalEventEnvelope<"command.completed"> = {
      id: "evt_2",
      projectId: "proj_1",
      sessionId: "ses_1",
      sequence: 2,
      type: "command.completed",
      runtime: "codex",
      payload: {
        itemId: "cmd_1",
        command: "ls -la",
        exitCode: 0,
        output: "total 0\n",
        durationMs: 45,
      },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    expect(event.payload.exitCode).toBe(0);
    expect(event.payload.command).toBe("ls -la");
    expect(event.payload.output).toBe("total 0\n");
  });

  test("EventRecord and EventType are unified in events.ts and accessible via types.ts", () => {
    // Both events.ts and types.ts re-export EventRecord and EventType
    const record: import("../src/domain/events.ts").EventRecord = {
      id: "evt_rec_1",
      projectId: "proj_rec",
      sessionId: "ses_rec",
      sequence: 1,
      type: "agent.message.completed",
      runtime: "codex",
      payload: { itemId: "item_rec", text: "done" },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    expect(record.type).toBe("agent.message.completed");
    expect(record.runtime).toBe("codex");
  });

  test("isTransientEvent correctly identifies transient streaming events via canonical Set", () => {
    expect(TRANSIENT_EVENT_TYPES.has("agent.message.delta")).toBe(true);
    expect(TRANSIENT_EVENT_TYPES.has("agent.reasoning.delta")).toBe(true);
    expect(TRANSIENT_EVENT_TYPES.has("command.output")).toBe(true);

    expect(isTransientEvent("agent.message.delta")).toBe(true);
    expect(isTransientEvent("agent.reasoning.delta")).toBe(true);
    expect(isTransientEvent("command.output")).toBe(true);

    // Non-transient milestone events must be false
    expect(isTransientEvent("agent.message.completed")).toBe(false);
    expect(isTransientEvent("command.completed")).toBe(false);
    expect(isTransientEvent("turn.completed")).toBe(false);
    expect(isTransientEvent("session.started")).toBe(false);
    expect(isTransientEvent("runtime.unmapped")).toBe(false);
  });

  test("runtime.unmapped payload encapsulates raw method and vendor payload inside metadata", () => {
    const unmapped: CanonicalEventEnvelope<"runtime.unmapped"> = {
      id: "evt_unmapped_1",
      projectId: "proj_1",
      sessionId: "ses_1",
      sequence: 1,
      type: "runtime.unmapped",
      runtime: "codex",
      payload: {
        metadata: {
          rawMethod: "custom/vendor/event",
          raw: { foo: "bar" },
        },
      },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    };

    expect(unmapped.type).toBe("runtime.unmapped");
    expect(unmapped.payload.metadata.rawMethod).toBe("custom/vendor/event");
    expect((unmapped.payload.metadata.raw as any).foo).toBe("bar");
  });
});
