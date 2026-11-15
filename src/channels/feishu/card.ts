export type CardHeaderTemplate = "blue" | "green" | "red" | "orange" | "grey";

export interface BuildCardOptions {
  title?: string;
  headerTemplate?: CardHeaderTemplate;
  showHeader?: boolean;
  statusLine?: string;
  contentMarkdown?: string;
  artifacts?: Array<{ kind: string; name?: string; id?: string }>;
  durationMs?: number;
  isFinished?: boolean;
}

export function formatQuote(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed
    .split("\n")
    .map((line) => (line.startsWith(">") ? line : `> ${line}`))
    .join("\n");
}

export function buildFeishuCard(options: BuildCardOptions): Record<string, unknown> {
  const isFinished = options.isFinished ?? false;
  const template = options.headerTemplate ?? (isFinished ? "green" : "blue");
  const title = options.title ?? (isFinished ? "✅ Agent 执行完成" : "🔄 Agent 正在处理中");

  const elements: Array<Record<string, unknown>> = [];

  // 1. Updatable process quote block
  if (options.statusLine) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: formatQuote(options.statusLine),
      },
    });
  }

  // 2. Main response markdown content
  const content = options.contentMarkdown?.trim();
  if (content) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content,
      },
    });
  }

  // 3. Finished metadata footer
  if (isFinished && typeof options.durationMs === "number") {
    elements.push({ tag: "hr" });
    const seconds = (options.durationMs / 1000).toFixed(1);
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `⏱️ 耗时 ${seconds}s  •  Powered by Agent Orchestrator`,
        text_size: "notation",
        text_color: "grey",
      },
    });
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
    },
    ...(options.showHeader === false
      ? {}
      : {
          header: {
            template,
            title: {
              tag: "plain_text",
              content: title,
            },
          },
        }),
    body: {
      elements,
    },
  };
}
