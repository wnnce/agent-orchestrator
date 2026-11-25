import type { ScheduledJobRecord } from "../types";
import { http } from "./http";

export interface ListJobsParams {
  sessionId?: string;
  projectId?: string;
  status?: number;
  limit?: number;
}

export const jobsApi = {
  async list(params?: ListJobsParams): Promise<ScheduledJobRecord[]> {
    const data = await http.get<{ jobs?: ScheduledJobRecord[] }>("/scheduled-jobs", {
      sessionId: params?.sessionId,
      projectId: params?.projectId,
      status: params?.status,
      limit: params?.limit,
    });
    return data.jobs ?? [];
  },

  cancel(jobId: string): Promise<{ success: boolean; jobId: string }> {
    return http.post(`/scheduled-jobs/${encodeURIComponent(jobId)}/cancel`);
  },
};
