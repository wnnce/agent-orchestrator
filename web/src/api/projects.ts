import type {
  ProjectMetricsData,
  ProjectMetricsRange,
  ProjectOverviewData,
  ProjectRouting,
  ProjectSkill,
} from "../types";
import { http } from "./http";

export const projectsApi = {
  async list(): Promise<ProjectRouting[]> {
    const data = await http.get<{ projects?: ProjectRouting[] }>("/projects");
    return data.projects ?? [];
  },

  async listSkills(projectId: string): Promise<ProjectSkill[]> {
    const data = await http.get<{ skills?: ProjectSkill[] }>(
      `/projects/${encodeURIComponent(projectId)}/skills`,
    );
    return data.skills ?? [];
  },

  async getOverview(
    projectId: string,
    options?: { limit?: number; refresh?: boolean },
  ): Promise<ProjectOverviewData> {
    return http.get<ProjectOverviewData>(
      `/projects/${encodeURIComponent(projectId)}/overview`,
      {
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.refresh ? { refresh: "true" } : {}),
      },
    );
  },

  async getMetrics(
    projectId: string,
    options: { range: ProjectMetricsRange; tz?: string; refresh?: boolean },
  ): Promise<ProjectMetricsData> {
    return http.get<ProjectMetricsData>(
      `/projects/${encodeURIComponent(projectId)}/metrics`,
      {
        range: options.range,
        ...(options.tz ? { tz: options.tz } : {}),
        ...(options.refresh ? { refresh: "true" } : {}),
      },
    );
  },
};
