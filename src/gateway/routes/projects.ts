import { Hono } from "hono";
import type { ProjectManager } from "../../project/manager.ts";

export interface ProjectsRouteDeps {
  projects: ProjectManager;
}

export function createProjectsRouter(deps: ProjectsRouteDeps): Hono {
  const router = new Hono();

  router.get("/projects", (c) => {
    const defaultRuntime = deps.projects.getDefaultRuntime();
    return c.json({
      projects: deps.projects.list().map((project) => ({
        ...project.routing,
        ...(project.repository?.url ? { repository: project.repository.url } : {}),
        runtime: {
          type: project.runtime?.type ?? defaultRuntime,
          ...(project.runtime?.model ? { model: project.runtime.model } : {}),
          ...(project.runtime?.reasoningEffort
            ? { reasoningEffort: project.runtime.reasoningEffort }
            : {}),
        },
      })),
    });
  });

  router.get("/projects/:projectId/skills", async (c) => {
    const projectId = c.req.param("projectId");
    try {
      const skills = await deps.projects.listSkills(projectId);
      return c.json({ projectId, skills });
    } catch {
      return c.json({ error: `project not found: ${projectId}` }, 404);
    }
  });

  return router;
}
