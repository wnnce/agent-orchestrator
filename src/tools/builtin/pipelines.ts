import { z } from "zod";
import { defineTool, type ToolSite } from "../types.ts";

const nonEmptyText = z.string().trim().min(1);

export const listProjectPipelinesParams = z.object({
  includeDisabled: z
    .boolean()
    .optional()
    .describe("Include disabled pipelines in the result (default: false)"),
});

export const dispatchPipelineRunParams = z.object({
  pipelineId: nonEmptyText.describe(
    "Target pipeline ID in the current project (use list_project_pipelines to discover IDs and entryInputSchema)",
  ),
  title: nonEmptyText.describe("Concise title for the new pipeline run"),
  description: z.string().optional().describe("Optional Markdown description or context"),
  externalKey: nonEmptyText
    .optional()
    .describe(
      "Optional idempotency key (e.g. github:owner/repo#42); matching an existing run returns it without creating a duplicate",
    ),
  externalUrl: nonEmptyText
    .optional()
    .describe("Optional external reference URL (e.g. GitHub Issue or ticket URL)"),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Structured entry data matching the pipeline's entryInputSchema (omit when entryInputSchema is absent)",
    ),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional free-form metadata attached to the run"),
});

/** A pipeline node's agent works within its run; starting other runs is left to people and tasks. */
const outsidePipelines = (site: ToolSite): boolean => site.owner?.kind !== "pipeline";

export const listProjectPipelinesTool = defineTool({
  name: "list_project_pipelines",
  description:
    "List pipelines configured in the current project, including their stages and the entry node's JSON Schema (entryInputSchema) required for dispatch_pipeline_run.",
  input: listProjectPipelinesParams,
  when: outsidePipelines,
  async run(input, ctx) {
    const all = await ctx.pipelines.list();
    const visible = input.includeDisabled ? all : all.filter((p) => p.enabled);
    return {
      projectId: ctx.project.id,
      pipelines: visible.map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.description !== undefined ? { description: p.description } : {}),
        enabled: p.enabled,
        currentVersion: p.currentVersion,
        nodes: p.nodes.map((n) => ({
          id: n.id,
          name: n.name,
          executor: n.executor,
          terminal: n.terminal,
        })),
        ...(p.entryInputSchema !== undefined ? { entryInputSchema: p.entryInputSchema } : {}),
      })),
    };
  },
});

export const dispatchPipelineRunTool = defineTool({
  name: "dispatch_pipeline_run",
  description:
    "Start a new pipeline run in the current project (idempotent when externalKey is provided). Validate `data` against the pipeline's entryInputSchema from list_project_pipelines.",
  input: dispatchPipelineRunParams,
  when: outsidePipelines,
  async run(input, ctx) {
    const { created, run } = await ctx.pipelines.start({
      pipelineId: input.pipelineId,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.externalKey !== undefined ? { externalKey: input.externalKey } : {}),
      ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
    return {
      created,
      runId: run.runId,
      pipelineId: run.pipelineId,
      pipelineVersion: run.pipelineVersion,
      title: run.title,
      status: run.status,
      currentNodeId: run.currentNodeId,
      ...(run.externalKey !== undefined ? { externalKey: run.externalKey } : {}),
    };
  },
});
