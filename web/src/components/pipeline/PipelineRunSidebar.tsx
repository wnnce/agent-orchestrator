import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileCode2,
  GitBranch,
  History,
  Link2,
  Repeat,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { sessionsApi } from "../../api";
import type {
  PipelineActionRecord,
  PipelineNodeRunRecord,
  PipelineNodeSnapshot,
  PipelineRunRecord,
} from "../../types";
import { copyToClipboard } from "../../utils/clipboard";
import {
  calculateCacheHitRate,
  formatDateTime,
  formatDuration,
  formatTimeAgo,
  formatTokenCount,
} from "../../utils/formatters";
import type { SessionInspectorData } from "../session/SessionConversation";
import { extractDerivedRunLinks } from "./PipelineOverviewPanel";
import {
  getActionStyle,
  getPipelineStatusStyle,
  getWorkspaceStatusLabel,
} from "./pipelineStatus";

interface PipelineRunSidebarProps {
  run: PipelineRunRecord;
  nodes: PipelineNodeSnapshot[];
  actions: PipelineActionRecord[];
  selectedNodeRun?: PipelineNodeRunRecord | null;
  totalDurationMs?: number;
  sessionData?: SessionInspectorData | null;
  onClose?: () => void;
}

type InspectorTab = "details" | "actions" | "artifacts" | "events";

export function PipelineRunSidebar({
  run,
  nodes,
  actions,
  selectedNodeRun = null,
  totalDurationMs,
  sessionData = null,
  onClose,
}: PipelineRunSidebarProps) {
  const [tab, setTab] = useState<InspectorTab>("details");
  const [expandedEvents, setExpandedEvents] = useState<Record<number, boolean>>({});
  const [eventFilter, setEventFilter] = useState("");
  const [showInputJson, setShowInputJson] = useState(false);
  const [showMetadataJson, setShowMetadataJson] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionData && (tab === "artifacts" || tab === "events")) {
      setTab("details");
    }
  }, [sessionData, tab]);

  useEffect(() => {
    setExpandedEvents({});
    setEventFilter("");
  }, [selectedNodeRun?.nodeRunId]);

  const nodeNameById = (id?: string) => {
    if (!id) return "";
    return nodes.find((n) => n.id === id)?.name ?? id;
  };

  const toggleEvent = (idx: number) => {
    setExpandedEvents((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const handleCopy = async (key: string, value: string, label: string) => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
      toast.success(`已复制${label}`);
    }
  };

  const derived = useMemo(() => extractDerivedRunLinks(run, actions), [run, actions]);

  const visibleArtifacts = useMemo(
    () => (sessionData?.artifacts ?? []).filter((art) => art.kind !== "agent-message"),
    [sessionData?.artifacts],
  );

  const filteredEvents = useMemo(() => {
    const list = sessionData?.events ?? [];
    const q = eventFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) => e.type.toLowerCase().includes(q));
  }, [sessionData?.events, eventFilter]);

  const loopEntries = Object.entries(run.loopCounts ?? {}).filter(([, count]) => count > 0);
  const hasDataPayload = Object.keys(run.data ?? {}).length > 0;
  const hasMetadataPayload = Object.keys(run.metadata ?? {}).length > 0;
  const statusStyle = getPipelineStatusStyle(run.status);
  const cacheHitRate = sessionData?.usage ? calculateCacheHitRate(sessionData.usage) : null;

  return (
    <aside className="w-full border-l border-[var(--border-default)] bg-[var(--bg-inspector)] flex flex-col h-full overflow-hidden">
      {/* Single-level Compact Tabs Bar */}
      <div className="px-2.5 py-2 border-b border-[var(--border-default)] bg-[var(--bg-surface)] flex items-center justify-between gap-1 shrink-0 select-none">
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
          <button
            type="button"
            onClick={() => setTab("details")}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] text-xs font-medium transition-colors cursor-pointer shrink-0 ${
              tab === "details"
                ? "bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-default)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] border border-transparent"
            }`}
          >
            <SlidersHorizontal className="w-3 h-3" />
            <span>属性</span>
          </button>

          <button
            type="button"
            onClick={() => setTab("actions")}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] text-xs font-medium transition-colors cursor-pointer shrink-0 ${
              tab === "actions"
                ? "bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-default)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] border border-transparent"
            }`}
          >
            <History className="w-3 h-3" />
            <span>流转</span>
            <span className="text-[10px] font-mono text-[var(--text-muted)]">
              {actions.length}
            </span>
          </button>

          {sessionData && (
            <>
              <button
                type="button"
                onClick={() => setTab("artifacts")}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] text-xs font-medium transition-colors cursor-pointer shrink-0 ${
                  tab === "artifacts"
                    ? "bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-default)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] border border-transparent"
                }`}
              >
                <FileCode2 className="w-3 h-3" />
                <span>产物</span>
                <span className="text-[10px] font-mono text-[var(--text-muted)]">
                  {visibleArtifacts.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setTab("events")}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] text-xs font-medium transition-colors cursor-pointer shrink-0 ${
                  tab === "events"
                    ? "bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border-default)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] border border-transparent"
                }`}
              >
                <Activity className="w-3 h-3" />
                <span>事件</span>
              </button>
            </>
          )}
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="收起右侧栏"
            className="w-6 h-6 rounded-[var(--radius-xs)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Tab 1: Linear-style Pure Properties */}
      {tab === "details" && (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 text-xs select-text">
          {/* Core Run Properties */}
          <dl className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-muted)] font-mono text-[11px] shrink-0">状态</dt>
              <dd>
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium border ${statusStyle.badgeClass}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dotClass}`} />
                  {statusStyle.label}
                </span>
              </dd>
            </div>

            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-muted)] font-mono text-[11px] shrink-0">版本 / 触发</dt>
              <dd className="font-mono text-[11px] text-[var(--text-primary)]">
                v{run.pipelineVersion} · {run.createdBy}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-muted)] font-mono text-[11px] shrink-0">总耗时</dt>
              <dd className="font-mono text-[11px] text-[var(--text-primary)] tabular-nums">
                {formatDuration(totalDurationMs)}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-muted)] font-mono text-[11px] shrink-0">创建时间</dt>
              <dd className="font-mono text-[11px] text-[var(--text-secondary)] tabular-nums">
                {formatDateTime(run.createdAt)}
              </dd>
            </div>

            {run.finishedAt && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--text-muted)] font-mono text-[11px] shrink-0">结束时间</dt>
                <dd className="font-mono text-[11px] text-[var(--text-secondary)] tabular-nums">
                  {formatDateTime(run.finishedAt)}
                </dd>
              </div>
            )}

            {derived.workingBranch && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--text-muted)] font-mono text-[11px] shrink-0">分支</dt>
                <dd className="min-w-0">
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopy("branch", derived.workingBranch!, "分支名")
                    }
                    title={derived.workingBranch}
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--text-primary)] hover:underline cursor-pointer max-w-[180px]"
                  >
                    <GitBranch className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                    <span className="truncate">{derived.workingBranch}</span>
                    {copiedKey === "branch" ? (
                      <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                    ) : (
                      <Copy className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                    )}
                  </button>
                </dd>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-muted)] font-mono text-[11px] shrink-0">Worktree</dt>
              <dd className="font-mono text-[11px] text-[var(--text-secondary)]">
                {getWorkspaceStatusLabel(run.workspaceStatus)}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--text-muted)] font-mono text-[11px] shrink-0">Run ID</dt>
              <dd className="min-w-0">
                <button
                  type="button"
                  onClick={() => void handleCopy("runId", run.runId, " Run ID")}
                  title={run.runId}
                  className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer max-w-[180px]"
                >
                  <span className="truncate">{run.runId}</span>
                  {copiedKey === "runId" ? (
                    <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                  ) : (
                    <Copy className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  )}
                </button>
              </dd>
            </div>
          </dl>

          {/* External Links (auto-extracted from externalUrl + action data URLs) */}
          {derived.links.length > 0 && (
            <div className="pt-4 border-t border-[var(--border-subtle)] space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                关联链接
              </div>
              <div className="space-y-1.5">
                {derived.links.map((item) => (
                  <a
                    key={item.url}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={item.url}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-default)] hover:border-[var(--border-strong)] font-mono text-[11px] text-[var(--text-primary)] transition-colors"
                  >
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <Link2 className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </span>
                    <ExternalLink className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Rework Loop Counts */}
          {loopEntries.length > 0 && (
            <div className="pt-4 border-t border-[var(--border-subtle)] space-y-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                返工记录
              </div>
              <div className="space-y-1.5">
                {loopEntries.map(([edge, count]) => (
                  <div
                    key={edge}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-amber-500/8 border border-amber-500/20 font-mono text-[11px]"
                  >
                    <span className="inline-flex items-center gap-1.5 text-[var(--text-primary)] truncate">
                      <Repeat className="w-3 h-3 text-amber-500 shrink-0" />
                      <span className="truncate">{edge}</span>
                    </span>
                    <span className="text-amber-700 dark:text-amber-400 font-semibold shrink-0">
                      ×{count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Selected Stage Execution Metrics (only when inspecting a specific stage) */}
          {selectedNodeRun && (
            <div className="pt-4 border-t border-[var(--border-subtle)] space-y-2.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                当前阶段指标
              </div>
              <dl className="space-y-2 text-[11px] font-mono">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[var(--text-muted)]">阶段</dt>
                  <dd className="text-[var(--text-primary)] font-semibold">
                    {nodeNameById(selectedNodeRun.nodeId)} #{selectedNodeRun.attempt}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[var(--text-muted)]">阶段耗时</dt>
                  <dd className="text-[var(--text-secondary)] tabular-nums">
                    {formatDuration(selectedNodeRun.durationMs)}
                  </dd>
                </div>
                {selectedNodeRun.pollCount > 0 && (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[var(--text-muted)]">轮询次数</dt>
                    <dd className="text-[var(--text-secondary)] tabular-nums">
                      {selectedNodeRun.pollCount}
                    </dd>
                  </div>
                )}
                {sessionData?.session?.model && (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[var(--text-muted)] shrink-0">模型</dt>
                    <dd className="text-[var(--text-secondary)] inline-flex items-center gap-1 truncate max-w-[180px]">
                      <Cpu className="w-3 h-3 shrink-0" />
                      <span className="truncate">{sessionData.session.model}</span>
                    </dd>
                  </div>
                )}
                {sessionData?.usage && (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-[var(--text-muted)]">Token</dt>
                    <dd className="text-[var(--text-secondary)] tabular-nums">
                      {formatTokenCount(sessionData.usage.totalTokens)}
                      {cacheHitRate !== null ? ` (${cacheHitRate}% cache)` : ""}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {/* Collapsible Raw Data JSON */}
          {hasDataPayload && (
            <div className="pt-4 border-t border-[var(--border-subtle)] space-y-2">
              <button
                type="button"
                onClick={() => setShowInputJson((prev) => !prev)}
                className="w-full flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <span>Entry Data</span>
                {showInputJson ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
              {showInputJson && (
                <pre className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[10.5px] font-mono text-[var(--text-code)] overflow-x-auto max-h-60">
                  {JSON.stringify(run.data, null, 2)}
                </pre>
              )}
            </div>
          )}

          {/* Collapsible Raw Metadata JSON */}
          {hasMetadataPayload && (
            <div className="pt-4 border-t border-[var(--border-subtle)] space-y-2">
              <button
                type="button"
                onClick={() => setShowMetadataJson((prev) => !prev)}
                className="w-full flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <span>Metadata</span>
                {showMetadataJson ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
              {showMetadataJson && (
                <pre className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[10.5px] font-mono text-[var(--text-code)] overflow-x-auto max-h-60">
                  {JSON.stringify(run.metadata, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Compact Actions Audit List */}
      {tab === "actions" && (
        <div className="flex-1 overflow-y-auto p-3 space-y-2 select-text">
          {actions.length === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--text-muted)] font-mono">
              暂无流转记录
            </div>
          ) : (
            actions.map((act) => {
              const actStyle = getActionStyle(act.action);
              const summary =
                act.context.summary ||
                act.context.reason ||
                act.context.question ||
                act.context.humanNote;

              return (
                <div
                  key={act.recordId}
                  className="p-2.5 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-default)] space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] font-mono text-[var(--text-muted)]">
                        #{act.sequence}
                      </span>
                      <span
                        className={`px-1.5 py-0 rounded text-[10px] font-mono border ${actStyle.badgeClass}`}
                      >
                        {actStyle.label}
                      </span>
                    </div>
                    <span
                      className="text-[10px] font-mono text-[var(--text-muted)] shrink-0"
                      title={formatDateTime(act.createdAt)}
                    >
                      {formatTimeAgo(act.createdAt)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 text-[11px] font-mono text-[var(--text-secondary)]">
                    <span className="truncate">{nodeNameById(act.fromNodeId)}</span>
                    {act.toNodeId && act.toNodeId !== act.fromNodeId && (
                      <>
                        <ArrowRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                        <span className="text-[var(--text-primary)] font-medium truncate">
                          {nodeNameById(act.toNodeId)}
                        </span>
                      </>
                    )}
                  </div>

                  {summary && (
                    <p className="text-[11px] text-[var(--text-secondary)] line-clamp-2 leading-relaxed">
                      {summary}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Tab 3: Session Artifacts (Agent nodes only) */}
      {tab === "artifacts" && sessionData && (
        <div className="flex-1 overflow-y-auto p-3 space-y-2 select-text">
          {visibleArtifacts.length === 0 ? (
            <div className="py-10 text-center text-xs text-[var(--text-muted)] font-mono">
              当前阶段暂无生成产物
            </div>
          ) : (
            visibleArtifacts.map((art) => (
              <div
                key={art.id}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-card)] p-2.5 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[var(--text-primary)] truncate">
                    {art.path.split("/").pop()}
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">
                    {(art.sizeBytes / 1024).toFixed(1)} KB · {art.contentType}
                  </div>
                </div>
                <a
                  href={sessionsApi.getArtifactDownloadUrl(art.sessionId, art.id)}
                  target="_blank"
                  rel="noreferrer"
                  title="下载产物"
                  className="p-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                </a>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab 4: Runtime Events (Agent nodes only) */}
      {tab === "events" && sessionData && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden select-text">
          <div className="p-2.5 border-b border-[var(--border-subtle)] shrink-0">
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 absolute left-2.5 text-[var(--text-muted)] pointer-events-none" />
              <input
                type="text"
                placeholder="按事件类型过滤..."
                value={eventFilter}
                onChange={(e) => setEventFilter(e.target.value)}
                className="w-full bg-[var(--bg-input)] pl-8 pr-3 py-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] text-xs text-[var(--text-primary)] outline-hidden focus:border-[var(--border-focus)]"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5 font-mono">
            {filteredEvents.length === 0 ? (
              <div className="py-10 text-center text-xs text-[var(--text-muted)]">
                暂无匹配事件
              </div>
            ) : (
              filteredEvents.map((evt, idx) => {
                const isExpanded = !!expandedEvents[idx];
                return (
                  <div
                    key={evt.id || idx}
                    className="border border-[var(--border-subtle)] rounded-[var(--radius-sm)] bg-[var(--bg-card)] p-2 text-[11px]"
                  >
                    <button
                      type="button"
                      onClick={() => toggleEvent(idx)}
                      className="w-full flex items-center justify-between gap-2 cursor-pointer text-left"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <ChevronRight
                          className={`w-3 h-3 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                        />
                        <span className="font-semibold text-[var(--text-primary)] truncate">
                          {evt.type}
                        </span>
                      </div>
                      <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                        #{evt.sequence ?? idx + 1}
                      </span>
                    </button>
                    {isExpanded && (
                      <pre className="mt-2 pt-2 border-t border-[var(--border-subtle)] text-[10px] bg-[var(--bg-code)] p-2 rounded overflow-x-auto text-[var(--text-code)] max-h-48">
                        {JSON.stringify(evt.payload || {}, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
