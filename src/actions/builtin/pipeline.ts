import { z } from "zod";
import type { PipelineEngine } from "../../pipeline/engine.ts";
import type { PipelineActionName } from "../../pipeline/types.ts";
import type { ActionContext, ActionDefinition } from "../types.ts";

const nonEmptyText = z.string().trim().min(1);

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
    .describe("Optional structured JSON payload for downstream TS or Agent nodes"),
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
    .describe("Optional structured diagnostic data"),
});

const pipelineRequestConfirmationParams = z.object({
  summary: nonEmptyText.describe("Current progress or proposal summary"),
  question: nonEmptyText.describe("Specific question or decision needed from a human"),
  options: z.array(nonEmptyText).optional().describe("Optional suggested choices for the human"),
  content: z.string().optional().describe("Optional full Markdown deliverable so far"),
  artifacts: z.array(nonEmptyText).optional().describe("Optional list of file paths"),
  data: z.record(z.string(), z.unknown()).optional().describe("Optional structured data"),
});

const pipelineFailParams = z.object({
  reason: nonEmptyText.describe("Unrecoverable failure reason blocking progress"),
  summary: z.string().optional().describe("Optional short summary"),
  data: z.record(z.string(), z.unknown()).optional().describe("Optional diagnostic details"),
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

function requirePipelineEngine(context: ActionContext): PipelineEngine {
  return context.requireService("pipelineEngine");
}

export const pipelineNextAction: ActionDefinition<z.infer<typeof pipelineNextParams>, unknown> = {
  name: "pipeline_next",
  description:
    "Advance this pipeline run to the fixed next node (or pause for manual confirmation when gate=manual). Requires non-empty summary and content.",
  parameters: pipelineNextParams,
  scopes: ["pipeline"],
  async handler(params, context) {
    const engine = requirePipelineEngine(context);
    return engine.registerAgentDecision({
      sessionId: context.sessionId,
      turnId: context.turnId,
      action: "pipeline_next",
      context: {
        summary: params.summary,
        content: params.content,
        artifacts: params.artifacts,
        data: params.data,
      },
    });
  },
};

export const pipelinePrevAction: ActionDefinition<z.infer<typeof pipelinePrevParams>, unknown> = {
  name: "pipeline_prev",
  description:
    "Reject and route this pipeline run back to an allowed upstream node with explicit reason and actionable feedback.",
  parameters: pipelinePrevParams,
  scopes: ["pipeline"],
  async handler(params, context) {
    const engine = requirePipelineEngine(context);
    return engine.registerAgentDecision({
      sessionId: context.sessionId,
      turnId: context.turnId,
      action: "pipeline_prev",
      context: {
        reason: params.reason,
        feedback: params.feedback,
        targetNodeId: params.targetNodeId,
        data: params.data,
      },
    });
  },
};

export const pipelineRequestConfirmationAction: ActionDefinition<
  z.infer<typeof pipelineRequestConfirmationParams>,
  unknown
> = {
  name: "pipeline_request_confirmation",
  description:
    "Pause this agent node in waiting_confirmation and ask a human to review, answer a question, or approve before proceeding.",
  parameters: pipelineRequestConfirmationParams,
  scopes: ["pipeline"],
  async handler(params, context) {
    const engine = requirePipelineEngine(context);
    return engine.registerAgentDecision({
      sessionId: context.sessionId,
      turnId: context.turnId,
      action: "pipeline_request_confirmation",
      context: {
        summary: params.summary,
        question: params.question,
        options: params.options,
        content: params.content,
        artifacts: params.artifacts,
        data: params.data,
      },
    });
  },
};

export const pipelineFailAction: ActionDefinition<z.infer<typeof pipelineFailParams>, unknown> = {
  name: "pipeline_fail",
  description:
    "Mark this pipeline node as failed due to an unrecoverable blocker. Preserves the workspace for human inspection, retry, or cancellation.",
  parameters: pipelineFailParams,
  scopes: ["pipeline"],
  async handler(params, context) {
    const engine = requirePipelineEngine(context);
    return engine.registerAgentDecision({
      sessionId: context.sessionId,
      turnId: context.turnId,
      action: "pipeline_fail",
      context: {
        reason: params.reason,
        summary: params.summary,
        data: params.data,
      },
    });
  },
};

export const pipelineGetContextAction: ActionDefinition<
  z.infer<typeof pipelineGetContextParams>,
  unknown
> = {
  name: "pipeline_get_context",
  description:
    "Read the current pipeline run overview, branch, node topology, direct upstream handoff context, and latest summaries of prior nodes.",
  parameters: pipelineGetContextParams,
  scopes: ["pipeline"],
  async handler(_params, context) {
    const engine = requirePipelineEngine(context);
    return engine.getContextForSession(context.sessionId);
  },
};

export const pipelineListHistoryAction: ActionDefinition<
  z.infer<typeof pipelineListHistoryParams>,
  unknown
> = {
  name: "pipeline_list_history",
  description:
    "List all recorded pipeline actions and transitions for this run in chronological order, optionally filtered by nodeId or action.",
  parameters: pipelineListHistoryParams,
  scopes: ["pipeline"],
  async handler(params, context) {
    const engine = requirePipelineEngine(context);
    const entries = await engine.listHistoryForSession(context.sessionId, {
      nodeId: params.nodeId,
      action: params.action as PipelineActionName | undefined,
    });
    return { entries };
  },
};

export const pipelineGetHistoryDetailAction: ActionDefinition<
  z.infer<typeof pipelineGetHistoryDetailParams>,
  unknown
> = {
  name: "pipeline_get_history_detail",
  description:
    "Read the full saved context (content, feedback, artifacts, data, humanNote) and engine result of a specific historical pipeline action record.",
  parameters: pipelineGetHistoryDetailParams,
  scopes: ["pipeline"],
  async handler(params, context) {
    if (!params.recordId && !params.sequence && !params.nodeId) {
      throw new Error(
        "Provide at least one selector: recordId, sequence, or nodeId (with optional attempt).",
      );
    }
    const engine = requirePipelineEngine(context);
    const record = await engine.getHistoryDetailForSession(context.sessionId, {
      recordId: params.recordId,
      sequence: params.sequence,
      nodeId: params.nodeId,
      attempt: params.attempt,
    });
    if (!record) {
      throw new Error("Matching pipeline history record not found.");
    }
    return { record };
  },
};

export const pipelineActions: readonly ActionDefinition<unknown, unknown>[] = [
  pipelineNextAction as ActionDefinition<unknown, unknown>,
  pipelinePrevAction as ActionDefinition<unknown, unknown>,
  pipelineRequestConfirmationAction as ActionDefinition<unknown, unknown>,
  pipelineFailAction as ActionDefinition<unknown, unknown>,
  pipelineGetContextAction as ActionDefinition<unknown, unknown>,
  pipelineListHistoryAction as ActionDefinition<unknown, unknown>,
  pipelineGetHistoryDetailAction as ActionDefinition<unknown, unknown>,
];
