import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, m } from "motion/react";
import { toast } from "sonner";
import {
  Clock,
  Cpu,
  FileCode2,
  ListTodo,
  Loader2,
  MessageSquare,
  Play,
  RotateCw,
  Search,
  Terminal,
} from "lucide-react";
import { generatePath, useNavigate, useParams } from "react-router";
import { tasksApi } from "../../api";
import { useCurrentProject } from "../../layouts/ProjectLayout";
import { queryKeys } from "../../queries";
import { ROUTES } from "../../routes";
import type { ProjectRuntimeDefault, TaskDefinition, TaskExecutionRecord } from "../../types";
import { formatDateTime, formatDuration, formatTimeAgo } from "../../utils/formatters";
import { EASE_OUT_EXPO } from "../../utils/motion";
import { SessionConversation } from "../session/SessionConversation";
import { TaskExecutionDetail } from "../task/TaskExecutionDetail";

function taskTypeBadgeClass(taskType: string): string {
  switch (taskType) {
    case "ts":
      return "text-sky-600 dark:text-sky-400 bg-sky-500/10 border-sky-500/25";
    case "script":
      return "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/25";
    case "action":
      return "text-purple-600 dark:text-purple-400 bg-purple-500/10 border-purple-500/25";
    default:
      return "text-[var(--text-secondary)] bg-[var(--bg-surface-elevated)] border-[var(--border-default)]";
  }
}

function getEffectiveRuntimeInfo(
  task: TaskDefinition,
  projectRuntime?: ProjectRuntimeDefault,
): { parts: string[]; hasOverride: boolean } {
  const override = task.runtime;
  const hasOverride = Boolean(
    override && (override.type || override.model || override.reasoningEffort),
  );
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
  const parts = [effectiveType, effectiveModel, effectiveEffort].filter(Boolean) as string[];
  return { parts, hasOverride };
}

function TaskInfoPanel({
  task,
  projectRuntime,
}: {
  task: TaskDefinition;
  projectRuntime?: ProjectRuntimeDefault;
}) {
  const taskType = (task.type ?? "agent").toLowerCase();
  const isAgent = taskType === "agent";
  const runtimeInfo = getEffectiveRuntimeInfo(task, projectRuntime);

  return (
    <div className="flex-1 overflow-y-auto p-5 bg-[var(--bg-canvas)] select-text">
      <div className="w-full space-y-4">
        {/* Description */}
        <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] space-y-1.5">
          <div className="text-[10px] font-mono font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Description
          </div>
          <p className="text-xs text-[var(--text-primary)] leading-relaxed">
            {task.description || "No description provided."}
          </p>
        </div>

        {/* Task Configuration Grid */}
        <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
          <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] flex items-center justify-between">
            <span className="text-[10.5px] font-mono font-semibold uppercase tracking-wider text-[var(--text-primary)]">
              Task Configuration
            </span>
            <span
              title={task.filePath}
              className="text-[10.5px] font-mono text-[var(--text-muted)] inline-flex items-center gap-1"
            >
              <FileCode2 className="w-3 h-3" />
              <span>{task.filePath.split("/").pop()}</span>
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-[var(--border-subtle)] font-mono text-[11.5px]">
            <div className="p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Task ID</span>
                <span className="text-[var(--text-primary)] font-medium">{task.taskId}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Executor</span>
                <span
                  className={`text-[10px] uppercase px-1.5 py-0.5 rounded-[var(--radius-xs)] border ${taskTypeBadgeClass(taskType)}`}
                >
                  {taskType}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Schedule</span>
                <span className="text-[var(--text-primary)]">{task.cron}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Timezone</span>
                <span className="text-[var(--text-secondary)]">
                  {task.timezone || "System default"}
                </span>
              </div>
            </div>

            <div className="p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Status</span>
                <span
                  className={
                    task.enabled
                      ? "text-emerald-500 font-medium"
                      : "text-[var(--text-muted)]"
                  }
                >
                  {task.enabled ? "Enabled (Scheduled)" : "Disabled"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Next Run</span>
                <span className="text-[var(--text-secondary)]">
                  {task.nextRun ? formatDateTime(task.nextRun) : "-"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">Format</span>
                <span className="text-[var(--text-secondary)]">
                  {task.sourceFormat || "markdown"}
                </span>
              </div>
              {task.timeoutMs !== undefined && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--text-muted)]">Timeout</span>
                  <span className="text-[var(--text-secondary)]">
                    {formatDuration(task.timeoutMs)}
                  </span>
                </div>
              )}
              {isAgent && runtimeInfo.parts.length > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[var(--text-muted)]">Runtime</span>
                  <span
                    className={`truncate max-w-[200px] ${
                      runtimeInfo.hasOverride
                        ? "text-indigo-500 dark:text-indigo-400"
                        : "text-[var(--text-secondary)]"
                    }`}
                    title={runtimeInfo.parts.join(" · ")}
                  >
                    {runtimeInfo.parts.join(" · ")}
                    {!runtimeInfo.hasOverride ? " (default)" : ""}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Command / Action / Prompt Template Preview */}
        {task.command && (
          <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
            <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-mono font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Command
            </div>
            <pre className="p-4 bg-[var(--bg-code)] text-xs font-mono text-[var(--text-code)] overflow-x-auto whitespace-pre-wrap">
              {task.command}
            </pre>
          </div>
        )}

        {task.action && (
          <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
            <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-mono font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Action: {task.action}
            </div>
            <pre className="p-4 bg-[var(--bg-code)] text-xs font-mono text-[var(--text-code)] overflow-x-auto">
              {JSON.stringify(task.actionParams || {}, null, 2)}
            </pre>
          </div>
        )}

        {task.promptTemplate && (
          <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
            <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] text-[10.5px] font-mono font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Prompt Template
            </div>
            <pre className="p-4 bg-[var(--bg-code)] text-[11.5px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words leading-relaxed">
              {task.promptTemplate}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

const RUNS_PAGE_SIZE = 25;
const RUNS_SCROLL_PREFETCH_MARGIN = "0px 0px 180px 0px";

export function TasksView() {
  const activeProject = useCurrentProject();
  const activeProjectId = activeProject.projectId;
  const { taskId: activeTaskId = null, executionId: activeExecutionId = null } = useParams<{
    taskId?: string;
    executionId?: string;
  }>();
  const navigate = useNavigate();

  const openTask = useCallback(
    (taskId: string, executionId?: string | null) => {
      navigate(
        executionId
          ? generatePath(ROUTES.taskExecution, {
              projectId: activeProjectId,
              taskId,
              executionId,
            })
          : generatePath(ROUTES.task, { projectId: activeProjectId, taskId }),
      );
    },
    [activeProjectId, navigate],
  );

  const qc = useQueryClient();
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  const runsScrollRef = useRef<HTMLDivElement | null>(null);
  const runsSentinelRef = useRef<HTMLDivElement | null>(null);

  // Left Explorer filters
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "agent" | "ts" | "script" | "action">("all");

  // Right Runs panel filter (server-side filtered + cursor paginated)
  const [runStatusFilter, setRunStatusFilter] = useState<"all" | "success" | "failed">("all");

  const tasksQuery = useQuery({
    queryKey: queryKeys.tasks(activeProjectId),
    queryFn: () => tasksApi.listByProject(activeProjectId),
    enabled: Boolean(activeProjectId),
  });

  useEffect(() => {
    if (tasksQuery.error) {
      console.error("Failed to load project tasks:", tasksQuery.error);
      toast.error("加载项目任务失败");
    }
  }, [tasksQuery.error]);

  const tasks = tasksQuery.data ?? [];
  const loadingTasks = tasksQuery.isFetching;
  const loadTasks = useCallback(() => tasksQuery.refetch(), [tasksQuery]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((task) => {
      const tType = (task.type ?? "agent").toLowerCase();
      if (typeFilter !== "all" && tType !== typeFilter) return false;
      if (!q) return true;
      return (
        task.name.toLowerCase().includes(q) ||
        task.taskId.toLowerCase().includes(q) ||
        (task.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [tasks, searchQuery, typeFilter]);

  const selectedTask = useMemo(() => {
    if (activeTaskId) {
      const exact = tasks.find((t) => t.taskId === activeTaskId);
      if (exact) return exact;
    }
    return filteredTasks[0] ?? tasks[0] ?? null;
  }, [tasks, filteredTasks, activeTaskId]);

  const executionsQuery = useInfiniteQuery({
    queryKey: queryKeys.taskExecutionsFiltered(
      activeProjectId,
      selectedTask?.taskId ?? "",
      runStatusFilter,
    ),
    queryFn: ({ pageParam }) =>
      tasksApi.listExecutions({
        taskKey: selectedTask!.taskKey,
        status: runStatusFilter === "all" ? undefined : runStatusFilter,
        ...(pageParam !== undefined ? { beforeId: pageParam } : {}),
        limit: RUNS_PAGE_SIZE,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextBeforeId !== null ? lastPage.nextBeforeId : undefined,
    enabled: Boolean(activeProjectId && selectedTask),
  });

  const taskExecutions = useMemo(() => {
    const pages = executionsQuery.data?.pages ?? [];
    const seen = new Set<string>();
    const merged: TaskExecutionRecord[] = [];
    for (const page of pages) {
      for (const item of page.executions) {
        if (!seen.has(item.executionId)) {
          seen.add(item.executionId);
          merged.push(item);
        }
      }
    }
    return merged;
  }, [executionsQuery.data]);

  const hasMoreRuns = Boolean(executionsQuery.hasNextPage);
  const loadingExecutions = executionsQuery.isFetching && !executionsQuery.isFetchingNextPage;
  const loadingMoreRuns = executionsQuery.isFetchingNextPage;
  const isLoadingRuns = Boolean(selectedTask && executionsQuery.isPending);

  const loadTaskExecutions = useCallback(
    async (_taskId?: string, _status?: "all" | "success" | "failed") => {
      await executionsQuery.refetch();
    },
    [executionsQuery],
  );

  const loadMoreRuns = useCallback(async () => {
    if (!hasMoreRuns || loadingMoreRuns || loadingExecutions) return;
    await executionsQuery.fetchNextPage();
  }, [hasMoreRuns, loadingMoreRuns, loadingExecutions, executionsQuery]);

  useEffect(() => {
    if (runsScrollRef.current) {
      runsScrollRef.current.scrollTop = 0;
    }
  }, [selectedTask?.taskKey, runStatusFilter]);

  // Threshold-triggered infinite scroll: prefetch next page when within 180px of the bottom
  useEffect(() => {
    const root = runsScrollRef.current;
    const sentinel = runsSentinelRef.current;
    if (!root || !sentinel || !hasMoreRuns || loadingExecutions) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreRuns();
        }
      },
      {
        root,
        rootMargin: RUNS_SCROLL_PREFETCH_MARGIN,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [selectedTask?.taskKey, runStatusFilter, hasMoreRuns, loadingExecutions, loadMoreRuns]);

  // Consistent selection rule:
  // - Clicking a Task sets URL to /:projectId/tasks/:taskId (no executionId) -> ALWAYS shows Task Info!
  // - Clicking a Run in the right sidebar sets URL to /:projectId/tasks/:taskId/:executionId -> shows that Run!
  const selectedExecution = useMemo(() => {
    if (!activeExecutionId) return null;
    return taskExecutions.find((e) => e.executionId === activeExecutionId) ?? null;
  }, [taskExecutions, activeExecutionId]);

  const runTaskMutation = useMutation({
    mutationFn: (taskId: string) => tasksApi.run(activeProjectId, taskId),
    onSuccess: async (res, taskId) => {
      toast.success(`Task [${taskId}] triggered`, {
        description: res.message || "Execution started in background",
      });
      await qc.invalidateQueries({ queryKey: queryKeys.taskExecutions(activeProjectId, taskId) });
    },
    onError: (err: unknown) => {
      toast.error(`Trigger task failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  const handleRunNow = async (taskId: string) => {
    if (!activeProjectId || runningTaskId === taskId) return;
    setRunningTaskId(taskId);
    try {
      await runTaskMutation.mutateAsync(taskId);
    } catch {
      /* toast handled by onError */
    } finally {
      setRunningTaskId(null);
    }
  };

  const selectedTaskType = (selectedTask?.type ?? "agent").toLowerCase();
  const isSelectedAgent = selectedTaskType === "agent";
  const selectedRuntimeInfo = selectedTask
    ? getEffectiveRuntimeInfo(selectedTask, activeProject?.runtime)
    : null;

  return (
    <div className="flex-1 flex h-full w-full overflow-hidden bg-[var(--bg-canvas)] select-text">
      {/* 1. Left Column: Task Explorer (240px) */}
      <aside className="w-60 border-r border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col shrink-0 min-h-0 select-none">
        <div className="h-12 px-3 border-b border-[var(--border-default)] bg-[var(--bg-header)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-xs uppercase tracking-wider font-semibold text-[var(--text-primary)]">
              Tasks
            </span>
            <span className="text-[10.5px] font-mono text-[var(--text-muted)] px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] leading-none">
              {tasks.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void loadTasks()}
            disabled={loadingTasks}
            title="Refresh tasks"
            className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${loadingTasks ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="p-2.5 border-b border-[var(--border-subtle)] space-y-2 shrink-0">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter tasks..."
              className="w-full pl-8 pr-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-hidden focus:border-[var(--border-focus)] transition-colors"
            />
          </div>

          <div className="flex items-center gap-1 font-mono text-[10px]">
            {(["all", "agent", "ts", "script", "action"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTypeFilter(t)}
                className={`flex-1 py-0.5 rounded-[var(--radius-xs)] uppercase border transition-colors cursor-pointer ${
                  typeFilter === t
                    ? "bg-[var(--primary)] text-[var(--text-inverted)] border-[var(--primary)]"
                    : "bg-[var(--bg-canvas)] text-[var(--text-muted)] border-[var(--border-default)] hover:text-[var(--text-primary)]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
          {loadingTasks && tasks.length === 0 ? (
            <div className="py-12 flex items-center justify-center gap-2 text-xs font-mono text-[var(--text-muted)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Loading...</span>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="py-10 px-3 text-center text-[11px] font-mono text-[var(--text-muted)] space-y-1">
              <div>{tasks.length === 0 ? "No tasks configured" : "No matching tasks"}</div>
              {tasks.length === 0 && (
                <div className="text-[10px] opacity-70">projects/{activeProjectId}/tasks/</div>
              )}
            </div>
          ) : (
            filteredTasks.map((task) => {
              const isSelected = selectedTask?.taskId === task.taskId;
              const taskType = (task.type ?? "agent").toLowerCase();

              return (
                <button
                  key={task.taskKey}
                  type="button"
                  onClick={() => {
                    if (selectedTask?.taskId !== task.taskId) {
                      setRunStatusFilter("all");
                    }
                    openTask(task.taskId);
                  }}
                  className={`relative w-full text-left px-2.5 py-2 rounded-[var(--radius-sm)] border transition-all duration-150 cursor-pointer space-y-1.5 ${
                    isSelected
                      ? "bg-[var(--bg-surface-elevated)] border-[var(--border-strong)] text-[var(--text-primary)]"
                      : "bg-transparent border-transparent hover:bg-[var(--bg-surface-hover)]/70 text-[var(--text-secondary)]"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-[var(--primary)] transition-opacity duration-150 ${
                      isSelected ? "opacity-100" : "opacity-0"
                    }`}
                  />

                  <div className="flex items-center justify-between gap-1.5">
                    <span className="text-xs font-mono font-semibold truncate text-[var(--text-primary)]">
                      {task.name}
                    </span>
                    <span
                      title={task.enabled ? "Enabled (Scheduled)" : "Disabled"}
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        task.enabled ? "bg-emerald-500" : "bg-[var(--border-strong)]"
                      }`}
                    />
                  </div>

                  <div className="flex items-center gap-1.5 font-mono text-[10px] min-w-0">
                    <span
                      className={`uppercase px-1 py-0 rounded-[var(--radius-xs)] border shrink-0 leading-tight ${taskTypeBadgeClass(taskType)}`}
                    >
                      {taskType}
                    </span>
                    <span className="text-[var(--text-muted)] truncate">{task.cron}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* 2. Center Column: Main Canvas (Task Info by default, or Selected Run Output) */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {!selectedTask ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center font-mono">
            <div className="w-11 h-11 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-muted)]">
              <ListTodo className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--text-primary)]">
                No tasks in {activeProjectId}
              </div>
              <div className="text-xs text-[var(--text-muted)] max-w-sm">
                Add Markdown (<code className="text-[var(--text-secondary)]">tasks/*.md</code>) or
                TypeScript (<code className="text-[var(--text-secondary)]">tasks/*.ts</code>) task
                definitions to automate this project.
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Single Clean 48px Task Action Bar */}
            <div className="h-12 px-5 border-b border-[var(--border-default)] bg-[var(--bg-header)] flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-xs font-mono font-semibold text-[var(--text-primary)] truncate">
                  {selectedTask.name}
                </h2>

                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded-[var(--radius-xs)] border shrink-0 ${
                    selectedTask.enabled
                      ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                      : "text-[var(--text-muted)] bg-[var(--bg-surface-elevated)] border-[var(--border-default)]"
                  }`}
                >
                  {selectedTask.enabled ? "ENABLED" : "DISABLED"}
                </span>

                <span
                  className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded-[var(--radius-xs)] border shrink-0 ${taskTypeBadgeClass(selectedTaskType)}`}
                >
                  {selectedTaskType}
                </span>

                {isSelectedAgent && selectedRuntimeInfo && selectedRuntimeInfo.parts.length > 0 && (
                  <span
                    title={
                      selectedRuntimeInfo.hasOverride
                        ? `Task 自定义运行配置: ${selectedRuntimeInfo.parts.join(" · ")}`
                        : `跟随项目默认运行配置: ${selectedRuntimeInfo.parts.join(" · ")}`
                    }
                    className={`hidden xl:inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-[var(--radius-xs)] border truncate max-w-[240px] ${
                      selectedRuntimeInfo.hasOverride
                        ? "text-indigo-500 dark:text-indigo-400 bg-indigo-500/10 border-indigo-500/25"
                        : "text-[var(--text-secondary)] bg-[var(--bg-surface-elevated)] border-[var(--border-default)]"
                    }`}
                  >
                    <Cpu className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{selectedRuntimeInfo.parts.join(" · ")}</span>
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => void handleRunNow(selectedTask.taskId)}
                disabled={runningTaskId === selectedTask.taskId}
                className="px-3 py-1 rounded-[var(--radius-sm)] bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 active:scale-95 disabled:opacity-40 text-xs font-mono font-medium transition-all cursor-pointer inline-flex items-center gap-1.5 shrink-0"
              >
                {runningTaskId === selectedTask.taskId ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Play className="w-3 h-3 fill-current" />
                )}
                <span>{runningTaskId === selectedTask.taskId ? "Running..." : "Run Now"}</span>
              </button>
            </div>

            {/* Animated Center Content Driven Solely by Right Panel Selection */}
            <div className="flex-1 flex min-h-0 overflow-hidden relative">
              <AnimatePresence mode="wait" initial={false}>
                <m.div
                  key={`${selectedTask.taskKey}:${activeExecutionId ?? "info"}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15, ease: EASE_OUT_EXPO }}
                  className="flex-1 flex min-w-0 min-h-0 overflow-hidden"
                >
                  {!selectedExecution ? (
                    activeExecutionId && isLoadingRuns ? (
                      <div className="flex-1 flex items-center justify-center gap-2 text-xs font-mono text-[var(--text-muted)] animate-delayed-fade">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Loading run...</span>
                      </div>
                    ) : (
                      <TaskInfoPanel task={selectedTask} projectRuntime={activeProject?.runtime} />
                    )
                  ) : selectedExecution.sessionId ? (
                    <SessionConversation
                      sessionId={selectedExecution.sessionId}
                      readOnly
                      mode="embedded"
                      taskExecution={selectedExecution}
                    />
                  ) : (
                    <TaskExecutionDetail execution={selectedExecution} task={selectedTask} />
                  )}
                </m.div>
              </AnimatePresence>
            </div>
          </>
        )}
      </div>

      {/* 3. Right Column: Pinned Task Info + Execution History List (272px) */}
      {selectedTask && (
        <aside className="w-64 lg:w-72 border-l border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col shrink-0 min-h-0 select-none">
          {/* 48px Header aligned 1:1 with Left & Center */}
          <div className="h-12 px-3 border-b border-[var(--border-default)] bg-[var(--bg-header)] flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-xs uppercase tracking-wider font-semibold text-[var(--text-primary)]">
                Runs
              </span>
              <span className="text-[10.5px] font-mono text-[var(--text-muted)] px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] leading-none">
                {taskExecutions.length}
                {hasMoreRuns ? "+" : ""}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void loadTaskExecutions(selectedTask.taskId, runStatusFilter)}
              disabled={loadingExecutions}
              title="Refresh execution history"
              className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer disabled:opacity-50"
            >
              <RotateCw className={`w-3.5 h-3.5 ${loadingExecutions ? "animate-spin" : ""}`} />
            </button>
          </div>

          {/* Pinned Top Entry: Task Info (always returns center canvas to Task Configuration & Prompt) */}
          <div className="p-2 border-b border-[var(--border-default)] shrink-0">
            <button
              type="button"
              onClick={() => openTask(selectedTask.taskId)}
              className={`relative w-full text-left px-2.5 py-2 rounded-[var(--radius-sm)] border transition-all duration-150 cursor-pointer flex items-center justify-between gap-2 font-mono ${
                !selectedExecution
                  ? "bg-[var(--bg-surface-elevated)] border-[var(--border-strong)] text-[var(--text-primary)]"
                  : "bg-transparent border-transparent hover:bg-[var(--bg-surface-hover)]/70 text-[var(--text-secondary)]"
              }`}
            >
              <span
                className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-[var(--primary)] transition-opacity duration-150 ${
                  !selectedExecution ? "opacity-100" : "opacity-0"
                }`}
              />
              <div className="flex items-center gap-2 min-w-0">
                <FileCode2 className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">任务信息</div>
                  <div className="text-[10px] text-[var(--text-muted)] truncate">
                    配置 · 调度 · 模板
                  </div>
                </div>
              </div>
            </button>
          </div>

          {/* Run Status Filter */}
          <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 font-mono text-[10px] shrink-0">
            <span className="uppercase tracking-wider text-[var(--text-muted)]">
              运行记录 ({taskExecutions.length}
              {hasMoreRuns ? "+" : ""})
            </span>
            <div className="flex items-center gap-0.5">
              {(["all", "success", "failed"] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setRunStatusFilter(st)}
                  className={`px-1.5 py-0.5 rounded-[var(--radius-xs)] uppercase transition-colors cursor-pointer ${
                    runStatusFilter === st
                      ? "bg-[var(--primary)] text-[var(--text-inverted)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {st === "success" ? "ok" : st === "failed" ? "err" : "all"}
                </button>
              ))}
            </div>
          </div>

          {/* Scrollable Execution History with Threshold-Triggered Infinite Scroll */}
          <div ref={runsScrollRef} className="flex-1 overflow-y-auto p-1.5 space-y-1 font-mono">
            {isLoadingRuns && taskExecutions.length === 0 ? (
              <div className="py-10 flex items-center justify-center gap-2 text-xs text-[var(--text-muted)] animate-delayed-fade">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Loading runs...</span>
              </div>
            ) : taskExecutions.length === 0 ? (
              <div className="py-10 px-3 text-center text-[11px] text-[var(--text-muted)] space-y-1">
                <div>{runStatusFilter === "all" ? "暂无运行记录" : "无匹配状态的记录"}</div>
                {runStatusFilter === "all" && (
                  <div className="text-[10px] opacity-70">点击 Run Now 手动执行</div>
                )}
              </div>
            ) : (
              <>
                {taskExecutions.map((exec) => {
                  const isSelected = selectedExecution?.executionId === exec.executionId;
                  const isOk = exec.status === "success";
                  return (
                    <button
                      key={exec.executionId}
                      type="button"
                      onClick={() => openTask(selectedTask.taskId, exec.executionId)}
                      className={`relative w-full text-left px-2.5 py-2 rounded-[var(--radius-sm)] border transition-all duration-150 cursor-pointer space-y-1 ${
                        isSelected
                          ? "bg-[var(--bg-surface-elevated)] border-[var(--border-strong)] text-[var(--text-primary)]"
                          : "bg-transparent border-transparent hover:bg-[var(--bg-surface-hover)]/70 text-[var(--text-secondary)]"
                      }`}
                    >
                      <span
                        className={`absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-[var(--primary)] transition-opacity duration-150 ${
                          isSelected ? "opacity-100" : "opacity-0"
                        }`}
                      />

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              isOk ? "bg-emerald-500" : "bg-red-500"
                            }`}
                          />
                          <span
                            className={`text-[10.5px] font-semibold uppercase ${
                              isOk ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                            }`}
                          >
                            {exec.status}
                          </span>
                        </div>
                        <span className="text-[10px] text-[var(--text-muted)] inline-flex items-center gap-1 shrink-0">
                          <Clock className="w-2.5 h-2.5 opacity-70" />
                          <span>{formatDuration(exec.durationMs)}</span>
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                        <span className="truncate">
                          {exec.startedAt ? formatTimeAgo(exec.startedAt) : "-"}
                        </span>
                        <span className="inline-flex items-center gap-1 shrink-0 opacity-80">
                          {exec.sessionId ? (
                            <MessageSquare className="w-2.5 h-2.5 text-indigo-400" />
                          ) : (
                            <Terminal className="w-2.5 h-2.5 text-sky-400" />
                          )}
                          <span>{exec.executionId.slice(5, 13)}</span>
                        </span>
                      </div>
                    </button>
                  );
                })}

                {/* Infinite Scroll Sentinel / Loading / End-of-List Footer */}
                {hasMoreRuns ? (
                  <div ref={runsSentinelRef} className="py-2 flex items-center justify-center">
                    {loadingMoreRuns ? (
                      <span className="inline-flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>加载更多...</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void loadMoreRuns()}
                        className="px-2.5 py-1 rounded-[var(--radius-xs)] text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
                      >
                        加载更多记录
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="py-2 text-center text-[10px] text-[var(--text-muted)] opacity-60">
                    已加载全部 {taskExecutions.length} 条记录
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
