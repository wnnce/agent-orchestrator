import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, m } from "motion/react";
import { generatePath, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  GitBranch,
  Hash,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, pipelinesApi } from "../../api";
import { useCurrentProject } from "../../layouts/ProjectLayout";
import { queryKeys } from "../../queries";
import { ROUTES } from "../../routes";
import type {
  PipelineNodeExecutorType,
  PipelineNodeSnapshot,
  PipelineRunRecord,
} from "../../types";
import { formatDateTime, formatTimeAgo } from "../../utils/formatters";
import { EASE_OUT_EXPO } from "../../utils/motion";
import { EmptyState } from "../common/EmptyState";
import { NewPipelineRunModal } from "../pipeline/NewPipelineRunModal";
import {
  getExecutorStyle,
  getPipelineStatusStyle,
  isTerminalRunStatus,
} from "../pipeline/pipelineStatus";

type StatusFilter = "all" | "active" | "attention" | "done";

const PAGE_LIMIT = 60;

function getExecutorDotColor(executor: PipelineNodeExecutorType): string {
  switch (executor) {
    case "agent":
      return "bg-blue-500";
    case "ts":
      return "bg-cyan-500";
    case "human":
      return "bg-violet-500";
    case "terminal":
      return "bg-emerald-500";
    default:
      return "bg-neutral-500";
  }
}

export function PipelinesView() {
  const project = useCurrentProject();
  const { pipelineId: routePipelineId } = useParams<{ pipelineId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sseConnected, setSseConnected] = useState(false);
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [pipelineDropdownOpen, setPipelineDropdownOpen] = useState(false);
  const [versionDropdownOpen, setVersionDropdownOpen] = useState(false);

  const pipelineDropdownRef = useRef<HTMLDivElement>(null);
  const versionDropdownRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!pipelineDropdownOpen && !versionDropdownOpen) return;
    function handleOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (pipelineDropdownRef.current && !pipelineDropdownRef.current.contains(target)) {
        setPipelineDropdownOpen(false);
      }
      if (versionDropdownRef.current && !versionDropdownRef.current.contains(target)) {
        setVersionDropdownOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setPipelineDropdownOpen(false);
        setVersionDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pipelineDropdownOpen, versionDropdownOpen]);

  const pipelinesQuery = useQuery({
    queryKey: queryKeys.pipelines(project.projectId),
    queryFn: () => pipelinesApi.listPipelines(project.projectId),
  });

  const pipelines = pipelinesQuery.data ?? [];
  const loadingPipelines = pipelinesQuery.isPending;
  const pipelinesError = pipelinesQuery.error
    ? pipelinesQuery.error instanceof ApiError
      ? pipelinesQuery.error.message
      : pipelinesQuery.error instanceof Error
        ? pipelinesQuery.error.message
        : "Failed to load pipelines"
    : null;

  const activePipeline = useMemo(() => {
    if (pipelines.length === 0) return null;
    if (routePipelineId) {
      return pipelines.find((p) => p.id === routePipelineId) ?? pipelines[0] ?? null;
    }
    return pipelines[0] ?? null;
  }, [pipelines, routePipelineId]);

  const effectivePipelineId = activePipeline?.id;

  const urlVersion = useMemo(() => {
    const raw = searchParams.get("version");
    return raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  }, [searchParams]);

  const selectedVersion = useMemo(() => {
    if (!activePipeline) return null;
    if (
      urlVersion !== null &&
      (urlVersion === activePipeline.currentVersion ||
        activePipeline.activeVersions.some((v) => v.version === urlVersion))
    ) {
      return urlVersion;
    }
    return activePipeline.currentVersion;
  }, [activePipeline, urlVersion]);

  const handleSelectVersion = useCallback(
    (version: number) => {
      setVersionDropdownOpen(false);
      const next = new URLSearchParams(searchParams);
      if (activePipeline && version === activePipeline.currentVersion) {
        next.delete("version");
      } else {
        next.set("version", String(version));
      }
      setSearchParams(next, { replace: true });
    },
    [activePipeline, searchParams, setSearchParams],
  );

  // Redirect /:projectId/pipelines to /:projectId/pipelines/:firstId once loaded
  useEffect(() => {
    if (loadingPipelines || pipelines.length === 0) return;
    if (!routePipelineId) {
      navigate(
        generatePath(ROUTES.pipeline, {
          projectId: project.projectId,
          pipelineId: pipelines[0].id,
        }),
        { replace: true },
      );
    }
  }, [loadingPipelines, pipelines, routePipelineId, navigate, project.projectId]);

  const runsQuery = useInfiniteQuery({
    queryKey: queryKeys.pipelineRuns(
      project.projectId,
      effectivePipelineId ?? "",
      selectedVersion ?? 0,
    ),
    queryFn: ({ pageParam }) =>
      pipelinesApi.listRuns(project.projectId, effectivePipelineId!, {
        version: selectedVersion!,
        limit: PAGE_LIMIT,
        ...(pageParam !== undefined ? { beforeId: pageParam } : {}),
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => {
      if (lastPage.length < PAGE_LIMIT) return undefined;
      return lastPage.reduce<number | undefined>((acc, r) => {
        if (typeof r.id !== "number") return acc;
        return acc === undefined ? r.id : Math.min(acc, r.id);
      }, undefined);
    },
    enabled: Boolean(effectivePipelineId && selectedVersion !== null),
  });

  useEffect(() => {
    if (runsQuery.error) {
      const msg =
        runsQuery.error instanceof ApiError
          ? runsQuery.error.message
          : runsQuery.error instanceof Error
            ? runsQuery.error.message
            : "Failed to load pipeline runs";
      toast.error(msg);
    }
  }, [runsQuery.error]);

  const runs = useMemo(() => {
    const pages = runsQuery.data?.pages ?? [];
    const seen = new Set<string>();
    const merged: PipelineRunRecord[] = [];
    for (const page of pages) {
      for (const r of page) {
        if (!seen.has(r.runId)) {
          seen.add(r.runId);
          merged.push(r);
        }
      }
    }
    return merged;
  }, [runsQuery.data]);

  const loadingRuns = runsQuery.isFetching && !runsQuery.isFetchingNextPage;
  const loadingMore = runsQuery.isFetchingNextPage;
  const hasMore = Boolean(runsQuery.hasNextPage);

  const loadPipelines = useCallback(() => pipelinesQuery.refetch(), [pipelinesQuery]);
  const loadRuns = useCallback(() => runsQuery.refetch(), [runsQuery]);

  const handleLoadMore = async () => {
    if (!hasMore || loadingMore) return;
    await runsQuery.fetchNextPage();
  };

  // Real-time SSE updates for this project's pipeline
  useEffect(() => {
    if (!effectivePipelineId) return;
    const unsubscribe = pipelinesApi.subscribeEvents(
      project.projectId,
      () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          void qc.invalidateQueries({
            queryKey: queryKeys.pipelineRunsScope(project.projectId, effectivePipelineId),
          });
          void qc.invalidateQueries({ queryKey: queryKeys.pipelines(project.projectId) });
        }, 250);
      },
      { pipelineId: effectivePipelineId },
      setSseConnected,
    );
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      unsubscribe();
    };
  }, [project.projectId, effectivePipelineId, qc]);

  // Active version topology nodes
  const boardNodes: PipelineNodeSnapshot[] = useMemo(() => {
    if (!activePipeline) return [];
    const matched = activePipeline.activeVersions.find((v) => v.version === selectedVersion);
    return matched?.nodes ?? activePipeline.nodes;
  }, [activePipeline, selectedVersion]);

  // Client-side search & status filter
  const filteredRuns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return runs.filter((run) => {
      if (statusFilter === "active") {
        if (
          run.status !== "queued" &&
          run.status !== "running" &&
          run.status !== "waiting"
        ) {
          return false;
        }
      } else if (statusFilter === "attention") {
        if (run.status !== "waiting_confirmation" && run.status !== "failed") {
          return false;
        }
      } else if (statusFilter === "done") {
        if (!isTerminalRunStatus(run.status)) {
          return false;
        }
      }

      if (!q) return true;
      return (
        run.title.toLowerCase().includes(q) ||
        run.runId.toLowerCase().includes(q) ||
        (run.externalKey?.toLowerCase().includes(q) ?? false) ||
        (run.branchName?.toLowerCase().includes(q) ?? false) ||
        (run.statusSummary?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [runs, searchQuery, statusFilter]);

  // Group runs into swimlanes strictly by topology node order
  const runsByNode = useMemo(() => {
    const map = new Map<string, PipelineRunRecord[]>();
    for (const node of boardNodes) {
      map.set(node.id, []);
    }
    const terminalNode = boardNodes.find((n) => n.terminal) ?? boardNodes[boardNodes.length - 1];

    for (const run of filteredRuns) {
      if (run.status === "cancelled" && terminalNode) {
        map.get(terminalNode.id)?.push(run);
        continue;
      }
      const bucket = map.get(run.currentNodeId);
      if (bucket) {
        bucket.push(run);
      } else if (terminalNode) {
        map.get(terminalNode.id)?.push(run);
      }
    }
    return map;
  }, [boardNodes, filteredRuns]);

  const counts = useMemo(() => {
    let attention = 0;
    let active = 0;
    let done = 0;
    for (const r of runs) {
      if (r.status === "waiting_confirmation" || r.status === "failed") attention += 1;
      else if (isTerminalRunStatus(r.status)) done += 1;
      else active += 1;
    }
    return { all: runs.length, active, attention, done };
  }, [runs]);

  const handleOpenRun = (run: PipelineRunRecord) => {
    navigate(
      generatePath(ROUTES.pipelineRun, {
        projectId: project.projectId,
        pipelineId: run.pipelineId,
        runId: run.runId,
      }),
    );
  };

  if (loadingPipelines) {
    return (
      <div className="flex-1 w-full h-full min-w-0 flex items-center justify-center bg-[var(--bg-canvas)] text-xs text-[var(--text-muted)] gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Loading project pipelines...</span>
      </div>
    );
  }

  if (pipelinesError) {
    return (
      <div className="flex-1 w-full h-full min-w-0 flex items-center justify-center p-6 bg-[var(--bg-canvas)]">
        <EmptyState
          icon={<GitBranch className="w-7 h-7 text-red-500" />}
          title="Failed to load pipelines"
          description={pipelinesError}
          action={
            <button
              type="button"
              onClick={() => void loadPipelines()}
              className="px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 cursor-pointer"
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (pipelines.length === 0 || !activePipeline) {
    return (
      <div className="flex-1 w-full h-full min-w-0 flex items-center justify-center p-6 bg-[var(--bg-canvas)]">
        <EmptyState
          icon={<GitBranch className="w-7 h-7 text-[var(--text-muted)]" />}
          title="No pipelines configured"
          description={`Add TypeScript pipeline files (*.ts) under projects/${project.projectId}/pipelines/ to orchestrate multi-stage Agent, Code, and Human workflows.`}
        />
      </div>
    );
  }

  const versionOptions =
    activePipeline.activeVersions.length > 0
      ? activePipeline.activeVersions
      : [
          {
            version: activePipeline.currentVersion,
            activeRunCount: 0,
            totalRunCount: runs.length,
            nodes: activePipeline.nodes,
          },
        ];

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg-canvas)] select-text">
      {/* Vercel-style Top Toolbar matching SessionBoard */}
      <div className="min-h-12 px-6 py-2 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] bg-[var(--bg-header)] shrink-0">
        {/* Left: Pipeline Selector (matches StudioHeader Project dropdown), Version & Count */}
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          {pipelines.length > 1 ? (
            <div className="relative flex items-center h-7 select-none" ref={pipelineDropdownRef}>
              <button
                type="button"
                onClick={() => setPipelineDropdownOpen((prev) => !prev)}
                className="h-7 flex items-center gap-1.5 px-2 rounded-[var(--radius-sm)] text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-default)] leading-none"
                title={activePipeline.description}
              >
                <GitBranch className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                <span className="font-semibold leading-none">{activePipeline.name}</span>
                <ChevronDown
                  className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                    pipelineDropdownOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              <AnimatePresence>
                {pipelineDropdownOpen && (
                  <m.div
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.14, ease: EASE_OUT_EXPO }}
                    className="absolute left-0 top-full mt-1 w-64 rounded-[var(--radius-md)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] shadow-lg py-1 z-50 origin-top-left"
                  >
                    <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-mono border-b border-[var(--border-subtle)] mb-1 flex items-center justify-between">
                      <span>Pipelines</span>
                      <span>{pipelines.length}</span>
                    </div>
                    {pipelines.map((p) => {
                      const isSelected = p.id === activePipeline.id;
                      const activeCount = p.activeVersions.reduce(
                        (sum, v) => sum + v.activeRunCount,
                        0,
                      );
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setPipelineDropdownOpen(false);
                            navigate(
                              generatePath(ROUTES.pipeline, {
                                projectId: project.projectId,
                                pipelineId: p.id,
                              }),
                            );
                          }}
                          className={`w-full px-2.5 py-1.5 text-xs text-left flex items-center justify-between gap-2 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer ${
                            isSelected
                              ? "text-[var(--text-primary)] font-semibold bg-[var(--bg-surface)]"
                              : "text-[var(--text-secondary)]"
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate">{p.name}</span>
                              {!p.enabled && (
                                <span className="px-1 py-0 rounded text-[9.5px] font-mono bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 shrink-0">
                                  off
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] font-mono text-[var(--text-muted)] truncate mt-0.5">
                              {p.nodes.length} stages
                              {activeCount > 0 ? ` · ${activeCount} active` : ""}
                            </div>
                          </div>
                          {isSelected && (
                            <Check className="w-3.5 h-3.5 text-[var(--text-primary)] shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)] font-semibold"
              title={activePipeline.description}
            >
              <GitBranch className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <span>{activePipeline.name}</span>
            </span>
          )}

          <span className="text-[11px] font-mono text-[var(--text-muted)] px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)]">
            {filteredRuns.length} total
          </span>

          {/* Topology Revision Selector (Dropdown when > 1 version exists) */}
          {versionOptions.length > 1 ? (
            <div className="relative flex items-center h-7 select-none" ref={versionDropdownRef}>
              <button
                type="button"
                onClick={() => {
                  setPipelineDropdownOpen(false);
                  setVersionDropdownOpen((prev) => !prev);
                }}
                className="h-7 inline-flex items-center gap-1.5 px-2 rounded-[var(--radius-sm)] text-[11px] font-mono bg-[var(--bg-surface)] border border-[var(--border-default)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-surface-hover)] text-[var(--text-primary)] transition-colors cursor-pointer leading-none"
                title="Switch pipeline topology revision"
              >
                <span className="font-semibold">v{selectedVersion}</span>
                {selectedVersion === activePipeline.currentVersion && (
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                    latest
                  </span>
                )}
                <ChevronDown
                  className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                    versionDropdownOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              <AnimatePresence>
                {versionDropdownOpen && (
                  <m.div
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.14, ease: EASE_OUT_EXPO }}
                    className="absolute left-0 top-full mt-1 w-56 rounded-[var(--radius-md)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] shadow-lg py-1 z-50 origin-top-left"
                  >
                    <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-mono border-b border-[var(--border-subtle)] mb-1 flex items-center justify-between">
                      <span>Revisions</span>
                      <span>{versionOptions.length}</span>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {versionOptions.map((v) => {
                        const isSelected = v.version === selectedVersion;
                        const isLatest = v.version === activePipeline.currentVersion;
                        return (
                          <button
                            key={v.version}
                            type="button"
                            onClick={() => handleSelectVersion(v.version)}
                            className={`w-full px-2.5 py-1.5 text-xs text-left flex items-center justify-between gap-2 hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer ${
                              isSelected
                                ? "text-[var(--text-primary)] font-semibold bg-[var(--bg-surface)]"
                                : "text-[var(--text-secondary)]"
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 font-mono">
                                <span>v{v.version}</span>
                                {isLatest && (
                                  <span className="px-1 py-0 rounded text-[9.5px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                    latest
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] font-mono text-[var(--text-muted)] truncate mt-0.5">
                                {v.nodes.length} stages · {v.totalRunCount} runs
                                {v.activeRunCount > 0 ? ` (${v.activeRunCount} active)` : ""}
                              </div>
                            </div>
                            {isSelected && (
                              <Check className="w-3.5 h-3.5 text-[var(--text-primary)] shrink-0" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            <span className="text-[11px] font-mono text-[var(--text-muted)] px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface)] border border-[var(--border-default)]">
              v{activePipeline.currentVersion}
            </span>
          )}

          {!activePipeline.enabled && (
            <span className="px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[11px] font-mono bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/25">
              Disabled
            </span>
          )}
        </div>

        {/* Right: Filters, Search, Live Status & New Run */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Status Filter Pills */}
          <div className="inline-flex items-center p-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-default)]">
            {(
              [
                { id: "all", label: "All", count: counts.all },
                { id: "active", label: "Active", count: counts.active },
                { id: "attention", label: "Attention", count: counts.attention },
                { id: "done", label: "Done", count: counts.done },
              ] as const
            ).map((pill) => {
              const selected = statusFilter === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => setStatusFilter(pill.id)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] text-[11px] font-medium transition-colors cursor-pointer ${
                    selected
                      ? "bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-default)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-transparent"
                  }`}
                >
                  <span>{pill.label}</span>
                  <span
                    className={`font-mono text-[10px] ${
                      pill.id === "attention" && pill.count > 0
                        ? "text-violet-600 dark:text-violet-400 font-semibold"
                        : "text-[var(--text-muted)]"
                    }`}
                  >
                    {pill.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="relative w-44 md:w-56">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search title, key, branch..."
              className="w-full pl-8 pr-2.5 py-1 rounded-[var(--radius-sm)] text-xs bg-[var(--bg-canvas)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-hidden focus:border-[var(--border-focus)] transition-colors"
            />
          </div>

          {/* Live SSE indicator */}
          <div
            title={sseConnected ? "Real-time SSE connected" : "Connecting to SSE stream..."}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-sm)] text-[11px] font-mono text-[var(--text-muted)]"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                sseConnected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
              }`}
            />
            <span className="hidden lg:inline">{sseConnected ? "Live" : "Sync"}</span>
          </div>

          <button
            type="button"
            onClick={() => void loadRuns()}
            disabled={loadingRuns}
            title="Refresh board"
            className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingRuns ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={() => setNewRunOpen(true)}
            disabled={!activePipeline.enabled}
            className="px-3 py-1 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-1.5 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Run</span>
          </button>
        </div>
      </div>

      {/* Open Flat Swimlane Board (matching SessionBoard column design — no outer lane cards) */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4 md:p-6 min-h-0">
        <div className="flex gap-6 h-full min-w-max">
          {boardNodes.map((node, index) => {
            const laneRuns = runsByNode.get(node.id) ?? [];
            const execStyle = getExecutorStyle(node.executor);
            const hasActiveRun = laneRuns.some(
              (r) => r.status === "running" || r.status === "waiting_confirmation",
            );

            return (
              <div
                key={node.id}
                className="w-[300px] xl:w-[320px] shrink-0 flex flex-col h-full min-h-0"
              >
                {/* Plain Text Column Header (SessionBoard style) */}
                <div className="flex items-center justify-between gap-2 pb-3 px-1 shrink-0 select-none">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${getExecutorDotColor(node.executor)} ${
                        hasActiveRun ? "animate-pulse" : ""
                      }`}
                    />
                    <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3
                      className="font-mono text-xs font-semibold tracking-wider text-[var(--text-primary)] uppercase truncate"
                      title={`${node.name} (${node.id})`}
                    >
                      {node.name}
                    </h3>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className={`px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-mono border ${execStyle.badgeClass}`}
                    >
                      {execStyle.label}
                    </span>
                    {node.gate === "manual" && (
                      <span
                        title="Manual Approval Gate"
                        className="inline-flex items-center px-1 py-0.5 rounded-[var(--radius-xs)] text-[10px] bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20"
                      >
                        <ShieldAlert className="w-3 h-3" />
                      </span>
                    )}
                    <span className="font-mono text-[11px] font-medium text-[var(--text-muted)] px-2 py-0.5 rounded-full bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] tabular-nums">
                      {laneRuns.length}
                    </span>
                  </div>
                </div>

                {/* Independent Scrollable Column Stack */}
                <div className="flex-1 overflow-y-auto min-h-0 pr-1 space-y-3">
                  {laneRuns.length === 0 ? (
                    <div className="border border-dashed border-[var(--border-default)] rounded-[var(--radius-md)] p-8 text-center text-xs text-[var(--text-muted)] font-mono flex flex-col items-center justify-center gap-1">
                      <span>No runs</span>
                      <span className="text-[10px] text-[var(--text-muted)] opacity-70">
                        暂无此阶段任务
                      </span>
                    </div>
                  ) : (
                    <AnimatePresence initial={false}>
                      {laneRuns.map((run, idx) => {
                        const statusStyle = getPipelineStatusStyle(run.status);
                        const totalLoops = Object.values(run.loopCounts ?? {}).reduce(
                          (sum, n) => sum + n,
                          0,
                        );

                        return (
                          <m.div
                            key={run.runId}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.96 }}
                            transition={{
                              duration: 0.18,
                              delay: Math.min(idx * 0.025, 0.18),
                              ease: EASE_OUT_EXPO,
                            }}
                          >
                            <article
                              onClick={() => handleOpenRun(run)}
                              className="group relative flex flex-col justify-between p-4 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-default)] hover:border-[var(--border-strong)] transition-colors duration-150 cursor-pointer space-y-3"
                            >
                              {/* 1. Title */}
                              <h4 className="text-[13px] font-semibold text-[var(--text-primary)] group-hover:text-[var(--primary)] transition-colors line-clamp-2 leading-snug">
                                {run.title}
                              </h4>

                              {/* 2. ID / External Key + Status Badge */}
                              <div className="flex items-center gap-2 flex-wrap">
                                {run.externalKey ? (
                                  run.externalUrl ? (
                                    <a
                                      href={run.externalUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-[10px] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors max-w-[150px]"
                                    >
                                      <span className="truncate">{run.externalKey}</span>
                                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                                    </a>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-[10px] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)] max-w-[150px] truncate">
                                      {run.externalKey}
                                    </span>
                                  )
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-[10px] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                                    <Hash className="w-2.5 h-2.5 text-[var(--text-muted)]" />
                                    <span>{run.runId.slice(0, 12)}...</span>
                                  </span>
                                )}

                                <span
                                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusStyle.badgeClass}`}
                                >
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full ${statusStyle.dotClass}`}
                                  />
                                  <span>{statusStyle.label}</span>
                                </span>

                                {totalLoops > 0 && (
                                  <span
                                    title="Rework loops"
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20"
                                  >
                                    <Repeat className="w-2.5 h-2.5" />
                                    {totalLoops}
                                  </span>
                                )}
                              </div>

                              {/* 3. Summary & Branch/Version Chips */}
                              {run.statusSummary && (
                                <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed line-clamp-2">
                                  {run.statusSummary}
                                </p>
                              )}

                              <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                                {run.branchName && (
                                  <span
                                    title={run.branchName}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)] max-w-[190px]"
                                  >
                                    <GitBranch className="w-2.5 h-2.5 text-[var(--text-muted)] shrink-0" />
                                    <span className="truncate">{run.branchName}</span>
                                  </span>
                                )}
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-xs)] font-mono bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-muted)]">
                                  <Layers className="w-2.5 h-2.5" />
                                  <span>v{run.pipelineVersion}</span>
                                </span>
                              </div>

                              {/* 4. Card Footer: Timestamp & Enter Affordance */}
                              <div className="pt-2.5 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                                <div
                                  className="flex items-center gap-1 font-mono text-[10px]"
                                  title={`最后更新: ${formatDateTime(run.updatedAt)}`}
                                >
                                  <Clock className="w-2.5 h-2.5 text-[var(--text-muted)]" />
                                  <span>{formatTimeAgo(run.updatedAt)}</span>
                                </div>

                                <div className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors">
                                  <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                                    查看详情
                                  </span>
                                  <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                                </div>
                              </div>
                            </article>
                          </m.div>
                        );
                      })}
                    </AnimatePresence>
                  )}

                  {/* Pagination button on terminal column */}
                  {node.terminal && hasMore && (
                    <button
                      type="button"
                      onClick={() => void handleLoadMore()}
                      disabled={loadingMore}
                      className="w-full py-2 rounded-[var(--radius-sm)] text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-default)] transition-colors cursor-pointer flex items-center justify-center gap-1.5"
                    >
                      {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>{loadingMore ? "Loading..." : "Load older runs"}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* New Run Modal */}
      <NewPipelineRunModal
        open={newRunOpen}
        projectId={project.projectId}
        pipelineId={activePipeline.id}
        pipelineName={activePipeline.name}
        entryInputSchema={activePipeline.entryInputSchema}
        onClose={() => setNewRunOpen(false)}
        onCreated={(run) => {
          setNewRunOpen(false);
          handleOpenRun(run);
        }}
      />
    </div>
  );
}
