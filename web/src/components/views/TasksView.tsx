import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Play,
  RotateCw,
  Clock,
  Calendar,
  ChevronDown,
  ChevronUp,
  Cpu,
  Terminal,
  Loader2,
} from "lucide-react";
import {
  fetchProjectTasks,
  fetchTaskExecutionLogs,
  fetchTaskExecutions,
  runProjectTask,
} from "../../api/client";
import { useStudio } from "../../context/StudioContext";
import type {
  TaskDefinition,
  TaskExecutionLogLevel,
  TaskExecutionLogRecord,
  TaskExecutionRecord,
} from "../../types";
import { formatDateTime, formatDuration, formatTimeAgo } from "../../utils/formatters";

interface ExecutionLogsState {
  logs: TaskExecutionLogRecord[];
  hasMore: boolean;
  nextAfterSeq: number;
  level: TaskExecutionLogLevel | "all";
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
}

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

export function TasksView() {
  const { activeProjectId, activeProject } = useStudio();
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [executions, setExecutions] = useState<TaskExecutionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [expandedExecId, setExpandedExecId] = useState<string | null>(null);
  const [logsByExecId, setLogsByExecId] = useState<Record<string, ExecutionLogsState>>({});

  const loadExecutionLogs = async (
    executionId: string,
    options?: { level?: TaskExecutionLogLevel | "all"; append?: boolean; afterSeq?: number },
  ) => {
    const level = options?.level ?? logsByExecId[executionId]?.level ?? "all";
    const append = options?.append ?? false;
    const afterSeq = append ? (options?.afterSeq ?? logsByExecId[executionId]?.nextAfterSeq ?? 0) : 0;

    setLogsByExecId((prev) => {
      const existing = prev[executionId];
      return {
        ...prev,
        [executionId]: {
          logs: append ? (existing?.logs ?? []) : [],
          hasMore: append ? (existing?.hasMore ?? false) : false,
          nextAfterSeq: append ? (existing?.nextAfterSeq ?? 0) : 0,
          level,
          loading: !append,
          loadingMore: append,
          loaded: existing?.loaded ?? false,
        },
      };
    });

    try {
      const res = await fetchTaskExecutionLogs(executionId, {
        ...(afterSeq > 0 ? { afterSeq } : {}),
        ...(level !== "all" ? { level } : {}),
        limit: 200,
      });
      setLogsByExecId((prev) => {
        const existing = prev[executionId];
        return {
          ...prev,
          [executionId]: {
            logs: append ? [...(existing?.logs ?? []), ...res.logs] : res.logs,
            hasMore: res.hasMore,
            nextAfterSeq: res.nextAfterSeq,
            level,
            loading: false,
            loadingMore: false,
            loaded: true,
          },
        };
      });
    } catch (err) {
      console.error("Failed to load task execution logs:", err);
      setLogsByExecId((prev) => {
        const existing = prev[executionId];
        return {
          ...prev,
          [executionId]: {
            logs: existing?.logs ?? [],
            hasMore: existing?.hasMore ?? false,
            nextAfterSeq: existing?.nextAfterSeq ?? 0,
            level,
            loading: false,
            loadingMore: false,
            loaded: true,
          },
        };
      });
    }
  };

  const handleToggleInspect = (executionId: string) => {
    if (expandedExecId === executionId) {
      setExpandedExecId(null);
      return;
    }
    setExpandedExecId(executionId);
    if (!logsByExecId[executionId]?.loaded) {
      void loadExecutionLogs(executionId, { level: "all", append: false });
    }
  };

  const loadData = async () => {
    if (!activeProjectId) return;
    setLoading(true);
    try {
      const [tList, eList] = await Promise.all([
        fetchProjectTasks(activeProjectId),
        fetchTaskExecutions({ projectId: activeProjectId, limit: 30 }),
      ]);
      setTasks(tList);
      setExecutions(eList);
    } catch (err) {
      console.error("Failed to load tasks and executions:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeProjectId]);

  const handleRunTask = async (taskId: string) => {
    if (!activeProjectId) return;
    setRunningTaskId(taskId);
    try {
      const res = await runProjectTask(activeProjectId, taskId);
      toast.success(`Task [${taskId}] triggered`, {
        description: res.message || "Execution started in background",
      });
      await loadData();
    } catch (err: any) {
      toast.error(`Trigger task failed: ${err.message || String(err)}`);
    } finally {
      setRunningTaskId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[var(--bg-canvas)] select-text">
      {/* Vercel Header */}
      <div className="px-6 py-6 border-b border-[var(--border-default)] bg-[var(--bg-header)]">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
              Tasks & Pipeline
            </h1>
            <p className="text-xs text-[var(--text-secondary)]">
              Cron inspection pipelines and execution audit log for project {activeProjectId}.
            </p>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            className="px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] hover:bg-[var(--bg-surface-hover)] text-xs font-mono text-[var(--text-primary)] transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <RotateCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto w-full px-6 py-6 space-y-8">
        {/* Section 1: Defined Tasks in Flat Table */}
        <div className="border border-[var(--border-default)] rounded-[var(--radius-sm)] overflow-hidden">
          <div className="px-4 py-2.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
              Configured Tasks ({tasks.length})
            </span>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              tasks/*.md · tasks/*.ts
            </span>
          </div>

          {tasks.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--text-muted)] font-mono">
              No tasks configured in projects/{activeProjectId}/tasks/
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-default)]">
              {tasks.map((task) => {
                const taskType = (task.type ?? "agent").toLowerCase();
                const isAgentTask = taskType === "agent";
                const typeBadgeClass =
                  taskType === "ts"
                    ? "text-sky-500 dark:text-sky-400 bg-sky-500/10 border-sky-500/25"
                    : taskType === "script"
                      ? "text-amber-500 dark:text-amber-400 bg-amber-500/10 border-amber-500/25"
                      : taskType === "action"
                        ? "text-purple-500 dark:text-purple-400 bg-purple-500/10 border-purple-500/25"
                        : "text-[var(--text-secondary)] bg-[var(--bg-surface-elevated)] border-[var(--border-default)]";
                const override = task.runtime;
                const hasOverride = Boolean(
                  override && (override.type || override.model || override.reasoningEffort),
                );
                const projectRuntime = activeProject?.runtime;
                const effectiveType = override?.type ?? projectRuntime?.type;
                const sameAsDefaultRuntime =
                  !override?.type ||
                  !projectRuntime?.type ||
                  override.type.toLowerCase() === projectRuntime.type.toLowerCase();
                const effectiveModel =
                  override?.model ?? (sameAsDefaultRuntime ? projectRuntime?.model : undefined);
                const effectiveEffort =
                  override?.reasoningEffort ??
                  (sameAsDefaultRuntime ? projectRuntime?.reasoningEffort : undefined);
                const runtimeParts = [effectiveType, effectiveModel, effectiveEffort].filter(
                  Boolean,
                );

                return (
                  <div
                    key={task.taskKey}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-[var(--bg-surface-hover)] transition-colors"
                  >
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-xs text-[var(--text-primary)] font-mono">
                          {task.name}
                        </span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded-[var(--radius-xs)] border ${
                            task.enabled
                              ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                              : "text-[var(--text-muted)] bg-[var(--bg-surface-elevated)] border-[var(--border-default)]"
                          }`}
                        >
                          {task.enabled ? "ENABLED" : "DISABLED"}
                        </span>
                        <span
                          className={`text-[10px] font-mono uppercase px-1.5 py-0.2 rounded-[var(--radius-xs)] border ${typeBadgeClass}`}
                        >
                          {taskType}
                        </span>
                        {isAgentTask && runtimeParts.length > 0 && (
                          <span
                            title={
                              hasOverride
                                ? `Task 自定义运行配置: ${runtimeParts.join(" · ")}`
                                : `跟随项目默认运行配置: ${runtimeParts.join(" · ")}`
                            }
                            className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.2 rounded-[var(--radius-xs)] border max-w-full ${
                              hasOverride
                                ? "text-indigo-500 dark:text-indigo-400 bg-indigo-500/10 border-indigo-500/25"
                                : "text-[var(--text-secondary)] bg-[var(--bg-surface-elevated)] border-[var(--border-default)]"
                            }`}
                          >
                            <Cpu className="w-2.5 h-2.5 shrink-0" />
                            <span className="truncate">{runtimeParts.join(" · ")}</span>
                            {!hasOverride && (
                              <span className="text-[var(--text-muted)] shrink-0">(default)</span>
                            )}
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-[var(--text-secondary)] line-clamp-1">
                        {task.description || "No description provided."}
                      </p>

                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)] font-mono pt-0.5">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span>cron: {task.cron}</span>
                        </span>
                        {task.nextRun && (
                          <span className="flex items-center gap-1 text-[var(--text-secondary)]">
                            <Calendar className="w-3 h-3" />
                            <span>next: {formatDateTime(task.nextRun)}</span>
                          </span>
                        )}
                        <span>file: {task.filePath.split("/").pop()}</span>
                      </div>
                    </div>

                    <button
                      onClick={() => handleRunTask(task.taskId)}
                      disabled={runningTaskId === task.taskId}
                      className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 active:scale-95 disabled:opacity-40 text-xs font-mono font-medium transition-all cursor-pointer shrink-0 flex items-center gap-1.5"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>{runningTaskId === task.taskId ? "Running..." : "Run Now"}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Section 2: Execution Audit Table */}
        <div className="border border-[var(--border-default)] rounded-[var(--radius-sm)] overflow-hidden">
          <div className="px-4 py-2.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
              Execution Audit Log ({executions.length})
            </span>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              task_executions
            </span>
          </div>

          {executions.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--text-muted)] font-mono">
              No executions recorded yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-[var(--bg-table-header)] text-[var(--text-muted)] text-[11px] border-b border-[var(--border-default)]">
                  <tr>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Task ID</th>
                    <th className="py-2 px-3">Duration</th>
                    <th className="py-2 px-3">Started</th>
                    <th className="py-2 px-3">Session</th>
                    <th className="py-2 px-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {executions.map((exec) => {
                    const isExpanded = expandedExecId === exec.executionId;
                    return (
                      <React.Fragment key={exec.executionId}>
                        <tr className="hover:bg-[var(--bg-table-row-hover)] transition-colors">
                          <td className="py-2 px-3">
                            <span
                              className={`inline-flex px-1.5 py-0.2 rounded-[var(--radius-xs)] text-[10px] border ${
                                exec.status === "success"
                                  ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                                  : "text-red-400 bg-red-500/10 border-red-500/20"
                              }`}
                            >
                              {exec.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-semibold text-[var(--text-primary)]">
                            {exec.taskId}
                          </td>
                          <td className="py-2 px-3 text-[var(--text-muted)]">
                            {formatDuration(exec.durationMs)}
                          </td>
                          <td className="py-2 px-3 text-[var(--text-muted)]">
                            {exec.startedAt ? formatTimeAgo(exec.startedAt) : "-"}
                          </td>
                          <td className="py-2 px-3 text-[var(--text-muted)]">
                            {exec.sessionId ? `${exec.sessionId.slice(0, 12)}...` : "-"}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <button
                              onClick={() => handleToggleInspect(exec.executionId)}
                              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer inline-flex items-center gap-0.5"
                            >
                              <span>{isExpanded ? "Hide" : "Inspect"}</span>
                              {isExpanded ? (
                                <ChevronUp className="w-3 h-3" />
                              ) : (
                                <ChevronDown className="w-3 h-3" />
                              )}
                            </button>
                          </td>
                        </tr>

                        {isExpanded && (() => {
                          const logState = logsByExecId[exec.executionId];
                          const hasSummary =
                            exec.actionsSummary && Object.keys(exec.actionsSummary).length > 0;
                          return (
                            <tr className="bg-[var(--bg-code)]">
                              <td colSpan={6} className="p-4 border-b border-[var(--border-default)]">
                                <div className="space-y-3 text-[11px] font-mono">
                                  {exec.errorMessage && (
                                    <div className="p-2.5 rounded-[var(--radius-xs)] bg-red-500/10 border border-red-500/20 text-red-400">
                                      Error: {exec.errorMessage}
                                    </div>
                                  )}

                                  {/* Execution Logs Viewer */}
                                  <div className="space-y-1.5">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="text-[var(--text-muted)] inline-flex items-center gap-1.5">
                                        <Terminal className="w-3 h-3" />
                                        <span>
                                          Execution Logs ({logState?.logs.length ?? 0}
                                          {logState?.hasMore ? "+" : ""})
                                        </span>
                                      </span>
                                      <div className="flex items-center gap-1">
                                        {(["all", "debug", "info", "warn", "error"] as const).map(
                                          (lvl) => {
                                            const active = (logState?.level ?? "all") === lvl;
                                            return (
                                              <button
                                                key={lvl}
                                                type="button"
                                                onClick={() =>
                                                  void loadExecutionLogs(exec.executionId, {
                                                    level: lvl,
                                                    append: false,
                                                  })
                                                }
                                                className={`px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[10px] uppercase border transition-colors cursor-pointer ${
                                                  active
                                                    ? "bg-[var(--primary)] text-[var(--text-inverted)] border-[var(--primary)]"
                                                    : "bg-[var(--bg-canvas)] text-[var(--text-muted)] border-[var(--border-default)] hover:text-[var(--text-primary)]"
                                                }`}
                                              >
                                                {lvl}
                                              </button>
                                            );
                                          },
                                        )}
                                        <button
                                          type="button"
                                          onClick={() =>
                                            void loadExecutionLogs(exec.executionId, {
                                              level: logState?.level ?? "all",
                                              append: false,
                                            })
                                          }
                                          disabled={logState?.loading}
                                          title="Refresh logs"
                                          className="p-1 rounded-[var(--radius-xs)] bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50"
                                        >
                                          <RotateCw
                                            className={`w-3 h-3 ${logState?.loading ? "animate-spin" : ""}`}
                                          />
                                        </button>
                                      </div>
                                    </div>

                                    <div className="rounded-[var(--radius-xs)] bg-[var(--bg-canvas)] border border-[var(--border-default)] max-h-64 overflow-y-auto">
                                      {logState?.loading ? (
                                        <div className="p-4 flex items-center justify-center gap-2 text-[var(--text-muted)]">
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                          <span>Loading logs...</span>
                                        </div>
                                      ) : !logState || logState.logs.length === 0 ? (
                                        <div className="p-3 text-[var(--text-muted)] text-[11px]">
                                          No execution logs recorded.
                                        </div>
                                      ) : (
                                        <div className="divide-y divide-[var(--border-subtle)]">
                                          {logState.logs.map((entry) => (
                                            <div
                                              key={`${entry.executionId}:${entry.sequence}`}
                                              className="px-2.5 py-1.5 flex items-start gap-2 text-[11px] leading-relaxed hover:bg-[var(--bg-surface-hover)]/40"
                                            >
                                              <span className="text-[10px] text-[var(--text-muted)] shrink-0 tabular-nums">
                                                {formatLogTime(entry.createdAt)}
                                              </span>
                                              <span
                                                className={`text-[9.5px] uppercase px-1 py-0 rounded-[var(--radius-xs)] border shrink-0 ${LOG_LEVEL_BADGE[entry.level]}`}
                                              >
                                                {entry.level}
                                              </span>
                                              <div className="min-w-0 flex-1 break-words">
                                                <span className="text-[var(--text-primary)]">
                                                  {entry.message}
                                                </span>
                                                {entry.fields &&
                                                  Object.keys(entry.fields).length > 0 && (
                                                    <span className="ml-2 text-[10.5px] text-[var(--text-muted)]">
                                                      {JSON.stringify(entry.fields)}
                                                    </span>
                                                  )}
                                              </div>
                                            </div>
                                          ))}
                                          {logState.hasMore && (
                                            <div className="p-2 text-center">
                                              <button
                                                type="button"
                                                disabled={logState.loadingMore}
                                                onClick={() =>
                                                  void loadExecutionLogs(exec.executionId, {
                                                    level: logState.level,
                                                    append: true,
                                                    afterSeq: logState.nextAfterSeq,
                                                  })
                                                }
                                                className="px-2.5 py-1 rounded-[var(--radius-xs)] border border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                                              >
                                                {logState.loadingMore && (
                                                  <Loader2 className="w-3 h-3 animate-spin" />
                                                )}
                                                <span>Load more logs</span>
                                              </button>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {hasSummary && (
                                    <div>
                                      <span className="text-[var(--text-muted)] block mb-1">
                                        actionsSummary:
                                      </span>
                                      <pre className="p-2.5 rounded-[var(--radius-xs)] bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-primary)] overflow-x-auto max-h-40">
                                        {JSON.stringify(exec.actionsSummary, null, 2)}
                                      </pre>
                                    </div>
                                  )}

                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <div>
                                      <span className="text-[var(--text-muted)] block mb-1">
                                        stateBefore:
                                      </span>
                                      <pre className="p-2.5 rounded-[var(--radius-xs)] bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-primary)] overflow-x-auto max-h-40">
                                        {JSON.stringify(exec.stateBefore || {}, null, 2)}
                                      </pre>
                                    </div>
                                    <div>
                                      <span className="text-[var(--text-muted)] block mb-1">
                                        stateAfter:
                                      </span>
                                      <pre className="p-2.5 rounded-[var(--radius-xs)] bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-primary)] overflow-x-auto max-h-40">
                                        {JSON.stringify(exec.stateAfter || {}, null, 2)}
                                      </pre>
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          );
                        })()}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
