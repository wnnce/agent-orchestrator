import { describe, expect, it } from "bun:test";
import { FeishuClient } from "../src/channels/feishu/client.ts";
import { buildFeishuCard, formatQuote } from "../src/channels/feishu/card.ts";
import { FeishuSessionStreamer } from "../src/channels/feishu/streamer.ts";
import { MemoryEventHub } from "../src/events/hub.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import type { EventRecord } from "../src/domain/types.ts";

describe("Feishu Card Builder", () => {
  it("builds Schema 2.0 card without thought content in markdown", () => {
    const card = buildFeishuCard({
      title: "🔄 Agent 正在处理中",
      headerTemplate: "blue",
      statusLine: "💭 正在深度思考中...",
      contentMarkdown: "Here is the direct answer to your question.",
      durationMs: 4200,
      isFinished: false,
    }) as any;

    expect(card.schema).toBe("2.0");
    expect(card.header.title.content).toBe("🔄 Agent 正在处理中");
    expect(card.header.template).toBe("blue");

    // Elements should contain statusLine and content, but no internal thinking trace
    const elements = card.body.elements;
    expect(elements.length).toBe(2);
    expect(elements[0].text.content).toContain("💭 正在深度思考中...");
    expect(elements[1].text.content).toBe("Here is the direct answer to your question.");
    expect(JSON.stringify(card)).not.toContain("internal secret thoughts");
  });

  it("builds finished card with green header, content, and duration", () => {
    const card = buildFeishuCard({
      statusLine: "✅ 任务已完成",
      contentMarkdown: "Final solution delivered.",
      durationMs: 5300,
      isFinished: true,
    }) as any;

    expect(card.header.template).toBe("green");
    expect(card.header.title.content).toBe("✅ Agent 执行完成");
    const jsonStr = JSON.stringify(card);
    expect(jsonStr).toContain("Final solution delivered.");
    expect(jsonStr).toContain("5.3s");
  });

  it("formatQuote formats text into Markdown blockquote (> ...)", () => {
    expect(formatQuote("正在分析需求")).toBe("> 正在分析需求");
    expect(formatQuote("> 已经引用")).toBe("> 已经引用");
    expect(formatQuote("第一行\n第二行")).toBe("> 第一行\n> 第二行");
    expect(formatQuote("")).toBe("");
  });

  it("builds intermediate card with updatable quote text and no incremental body text", () => {
    const card = buildFeishuCard({
      statusLine: "⚡ 正在执行: 命令: git status",
      isFinished: false,
    }) as any;

    expect(card.header.template).toBe("blue");
    expect(card.header.title.content).toBe("🔄 Agent 正在处理中");
    expect(card.body.elements.length).toBe(1);
    expect(card.body.elements[0].text.content).toBe("> ⚡ 正在执行: 命令: git status");
  });

  it("can render a conversation card without a header title", () => {
    const card = buildFeishuCard({
      showHeader: false,
      statusLine: "💡 任务已完成",
      contentMarkdown: "Final answer",
      isFinished: true,
    }) as any;
    expect(card.header).toBeUndefined();
    expect(card.body.elements[0].text.content).toContain("任务已完成");
    expect(card.body.elements[1].text.content).toBe("Final answer");
  });
});

describe("FeishuClient", () => {
  it("acquires and caches tenant_access_token", async () => {
    let tokenRequestCount = 0;
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/auth/v3/tenant_access_token/internal")) {
        tokenRequestCount++;
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            tenant_access_token: "t-mock-token-12345",
            expire: 7200,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new FeishuClient({
      appId: "cli_mock_app",
      appSecret: "sec_mock_secret",
      fetchFn: mockFetch as any,
    });

    const token1 = await client.getTenantAccessToken();
    const token2 = await client.getTenantAccessToken();

    expect(token1).toBe("t-mock-token-12345");
    expect(token2).toBe("t-mock-token-12345");
    expect(tokenRequestCount).toBe(1); // Cached, no second network request
  });

  it("sends card with reply-in-thread root_id and updates card via PATCH", async () => {
    const recordedRequests: Array<{ url: string; method: string; body: any }> = [];

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      recordedRequests.push({ url: urlStr, method, body });

      if (urlStr.includes("/auth/v3/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            tenant_access_token: "t-mock-token",
            expire: 7200,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: { message_id: "om_initial_card_999" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/open-apis/im/v1/messages/om_initial_card_999")) {
        return new Response(JSON.stringify({ code: 0, msg: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new FeishuClient({
      appId: "cli_app",
      appSecret: "sec_secret",
      fetchFn: mockFetch as any,
    });

    const messageId = await client.sendCard({
      receiveId: "oc_test_chat_id",
      receiveIdType: "chat_id",
      rootId: "om_user_prompt_id",
      card: { test: "card_content" },
    });

    expect(messageId).toBe("om_initial_card_999");
    const sendReq = recordedRequests.find(
      (r) => r.method === "POST" && r.url.includes("/messages"),
    );
    expect(sendReq?.body.root_id).toBe("om_user_prompt_id");
    expect(sendReq?.body.receive_id).toBe("oc_test_chat_id");

    await client.updateCard({
      messageId,
      card: { test: "updated_card" },
    });

    const updateReq = recordedRequests.find((r) => r.method === "PATCH");
    expect(updateReq).toBeDefined();
    expect(updateReq?.body.content).toBe(JSON.stringify({ test: "updated_card" }));
  });
});

describe("FeishuSessionStreamer", () => {
  it("keeps one Session subscription and renders one card per Turn", async () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);
    const sentCards: any[] = [];
    const updatedCards: any[] = [];
    const client = new FeishuClient({
      appId: "cli_session",
      appSecret: "sec_session",
      fetchFn: (async (url, init) => {
        const target = String(url);
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (target.includes("tenant_access_token"))
          return Response.json({ code: 0, tenant_access_token: "token", expire: 7200 });
        if (init?.method === "PATCH") {
          updatedCards.push(JSON.parse(body.content));
          return Response.json({ code: 0 });
        }
        sentCards.push(JSON.parse(body.content));
        return Response.json({
          code: 0,
          data: { message_id: `card-${sentCards.length}` },
        });
      }) as typeof fetch,
    });
    const streamer = new FeishuSessionStreamer(hub, client, undefined, { throttleMs: 0 });
    const sessionId = "ses_one_subscription";
    streamer.ensureSession({ sessionId, chatId: "oc_chat", projectId: "p" });
    streamer.enqueueTurn(sessionId, { chatId: "oc_chat", rootId: "om_a", projectId: "p" });
    streamer.enqueueTurn(sessionId, { chatId: "oc_chat", rootId: "om_b", projectId: "p" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = (sequence: number, turnId: string, type: EventRecord["type"], payload = {}) => ({
      id: `session-${sequence}`,
      projectId: "p",
      sessionId,
      turnId,
      sequence,
      type,
      runtime: "fake" as const,
      payload,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    for (const item of [
      event(1, "turn-a", "turn.queued"),
      event(2, "turn-a", "agent.message.completed", {
        phase: "final_answer",
        text: "answer A",
      }),
      event(3, "turn-a", "turn.completed", { finalText: "answer A" }),
      event(4, "turn-b", "turn.queued"),
      event(5, "turn-b", "agent.message.completed", {
        phase: "final_answer",
        text: "answer B",
      }),
      event(6, "turn-b", "turn.completed", { finalText: "answer B" }),
    ]) {
      await store.appendEvent(item);
      hub.publish(item);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await streamer.closeSession(sessionId);

    expect(sentCards).toHaveLength(2);
    expect(updatedCards.some((card) => JSON.stringify(card).includes("answer A"))).toBe(true);
    expect(updatedCards.some((card) => JSON.stringify(card).includes("answer B"))).toBe(true);
  });

  it("streams events, filters thoughts, and updates card to green completed state", async () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);

    const updatedCards: any[] = [];
    let initialSent = false;

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      if (urlStr.includes("/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "tok", expire: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/im/v1/messages?") && init?.method === "POST") {
        initialSent = true;
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", data: { message_id: "om_stream_card_1" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "PATCH") {
        updatedCards.push(JSON.parse(body.content));
        return new Response(JSON.stringify({ code: 0, msg: "ok" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new FeishuClient({
      appId: "cli_test",
      appSecret: "sec_test",
      fetchFn: mockFetch as any,
    });

    const streamer = new FeishuSessionStreamer(hub, client, undefined, { throttleMs: 50 });

    const sessionId = "ses_feishu_test";
    const streamPromise = streamer.streamSession({
      sessionId,
      chatId: "oc_chat_1",
      rootId: "om_user_root",
    });

    // Wait for initial send
    await new Promise((r) => setTimeout(r, 20));
    expect(initialSent).toBe(true);

    // 1. Emit thought event (should be filtered from markdown text)
    hub.publish({
      id: "evt_1",
      projectId: "p1",
      sessionId,
      sequence: 1,
      type: "thought",
      runtime: "codex",
      payload: { text: "Thinking about the inner architecture..." },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    // 2. Emit tool call
    hub.publish({
      id: "evt_2",
      projectId: "p1",
      sessionId,
      sequence: 2,
      type: "tool.call.started",
      runtime: "codex",
      payload: { command: "git status" },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    // 3. Emit message delta
    hub.publish({
      id: "evt_3",
      projectId: "p1",
      sessionId,
      sequence: 3,
      type: "agent.message.delta",
      runtime: "codex",
      payload: { delta: "Hello from Feishu Outbound!" },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    // 4. Emit turn.completed
    hub.publish({
      id: "evt_4",
      projectId: "p1",
      sessionId,
      sequence: 4,
      type: "turn.completed",
      runtime: "codex",
      payload: {},
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    await streamPromise;

    expect(updatedCards.length).toBeGreaterThan(0);

    // Verify intermediate cards: intermediate process is presented as updatable quote without incremental text stream
    const intermediateCards = updatedCards.slice(0, -1);
    for (const interCard of intermediateCards) {
      expect(interCard.body.elements.length).toBe(1);
      expect(interCard.body.elements[0].text.content.startsWith("> ")).toBe(true);
      expect(JSON.stringify(interCard)).not.toContain("Hello from Feishu Outbound!");
    }

    const finalCard = updatedCards.at(-1);

    expect(finalCard.header.template).toBe("green");
    expect(finalCard.header.title.content).toBe("✅ Agent 执行完成");

    // Final card contains both the quote block and the final result
    expect(finalCard.body.elements[0].text.content.startsWith("> ")).toBe(true);
    expect(finalCard.body.elements[1].text.content).toBe("Hello from Feishu Outbound!");

    const jsonText = JSON.stringify(finalCard);
    expect(jsonText).toContain("Hello from Feishu Outbound!");
    // Thought text MUST NOT appear in the final card
    expect(jsonText).not.toContain("Thinking about the inner architecture");
  });

  it("updates stage reply (commentary) in quote block without delta typing and mounts final answer in body", async () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);
    const updatedCards: any[] = [];

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      if (urlStr.includes("/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "tok", expire: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/im/v1/messages?") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", data: { message_id: "om_stage_card_1" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "PATCH") {
        updatedCards.push(JSON.parse(body.content));
        return new Response(JSON.stringify({ code: 0, msg: "ok" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new FeishuClient({
      appId: "cli_test",
      appSecret: "sec_test",
      fetchFn: mockFetch as any,
    });

    const streamer = new FeishuSessionStreamer(hub, client, undefined, { throttleMs: 10 });
    const sessionId = "ses_stage_test";
    const streamPromise = streamer.streamSession({
      sessionId,
      chatId: "oc_chat_stage",
      rootId: "om_stage_root",
    });

    await new Promise((r) => setTimeout(r, 20));

    // 1. Thinking phase -> quote shows fixed thinking placeholder
    hub.publish({
      id: "evt_1",
      projectId: "p1",
      sessionId,
      sequence: 1,
      type: "thought",
      runtime: "codex",
      payload: { text: "Deep internal reasoning..." },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    await new Promise((r) => setTimeout(r, 20));

    // 2. Commentary item started and deltas streamed -> should NOT incremental stream in quote/body
    hub.publish({
      id: "evt_2",
      projectId: "p1",
      sessionId,
      sequence: 2,
      type: "item.started",
      runtime: "codex",
      payload: { item: { id: "msg_stage", type: "agentMessage", phase: "commentary" } },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    hub.publish({
      id: "evt_3",
      projectId: "p1",
      sessionId,
      sequence: 3,
      type: "agent.message.delta",
      runtime: "codex",
      payload: { itemId: "msg_stage", delta: "我会先查看" },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    // 3. Commentary completed -> entire stage text replaces quote block
    hub.publish({
      id: "evt_4",
      projectId: "p1",
      sessionId,
      sequence: 4,
      type: "agent.message.completed",
      runtime: "codex",
      payload: {
        itemId: "msg_stage",
        phase: "commentary",
        text: "我会先查看项目结构并确认布局。",
      },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    await new Promise((r) => setTimeout(r, 25));

    // 4. Command execution starts -> quote block updates to tool execution
    hub.publish({
      id: "evt_5",
      projectId: "p1",
      sessionId,
      sequence: 5,
      type: "command.started",
      runtime: "codex",
      payload: { itemId: "cmd_1", command: "ls -la /app/projects" },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    await new Promise((r) => setTimeout(r, 25));

    // 5. Final answer completion
    hub.publish({
      id: "evt_7",
      projectId: "p1",
      sessionId,
      sequence: 7,
      type: "agent.message.completed",
      runtime: "codex",
      payload: {
        itemId: "msg_final",
        phase: "final_answer",
        text: "### 分析结论\n已完成对工程结构的全面梳理。",
      },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    hub.publish({
      id: "evt_8",
      projectId: "p1",
      sessionId,
      sequence: 8,
      type: "turn.completed",
      runtime: "codex",
      payload: {
        finalText: "### 分析结论\n已完成对工程结构的全面梳理。",
      },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    await streamPromise;

    // Check history of updated cards
    expect(updatedCards.length).toBeGreaterThan(2);

    // Verify stage card: quote contains stage commentary, body has no incremental text
    const stageCard = updatedCards.find((c) =>
      c.body.elements[0]?.text?.content?.includes("我会先查看项目结构并确认布局。"),
    );
    expect(stageCard).toBeDefined();
    expect(stageCard.body.elements.length).toBe(1); // Only quote, no body
    expect(stageCard.body.elements[0].text.content.startsWith("> ")).toBe(true);

    // Verify tool card: quote contains tool command
    const toolCard = updatedCards.find((c) =>
      c.body.elements[0]?.text?.content?.includes("正在执行: 命令: ls -la /app/projects"),
    );
    expect(toolCard).toBeDefined();
    expect(toolCard.body.elements.length).toBe(1);

    // Verify final card: quote shows completion, body contains final markdown
    const finalCard = updatedCards.at(-1);
    expect(finalCard.header.template).toBe("green");
    expect(finalCard.body.elements[0].text.content).toContain("💡 任务已完成");
    expect(finalCard.body.elements[1].text.content).toContain(
      "### 分析结论\n已完成对工程结构的全面梳理。",
    );
  });

  it("never drops final completed card update even when an update is currently in flight", async () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);
    const updatedCards: any[] = [];

    // Mock fetch that artificially delays PATCH calls by 60ms to simulate slow network
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;

      if (urlStr.includes("/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "tok", expire: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/im/v1/messages?") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", data: { message_id: "om_race_card" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "PATCH") {
        await new Promise((r) => setTimeout(r, 60));
        updatedCards.push(JSON.parse(body.content));
        return new Response(JSON.stringify({ code: 0, msg: "ok" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new FeishuClient({
      appId: "cli_test",
      appSecret: "sec_test",
      fetchFn: mockFetch as any,
    });

    const streamer = new FeishuSessionStreamer(hub, client, undefined, { throttleMs: 20 });
    const sessionId = "ses_race_test";
    const streamPromise = streamer.streamSession({
      sessionId,
      chatId: "oc_chat_race",
      rootId: "om_race_root",
      projectId: "_global_",
    });

    await new Promise((r) => setTimeout(r, 20));

    // Emit a delta to trigger intermediate flush
    hub.publish({
      id: "evt_1",
      projectId: "_global_",
      sessionId,
      sequence: 1,
      type: "agent.message.delta",
      runtime: "codex",
      payload: { delta: "正在分析..." },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    // Wait slightly so timer flush is launched and in-flight (PATCH takes 60ms)
    await new Promise((r) => setTimeout(r, 25));

    // While PATCH is in-flight, immediately emit turn.completed with final text
    hub.publish({
      id: "evt_2",
      projectId: "_global_",
      sessionId,
      sequence: 2,
      type: "turn.completed",
      runtime: "codex",
      payload: {
        finalText: "这是最终分析结论，绝对不能被丢失！",
      },
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    // Wait for streamer to finish
    await streamPromise;

    // The final card must be delivered and have isFinished=true and the final content!
    expect(updatedCards.length).toBeGreaterThan(0);
    const finalCard = updatedCards.at(-1);
    expect(finalCard.header.template).toBe("green");
    expect(finalCard.header.title.content).toContain("全局分析完成");
    const jsonStr = JSON.stringify(finalCard);
    expect(jsonStr).toContain("这是最终分析结论，绝对不能被丢失！");
  });
});

describe("Feishu /close Command", () => {
  it("closes active session on /close and subsequent message creates fresh session", async () => {
    const store = new MemoryStore();
    const hub = new MemoryEventHub(store);
    const sentCards: any[] = [];

    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (urlStr.includes("/tenant_access_token/internal")) {
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "tok", expire: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes("/im/v1/messages?") && init?.method === "POST") {
        sentCards.push(JSON.parse(body.content));
        return new Response(
          JSON.stringify({ code: 0, msg: "ok", data: { message_id: "om_close_card" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new FeishuClient({
      appId: "cli_app",
      appSecret: "sec_secret",
      fetchFn: mockFetch as any,
    });

    const project: any = {
      id: "close-test-proj",
      displayName: "Close Test Proj",
      description: "testing /close",
      routing: {
        projectId: "close-test-proj",
        displayName: "Test",
        summary: "test",
        keywords: ["close-test"],
      },
      runtime: { type: "fake" },
      repository: { url: "", baseBranch: "main" },
    };

    const config: any = {
      port: 7070,
      host: "127.0.0.1",
      dataDir: "/tmp/feishu-close-test-data",
      artifactDir: "/tmp/feishu-close-test-artifacts",
      projectConfigPath: "/tmp/feishu-close-test-projects",
      allowUnauthenticated: true,
      codex: {},
      logLevel: "info",
      feishu: {
        enabled: true,
        verificationToken: "tok",
        appId: "cli_app",
        appSecret: "sec_secret",
      },
    };

    const { Logger } = await import("../src/observability/logger.ts");
    const { ProjectManager } = await import("../src/project/manager.ts");
    const { GatewayService } = await import("../src/gateway/service.ts");

    const logger = new Logger();
    const projectManager = new ProjectManager([project], store, config, logger, hub);
    await projectManager.start();

    try {
      const gatewayService = new GatewayService(config, store, projectManager, logger, hub, client);

      // 1. Initial message creating session
      const res1 = await gatewayService.handleInbound({
        messageId: "msg-1",
        conversation: { channel: "feishu", conversationId: "chat-feishu-100" },
        text: "close-test first question",
        receivedAt: new Date().toISOString(),
      });
      expect(res1.session).toBeDefined();
      const firstSessionId = res1.session.sessionId;
      expect(await store.getSession(firstSessionId)).toBeDefined();

      // 2. Send /close command
      const resClose = await gatewayService.handleInbound({
        messageId: "msg-2",
        conversation: { channel: "feishu", conversationId: "chat-feishu-100" },
        text: "/close",
        receivedAt: new Date().toISOString(),
      });
      expect(resClose.command).toBe("close");
      expect(resClose.session.sessionId).toBe(firstSessionId);

      // Verify session was cleaned up
      expect(await store.getSession(firstSessionId)).toBeNull();

      // Verify confirmation card was sent to Feishu
      expect(sentCards.length).toBeGreaterThan(0);
      const closeCard = sentCards.at(-1);
      expect(closeCard.header.title.content).toContain("会话已关闭");

      // 3. Subsequent message creates a brand new session!
      const res3 = await gatewayService.handleInbound({
        messageId: "msg-3",
        conversation: { channel: "feishu", conversationId: "chat-feishu-100" },
        text: "close-test second new session",
        receivedAt: new Date().toISOString(),
      });
      expect(res3.session.sessionId).not.toBe(firstSessionId);
    } finally {
      await projectManager.stop();
    }
  });
});
