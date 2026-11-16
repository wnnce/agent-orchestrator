import type { NotificationConfig } from "../../domain/types.ts";
import type { NotificationMessage, NotificationProvider } from "../types.ts";

interface CodeBlock {
  marker: string;
  info: string;
  lines: string[];
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const UNORDERED_LIST_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

/**
 * Converts common Markdown into the syntax supported by WeCom robot markdown messages.
 * WeCom supports headings, quotes, bold, links, and inline code, but not reliable `-` lists.
 * The title is added only when the body does not already start with a Markdown heading.
 */
export function formatWeComMarkdown(markdown: string, title?: string): string {
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
        output.push(...formatWeComCodeBlock(block));
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

    output.push(formatWeComLine(line));
  }

  if (block) output.push(...formatWeComCodeBlock(block));
  const content = output.join("\n");

  if (title && !markdown.startsWith("#")) {
    return `### ${title}\n\n${content}`;
  }
  return content;
}

function formatWeComLine(line: string): string {
  const unordered = line.match(UNORDERED_LIST_RE);
  if (unordered) {
    return `${unordered[1]}• ${unordered[2] ?? ""}`;
  }

  const ordered = line.match(ORDERED_LIST_RE);
  if (ordered) {
    return `${ordered[1]}${ordered[2]}. ${ordered[3] ?? ""}`;
  }

  return line;
}

function formatWeComCodeBlock(block: CodeBlock): string[] {
  const label = block.info ? `💻 代码（${block.info}）` : "💻 代码";
  if (block.lines.length === 0) return [label];

  return [label, ...block.lines.map((line) => (line.length > 0 ? wrapInlineCode(line) : ""))];
}

function wrapInlineCode(text: string): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(longest + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
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
