import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ActionRegistry } from "../src/actions/registry.ts";
import { Logger } from "../src/observability/logger.ts";
import {
  PI_CAPABILITIES,
  PiNormalizer,
  PiRuntime,
  bridgeActionsToPiTools,
} from "../src/runtime/pi/index.ts";
import { defaultRuntimeRegistry } from "../src/runtime/registry.ts";
import type { RuntimeContext, RuntimeEvent } from "../src/runtime/runtime.ts";
import type { ProjectConfig } from "../src/domain/types.ts";

async function createMockModelRuntime(responseTokens: string[] = ["Hello", " world", "!"]) {
  const mr = (ModelRuntime as any).create ? await (ModelRuntime as any).create() : undefined;

  mr.registerProvider("mock-provider", {
    name: "Mock Provider",
    baseUrl: "http://localhost:8080",
    api: "openai-codex",
    models: [
      {
        id: "mock-model",
        name: "Mock Model",
        api: "openai-codex",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({
          type: "start",
          partial: { role: "assistant", content: [] } as any,
        });
        stream.push({
          type: "text_start",
          contentIndex: 0,
          partial: { role: "assistant", content: [{ type: "text", text: "" }] } as any,
        });
        let full = "";
        for (const token of responseTokens) {
          full += token;
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: token,
            partial: {
              role: "assistant",
              content: [{ type: "text", text: full }],
            } as any,
          });
        }
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: full,
          partial: { role: "assistant", content: [{ type: "text", text: full }] } as any,
        });
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: full }],
            stopReason: "stop",
            api: "openai-codex",
            provider: "mock-provider",
            model: "mock-model",
            timestamp: Date.now(),
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          } as any,
        });
        stream.end();
      }, 5);
      return stream;
    },
  });

  await mr.setRuntimeApiKey("mock-provider", "mock-key");

  return mr;
}

const DUMMY_PROJECT: ProjectConfig = {
  id: "test-pi-project",
  displayName: "Test Pi Project",
  description: "Test Pi Project description",
  routing: {
    projectId: "test-pi-project",
  },
  runtime: {
    type: "pi",
    model: "mock-provider/mock-model",
  },
  repository: { url: "https://github.com/example/repo.git", baseBranch: "main" },
};

// Pi keeps settings, models and sessions in its agent directory; never touch the real ~/.pi.
const piAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeAll(async () => {
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  await Bun.write(join(piAgentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
});
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(piAgentDir, { recursive: true, force: true });
});

describe("Pi Agent Native SDK Runtime", () => {
  it("registers pi runtime in defaultRuntimeRegistry with PI_CAPABILITIES", () => {
    expect(defaultRuntimeRegistry.has("pi")).toBe(true);
    const meta = defaultRuntimeRegistry.listRuntimes().find((r) => r.type === "pi");
    expect(meta).toBeDefined();
    expect(meta?.capabilities).toEqual(PI_CAPABILITIES);
    expect(PI_CAPABILITIES.streaming).toBe(true);
    expect(PI_CAPABILITIES.resume).toBe(true);
    expect(PI_CAPABILITIES.steer).toBe(true);
    expect(PI_CAPABILITIES.interrupt).toBe(true);
    expect(PI_CAPABILITIES.compaction).toBe(true);
  });

  describe("PiNormalizer", () => {
    it("normalizes text and reasoning stream deltas", () => {
      const textEvent: any = {
        type: "message_update",
        message: { role: "assistant", content: [], timestamp: 1001 },
        assistantMessageEvent: {
          type: "text_delta",
          delta: "hello stream",
        },
      };

      const textNormalized = PiNormalizer.normalize(textEvent, "ses_1", "turn_1");
      expect(textNormalized).toHaveLength(1);
      expect(textNormalized[0]!.type).toBe("agent.message.delta");
      expect(textNormalized[0]!.payload).toMatchObject({
        itemId: "msg_1001",
        delta: "hello stream",
      });

      const thinkEvent: any = {
        type: "message_update",
        message: { role: "assistant", content: [], timestamp: 1002 },
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "thinking step",
        },
      };

      const thinkNormalized = PiNormalizer.normalize(thinkEvent, "ses_1", "turn_1");
      expect(thinkNormalized).toHaveLength(1);
      expect(thinkNormalized[0]!.type).toBe("agent.reasoning.delta");
      expect(thinkNormalized[0]!.payload).toMatchObject({
        itemId: "msg_1002",
        delta: "thinking step",
      });
    });

    it("normalizes completed messages for assistant text and reasoning", () => {
      const msgEndEvent: any = {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 1003,
          content: [
            { type: "text", text: "Final answer text" },
            { type: "thinking", thinking: "My thought process" },
          ],
        },
      };

      const normalized = PiNormalizer.normalize(msgEndEvent, "ses_1", "turn_1");
      expect(normalized).toHaveLength(2);
      expect(normalized[0]!.type).toBe("agent.message.completed");
      expect(normalized[0]!.payload).toMatchObject({
        itemId: "msg_1003",
        text: "Final answer text",
      });
      expect(normalized[1]!.type).toBe("agent.reasoning.completed");
      expect(normalized[1]!.payload).toMatchObject({
        itemId: "msg_1003",
        text: "My thought process",
      });
    });

    it("normalizes bash tool execution lifecycle", () => {
      const startEv: any = {
        type: "tool_execution_start",
        toolCallId: "call_bash_1",
        toolName: "bash",
        args: { command: "ls -la", cwd: "/tmp" },
      };

      const startNorm = PiNormalizer.normalize(startEv, "ses_1", "turn_1");
      expect(startNorm).toHaveLength(2);
      expect(startNorm[0]!.type).toBe("command.started");
      expect(startNorm[0]!.payload).toMatchObject({
        itemId: "call_bash_1",
        command: "ls -la",
        workdir: "/tmp",
      });
      expect(startNorm[1]!.type).toBe("tool.call.started");
      expect(startNorm[1]!.payload).toMatchObject({
        itemId: "call_bash_1",
        toolName: "bash",
      });

      const endEv: any = {
        type: "tool_execution_end",
        toolCallId: "call_bash_1",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "total 0\n-rw-r--r-- file.txt" }],
        },
        isError: false,
        durationMs: 42,
      };

      const endNorm = PiNormalizer.normalize(endEv, "ses_1", "turn_1");
      expect(endNorm).toHaveLength(2);
      expect(endNorm[0]!.type).toBe("command.completed");
      expect(endNorm[0]!.payload).toMatchObject({
        itemId: "call_bash_1",
        exitCode: 0,
        output: "total 0\n-rw-r--r-- file.txt",
        durationMs: 42,
      });
      expect(endNorm[1]!.type).toBe("tool.called");
      expect(endNorm[1]!.payload).toMatchObject({
        itemId: "call_bash_1",
        toolName: "bash",
        status: "success",
      });
    });

    it("normalizes write and edit file changes", () => {
      const writeStart: any = {
        type: "tool_execution_start",
        toolCallId: "call_write_1",
        toolName: "write",
        args: { path: "src/app.ts" },
      };

      const writeNorm = PiNormalizer.normalize(writeStart, "ses_1", "turn_1");
      expect(writeNorm[0]!.type).toBe("file_change.started");
      expect(writeNorm[0]!.payload).toMatchObject({
        itemId: "call_write_1",
        path: "src/app.ts",
        kind: "create",
      });

      const writeEnd: any = {
        type: "tool_execution_end",
        toolCallId: "call_write_1",
        toolName: "write",
        result: { content: [{ type: "text", text: "created file" }] },
        isError: false,
      };

      const writeEndNorm = PiNormalizer.normalize(writeEnd, "ses_1", "turn_1");
      expect(writeEndNorm[0]!.type).toBe("file_change.completed");
      expect(writeEndNorm[0]!.payload).toMatchObject({
        itemId: "call_write_1",
        kind: "create",
      });
    });

    it("normalizes compaction completion", () => {
      const compEvent: any = {
        type: "compaction_end",
        aborted: false,
        result: { summary: "Pruned older messages" },
      };
      const compNorm = PiNormalizer.normalize(compEvent, "ses_1");
      expect(compNorm).toHaveLength(1);
      expect(compNorm[0]!.type).toBe("compaction.completed");
    });
  });

  describe("Action & Tool Bridging", () => {
    it("bridges ActionRegistry actions to Pi ToolDefinitions and executes correctly", async () => {
      const registry = new ActionRegistry(new Logger());
      registry.register({
        name: "calculate_sum",
        description: "Sums two numbers",
        parameters: z.object({
          a: z.number(),
          b: z.number(),
        }),
        handler: async (params) => {
          return { sum: params.a + params.b };
        },
      });

      const tools = bridgeActionsToPiTools(registry, () => ({
        project: DUMMY_PROJECT,
        workspacePath: "/tmp",
        sessionId: "ses_test",
        turnId: "turn_test",
      }));

      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("calculate_sum");
      expect(tools[0]!.description).toBe("Sums two numbers");

      const result = await (tools[0] as any).execute("call_1", { a: 10, b: 25 });
      expect(result.isError).toBe(false);
      expect(result.details).toEqual({ sum: 35 });
      expect((result.content[0] as any).text).toBe(JSON.stringify({ sum: 35 }));
    });
  });

  describe("PiRuntime End-to-End Lifecycle", () => {
    it("starts session, executes turn with streaming events, and completes", async () => {
      const tmpWorkspace = mkdtempSync(join(tmpdir(), "pi-rt-test-"));
      try {
        const mockModelRuntime = await createMockModelRuntime(["Pi", " Agent", " operational"]);

        const events: RuntimeEvent[] = [];
        const runtime = new PiRuntime(new Logger(), undefined, undefined, mockModelRuntime);

        const context: RuntimeContext = {
          project: DUMMY_PROJECT,
          workspacePath: tmpWorkspace,
          onEvent: (ev) => {
            events.push(ev);
          },
        };

        // 1. startSession
        const session = await runtime.startSession(context);
        expect(session.id).toBeDefined();
        expect(session.workspacePath).toBe(tmpWorkspace);

        // 2. startTurn
        const turn = await runtime.startTurn(context, session.id, "turn_101", "Hello Pi");
        expect(turn.id).toBeDefined();

        // Wait for async prompt turn to complete
        await new Promise((resolve) => setTimeout(resolve, 80));

        // Verify streaming deltas were emitted
        const deltas = events
          .filter((e) => e.type === "agent.message.delta" && e.turnId === "turn_101")
          .map((e) => (e.payload as any).delta);
        expect(deltas.join("")).toContain("Pi Agent operational");

        // Verify turn completed
        const completed = events.find(
          (e) => e.type === "turn.completed" && e.turnId === "turn_101",
        );
        expect(completed).toBeDefined();
        expect((completed!.payload as any).status).toBe("completed");
        expect((completed!.payload as any).finalText).toContain("Pi Agent operational");

        // 3. resumeSession
        const resumed = await runtime.resumeSession(context, session.id);
        expect(resumed.id).toBe(session.id);

        // 4. compactSession: a session this short has nothing to compact, which is not an error
        await runtime.compactSession(context, session.id);

        // 5. releaseSession
        await runtime.releaseSession(context, session.id);

        // Session lifecycle events belong to ProjectRuntime, not to the runtime
        expect(events.some((e) => e.type.startsWith("session.") || e.type === "turn.started")).toBe(
          false,
        );

        await runtime.stop();
      } finally {
        rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    });

    it("offers only read-only tools to a read-only session", async () => {
      const tmpWorkspace = mkdtempSync(join(tmpdir(), "pi-rt-readonly-"));
      try {
        const runtime = new PiRuntime(new Logger({ sink: () => {} }), undefined, undefined, await createMockModelRuntime());
        const context: RuntimeContext = {
          project: DUMMY_PROJECT,
          workspacePath: tmpWorkspace,
          readOnly: true,
          onEvent: () => {},
        };
        const session = await runtime.startSession(context);
        const wrapper = (runtime as any).sessions.get(session.id);
        expect(wrapper.session.getActiveToolNames().sort()).toEqual(["find", "grep", "ls", "read"]);
        await runtime.stop();
      } finally {
        rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    });

    it("handles turn interruption cleanly", async () => {
      const tmpWorkspace = mkdtempSync(join(tmpdir(), "pi-rt-interrupt-"));
      try {
        const mockModelRuntime = await createMockModelRuntime(["long", " run"]);
        const events: RuntimeEvent[] = [];
        const runtime = new PiRuntime(new Logger(), undefined, undefined, mockModelRuntime);

        const context: RuntimeContext = {
          project: DUMMY_PROJECT,
          workspacePath: tmpWorkspace,
          onEvent: (ev) => {
            events.push(ev);
          },
        };

        const session = await runtime.startSession(context);
        const turn = await runtime.startTurn(context, session.id, "turn_202", "Run long task");

        // Immediately interrupt
        await runtime.interruptTurn(context, session.id, turn.id);

        const interrupted = events.find(
          (e) => e.type === "turn.interrupted" && e.turnId === "turn_202",
        );
        expect(interrupted).toBeDefined();
        expect((interrupted!.payload as any).status).toBe("interrupted");

        await runtime.releaseSession(context, session.id);
        await runtime.stop();
      } finally {
        rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    });

    it("forwards steer input without emitting synthetic messages", async () => {
      const tmpWorkspace = mkdtempSync(join(tmpdir(), "pi-rt-steer-"));
      try {
        const mockModelRuntime = await createMockModelRuntime(["hello"]);
        const events: RuntimeEvent[] = [];
        const runtime = new PiRuntime(new Logger(), undefined, undefined, mockModelRuntime);

        const context: RuntimeContext = {
          project: DUMMY_PROJECT,
          workspacePath: tmpWorkspace,
          onEvent: (ev) => {
            events.push(ev);
          },
        };

        const session = await runtime.startSession(context);
        const turn = await runtime.startTurn(context, session.id, "turn_303", "Initial prompt");

        await runtime.steerTurn(context, session.id, turn.id, "Change direction please");

        const steerEcho = events.find((e) =>
          String((e.payload as any).text ?? "").includes("Change direction please"),
        );
        expect(steerEcho).toBeUndefined();

        await runtime.releaseSession(context, session.id);
        await runtime.stop();
      } finally {
        rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    });

    it("handles prompt failure by emitting turn.failed", async () => {
      const tmpWorkspace = mkdtempSync(join(tmpdir(), "pi-rt-fail-"));
      try {
        const mr = await ModelRuntime.create();
        mr.registerProvider("failing-provider", {
          name: "Failing Provider",
          baseUrl: "http://localhost:8080",
          api: "openai-codex",
          models: [
            {
              id: "failing-model",
              name: "Failing Model",
              api: "openai-codex",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
          streamSimple: () => {
            const stream = createAssistantMessageEventStream();
            setTimeout(() => {
              stream.push({
                type: "done",
                reason: "error",
                error: "Provider rate limit reached (429)",
                message: {
                  role: "assistant",
                  content: [],
                  stopReason: "error",
                  errorMessage: "Provider rate limit reached (429)",
                },
              } as any);
              stream.end();
            }, 5);
            return stream;
          },
        });
        await mr.setRuntimeApiKey("failing-provider", "key");

        const events: RuntimeEvent[] = [];
        const runtime = new PiRuntime(new Logger(), undefined, undefined, mr);

        const context: RuntimeContext = {
          project: {
            ...DUMMY_PROJECT,
            runtime: {
              type: "pi",
              model: "failing-provider/failing-model",
            },
          },
          workspacePath: tmpWorkspace,
          onEvent: (ev) => {
            events.push(ev);
          },
        };

        const session = await runtime.startSession(context);
        const turn = await runtime.startTurn(context, session.id, "turn_fail_1", "This will fail");
        expect(turn.id).toBeDefined();

        // Wait for prompt failure
        await new Promise((resolve) => setTimeout(resolve, 80));

        const failed = events.find((e) => e.type === "turn.failed" && e.turnId === "turn_fail_1");
        expect(failed).toBeDefined();
        expect((failed!.payload as any).status).toBe("failed");
        expect((failed!.payload as any).error).toContain("Provider rate limit reached");

        await runtime.releaseSession(context, session.id);
        await runtime.stop();
      } finally {
        rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    });

    it("resolves models from Pi's own models.json, and an unknown model is an error", async () => {
      const tmpWorkspace = mkdtempSync(join(tmpdir(), "pi-rt-models-"));
      await Bun.write(
        join(piAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            deepseek: {
              baseUrl: "https://llm.example.com",
              apiKey: "sk-test-key",
              api: "openai-completions",
              models: [{ id: "deepseek-flash", contextWindow: 1000000, maxTokens: 384000 }],
            },
          },
        }),
      );
      const runtime = new PiRuntime(new Logger({ sink: () => {} }));
      try {
        const context = (model: string): RuntimeContext => ({
          project: { ...DUMMY_PROJECT, runtime: { type: "pi", model } },
          workspacePath: tmpWorkspace,
          onEvent: () => {},
        });
        const session = await runtime.startSession(context("deepseek/deepseek-flash"));
        const wrapper = (runtime as any).sessions.get(session.id);
        expect(wrapper.session.model?.id).toBe("deepseek-flash");
        expect(wrapper.session.model?.contextWindow).toBe(1000000);

        await expect(runtime.startSession(context("deepseek/unknown"))).rejects.toThrow(
          "Pi model deepseek/unknown is not configured",
        );
      } finally {
        await runtime.stop();
        rmSync(join(piAgentDir, "models.json"), { force: true });
        rmSync(tmpWorkspace, { recursive: true, force: true });
      }
    });
  });
});
