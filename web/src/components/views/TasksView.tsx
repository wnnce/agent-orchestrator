import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ListTodo,
  Play,
  RotateCw,
  Clock,
  Calendar,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { fetchProjectTasks, fetchTaskExecutions, runProjectTask } from "../../api/client";
import { useStudio } from "../../context/StudioContext";
import type { TaskDefinition, TaskExecutionRecord } from "../../types";
import { formatDateTime, formatDuration, formatTimeAgo } from "../../utils/formatters";

export function TasksView() {
  const { activeProjectId } = useStudio();
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [executions, setExecutions] = useState<TaskExecutionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [expandedExecId, setExpandedExecId] = useState<string | null>(null);

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
              tasks/*.md
            </span>
          </div>

          {tasks.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--text-muted)] font-mono">
              No tasks configured in projects/{activeProjectId}/tasks/*.md
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-default)]">
              {tasks.map((task) => (
                <div
                  key={task.taskKey}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-[var(--bg-surface-hover)] transition-colors"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
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
                    className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 disabled:opacity-40 text-xs font-mono font-medium transition-opacity cursor-pointer shrink-0 flex items-center gap-1.5"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>{runningTaskId === task.taskId ? "Running..." : "Run Now"}</span>
                  </button>
                </div>
              ))}
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
                              onClick={() =>
                                setExpandedExecId(isExpanded ? null : exec.executionId)
                              }
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

                        {isExpanded && (
                          <tr className="bg-[var(--bg-code)]">
                            <td colSpan={6} className="p-4 border-b border-[var(--border-default)]">
                              <div className="space-y-3 text-[11px] font-mono">
                                {exec.errorMessage && (
                                  <div className="p-2.5 rounded-[var(--radius-xs)] bg-red-500/10 border border-red-500/20 text-red-400">
                                    Error: {exec.errorMessage}
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
                        )}
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
