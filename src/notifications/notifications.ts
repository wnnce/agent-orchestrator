import crypto from "node:crypto";
import type {
  NotificationConfig,
  NotificationDelivery,
  NotificationDeliveryDetail,
} from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import { Logger } from "../observability/logger.ts";
import { formatFeishuMarkdown, formatWeComMarkdown } from "./markdown.ts";

export type { NotificationDeliveryDetail } from "../domain/types.ts";

export interface NotificationMessage {
  title: string;
  text: string;
  markdown?: string;
  level?: "info" | "success" | "warning" | "error";
  metadata?: Record<string, unknown>;
}

export interface NotificationOptions {
  /**
   * Target platform or specific channel:
   * - "all" (default): send to all active notification configs of the project
   * - "feishu" / "wecom" / "webhook" / "log": matches config.type
   * - "ops-feishu" / "dev-alert": matches config.name
   * - Array of target strings: ["feishu", "ops-webhook"]
   */
  target?: "all" | string | string[] | undefined;
}

export interface NotificationResult {
  total: number;
  sent: number;
  failed: number;
  details: NotificationDeliveryDetail[];
}

export interface NotificationProvider {
  readonly type: string;
  send(message: NotificationMessage, config: NotificationConfig): Promise<void>;
}

export class LogNotificationProvider implements NotificationProvider {
  readonly type = "log" as const;
  constructor(private readonly logger = new Logger()) {}
  async send(message: NotificationMessage): Promise<void> {
    this.logger.info("notification delivered to log provider", { notification: message });
  }
}

export class WebhookNotificationProvider implements NotificationProvider {
  readonly type = "webhook" as const;
  async send(message: NotificationMessage, config: NotificationConfig): Promise<void> {
    if (!config.url) throw new Error("webhook notification needs url");
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.secret ? { authorization: `Bearer ${config.secret}` } : {}),
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      throw new Error(`webhook notification failed: HTTP ${response.status}`);
    }
  }
}

export class FeishuNotificationProvider implements NotificationProvider {
  readonly type = "feishu" as const;

  async send(message: NotificationMessage, config: NotificationConfig): Promise<void> {
    if (!config.url) throw new Error("feishu notification needs webhook url");

    let body: Record<string, unknown>;
    if (message.markdown) {
      const template =
        message.level === "error"
          ? "red"
          : message.level === "warning"
            ? "orange"
            : message.level === "success"
              ? "green"
              : "blue";

      body = {
        msg_type: "interactive",
        card: {
          header: {
            title: { tag: "plain_text", content: message.title || "通知" },
            template,
          },
          elements: [
            {
              tag: "div",
              text: { tag: "lark_md", content: formatFeishuMarkdown(message.markdown) },
            },
          ],
        },
      };
    } else {
      body = {
        msg_type: "text",
        content: {
          text: message.title ? `${message.title}\n\n${message.text}` : message.text,
        },
      };
    }

    // Feishu webhook signature support
    if (config.secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const stringToSign = `${timestamp}\n${config.secret}`;
      const sign = crypto.createHmac("sha256", stringToSign).update("").digest("base64");
      body.timestamp = String(timestamp);
      body.sign = sign;
    }

    const response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`feishu notification webhook failed: HTTP ${response.status}`);
    }
    const resJson: any = await response.json().catch(() => ({}));
    if (resJson.code !== undefined && resJson.code !== 0 && resJson.StatusCode !== 0) {
      throw new Error(`feishu webhook error (${resJson.code}): ${resJson.msg ?? "unknown"}`);
    }
  }
}

export class WeComNotificationProvider implements NotificationProvider {
  readonly type = "wecom" as const;

  async send(message: NotificationMessage, config: NotificationConfig): Promise<void> {
    if (!config.url) throw new Error("wecom notification needs webhook url");

    let body: Record<string, unknown>;
    if (message.markdown) {
      const content = formatWeComMarkdown(message.markdown, message.title);
      body = {
        msgtype: "markdown",
        markdown: { content },
      };
    } else {
      body = {
        msgtype: "text",
        text: {
          content: message.title ? `${message.title}\n\n${message.text}` : message.text,
        },
      };
    }

    const response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`wecom notification webhook failed: HTTP ${response.status}`);
    }
    const resJson: any = await response.json().catch(() => ({}));
    if (resJson.errcode !== undefined && resJson.errcode !== 0) {
      throw new Error(`wecom webhook error (${resJson.errcode}): ${resJson.errmsg ?? "unknown"}`);
    }
  }
}

export class TelegramNotificationProvider implements NotificationProvider {
  readonly type = "telegram" as const;

  async send(message: NotificationMessage, config: NotificationConfig): Promise<void> {
    const token = config.botToken || config.secret;
    let endpoint: string;
    let chatId = config.chatId;

    if (config.url) {
      try {
        const parsed = new URL(config.url);
        if (parsed.searchParams.has("chat_id") && !chatId) {
          chatId = parsed.searchParams.get("chat_id")!;
        }
        if (parsed.pathname.includes("/sendMessage")) {
          endpoint = config.url;
        } else if (token) {
          endpoint = `${config.url.replace(/\/+$/, "")}/bot${token}/sendMessage`;
        } else {
          endpoint = config.url;
        }
      } catch {
        endpoint = config.url;
      }
    } else if (token) {
      endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
    } else {
      throw new Error("telegram notification needs botToken/secret or url");
    }

    if (!chatId) {
      try {
        const u = new URL(endpoint);
        chatId = u.searchParams.get("chat_id") || undefined;
      } catch {}
    }

    if (!chatId) {
      throw new Error("telegram notification needs chatId");
    }

    const formattedHtml = this.formatHtml(message);

    // 1. Send via HTML parse_mode
    let response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: formattedHtml,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    // 2. If entity parse error occurs (e.g. malformed tag), fallback to plain text
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      if (
        response.status === 400 &&
        (errText.toLowerCase().includes("parse") || errText.toLowerCase().includes("entities"))
      ) {
        const plainText = this.formatPlainText(message);
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: plainText,
            disable_web_page_preview: true,
          }),
        });
      }

      if (!response.ok) {
        throw new Error(
          `telegram notification failed: HTTP ${response.status} (${errText || response.statusText})`,
        );
      }
    }

    const data: any = await response.json().catch(() => ({}));
    if (data.ok === false) {
      throw new Error(`telegram api error (${data.error_code}): ${data.description ?? "unknown"}`);
    }
  }

  formatHtml(message: NotificationMessage): string {
    const badge =
      message.level === "error"
        ? "🚨 "
        : message.level === "warning"
          ? "⚠️ "
          : message.level === "success"
            ? "✅ "
            : message.level === "info"
              ? "ℹ️ "
              : "";

    const body = message.markdown
      ? this.markdownToTelegramHtml(message.markdown)
      : this.escapeHtml(message.text || "");

    let full = message.title
      ? `${badge}<b>${this.escapeHtml(message.title)}</b>\n\n${body}`
      : `${badge}${body}`;

    if (full.length > 4000) {
      full = full.slice(0, 3950) + "\n\n... (truncated)";
    }
    return full;
  }

  formatPlainText(message: NotificationMessage): string {
    const badge =
      message.level === "error"
        ? "[ERROR] "
        : message.level === "warning"
          ? "[WARN] "
          : message.level === "success"
            ? "[SUCCESS] "
            : "";
    const body = message.text || message.markdown || "";
    let full = message.title ? `${badge}${message.title}\n\n${body}` : `${badge}${body}`;
    if (full.length > 4000) {
      full = full.slice(0, 3950) + "\n\n... (truncated)";
    }
    return full;
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private markdownToTelegramHtml(md: string): string {
    let out = this.escapeHtml(md);

    // Fenced code blocks ```lang\ncode``` -> <pre><code>code</code></pre>
    out = out.replace(/```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_m, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code `code` -> <code>code</code>
    out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Headings # Title, ## Title, ### Title -> <b>Title</b>
    out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

    // Blockquotes > quote -> <blockquote>quote</blockquote>
    out = out.replace(/^&gt;\s*(.+)$/gm, "<blockquote>$1</blockquote>");
    out = out.replace(/<\/blockquote>\n<blockquote>/g, "\n");

    // Strikethrough ~~text~~ -> <s>text</s>
    out = out.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

    // Spoilers ||spoiler|| -> <tg-spoiler>spoiler</tg-spoiler>
    out = out.replace(/\|\|([^|\n]+)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");

    // Bold **text** or __text__ -> <b>text</b>
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    out = out.replace(/__([^_\n]+)__/g, "<b>$1</b>");

    // Italic *text* or _text_ -> <i>text</i>
    out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
    out = out.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<i>$1</i>");

    // Links [text](url) -> <a href="url">text</a>
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

    // Horizontal rule --- -> ──────────────
    out = out.replace(/^-{3,}$/gm, "──────────────");

    // Unordered lists - item or * item -> • item
    out = out.replace(/^[\s]*[-*]\s+(.+)$/gm, "• $1");

    return out;
  }
}

/**
 * Registry holding NotificationProvider instances by their type identifier.
 */
export class NotificationRegistry {
  private readonly providers = new Map<string, NotificationProvider>();

  register(provider: NotificationProvider): this {
    this.providers.set(provider.type.toLowerCase(), provider);
    return this;
  }

  unregister(type: string): boolean {
    return this.providers.delete(type.toLowerCase());
  }

  get(type: string): NotificationProvider | undefined {
    return this.providers.get(type.toLowerCase());
  }

  has(type: string): boolean {
    return this.providers.has(type.toLowerCase());
  }

  list(): NotificationProvider[] {
    return [...this.providers.values()];
  }
}

/**
 * Central dispatcher responsible for dispatching notifications to registered providers.
 */
export class NotificationHub {
  readonly registry: NotificationRegistry;

  constructor(
    private readonly logger = new Logger(),
    registry?: NotificationRegistry,
  ) {
    this.registry = registry ?? new NotificationRegistry();
    if (!registry) {
      this.registry.register(new LogNotificationProvider(this.logger));
      this.registry.register(new WebhookNotificationProvider());
      this.registry.register(new FeishuNotificationProvider());
      this.registry.register(new WeComNotificationProvider());
      this.registry.register(new TelegramNotificationProvider());
    }
  }

  register(provider: NotificationProvider): this {
    this.registry.register(provider);
    return this;
  }

  /**
   * Filters configs based on target option ("all", specific type, specific name, or array).
   */
  filterConfigs(
    configs: NotificationConfig[] | undefined,
    options?: NotificationOptions,
  ): NotificationConfig[] {
    if (!configs || configs.length === 0) return [];
    const target = options?.target ?? "all";

    return configs.filter((config) => {
      if (config.enabled === false) return false;
      if (target === "all") return true;

      const targetList = Array.isArray(target) ? target : [target];
      return targetList.some(
        (t) =>
          t.toLowerCase() === config.type.toLowerCase() ||
          (config.name && t.toLowerCase() === config.name.toLowerCase()),
      );
    });
  }

  async send(
    configs: NotificationConfig[] | undefined,
    message: NotificationMessage,
    options?: NotificationOptions,
  ): Promise<NotificationResult> {
    const targets = this.filterConfigs(configs, options);
    const details: NotificationDeliveryDetail[] = [];
    let sent = 0;
    let failed = 0;

    const tasks = targets.map(async (config) => {
      const provider = this.registry.get(config.type);
      if (!provider) {
        const errorMsg = `No notification provider registered for type: ${config.type}`;
        this.logger.warn(errorMsg, { configName: config.name });
        details.push({
          name: config.name,
          type: config.type,
          success: false,
          error: errorMsg,
        });
        failed++;
        return;
      }

      try {
        await provider.send(message, config);
        details.push({
          name: config.name,
          type: config.type,
          success: true,
        });
        sent++;
      } catch (err: any) {
        const errorMsg = err?.message ?? String(err);
        this.logger.error("Notification delivery failed", {
          name: config.name,
          type: config.type,
          error: errorMsg,
        });
        details.push({
          name: config.name,
          type: config.type,
          success: false,
          error: errorMsg,
        });
        failed++;
      }
    });

    await Promise.allSettled(tasks);

    return {
      total: targets.length,
      sent,
      failed,
      details,
    };
  }
}

export interface EnqueuedNotification {
  readonly deliveryId: string;
  readonly projectId: string;
  readonly sessionId?: string | undefined;
  readonly configs: NotificationConfig[];
  readonly message: NotificationMessage;
  readonly options?: NotificationOptions | undefined;
}

export class NotificationOutbox {
  private readonly queueBuffer: EnqueuedNotification[] = [];
  private activeWorkers = 0;
  private readonly maxConcurrency = 5;

  constructor(
    private readonly store: Store,
    private readonly hub: NotificationHub,
    private readonly logger = new Logger(),
  ) {}

  /**
   * Enqueue a notification into the in-memory queue.
   * Immediately triggers reactive background dispatch without blocking caller or polling DB.
   */
  async queue(
    projectId: string,
    sessionId: string,
    configs: NotificationConfig[] | undefined,
    message: NotificationMessage,
    options?: NotificationOptions,
  ): Promise<string | undefined> {
    const targets = this.hub.filterConfigs(configs, options);
    if (targets.length === 0) {
      this.logger.debug("no matching notification configs to queue", {
        projectId,
        sessionId,
        target: options?.target ?? "all",
      });
      return undefined;
    }

    const deliveryId = `delivery_${crypto.randomUUID()}`;
    const item: EnqueuedNotification = {
      deliveryId,
      projectId,
      sessionId,
      configs: targets,
      message,
      options,
    };

    this.queueBuffer.push(item);
    this.logger.info("notification enqueued to memory queue", {
      projectId,
      sessionId,
      deliveryId,
      providerCount: targets.length,
      target: options?.target ?? "all",
      queueLength: this.queueBuffer.length,
    });

    // Reactive trigger: immediately pump memory queue (0ms latency, zero sleep)
    void this.processNext();
    return deliveryId;
  }

  /**
   * Reactive worker pump consuming from the in-memory queue.
   */
  private async processNext(): Promise<void> {
    if (this.activeWorkers >= this.maxConcurrency || this.queueBuffer.length === 0) {
      return;
    }

    const item = this.queueBuffer.shift();
    if (!item) return;

    this.activeWorkers++;
    try {
      await this.dispatchItem(item);
    } finally {
      this.activeWorkers--;
      if (this.queueBuffer.length > 0) {
        void this.processNext();
      }
    }
  }

  /**
   * Dispatches the notification immediately via NotificationHub,
   * then asynchronously persists the delivery audit record to Store.
   * No retry on failure.
   */
  private async dispatchItem(item: EnqueuedNotification): Promise<void> {
    let result: NotificationResult;
    try {
      result = await this.hub.send(item.configs, item.message);
    } catch (err) {
      result = {
        total: item.configs.length,
        sent: 0,
        failed: item.configs.length,
        details: item.configs.map((c) => ({
          name: c.name,
          type: c.type,
          success: false,
          error: String(err),
        })),
      };
    }

    const status: "sent" | "partial" | "failed" =
      result.failed === 0 ? "sent" : result.sent === 0 ? "failed" : "partial";

    const delivery: NotificationDelivery = {
      id: item.deliveryId,
      projectId: item.projectId,
      sessionId: item.sessionId,
      configs: item.configs,
      message: item.message,
      status,
      details: result.details,
      createdAt: new Date().toISOString(),
    };

    // Asynchronously record delivery audit into store
    try {
      await this.store.recordNotificationDelivery(delivery);
      this.logger.info("notification delivered and recorded", {
        deliveryId: item.deliveryId,
        projectId: item.projectId,
        status,
        sent: result.sent,
        failed: result.failed,
      });
    } catch (dbErr) {
      this.logger.error("failed to record notification delivery into store", {
        deliveryId: item.deliveryId,
        projectId: item.projectId,
        error: dbErr,
      });
    }
  }

  /**
   * Drains remaining items in the in-memory queue (useful for testing and graceful shutdown).
   */
  async drain(_projectId?: string): Promise<void> {
    while (this.queueBuffer.length > 0 || this.activeWorkers > 0) {
      await this.processNext();
      if (this.queueBuffer.length === 0 && this.activeWorkers === 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  get pendingCount(): number {
    return this.queueBuffer.length;
  }
}
