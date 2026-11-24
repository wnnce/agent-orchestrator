import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  FileCode,
  Info,
  ChevronDown,
  ChevronRight,
  Download,
  Search,
  Timer,
  Ban,
  Clock,
} from "lucide-react";
import { cancelScheduledJob, fetchScheduledJobs } from "../api/client";
import { useConfirm } from "../context/ConfirmContext";
import type {
  ArtifactRecord,
  ProjectRouting,
  RuntimeEvent,
  ScheduledJobRecord,
  SessionRoute,
  SessionUsageSummary,
} from "../types";
import {
  calculateCacheHitRate,
  formatDateTime,
  formatJobStatus,
  formatTokenCount,
} from "../utils/formatters";
import { Badge } from "./common/Badge";
import { Button } from "./common/Button";

interface InspectorProps {
  events: RuntimeEvent[];
  artifacts: ArtifactRecord[];
  session: SessionRoute | null;
  project: ProjectRouting | null;
  usage?: SessionUsageSummary | null;
}

export const Inspector: React.FC<InspectorProps> = ({
  events,
  artifacts,
  session,
  project,
  usage = null,
}) => {
  const confirm = useConfirm();
  const [tab, setTab] = useState<"events" | "artifacts" | "jobs" | "info">("artifacts");
  const [expandedEvents, setExpandedEvents] = useState<Record<number, boolean>>({});
  const [filter, setFilter] = useState("");
  const [jobs, setJobs] = useState<ScheduledJobRecord[]>([]);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);

  const visibleArtifacts = useMemo(
    () => artifacts.filter((art) => art.kind !== "agent-message"),
    [artifacts],
  );

  const loadSessionJobs = async () => {
    if (!session) return;
    try {
      const list = await fetchScheduledJobs({ sessionId: session.sessionId });
      setJobs(list);
    } catch (err) {
      console.error("Failed to load session jobs in inspector:", err);
    }
  };

  useEffect(() => {
    loadSessionJobs();
  }, [session?.sessionId]);

  const toggleEvent = (idx: number) => {
    setExpandedEvents((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const handleCancelJob = async (jobId: string) => {
    const ok = await confirm({
      title: "Cancel Scheduled Job",
      description: `Are you sure you want to cancel scheduled job ${jobId}?`,
      confirmText: "Cancel Job",
      variant: "destructive",
    });
    if (!ok) return;

    setCancellingJobId(jobId);
    try {
      await cancelScheduledJob(jobId);
      toast.success("Job cancelled successfully");
      await loadSessionJobs();
    } catch (err: any) {
      toast.error(`Cancel failed: ${err.message || String(err)}`);
    } finally {
      setCancellingJobId(null);
    }
  };

  const filteredEvents = events.filter((e) =>
    e.type.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <aside className="w-full h-full bg-[var(--bg-inspector)] flex flex-col shrink-0 text-xs">
      {/* Tabs */}
      <div className="flex border-b border-[var(--border-default)] bg-[var(--bg-surface)]">
        <button
          onClick={() => setTab("events")}
          className={`flex-1 py-2.5 font-medium flex items-center justify-center gap-1 border-b-2 transition cursor-pointer ${
            tab === "events"
              ? "border-[var(--primary)] text-[var(--primary-text)] bg-[var(--bg-surface-hover)]"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>事件 ({events.length})</span>
        </button>

        <button
          onClick={() => setTab("artifacts")}
          className={`flex-1 py-2.5 font-medium flex items-center justify-center gap-1 border-b-2 transition cursor-pointer ${
            tab === "artifacts"
              ? "border-[var(--primary)] text-[var(--primary-text)] bg-[var(--bg-surface-hover)]"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <FileCode className="w-3.5 h-3.5" />
          <span>产物 ({visibleArtifacts.length})</span>
        </button>

        <button
          onClick={() => setTab("jobs")}
          className={`flex-1 py-2.5 font-medium flex items-center justify-center gap-1 border-b-2 transition cursor-pointer ${
            tab === "jobs"
              ? "border-[var(--primary)] text-[var(--primary-text)] bg-[var(--bg-surface-hover)]"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Timer className="w-3.5 h-3.5" />
          <span>延时 ({jobs.length})</span>
        </button>

        <button
          onClick={() => setTab("info")}
          className={`px-3 py-2.5 font-medium flex items-center justify-center gap-1 border-b-2 transition cursor-pointer ${
            tab === "info"
              ? "border-[var(--primary)] text-[var(--primary-text)] bg-[var(--bg-surface-hover)]"
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tab: Events */}
      {tab === "events" && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="p-2 border-b border-[var(--border-default)]">
            <div className="relative flex items-center">
              <Search className="w-3.5 h-3.5 absolute left-2.5 text-[var(--text-muted)]" />
              <input
                type="text"
                placeholder="按类型过滤事件..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full bg-[var(--bg-input)] pl-8 pr-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] text-xs text-[var(--text-primary)] outline-hidden focus:border-[var(--primary)]"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 font-mono">
            {filteredEvents.length === 0 ? (
              <div className="text-center py-8 text-[var(--text-muted)]">
                暂无匹配事件
              </div>
            ) : (
              filteredEvents.map((evt, idx) => {
                const isExpanded = !!expandedEvents[idx];
                return (
                  <div
                    key={evt.id || idx}
                    className="border border-[var(--border-subtle)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] p-2 text-[11px]"
                  >
                    <div
                      className="flex items-center justify-between cursor-pointer select-none"
                      onClick={() => toggleEvent(idx)}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                        )}
                        <span className="font-semibold text-[var(--text-primary)] truncate">
                          {evt.type}
                        </span>
                      </div>
                      <span className="text-[10px] text-[var(--text-muted)]">
                        #{evt.sequence ?? idx + 1}
                      </span>
                    </div>

                    {isExpanded && (
                      <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                        <pre className="text-[10px] bg-[var(--bg-code)] p-1.5 rounded overflow-x-auto text-[var(--text-code)] max-h-48">
                          {JSON.stringify(evt.payload || {}, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Tab: Artifacts */}
      {tab === "artifacts" && (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {visibleArtifacts.length === 0 ? (
            <div className="text-center py-8 text-[var(--text-muted)]">
              当前会话暂无生成产物
            </div>
          ) : (
            visibleArtifacts.map((art) => (
              <div
                key={art.id}
                className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--bg-surface)] p-2.5 flex items-center justify-between gap-2"
              >
                <div className="truncate">
                  <div className="font-semibold text-xs text-[var(--text-primary)] truncate">
                    {art.path.split("/").pop()}
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] font-mono">
                    {(art.sizeBytes / 1024).toFixed(1)} KB | {art.contentType}
                  </div>
                </div>
                <a
                  href={`/sessions/${encodeURIComponent(art.sessionId)}/artifacts/${encodeURIComponent(art.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="p-1.5 rounded bg-[var(--bg-surface-elevated)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-default)] text-[var(--text-secondary)]"
                  title="查看/下载产物"
                >
                  <Download className="w-3.5 h-3.5" />
                </a>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab: Jobs */}
      {tab === "jobs" && (
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          {jobs.length === 0 ? (
            <div className="text-center py-8 text-[var(--text-muted)]">
              此会话暂未调度延迟任务
            </div>
          ) : (
            jobs.map((job) => {
              const statusInfo = formatJobStatus(job.status);
              const isPending = job.status === 1;
              return (
                <div
                  key={job.jobId}
                  className="border border-[var(--border-default)] rounded-[var(--radius-md)] bg-[var(--bg-surface)] p-2.5 space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[var(--text-primary)] truncate">
                      {job.name}
                    </span>
                    <Badge variant={statusInfo.variant} size="xs" dot={isPending}>
                      {statusInfo.label}
                    </Badge>
                  </div>
                  <p className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-code)] p-1.5 rounded">
                    "{job.prompt}"
                  </p>
                  <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] pt-1 border-t border-[var(--border-subtle)]">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-[var(--primary)]" />
                      <span>{formatDateTime(job.triggerAt)}</span>
                    </div>
                    {isPending && (
                      <Button
                        variant="danger"
                        size="xs"
                        loading={cancellingJobId === job.jobId}
                        onClick={() => handleCancelJob(job.jobId)}
                      >
                        取消
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Tab: Info */}
      {tab === "info" && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* Model Usage & Context Summary */}
          <div>
            <h4 className="font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
              模型用量 (Usage)
            </h4>
            {usage ? (
              (() => {
                const hitRate = calculateCacheHitRate(usage);
                const ctxRatio =
                  usage.contextUsedTokens !== undefined &&
                  usage.contextWindowTokens !== undefined &&
                  usage.contextWindowTokens > 0
                    ? Math.min(100, (usage.contextUsedTokens / usage.contextWindowTokens) * 100)
                    : null;
                return (
                  <div className="space-y-2.5 font-mono text-[11px] bg-[var(--bg-surface)] p-2.5 rounded-[var(--radius-md)] border border-[var(--border-default)]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[var(--text-muted)]">累计总计</span>
                      <span className="text-[var(--text-primary)] font-semibold">
                        {formatTokenCount(usage.totalTokens)} tokens ({usage.turnCount} 轮)
                      </span>
                    </div>
                    {usage.lastModel && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[var(--text-muted)]">最近模型</span>
                        <span className="text-[var(--text-primary)] truncate" title={usage.lastModel}>
                          {usage.lastModel}
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1.5 border-t border-[var(--border-subtle)] text-[10.5px]">
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">新输入</span>
                        <span className="text-[var(--text-primary)]">
                          {formatTokenCount(usage.inputTokens)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">缓存读</span>
                        <span className="text-emerald-500">
                          {formatTokenCount(usage.cacheReadTokens)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">缓存写</span>
                        <span className="text-[var(--text-primary)]">
                          {formatTokenCount(usage.cacheWriteTokens)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">输出</span>
                        <span className="text-[var(--text-primary)]">
                          {formatTokenCount(usage.outputTokens)}
                        </span>
                      </div>
                      {usage.reasoningTokens > 0 && (
                        <div className="flex justify-between">
                          <span className="text-[var(--text-muted)]">思考</span>
                          <span className="text-[var(--text-primary)]">
                            {formatTokenCount(usage.reasoningTokens)}
                          </span>
                        </div>
                      )}
                      {hitRate !== null && (
                        <div className="flex justify-between">
                          <span className="text-[var(--text-muted)]">命中率</span>
                          <span className="text-emerald-500 font-semibold">{hitRate}%</span>
                        </div>
                      )}
                    </div>
                    {ctxRatio !== null &&
                      usage.contextUsedTokens !== undefined &&
                      usage.contextWindowTokens !== undefined && (
                        <div className="pt-1.5 border-t border-[var(--border-subtle)] space-y-1">
                          <div className="flex items-center justify-between text-[10.5px]">
                            <span className="text-[var(--text-muted)]">上下文水位</span>
                            <span className="text-[var(--text-primary)]">
                              {formatTokenCount(usage.contextUsedTokens)} /{" "}
                              {formatTokenCount(usage.contextWindowTokens)} ({ctxRatio.toFixed(1)}%)
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-[var(--bg-code)] overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                ctxRatio >= 85
                                  ? "bg-red-500"
                                  : ctxRatio >= 65
                                    ? "bg-amber-500"
                                    : "bg-emerald-500"
                              }`}
                              style={{ width: `${Math.max(2, ctxRatio)}%` }}
                            />
                          </div>
                        </div>
                      )}
                  </div>
                );
              })()
            ) : (
              <div className="font-mono text-[11px] text-[var(--text-muted)] bg-[var(--bg-surface)] p-2.5 rounded-[var(--radius-md)] border border-[var(--border-default)]">
                暂无用量记录
              </div>
            )}
          </div>

          <div>
            <h4 className="font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
              当前会话 (Session)
            </h4>
            <div className="space-y-1.5 font-mono text-[11px] bg-[var(--bg-surface)] p-2.5 rounded-[var(--radius-md)] border border-[var(--border-default)]">
              <div>
                <span className="text-[var(--text-muted)]">ID: </span>
                <span className="text-[var(--text-primary)] break-all">
                  {session?.sessionId || "-"}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">状态: </span>
                <span className="text-[var(--text-primary)]">{session?.status || "-"}</span>
              </div>
              {session?.runtime && session.runtime !== "unknown" && (
                <div>
                  <span className="text-[var(--text-muted)]">Runtime: </span>
                  <span className="text-[var(--text-primary)]">{session.runtime}</span>
                </div>
              )}
              {session?.model && (
                <div>
                  <span className="text-[var(--text-muted)]">模型: </span>
                  <span className="text-[var(--text-primary)] break-all">{session.model}</span>
                </div>
              )}
              {session?.reasoningEffort && (
                <div>
                  <span className="text-[var(--text-muted)]">思考强度: </span>
                  <span className="text-[var(--text-primary)]">{session.reasoningEffort}</span>
                </div>
              )}
              <div>
                <span className="text-[var(--text-muted)]">创建时间: </span>
                <span className="text-[var(--text-primary)]">
                  {formatDateTime(session?.createdAt)}
                </span>
              </div>
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
              所属项目 (Project)
            </h4>
            <div className="space-y-1.5 text-xs bg-[var(--bg-surface)] p-2.5 rounded-[var(--radius-md)] border border-[var(--border-default)]">
              <div>
                <span className="text-[var(--text-muted)]">名称: </span>
                <span className="text-[var(--text-primary)] font-medium">
                  {project?.displayName || project?.projectId || "-"}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">ID: </span>
                <code className="text-[var(--text-primary)] font-mono text-[11px]">
                  {project?.projectId || "-"}
                </code>
              </div>
              <p className="text-[11px] text-[var(--text-secondary)] mt-1">
                {project?.summary || ""}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Compact persistent usage footer strip */}
      {usage && tab !== "info" && (
        <button
          type="button"
          onClick={() => setTab("info")}
          className="border-t border-[var(--border-default)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] px-3 py-2 flex items-center justify-between gap-2 text-[10.5px] font-mono text-[var(--text-muted)] transition-colors cursor-pointer select-none"
          title="查看会话模型用量详情"
        >
          <span className="truncate">
            Total <strong className="text-[var(--text-primary)]">{formatTokenCount(usage.totalTokens)}</strong>
            {(() => {
              const rate = calculateCacheHitRate(usage);
              return rate !== null && usage.cacheReadTokens > 0 ? (
                <span className="text-emerald-500 ml-1.5">· Cache {rate}%</span>
              ) : null;
            })()}
          </span>
          {usage.contextUsedTokens !== undefined &&
            usage.contextWindowTokens !== undefined &&
            usage.contextWindowTokens > 0 && (
              <span className="shrink-0 text-[var(--text-secondary)]">
                Ctx {Math.min(100, Math.round((usage.contextUsedTokens / usage.contextWindowTokens) * 100))}%
              </span>
            )}
        </button>
      )}
    </aside>
  );
};
