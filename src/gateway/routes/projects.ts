import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ProjectManager } from "../../project/manager.ts";
import type { ProjectStats } from "../../project/stats.ts";
import { describeProjectTools } from "../../tools/describe.ts";
import { hookPath } from "./hooks.ts";
import {
  getProjectMetricsRoute,
  getProjectOverviewRoute,
  listProjectHooksRoute,
  listProjectSkillsRoute,
  listProjectToolsRoute,
  listProjectsRoute,
} from "../contracts/projects.ts";
import { createOpenAPIApp } from "../openapi.ts";

export interface ProjectsRouteDeps {
  readonly projects: ProjectManager;
  readonly stats: ProjectStats;
}

export function createProjectsRouter(deps: ProjectsRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  router.openapi(listProjectsRoute, (c) => {
    const defaultRuntime = deps.projects.getDefaultRuntime();
    return c.json(
      {
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
      },
      200,
    );
  });

  router.openapi(listProjectSkillsRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const skills = await deps.projects.listSkills(projectId);
    return c.json({ projectId, skills }, 200);
  });

  router.openapi(listProjectToolsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const tools = describeProjectTools(deps.projects.get(projectId).tools);
    return c.json({ projectId, tools }, 200);
  });

  router.openapi(listProjectHooksRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const hooks = deps.projects
      .get(projectId)
      .hooks.list()
      .map((hook) => ({ ...hook, path: hookPath(projectId, hook.id) }));
    return c.json({ projectId, hooks }, 200);
  });

  router.openapi(getProjectOverviewRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const { limit, refresh } = c.req.valid("query");
    const data = await deps.stats.overview(projectId, {
      limit: limit ?? 5,
      refresh: isSet(refresh),
    });
    return c.json(data, 200);
  });

  router.openapi(getProjectMetricsRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const { range, tz, refresh } = c.req.valid("query");
    const data = await deps.stats.metrics(projectId, {
      range,
      tz: tz?.trim() || "UTC",
      refresh: isSet(refresh),
    });
    return c.json(data, 200);
  });

  return router;
}

/** Reads a `true`/`1` style query flag. */
function isSet(flag: string | undefined): boolean {
  return flag === "true" || flag === "1";
}
