import { describe, expect, it } from "bun:test";
import {
  NotificationRegistry,
  NotificationHub,
  NotificationOutbox,
  FeishuNotificationProvider,
  WeComNotificationProvider,
  WebhookNotificationProvider,
  TelegramNotificationProvider,
  type NotificationProvider,
  type NotificationMessage,
  formatFeishuMarkdown,
  formatWeComMarkdown,
} from "../src/notifications/index.ts";
import type { NotificationConfig } from "../src/domain/types.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { Logger } from "../src/observability/logger.ts";
import { createActionContext } from "../src/actions/context.ts";
import { mergeNotifications } from "../src/project/manager.ts";

describe("NotificationRegistry", () => {
  it("registers, retrieves, checks, and unregisters providers", () => {
    const registry = new NotificationRegistry();

    const mockProvider: NotificationProvider = {
      type: "email",
      send: async () => {},
    };

    expect(registry.has("email")).toBe(false);
    registry.register(mockProvider);
    expect(registry.has("email")).toBe(true);
    expect(registry.get("EMAIL")).toBe(mockProvider); // Case-insensitive
    expect(registry.list()).toContain(mockProvider);

    expect(registry.unregister("email")).toBe(true);
    expect(registry.has("email")).toBe(false);
  });
});

describe("NotificationHub Target Filtering", () => {
  const hub = new NotificationHub();

  const configs: NotificationConfig[] = [
    { name: "feishu-dev", type: "feishu", url: "https://feishu.example/hook1", enabled: true },
    { name: "wecom-ops", type: "wecom", url: "https://wecom.example/hook2", enabled: true },
    { name: "backup-log", type: "log", enabled: true },
    { name: "disabled-channel", type: "webhook", url: "https://hook.example/3", enabled: false },
  ];

  it("selects all active channels when target is 'all' or omitted", () => {
    const all = hub.filterConfigs(configs, { target: "all" });
    expect(all.length).toBe(3);
    expect(all.map((c) => c.name)).toEqual(["feishu-dev", "wecom-ops", "backup-log"]);

    const defaultTarget = hub.filterConfigs(configs);
    expect(defaultTarget.length).toBe(3);
  });

  it("filters by provider type (e.g. 'feishu')", () => {
    const feishuOnly = hub.filterConfigs(configs, { target: "feishu" });
    expect(feishuOnly.length).toBe(1);
    expect(feishuOnly[0]?.name).toBe("feishu-dev");

    const wecomOnly = hub.filterConfigs(configs, { target: "wecom" });
    expect(wecomOnly.length).toBe(1);
    expect(wecomOnly[0]?.name).toBe("wecom-ops");
  });

  it("filters by array of multiple targets", () => {
    const selected = hub.filterConfigs(configs, { target: ["feishu", "wecom"] });
    expect(selected.length).toBe(2);
    expect(selected.map((c) => c.name)).toEqual(["feishu-dev", "wecom-ops"]);
  });

  it("filters by specific channel name", () => {
    const byName = hub.filterConfigs(configs, { target: "wecom-ops" });
    expect(byName.length).toBe(1);
    expect(byName[0]?.name).toBe("wecom-ops");
  });

  it("returns empty array if no configs match target", () => {
    const none = hub.filterConfigs(configs, { target: "email" });
    expect(none.length).toBe(0);
  });
});

describe("NotificationHub Dispatching & Error Resilience", () => {
  it("delivers to matching registered providers and collects results", async () => {
    const registry = new NotificationRegistry();
    const delivered: string[] = [];

    const mockFeishu: NotificationProvider = {
      type: "feishu",
      send: async (msg, cfg) => {
        delivered.push(`feishu:${cfg.name}:${msg.title}`);
      },
    };

    const mockWeCom: NotificationProvider = {
      type: "wecom",
      send: async (msg, cfg) => {
        delivered.push(`wecom:${cfg.name}:${msg.title}`);
      },
    };

    registry.register(mockFeishu);
    registry.register(mockWeCom);

    const hub = new NotificationHub(new Logger({ level: "error" }), registry);

    const configs: NotificationConfig[] = [
      { name: "f-group", type: "feishu", enabled: true },
      { name: "w-group", type: "wecom", enabled: true },
    ];

    // 1. Broadcast to all
    const resAll = await hub.send(
      configs,
      { title: "Broadcast", text: "Hello everyone" },
      { target: "all" },
    );
    expect(resAll.total).toBe(2);
    expect(resAll.sent).toBe(2);
    expect(resAll.failed).toBe(0);
    expect(delivered).toEqual(["feishu:f-group:Broadcast", "wecom:w-group:Broadcast"]);

    // 2. Target specific platform
    delivered.length = 0;
    const resWecom = await hub.send(
      configs,
      { title: "Ops Only", text: "High load" },
      { target: "wecom" },
    );
    expect(resWecom.total).toBe(1);
    expect(resWecom.sent).toBe(1);
    expect(delivered).toEqual(["wecom:w-group:Ops Only"]);
  });

  it("isolates provider failures without breaking other providers", async () => {
    const registry = new NotificationRegistry();

    registry.register({
      type: "failing-provider",
      send: async () => {
        throw new Error("Network timeout");
      },
    });

    registry.register({
      type: "good-provider",
      send: async () => {},
    });

    const hub = new NotificationHub(new Logger({ level: "error" }), registry);

    const configs: NotificationConfig[] = [
      { name: "broken", type: "failing-provider", enabled: true },
      { name: "healthy", type: "good-provider", enabled: true },
    ];

    const result = await hub.send(configs, { title: "Test", text: "Body" });
    expect(result.total).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details.find((d) => d.name === "broken")?.success).toBe(false);
    expect(result.details.find((d) => d.name === "healthy")?.success).toBe(true);
  });
});

describe("NotificationOutbox & ActionContext Integration", () => {
  it("dispatches notifications via in-memory queue and asynchronously records audit into store", async () => {
    const store = new MemoryStore();
    const registry = new NotificationRegistry();
    const received: string[] = [];

    registry.register({
      type: "wecom",
      send: async (msg) => {
        received.push(`wecom:${msg.title}`);
      },
    });
    registry.register({
      type: "feishu",
      send: async (msg) => {
        received.push(`feishu:${msg.title}`);
      },
    });

    const hub = new NotificationHub(new Logger({ level: "error" }), registry);
    const outbox = new NotificationOutbox(store, hub);

    const configs: NotificationConfig[] = [
      { name: "feishu-channel", type: "feishu", enabled: true },
      { name: "wecom-channel", type: "wecom", enabled: true },
    ];

    // Queue targeted notification via action context
    const ctx = createActionContext({
      projectId: "proj_target",
      sessionId: "ses_target",
      services: {
        notifications: outbox,
      },
      projectNotifications: configs,
    });

    await ctx.notify(
      { title: "Targeted to WeCom", text: "Special notification" },
      { target: "wecom" },
    );

    // Wait for in-memory queue to finish dispatch and async store record
    await outbox.drain();

    expect(received).toEqual(["wecom:Targeted to WeCom"]);

    const deliveries = await store.listNotificationDeliveries({ projectId: "proj_target" });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.status).toBe("sent");
    expect(deliveries[0]?.details.length).toBe(1);
    expect(deliveries[0]?.details[0]?.name).toBe("wecom-channel");
    expect(deliveries[0]?.details[0]?.success).toBe(true);
  });

  it("records 'partial' status with per-channel details when some providers fail", async () => {
    const store = new MemoryStore();
    const registry = new NotificationRegistry();

    registry.register({
      type: "feishu",
      send: async () => {}, // success
    });
    registry.register({
      type: "telegram",
      send: async () => {
        throw new Error("HTTP 401 Unauthorized");
      },
    });

    const hub = new NotificationHub(new Logger({ level: "error" }), registry);
    const outbox = new NotificationOutbox(store, hub);

    const configs: NotificationConfig[] = [
      { name: "feishu", type: "feishu", enabled: true },
      { name: "telegram", type: "telegram", enabled: true },
    ];

    await outbox.queue("p1", "s1", configs, { title: "Broadcast", text: "Test partial" });
    await outbox.drain();

    const deliveries = await store.listNotificationDeliveries({ projectId: "p1" });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.status).toBe("partial");
    expect(deliveries[0]?.details.length).toBe(2);

    const feishuDetail = deliveries[0]?.details.find((d) => d.name === "feishu");
    expect(feishuDetail?.success).toBe(true);

    const tgDetail = deliveries[0]?.details.find((d) => d.name === "telegram");
    expect(tgDetail?.success).toBe(false);
    expect(tgDetail?.error).toContain("401");
  });

  it("records 'failed' status without retrying when all providers fail", async () => {
    const store = new MemoryStore();
    const registry = new NotificationRegistry();

    registry.register({
      type: "webhook",
      send: async () => {
        throw new Error("Connection refused");
      },
    });

    const hub = new NotificationHub(new Logger({ level: "error" }), registry);
    const outbox = new NotificationOutbox(store, hub);

    const configs: NotificationConfig[] = [{ name: "broken-hook", type: "webhook", enabled: true }];

    await outbox.queue("p2", "s2", configs, { title: "Down", text: "Service dead" });
    await outbox.drain();

    const deliveries = await store.listNotificationDeliveries({ projectId: "p2" });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.status).toBe("failed");
    expect(deliveries[0]?.details[0]?.success).toBe(false);
    expect(deliveries[0]?.details[0]?.error).toContain("Connection refused");
  });
});

describe("Global & Project Notifications Inheritance and Override", () => {
  const globalConfigs: NotificationConfig[] = [
    { name: "feishu-ops", type: "feishu", url: "https://feishu.example/global", enabled: true },
    { name: "wecom-ops", type: "wecom", url: "https://wecom.example/global", enabled: true },
  ];

  it("inherits all global notifications when project has none", () => {
    const merged = mergeNotifications(globalConfigs, undefined);
    expect(merged.length).toBe(2);
    expect(merged.map((c) => c.name)).toEqual(["feishu-ops", "wecom-ops"]);
    expect(merged[0]?.url).toBe("https://feishu.example/global");
  });

  it("overrides global notification when project has matching name (case-insensitive)", () => {
    const projectConfigs: NotificationConfig[] = [
      {
        name: "FEISHU-OPS",
        type: "feishu",
        url: "https://feishu.example/project-override",
        enabled: true,
      },
    ];
    const merged = mergeNotifications(globalConfigs, projectConfigs);
    expect(merged.length).toBe(2);
    const feishuCfg = merged.find((c) => c.name.toLowerCase() === "feishu-ops");
    expect(feishuCfg?.url).toBe("https://feishu.example/project-override");
    const wecomCfg = merged.find((c) => c.name.toLowerCase() === "wecom-ops");
    expect(wecomCfg?.url).toBe("https://wecom.example/global");
  });

  it("appends project-specific notifications", () => {
    const projectConfigs: NotificationConfig[] = [
      {
        name: "project-custom",
        type: "webhook",
        url: "https://webhook.example/proj",
        enabled: true,
      },
    ];
    const merged = mergeNotifications(globalConfigs, projectConfigs);
    expect(merged.length).toBe(3);
    expect(merged.map((c) => c.name)).toEqual(["feishu-ops", "wecom-ops", "project-custom"]);
  });

  it("allows project to disable an inherited global notification", () => {
    const projectConfigs: NotificationConfig[] = [
      { name: "feishu-ops", type: "feishu", url: "https://feishu.example/global", enabled: false },
    ];
    const merged = mergeNotifications(globalConfigs, projectConfigs);
    expect(merged.length).toBe(2);
    const feishuCfg = merged.find((c) => c.name.toLowerCase() === "feishu-ops");
    expect(feishuCfg?.enabled).toBe(false);

    // Filter using hub should exclude disabled channel
    const hub = new NotificationHub();
    const active = hub.filterConfigs(merged);
    expect(active.length).toBe(1);
    expect(active[0]?.name).toBe("wecom-ops");
  });
});

describe("TelegramNotificationProvider", () => {
  const provider = new TelegramNotificationProvider();

  it("formats HTML with level emoji badges and converts markdown elements", () => {
    const formatted = provider.formatHtml({
      title: "Deploy Alert",
      text: "Normal text",
      markdown:
        "### Section Header\n\n- item 1\n- item 2\n\n> quote block\n\n~~cancelled~~\n\nDeploying `backend-v2` with **success**!\n```ts\nconst ok = true;\n```\nSee [Dashboard](https://example.com/dash)",
      level: "success",
    });

    expect(formatted).toContain("✅ <b>Deploy Alert</b>");
    expect(formatted).toContain("<b>Section Header</b>");
    expect(formatted).toContain("• item 1");
    expect(formatted).toContain("<blockquote>quote block</blockquote>");
    expect(formatted).toContain("<s>cancelled</s>");
    expect(formatted).toContain("<code>backend-v2</code>");
    expect(formatted).toContain("<b>success</b>");
    expect(formatted).toContain("<pre><code>const ok = true;</code></pre>");
    expect(formatted).toContain('<a href="https://example.com/dash">Dashboard</a>');
  });

  it("escapes raw HTML tags to prevent entity injection", () => {
    const formatted = provider.formatHtml({
      title: "<Script> & Alerts",
      text: "Testing <tag> & values",
      level: "error",
    });

    expect(formatted).toContain("🚨 <b>&lt;Script&gt; &amp; Alerts</b>");
    expect(formatted).toContain("&lt;tag&gt; &amp; values");
  });

  it("sends message via Telegram Bot API with botToken and chatId", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedBody: any = null;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      await provider.send(
        {
          title: "Build Succeeded",
          text: "All tests passed",
          level: "success",
        },
        {
          name: "telegram",
          type: "telegram",
          botToken: "123456:ABC-DEF",
          chatId: "-100987654321",
        },
      );

      expect(requestedUrl).toBe("https://api.telegram.org/bot123456:ABC-DEF/sendMessage");
      expect(requestedBody.chat_id).toBe("-100987654321");
      expect(requestedBody.parse_mode).toBe("HTML");
      expect(requestedBody.text).toContain("✅ <b>Build Succeeded</b>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries with plain text fallback if Telegram returns 400 entity parse error", async () => {
    const originalFetch = globalThis.fetch;
    const calls: any[] = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }),
          {
            status: 400,
          },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      await provider.send(
        {
          title: "Malformed Entities",
          text: "Raw unclosed tags",
          level: "warning",
        },
        {
          name: "telegram",
          type: "telegram",
          secret: "token123",
          chatId: "@my_channel",
        },
      );

      expect(calls.length).toBe(2);
      // First attempt used HTML parse_mode
      expect(calls[0].body.parse_mode).toBe("HTML");
      // Fallback attempt omitted parse_mode
      expect(calls[1].body.parse_mode).toBeUndefined();
      expect(calls[1].body.text).toContain("[WARN] Malformed Entities");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws descriptive error when required fields are missing", async () => {
    await expect(
      provider.send({ title: "T", text: "M" }, { name: "telegram", type: "telegram" }),
    ).rejects.toThrow("telegram notification needs botToken/secret or url");

    await expect(
      provider.send(
        { title: "T", text: "M" },
        { name: "telegram", type: "telegram", botToken: "tok" },
      ),
    ).rejects.toThrow("telegram notification needs chatId");
  });

  it("is registered by default in NotificationHub", () => {
    const hub = new NotificationHub();
    expect(hub.registry.has("telegram")).toBe(true);
    expect(hub.registry.get("TELEGRAM")).toBeInstanceOf(TelegramNotificationProvider);
  });
});

describe("Feishu and WeCom Markdown conversion", () => {
  const commonMarkdown = [
    "## 部署结果",
    "### 详细步骤",
    "",
    "- 第一步",
    "  - 子步骤 A",
    "  - 子步骤 B",
    "- 第二步",
    "",
    "1. 检查",
    "2. 上线",
    "",
    "> 注意安全",
    "",
    "**成功** 与 [文档](https://example.com/docs)",
    "",
    "行内 `bun run check`",
    "",
    "```ts",
    "## 不是标题",
    "- 不是列表",
    "const ok = true;",
    "```",
  ].join("\n");

  it("normalizes Feishu Markdown preserving native elements and converting H3+ headings", () => {
    const formatted = formatFeishuMarkdown(commonMarkdown);

    // H2 is preserved natively for Feishu card markdown
    expect(formatted).toContain("## 部署结果");
    // H3 is converted to bold heading for clean card rendering
    expect(formatted).toContain("**详细步骤**");
    // Lists, quotes, bold, links, inline code, and code blocks remain native
    expect(formatted).toContain("- 第一步");
    expect(formatted).toContain("1. 检查");
    expect(formatted).toContain("> 注意安全");
    expect(formatted).toContain("**成功**");
    expect(formatted).toContain("[文档](https://example.com/docs)");
    expect(formatted).toContain("`bun run check`");
    expect(formatted).toContain("```ts\n## 不是标题\n- 不是列表\nconst ok = true;\n```");
  });

  it("formats WeCom Markdown preserving native lists, quotes, and code", () => {
    const formatted = formatWeComMarkdown(commonMarkdown);

    expect(formatted).toContain("## 部署结果");
    expect(formatted).toContain("### 详细步骤");
    expect(formatted).toContain("- 第一步");
    expect(formatted).toContain("1. 检查");
    expect(formatted).toContain("> 注意安全");
    expect(formatted).toContain("**成功**");
    expect(formatted).toContain("[文档](https://example.com/docs)");
    expect(formatted).toContain("行内 `bun run check`");
  });

  it("prepends the WeCom title only when the body has no heading", () => {
    const withTitle = formatWeComMarkdown("- 第一项\n- 第二项", "部署通知");
    expect(withTitle.startsWith("### 部署通知\n\n")).toBe(true);
    expect(withTitle).toContain("- 第一项");
    expect(withTitle).toContain("- 第二项");

    const withHeading = formatWeComMarkdown("## 已有标题\n\n- 第一项", "部署通知");
    expect(withHeading.startsWith("## 已有标题")).toBe(true);
    expect(withHeading).not.toContain("### 部署通知");
  });
});

describe("FeishuNotificationProvider", () => {
  const provider = new FeishuNotificationProvider();

  it("sends native markdown element in the interactive card body", async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: any = null;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as typeof fetch;

    try {
      await provider.send(
        {
          title: "构建通知",
          text: "构建完成",
          markdown: "## 结果\n\n### 详情\n\n- 成功\n- 失败\n\n`v1.0`",
          level: "success",
        },
        { name: "feishu", type: "feishu", url: "https://feishu.example/hook" },
      );

      expect(requestedBody.msg_type).toBe("interactive");
      expect(requestedBody.card.config.wide_screen_mode).toBe(true);
      expect(requestedBody.card.header.template).toBe("green");
      expect(requestedBody.card.header.title.content).toBe("构建通知");
      expect(requestedBody.card.elements[0].tag).toBe("markdown");

      const content = requestedBody.card.elements[0].content;
      expect(content).toContain("## 结果");
      expect(content).toContain("**详情**");
      expect(content).toContain("- 成功");
      expect(content).toContain("- 失败");
      expect(content).toContain("`v1.0`");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps plain text notifications on the text payload", async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: any = null;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as typeof fetch;

    try {
      await provider.send(
        { title: "纯文本", text: "保持原样" },
        { name: "feishu", type: "feishu", url: "https://feishu.example/hook" },
      );

      expect(requestedBody).toEqual({
        msg_type: "text",
        content: { text: "纯文本\n\n保持原样" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("WeComNotificationProvider", () => {
  const provider = new WeComNotificationProvider();

  it("sends converted markdown with a title in the webhook body", async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: any = null;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    }) as typeof fetch;

    try {
      await provider.send(
        { title: "部署通知", text: "部署完成", markdown: "- 成功\n- 失败" },
        { name: "wecom", type: "wecom", url: "https://wecom.example/hook" },
      );

      expect(requestedBody.msgtype).toBe("markdown");
      const content = requestedBody.markdown.content;
      expect(content.startsWith("### 部署通知\n\n")).toBe(true);
      expect(content).toContain("- 成功");
      expect(content).toContain("- 失败");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps plain text notifications on the text payload", async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: any = null;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
    }) as typeof fetch;

    try {
      await provider.send(
        { title: "纯文本", text: "保持原样" },
        { name: "wecom", type: "wecom", url: "https://wecom.example/hook" },
      );

      expect(requestedBody).toEqual({
        msgtype: "text",
        text: { content: "纯文本\n\n保持原样" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("WebhookNotificationProvider", () => {
  it("forwards the original notification message unchanged", async () => {
    const originalFetch = globalThis.fetch;
    let requestedBody: any = null;
    const message: NotificationMessage = {
      title: "Webhook",
      text: "Plain body",
      markdown: "## 原样 Markdown\n\n- 列表",
      level: "warning",
    };

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      await new WebhookNotificationProvider().send(message, {
        name: "webhook",
        type: "webhook",
        url: "https://webhook.example/hook",
      });

      expect(requestedBody).toEqual(message);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
