import type { ScheduledJobStatusCode } from "../types";

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
