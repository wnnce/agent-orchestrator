import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Clock,
  Database,
  FileText,
  Loader2,
  Radio,
  Terminal,
  Zap,
} from "lucide-react";
import { ApiError, pipelinesApi } from "../../api";
import { queryKeys } from "../../queries";
import type { PipelineNodeRunRecord } from "../../types";
import { formatDateTime, formatDuration } from "../../utils/formatters";
import { LogViewer, type LogEntry } from "../common/LogViewer";
import { formatRelativeCountdown, getPipelineStatusStyle } from "./pipelineStatus";

interface PipelineTsNodePanelProps {
  nodeRun: PipelineNodeRunRecord;
  isActive: boolean;
  onSignal?: () => Promise<void>;
  signaling?: boolean;
}

type TsTab = "logs" | "state" | "context";

export function PipelineTsNodePanel({
  nodeRun,
  isActive,
  onSignal,
  signaling = false,
}: PipelineTsNodePanelProps) {
  const [activeTab, setActiveTab] = useState<TsTab>("logs");
  const isTerminalNode =
    nodeRun.status === "completed" ||
    nodeRun.status === "failed" ||
    nodeRun.status === "cancelled";

  const logsQuery = useQuery({
    queryKey: queryKeys.pipelineNodeLogs(nodeRun.nodeRunId),
    queryFn: () => pipelinesApi.listNodeRunLogs(nodeRun.nodeRunId, { limit: 500 }),
    staleTime: isTerminalNode ? Infinity : 5_000,
  });

  // Refetch cached logs only when the node actually advances (status/poll/updatedAt changes)
  const lastChangeSigRef = useRef(
    `${nodeRun.nodeRunId}:${nodeRun.status}:${nodeRun.pollCount}:${nodeRun.updatedAt}`,
  );
  useEffect(() => {
    const nextSig = `${nodeRun.nodeRunId}:${nodeRun.status}:${nodeRun.pollCount}:${nodeRun.updatedAt}`;
    if (nextSig !== lastChangeSigRef.current) {
      const sameNode = lastChangeSigRef.current.startsWith(`${nodeRun.nodeRunId}:`);
      lastChangeSigRef.current = nextSig;
      if (sameNode) {
        void logsQuery.refetch();
      }
    }
  }, [nodeRun.nodeRunId, nodeRun.status, nodeRun.pollCount, nodeRun.updatedAt, logsQuery]);

  const logs = logsQuery.data ?? [];
  const loadingLogs = logsQuery.isFetching;
  const logsError = logsQuery.error
    ? logsQuery.error instanceof ApiError
      ? logsQuery.error.message
      : logsQuery.error instanceof Error
        ? logsQuery.error.message
        : "Failed to load node logs"
    : null;
  const loadLogs = () => logsQuery.refetch();

  const logEntries: LogEntry[] = useMemo(
    () =>
      logs.map((entry) => ({
        key: `${entry.sequence}-${entry.id ?? entry.createdAt}`,
        sequence: entry.sequence,
        level: entry.level,
        message: entry.message,
        fields: entry.fields,
        createdAt: entry.createdAt,
      })),
    [logs],
  );

  const stepEntries = Object.entries(nodeRun.stepState?.steps ?? {});
  const waitEntries = Object.entries(nodeRun.stepState?.waits ?? {});
  const stateCount = stepEntries.length + waitEntries.length;
  const statusStyle = getPipelineStatusStyle(nodeRun.status);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-[var(--bg-canvas)] select-text">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-4">
        {/* Inline Compact Stage Header + Sub-tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--border-default)]">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${statusStyle.badgeClass}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dotClass}`} />
              {statusStyle.label}
            </span>
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">
              Attempt #{nodeRun.attempt}
            </span>
            <span className="text-[var(--border-strong)]">·</span>
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--text-secondary)]">
              <Clock className="w-3 h-3 text-[var(--text-muted)]" />
              {formatDuration(nodeRun.durationMs)}
            </span>
            {nodeRun.pollCount > 0 && (
              <>
                <span className="text-[var(--border-strong)]">·</span>
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--text-secondary)]">
                  <Radio className="w-3 h-3 text-[var(--text-muted)]" />
                  Polls: {nodeRun.pollCount}
                </span>
              </>
            )}
            {nodeRun.status === "waiting" && nodeRun.nextPollAt && (
              <>
                <span className="text-[var(--border-strong)]">·</span>
                <span
                  className="font-mono text-[11px] text-amber-700 dark:text-amber-400"
                  title={formatDateTime(nodeRun.nextPollAt)}
                >
                  Next poll {formatRelativeCountdown(nodeRun.nextPollAt)}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isActive && nodeRun.status === "waiting" && onSignal && (
              <button
                type="button"
                onClick={() => void onSignal()}
                disabled={signaling}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {signaling ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Zap className="w-3.5 h-3.5" />
                )}
                <span>Signal Now</span>
              </button>
            )}

            <div className="inline-flex items-center p-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-default)]">
              {(
                [
                  { id: "logs", label: "Logs", icon: Terminal, count: logs.length },
                  { id: "state", label: "Step State", icon: Database, count: stateCount },
                  { id: "context", label: "Context", icon: FileText, count: undefined },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-xs)] text-xs font-medium transition-colors cursor-pointer ${
                      selected
                        ? "bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-default)]"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-transparent"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                    {tab.count !== undefined && (
                      <span className="px-1 py-0 rounded text-[10px] font-mono bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)]">
                        {tab.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Tab Body */}
        {activeTab === "logs" && (
          <LogViewer
            logs={logEntries}
            loading={loadingLogs}
            error={logsError}
            emptyText="本次阶段执行暂无日志输出"
            onRefresh={() => void loadLogs()}
          />
        )}

        {activeTab === "state" && (
          <div className="space-y-5">
            <section className="space-y-2.5">
              <h3 className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
                Wait Conditions ({waitEntries.length})
              </h3>
              {waitEntries.length === 0 ? (
                <div className="p-4 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] bg-[var(--bg-surface)] text-xs text-[var(--text-muted)]">
                  No <code className="font-mono">ctx.waitUntil</code> state recorded.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {waitEntries.map(([key, entry]) => (
                    <div
                      key={key}
                      className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs font-semibold text-[var(--text-primary)]">
                          {key}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                            entry.status === "done"
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25"
                              : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25"
                          }`}
                        >
                          {entry.status}
                        </span>
                      </div>
                      {entry.summary && (
                        <p className="text-xs text-[var(--text-secondary)]">{entry.summary}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-[var(--text-muted)]">
                        <span>Started: {formatDateTime(entry.startedAt)}</span>
                        {entry.completedAt && (
                          <span>Completed: {formatDateTime(entry.completedAt)}</span>
                        )}
                      </div>
                      {entry.value !== undefined && (
                        <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-code)] overflow-x-auto">
                          {JSON.stringify(entry.value, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2.5">
              <h3 className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
                Cached Steps ({stepEntries.length})
              </h3>
              {stepEntries.length === 0 ? (
                <div className="p-4 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] bg-[var(--bg-surface)] text-xs text-[var(--text-muted)]">
                  No <code className="font-mono">ctx.step</code> results cached.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {stepEntries.map(([key, entry]) => (
                    <div
                      key={key}
                      className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-2"
                    >
                      <div className="font-mono text-xs font-semibold text-[var(--text-primary)]">
                        {key}
                      </div>
                      <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-code)] overflow-x-auto">
                        {entry.value === undefined
                          ? "undefined"
                          : JSON.stringify(entry.value, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === "context" && (
          <div className="space-y-4">
            {nodeRun.errorMessage && (
              <div className="p-4 rounded-[var(--radius-md)] bg-red-500/8 border border-red-500/25 space-y-1.5">
                <div className="text-xs font-semibold text-red-700 dark:text-red-400 font-mono">
                  Error Message
                </div>
                <pre className="text-xs font-mono text-red-700 dark:text-red-300 whitespace-pre-wrap break-words">
                  {nodeRun.errorMessage}
                </pre>
              </div>
            )}

            {nodeRun.outputSummary && (
              <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-1.5">
                <div className="text-xs font-semibold text-[var(--text-primary)] font-mono uppercase tracking-wider">
                  Output Summary
                </div>
                <p className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                  {nodeRun.outputSummary}
                </p>
              </div>
            )}

            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-2">
              <div className="text-xs font-semibold text-[var(--text-primary)] font-mono uppercase tracking-wider">
                Input Context
              </div>
              <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-code)] overflow-x-auto">
                {JSON.stringify(nodeRun.inputContext ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
