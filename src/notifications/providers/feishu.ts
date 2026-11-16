import crypto from "node:crypto";
import type { NotificationConfig } from "../../domain/types.ts";
import type { NotificationMessage, NotificationProvider } from "../types.ts";

/**
 * Normalizes Markdown for Feishu interactive message cards.
 *
 * Feishu interactive cards natively support the `markdown` element (`tag: "markdown"`):
 * - Multi-line fenced code blocks with language highlighting (```lang ... ```)
 * - Inline code (`code`)
 * - Ordered (1.) and unordered (-) lists
 * - Blockquotes (>)
 * - Bold (**), italic (*), strikethrough (~~)
 * - Links ([text](url)) and horizontal rules (---)
 * - Level 1 and Level 2 headings (# and ##)
 *
 * Headings beyond H2 (###, ####, etc.) are converted to bold text (**heading**)
 * because Feishu Card Markdown only supports # and ## as native heading elements.
 */
export function formatFeishuMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const normalized: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      normalized.push(line);
      continue;
    }

    if (!inCodeBlock) {
      // Feishu card markdown only natively supports H1 (#) and H2 (##).
      // Convert H3+ (###, ####, etc.) to bold text for clean and consistent card layout.
      const h3PlusMatch = line.match(/^(\s*)#{3,6}\s+(.+?)(?:\s+#+)?\s*$/);
      if (h3PlusMatch) {
        normalized.push(`${h3PlusMatch[1] ?? ""}**${(h3PlusMatch[2] ?? "").trim()}**`);
        continue;
      }
    }

    normalized.push(line);
  }

  return normalized.join("\n");
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
          config: {
            wide_screen_mode: true,
          },
          header: {
            title: { tag: "plain_text", content: message.title || "通知" },
            template,
          },
          elements: [
            {
              tag: "markdown",
              content: formatFeishuMarkdown(message.markdown),
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
