import React, { useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  Link2,
  Repeat,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type {
  PipelineActionRecord,
  PipelineNodeRunRecord,
  PipelineNodeSnapshot,
  PipelineRunRecord,
} from "../../types";
import { copyToClipboard } from "../../utils/clipboard";
import { formatDateTime, formatDuration } from "../../utils/formatters";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { getActionStyle, getPipelineStatusStyle } from "./pipelineStatus";

export interface DerivedExternalLink {
  url: string;
  label: string;
  source: "external" | "action";
}

export interface DerivedRunLinks {
  links: DerivedExternalLink[];
  workingBranch?: string;
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
}

function formatLinkKeyLabel(key: string, data: Record<string, unknown>): string {
  if (/^pr[-_]?url$/i.test(key) && typeof data.prNumber === "number") {
    return `PR #${data.prNumber}`;
  }
  const cleaned = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\burl\b/gi, "")
    .trim();
  if (!cleaned) return "Link";
  return cleaned
    .split(/\s+/)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

export function extractDerivedRunLinks(
  run: PipelineRunRecord,
  actions: PipelineActionRecord[],
): DerivedRunLinks {
  const links: DerivedExternalLink[] = [];
  const seenUrls = new Set<string>();
  let workingBranch: string | undefined;

  if (isHttpUrl(run.externalUrl)) {
    const normalized = run.externalUrl.trim();
    seenUrls.add(normalized);
    links.push({
      url: normalized,
      label: run.externalKey?.trim() || "External Link",
      source: "external",
    });
  }

  for (let i = actions.length - 1; i >= 0; i--) {
    const data = actions[i]?.context?.data;
    if (!data || typeof data !== "object") continue;

    if (!workingBranch && typeof data.branch === "string" && data.branch.trim()) {
      workingBranch = data.branch.trim();
    }

    if (Array.isArray(data.links)) {
      for (const item of data.links) {
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          if (isHttpUrl(rec.url)) {
            const url = rec.url.trim();
            if (!seenUrls.has(url)) {
              seenUrls.add(url);
              links.push({
                url,
                label:
                  typeof rec.label === "string" && rec.label.trim() ? rec.label.trim() : "Link",
                source: "action",
              });
            }
          }
        }
      }
    }

    for (const [key, val] of Object.entries(data)) {
      if (!isHttpUrl(val)) continue;
      const url = val.trim();
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      links.push({
        url,
        label: formatLinkKeyLabel(key, data),
        source: "action",
      });
    }
  }

  return {
    links,
    workingBranch: workingBranch ?? run.branchName,
  };
}

interface PipelineOverviewPanelProps {
  run: PipelineRunRecord;
  nodes: PipelineNodeSnapshot[];
  nodeRuns: PipelineNodeRunRecord[];
  actions: PipelineActionRecord[];
  totalDurationMs?: number;
  onInspectNodeRun: (nodeRunId: string) => void;
}

export function PipelineOverviewPanel({
  run,
  nodes,
  nodeRuns,
  actions,
  totalDurationMs,
  onInspectNodeRun,
}: PipelineOverviewPanelProps) {
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [copiedBranch, setCopiedBranch] = useState(false);

  const statusStyle = getPipelineStatusStyle(run.status);
  const derived = useMemo(() => extractDerivedRunLinks(run, actions), [run, actions]);

  const totalReworks = useMemo(
    () => Object.values(run.loopCounts ?? {}).reduce((sum, n) => sum + n, 0),
    [run.loopCounts],
  );

  const nodeRunIdSet = useMemo(() => new Set(nodeRuns.map((nr) => nr.nodeRunId)), [nodeRuns]);

  const nodeNameById = (id?: string) => {
    if (!id) return "";
    return nodes.find((n) => n.id === id)?.name ?? id;
  };

  const toggleAction = (recordId: string) => {
    setExpandedActions((prev) => ({ ...prev, [recordId]: !prev[recordId] }));
  };

  const handleCopyBranch = async () => {
    if (!derived.workingBranch) return;
    const ok = await copyToClipboard(derived.workingBranch);
    if (ok) {
      setCopiedBranch(true);
      setTimeout(() => setCopiedBranch(false), 1600);
      toast.success("已复制分支名");
    }
  };

  const latestActionSummary = useMemo(() => {
    for (let i = actions.length - 1; i >= 0; i--) {
      const s = actions[i].context.summary || actions[i].context.reason;
      if (s) return s;
    }
    return run.statusSummary;
  }, [actions, run.statusSummary]);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-[var(--bg-canvas)] select-text">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {/* 1. Delivery & Status Summary Card */}
        <section className="rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] p-5 space-y-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div
                className={`w-8 h-8 rounded-[var(--radius-sm)] border flex items-center justify-center shrink-0 mt-0.5 ${statusStyle.badgeClass}`}
              >
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${statusStyle.badgeClass}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dotClass}`} />
                    {statusStyle.label}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[var(--text-muted)] tabular-nums">
                    <Clock className="w-3 h-3" />
                    {formatDuration(totalDurationMs)}
                  </span>
                  {totalReworks > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10.5px] font-mono bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                      <Repeat className="w-2.5 h-2.5" />
                      {totalReworks} 次返工
                    </span>
                  )}
                </div>
                {latestActionSummary && (
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                    {latestActionSummary}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Quick Deliverable Links */}
          {(derived.links.length > 0 || derived.workingBranch) && (
            <div className="pt-3 border-t border-[var(--border-subtle)] flex flex-wrap items-center gap-2">
              {derived.links.map((item) => (
                <a
                  key={item.url}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={item.url}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-mono border transition-colors max-w-[280px] ${
                    item.source === "action"
                      ? "bg-blue-500/8 border-blue-500/25 hover:border-blue-500/45 text-blue-700 dark:text-blue-300"
                      : "bg-[var(--bg-card)] border-[var(--border-default)] hover:border-[var(--border-strong)] text-[var(--text-primary)]"
                  }`}
                >
                  <Link2 className="w-3 h-3 opacity-70 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  <ExternalLink className="w-3 h-3 opacity-60 shrink-0" />
                </a>
              ))}

              {derived.workingBranch && (
                <button
                  type="button"
                  onClick={() => void handleCopyBranch()}
                  title="点击复制分支名"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-card)] border border-[var(--border-default)] hover:border-[var(--border-strong)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer max-w-[320px]"
                >
                  <GitBranch className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  <span className="truncate">{derived.workingBranch}</span>
                  {copiedBranch ? (
                    <Check className="w-3 h-3 text-emerald-500 shrink-0" />
                  ) : (
                    <Copy className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  )}
                </button>
              )}
            </div>
          )}
        </section>

        {/* 2. Requirement / Description (full Markdown rendering) */}
        {run.description && (
          <section className="space-y-2.5">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              需求背景
            </h2>
            <div className="rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] p-5 text-[13.5px] leading-relaxed">
              <MarkdownRenderer content={run.description} />
            </div>
          </section>
        )}

        {/* 3. Full Execution Timeline (with in-place expandable handoff docs) */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              流转时间线 ({actions.length})
            </h2>
          </div>

          {actions.length === 0 ? (
            <div className="p-6 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] text-center text-xs font-mono text-[var(--text-muted)]">
              尚无阶段流转记录
            </div>
          ) : (
            <div className="relative pl-5 space-y-3 before:content-[''] before:absolute before:left-[7px] before:top-3 before:bottom-3 before:w-px before:bg-[var(--border-default)]">
              {actions.map((act) => {
                const actStyle = getActionStyle(act.action);
                const isRework =
                  act.action === "pipeline_prev" || act.action === "human_reject";
                const isFail = act.action === "pipeline_fail";
                const isExpanded = !!expandedActions[act.recordId];
                const canInspect = Boolean(act.nodeRunId && nodeRunIdSet.has(act.nodeRunId));

                const hasExpandableBody = Boolean(
                  act.context.content ||
                    act.context.feedback ||
                    act.context.humanNote ||
                    (act.context.artifacts && act.context.artifacts.length > 0),
                );

                const headline =
                  act.context.summary ||
                  act.context.reason ||
                  act.context.question ||
                  act.context.humanNote;

                return (
                  <div key={act.recordId} className="relative">
                    {/* Timeline Node Dot */}
                    <span
                      className={`absolute -left-5 top-4 w-3.5 h-3.5 rounded-full border-2 border-[var(--bg-canvas)] ${
                        isFail
                          ? "bg-red-500"
                          : isRework
                            ? "bg-amber-500"
                            : "bg-emerald-500"
                      }`}
                    />

                    <div
                      className={`rounded-[var(--radius-md)] border bg-[var(--bg-card)] overflow-hidden ${
                        isRework
                          ? "border-amber-500/30"
                          : isFail
                            ? "border-red-500/30"
                            : "border-[var(--border-default)]"
                      }`}
                    >
                      <div className="px-4 py-3 space-y-2">
                        {/* Header row */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                              #{act.sequence}
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${actStyle.badgeClass}`}
                            >
                              {actStyle.label}
                            </span>
                            <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-[var(--text-primary)] font-medium">
                              <span>{nodeNameById(act.fromNodeId)}</span>
                              {act.toNodeId && act.toNodeId !== act.fromNodeId && (
                                <>
                                  <ArrowRight className="w-3 h-3 text-[var(--text-muted)]" />
                                  <span>{nodeNameById(act.toNodeId)}</span>
                                </>
                              )}
                            </span>
                            {act.attempt > 1 && (
                              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                                try #{act.attempt}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2.5 text-[11px] font-mono text-[var(--text-muted)]">
                            <span className="tabular-nums">
                              {formatDateTime(act.createdAt)}
                            </span>
                            {canInspect && act.nodeRunId && (
                              <button
                                type="button"
                                onClick={() => onInspectNodeRun(act.nodeRunId!)}
                                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 cursor-pointer"
                              >
                                查看过程
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Headline Summary / Reason */}
                        {headline && (
                          <p className="text-xs text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">
                            {headline}
                          </p>
                        )}

                        {/* Expand button for full Markdown handoff / feedback */}
                        {hasExpandableBody && (
                          <button
                            type="button"
                            onClick={() => toggleAction(act.recordId)}
                            className="inline-flex items-center gap-1 text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer pt-0.5"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {isExpanded
                                ? "收起详情"
                                : act.context.feedback
                                  ? "展开打回反馈"
                                  : "展开交接文档"}
                            </span>
                          </button>
                        )}
                      </div>

                      {/* Expanded Rich Handoff / Feedback Body */}
                      {isExpanded && hasExpandableBody && (
                        <div className="px-4 py-3.5 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)] space-y-3 text-xs">
                          {act.context.feedback && (
                            <div className="space-y-1">
                              <div className="font-mono text-[10px] uppercase text-amber-700 dark:text-amber-400">
                                Rework Feedback
                              </div>
                              <div className="text-[13px] leading-relaxed">
                                <MarkdownRenderer content={act.context.feedback} />
                              </div>
                            </div>
                          )}

                          {act.context.humanNote && (
                            <div className="space-y-1">
                              <div className="font-mono text-[10px] uppercase text-[var(--text-muted)]">
                                Human Note
                              </div>
                              <p className="text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
                                {act.context.humanNote}
                              </p>
                            </div>
                          )}

                          {act.context.content && (
                            <div className="text-[13px] leading-relaxed">
                              <MarkdownRenderer content={act.context.content} />
                            </div>
                          )}

                          {act.context.artifacts && act.context.artifacts.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              {act.context.artifacts.map((art) => (
                                <span
                                  key={art}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border-default)] font-mono text-[10.5px] text-[var(--text-secondary)]"
                                >
                                  <FileCode2 className="w-3 h-3 text-[var(--text-muted)]" />
                                  {art}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
