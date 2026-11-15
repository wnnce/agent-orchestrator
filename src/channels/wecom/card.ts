export interface BuildWeComMarkdownOptions {
  statusLine?: string | undefined;
  contentMarkdown?: string | undefined;
  artifacts?: Array<{ kind: string; name?: string; id?: string }> | undefined;
  durationMs?: number | undefined;
  isFinished?: boolean | undefined;
  outcome?: "completed" | "failed" | "interrupted" | "" | undefined;
}

export function formatQuote(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed
    .split("\n")
    .map((line) => (line.startsWith(">") ? line : `> ${line}`))
    .join("\n");
}

/**
 * Builds formatted Markdown content compatible with WeCom AI Bot rendering.
 */
export function buildWeComMarkdown(options: BuildWeComMarkdownOptions): string {
  const isFinished = options.isFinished ?? false;
  const outcome = options.outcome ?? "";
  const parts: string[] = [];

  const mainContent = options.contentMarkdown?.trim() ?? "";

  if (!isFinished) {
    // In-progress: render execution status
    if (options.statusLine) {
      parts.push(formatQuote(options.statusLine));
    } else {
      parts.push(formatQuote("⏳ 正在分析需求并规划任务..."));
    }
    if (mainContent) {
      parts.push("");
      parts.push(mainContent);
    }
  } else {
    // Completed state
    if (outcome === "failed") {
      parts.push(`❌ **任务执行出错**`);
      if (mainContent) {
        parts.push("");
        parts.push(mainContent);
      }
    } else if (outcome === "interrupted") {
      parts.push(`⚠️ **任务已中断**`);
      if (mainContent) {
        parts.push("");
        parts.push(mainContent);
      }
    } else {
      if (mainContent) {
        parts.push(mainContent);
      } else {
        parts.push("✅ **任务已完成**");
      }
    }

    // Execution duration footer
    if (typeof options.durationMs === "number") {
      parts.push("");
      parts.push("---");
      const seconds = (options.durationMs / 1000).toFixed(1);
      parts.push(`⏱️ 耗时 ${seconds}s  •  Powered by Agent Orchestrator`);
    }
  }

  return parts.join("\n");
}

export function buildWeComCancelMessage(hasActiveSession: boolean): string {
  return hasActiveSession
    ? `⚠️ **当前任务已取消**`
    : `ℹ️ **当前无活跃会话**`;
}

export function buildWeComCloseMessage(): string {
  return [
    `### ✅ 会话已关闭`,
    ``,
    `当前会话已成功退出，相关的 Git 工作区与进程资源已安全释放。`,
    ``,
    `如需开启新任务，请直接发送具体需求。`,
  ].join("\n");
}
