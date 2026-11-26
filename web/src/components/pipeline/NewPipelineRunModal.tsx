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
  entryInputSchema?: Record<string, unknown>;
  onClose: () => void;
  onCreated: (run: PipelineRunRecord, created: boolean) => void;
}

export function NewPipelineRunModal({
  open,
  projectId,
  pipelineId,
  pipelineName,
  entryInputSchema,
  onClose,
  onCreated,
}: NewPipelineRunModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [externalKey, setExternalKey] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [dataJson, setDataJson] = useState("");
  const [metadataJson, setMetadataJson] = useState("");
  const [dataError, setDataError] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const schemaProperties =
    entryInputSchema &&
    typeof entryInputSchema.properties === "object" &&
    entryInputSchema.properties !== null
      ? Object.keys(entryInputSchema.properties as Record<string, unknown>)
      : [];
  const hasEntrySchema = schemaProperties.length > 0;
  const requiredFields = Array.isArray(entryInputSchema?.required)
    ? (entryInputSchema.required as string[])
    : [];

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
    setDataJson("");
    setMetadataJson("");
    setDataError(null);
    setMetadataError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    resetForm();
    onClose();
  };

  const parseJsonObject = (
    raw: string,
    label: string,
    setError: (msg: string | null) => void,
  ): { ok: true; value?: Record<string, unknown> } | { ok: false } => {
    if (!raw.trim()) {
      setError(null);
      return { ok: true };
    }
    try {
      const parsed = JSON.parse(raw.trim());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError(`${label} must be a JSON object (e.g. {"issueNumber": 42})`);
        return { ok: false };
      }
      setError(null);
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
      return { ok: false };
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error("Please enter a run title");
      return;
    }

    const parsedData = parseJsonObject(dataJson, "Data", setDataError);
    if (!parsedData.ok) return;
    const parsedMetadata = parseJsonObject(metadataJson, "Metadata", setMetadataError);
    if (!parsedMetadata.ok) return;

    setSubmitting(true);
    try {
      const result = await pipelinesApi.startRun(projectId, pipelineId, {
        title: trimmedTitle,
        description: description.trim() || undefined,
        externalKey: externalKey.trim() || undefined,
        externalUrl: externalUrl.trim() || undefined,
        data: parsedData.value,
        metadata: parsedMetadata.value,
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

                {hasEntrySchema && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                      Entry Data{" "}
                      {requiredFields.length > 0 ? (
                        <span className="text-red-500">*</span>
                      ) : (
                        <span className="text-[var(--text-muted)] font-normal">(optional JSON)</span>
                      )}
                    </label>
                    <p className="text-[11px] font-mono text-[var(--text-muted)] mb-1.5">
                      Schema fields:{" "}
                      {schemaProperties
                        .map((k) => (requiredFields.includes(k) ? `${k}*` : k))
                        .join(", ")}
                    </p>
                    <textarea
                      rows={4}
                      value={dataJson}
                      onChange={(e) => {
                        setDataJson(e.target.value);
                        if (dataError) setDataError(null);
                      }}
                      placeholder={`{\n${schemaProperties.map((k) => `  "${k}": ""`).join(",\n")}\n}`}
                      className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors resize-y"
                    />
                    {dataError && (
                      <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400 font-mono">
                        {dataError}
                      </p>
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                    Metadata <span className="text-[var(--text-muted)] font-normal">(optional free-form JSON)</span>
                  </label>
                  <textarea
                    rows={2}
                    value={metadataJson}
                    onChange={(e) => {
                      setMetadataJson(e.target.value);
                      if (metadataError) setMetadataError(null);
                    }}
                    placeholder={'{\n  "source": "studio"\n}'}
                    className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-xs font-mono bg-[var(--bg-input)] border border-[var(--border-default)] focus:border-[var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors resize-y"
                  />
                  {metadataError && (
                    <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400 font-mono">
                      {metadataError}
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
