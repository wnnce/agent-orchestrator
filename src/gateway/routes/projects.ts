import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ProjectMetricsData, ProjectOverviewData, Store } from "../../persistence/types.ts";
import type { ProjectManager } from "../../project/manager.ts";
import {
  getProjectMetricsRoute,
  getProjectOverviewRoute,
  listProjectSkillsRoute,
  listProjectsRoute,
} from "../contracts/projects.ts";
import { createOpenAPIApp } from "../openapi.ts";
import { TtlSingleflightCache } from "../stats-cache.ts";

export interface ProjectsRouteDeps {
  projects: ProjectManager;
  store: Store;
  overviewCacheTtlMs?: number;
  metricsCacheTtlMs?: number;
}

export function createProjectsRouter(deps: ProjectsRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();
  const overviewCache = new TtlSingleflightCache<ProjectOverviewData>();
  const metricsCache = new TtlSingleflightCache<ProjectMetricsData>();
  const overviewTtlMs = deps.overviewCacheTtlMs ?? 3_000;
  const metricsTtlMs = deps.metricsCacheTtlMs ?? 20_000;

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

  router.openapi(getProjectOverviewRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const { limit, refresh } = c.req.valid("query");
    const runtime = deps.projects.get(projectId);
    const resolvedLimit = limit ?? 5;
    const data = await overviewCache.getOrLoad(
      `${projectId}:${resolvedLimit}`,
      overviewTtlMs,
      async () => {
        const [snapshot, tasks] = await Promise.all([
          deps.store.getProjectOverview(projectId, { limit: resolvedLimit }),
          runtime.listTasks(),
        ]);
        return {
          generatedAt: new Date().toISOString(),
          ...snapshot,
          tasks: {
            total: tasks.length,
            enabled: tasks.filter((task) => task.enabled).length,
          },
        };
      },
      { bypassCache: refresh === "true" || refresh === "1" },
    );

    return c.json(data, 200);
  });

  router.openapi(getProjectMetricsRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const { range, tz, refresh } = c.req.valid("query");
    deps.projects.get(projectId);
    const resolvedTz = tz?.trim() || "UTC";
    const data = await metricsCache.getOrLoad(
      `${projectId}:${range}:${resolvedTz}`,
      metricsTtlMs,
      () => deps.store.getProjectMetrics(projectId, { range, tz: resolvedTz }),
      { bypassCache: refresh === "true" || refresh === "1" },
    );

    return c.json(data, 200);
  });

  return router;
}
