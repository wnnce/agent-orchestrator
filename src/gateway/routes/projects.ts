import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { REASONING_EFFORTS } from "../../domain/types.ts";
import type { ProjectManager } from "../../project/manager.ts";

export interface ProjectsRouteDeps {
  projects: ProjectManager;
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

export function createProjectsRouter(deps: ProjectsRouteDeps): Hono {
  const router = new Hono();

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

  return router;
}
