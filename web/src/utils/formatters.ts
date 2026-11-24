import type {
  ScheduledJobStatusCode,
  SessionUsageSummary,
  TokenUsage,
  TurnUsage,
} from "../types";

export function formatTokenCount(count?: number): string {
  if (count === undefined || count === null || !Number.isFinite(count)) return "0";
  const abs = Math.abs(count);
  if (abs >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(Math.trunc(count));
}

export function calculateCacheHitRate(usage: TokenUsage): number | null {
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (totalInput <= 0) return null;
  return Math.round((usage.cacheReadTokens / totalInput) * 100);
}

export function mergeTurnUsageIntoSummary(
  prev: SessionUsageSummary | null,
  turnUsage: TurnUsage,
): SessionUsageSummary {
  if (!prev) {
    return {
      turnCount: 1,
      inputTokens: turnUsage.inputTokens,
      cacheReadTokens: turnUsage.cacheReadTokens,
      cacheWriteTokens: turnUsage.cacheWriteTokens,
      outputTokens: turnUsage.outputTokens,
      reasoningTokens: turnUsage.reasoningTokens,
      totalTokens: turnUsage.totalTokens,
      ...(turnUsage.model ? { lastModel: turnUsage.model } : {}),
      ...(turnUsage.contextUsedTokens !== undefined
        ? { contextUsedTokens: turnUsage.contextUsedTokens }
        : {}),
      ...(turnUsage.contextWindowTokens !== undefined
        ? { contextWindowTokens: turnUsage.contextWindowTokens }
        : {}),
    };
  }
  return {
    turnCount: prev.turnCount + 1,
    inputTokens: prev.inputTokens + turnUsage.inputTokens,
    cacheReadTokens: prev.cacheReadTokens + turnUsage.cacheReadTokens,
    cacheWriteTokens: prev.cacheWriteTokens + turnUsage.cacheWriteTokens,
    outputTokens: prev.outputTokens + turnUsage.outputTokens,
    reasoningTokens: prev.reasoningTokens + turnUsage.reasoningTokens,
    totalTokens: prev.totalTokens + turnUsage.totalTokens,
    lastModel: turnUsage.model ?? prev.lastModel,
    contextUsedTokens: turnUsage.contextUsedTokens ?? prev.contextUsedTokens,
    contextWindowTokens: turnUsage.contextWindowTokens ?? prev.contextWindowTokens,
  };
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainingSec = sec % 60;
  return `${min}m ${remainingSec}s`;
}

export function formatDateTime(isoString?: string): string {
  if (!isoString) return "-";
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "-";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return isoString;
  }
}

export function formatTimeAgo(isoString?: string): string {
  if (!isoString) return "-";
  try {
    const time = new Date(isoString).getTime();
    const diff = Date.now() - time;
    if (diff < 5000) return "刚刚";
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec} 秒前`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return `${days} 天前`;
  } catch {
    return isoString;
  }
}

export function formatJobStatus(status: ScheduledJobStatusCode): {
  label: string;
  variant: "success" | "pending" | "info" | "warning" | "error" | "neutral";
} {
  switch (status) {
    case 0:
      return { label: "已完成 (COMPLETED)", variant: "success" };
    case 1:
      return { label: "待触发 (PENDING)", variant: "pending" };
    case 2:
      return { label: "执行中 (RUNNING)", variant: "info" };
    case 3:
      return { label: "已取消 (CANCELLED)", variant: "neutral" };
    case 4:
      return { label: "已失效 (ABANDONED)", variant: "error" };
    default:
      return { label: "未知", variant: "neutral" };
  }
}
