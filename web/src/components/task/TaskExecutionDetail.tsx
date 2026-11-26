import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { m } from "motion/react";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  Clock,
  Copy,
  Database,
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
import { LogViewer, type LogEntry } from "../common/LogViewer";

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
  const [loading, setLoading] = useState(false);
  const [loadedExecutionId, setLoadedExecutionId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
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
    setActiveTab("logs");
    if (!isScriptOutput && !isActionOutput) {
      void loadLogs({ level: "all", append: false, afterSeq: 0 });
    }
  }, [execution.executionId, isScriptOutput, isActionOutput]);

  const logEntries: LogEntry[] = useMemo(
    () =>
      logs.map((entry) => ({
        key: `${entry.executionId}:${entry.sequence}`,
        sequence: entry.sequence,
        level: entry.level,
        message: entry.message,
        fields: entry.fields,
        createdAt: entry.createdAt,
      })),
    [logs],
  );

  const handleCopyExecutionId = async () => {
    const ok = await copyToClipboard(execution.executionId);
    if (ok) {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1600);
      toast.success("已复制 Execution ID");
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-[var(--bg-canvas)] select-text">
      {/* Compact Run Meta + Sub-tabs Bar (matches embedded Agent run 1:1) */}
      <div className="px-5 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-surface)] shrink-0 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-semibold border uppercase ${
                execution.status === "success"
                  ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                  : "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20"
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
          <div className="flex items-start gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] border border-red-500/30 bg-red-500/10 text-[11px] text-red-600 dark:text-red-400 font-mono">
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
        className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--bg-canvas)]"
      >
        {activeTab === "logs" ? (
          isScriptOutput ? (
            <div className="flex-1 overflow-y-auto p-5 space-y-4 font-mono text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 p-4 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)]">
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
                        ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                        : "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20"
                    }`}
                  >
                    exit {String(summary.exitCode)}
                  </span>
                )}
              </div>

              <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  stdout
                </div>
                <pre className="p-4 bg-[var(--bg-code)] text-[11.5px] text-[var(--text-code)] whitespace-pre-wrap overflow-x-auto leading-relaxed">
                  {typeof summary.stdout === "string" && summary.stdout.length > 0
                    ? summary.stdout
                    : "(empty)"}
                </pre>
              </div>

              {typeof summary.stderr === "string" && summary.stderr.length > 0 && (
                <div className="rounded-[var(--radius-md)] border border-red-500/25 bg-[var(--bg-surface)] overflow-hidden">
                  <div className="px-4 py-2 border-b border-red-500/20 bg-red-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
                    stderr
                  </div>
                  <pre className="p-4 bg-red-500/5 text-[11.5px] text-red-600 dark:text-red-400 whitespace-pre-wrap overflow-x-auto leading-relaxed">
                    {summary.stderr}
                  </pre>
                </div>
              )}
            </div>
          ) : isActionOutput ? (
            <div className="flex-1 overflow-y-auto p-5 space-y-4 font-mono text-xs">
              <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)]">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  Action
                </div>
                <div className="text-[var(--text-primary)] font-semibold">
                  {String(summary.action ?? "")}
                </div>
              </div>
              <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Result
                </div>
                <pre className="p-4 bg-[var(--bg-code)] text-[11.5px] text-[var(--text-code)] overflow-x-auto leading-relaxed">
                  {JSON.stringify(summary.result ?? null, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 p-5">
              <LogViewer
                logs={logEntries}
                loading={isLoadingInitialLogs}
                emptyText="本次执行无日志输出"
                level={level}
                onLevelChange={(nextLevel) => {
                  setLevel(nextLevel);
                  void loadLogs({ level: nextLevel, append: false, afterSeq: 0 });
                }}
                onRefresh={() => void loadLogs({ level, append: false, afterSeq: 0 })}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={() => void loadLogs({ level, append: true, afterSeq: nextAfterSeq })}
                fillHeight
              />
            </div>
          )
        ) : (
          <div className="flex-1 overflow-y-auto p-5 font-mono text-xs">
            <div className="w-full space-y-4">
              {execution.actionsSummary && Object.keys(execution.actionsSummary).length > 0 && (
                <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                  <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    actionsSummary
                  </div>
                  <pre className="p-4 bg-[var(--bg-code)] text-[11.5px] text-[var(--text-code)] overflow-x-auto max-h-60 leading-relaxed">
                    {JSON.stringify(execution.actionsSummary, null, 2)}
                  </pre>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                  <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    stateBefore
                  </div>
                  <pre className="p-4 bg-[var(--bg-code)] text-[11.5px] text-[var(--text-code)] overflow-x-auto max-h-72 leading-relaxed">
                    {JSON.stringify(execution.stateBefore || {}, null, 2)}
                  </pre>
                </div>
                <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
                  <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    stateAfter
                  </div>
                  <pre className="p-4 bg-[var(--bg-code)] text-[11.5px] text-[var(--text-code)] overflow-x-auto max-h-72 leading-relaxed">
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
