import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generatePath, Link, useParams } from "react-router";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  ShieldCheck,
  Undo2,
  XOctagon,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, pipelinesApi } from "../../api";
import { useCurrentProject } from "../../layouts/ProjectLayout";
import { ROUTES } from "../../routes";
import type {
  PipelineActionRecord,
  PipelineNodeSnapshot,
  PipelineRunDetail,
} from "../../types";
import { EmptyState } from "../common/EmptyState";
import { ResizablePane } from "../common/ResizablePane";
import {
  PipelineActionModal,
  type PipelineActionModalKind,
} from "../pipeline/PipelineActionModals";
import { PipelineHumanNodePanel } from "../pipeline/PipelineHumanNodePanel";
import { PipelineOverviewPanel } from "../pipeline/PipelineOverviewPanel";
import { PipelineRunSidebar } from "../pipeline/PipelineRunSidebar";
import { PipelineStagesSidebar } from "../pipeline/PipelineStagesSidebar";
import { PipelineTsNodePanel } from "../pipeline/PipelineTsNodePanel";
import { getPipelineStatusStyle, isTerminalRunStatus } from "../pipeline/pipelineStatus";
import {
  SessionConversation,
  type SessionInspectorData,
} from "../session/SessionConversation";

type SelectedView =
  | { kind: "overview" }
  | { kind: "nodeRun"; nodeRunId: string }
  | { kind: "unreached"; nodeId: string };

export function PipelineRunView() {
  const project = useCurrentProject();
  const { pipelineId, runId } = useParams<{ pipelineId: string; runId: string }>();

  const [detail, setDetail] = useState<PipelineRunDetail | null>(null);
  const [actions, setActions] = useState<PipelineActionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedView, setSelectedView] = useState<SelectedView | null>(null);

  // 3-pane layout: fixed Left Navigation + Center Content + animated collapsible Right Properties
  const [showInspector, setShowInspector] = useState(true);
  const [sessionInspectorData, setSessionInspectorData] = useState<SessionInspectorData | null>(
    null,
  );

  const [sseConnected, setSseConnected] = useState(false);
  const [modalKind, setModalKind] = useState<PipelineActionModalKind | null>(null);
  const [signaling, setSignaling] = useState(false);

  const prevActiveNodeRunIdRef = useRef<string | undefined>(undefined);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRunData = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!runId) return;
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const [nextDetail, nextActions] = await Promise.all([
          pipelinesApi.getRunDetail(runId),
          pipelinesApi.listRunActions(runId, { limit: 500 }),
        ]);
        setDetail(nextDetail);
        setActions(nextActions);

        const nextActiveId = nextDetail.run.activeNodeRunId;
        const isTerminal = isTerminalRunStatus(nextDetail.run.status);

        setSelectedView((prev) => {
          // Initial load: completed/cancelled opens on Overview; active/failed opens on active stage
          if (!prev) {
            if (isTerminal || !nextActiveId) {
              return { kind: "overview" };
            }
            return { kind: "nodeRun", nodeRunId: nextActiveId };
          }
          // Follow active stage progression when user was watching the previously active stage
          if (
            prev.kind === "nodeRun" &&
            prev.nodeRunId === prevActiveNodeRunIdRef.current &&
            nextActiveId &&
            nextActiveId !== prev.nodeRunId
          ) {
            return { kind: "nodeRun", nodeRunId: nextActiveId };
          }
          // If the run just finished while user was watching the active stage, move to Overview
          if (
            prev.kind === "nodeRun" &&
            prev.nodeRunId === prevActiveNodeRunIdRef.current &&
            isTerminal
          ) {
            return { kind: "overview" };
          }
          return prev;
        });
        prevActiveNodeRunIdRef.current = nextActiveId;
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to load pipeline run";
        setError(msg);
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    setDetail(null);
    setActions([]);
    setSelectedView(null);
    setSessionInspectorData(null);
    prevActiveNodeRunIdRef.current = undefined;
    void loadRunData();
  }, [loadRunData]);

  // Live SSE stream scoped to this run
  useEffect(() => {
    if (!runId) return;
    const unsubscribe = pipelinesApi.subscribeEvents(
      project.projectId,
      () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          void loadRunData({ silent: true });
        }, 250);
      },
      { runId },
      setSseConnected,
    );
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      unsubscribe();
    };
  }, [project.projectId, runId, loadRunData]);

  const nodes: PipelineNodeSnapshot[] = useMemo(() => {
    if (detail?.revision?.nodesSnapshot && detail.revision.nodesSnapshot.length > 0) {
      return detail.revision.nodesSnapshot;
    }
    if (!detail) return [];
    const seen = new Map<string, PipelineNodeSnapshot>();
    for (const nr of detail.nodeRuns) {
      if (!seen.has(nr.nodeId)) {
        seen.set(nr.nodeId, {
          id: nr.nodeId,
          name: nr.nodeId,
          executor: nr.executorType,
          terminal: nr.executorType === "terminal",
          gate: "auto",
          allowPrev: false,
          prevTargets: [],
          maxLoops: 0,
        });
      }
    }
    return Array.from(seen.values());
  }, [detail]);

  const effectiveView: SelectedView = selectedView ?? { kind: "overview" };

  const selectedNodeRun = useMemo(() => {
    if (!detail || effectiveView.kind !== "nodeRun") return null;
    return detail.nodeRuns.find((nr) => nr.nodeRunId === effectiveView.nodeRunId) ?? null;
  }, [detail, effectiveView]);

  useEffect(() => {
    if (
      effectiveView.kind !== "nodeRun" ||
      selectedNodeRun?.executorType !== "agent" ||
      !selectedNodeRun?.sessionId
    ) {
      setSessionInspectorData(null);
    }
  }, [effectiveView.kind, selectedNodeRun?.executorType, selectedNodeRun?.sessionId]);

  const activeNodeRun = useMemo(() => {
    if (!detail?.run.activeNodeRunId) return undefined;
    return detail.nodeRuns.find((nr) => nr.nodeRunId === detail.run.activeNodeRunId);
  }, [detail]);

  const currentNodeSnapshot = useMemo(() => {
    if (!detail) return undefined;
    return nodes.find((n) => n.id === detail.run.currentNodeId);
  }, [detail, nodes]);

  const selectedNodeSnapshot = useMemo(() => {
    const targetId =
      effectiveView.kind === "unreached" ? effectiveView.nodeId : selectedNodeRun?.nodeId;
    if (!targetId) return undefined;
    return nodes.find((n) => n.id === targetId);
  }, [nodes, effectiveView, selectedNodeRun]);

  const triggerActionForSelected = useMemo(() => {
    if (!selectedNodeRun?.triggeredByRecordId) return undefined;
    return actions.find((a) => a.recordId === selectedNodeRun.triggeredByRecordId);
  }, [actions, selectedNodeRun]);

  const latestConfirmationAction = useMemo(() => {
    if (!detail) return undefined;
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      if (a.nodeId === detail.run.currentNodeId) return a;
    }
    return actions[actions.length - 1];
  }, [actions, detail]);

  const handleSignalNow = async () => {
    if (!detail || signaling) return;
    setSignaling(true);
    try {
      const res = await pipelinesApi.signalRun(detail.run.runId);
      toast.success(
        res.woken ? "Signal sent — re-evaluating wait condition" : "Signal acknowledged",
      );
      void loadRunData({ silent: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to signal waiting node");
    } finally {
      setSignaling(false);
    }
  };

  const boardHref = generatePath(
    pipelineId ? ROUTES.pipeline : ROUTES.pipelines,
    pipelineId
      ? { projectId: project.projectId, pipelineId }
      : { projectId: project.projectId },
  );

  if (loading && !detail) {
    return (
      <div className="flex-1 w-full h-full min-w-0 flex items-center justify-center bg-[var(--bg-canvas)] text-xs text-[var(--text-muted)] gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Loading pipeline run...</span>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="flex-1 w-full h-full min-w-0 flex items-center justify-center p-6 bg-[var(--bg-canvas)]">
        <EmptyState
          icon={<AlertCircle className="w-7 h-7 text-red-500" />}
          title="Pipeline run unavailable"
          description={error ?? "Run not found"}
          action={
            <Link
              to={boardHref}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Board</span>
            </Link>
          }
        />
      </div>
    );
  }

  const { run, nodeRuns } = detail;
  const runStatusStyle = getPipelineStatusStyle(run.status);
  const terminal = isTerminalRunStatus(run.status);
  const canApprove = run.status === "waiting_confirmation";
  const canReject =
    run.status === "waiting_confirmation" &&
    Boolean(currentNodeSnapshot?.allowPrev && currentNodeSnapshot.prevTargets.length > 0);
  const canRetry = run.status === "failed";
  const canSignal = run.status === "waiting";
  const canCancel = !terminal;

  const isSelectedActive = Boolean(
    selectedNodeRun &&
      effectiveView.kind === "nodeRun" &&
      selectedNodeRun.nodeRunId === run.activeNodeRunId,
  );

  const agentReadOnly = !(
    isSelectedActive &&
    (run.status === "running" || run.status === "waiting_confirmation")
  );
  const agentReadOnlyReason = !isSelectedActive
    ? "历史阶段只读回放"
    : run.status === "completed"
      ? "流水线已完成，会话已归档"
      : run.status === "cancelled"
        ? "流水线已取消"
        : run.status === "failed"
          ? "阶段执行失败，可点击右上角 Retry 重新尝试"
          : "当前会话为只读状态";

  const totalDurationMs = (() => {
    const start = new Date(run.createdAt).getTime();
    const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
    return end - start;
  })();

  const isOverviewMode =
    effectiveView.kind === "overview" ||
    (effectiveView.kind === "nodeRun" && selectedNodeRun?.executorType === "terminal");

  return (
    <div className="flex-1 w-full h-full min-w-0 flex flex-col bg-[var(--bg-canvas)] overflow-hidden">
      {/* Single Compact 48px Run Bar */}
      <header className="h-12 px-4 border-b border-[var(--border-default)] bg-[var(--bg-header)] flex items-center justify-between gap-3 shrink-0 z-20 select-none">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Link
            to={boardHref}
            title="返回看板"
            className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>

          <span className="h-4 w-px bg-[var(--border-default)] shrink-0" />

          <h1
            className="text-xs sm:text-[13px] font-semibold text-[var(--text-primary)] truncate"
            title={run.title}
          >
            {run.title}
          </h1>

          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium border shrink-0 ${runStatusStyle.badgeClass}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${runStatusStyle.dotClass}`} />
            {runStatusStyle.label}
          </span>

          <span className="hidden md:inline-flex px-1.5 py-0.5 rounded-[var(--radius-xs)] text-[10px] font-mono bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-muted)] shrink-0">
            v{run.pipelineVersion}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {canApprove && (
            <button
              type="button"
              onClick={() => setModalKind("approve")}
              className="h-7 inline-flex items-center gap-1.5 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors cursor-pointer"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Approve</span>
            </button>
          )}
          {canReject && (
            <button
              type="button"
              onClick={() => setModalKind("reject")}
              className="h-7 inline-flex items-center gap-1.5 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 transition-colors cursor-pointer"
            >
              <Undo2 className="w-3.5 h-3.5" />
              <span>Reject</span>
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={() => setModalKind("retry")}
              className="h-7 inline-flex items-center gap-1.5 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 transition-opacity cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Retry</span>
            </button>
          )}
          {canSignal && (
            <button
              type="button"
              onClick={() => void handleSignalNow()}
              disabled={signaling}
              className="h-7 inline-flex items-center gap-1.5 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {signaling ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Zap className="w-3.5 h-3.5" />
              )}
              <span>Signal</span>
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={() => setModalKind("cancel")}
              title="取消流水线"
              className="h-7 inline-flex items-center gap-1 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 border border-red-500/25 transition-colors cursor-pointer"
            >
              <XOctagon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Cancel</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowInspector((prev) => !prev)}
            title={showInspector ? "收起右侧属性栏" : "展开右侧属性栏"}
            className={`w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center transition-colors cursor-pointer ${
              showInspector
                ? "bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] border border-[var(--border-default)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)]"
            }`}
          >
            {showInspector ? (
              <PanelRightClose className="w-3.5 h-3.5" />
            ) : (
              <PanelRightOpen className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </header>

      {/* Main 3-Pane Flex Workspace */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        {/* Left: Resizable Navigation (drag right edge; double-click to reset) */}
        <ResizablePane
          edge="right"
          defaultSize={236}
          minSize={180}
          maxSize={420}
          storageKey="studio.pipeline.leftWidth"
        >
          <PipelineStagesSidebar
            nodes={nodes}
            nodeRuns={nodeRuns}
            runStatus={run.status}
            currentNodeId={run.currentNodeId}
            activeNodeRunId={run.activeNodeRunId}
            isOverviewSelected={isOverviewMode}
            selectedNodeRunId={
              effectiveView.kind === "nodeRun" ? effectiveView.nodeRunId : null
            }
            selectedUnreachedNodeId={
              effectiveView.kind === "unreached" ? effectiveView.nodeId : null
            }
            sseConnected={sseConnected}
            totalDurationMs={totalDurationMs}
            onSelectOverview={() => setSelectedView({ kind: "overview" })}
            onSelectNodeRun={(id) => setSelectedView({ kind: "nodeRun", nodeRunId: id })}
            onSelectUnreachedNode={(nodeId) =>
              setSelectedView({ kind: "unreached", nodeId })
            }
          />
        </ResizablePane>

        {/* Center: Primary Content (Overview Report OR Active Stage Execution) */}
        <main className="flex-1 min-w-0 h-full flex flex-col overflow-hidden bg-[var(--bg-canvas)]">
          {isOverviewMode ? (
            <PipelineOverviewPanel
              run={run}
              nodes={nodes}
              nodeRuns={nodeRuns}
              actions={actions}
              totalDurationMs={totalDurationMs}
              onInspectNodeRun={(id) => setSelectedView({ kind: "nodeRun", nodeRunId: id })}
            />
          ) : effectiveView.kind === "unreached" ? (
            <div className="flex-1 h-full flex items-center justify-center p-6 bg-[var(--bg-canvas)]">
              <EmptyState
                icon={<Clock className="w-7 h-7 text-[var(--text-muted)]" />}
                title={`${selectedNodeSnapshot?.name ?? effectiveView.nodeId} 尚未执行`}
                description="流水线尚未流转到此阶段。"
              />
            </div>
          ) : !selectedNodeRun ? (
            <div className="flex-1 h-full flex items-center justify-center p-6 bg-[var(--bg-canvas)]">
              <EmptyState
                icon={<Loader2 className="w-7 h-7 text-[var(--text-muted)] animate-spin" />}
                title="正在准备执行阶段..."
                description="等待调度器启动节点任务。"
              />
            </div>
          ) : selectedNodeRun.executorType === "agent" ? (
            <div className="flex-1 h-full flex flex-col min-h-0 min-w-0 overflow-hidden">
              {isSelectedActive && run.status === "waiting_confirmation" && (
                <div className="px-5 py-2.5 border-b border-violet-500/25 bg-violet-500/8 flex flex-wrap items-center justify-between gap-3 shrink-0">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <ShieldCheck className="w-4 h-4 text-violet-600 dark:text-violet-400 shrink-0" />
                    <div className="text-xs text-[var(--text-primary)] truncate">
                      <span className="font-semibold">等待人工确认：</span>
                      <span className="text-[var(--text-secondary)]">
                        {latestConfirmationAction?.context.question ||
                          latestConfirmationAction?.context.summary ||
                          run.statusSummary ||
                          "请检查下方执行输出，确认后点击 Approve 或 Reject。"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {canApprove && (
                      <button
                        type="button"
                        onClick={() => setModalKind("approve")}
                        className="px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors cursor-pointer"
                      >
                        Approve
                      </button>
                    )}
                    {canReject && (
                      <button
                        type="button"
                        onClick={() => setModalKind("reject")}
                        className="px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer"
                      >
                        Reject
                      </button>
                    )}
                  </div>
                </div>
              )}

              {selectedNodeRun.sessionId ? (
                <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
                  <SessionConversation
                    key={selectedNodeRun.sessionId}
                    sessionId={selectedNodeRun.sessionId}
                    mode="canvas"
                    readOnly={agentReadOnly}
                    readOnlyReason={agentReadOnlyReason}
                    onInspectorDataChange={setSessionInspectorData}
                  />
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center p-6 bg-[var(--bg-canvas)]">
                  <EmptyState
                    icon={<Clock className="w-7 h-7 text-[var(--text-muted)]" />}
                    title={
                      selectedNodeRun.status === "queued"
                        ? "排队等待执行"
                        : "未关联 Agent 会话"
                    }
                    description={
                      selectedNodeRun.errorMessage ||
                      "正在等待节点并发配额以启动 Agent 会话。"
                    }
                  />
                </div>
              )}
            </div>
          ) : selectedNodeRun.executorType === "ts" ? (
            <PipelineTsNodePanel
              nodeRun={selectedNodeRun}
              isActive={isSelectedActive}
              onSignal={handleSignalNow}
              signaling={signaling}
            />
          ) : (
            <PipelineHumanNodePanel
              nodeRun={selectedNodeRun}
              nodeSnapshot={selectedNodeSnapshot}
              triggerAction={triggerActionForSelected}
              isActive={isSelectedActive}
              canApprove={canApprove}
              canReject={canReject}
              onApprove={() => setModalKind("approve")}
              onReject={() => setModalKind("reject")}
            />
          )}
        </main>

        {/* Right: Animated Collapsible & Resizable Properties Inspector */}
        <ResizablePane
          edge="left"
          defaultSize={308}
          minSize={260}
          maxSize={560}
          open={showInspector}
          storageKey="studio.pipeline.rightWidth"
        >
          <PipelineRunSidebar
            run={run}
            nodes={nodes}
            actions={actions}
            selectedNodeRun={isOverviewMode ? null : selectedNodeRun}
            totalDurationMs={totalDurationMs}
            sessionData={sessionInspectorData}
            onClose={() => setShowInspector(false)}
          />
        </ResizablePane>
      </div>

      {/* Action Modals */}
      <PipelineActionModal
        kind={modalKind}
        run={run}
        currentNode={currentNodeSnapshot}
        activeNodeRun={activeNodeRun}
        nodes={nodes}
        onClose={() => setModalKind(null)}
        onSuccess={() => {
          void loadRunData({ silent: true });
        }}
      />
    </div>
  );
}
