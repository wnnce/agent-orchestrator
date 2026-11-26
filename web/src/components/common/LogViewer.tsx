import React, { useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Loader2,
  RotateCw,
  Search,
  Terminal,
  WrapText,
} from "lucide-react";
import { toast } from "sonner";
import type { TaskExecutionLogLevel } from "../../types";
import { copyToClipboard } from "../../utils/clipboard";
import { formatDateTime } from "../../utils/formatters";

export type LogLevelFilter = "all" | TaskExecutionLogLevel;

export interface LogEntry {
  key: string;
  sequence: number;
  level: TaskExecutionLogLevel;
  message: string;
  fields?: Record<string, unknown>;
  createdAt: string;
}

export interface LogViewerProps {
  logs: LogEntry[];
  loading?: boolean;
  error?: string | null;
  emptyText?: string;
  /** Controlled level filter (useful when parent performs server-side filtering). */
  level?: LogLevelFilter;
  onLevelChange?: (level: LogLevelFilter) => void;
  onRefresh?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Stretch to fill parent height cleanly (e.g. inside flex-1 containers). */
  fillHeight?: boolean;
  className?: string;
}

const LEVEL_TAG: Record<TaskExecutionLogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

function formatTimeOnly(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return isoString;
  }
}

function formatCompactFieldValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const s = JSON.stringify(value);
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
}

function getRowAccentClasses(level: TaskExecutionLogLevel): {
  row: string;
  tag: string;
  msg: string;
} {
  switch (level) {
    case "error":
      return {
        row: "border-l-red-500 bg-red-500/[0.08] hover:bg-red-500/[0.13]",
        tag: "text-red-600 dark:text-red-400",
        msg: "text-red-700 dark:text-red-300",
      };
    case "warn":
      return {
        row: "border-l-amber-500 bg-amber-500/[0.07] hover:bg-amber-500/[0.12]",
        tag: "text-amber-700 dark:text-amber-400",
        msg: "text-amber-900 dark:text-amber-200",
      };
    case "debug":
      return {
        row: "border-l-transparent hover:bg-[var(--bg-surface-hover)]/45",
        tag: "text-[var(--text-muted)] opacity-55",
        msg: "text-[var(--text-secondary)]",
      };
    case "info":
    default:
      return {
        row: "border-l-transparent hover:bg-[var(--bg-surface-hover)]/45",
        tag: "text-[var(--text-muted)] opacity-75",
        msg: "text-[var(--text-primary)]",
      };
  }
}

export function LogViewer({
  logs,
  loading = false,
  error = null,
  emptyText = "暂无日志输出",
  level: controlledLevel,
  onLevelChange,
  onRefresh,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  fillHeight = false,
  className = "",
}: LogViewerProps) {
  const [internalLevel, setInternalLevel] = useState<LogLevelFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [wrapLines, setWrapLines] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  const activeLevel = controlledLevel ?? internalLevel;
  const setLevel = (next: LogLevelFilter) => {
    if (onLevelChange) onLevelChange(next);
    else setInternalLevel(next);
  };

  const levelCounts = useMemo(() => {
    let warn = 0;
    let err = 0;
    for (const entry of logs) {
      if (entry.level === "warn") warn += 1;
      else if (entry.level === "error") err += 1;
    }
    return { warn, error: err };
  }, [logs]);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return logs.filter((entry) => {
      if (!onLevelChange && activeLevel !== "all" && entry.level !== activeLevel) {
        return false;
      }
      if (!q) return true;
      if (entry.message.toLowerCase().includes(q)) return true;
      if (entry.fields && JSON.stringify(entry.fields).toLowerCase().includes(q)) return true;
      return false;
    });
  }, [logs, onLevelChange, activeLevel, searchQuery]);

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleCopy = async () => {
    const text = filteredLogs
      .map((l) => {
        const fields =
          l.fields && Object.keys(l.fields).length > 0 ? ` ${JSON.stringify(l.fields)}` : "";
        return `${formatDateTime(l.createdAt)} [${LEVEL_TAG[l.level]}] ${l.message}${fields}`;
      })
      .join("\n");
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      toast.success("已复制日志");
    }
  };

  return (
    <div
      className={`rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-code)] overflow-hidden flex flex-col ${
        fillHeight ? "flex-1 min-h-0" : ""
      } ${className}`}
    >
      {/* Compact Vercel-style Terminal Header */}
      <div className="px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2 shrink-0 select-none">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <div className="relative w-44 sm:w-56">
            <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter logs..."
              className="w-full pl-7 pr-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-hidden focus:border-[var(--border-focus)] transition-colors"
            />
          </div>

          <div className="inline-flex items-center p-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-default)] font-mono">
            {(["all", "info", "warn", "error", "debug"] as const).map((lvl) => {
              const selected = activeLevel === lvl;
              const badgeNum =
                lvl === "warn" && levelCounts.warn > 0
                  ? levelCounts.warn
                  : lvl === "error" && levelCounts.error > 0
                    ? levelCounts.error
                    : null;
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setLevel(lvl)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] text-[10px] uppercase transition-colors cursor-pointer ${
                    selected
                      ? "bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] font-semibold"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <span>{lvl}</span>
                  {badgeNum !== null && (
                    <span
                      className={`text-[9.5px] ${
                        lvl === "error"
                          ? "text-red-600 dark:text-red-400"
                          : "text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {badgeNum}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--text-muted)] shrink-0">
          <span className="tabular-nums px-1">
            {filteredLogs.length}
            {hasMore ? "+" : ""} lines
          </span>

          <button
            type="button"
            onClick={() => setWrapLines((prev) => !prev)}
            title={wrapLines ? "切换为单行横向滚动" : "切换为自动换行"}
            className={`w-6 h-6 rounded-[var(--radius-xs)] flex items-center justify-center border transition-colors cursor-pointer ${
              wrapLines
                ? "bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] border-[var(--border-strong)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
            }`}
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={handleCopy}
            disabled={filteredLogs.length === 0}
            title="复制日志"
            className="w-6 h-6 rounded-[var(--radius-xs)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] disabled:opacity-40 transition-colors cursor-pointer"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>

          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              title="刷新日志"
              className="w-6 h-6 rounded-[var(--radius-xs)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] disabled:opacity-40 transition-colors cursor-pointer"
            >
              <RotateCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          )}
        </div>
      </div>

      {/* Error Notice */}
      {error && (
        <div className="px-3.5 py-2 border-b border-red-500/20 bg-red-500/8 text-xs text-red-700 dark:text-red-300 flex items-center gap-2 font-mono shrink-0">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-500" />
          <span>{error}</span>
        </div>
      )}

      {/* Terminal Stream Body */}
      <div
        className={`overflow-x-auto overflow-y-auto font-mono text-[11.5px] leading-6 select-text ${
          fillHeight ? "flex-1 min-h-0" : "max-h-[540px]"
        }`}
      >
        {loading && logs.length === 0 ? (
          <div className="py-14 flex items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading logs...</span>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="py-14 flex flex-col items-center justify-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Terminal className="w-4 h-4 opacity-40" />
            <span>{logs.length === 0 ? emptyText : "没有匹配当前筛选条件的日志"}</span>
          </div>
        ) : (
          <div className={`py-1.5 ${wrapLines ? "w-full" : "min-w-max"}`}>
            {filteredLogs.map((entry) => {
              const accent = getRowAccentClasses(entry.level);
              const fieldEntries = entry.fields ? Object.entries(entry.fields) : [];
              const hasFields = fieldEntries.length > 0;
              const isExpanded = !!expandedKeys[entry.key];

              return (
                <div key={entry.key}>
                  <div
                    onClick={() => hasFields && toggleExpand(entry.key)}
                    className={`border-l-2 pl-2.5 pr-4 py-[1px] flex items-baseline gap-2.5 transition-colors ${accent.row} ${
                      wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-nowrap"
                    } ${hasFields ? "cursor-pointer" : ""}`}
                  >
                    {/* Line Number Gutter */}
                    <span className="w-6 text-right text-[10.5px] text-[var(--text-muted)] opacity-40 tabular-nums select-none shrink-0">
                      {entry.sequence}
                    </span>

                    {/* Compact HH:mm:ss Timestamp */}
                    <span
                      className="text-[10.5px] text-[var(--text-muted)] opacity-65 tabular-nums select-none shrink-0"
                      title={formatDateTime(entry.createdAt)}
                    >
                      {formatTimeOnly(entry.createdAt)}
                    </span>

                    {/* Borderless 3-letter Level */}
                    <span
                      className={`w-7 text-[10px] font-semibold uppercase tracking-wide select-none shrink-0 ${accent.tag}`}
                    >
                      {LEVEL_TAG[entry.level]}
                    </span>

                    {/* Log Message */}
                    <span className={accent.msg}>
                      {wrapLines ? entry.message : entry.message.replace(/\r?\n/g, " ↵ ")}
                    </span>

                    {/* Clean Inline key=value Structured Fields */}
                    {hasFields && (
                      <span className="inline-flex items-baseline gap-2.5 ml-2 text-[11px]">
                        {fieldEntries.map(([k, v]) => (
                          <span key={k} className="inline-flex items-baseline">
                            <span className="text-[var(--text-muted)] opacity-70">{k}=</span>
                            <span className="text-[var(--text-secondary)]">
                              {formatCompactFieldValue(v)}
                            </span>
                          </span>
                        ))}
                        <ChevronRight
                          className={`w-3 h-3 text-[var(--text-muted)] opacity-50 self-center transition-transform duration-150 ${
                            isExpanded ? "rotate-90 opacity-90" : ""
                          }`}
                        />
                      </span>
                    )}
                  </div>

                  {/* Click-to-expand Structured Fields Detail Drawer */}
                  {hasFields && isExpanded && (
                    <div className="border-l-2 border-l-[var(--border-strong)] bg-[var(--bg-surface)]/80 pl-[116px] pr-4 py-2">
                      <pre className="text-[11px] leading-5 text-[var(--text-secondary)] overflow-x-auto">
                        {JSON.stringify(entry.fields, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}

            {hasMore && onLoadMore && (
              <div className="px-4 py-2.5 text-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                  className="px-3 py-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>加载更多日志</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
