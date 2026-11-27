import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  Cpu,
  GitBranch,
  ListTodo,
  Loader2,
  MessageSquare,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Webhook,
  Workflow,
  Wrench,
} from "lucide-react";
import { generatePath, useNavigate } from "react-router";
import { toast } from "sonner";
import { pipelinesApi, projectsApi } from "../../api";
import { useCurrentProject } from "../../layouts/ProjectLayout";
import { queryKeys } from "../../queries";
import { ROUTES } from "../../routes";
import type { ProjectMetricsRange } from "../../types";
import { copyToClipboard } from "../../utils/clipboard";
import { formatDuration, formatTimeAgo, formatTokenCount } from "../../utils/formatters";

const ProjectMetricsCharts = lazy(() => import("../project/ProjectMetricsCharts"));

function detectBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formatCountdown(iso: string): string {
  const diffMs = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diffMs)) return "-";
  if (diffMs <= 0) return "即将触发";
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `${mins}m 后`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m 后` : `${hours}h 后`;
}

interface ToolParamInfo {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

function extractToolParams(inputSchema: Record<string, unknown>): ToolParamInfo[] {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const requiredSet = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const prop = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    let type = "any";
    if (typeof prop.type === "string") {
      type = prop.type;
    } else if (Array.isArray(prop.type)) {
      type = prop.type.filter((item): item is string => typeof item === "string").join(" | ");
    } else if (Array.isArray(prop.enum)) {
      type = prop.enum.map((v) => JSON.stringify(v)).join(" | ");
    } else if (Array.isArray(prop.anyOf)) {
      type = "union";
    }
    return {
      name,
      type,
      required: requiredSet.has(name),
      description: typeof prop.description === "string" ? prop.description : undefined,
    };
  });
}

export function ProjectInfoView() {
  const activeProject = useCurrentProject();
  const activeProjectId = activeProject.projectId;
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [range, setRange] = useState<ProjectMetricsRange>("7d");
  const [sseConnected, setSseConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedRepo, setCopiedRepo] = useState(false);
  const [copiedHookId, setCopiedHookId] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const sseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tz = useMemo(() => detectBrowserTimeZone(), []);

  const overviewQuery = useQuery({
    queryKey: queryKeys.projectOverview(activeProjectId),
    queryFn: () => projectsApi.getOverview(activeProjectId),
    enabled: Boolean(activeProjectId),
    staleTime: 3_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const metricsQuery = useQuery({
    queryKey: queryKeys.projectMetrics(activeProjectId, range, tz),
    queryFn: () => projectsApi.getMetrics(activeProjectId, { range, tz }),
    enabled: Boolean(activeProjectId),
    staleTime: 60_000,
  });

  const skillsQuery = useQuery({
    queryKey: queryKeys.projectSkills(activeProjectId),
    queryFn: () => projectsApi.listSkills(activeProjectId),
    enabled: Boolean(activeProjectId),
    staleTime: 60_000,
  });

  const toolsQuery = useQuery({
    queryKey: queryKeys.projectTools(activeProjectId),
    queryFn: () => projectsApi.listTools(activeProjectId),
    enabled: Boolean(activeProjectId),
    staleTime: 60_000,
  });

  const hooksQuery = useQuery({
    queryKey: queryKeys.projectHooks(activeProjectId),
    queryFn: () => projectsApi.listHooks(activeProjectId),
    enabled: Boolean(activeProjectId),
    staleTime: 60_000,
  });

  // Subscribe to project pipeline SSE to refresh live overview promptly on stage transitions
  useEffect(() => {
    if (!activeProjectId) return;
    const unsubscribe = pipelinesApi.subscribeEvents(
      activeProjectId,
      () => {
        if (sseTimerRef.current) clearTimeout(sseTimerRef.current);
        sseTimerRef.current = setTimeout(() => {
          void qc.invalidateQueries({ queryKey: queryKeys.projectOverview(activeProjectId) });
        }, 400);
      },
      undefined,
      setSseConnected,
    );
    return () => {
      if (sseTimerRef.current) clearTimeout(sseTimerRef.current);
      unsubscribe();
    };
  }, [activeProjectId, qc]);

  const handleManualRefresh = useCallback(async () => {
    if (!activeProjectId || refreshing) return;
    setRefreshing(true);
    try {
      const [freshOverview, freshMetrics] = await Promise.all([
        projectsApi.getOverview(activeProjectId, { refresh: true }),
        projectsApi.getMetrics(activeProjectId, { range, tz, refresh: true }),
      ]);
      qc.setQueryData(queryKeys.projectOverview(activeProjectId), freshOverview);
      qc.setQueryData(queryKeys.projectMetrics(activeProjectId, range, tz), freshMetrics);
      void qc.invalidateQueries({ queryKey: queryKeys.projectSkills(activeProjectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.projectTools(activeProjectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.projectHooks(activeProjectId) });
    } catch (err: unknown) {
      toast.error(`刷新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefreshing(false);
    }
  }, [activeProjectId, range, tz, refreshing, qc]);

  const handleCopyRepo = async () => {
    if (!activeProject?.repository) return;
    const ok = await copyToClipboard(activeProject.repository);
    if (ok) {
      setCopiedRepo(true);
      setTimeout(() => setCopiedRepo(false), 1600);
      toast.success("已复制仓库地址");
    }
  };

  const handleCopyHookUrl = async (hookId: string, hookPath: string) => {
    const fullUrl = `${window.location.origin}${hookPath}`;
    const ok = await copyToClipboard(fullUrl);
    if (ok) {
      setCopiedHookId(hookId);
      setTimeout(() => setCopiedHookId((prev) => (prev === hookId ? null : prev)), 1600);
      toast.success("已复制 Hook 回调地址");
    }
  };

  const overview = overviewQuery.data;
  const metrics = metricsQuery.data;
  const skills = skillsQuery.data ?? [];
  const loadingSkills = skillsQuery.isPending;
  const tools = toolsQuery.data ?? [];
  const loadingTools = toolsQuery.isPending;
  const hooks = hooksQuery.data ?? [];
  const loadingHooks = hooksQuery.isPending;

  const toggleToolParams = (toolName: string) => {
    setExpandedTools((prev) => ({ ...prev, [toolName]: !prev[toolName] }));
  };

  const runtimeParts = [
    activeProject.runtime?.type,
    activeProject.runtime?.model,
    activeProject.runtime?.reasoningEffort,
  ].filter(Boolean) as string[];

  const attentionCount =
    (overview?.attention.waitingConfirmations.length ?? 0) +
    (overview?.attention.failedPipelineRuns.length ?? 0) +
    (overview?.attention.failedTaskExecutions.length ?? 0);

  const liveCount =
    (overview?.live.activePipelineNodes.length ?? 0) +
    (overview?.live.activeSessions.length ?? 0) +
    (overview?.live.upcomingJobs.length ?? 0);

  const runningPipelines = (overview?.pipelines.running ?? 0) + (overview?.pipelines.waiting ?? 0);

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[var(--bg-canvas)] select-text">
      {/* Project Overview Header */}
      <div className="px-6 py-5 border-b border-[var(--border-default)] bg-[var(--bg-header)] shrink-0">
        <div className="max-w-6xl mx-auto flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-[var(--text-primary)]">
                {activeProject?.displayName || activeProjectId || "Project Overview"}
              </h1>
              <span className="px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-[11px] text-[var(--text-muted)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)]">
                {activeProjectId}
              </span>
              {runtimeParts.length > 0 && (
                <span
                  title={`默认运行配置: ${runtimeParts.join(" · ")}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-[11px] text-[var(--text-secondary)] bg-[var(--bg-surface)] border border-[var(--border-default)]"
                >
                  <Cpu className="w-3 h-3 text-[var(--text-muted)]" />
                  <span>{runtimeParts.join(" · ")}</span>
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-2xl">
              {activeProject?.summary || "No project description provided."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {/* Range Selector */}
            <div className="inline-flex items-center p-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-default)] font-mono text-[11px]">
              {(["7d", "14d", "30d"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`px-2 py-1 rounded-[var(--radius-xs)] transition-colors cursor-pointer ${
                    range === r
                      ? "bg-[var(--primary)] text-[var(--text-inverted)] font-medium"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>

            {/* Live Indicator + Manual Refresh */}
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-default)] font-mono text-[11px] text-[var(--text-muted)]">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  sseConnected ? "bg-emerald-500 animate-pulse" : "bg-amber-400"
                }`}
              />
              <span>Live</span>
              {overview?.generatedAt && (
                <span className="hidden sm:inline opacity-75">
                  · {formatTimeAgo(overview.generatedAt)}
                </span>
              )}
              <button
                type="button"
                onClick={() => void handleManualRefresh()}
                disabled={refreshing}
                title="立即刷新实时数据与统计图表"
                className="ml-0.5 p-0.5 rounded hover:bg-[var(--bg-surface-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer disabled:opacity-50"
              >
                <RotateCw
                  className={`w-3 h-3 ${
                    refreshing || overviewQuery.isFetching || metricsQuery.isFetching
                      ? "animate-spin"
                      : ""
                  }`}
                />
              </button>
            </div>

            <button
              type="button"
              onClick={() => navigate(generatePath(ROUTES.sessions, { projectId: activeProjectId }))}
              className="px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 transition-opacity cursor-pointer inline-flex items-center gap-1.5"
            >
              <span>View Sessions</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Dashboard Body */}
      <div className="max-w-6xl mx-auto w-full px-6 py-6 space-y-4">
        {/* 1. Real-time KPI Overview Row (4 Cards) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Sessions */}
          <button
            type="button"
            onClick={() => navigate(generatePath(ROUTES.sessions, { projectId: activeProjectId }))}
            className="group text-left p-4 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)] transition-colors cursor-pointer space-y-2.5"
          >
            <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5" />
                Sessions
              </span>
              <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold font-mono tabular-nums text-[var(--text-primary)]">
                {overview ? overview.sessions.active : "-"}
              </span>
              <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400">
                active
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
              <span>
                {overview ? `${overview.sessions.idle} idle · ${overview.sessions.total} total` : "加载中..."}
              </span>
              {metrics && <span>{metrics.summary.turnCount} turns</span>}
            </div>
          </button>

          {/* Card 2: Pipelines */}
          <button
            type="button"
            onClick={() => navigate(generatePath(ROUTES.pipelines, { projectId: activeProjectId }))}
            className="group text-left p-4 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)] transition-colors cursor-pointer space-y-2.5"
          >
            <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <Workflow className="w-3.5 h-3.5" />
                Pipelines
              </span>
              <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono tabular-nums text-[var(--text-primary)]">
                  {overview ? runningPipelines : "-"}
                </span>
                <span className="text-xs font-mono text-[var(--text-secondary)]">running</span>
              </div>
              {overview && overview.pipelines.waitingConfirmation > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono font-medium bg-violet-500/12 text-violet-700 dark:text-violet-300 border border-violet-500/25">
                  <ShieldCheck className="w-2.5 h-2.5" />
                  {overview.pipelines.waitingConfirmation} 待确认
                </span>
              )}
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
              <span>
                {metrics
                  ? `${range}: ${metrics.summary.pipelineCompleted} 完成`
                  : "加载中..."}
              </span>
              {metrics && metrics.summary.pipelineFailed > 0 ? (
                <span className="text-red-600 dark:text-red-400">
                  {metrics.summary.pipelineFailed} 失败
                </span>
              ) : (
                <span>{overview ? `${overview.pipelines.total} total` : ""}</span>
              )}
            </div>
          </button>

          {/* Card 3: Tasks */}
          <button
            type="button"
            onClick={() => navigate(generatePath(ROUTES.tasks, { projectId: activeProjectId }))}
            className="group text-left p-4 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)] transition-colors cursor-pointer space-y-2.5"
          >
            <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <ListTodo className="w-3.5 h-3.5" />
                Tasks ({range})
              </span>
              <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold font-mono tabular-nums text-[var(--text-primary)]">
                {metrics
                  ? metrics.summary.taskSuccessRate !== null
                    ? `${metrics.summary.taskSuccessRate}%`
                    : "-"
                  : "-"}
              </span>
              <span className="text-xs font-mono text-[var(--text-secondary)]">
                {metrics?.summary.taskSuccessRate !== null ? "success" : "no runs"}
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
              <span>
                {overview ? `${overview.tasks.enabled}/${overview.tasks.total} enabled` : "加载中..."}
              </span>
              {metrics && (
                <span
                  className={
                    metrics.summary.taskFailed > 0 ? "text-red-600 dark:text-red-400" : ""
                  }
                >
                  {metrics.summary.taskTotal} 次
                  {metrics.summary.taskFailed > 0 ? ` · ${metrics.summary.taskFailed} 失败` : ""}
                </span>
              )}
            </div>
          </button>

          {/* Card 4: Token Usage */}
          <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] space-y-2.5">
            <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                Token Usage ({range})
              </span>
              {metrics?.summary.cacheHitRate !== null && metrics?.summary.cacheHitRate !== undefined && (
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                  Hit {metrics.summary.cacheHitRate}%
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold font-mono tabular-nums text-[var(--text-primary)]">
                {metrics ? formatTokenCount(metrics.summary.totalTokens) : "-"}
              </span>
              <span className="text-xs font-mono text-[var(--text-secondary)]">tokens</span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)] truncate">
              {metrics ? (
                <span className="truncate">
                  In {formatTokenCount(metrics.summary.inputTokens)} · Cache{" "}
                  {formatTokenCount(metrics.summary.cacheReadTokens)} · Out{" "}
                  {formatTokenCount(metrics.summary.outputTokens)}
                </span>
              ) : (
                <span>加载中...</span>
              )}
            </div>
          </div>
        </div>

        {/* 2. Needs Attention & Live Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left: Needs Attention */}
          <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle
                  className={`w-3.5 h-3.5 ${
                    attentionCount > 0 ? "text-amber-500" : "text-emerald-500"
                  }`}
                />
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">
                  需要关注 ({attentionCount})
                </span>
              </div>
              <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                待审批 & 近 7 天失败
              </span>
            </div>

            {overviewQuery.isPending ? (
              <div className="p-6 flex items-center justify-center gap-2 text-xs font-mono text-[var(--text-muted)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>检查项目健康状态...</span>
              </div>
            ) : attentionCount === 0 ? (
              <div className="px-4 py-5 flex items-center gap-2.5 text-xs font-mono text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>当前运行健康，无待审批流水线或近期失败记录</span>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)]">
                {overview?.attention.waitingConfirmations.map((run) => (
                  <button
                    key={`confirm:${run.runId}`}
                    type="button"
                    onClick={() =>
                      navigate(
                        generatePath(ROUTES.pipelineRun, {
                          projectId: activeProjectId,
                          pipelineId: run.pipelineId,
                          runId: run.runId,
                        }),
                      )
                    }
                    className="w-full text-left px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-mono font-medium bg-violet-500/12 text-violet-700 dark:text-violet-300 border border-violet-500/25 shrink-0">
                          待审批
                        </span>
                        <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {run.title}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">
                        {run.pipelineId} · 节点 {run.currentNodeId} · {formatTimeAgo(run.updatedAt)}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-violet-600 dark:text-violet-400 shrink-0 inline-flex items-center gap-1">
                      审批
                      <ArrowRight className="w-3 h-3" />
                    </span>
                  </button>
                ))}

                {overview?.attention.failedPipelineRuns.map((run) => (
                  <button
                    key={`fail-run:${run.runId}`}
                    type="button"
                    onClick={() =>
                      navigate(
                        generatePath(ROUTES.pipelineRun, {
                          projectId: activeProjectId,
                          pipelineId: run.pipelineId,
                          runId: run.runId,
                        }),
                      )
                    }
                    className="w-full text-left px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-mono font-medium bg-red-500/12 text-red-600 dark:text-red-400 border border-red-500/25 shrink-0">
                          流水线失败
                        </span>
                        <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {run.title}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">
                        {run.statusSummary || `${run.pipelineId} · ${run.currentNodeId}`} ·{" "}
                        {formatTimeAgo(run.updatedAt)}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-[var(--text-secondary)] shrink-0 inline-flex items-center gap-1">
                      查看
                      <ArrowRight className="w-3 h-3" />
                    </span>
                  </button>
                ))}

                {overview?.attention.failedTaskExecutions.map((exec) => (
                  <button
                    key={`fail-task:${exec.executionId}`}
                    type="button"
                    onClick={() =>
                      navigate(
                        generatePath(ROUTES.taskExecution, {
                          projectId: activeProjectId,
                          taskId: exec.taskId,
                          executionId: exec.executionId,
                        }),
                      )
                    }
                    className="w-full text-left px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-mono font-medium bg-red-500/12 text-red-600 dark:text-red-400 border border-red-500/25 shrink-0">
                          任务失败
                        </span>
                        <span className="text-xs font-mono font-medium text-[var(--text-primary)] truncate">
                          {exec.taskId}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">
                        {exec.errorMessage || exec.status}
                        {exec.startedAt ? ` · ${formatTimeAgo(exec.startedAt)}` : ""}
                        {exec.durationMs !== undefined ? ` · ${formatDuration(exec.durationMs)}` : ""}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-[var(--text-secondary)] shrink-0 inline-flex items-center gap-1">
                      日志
                      <ArrowRight className="w-3 h-3" />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Right: Live Activity & Upcoming Jobs */}
          <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 border-b border-[var(--border-default)] bg-[var(--bg-table-header)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">
                  实时进行中 / 即将触发
                </span>
              </div>
              {overview && overview.scheduledJobs.pending > 0 && (
                <button
                  type="button"
                  onClick={() => navigate(generatePath(ROUTES.jobs, { projectId: activeProjectId }))}
                  className="font-mono text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  {overview.scheduledJobs.pending} pending jobs →
                </button>
              )}
            </div>

            {overviewQuery.isPending ? (
              <div className="p-6 flex items-center justify-center gap-2 text-xs font-mono text-[var(--text-muted)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>加载实时动态...</span>
              </div>
            ) : liveCount === 0 ? (
              <div className="px-4 py-5 flex items-center gap-2.5 text-xs font-mono text-[var(--text-muted)]">
                <Clock className="w-4 h-4 opacity-50 shrink-0" />
                <span>当前无正在运行的会话、流水线节点或待触发定时任务</span>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)]">
                {overview?.live.activePipelineNodes.map((node) => (
                  <button
                    key={`node:${node.nodeRunId}`}
                    type="button"
                    onClick={() =>
                      navigate(
                        generatePath(ROUTES.pipelineRun, {
                          projectId: activeProjectId,
                          pipelineId: node.pipelineId,
                          runId: node.runId,
                        }),
                      )
                    }
                    className="w-full text-left px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            node.status === "running"
                              ? "bg-emerald-500 animate-pulse"
                              : "bg-amber-500"
                          }`}
                        />
                        <span className="px-1.5 py-0 rounded-[var(--radius-xs)] text-[10px] font-mono bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 shrink-0">
                          Pipeline
                        </span>
                        <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {node.runTitle || node.pipelineId}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[var(--text-muted)] truncate pl-3.5">
                        节点 {node.nodeId} ({node.executorType}) · {node.status}
                        {node.startedAt ? ` · ${formatTimeAgo(node.startedAt)}` : ""}
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                  </button>
                ))}

                {overview?.live.activeSessions.map((sess) => (
                  <button
                    key={`sess:${sess.sessionId}`}
                    type="button"
                    onClick={() =>
                      navigate(
                        generatePath(ROUTES.session, {
                          projectId: activeProjectId,
                          sessionId: sess.sessionId,
                        }),
                      )
                    }
                    className="w-full text-left px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                        <span className="px-1.5 py-0 rounded-[var(--radius-xs)] text-[10px] font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                          Session
                        </span>
                        <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {sess.title || sess.sessionId.slice(0, 16)}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[var(--text-muted)] truncate pl-3.5">
                        {[sess.runtime, sess.model, formatTimeAgo(sess.lastActiveAt)]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                  </button>
                ))}

                {overview?.live.upcomingJobs.map((job) => (
                  <button
                    key={`job:${job.jobId}`}
                    type="button"
                    onClick={() => navigate(generatePath(ROUTES.jobs, { projectId: activeProjectId }))}
                    className="w-full text-left px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <Clock className="w-3 h-3 text-amber-500 shrink-0" />
                        <span className="px-1.5 py-0 rounded-[var(--radius-xs)] text-[10px] font-mono bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 shrink-0">
                          Job
                        </span>
                        <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {job.name}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[var(--text-muted)] truncate pl-5">
                        {formatCountdown(job.triggerAt)}
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* 3. ECharts Visual Analytics (Lazy-loaded separate bundle) */}
        {metrics ? (
          <Suspense
            fallback={
              <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] h-[280px] flex items-center justify-center gap-2 text-xs font-mono text-[var(--text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>加载统计图表...</span>
              </div>
            }
          >
            <ProjectMetricsCharts metrics={metrics} />
          </Suspense>
        ) : metricsQuery.isPending ? (
          <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] h-[260px] flex items-center justify-center gap-2 text-xs font-mono text-[var(--text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>正在聚合近 {range} 运行指标...</span>
          </div>
        ) : null}

        {/* 4. Compact Project Specification & Loaded Skills */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Project Specification */}
          <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden">
            <div className="px-4 py-2.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] text-[11px] font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
              Project Specification
            </div>
            <div className="p-4 space-y-3.5">
              <div>
                <span className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                  Git Repository
                </span>
                <div className="mt-1.5 flex items-center gap-1.5">
                  {activeProject?.repository ? (
                    <>
                      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-xs)] font-mono text-xs bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-primary)] break-all">
                        <GitBranch className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                        {activeProject.repository}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopyRepo()}
                        title="复制仓库地址"
                        className="p-1.5 rounded-[var(--radius-xs)] border border-[var(--border-default)] bg-[var(--bg-canvas)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer shrink-0"
                      >
                        {copiedRepo ? (
                          <Check className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">None configured</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <span className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                    Default Runtime
                  </span>
                  <span className="mt-1 font-mono text-xs text-[var(--text-primary)] block">
                    {runtimeParts.length > 0 ? runtimeParts.join(" · ") : "System default"}
                  </span>
                </div>
                <div>
                  <span className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                    Configuration Dir
                  </span>
                  <span className="mt-1 font-mono text-xs text-[var(--text-secondary)] block truncate">
                    projects/{activeProjectId}
                  </span>
                </div>
              </div>

              <div>
                <span className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                  Routing Keywords
                </span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {activeProject?.keywords && activeProject.keywords.length > 0 ? (
                    activeProject.keywords.map((kw) => (
                      <span
                        key={kw}
                        className="px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-[11px] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)]"
                      >
                        #{kw}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">No keywords defined</span>
                  )}
                </div>
              </div>

              <div>
                <span className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                  Routing Hints
                </span>
                <span className="mt-1 text-xs text-[var(--text-secondary)] block leading-relaxed">
                  {activeProject?.routingHints?.join(", ") || "Standard multi-project routing"}
                </span>
              </div>
            </div>
          </section>

          {/* Loaded Skills */}
          <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
                Loaded Skills ({skills.length})
              </span>
              <span className="text-[10.5px] text-[var(--text-muted)] font-mono">.skills/*</span>
            </div>

            {loadingSkills ? (
              <div className="p-6 text-center text-xs text-[var(--text-muted)] font-mono">
                Scanning project skills...
              </div>
            ) : skills.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--text-muted)] font-mono">
                No custom skills detected in this project's .skills directory.
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)] max-h-[300px] overflow-y-auto">
                {skills.map((skill) => (
                  <div
                    key={skill.id}
                    className="px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Wrench className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                        <span className="font-semibold text-xs text-[var(--text-primary)] font-mono truncate">
                          {skill.name || skill.id}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-muted)] shrink-0">
                          {skill.id}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-2">
                      {skill.description || "No description in SKILL.md"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* 5. Loaded Project Custom Tools & HTTP Hooks */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Loaded Tools */}
          <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
                Loaded Tools ({tools.length})
              </span>
              <span className="text-[10.5px] text-[var(--text-muted)] font-mono">tools/*</span>
            </div>

            {loadingTools ? (
              <div className="p-6 text-center text-xs text-[var(--text-muted)] font-mono">
                Scanning project tools...
              </div>
            ) : tools.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--text-muted)] font-mono">
                No custom tools detected in this project's tools/ directory.
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)] max-h-[340px] overflow-y-auto">
                {tools.map((tool) => {
                  const params = extractToolParams(tool.inputSchema);
                  const isExpanded = Boolean(expandedTools[tool.name]);
                  return (
                    <div
                      key={tool.name}
                      className="px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors flex flex-col gap-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                          <Code2 className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                          <span className="font-semibold text-xs text-[var(--text-primary)] font-mono truncate">
                            {tool.name}
                          </span>
                          {tool.overridesBuiltin && (
                            <span
                              title="Overrides a built-in tool with the same name"
                              className="text-[10px] font-mono px-1.5 py-0 rounded-[var(--radius-xs)] bg-amber-500/10 border border-amber-500/30 text-amber-500 shrink-0"
                            >
                              override
                            </span>
                          )}
                        </div>

                        {params.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleToolParams(tool.name)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[10.5px] font-mono text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-elevated)] transition-colors cursor-pointer shrink-0"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                            <span>
                              {params.length} {params.length === 1 ? "param" : "params"}
                            </span>
                          </button>
                        ) : (
                          <span className="text-[10.5px] font-mono text-[var(--text-muted)] shrink-0">
                            no params
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                        {tool.description}
                      </p>

                      {isExpanded && params.length > 0 && (
                        <div className="mt-1 pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                          {params.map((param) => (
                            <div key={param.name} className="text-[11px] leading-relaxed">
                              <div className="flex items-center gap-1.5 flex-wrap font-mono">
                                <span className="text-[var(--text-primary)] font-medium">
                                  {param.name}
                                </span>
                                <span className="text-[var(--text-muted)]">{param.type}</span>
                                {param.required && (
                                  <span className="text-[9.5px] uppercase px-1 py-0 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                                    required
                                  </span>
                                )}
                              </div>
                              {param.description && (
                                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                                  {param.description}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Loaded Hooks */}
          <section className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] overflow-hidden flex flex-col">
            <div className="px-4 py-2.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
                Loaded Hooks ({hooks.length})
              </span>
              <span className="text-[10.5px] text-[var(--text-muted)] font-mono">hooks/*</span>
            </div>

            {loadingHooks ? (
              <div className="p-6 text-center text-xs text-[var(--text-muted)] font-mono">
                Scanning project hooks...
              </div>
            ) : hooks.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--text-muted)] font-mono">
                No HTTP hooks detected in this project's hooks/ directory.
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)] max-h-[340px] overflow-y-auto">
                {hooks.map((hook) => (
                  <div
                    key={hook.id}
                    className="px-4 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Webhook className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                        <span className="font-semibold text-xs text-[var(--text-primary)] truncate">
                          {hook.name}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-muted)] shrink-0">
                          {hook.id}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-[11px] bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-primary)] break-all">
                        {hook.path}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopyHookUrl(hook.id, hook.path)}
                        title="复制完整回调地址"
                        className="p-1 rounded-[var(--radius-xs)] border border-[var(--border-default)] bg-[var(--bg-canvas)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer shrink-0"
                      >
                        {copiedHookId === hook.id ? (
                          <Check className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>

                    {hook.description && (
                      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                        {hook.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
