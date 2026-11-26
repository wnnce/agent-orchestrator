import React from "react";
import { CheckCircle2, Clock, FileText, ShieldAlert } from "lucide-react";
import type {
  PipelineNodeRunRecord,
  PipelineNodeSnapshot,
  PipelineRunStatus,
} from "../../types";
import { formatDuration } from "../../utils/formatters";
import {
  getActionStyle,
  getExecutorStyle,
  getPipelineStatusStyle,
} from "./pipelineStatus";

interface PipelineStagesSidebarProps {
  nodes: PipelineNodeSnapshot[];
  nodeRuns: PipelineNodeRunRecord[];
  runStatus: PipelineRunStatus;
  currentNodeId: string;
  activeNodeRunId?: string;
  isOverviewSelected: boolean;
  selectedNodeRunId?: string | null;
  selectedUnreachedNodeId?: string | null;
  sseConnected: boolean;
  totalDurationMs?: number;
  onSelectOverview: () => void;
  onSelectNodeRun: (nodeRunId: string) => void;
  onSelectUnreachedNode: (nodeId: string) => void;
}

export function PipelineStagesSidebar({
  nodes,
  nodeRuns,
  runStatus,
  currentNodeId,
  activeNodeRunId,
  isOverviewSelected,
  selectedNodeRunId,
  selectedUnreachedNodeId,
  sseConnected,
  totalDurationMs,
  onSelectOverview,
  onSelectNodeRun,
  onSelectUnreachedNode,
}: PipelineStagesSidebarProps) {
  const attemptsByNode = new Map<string, PipelineNodeRunRecord[]>();
  for (const nr of nodeRuns) {
    const list = attemptsByNode.get(nr.nodeId) ?? [];
    list.push(nr);
    attemptsByNode.set(nr.nodeId, list);
  }

  const executionNodes = nodes.filter((n) => !n.terminal);
  const terminalNode = nodes.find((n) => n.terminal);

  const completedStagesCount = executionNodes.filter((node) => {
    const attempts = attemptsByNode.get(node.id) ?? [];
    return attempts.some((a) => a.status === "completed");
  }).length;

  return (
    <aside className="w-full border-r border-[var(--border-default)] bg-[var(--bg-sidebar)] flex flex-col h-full overflow-hidden select-none">
      {/* Top Pinned Overview Navigation Item */}
      <div className="p-2.5 border-b border-[var(--border-subtle)] shrink-0">
        <button
          type="button"
          onClick={onSelectOverview}
          className={`w-full text-left px-2.5 py-2 rounded-[var(--radius-sm)] border transition-colors cursor-pointer flex items-center justify-between gap-2 ${
            isOverviewSelected
              ? "bg-[var(--bg-surface-elevated)] border-[var(--border-strong)] text-[var(--text-primary)] font-semibold"
              : "bg-transparent border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]/60 hover:text-[var(--text-primary)]"
          }`}
        >
          <span className="inline-flex items-center gap-2 text-xs">
            <FileText className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <span>总览</span>
          </span>
          {runStatus === "completed" && (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
          )}
        </button>
      </div>

      {/* Stages Section Header */}
      <div className="px-3.5 pt-3 pb-1.5 flex items-center justify-between gap-2 shrink-0">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          执行阶段
        </span>
        <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
          {completedStagesCount}/{executionNodes.length}
        </span>
      </div>

      {/* Vertical Stage List */}
      <div className="flex-1 overflow-y-auto px-2.5 pb-3 space-y-1">
        {executionNodes.map((node, idx) => {
          const attempts = attemptsByNode.get(node.id) ?? [];
          const latestAttempt = attempts[attempts.length - 1];
          const isCurrent = currentNodeId === node.id;
          const isStageSelected =
            !isOverviewSelected &&
            (selectedUnreachedNodeId
              ? selectedUnreachedNodeId === node.id
              : Boolean(
                  latestAttempt && attempts.some((a) => a.nodeRunId === selectedNodeRunId),
                ));

          const stageStatus = latestAttempt?.status;
          const dotClass = stageStatus
            ? getPipelineStatusStyle(stageStatus).dotClass
            : "bg-[var(--border-strong)]";
          const execStyle = getExecutorStyle(node.executor);
          const hasMultipleAttempts = attempts.length > 1;

          const handleStageClick = () => {
            if (latestAttempt) {
              onSelectNodeRun(latestAttempt.nodeRunId);
            } else {
              onSelectUnreachedNode(node.id);
            }
          };

          return (
            <div key={node.id} className="space-y-1">
              <button
                type="button"
                onClick={handleStageClick}
                className={`w-full text-left px-2.5 py-2 rounded-[var(--radius-sm)] border transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                  isStageSelected && !hasMultipleAttempts
                    ? "bg-[var(--bg-surface-elevated)] border-[var(--border-strong)] text-[var(--text-primary)]"
                    : isStageSelected
                      ? "bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--text-primary)]"
                      : isCurrent
                        ? "bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--text-primary)] hover:border-[var(--border-strong)]"
                        : "bg-transparent border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]/60 hover:text-[var(--text-primary)]"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
                  <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={`text-xs truncate ${
                      isStageSelected || isCurrent
                        ? "font-semibold text-[var(--text-primary)]"
                        : attempts.length > 0
                          ? "font-medium text-[var(--text-primary)]"
                          : "text-[var(--text-muted)]"
                    }`}
                    title={`${node.name} (${node.id})`}
                  >
                    {node.name}
                  </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {node.gate === "manual" && (
                    <span title="人工确认门禁" className="text-violet-600 dark:text-violet-400">
                      <ShieldAlert className="w-3 h-3" />
                    </span>
                  )}
                  {hasMultipleAttempts ? (
                    <span className="px-1.5 py-0 rounded text-[9.5px] font-mono bg-amber-500/12 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                      ×{attempts.length}
                    </span>
                  ) : (
                    <span
                      className={`px-1.5 py-0 rounded text-[9.5px] font-mono border ${execStyle.badgeClass}`}
                    >
                      {execStyle.label}
                    </span>
                  )}
                </div>
              </button>

              {hasMultipleAttempts && (
                <div className="ml-3.5 pl-2.5 border-l border-[var(--border-default)] space-y-0.5 py-0.5">
                  {attempts.map((attempt) => {
                    const isAttemptSelected =
                      !isOverviewSelected &&
                      !selectedUnreachedNodeId &&
                      selectedNodeRunId === attempt.nodeRunId;
                    const isAttemptActive = activeNodeRunId === attempt.nodeRunId;
                    const attemptStatus = getPipelineStatusStyle(attempt.status);
                    const finalActionStyle = attempt.finalAction
                      ? getActionStyle(attempt.finalAction)
                      : null;

                    return (
                      <button
                        key={attempt.nodeRunId}
                        type="button"
                        onClick={() => onSelectNodeRun(attempt.nodeRunId)}
                        className={`w-full text-left px-2 py-1.5 rounded-[var(--radius-xs)] border transition-colors cursor-pointer flex items-center justify-between gap-1.5 text-[11px] font-mono ${
                          isAttemptSelected
                            ? "bg-[var(--bg-surface-elevated)] border-[var(--border-strong)] text-[var(--text-primary)] font-semibold"
                            : "bg-transparent border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]/60 hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${attemptStatus.dotClass}`}
                          />
                          <span>#{attempt.attempt}</span>
                          {finalActionStyle ? (
                            <span className="text-[10px] text-[var(--text-muted)] truncate">
                              {finalActionStyle.label}
                            </span>
                          ) : isAttemptActive ? (
                            <span className="text-[10px] text-blue-600 dark:text-blue-400">
                              active
                            </span>
                          ) : null}
                        </div>
                        <span className="text-[10px] text-[var(--text-muted)] tabular-nums shrink-0">
                          {formatDuration(attempt.durationMs)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Terminal Indicator Row (grounds the end of the pipeline and opens Overview) */}
        {terminalNode && (
          <button
            type="button"
            onClick={onSelectOverview}
            className="w-full text-left px-2.5 py-2 rounded-[var(--radius-sm)] border border-transparent hover:bg-[var(--bg-surface-hover)]/60 transition-colors cursor-pointer flex items-center justify-between gap-2 text-[var(--text-muted)]"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  runStatus === "completed"
                    ? "bg-emerald-500"
                    : runStatus === "cancelled"
                      ? "bg-neutral-400"
                      : "bg-[var(--border-strong)]"
                }`}
              />
              <span className="font-mono text-[10px] tabular-nums shrink-0">
                {String(executionNodes.length + 1).padStart(2, "0")}
              </span>
              <span className="text-xs truncate">{terminalNode.name}</span>
            </div>
            <span className="text-[9.5px] font-mono">
              {runStatus === "completed"
                ? "Done"
                : runStatus === "cancelled"
                  ? "Cancelled"
                  : "End"}
            </span>
          </button>
        )}
      </div>

      {/* Compact Footer Status */}
      <div className="px-3.5 py-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-[10.5px] font-mono text-[var(--text-muted)] shrink-0">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              sseConnected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
            }`}
          />
          <span>{sseConnected ? "Live" : "Syncing"}</span>
        </span>
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Clock className="w-3 h-3" />
          <span>{formatDuration(totalDurationMs)}</span>
        </span>
      </div>
    </aside>
  );
}
