type MarkdownChannel = "feishu" | "wecom";

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
  return formatMarkdown(markdown, "feishu");
}

/**
 * Converts common Markdown into the syntax supported by WeCom robot markdown messages.
 * WeCom supports headings, quotes, bold, links, and inline code, but not reliable `-` lists.
 * The title is added only when the body does not already start with a Markdown heading.
 */
export function formatWeComMarkdown(markdown: string, title?: string): string {
  const content = formatMarkdown(markdown, "wecom");
  if (title && !markdown.startsWith("#")) {
    return `### ${title}\n\n${content}`;
  }
  return content;
}

function formatMarkdown(markdown: string, channel: MarkdownChannel): string {
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
        output.push(...formatCodeBlock(block, channel));
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

    output.push(formatLine(line, channel));
  }

  if (block) output.push(...formatCodeBlock(block, channel));
  return output.join("\n");
}

function formatLine(line: string, channel: MarkdownChannel): string {
  const quote = line.match(QUOTE_RE);
  if (quote) {
    const inner = formatLine(quote[2] ?? "", channel);
    return channel === "feishu" ? `${quote[1]}▎ ${inner}` : `${quote[1]}> ${inner}`;
  }

  if (HORIZONTAL_RULE_RE.test(line)) {
    return channel === "feishu" ? "──────────────" : line;
  }

  const heading = line.match(HEADING_RE);
  if (heading) {
    return channel === "feishu"
      ? `${heading[1]}**${formatInline(heading[2] ?? "", channel)}**`
      : line;
  }

  const unordered = line.match(UNORDERED_LIST_RE);
  if (unordered) {
    return `${unordered[1]}• ${formatInline(unordered[2] ?? "", channel)}`;
  }

  const ordered = line.match(ORDERED_LIST_RE);
  if (ordered) {
    return `${ordered[1]}${ordered[2]}. ${formatInline(ordered[3] ?? "", channel)}`;
  }

  return formatInline(line, channel);
}

function formatInline(text: string, channel: MarkdownChannel): string {
  if (channel !== "feishu") return text;
  return text.replace(/`([^`\n]+)`/g, "<font color='grey'>$1</font>");
}

function formatCodeBlock(block: CodeBlock, channel: MarkdownChannel): string[] {
  const label = block.info ? `💻 代码（${block.info}）` : "💻 代码";
  if (block.lines.length === 0) return [label];

  if (channel === "feishu") {
    return [
      label,
      ...block.lines.map((line) => (line.length > 0 ? `<font color='grey'>${line}</font>` : "")),
    ];
  }

  return [label, ...block.lines.map((line) => (line.length > 0 ? wrapInlineCode(line) : ""))];
}

function wrapInlineCode(text: string): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(longest + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}
