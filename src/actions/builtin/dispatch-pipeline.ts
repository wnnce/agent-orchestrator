import { z } from "zod";
import type { PipelineEngine } from "../../pipeline/engine.ts";
import type { ActionContext, ActionDefinition } from "../types.ts";

const nonEmptyText = z.string().trim().min(1);

export const listProjectPipelinesParams = z.object({
  includeDisabled: z
    .boolean()
    .optional()
    .describe("Include disabled pipelines in the result (default: false)"),
});

export type ListProjectPipelinesParams = z.infer<typeof listProjectPipelinesParams>;

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

export type DispatchPipelineRunParams = z.infer<typeof dispatchPipelineRunParams>;

function requirePipelineEngine(context: ActionContext): PipelineEngine {
  return context.requireService<PipelineEngine>("pipelineEngine");
}

export const listProjectPipelinesAction: ActionDefinition<ListProjectPipelinesParams, unknown> = {
  name: "list_project_pipelines",
  description:
    "List pipelines configured in the current project, including their stages and the entry node's JSON Schema (entryInputSchema) required for dispatch_pipeline_run.",
  parameters: listProjectPipelinesParams,
  scopes: ["conversation", "task"],
  async handler(params, context) {
    const engine = requirePipelineEngine(context);
    const all = await engine.listPipelinesWithVersions();
    const visible = params.includeDisabled ? all : all.filter((p) => p.enabled);
    return {
      projectId: context.projectId,
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
};

export const dispatchPipelineRunAction: ActionDefinition<DispatchPipelineRunParams, unknown> = {
  name: "dispatch_pipeline_run",
  description:
    "Start a new pipeline run in the current project (idempotent when externalKey is provided). Validate `data` against the pipeline's entryInputSchema from list_project_pipelines.",
  parameters: dispatchPipelineRunParams,
  scopes: ["conversation", "task"],
  async handler(params, context) {
    const engine = requirePipelineEngine(context);
    const createdBy = context.taskKey
      ? `task:${context.taskKey}`
      : context.sessionId
        ? `session:${context.sessionId}`
        : "agent";

    const { created, run } = await engine.startRun({
      pipelineId: params.pipelineId,
      title: params.title,
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.externalKey !== undefined ? { externalKey: params.externalKey } : {}),
      ...(params.externalUrl !== undefined ? { externalUrl: params.externalUrl } : {}),
      ...(params.data !== undefined ? { data: params.data } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      createdBy,
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
};

export const pipelineDispatchActions: readonly ActionDefinition<unknown, unknown>[] = [
  listProjectPipelinesAction as ActionDefinition<unknown, unknown>,
  dispatchPipelineRunAction as ActionDefinition<unknown, unknown>,
];
