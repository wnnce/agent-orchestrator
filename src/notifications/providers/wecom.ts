import type { NotificationConfig } from "../../domain/types.ts";
import type { NotificationMessage, NotificationProvider } from "../types.ts";

/**
 * Formats Markdown for WeCom robot webhooks.
 *
 * WeCom standard `markdown` message type natively supports:
 * - Headings (H1 to H6: `# ` to `###### `) - requires a space after #
 * - Bold (`**text**`)
 * - Links (`[text](url)`)
 * - Inline code (`code`)
 * - Blockquotes (`> quote`)
 * - Unordered lists (`- item`) and ordered lists (`1. item`)
 * - Font colors (`<font color="info|comment|warning">`)
 *
 * If a title is provided and markdown does not already start with a heading,
 * it prepends `### ${title}\n\n`.
 * Enforces WeCom's 4096-byte content limit to prevent HTTP 40058 errors.
 */
export function formatWeComMarkdown(markdown: string, title?: string): string {
  let content = markdown.replace(/\r\n?/g, "\n").trim();

  // Prepend title if body does not start with a heading
  if (title && !content.startsWith("#")) {
    content = `### ${title}\n\n${content}`;
  }

  // Ensure byte limit (4096 bytes UTF-8)
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  if (bytes.length > 4000) {
    const decoder = new TextDecoder("utf-8");
    content = decoder.decode(bytes.slice(0, 3950)) + "\n\n... (内容已截断)";
  }

  return content;
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
