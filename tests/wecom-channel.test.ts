import { describe, expect, it } from "bun:test";
import { WeComClient } from "../src/channels/wecom/client.ts";
import { WeComWSAdapter } from "../src/channels/wecom/ws.ts";
import {
  buildWeComMarkdown,
  buildWeComCancelMessage,
  buildWeComCloseMessage,
} from "../src/channels/wecom/card.ts";
import { WeComSessionStreamer } from "../src/channels/wecom/streamer.ts";
import type { EventRecord } from "../src/domain/types.ts";
import { MemoryEventHub } from "../src/events/hub.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { Logger } from "../src/observability/logger.ts";

let eventSeq = 0;
function createMockEvent(params: {
  type: string;
  sessionId: string;
  turnId?: string;
  sequence?: number;
  payload: Record<string, unknown>;
}): EventRecord {
  eventSeq++;
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    projectId: "p1",
    sessionId: params.sessionId,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    sequence: params.sequence ?? eventSeq,
    type: params.type,
    runtime: "codex",
    payload: params.payload,
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

describe("WeCom Channel Formatters (card.ts)", () => {
  it("formats running state with statusLine and partial content", () => {
    const markdown = buildWeComMarkdown({
      statusLine: "正在分析需求",
      contentMarkdown: "已找到入口函数",
      isFinished: false,
    });

    expect(markdown).toContain("> 正在分析需求");
    expect(markdown).toContain("已找到入口函数");
  });

  it("formats completed state with final text and duration", () => {
    const markdown = buildWeComMarkdown({
      contentMarkdown: "代码重构已完成。",
      durationMs: 3450,
      isFinished: true,
      outcome: "completed",
    });

    expect(markdown).toContain("代码重构已完成。");
    expect(markdown).toContain("⏱️ 耗时 3.5s");
    expect(markdown).not.toContain("<font");
  });

  it("formats failed and interrupted states", () => {
    const failedMarkdown = buildWeComMarkdown({
      contentMarkdown: "连接数据库超时",
      isFinished: true,
      outcome: "failed",
    });
    expect(failedMarkdown).toContain("❌ **任务执行出错**");
    expect(failedMarkdown).toContain("连接数据库超时");
    expect(failedMarkdown).not.toContain("<font");

    const interruptedMarkdown = buildWeComMarkdown({
      isFinished: true,
      outcome: "interrupted",
    });
    expect(interruptedMarkdown).toContain("⚠️ **任务已中断**");
    expect(interruptedMarkdown).not.toContain("<font");
  });

  it("formats cancel and close messages", () => {
    expect(buildWeComCancelMessage(true)).toContain("当前任务已取消");
    expect(buildWeComCancelMessage(true)).not.toContain("<font");
    expect(buildWeComCancelMessage(false)).toContain("当前无活跃会话");
    expect(buildWeComCancelMessage(false)).not.toContain("<font");

    const closeMsg = buildWeComCloseMessage();
    expect(closeMsg).toContain("会话已关闭");
    expect(closeMsg).toContain("Git 工作区与进程资源已安全释放");
  });
});

describe("WeComWSAdapter", () => {
  const logger = new Logger({ level: "error" });

  it("parses group chat message with leading @Robot mention stripped", () => {
    const client = new WeComClient({ botId: "bot123", secret: "sec123" }, logger);
    const adapter = new WeComWSAdapter(client, async () => {}, logger);

    const frame = {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req_group_1" },
      body: {
        msgid: "msg_group_999",
        aibotid: "bot123",
        chatid: "chat_group_888",
        chattype: "group",
        from: { userid: "user_alice" },
        msgtype: "text",
        text: { content: "@小助手 请帮我分析下最新 commit" },
      },
    };

    const envelope = adapter.parseWSMessage(frame);
    expect(envelope).toBeDefined();
    expect(envelope!.messageId).toBe("msg_group_999");
    expect(envelope!.conversation.channel).toBe("wecom");
    expect(envelope!.conversation.conversationId).toBe("chat_group_888");
    expect(envelope!.senderId).toBe("user_alice");
    expect(envelope!.text).toBe("请帮我分析下最新 commit");
    expect(envelope!.metadata?.reqId).toBe("req_group_1");
    expect(envelope!.metadata?.chatType).toBe("group");
  });

  it("parses single 1v1 chat message without chatid", () => {
    const client = new WeComClient({ botId: "bot123", secret: "sec123" }, logger);
    const adapter = new WeComWSAdapter(client, async () => {}, logger);

    const frame = {
      cmd: "aibot_msg_callback",
      headers: { req_id: "req_single_1" },
      body: {
        msgid: "msg_single_777",
        aibotid: "bot123",
        chattype: "single",
        from: { userid: "user_bob" },
        msgtype: "text",
        text: { content: "你好，请问你是谁？" },
      },
    };

    const envelope = adapter.parseWSMessage(frame);
    expect(envelope).toBeDefined();
    expect(envelope!.messageId).toBe("msg_single_777");
    expect(envelope!.conversation.channel).toBe("wecom");
    expect(envelope!.conversation.conversationId).toBe("user_bob");
    expect(envelope!.senderId).toBe("user_bob");
    expect(envelope!.text).toBe("你好，请问你是谁？");
    expect(envelope!.metadata?.chatType).toBe("single");
  });

  it("ignores non-text or empty messages", () => {
    const client = new WeComClient({ botId: "bot123", secret: "sec123" }, logger);
    const adapter = new WeComWSAdapter(client, async () => {}, logger);

    expect(
      adapter.parseWSMessage({
        headers: { req_id: "1" },
        body: { msgtype: "image", image: { url: "..." } },
      }),
    ).toBeUndefined();

    expect(
      adapter.parseWSMessage({
        headers: { req_id: "2" },
        body: { msgtype: "text", text: { content: "@Robot   " } },
      }),
    ).toBeUndefined();
  });
});

describe("WeComSessionStreamer", () => {
  const logger = new Logger({ level: "error" });

  it("enqueues turn and streams events to WeComClient.replyStream", async () => {
    const store = new MemoryStore();
    const eventHub = new MemoryEventHub(store);
    const client = new WeComClient({ botId: "bot123", secret: "sec123" }, logger);

    const calls: Array<{ reqId: string; streamId: string; content: string; finish: boolean }> = [];
    (client as any).replyStream = async (
      reqId: string,
      streamId: string,
      content: string,
      finish: boolean,
    ) => {
      calls.push({ reqId, streamId, content, finish });
    };

    const streamer = new WeComSessionStreamer(eventHub, client, logger, { throttleMs: 10 });
    const sessionId = "sess_wecom_test_1";

    eventSeq = 0;
    streamer.ensureSession({
      sessionId,
      chatId: "chat_123",
      source: "wecom",
    });

    // Allow event stream subscription to establish
    await new Promise((r) => setTimeout(r, 20));

    streamer.enqueueTurn(sessionId, {
      chatId: "chat_123",
      reqId: "req_turn_1",
      streamId: "stream_turn_1",
    });

    eventHub.publish(
      createMockEvent({ type: "turn.queued", sessionId, turnId: "turn_1", payload: {} }),
    );

    // 1. Initial tool call
    eventHub.publish(
      createMockEvent({
        type: "item.started",
        sessionId,
        turnId: "turn_1",
        payload: {
          item: {
            id: "item_1",
            type: "command_execution",
            command: "git status",
          },
        },
      }),
    );

    // 2. Message delta
    eventHub.publish(
      createMockEvent({
        type: "agent.message.delta",
        sessionId,
        turnId: "turn_1",
        payload: {
          delta: "已检查仓库状态，一切就绪。",
        },
      }),
    );

    // 3. Turn completed
    eventHub.publish(
      createMockEvent({
        type: "turn.completed",
        sessionId,
        turnId: "turn_1",
        payload: {
          turn: {
            items: [{ type: "agentMessage", text: "已检查仓库状态，一切就绪。" }],
          },
        },
      }),
    );

    // Wait a brief moment for async flush
    await new Promise((resolve) => setTimeout(resolve, 50));
    await streamer.stop();

    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Intermediate stream calls during running should only have status quote, not repeated content
    const intermediateCalls = calls.filter((c) => !c.finish);
    for (const call of intermediateCalls) {
      expect(call.content).not.toContain("已检查仓库状态，一切就绪。");
    }

    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    expect(lastCall!.reqId).toBe("req_turn_1");
    expect(lastCall!.streamId).toBe("stream_turn_1");
    expect(lastCall!.finish).toBe(true);
    expect(lastCall!.content).toContain("已检查仓库状态，一切就绪。");
    expect(lastCall!.content).not.toContain("<font");
  });

  it("binds a new message to its own Turn when the Session already has earlier Turn events", async () => {
    const store = new MemoryStore();
    const eventHub = new MemoryEventHub(store);
    const client = new WeComClient({ botId: "bot123", secret: "sec123" }, logger);
    const calls: Array<{ streamId: string; content: string; finish: boolean }> = [];
    (client as any).replyStream = async (
      _reqId: string,
      streamId: string,
      content: string,
      finish: boolean,
    ) => {
      calls.push({ streamId, content, finish });
    };
    const sessionId = "sess_wecom_restart";
    // A Turn that finished before the process restarted, including its trailing notification.
    for (const [sequence, type] of [
      [1, "turn.queued"],
      [2, "turn.failed"],
      [3, "notification.queued"],
    ] as const) {
      await store.appendEvent(
        createMockEvent({ type, sessionId, turnId: "turn_old", sequence, payload: {} }),
      );
    }

    const streamer = new WeComSessionStreamer(eventHub, client, logger, { throttleMs: 10 });
    streamer.ensureSession({ sessionId, chatId: "chat_123", source: "wecom" });
    streamer.enqueueTurn(sessionId, {
      chatId: "chat_123",
      reqId: "req_new",
      streamId: "stream_new",
    });
    for (const [sequence, type, payload] of [
      [4, "turn.queued", {}],
      [5, "turn.completed", { finalText: "新问题的回答" }],
    ] as const) {
      eventHub.publish(createMockEvent({ type, sessionId, turnId: "turn_new", sequence, payload }));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await streamer.stop();

    expect(calls.every((call) => call.streamId === "stream_new")).toBe(true);
    const final = calls.at(-1)!;
    expect(final.finish).toBe(true);
    expect(final.content).toContain("新问题的回答");
  });
});
