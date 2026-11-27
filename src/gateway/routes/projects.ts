import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { REASONING_EFFORTS } from "../../domain/types.ts";
import { isValidTimeZone } from "../../persistence/stats-helpers.ts";
import type { ProjectMetricsData, ProjectOverviewData, Store } from "../../persistence/types.ts";
import type { ProjectManager } from "../../project/manager.ts";
import { TtlSingleflightCache } from "../stats-cache.ts";

export interface ProjectsRouteDeps {
  projects: ProjectManager;
  store: Store;
  overviewCacheTtlMs?: number;
  metricsCacheTtlMs?: number;
}

export const projectRoutingSchema = z
  .object({
    projectId: z.string(),
    displayName: z.string().optional(),
    summary: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    jiraProjectKeys: z.array(z.string()).optional(),
    routingHints: z.array(z.string()).optional(),
  })
  .meta({ ref: "ProjectRouting" });

const projectSummarySchema = projectRoutingSchema
  .extend({
    repository: z.string().optional().describe("Configured repository URL"),
    runtime: z.object({
      type: z.string(),
      model: z.string().optional(),
      reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    }),
  })
  .meta({ ref: "ProjectSummary" });

const projectSkillSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    path: z.string().optional(),
    source: z.string().optional(),
  })
  .meta({ ref: "ProjectSkill" });

const overviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().describe("Preview items per section"),
  refresh: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .describe("Set true/1 to bypass short-lived server cache"),
});

const metricsQuerySchema = z.object({
  range: z.enum(["7d", "14d", "30d"]).default("7d"),
  tz: z
    .string()
    .max(64)
    .optional()
    .refine((value) => !value || isValidTimeZone(value.trim()), {
      message: "Invalid IANA time zone",
    }),
  refresh: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .describe("Set true/1 to bypass short-lived server cache"),
});

const projectOverviewSchema = z
  .object({
    generatedAt: z.string(),
    sessions: z.object({
      active: z.number().int(),
      idle: z.number().int(),
      suspended: z.number().int(),
      archived: z.number().int(),
      total: z.number().int(),
    }),
    pipelines: z.object({
      running: z.number().int(),
      waiting: z.number().int(),
      waitingConfirmation: z.number().int(),
      failed: z.number().int(),
      completed: z.number().int(),
      cancelled: z.number().int(),
      total: z.number().int(),
    }),
    tasks: z.object({
      total: z.number().int(),
      enabled: z.number().int(),
    }),
    scheduledJobs: z.object({
      pending: z.number().int(),
    }),
    attention: z.object({
      waitingConfirmations: z.array(z.record(z.string(), z.unknown())),
      failedPipelineRuns: z.array(z.record(z.string(), z.unknown())),
      failedTaskExecutions: z.array(z.record(z.string(), z.unknown())),
    }),
    live: z.object({
      activeSessions: z.array(z.record(z.string(), z.unknown())),
      activePipelineNodes: z.array(z.record(z.string(), z.unknown())),
      upcomingJobs: z.array(z.record(z.string(), z.unknown())),
    }),
  })
  .meta({ ref: "ProjectOverview" });

const projectMetricsSchema = z
  .object({
    generatedAt: z.string(),
    range: z.enum(["7d", "14d", "30d"]),
    days: z.number().int(),
    tz: z.string(),
    since: z.string(),
    summary: z.object({
      turnCount: z.number().int(),
      inputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheWriteTokens: z.number(),
      outputTokens: z.number(),
      reasoningTokens: z.number(),
      totalTokens: z.number(),
      cacheHitRate: z.number().nullable(),
      taskSuccess: z.number().int(),
      taskFailed: z.number().int(),
      taskTotal: z.number().int(),
      taskSuccessRate: z.number().nullable(),
      pipelineCompleted: z.number().int(),
      pipelineFailed: z.number().int(),
      pipelineTotal: z.number().int(),
    }),
    daily: z.array(z.record(z.string(), z.unknown())),
    byModel: z.array(z.record(z.string(), z.unknown())),
    bySource: z.array(z.record(z.string(), z.unknown())),
  })
  .meta({ ref: "ProjectMetrics" });

export function createProjectsRouter(deps: ProjectsRouteDeps): Hono {
  const router = new Hono();
  const overviewCache = new TtlSingleflightCache<ProjectOverviewData>();
  const metricsCache = new TtlSingleflightCache<ProjectMetricsData>();
  const overviewTtlMs = deps.overviewCacheTtlMs ?? 3_000;
  const metricsTtlMs = deps.metricsCacheTtlMs ?? 20_000;

  router.get(
    "/projects",
    describeRoute({
      tags: ["Projects"],
      summary: "List managed projects",
      responses: {
        200: {
          description: "List of configured projects",
          content: {
            "application/json": {
              schema: resolver(z.object({ projects: z.array(projectSummarySchema) })),
            },
          },
        },
      },
    }),
    (c) => {
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
    },
  );

  router.get(
    "/projects/:projectId/skills",
    describeRoute({
      tags: ["Projects"],
      summary: "List available skills for a project",
      responses: {
        200: {
          description: "Skills discovered for the project",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ projectId: z.string(), skills: z.array(projectSkillSchema) }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId");
      try {
        const skills = await deps.projects.listSkills(projectId);
        return c.json({ projectId, skills });
      } catch {
        return c.json({ error: `project not found: ${projectId}` }, 404);
      }
    },
  );

  router.get(
    "/projects/:projectId/overview",
    describeRoute({
      tags: ["Projects"],
      summary: "Get live operational overview for a project",
      responses: {
        200: {
          description: "Live project status counts, attention items, and active work",
          content: {
            "application/json": {
              schema: resolver(projectOverviewSchema),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("query", overviewQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const { limit, refresh } = c.req.valid("query");
      const bypassCache = refresh === "true" || refresh === "1";

      let runtime: ReturnType<ProjectManager["get"]>;
      try {
        runtime = deps.projects.get(projectId);
      } catch {
        return c.json({ error: `project not found: ${projectId}` }, 404);
      }

      const resolvedLimit = limit ?? 5;
      const cacheKey = `${projectId}:${resolvedLimit}`;
      const data = await overviewCache.getOrLoad(
        cacheKey,
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
        { bypassCache },
      );

      return c.json(data);
    },
  );

  router.get(
    "/projects/:projectId/metrics",
    describeRoute({
      tags: ["Projects"],
      summary: "Get time-series metrics and usage breakdowns for a project",
      responses: {
        200: {
          description: "Aggregated daily metrics, token usage, and model/source breakdowns",
          content: {
            "application/json": {
              schema: resolver(projectMetricsSchema),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("query", metricsQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const { range, tz, refresh } = c.req.valid("query");
      const bypassCache = refresh === "true" || refresh === "1";

      try {
        deps.projects.get(projectId);
      } catch {
        return c.json({ error: `project not found: ${projectId}` }, 404);
      }

      const resolvedTz = tz?.trim() || "UTC";
      const cacheKey = `${projectId}:${range}:${resolvedTz}`;
      const data = await metricsCache.getOrLoad(
        cacheKey,
        metricsTtlMs,
        () => deps.store.getProjectMetrics(projectId, { range, tz: resolvedTz }),
        { bypassCache },
      );

      return c.json(data);
    },
  );

  return router;
}
