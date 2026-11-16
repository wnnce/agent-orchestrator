import { Hono } from "hono";
import type { ProjectManager } from "../../project/manager.ts";

export interface ProjectsRouteDeps {
  projects: ProjectManager;
}

export function createProjectsRouter(deps: ProjectsRouteDeps): Hono {
  const router = new Hono();

  router.get("/projects", (c) => {
    return c.json({ projects: deps.projects.list().map((project) => project.routing) });
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
