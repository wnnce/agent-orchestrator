import crypto from "node:crypto";
import type { NotificationConfig } from "../../domain/types.ts";
import type { NotificationMessage, NotificationProvider } from "../types.ts";

interface CodeBlock {
  marker: string;
  info: string;
  lines: string[];
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const QUOTE_RE = /^(\s*)>\s?(.*)$/;
const HEADING_RE = /^(\s{0,3})#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const HORIZONTAL_RULE_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const UNORDERED_LIST_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

/**
 * Converts common Markdown into the limited lark_md subset supported by Feishu cards.
 * Headings, lists, quotes, and code blocks have no native lark_md representation, so they are
 * rendered with visible text prefixes and colors that Feishu can display reliably.
 */
export function formatFeishuMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let block: CodeBlock | undefined;

  for (const line of lines) {
    if (block) {
      const close = line.match(FENCE_CLOSE_RE);
      const fence = close?.[1];
      if (
        fence &&
        fence.charAt(0) === block.marker.charAt(0) &&
        fence.length >= block.marker.length
      ) {
        output.push(...formatFeishuCodeBlock(block));
        block = undefined;
      } else {
        block.lines.push(line);
      }
      continue;
    }

    const open = line.match(FENCE_OPEN_RE);
    if (open && !(open[1]?.[0] === "`" && open[2]?.includes("`"))) {
      block = {
        marker: open[1] ?? "```",
        info: open[2]?.trim() ?? "",
        lines: [],
      };
      continue;
    }

    output.push(formatFeishuLine(line));
  }

  if (block) output.push(...formatFeishuCodeBlock(block));
  return output.join("\n");
}

function formatFeishuLine(line: string): string {
  const quote = line.match(QUOTE_RE);
  if (quote) {
    const inner = formatFeishuLine(quote[2] ?? "");
    return `${quote[1]}▎ ${inner}`;
  }

  if (HORIZONTAL_RULE_RE.test(line)) {
    return "──────────────";
  }

  const heading = line.match(HEADING_RE);
  if (heading) {
    return `${heading[1]}**${formatFeishuInline(heading[2] ?? "")}**`;
  }

  const unordered = line.match(UNORDERED_LIST_RE);
  if (unordered) {
    return `${unordered[1]}• ${formatFeishuInline(unordered[2] ?? "")}`;
  }

  const ordered = line.match(ORDERED_LIST_RE);
  if (ordered) {
    return `${ordered[1]}${ordered[2]}. ${formatFeishuInline(ordered[3] ?? "")}`;
  }

  return formatFeishuInline(line);
}

function formatFeishuInline(text: string): string {
  return text.replace(/`([^`\n]+)`/g, "<font color='grey'>$1</font>");
}

function formatFeishuCodeBlock(block: CodeBlock): string[] {
  const label = block.info ? `💻 代码（${block.info}）` : "💻 代码";
  if (block.lines.length === 0) return [label];

  return [
    label,
    ...block.lines.map((line) => (line.length > 0 ? `<font color='grey'>${line}</font>` : "")),
  ];
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
