import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Timer,
  RotateCw,
  Clock,
  ArrowRight,
  Ban,
} from "lucide-react";
import { jobsApi } from "../../api";
import { useStudio } from "../../context/StudioContext";
import { useConfirm } from "../../context/ConfirmContext";
import type { ScheduledJobRecord } from "../../types";
import { formatDateTime, formatJobStatus, formatTimeAgo } from "../../utils/formatters";

export function ScheduledJobsView() {
  const { activeProjectId, openSession } = useStudio();
  const confirm = useConfirm();
  const [jobs, setJobs] = useState<ScheduledJobRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<number | "all">("all");
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const list = await jobsApi.list({
        projectId: activeProjectId || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
        limit: 50,
      });
      setJobs(list);
    } catch (err) {
      console.error("Failed to load scheduled jobs:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
    const timer = setInterval(loadJobs, 15000);
    return () => clearInterval(timer);
  }, [activeProjectId, statusFilter]);

  const handleCancel = async (jobId: string) => {
    const ok = await confirm({
      title: "Cancel Scheduled Job",
      description: `Are you sure you want to cancel scheduled job ${jobId}?`,
      confirmText: "Cancel Job",
      variant: "destructive",
    });
    if (!ok) return;

    setCancellingJobId(jobId);
    try {
      await jobsApi.cancel(jobId);
      toast.success("Scheduled job cancelled");
      await loadJobs();
    } catch (err: any) {
      toast.error(`Cancel job failed: ${err.message || String(err)}`);
    } finally {
      setCancellingJobId(null);
    }
  };

  const handleJumpToSession = (sessionId: string) => {
    openSession(sessionId);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[var(--bg-canvas)] select-text">
      {/* Vercel Header */}
      <div className="px-6 py-6 border-b border-[var(--border-default)] bg-[var(--bg-header)]">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
              Scheduled Jobs Queue
            </h1>
            <p className="text-xs text-[var(--text-secondary)]">
              Delayed execution jobs and pending triggers scheduled via schedule tool.
            </p>
          </div>
          <button
            onClick={loadJobs}
            disabled={loading}
            className="px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] hover:bg-[var(--bg-surface-hover)] text-xs font-mono text-[var(--text-primary)] transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <RotateCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto w-full px-6 py-6 space-y-6">
        {/* Status Filter Tabs (Vercel Flat Tabs) */}
        <div className="flex items-center gap-2 border-b border-[var(--border-default)] text-xs font-mono">
          {[
            { id: "all", label: "All" },
            { id: 0, label: "Pending" },
            { id: 1, label: "Executed" },
            { id: 2, label: "Failed" },
            { id: 3, label: "Cancelled" },
          ].map((tab) => {
            const isSelected = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setStatusFilter(tab.id as any)}
                className={`pb-2 px-2 transition-colors cursor-pointer relative ${
                  isSelected
                    ? "text-[var(--text-primary)] font-semibold border-b-2 border-[var(--border-focus)] -mb-[1px]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Jobs Data Table */}
        <div className="border border-[var(--border-default)] rounded-[var(--radius-sm)] overflow-hidden">
          {jobs.length === 0 ? (
            <div className="p-8 text-center text-xs text-[var(--text-muted)] font-mono">
              No scheduled jobs matching the filter.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-[var(--bg-table-header)] text-[var(--text-muted)] text-[11px] border-b border-[var(--border-default)]">
                  <tr>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Job ID</th>
                    <th className="py-2 px-3">Trigger Time</th>
                    <th className="py-2 px-3">Session</th>
                    <th className="py-2 px-3">Prompt Preview</th>
                    <th className="py-2 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {jobs.map((job) => {
                    const statusInfo = formatJobStatus(job.status);
                    const isPending = job.status === 0;

                    return (
                      <tr key={job.jobId} className="hover:bg-[var(--bg-table-row-hover)] transition-colors">
                        <td className="py-2.5 px-3">
                          <span
                            className={`inline-flex px-1.5 py-0.2 rounded-[var(--radius-xs)] text-[10px] border ${
                              isPending
                                ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
                                : job.status === 1
                                  ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                                  : "text-[var(--text-muted)] bg-[var(--bg-surface-elevated)] border-[var(--border-default)]"
                            }`}
                          >
                            {statusInfo.label.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-[var(--text-primary)]">
                          {job.name || job.jobId.slice(0, 16)}
                        </td>
                        <td className="py-2.5 px-3 text-[var(--text-secondary)]">
                          {formatDateTime(job.triggerAt)}
                        </td>
                        <td className="py-2.5 px-3">
                          <button
                            onClick={() => handleJumpToSession(job.sessionId)}
                            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline cursor-pointer flex items-center gap-1"
                          >
                            <span>{job.sessionId.slice(0, 12)}...</span>
                            <ArrowRight className="w-2.5 h-2.5" />
                          </button>
                        </td>
                        <td className="py-2.5 px-3 text-[var(--text-secondary)] max-w-xs truncate font-sans">
                          {job.prompt}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {isPending && (
                            <button
                              onClick={() => handleCancel(job.jobId)}
                              disabled={cancellingJobId === job.jobId}
                              className="px-2 py-0.5 rounded-[var(--radius-xs)] border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors text-[11px] cursor-pointer"
                            >
                              {cancellingJobId === job.jobId ? "Cancelling..." : "Cancel"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
