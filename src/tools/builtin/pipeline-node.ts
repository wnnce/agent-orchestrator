import { z } from "zod";
import type { PipelineInputSchema } from "../../pipeline/types.ts";
import { defineTool, type PipelineOwner, type ToolContext, type ToolSite } from "../types.ts";

const nonEmptyText = z.string().trim().min(1);
const metadataSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Optional free-form metadata passed along without schema restrictions");

/**
 * Builds the session-specific parameter schema for `pipeline_next`.
 * - When the next node declares an `input` schema, `data` is required and typed directly to it.
 * - When the next node declares no `input` schema (or is terminal), `data` is omitted completely.
 */
export function pipelineNextInput(
  nextInputSchema?: PipelineInputSchema,
): z.ZodObject<z.ZodRawShape> {
  const base = {
    summary: nonEmptyText.describe("Concise conclusion summary of this node's work"),
    content: nonEmptyText.describe(
      "Full Markdown output or deliverable to hand off to the next node",
    ),
    artifacts: z
      .array(nonEmptyText)
      .optional()
      .describe("Optional list of relevant file paths or artifact references"),
    metadata: metadataSchema,
  };
  if (nextInputSchema) {
    return z.object({
      ...base,
      data: nextInputSchema.describe(
        "Required structured data matching the next node's declared input schema",
      ),
    });
  }
  return z.object(base);
}

const pipelineNextParams = z.object({
  summary: nonEmptyText.describe("Concise conclusion summary of this node's work"),
  content: nonEmptyText.describe(
    "Full Markdown output or deliverable to hand off to the next node",
  ),
  artifacts: z
    .array(nonEmptyText)
    .optional()
    .describe("Optional list of relevant file paths or artifact references"),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Structured JSON payload matching the next node's declared input schema"),
  metadata: metadataSchema,
});

const pipelinePrevParams = z.object({
  reason: nonEmptyText.describe("One-sentence reason for rejecting and returning upstream"),
  feedback: nonEmptyText.describe("Detailed Markdown list of issues and required changes"),
  targetNodeId: nonEmptyText
    .optional()
    .describe("Target upstream node ID when multiple prevTargets are configured"),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional partial override merged into the target node's inherited input data"),
  metadata: metadataSchema,
});

const pipelineRequestConfirmationParams = z.object({
  summary: nonEmptyText.describe("Current progress or proposal summary"),
  question: nonEmptyText.describe("Specific question or decision needed from a human"),
  options: z.array(nonEmptyText).optional().describe("Optional suggested choices for the human"),
  content: z.string().optional().describe("Optional full Markdown deliverable so far"),
  artifacts: z.array(nonEmptyText).optional().describe("Optional list of file paths"),
  data: z.record(z.string(), z.unknown()).optional().describe("Optional structured data"),
  metadata: metadataSchema,
});

const pipelineFailParams = z.object({
  reason: nonEmptyText.describe("Unrecoverable failure reason blocking progress"),
  summary: z.string().optional().describe("Optional short summary"),
  data: z.record(z.string(), z.unknown()).optional().describe("Optional diagnostic details"),
  metadata: metadataSchema,
});

const pipelineGetContextParams = z.object({});

const pipelineActionNameSchema = z.enum([
  "pipeline_next",
  "pipeline_prev",
  "pipeline_request_confirmation",
  "pipeline_fail",
  "human_approve",
  "human_reject",
  "human_retry",
  "human_cancel",
  "system_fallback",
  "system_loop_breaker",
]);

const pipelineListHistoryParams = z.object({
  nodeId: nonEmptyText.optional().describe("Optional filter by node ID"),
  action: pipelineActionNameSchema.optional().describe("Optional filter by action type"),
});

const pipelineGetHistoryDetailParams = z.object({
  recordId: nonEmptyText.optional().describe("Exact PipelineActionRecord ID"),
  sequence: z.number().int().positive().optional().describe("Sequence number within the run"),
  nodeId: nonEmptyText.optional().describe("Node ID (optionally combined with attempt)"),
  attempt: z.number().int().positive().optional().describe("Attempt number for nodeId"),
});

/** Pipeline node tools are offered to the agent of a pipeline node, and only to it. */
const runsPipelineNode = (site: ToolSite): boolean => site.owner?.kind === "pipeline";

function pipelineOwner(ctx: ToolContext): PipelineOwner {
  if (ctx.owner?.kind !== "pipeline") throw new Error("this session does not run a pipeline node");
  return ctx.owner;
}

export const pipelineNextTool = defineTool({
  name: "pipeline_next",
  description:
    "Advance this pipeline run to the fixed next node (or pause for manual confirmation when gate=manual). Requires non-empty summary and content.",
  input: pipelineNextParams,
  when: runsPipelineNode,
  run: (input, ctx) =>
    pipelineOwner(ctx).decide("pipeline_next", {
      summary: input.summary,
      content: input.content,
      artifacts: input.artifacts,
      data: input.data,
      metadata: input.metadata,
    }),
});

export const pipelinePrevTool = defineTool({
  name: "pipeline_prev",
  description:
    "Reject and route this pipeline run back to an allowed upstream node with explicit reason and actionable feedback.",
  input: pipelinePrevParams,
  when: runsPipelineNode,
  run: (input, ctx) =>
    pipelineOwner(ctx).decide("pipeline_prev", {
      reason: input.reason,
      feedback: input.feedback,
      targetNodeId: input.targetNodeId,
      data: input.data,
      metadata: input.metadata,
    }),
});

export const pipelineRequestConfirmationTool = defineTool({
  name: "pipeline_request_confirmation",
  description:
    "Pause this agent node in waiting_confirmation and ask a human to review, answer a question, or approve before proceeding.",
  input: pipelineRequestConfirmationParams,
  when: runsPipelineNode,
  run: (input, ctx) =>
    pipelineOwner(ctx).decide("pipeline_request_confirmation", {
      summary: input.summary,
      question: input.question,
      options: input.options,
      content: input.content,
      artifacts: input.artifacts,
      data: input.data,
      metadata: input.metadata,
    }),
});

export const pipelineFailTool = defineTool({
  name: "pipeline_fail",
  description:
    "Mark this pipeline node as failed due to an unrecoverable blocker. Preserves the workspace for human inspection, retry, or cancellation.",
  input: pipelineFailParams,
  when: runsPipelineNode,
  run: (input, ctx) =>
    pipelineOwner(ctx).decide("pipeline_fail", {
      reason: input.reason,
      summary: input.summary,
      data: input.data,
      metadata: input.metadata,
    }),
});

export const pipelineGetContextTool = defineTool({
  name: "pipeline_get_context",
  description:
    "Read the current pipeline run overview, branch, node topology, direct upstream handoff context, and latest summaries of prior nodes.",
  input: pipelineGetContextParams,
  when: runsPipelineNode,
  run: (_input, ctx) => pipelineOwner(ctx).context(),
});

export const pipelineListHistoryTool = defineTool({
  name: "pipeline_list_history",
  description:
    "List all recorded pipeline actions and transitions for this run in chronological order, optionally filtered by nodeId or action.",
  input: pipelineListHistoryParams,
  when: runsPipelineNode,
  run: async (input, ctx) => ({
    entries: await pipelineOwner(ctx).history.list({
      nodeId: input.nodeId,
      action: input.action,
    }),
  }),
});

export const pipelineGetHistoryDetailTool = defineTool({
  name: "pipeline_get_history_detail",
  description:
    "Read the full saved context (content, feedback, artifacts, data, humanNote) and engine result of a specific historical pipeline action record.",
  input: pipelineGetHistoryDetailParams,
  when: runsPipelineNode,
  async run(input, ctx) {
    if (!input.recordId && !input.sequence && !input.nodeId) {
      throw new Error(
        "Provide at least one selector: recordId, sequence, or nodeId (with optional attempt).",
      );
    }
    const record = await pipelineOwner(ctx).history.get({
      recordId: input.recordId,
      sequence: input.sequence,
      nodeId: input.nodeId,
      attempt: input.attempt,
    });
    if (!record) throw new Error("Matching pipeline history record not found.");
    return { record };
  },
});

export const pipelineNodeTools = [
  pipelineNextTool,
  pipelinePrevTool,
  pipelineRequestConfirmationTool,
  pipelineFailTool,
  pipelineGetContextTool,
  pipelineListHistoryTool,
  pipelineGetHistoryDetailTool,
];
