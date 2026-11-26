import React, { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, m } from "motion/react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Undo2,
  X,
  XOctagon,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, pipelinesApi } from "../../api";
import { queryKeys } from "../../queries";
import type {
  PipelineNodeRunRecord,
  PipelineNodeSnapshot,
  PipelineRunRecord,
} from "../../types";
import { EASE_OUT_EXPO } from "../../utils/motion";

export type PipelineActionModalKind = "approve" | "reject" | "retry" | "cancel";

interface PipelineActionModalProps {
  kind: PipelineActionModalKind | null;
  run: PipelineRunRecord;
  currentNode?: PipelineNodeSnapshot;
  activeNodeRun?: PipelineNodeRunRecord;
  nodes: PipelineNodeSnapshot[];
  onClose: () => void;
  onSuccess: (updatedRun: PipelineRunRecord) => void;
}

export function PipelineActionModal({
  kind,
  run,
  currentNode,
  activeNodeRun,
  nodes,
  onClose,
  onSuccess,
}: PipelineActionModalProps) {
  const qc = useQueryClient();
  const [humanNote, setHumanNote] = useState("");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [targetNodeId, setTargetNodeId] = useState("");
  const [preserveStepState, setPreserveStepState] = useState(true);

  const prevTargets = currentNode?.prevTargets ?? [];
  const isTsNode = activeNodeRun?.executorType === "ts" || currentNode?.executor === "ts";

  const actionMutation = useMutation({
    mutationFn: async (actionKind: PipelineActionModalKind): Promise<PipelineRunRecord> => {
      if (actionKind === "approve") {
        return pipelinesApi.approveRun(run.runId, {
          humanNote: humanNote.trim() || undefined,
          actorId: "studio-ui",
        });
      }
      if (actionKind === "reject") {
        return pipelinesApi.rejectRun(run.runId, {
          reason: reason.trim(),
          feedback: feedback.trim(),
          targetNodeId: targetNodeId || undefined,
          actorId: "studio-ui",
        });
      }
      if (actionKind === "retry") {
        return pipelinesApi.retryRun(run.runId, {
          preserveStepState: isTsNode ? preserveStepState : undefined,
          actorId: "studio-ui",
        });
      }
      return pipelinesApi.cancelRun(run.runId, {
        reason: reason.trim() || undefined,
        actorId: "studio-ui",
      });
    },
    onSuccess: async (updated, actionKind) => {
      if (actionKind === "approve") toast.success("Approved — advancing pipeline");
      else if (actionKind === "reject") toast.success("Rejected — routed back for rework");
      else if (actionKind === "retry") toast.success("Retry queued");
      else toast.success("Pipeline run cancelled");

      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.pipelineRun(run.runId) }),
        qc.invalidateQueries({ queryKey: queryKeys.pipelineRunActions(run.runId) }),
        qc.invalidateQueries({
          queryKey: queryKeys.pipelineRunsScope(run.projectId, run.pipelineId),
        }),
        qc.invalidateQueries({ queryKey: queryKeys.pipelines(run.projectId) }),
      ]);
      onSuccess(updated);
      onClose();
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Operation failed";
      toast.error(msg);
    },
  });

  const submitting = actionMutation.isPending;

  useEffect(() => {
    if (!kind) return;
    setHumanNote("");
    setReason("");
    setFeedback("");
    setTargetNodeId(prevTargets[0] ?? "");
    setPreserveStepState(true);
  }, [kind, currentNode?.id]);

  useEffect(() => {
    if (!kind) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [kind, submitting, onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!kind || submitting) return;

    if (kind === "reject" && (!reason.trim() || !feedback.trim())) {
      toast.error("Please provide both a rejection reason and feedback");
      return;
    }

    actionMutation.mutate(kind);
  };

  const nodeNameById = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;

  return (
    <AnimatePresence>
      {kind && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={() => !submitting && onClose()}
          className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-4"
        >
          <m.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: EASE_OUT_EXPO }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-xl overflow-hidden"
          >
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-[var(--border-default)] bg-[var(--bg-card)] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {kind === "approve" && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                )}
                {kind === "reject" && <Undo2 className="w-4 h-4 text-amber-500 shrink-0" />}
                {kind === "retry" && <RotateCcw className="w-4 h-4 text-blue-500 shrink-0" />}
                {kind === "cancel" && <XOctagon className="w-4 h-4 text-red-500 shrink-0" />}
                <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                  {kind === "approve" && "Approve & Advance"}
                  {kind === "reject" && "Reject & Send Back"}
                  {kind === "retry" && "Retry Failed Node"}
                  {kind === "cancel" && "Cancel Pipeline Run"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => !submitting && onClose()}
                className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="p-5 space-y-4">
                {kind === "approve" && (
                  <>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                      Approve node{" "}
                      <span className="font-mono font-medium text-[var(--text-primary)]">
                        {currentNode?.name ?? run.currentNodeId}
                      </span>{" "}
                      and advance the run to the next stage.
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                        Approval Note{" "}
                        <span className="text-[var(--text-muted)] font-normal">(optional)</span>
                      </label>
                      <textarea
                        rows={3}
                        value={humanNote}
                        onChange={(e) => setHumanNote(e.target.value)}
                        placeholder="Optional guidance or notes forwarded to the next node..."
                        autoFocus
                        className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors resize-y"
                      />
                    </div>
                  </>
                )}

                {kind === "reject" && (
                  <>
                    {prevTargets.length > 0 && (
                      <div>
                        <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                          Target Rework Node
                        </label>
                        <div className="flex flex-wrap gap-1.5">
                          {prevTargets.map((id) => {
                            const selected = targetNodeId === id;
                            return (
                              <button
                                key={id}
                                type="button"
                                onClick={() => setTargetNodeId(id)}
                                className={`px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-mono border transition-colors cursor-pointer ${
                                  selected
                                    ? "bg-[var(--bg-surface-elevated)] border-[var(--border-focus)] text-[var(--text-primary)] font-semibold"
                                    : "bg-[var(--bg-card)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                                }`}
                              >
                                {nodeNameById(id)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                        Reason <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Short summary of why this stage is rejected"
                        autoFocus
                        className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                        Actionable Feedback <span className="text-red-500">*</span>
                      </label>
                      <textarea
                        rows={4}
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        placeholder="Detailed feedback passed to the rework node..."
                        className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors resize-y"
                      />
                    </div>
                  </>
                )}

                {kind === "retry" && (
                  <>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                      Re-queue node{" "}
                      <span className="font-mono font-medium text-[var(--text-primary)]">
                        {currentNode?.name ?? run.currentNodeId}
                      </span>{" "}
                      with a new execution attempt.
                    </p>
                    {isTsNode && (
                      <label className="flex items-start gap-2.5 p-3 rounded-[var(--radius-sm)] bg-[var(--bg-card)] border border-[var(--border-default)] cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={preserveStepState}
                          onChange={(e) => setPreserveStepState(e.target.checked)}
                          className="mt-0.5 accent-[var(--primary)] cursor-pointer"
                        />
                        <div className="space-y-0.5">
                          <div className="text-xs font-medium text-[var(--text-primary)]">
                            Preserve cached step state
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                            Keep completed <code className="font-mono">ctx.step</code> &{" "}
                            <code className="font-mono">waitUntil</code> results so side effects
                            (like creating a PR) are not re-executed.
                          </div>
                        </div>
                      </label>
                    )}
                  </>
                )}

                {kind === "cancel" && (
                  <>
                    <div className="flex items-start gap-2.5 p-3 rounded-[var(--radius-sm)] bg-red-500/8 border border-red-500/20 text-xs text-red-700 dark:text-red-300">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
                      <div className="leading-relaxed">
                        Cancelling terminates any active node execution, closes the current agent
                        session, and cleans up the shared git worktree. This cannot be undone.
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                        Reason{" "}
                        <span className="text-[var(--text-muted)] font-normal">(optional)</span>
                      </label>
                      <input
                        type="text"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="e.g. Superseded by another PR"
                        autoFocus
                        className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors"
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Footer */}
              <div className="px-5 py-3.5 border-t border-[var(--border-default)] bg-[var(--bg-card)] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => !submitting && onClose()}
                  disabled={submitting}
                  className="px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-default)] transition-colors cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={
                    submitting || (kind === "reject" && (!reason.trim() || !feedback.trim()))
                  }
                  className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-opacity disabled:opacity-40 cursor-pointer ${
                    kind === "cancel"
                      ? "bg-red-600 text-white hover:bg-red-700"
                      : kind === "approve"
                        ? "bg-emerald-600 text-white hover:bg-emerald-700"
                        : kind === "reject"
                          ? "bg-amber-600 text-white hover:bg-amber-700"
                          : "bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90"
                  }`}
                >
                  {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>
                    {kind === "approve" && "Confirm Approval"}
                    {kind === "reject" && "Confirm Rejection"}
                    {kind === "retry" && "Start Retry"}
                    {kind === "cancel" && "Cancel Pipeline"}
                  </span>
                </button>
              </div>
            </form>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
