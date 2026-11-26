import React from "react";
import { CheckCircle2, FileCode2, ShieldCheck, Undo2 } from "lucide-react";
import type {
  PipelineActionRecord,
  PipelineNodeRunRecord,
  PipelineNodeSnapshot,
} from "../../types";
import { formatDateTime } from "../../utils/formatters";
import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { getPipelineStatusStyle } from "./pipelineStatus";

interface PipelineHumanNodePanelProps {
  nodeRun: PipelineNodeRunRecord;
  nodeSnapshot?: PipelineNodeSnapshot;
  triggerAction?: PipelineActionRecord;
  isActive: boolean;
  canApprove: boolean;
  canReject: boolean;
  onApprove: () => void;
  onReject: () => void;
}

export function PipelineHumanNodePanel({
  nodeRun,
  nodeSnapshot,
  triggerAction,
  isActive,
  canApprove,
  canReject,
  onApprove,
  onReject,
}: PipelineHumanNodePanelProps) {
  const statusStyle = getPipelineStatusStyle(nodeRun.status);
  const ctx = triggerAction?.context;
  const contentMarkdown = ctx?.content ?? ctx?.feedback;
  const summary = ctx?.summary ?? nodeRun.outputSummary;
  const question = ctx?.question;
  const artifacts = ctx?.artifacts ?? [];
  const data = ctx?.data;

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-canvas)] select-text">
      <div className="max-w-3xl mx-auto p-6 space-y-5">
        {/* Header Card */}
        <div className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-[var(--radius-sm)] bg-violet-500/10 border border-violet-500/25 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {nodeSnapshot?.name ?? nodeRun.nodeId}
                </h2>
                <div className="text-[11px] font-mono text-[var(--text-muted)]">
                  Human Checkpoint · Attempt #{nodeRun.attempt} ·{" "}
                  {formatDateTime(nodeRun.createdAt)}
                </div>
              </div>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${statusStyle.badgeClass}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${statusStyle.dotClass}`} />
              {statusStyle.label}
            </span>
          </div>

          {question && (
            <div className="p-3.5 rounded-[var(--radius-sm)] bg-violet-500/8 border border-violet-500/20 text-xs text-[var(--text-primary)] leading-relaxed">
              <div className="text-[10px] font-mono uppercase tracking-wider text-violet-700 dark:text-violet-400 mb-1">
                Confirmation Prompt
              </div>
              {question}
            </div>
          )}

          {summary && (
            <div className="text-xs text-[var(--text-secondary)] leading-relaxed">{summary}</div>
          )}

          {isActive && nodeRun.status === "waiting_confirmation" && (canApprove || canReject) && (
            <div className="pt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)]">
              {canApprove && (
                <button
                  type="button"
                  onClick={onApprove}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Approve & Advance</span>
                </button>
              )}
              {canReject && (
                <button
                  type="button"
                  onClick={onReject}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/20 transition-colors cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  <span>Reject & Rework</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Upstream Handoff Markdown */}
        {contentMarkdown && (
          <div className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-3">
            <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
              Upstream Handoff
              {triggerAction ? ` · from ${triggerAction.fromNodeId}` : ""}
            </div>
            <div className="text-sm text-[var(--text-primary)]">
              <MarkdownRenderer content={contentMarkdown} />
            </div>
          </div>
        )}

        {/* Artifacts */}
        {artifacts.length > 0 && (
          <div className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-2.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
              Referenced Artifacts ({artifacts.length})
            </div>
            <div className="flex flex-wrap gap-2">
              {artifacts.map((art) => (
                <span
                  key={art}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-card)] border border-[var(--border-default)] text-xs font-mono text-[var(--text-primary)]"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  {art}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Structured Data */}
        {data && Object.keys(data).length > 0 && (
          <div className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-2.5">
            <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
              Structured Payload
            </div>
            <pre className="p-3 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-code)] overflow-x-auto">
              {JSON.stringify(data, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
