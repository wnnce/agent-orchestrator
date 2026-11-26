import type {
  PipelineActionName,
  PipelineNodeExecutorType,
  PipelineNodeRunStatus,
  PipelineRunStatus,
  PipelineWorkspaceStatus,
} from "../../types";

export interface StatusStyle {
  label: string;
  shortLabel: string;
  badgeClass: string;
  dotClass: string;
  borderAccentClass: string;
}

const STATUS_STYLES: Record<PipelineRunStatus, StatusStyle> = {
  queued: {
    label: "Queued",
    shortLabel: "Queued",
    badgeClass:
      "bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)] border-[var(--border-default)]",
    dotClass: "bg-[var(--text-muted)]",
    borderAccentClass: "border-l-[var(--border-strong)]",
  },
  running: {
    label: "Running",
    shortLabel: "Running",
    badgeClass:
      "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25",
    dotClass: "bg-blue-500 animate-pulse",
    borderAccentClass: "border-l-blue-500",
  },
  waiting: {
    label: "Waiting",
    shortLabel: "Waiting",
    badgeClass:
      "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25",
    dotClass: "bg-amber-500 animate-pulse",
    borderAccentClass: "border-l-amber-500",
  },
  waiting_confirmation: {
    label: "Needs Approval",
    shortLabel: "Approval",
    badgeClass:
      "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/25",
    dotClass: "bg-violet-500 animate-pulse",
    borderAccentClass: "border-l-violet-500",
  },
  completed: {
    label: "Completed",
    shortLabel: "Done",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
    dotClass: "bg-emerald-500",
    borderAccentClass: "border-l-emerald-500",
  },
  failed: {
    label: "Failed",
    shortLabel: "Failed",
    badgeClass:
      "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/25",
    dotClass: "bg-red-500",
    borderAccentClass: "border-l-red-500",
  },
  cancelled: {
    label: "Cancelled",
    shortLabel: "Cancelled",
    badgeClass:
      "bg-[var(--bg-surface-elevated)] text-[var(--text-muted)] border-[var(--border-default)]",
    dotClass: "bg-neutral-400",
    borderAccentClass: "border-l-neutral-400",
  },
};

export function getPipelineStatusStyle(
  status: PipelineRunStatus | PipelineNodeRunStatus,
): StatusStyle {
  return STATUS_STYLES[status] ?? STATUS_STYLES.queued;
}

export interface ExecutorStyle {
  label: string;
  badgeClass: string;
}

const EXECUTOR_STYLES: Record<PipelineNodeExecutorType, ExecutorStyle> = {
  agent: {
    label: "Agent",
    badgeClass:
      "bg-blue-500/8 text-blue-700 dark:text-blue-300 border-blue-500/20",
  },
  ts: {
    label: "TS",
    badgeClass:
      "bg-cyan-500/8 text-cyan-700 dark:text-cyan-300 border-cyan-500/20",
  },
  human: {
    label: "Human",
    badgeClass:
      "bg-violet-500/8 text-violet-700 dark:text-violet-300 border-violet-500/20",
  },
  terminal: {
    label: "Terminal",
    badgeClass:
      "bg-emerald-500/8 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
  },
};

export function getExecutorStyle(executor: PipelineNodeExecutorType): ExecutorStyle {
  return EXECUTOR_STYLES[executor] ?? EXECUTOR_STYLES.agent;
}

export interface ActionStyle {
  label: string;
  badgeClass: string;
}

const ACTION_STYLES: Record<PipelineActionName, ActionStyle> = {
  pipeline_next: {
    label: "Advance",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
  },
  pipeline_prev: {
    label: "Rework",
    badgeClass:
      "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25",
  },
  pipeline_request_confirmation: {
    label: "Confirm",
    badgeClass:
      "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/25",
  },
  pipeline_fail: {
    label: "Failed",
    badgeClass: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/25",
  },
  human_approve: {
    label: "Approved",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
  },
  human_reject: {
    label: "Rejected",
    badgeClass:
      "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25",
  },
  human_retry: {
    label: "Retried",
    badgeClass:
      "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25",
  },
  human_cancel: {
    label: "Cancelled",
    badgeClass:
      "bg-[var(--bg-surface-elevated)] text-[var(--text-muted)] border-[var(--border-default)]",
  },
  system_fallback: {
    label: "Fallback",
    badgeClass:
      "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/25",
  },
  system_loop_breaker: {
    label: "Loop Cap",
    badgeClass:
      "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/25",
  },
};

export function getActionStyle(action: PipelineActionName): ActionStyle {
  return ACTION_STYLES[action] ?? ACTION_STYLES.pipeline_next;
}

export function getWorkspaceStatusLabel(status: PipelineWorkspaceStatus): string {
  switch (status) {
    case "active":
      return "Worktree Active";
    case "cleaned":
      return "Worktree Cleaned";
    case "none":
    default:
      return "No Worktree";
  }
}

export function isTerminalRunStatus(status: PipelineRunStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export function formatRelativeCountdown(isoString?: string): string {
  if (!isoString) return "-";
  const target = new Date(isoString).getTime();
  if (Number.isNaN(target)) return isoString;
  const diffSec = Math.round((target - Date.now()) / 1000);
  if (diffSec <= 0) return "due now";
  if (diffSec < 60) return `in ${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  return sec > 0 ? `in ${min}m ${sec}s` : `in ${min}m`;
}
