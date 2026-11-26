import React, { useEffect, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { Loader2, Play, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError, pipelinesApi } from "../../api";
import type { PipelineRunRecord } from "../../types";
import { EASE_OUT_EXPO } from "../../utils/motion";

interface NewPipelineRunModalProps {
  open: boolean;
  projectId: string;
  pipelineId: string;
  pipelineName: string;
  onClose: () => void;
  onCreated: (run: PipelineRunRecord, created: boolean) => void;
}

export function NewPipelineRunModal({
  open,
  projectId,
  pipelineId,
  pipelineName,
  onClose,
  onCreated,
}: NewPipelineRunModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [externalKey, setExternalKey] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [inputJson, setInputJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, submitting, onClose]);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setExternalKey("");
    setExternalUrl("");
    setInputJson("");
    setJsonError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error("Please enter a run title");
      return;
    }

    let parsedInput: Record<string, unknown> | undefined;
    if (inputJson.trim()) {
      try {
        const parsed = JSON.parse(inputJson.trim());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setJsonError("Input must be a JSON object (e.g. {\"issueNumber\": 42})");
          return;
        }
        parsedInput = parsed as Record<string, unknown>;
        setJsonError(null);
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    } else {
      setJsonError(null);
    }

    setSubmitting(true);
    try {
      const result = await pipelinesApi.startRun(projectId, pipelineId, {
        title: trimmedTitle,
        description: description.trim() || undefined,
        externalKey: externalKey.trim() || undefined,
        externalUrl: externalUrl.trim() || undefined,
        input: parsedInput,
        createdBy: "studio-ui",
      });
      if (result.created) {
        toast.success(`Started run "${result.run.title}"`);
      } else {
        toast.info(`Matched existing run by external key (${result.run.runId.slice(0, 12)})`);
      }
      resetForm();
      onCreated(result.run, result.created);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to start pipeline run";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={handleClose}
          className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-4"
        >
          <m.div
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: EASE_OUT_EXPO }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-xl overflow-hidden"
          >
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-[var(--border-default)] bg-[var(--bg-card)] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                  New Pipeline Run
                </h2>
                <p className="text-[11px] font-mono text-[var(--text-muted)] truncate mt-0.5">
                  {pipelineName} ({pipelineId})
                </p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                disabled={submitting}
                className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Form Body */}
            <form onSubmit={handleSubmit}>
              <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                <div>
                  <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                    Title <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Add webhook retry support (#42)"
                    autoFocus
                    className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                    Description
                  </label>
                  <textarea
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Requirement details, acceptance criteria, or context for the entry node..."
                    className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors resize-y"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                      External Key
                    </label>
                    <input
                      type="text"
                      value={externalKey}
                      onChange={(e) => setExternalKey(e.target.value)}
                      placeholder="gh-issue-42 (optional)"
                      className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                      External URL
                    </label>
                    <input
                      type="url"
                      value={externalUrl}
                      onChange={(e) => setExternalUrl(e.target.value)}
                      placeholder="https://github.com/..."
                      className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                    Input Payload <span className="text-[var(--text-muted)] font-normal">(optional JSON object)</span>
                  </label>
                  <textarea
                    rows={3}
                    value={inputJson}
                    onChange={(e) => {
                      setInputJson(e.target.value);
                      if (jsonError) setJsonError(null);
                    }}
                    placeholder={'{\n  "issueNumber": 42\n}'}
                    className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors resize-y"
                  />
                  {jsonError && (
                    <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400 font-mono">
                      {jsonError}
                    </p>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-3.5 border-t border-[var(--border-default)] bg-[var(--bg-card)] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={submitting}
                  className="px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-default)] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !title.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 disabled:opacity-40 transition-opacity cursor-pointer"
                >
                  {submitting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                  <span>Start Run</span>
                </button>
              </div>
            </form>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
