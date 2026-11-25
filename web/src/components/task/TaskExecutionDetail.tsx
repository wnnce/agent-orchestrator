import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { m } from "motion/react";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  Clock,
  Copy,
  Database,
  Loader2,
  RotateCw,
  Search,
  Terminal,
} from "lucide-react";
import { tasksApi } from "../../api";
import type {
  TaskDefinition,
  TaskExecutionLogLevel,
  TaskExecutionLogRecord,
  TaskExecutionRecord,
} from "../../types";
import { copyToClipboard } from "../../utils/clipboard";
import { formatDateTime, formatDuration } from "../../utils/formatters";
import { EASE_OUT_EXPO } from "../../utils/motion";

const LOG_LEVEL_BADGE: Record<TaskExecutionLogLevel, string> = {
  debug: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20",
  info: "text-sky-500 dark:text-sky-400 bg-sky-500/10 border-sky-500/25",
  warn: "text-amber-500 dark:text-amber-400 bg-amber-500/10 border-amber-500/25",
  error: "text-red-500 dark:text-red-400 bg-red-500/10 border-red-500/25",
};

function formatLogTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

export interface TaskExecutionDetailProps {
  execution: TaskExecutionRecord;
  task?: TaskDefinition | null;
}

export function TaskExecutionDetail({ execution, task }: TaskExecutionDetailProps) {
  const [activeTab, setActiveTab] = useState<"logs" | "state">("logs");
  const [logs, setLogs] = useState<TaskExecutionLogRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextAfterSeq, setNextAfterSeq] = useState(0);
  const [level, setLevel] = useState<TaskExecutionLogLevel | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadedExecutionId, setLoadedExecutionId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const loadReqIdRef = useRef(0);

  const taskType = (task?.type ?? "ts").toLowerCase();
  const summary = execution.actionsSummary ?? {};
  const isScriptOutput =
    taskType === "script" ||
    (typeof summary.command === "string" &&
      ("stdout" in summary || "stderr" in summary || "exitCode" in summary));
  const isActionOutput =
    taskType === "action" || (typeof summary.action === "string" && "result" in summary);

  const isLoadingInitialLogs =
    !isScriptOutput &&
    !isActionOutput &&
    (loading || loadedExecutionId !== execution.executionId);

  const loadLogs = useCallback(
    async (opts?: { level?: TaskExecutionLogLevel | "all"; append?: boolean; afterSeq?: number }) => {
      const targetLevel = opts?.level ?? level;
      const append = opts?.append ?? false;
      const afterSeq = append ? (opts?.afterSeq ?? nextAfterSeq) : 0;
      const reqId = ++loadReqIdRef.current;

      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }

      try {
        const res = await tasksApi.listExecutionLogs(execution.executionId, {
          ...(afterSeq > 0 ? { afterSeq } : {}),
          ...(targetLevel !== "all" ? { level: targetLevel } : {}),
          limit: 200,
        });
        if (reqId !== loadReqIdRef.current) return;
        setLogs((prev) => (append ? [...prev, ...res.logs] : res.logs));
        setHasMore(res.hasMore);
        setNextAfterSeq(res.nextAfterSeq);
        setLoadedExecutionId(execution.executionId);
      } catch (err) {
        if (reqId !== loadReqIdRef.current) return;
        console.error("Failed to fetch execution logs:", err);
        toast.error("加载任务日志失败");
        setLoadedExecutionId(execution.executionId);
      } finally {
        if (reqId === loadReqIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [execution.executionId, level, nextAfterSeq],
  );

  useEffect(() => {
    setLogs([]);
    setHasMore(false);
    setNextAfterSeq(0);
    setLevel("all");
    setSearchQuery("");
    setActiveTab("logs");
    if (!isScriptOutput && !isActionOutput) {
      void loadLogs({ level: "all", append: false, afterSeq: 0 });
    }
  }, [execution.executionId, isScriptOutput, isActionOutput]);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(
      (entry) =>
        entry.message.toLowerCase().includes(q) ||
        (entry.fields && JSON.stringify(entry.fields).toLowerCase().includes(q)),
    );
  }, [logs, searchQuery]);

  const handleCopyExecutionId = async () => {
    const ok = await copyToClipboard(execution.executionId);
    if (ok) {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1600);
      toast.success("已复制 Execution ID");
    }
  };

  const handleCopyLogs = async () => {
    const text = filteredLogs
      .map(
        (entry) =>
          `${entry.createdAt} [${entry.level.toUpperCase()}] #${entry.sequence} ${entry.message}${
            entry.fields && Object.keys(entry.fields).length > 0
              ? ` ${JSON.stringify(entry.fields)}`
              : ""
          }`,
      )
      .join("\n");
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedLogs(true);
      setTimeout(() => setCopiedLogs(false), 1600);
      toast.success(`已复制 ${filteredLogs.length} 条日志`);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-[var(--bg-canvas)] select-text">
      {/* Compact Run Meta + Sub-tabs Bar (matches embedded Agent run 1:1) */}
      <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-semibold border uppercase ${
                execution.status === "success"
                  ? "text-emerald-500 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                  : "text-red-500 dark:text-red-400 bg-red-500/10 border-red-500/20"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  execution.status === "success" ? "bg-emerald-500" : "bg-red-500"
                }`}
              />
              {execution.status}
            </span>

            <button
              type="button"
              onClick={handleCopyExecutionId}
              title={`点击复制 ${execution.executionId}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors cursor-pointer"
            >
              <span>{execution.executionId.slice(0, 18)}...</span>
              {copiedId ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <Copy className="w-3 h-3 opacity-60" />
              )}
            </button>

            <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
              <Clock className="w-3 h-3" />
              <span>{formatDuration(execution.durationMs)}</span>
            </span>

            {execution.startedAt && (
              <span className="text-[10.5px] text-[var(--text-muted)] hidden lg:inline">
                {formatDateTime(execution.startedAt)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5 bg-[var(--bg-canvas)] p-0.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] text-[10.5px]">
            <button
              type="button"
              onClick={() => setActiveTab("logs")}
              className={`px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors cursor-pointer inline-flex items-center gap-1 ${
                activeTab === "logs"
                  ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Terminal className="w-3 h-3" />
              <span>
                日志
                {!isScriptOutput && !isActionOutput ? ` (${logs.length}${hasMore ? "+" : ""})` : ""}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("state")}
              className={`px-2 py-0.5 rounded-[var(--radius-xs)] transition-colors cursor-pointer inline-flex items-center gap-1 ${
                activeTab === "state"
                  ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              <Database className="w-3 h-3" />
              <span>状态与输出</span>
            </button>
          </div>
        </div>

        {execution.errorMessage && (
          <div className="flex items-start gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] border border-red-500/30 bg-red-500/10 text-[11px] text-red-400 font-mono">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-500" />
            <span className="break-words leading-relaxed">{execution.errorMessage}</span>
          </div>
        )}
      </div>

      {/* Tab Body */}
      <m.div
        key={`${execution.executionId}:${activeTab}`}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.14, ease: EASE_OUT_EXPO }}
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
      >
        {activeTab === "logs" ? (
          isScriptOutput ? (
            <div className="flex-1 overflow-y-auto p-5 space-y-4 font-mono text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-default)]">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                    Command
                  </div>
                  <code className="text-[var(--text-primary)] break-all">
                    {String(summary.command ?? "")}
                  </code>
                </div>
                {"exitCode" in summary && (
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-[var(--radius-xs)] border shrink-0 ${
                      summary.exitCode === 0
                        ? "text-emerald-500 bg-emerald-500/10 border-emerald-500/20"
                        : "text-red-500 bg-red-500/10 border-red-500/20"
                    }`}
                  >
                    exit {String(summary.exitCode)}
                  </span>
                )}
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                  stdout
                </div>
                <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-default)] text-[11.5px] text-[var(--text-code)] whitespace-pre-wrap overflow-x-auto leading-relaxed">
                  {typeof summary.stdout === "string" && summary.stdout.length > 0
                    ? summary.stdout
                    : "(empty)"}
                </pre>
              </div>

              {typeof summary.stderr === "string" && summary.stderr.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-red-400 mb-1.5">
                    stderr
                  </div>
                  <pre className="p-3 rounded-[var(--radius-sm)] bg-red-500/5 border border-red-500/25 text-[11.5px] text-red-400 whitespace-pre-wrap overflow-x-auto leading-relaxed">
                    {summary.stderr}
                  </pre>
                </div>
              )}
            </div>
          ) : isActionOutput ? (
            <div className="flex-1 overflow-y-auto p-5 space-y-4 font-mono text-xs">
              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-default)]">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  Action
                </div>
                <div className="text-[var(--text-primary)] font-semibold">
                  {String(summary.action ?? "")}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                  Result
                </div>
                <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-default)] text-[11.5px] text-[var(--text-code)] overflow-x-auto leading-relaxed">
                  {JSON.stringify(summary.result ?? null, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Compact Log Filter Bar */}
              <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-canvas)] flex flex-wrap items-center justify-between gap-2 shrink-0">
                <div className="relative w-52 sm:w-64">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="过滤日志关键字..."
                    className="w-full pl-8 pr-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-hidden focus:border-[var(--border-focus)] transition-colors"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1 font-mono">
                  {(["all", "debug", "info", "warn", "error"] as const).map((lvl) => {
                    const active = level === lvl;
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => {
                          setLevel(lvl);
                          void loadLogs({ level: lvl, append: false, afterSeq: 0 });
                        }}
                        className={`px-2 py-0.5 rounded-[var(--radius-xs)] text-[10px] uppercase border transition-colors cursor-pointer ${
                          active
                            ? "bg-[var(--primary)] text-[var(--text-inverted)] border-[var(--primary)]"
                            : "bg-[var(--bg-surface)] text-[var(--text-muted)] border-[var(--border-default)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        {lvl}
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    onClick={handleCopyLogs}
                    disabled={filteredLogs.length === 0}
                    title="Copy visible logs"
                    className="ml-1 px-2 py-0.5 rounded-[var(--radius-xs)] text-[10px] bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] disabled:opacity-40 cursor-pointer inline-flex items-center gap-1"
                  >
                    {copiedLogs ? (
                      <Check className="w-3 h-3 text-emerald-500" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    <span>Copy</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void loadLogs({ level, append: false, afterSeq: 0 })}
                    disabled={loading}
                    title="Refresh logs"
                    className="p-1 rounded-[var(--radius-xs)] bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] disabled:opacity-40 cursor-pointer"
                  >
                    <RotateCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                  </button>
                </div>
              </div>

              {/* Scrollable Terminal Stream */}
              <div className="flex-1 overflow-y-auto bg-[var(--bg-code)] font-mono">
                {isLoadingInitialLogs ? (
                  <div className="h-full flex items-center justify-center gap-2 text-xs text-[var(--text-muted)] animate-delayed-fade">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Loading logs...</span>
                  </div>
                ) : filteredLogs.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center gap-1.5 text-xs text-[var(--text-muted)] p-8">
                    <Terminal className="w-5 h-5 opacity-40" />
                    <span>
                      {logs.length === 0 ? "本次执行无日志输出" : "没有匹配当前筛选条件的日志"}
                    </span>
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--border-subtle)]/70">
                    {filteredLogs.map((entry) => (
                      <div
                        key={`${entry.executionId}:${entry.sequence}`}
                        className="px-4 py-1.5 flex items-start gap-2.5 text-[11.5px] leading-relaxed hover:bg-[var(--bg-surface-hover)]/40"
                      >
                        <span className="text-[10px] text-[var(--text-muted)] opacity-60 shrink-0 w-9 text-right tabular-nums select-none">
                          #{entry.sequence}
                        </span>
                        <span className="text-[10.5px] text-[var(--text-muted)] shrink-0 tabular-nums select-none">
                          {formatLogTime(entry.createdAt)}
                        </span>
                        <span
                          className={`text-[9.5px] uppercase px-1.5 py-0 rounded-[var(--radius-xs)] border shrink-0 w-12 text-center select-none ${LOG_LEVEL_BADGE[entry.level]}`}
                        >
                          {entry.level}
                        </span>
                        <div className="min-w-0 flex-1 break-words">
                          <span className="text-[var(--text-primary)]">{entry.message}</span>
                          {entry.fields && Object.keys(entry.fields).length > 0 && (
                            <span className="ml-2 text-[10.5px] text-[var(--text-muted)]">
                              {JSON.stringify(entry.fields)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                    {hasMore && (
                      <div className="p-3 text-center bg-[var(--bg-canvas)]">
                        <button
                          type="button"
                          disabled={loadingMore}
                          onClick={() =>
                            void loadLogs({ level, append: true, afterSeq: nextAfterSeq })
                          }
                          className="px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
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
          )
        ) : (
          <div className="flex-1 overflow-y-auto p-5 font-mono text-xs">
            <div className="max-w-3xl mx-auto space-y-4">
              {execution.actionsSummary && Object.keys(execution.actionsSummary).length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                    actionsSummary
                  </div>
                  <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-default)] text-[11.5px] text-[var(--text-code)] overflow-x-auto max-h-60 leading-relaxed">
                    {JSON.stringify(execution.actionsSummary, null, 2)}
                  </pre>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                    stateBefore
                  </div>
                  <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-default)] text-[11.5px] text-[var(--text-code)] overflow-x-auto max-h-72 leading-relaxed">
                    {JSON.stringify(execution.stateBefore || {}, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                    stateAfter
                  </div>
                  <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-default)] text-[11.5px] text-[var(--text-code)] overflow-x-auto max-h-72 leading-relaxed">
                    {JSON.stringify(execution.stateAfter || {}, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </m.div>
    </div>
  );
}
