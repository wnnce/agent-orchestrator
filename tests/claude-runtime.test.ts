import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ActionRegistry } from "../src/actions/registry.ts";
import { Logger } from "../src/observability/logger.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { ClaudeRuntime, type ClaudeQuery } from "../src/runtime/claude/index.ts";
import { defaultRuntimeRegistry } from "../src/runtime/registry.ts";
import {
  RuntimeSessionNotFoundError,
  type RuntimeContext,
  type RuntimeEvent,
} from "../src/runtime/runtime.ts";

const quiet = new Logger({ sink: () => {} });

/** A Claude Code query whose output the test scripts; it records every input it reads. */
class ScriptedQuery implements ClaudeQuery {
  readonly inputs: SDKUserMessage[] = [];
  interrupts = 0;
  closed = false;
  private readonly outbox: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private inputWaiters: Array<() => void> = [];
  private readonly init: Promise<never>;
  private failInit!: (error: Error) => void;

  constructor(
    readonly options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
    private readonly initFails = false,
  ) {
    this.init = new Promise<never>((_, reject) => {
      this.failInit = reject;
    });
    this.init.catch(() => {});
    void (async () => {
      for await (const message of prompt) {
        this.inputs.push(message);
        for (const notify of this.inputWaiters.splice(0)) notify();
      }
    })();
  }

  async initializationResult(): Promise<never> {
    if (!this.initFails) return {} as never;
    return this.init;
  }
  async interrupt(): Promise<undefined> {
    this.interrupts++;
    return undefined;
  }
  close(): void {
    this.closed = true;
    this.failInit(new Error("Query closed before response received"));
    this.wake?.();
  }
  emit(...messages: SDKMessage[]): void {
    this.outbox.push(...messages);
    this.wake?.();
  }
  async input(count: number): Promise<SDKUserMessage> {
    while (this.inputs.length < count) await new Promise<void>((r) => this.inputWaiters.push(r));
    return this.inputs[count - 1]!;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    while (true) {
      const message = this.outbox.shift();
      if (message) {
        yield message;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

function result(answered: string[], overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    duration_ms: 5,
    duration_api_ms: 5,
    num_turns: 1,
    total_cost_usd: 0,
    errors: [],
    user_message_uuids: answered,
    ...overrides,
  } as unknown as SDKMessage;
}

function assistantText(id: string, text: string): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, content: [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(check()).toBe(true);
}

describe("ClaudeRuntime", () => {
  let root: string;
  let project: ProjectConfig;
  let queries: ScriptedQuery[];
  let failInit: boolean;
  let runtime: ClaudeRuntime;
  let events: RuntimeEvent[];
  let context: RuntimeContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-runtime-"));
    project = {
      id: "claude-test",
      displayName: "Claude",
      description: "test",
      routing: { projectId: "claude-test" },
      runtime: { type: "claude", approvalPolicy: "on-request" },
    };
    queries = [];
    failInit = false;
    events = [];
    context = {
      project,
      workspacePath: root,
      onEvent: (event) => {
        events.push(event);
      },
    };
    runtime = new ClaudeRuntime(
      quiet,
      { apiKey: "sk-test" },
      undefined,
      undefined,
      root,
      (params) => {
        const query = new ScriptedQuery(params.options, params.prompt, failInit);
        queries.push(query);
        return query;
      },
    );
  });

  afterEach(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });

  const types = () => events.map((e) => e.type);

  test("is registered as the claude runtime", () => {
    expect(defaultRuntimeRegistry.has("claude")).toBe(true);
  });

  test("a turn streams the reply and completes on its result", async () => {
    const session = await runtime.startSession(context);
    expect(queries[0]!.options.sessionId).toBe(session.id);
    expect(queries[0]!.options.cwd).toBe(root);

    await runtime.startTurn(context, session.id, "turn-1", "hello");
    const prompt = await queries[0]!.input(1);
    expect(prompt.message.content).toBe("hello");
    queries[0]!.emit(
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "message_start", message: { id: "msg_1" } },
      } as unknown as SDKMessage,
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      } as unknown as SDKMessage,
      assistantText("msg_1", "Hi there"),
      result([prompt.uuid!], { result: "Hi there" }),
    );
    await until(() => types().includes("turn.completed"));

    expect(types()).toEqual(["agent.message.delta", "agent.message.completed", "turn.completed"]);
    expect(events[0]!.payload).toMatchObject({ itemId: "msg_1:0" });
    expect(events[1]!.payload).toMatchObject({ itemId: "msg_1:0", text: "Hi there" });
    expect(events[2]).toMatchObject({ turnId: "turn-1", payload: { finalText: "Hi there" } });
  });

  test("a steer that Claude Code runs as a follow-up keeps the turn open until it is answered", async () => {
    const session = await runtime.startSession(context);
    await runtime.startTurn(context, session.id, "turn-1", "long task");
    const prompt = await queries[0]!.input(1);
    await runtime.steerTurn(context, session.id, "rt", "also do this");
    const steer = await queries[0]!.input(2);
    expect(steer.priority).toBe("now");

    queries[0]!.emit(result([prompt.uuid!], { result: "" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(types()).not.toContain("turn.completed");

    queries[0]!.emit(assistantText("msg_2", "both done"), result([steer.uuid!], { result: "" }));
    await until(() => types().includes("turn.completed"));
    expect(events.at(-1)!.payload).toMatchObject({ finalText: "both done" });
  });

  test("an interrupted turn ends as interrupted", async () => {
    const session = await runtime.startSession(context);
    await runtime.startTurn(context, session.id, "turn-1", "work");
    const prompt = await queries[0]!.input(1);
    await runtime.interruptTurn(context, session.id, "rt");
    expect(queries[0]!.interrupts).toBe(1);
    queries[0]!.emit(result([prompt.uuid!], { subtype: "error_during_execution", errors: [] }));
    await until(() => types().includes("turn.interrupted"));
  });

  test("an error result fails the turn, including a success result flagged as an error", async () => {
    const session = await runtime.startSession(context);
    await runtime.startTurn(context, session.id, "turn-1", "go");
    const prompt = await queries[0]!.input(1);
    queries[0]!.emit(result([prompt.uuid!], { is_error: true, result: "Invalid API key" }));
    await until(() => types().includes("turn.failed"));
    expect(events.at(-1)!.payload).toMatchObject({ error: "Invalid API key" });
  });

  test("permission prompts become approvals", async () => {
    const session = await runtime.startSession(context);
    const canUseTool = queries[0]!.options.canUseTool as CanUseTool;
    const ask = (id: string, signal = new AbortController().signal) =>
      canUseTool("Bash", { command: "rm -rf build" }, {
        signal,
        toolUseID: id,
      } as Parameters<CanUseTool>[2]);

    const approved = ask("tool-1");
    await until(() => types().includes("approval.requested"));
    expect(events[0]!.payload).toMatchObject({ requestId: "tool-1", actionType: "command" });
    await runtime.respondToApproval(context, "tool-1", "approved");
    expect(await approved).toEqual({
      behavior: "allow",
      updatedInput: { command: "rm -rf build" },
    } as PermissionResult);

    const rejected = ask("tool-2");
    await runtime.respondToApproval(context, "tool-2", "rejected");
    expect((await rejected)?.behavior).toBe("deny");

    const abandoned = ask("tool-3");
    await runtime.releaseSession(context, session.id);
    expect((await abandoned)?.behavior).toBe("deny");
    await expect(runtime.respondToApproval(context, "tool-3", "approved")).rejects.toThrow();
  });

  test("compaction runs /compact and reports the boundary", async () => {
    const session = await runtime.startSession(context);
    const done = runtime.compactSession(context, session.id);
    const command = await queries[0]!.input(1);
    expect(command.message.content).toBe("/compact");
    queries[0]!.emit(
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 6000, post_tokens: 1300 },
      } as unknown as SDKMessage,
      result([command.uuid!], { result: "", num_turns: 0 }),
    );
    await done;
    expect(events[0]).toMatchObject({
      type: "compaction.completed",
      payload: { tokensBefore: 6000, tokensAfter: 1300 },
    });
  });

  test("resuming a session Claude Code does not have is reported as not found", async () => {
    failInit = true;
    const opening = runtime.resumeSession(context, "missing-session");
    await until(() => queries.length === 1);
    expect(queries[0]!.options.resume).toBe("missing-session");
    queries[0]!.emit(
      result([], {
        subtype: "error_during_execution",
        errors: ["No conversation found with session ID: missing-session"],
      }),
    );
    queries[0]!.close();
    await expect(opening).rejects.toBeInstanceOf(RuntimeSessionNotFoundError);
  });

  test("an unexpected exit reports a disconnect and forgets the session", async () => {
    const session = await runtime.startSession(context);
    queries[0]!.close();
    await until(() => types().includes("runtime.disconnected"));
    await expect(runtime.startTurn(context, session.id, "turn-1", "hi")).rejects.toThrow(
      "Claude session not found",
    );
  });

  test("orchestrator actions are offered to the session and never need approval", async () => {
    const registry = new ActionRegistry();
    registry.register({
      name: "ping",
      description: "Replies pong",
      parameters: z.object({ text: z.string() }),
      handler: async () => ({ pong: true }),
    });
    const withActions = new ClaudeRuntime(
      quiet,
      { apiKey: "sk-test" },
      undefined,
      registry,
      root,
      (params) => {
        const query = new ScriptedQuery(params.options, params.prompt);
        queries.push(query);
        return query;
      },
    );
    await withActions.startSession(context);
    expect(queries[0]!.options.mcpServers?.orchestrator).toMatchObject({ type: "sdk" });
    const canUseTool = queries[0]!.options.canUseTool as CanUseTool;
    const decision = await canUseTool("mcp__orchestrator__ping", { text: "hi" }, {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
    } as Parameters<CanUseTool>[2]);
    expect(decision?.behavior).toBe("allow");
    expect(types()).not.toContain("approval.requested");
    await withActions.stop();
  });

  test("releasing a session ends its Claude Code process", async () => {
    const session = await runtime.startSession(context);
    await runtime.releaseSession(context, session.id);
    expect(queries[0]!.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(types()).not.toContain("runtime.disconnected");
  });
});
