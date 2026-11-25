import type { ProjectRouting, ProjectSkill } from "../types";
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
};
