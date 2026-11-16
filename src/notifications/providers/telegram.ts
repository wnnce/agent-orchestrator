import type { NotificationConfig } from "../../domain/types.ts";
import type { NotificationMessage, NotificationProvider } from "../types.ts";

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
