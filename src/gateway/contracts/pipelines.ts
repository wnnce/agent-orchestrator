import { createRoute, z } from "@hono/zod-openapi";
import {
  badRequestResponse,
  conflictResponse,
  jsonBody,
  jsonContent,
  notFoundResponse,
  projectIdParamSchema,
} from "./common.ts";

export const pipelineRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "waiting_confirmation",
  "completed",
  "failed",
  "cancelled",
]);

export const pipelineNodeRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "waiting_confirmation",
  "completed",
  "failed",
  "cancelled",
]);

export const pipelineExecutorTypeSchema = z.enum(["agent", "ts", "human", "terminal"]);
export const pipelineGateModeSchema = z.enum(["auto", "manual"]);
export const pipelineWorkspaceStatusSchema = z.enum(["none", "active", "cleaned"]);
export const pipelineActionNameSchema = z.enum([
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
export const pipelineActorTypeSchema = z.enum(["agent", "ts", "human", "system"]);
export const pipelineLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const pipelineNodeSnapshotSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    executor: pipelineExecutorTypeSchema,
    terminal: z.boolean(),
    gate: pipelineGateModeSchema,
    allowPrev: z.boolean(),
    prevTargets: z.array(z.string()).readonly(),
    maxLoops: z.number().int(),
  })
  .openapi("PipelineNodeSnapshot");

export const pipelineRevisionRecordSchema = z
  .object({
    id: z.number().int().optional(),
    projectId: z.string(),
    pipelineId: z.string(),
    version: z.number().int(),
    topologyHash: z.string(),
    nodesSnapshot: z.array(pipelineNodeSnapshotSchema).readonly(),
    createdAt: z.string(),
  })
  .openapi("PipelineRevisionRecord");

export const pipelineSummaryWithVersionsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    enabled: z.boolean(),
    currentVersion: z.number().int(),
    currentTopologyHash: z.string(),
    nodes: z.array(pipelineNodeSnapshotSchema).readonly(),
    entryInputSchema: z.record(z.string(), z.unknown()).optional(),
    notifyOn: z.array(pipelineRunStatusSchema).readonly(),
    activeVersions: z
      .array(
        z.object({
          version: z.number().int(),
          activeRunCount: z.number().int(),
          totalRunCount: z.number().int(),
          nodes: z.array(pipelineNodeSnapshotSchema).readonly(),
        }),
      )
      .readonly(),
  })
  .openapi("PipelineSummaryWithVersions");

const pipelineNodeOutputSummarySchema = z.object({
  nodeId: z.string(),
  attempt: z.number().int(),
  recordId: z.string(),
  action: pipelineActionNameSchema,
  summary: z.string(),
  createdAt: z.string(),
});

export const pipelineRunRecordSchema = z
  .object({
    id: z.number().int().optional(),
    runId: z.string(),
    projectId: z.string(),
    pipelineId: z.string(),
    pipelineVersion: z.number().int(),
    title: z.string(),
    description: z.string().optional(),
    externalKey: z.string().optional(),
    externalUrl: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
    metadata: z.record(z.string(), z.unknown()),
    status: pipelineRunStatusSchema,
    currentNodeId: z.string(),
    activeNodeRunId: z.string().optional(),
    workspacePath: z.string().optional(),
    branchName: z.string().optional(),
    workspaceStatus: pipelineWorkspaceStatusSchema,
    loopCounts: z.record(z.string(), z.number().int()),
    latestNodeOutputs: z.record(z.string(), pipelineNodeOutputSummarySchema),
    statusSummary: z.string().optional(),
    createdBy: z.string(),
    stateVersion: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().optional(),
  })
  .openapi("PipelineRunRecord");

const pipelineStepStateSchema = z.object({
  steps: z.record(z.string(), z.unknown()).optional(),
  waits: z.record(z.string(), z.unknown()).optional(),
});

const pipelineActionContextSchema = z.object({
  summary: z.string().optional(),
  content: z.string().optional(),
  artifacts: z.array(z.string()).readonly().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  targetNodeId: z.string().optional(),
  reason: z.string().optional(),
  feedback: z.string().optional(),
  question: z.string().optional(),
  humanNote: z.string().optional(),
});

export const pipelineNodeRunRecordSchema = z
  .object({
    id: z.number().int().optional(),
    nodeRunId: z.string(),
    runId: z.string(),
    projectId: z.string(),
    pipelineId: z.string(),
    nodeId: z.string(),
    attempt: z.number().int(),
    sequence: z.number().int(),
    executorType: pipelineExecutorTypeSchema,
    triggeredByRecordId: z.string().optional(),
    traceparent: z.string().optional(),
    status: pipelineNodeRunStatusSchema,
    sessionId: z.string().optional(),
    inputContext: z.record(z.string(), z.unknown()),
    stepState: pipelineStepStateSchema,
    nextPollAt: z.string().optional(),
    pollCount: z.number().int(),
    agentTurnId: z.string().optional(),
    reminderSent: z.boolean(),
    pendingDecision: z
      .object({
        action: pipelineActionNameSchema,
        context: pipelineActionContextSchema,
        turnId: z.string().optional(),
      })
      .optional(),
    outputSummary: z.string().optional(),
    finalAction: pipelineActionNameSchema.optional(),
    errorMessage: z.string().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    durationMs: z.number().int().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("PipelineNodeRunRecord");

export const pipelineActionRecordSchema = z
  .object({
    id: z.number().int().optional(),
    recordId: z.string(),
    runId: z.string(),
    projectId: z.string(),
    sequence: z.number().int(),
    nodeRunId: z.string().optional(),
    nodeId: z.string(),
    attempt: z.number().int(),
    action: pipelineActionNameSchema,
    actorType: pipelineActorTypeSchema,
    actorId: z.string().optional(),
    fromNodeId: z.string(),
    toNodeId: z.string().optional(),
    fromStatus: pipelineRunStatusSchema,
    toStatus: pipelineRunStatusSchema,
    context: pipelineActionContextSchema,
    result: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .openapi("PipelineActionRecord");

export const pipelineNodeLogRecordSchema = z
  .object({
    id: z.number().int().optional(),
    nodeRunId: z.string(),
    runId: z.string(),
    projectId: z.string(),
    sequence: z.number().int(),
    level: pipelineLogLevelSchema,
    message: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string(),
  })
  .openapi("PipelineNodeLogRecord");

const projectPipelineParamsSchema = projectIdParamSchema.extend({
  pipelineId: z
    .string()
    .min(1)
    .openapi({ param: { name: "pipelineId", in: "path" } }),
});

const runIdParamSchema = z.object({
  runId: z
    .string()
    .min(1)
    .openapi({ param: { name: "runId", in: "path" } }),
});

const nodeRunIdParamSchema = z.object({
  nodeRunId: z
    .string()
    .min(1)
    .openapi({ param: { name: "nodeRunId", in: "path" } }),
});

export const listProjectPipelinesRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/pipelines",
  tags: ["Pipelines"],
  summary: "List pipelines configured for a project",
  request: {
    params: projectIdParamSchema,
  },
  responses: {
    200: jsonContent(
      z.object({
        projectId: z.string(),
        pipelines: z.array(pipelineSummaryWithVersionsSchema),
      }),
      "Project pipelines with active run counts and topology versions",
    ),
    404: notFoundResponse,
  },
});

export const listPipelineRunsRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/pipelines/{pipelineId}/runs",
  tags: ["Pipelines"],
  summary: "List pipeline runs with optional version, status, and node filters",
  request: {
    params: projectPipelineParamsSchema,
    query: z.object({
      status: pipelineRunStatusSchema.optional(),
      version: z.coerce.number().int().positive().optional(),
      nodeId: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      beforeId: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .openapi({ description: "Keyset pagination: only runs created before this `id`" }),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        projectId: z.string(),
        pipelineId: z.string(),
        runs: z.array(pipelineRunRecordSchema),
      }),
      "Matching pipeline runs",
    ),
    404: notFoundResponse,
  },
});

const startRunResponseSchema = z.object({
  created: z.boolean(),
  run: pipelineRunRecordSchema,
});

export const startPipelineRunRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/pipelines/{pipelineId}/runs",
  tags: ["Pipelines"],
  summary: "Start a new pipeline run (idempotent when externalKey is provided)",
  request: {
    params: projectPipelineParamsSchema,
    body: jsonBody(
      z.object({
        title: z.string().trim().min(1, "title is required"),
        description: z.string().optional(),
        externalKey: z.string().trim().min(1).optional(),
        externalUrl: z.string().trim().min(1).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        createdBy: z.string().trim().min(1).optional(),
      }),
    ),
  },
  responses: {
    200: jsonContent(startRunResponseSchema, "Existing pipeline run matched by externalKey"),
    201: jsonContent(startRunResponseSchema, "New pipeline run created"),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});

export const pipelineEventsStreamRoute = createRoute({
  method: "get",
  path: "/projects/{projectId}/pipeline-events",
  tags: ["Pipelines"],
  summary: "Subscribe to project pipeline run and action events via SSE",
  request: {
    params: projectIdParamSchema,
    query: z.object({
      pipelineId: z.string().min(1).optional(),
      runId: z.string().min(1).optional(),
    }),
  },
  responses: {
    200: {
      description: "Server-Sent Events stream of PipelineStreamEvent payloads",
      content: {
        "text/event-stream": {
          schema: z.string().openapi({
            description: "Server-Sent Events stream of pipeline lifecycle events",
          }),
        },
      },
    },
    404: notFoundResponse,
  },
});

export const getPipelineRunDetailRoute = createRoute({
  method: "get",
  path: "/pipeline-runs/{runId}",
  tags: ["Pipelines"],
  summary: "Get pipeline run detail including pinned topology revision and node run history",
  request: {
    params: runIdParamSchema,
  },
  responses: {
    200: jsonContent(
      z.object({
        run: pipelineRunRecordSchema,
        revision: pipelineRevisionRecordSchema.nullable(),
        nodeRuns: z.array(pipelineNodeRunRecordSchema),
        actionCount: z.number().int(),
      }),
      "Pipeline run detail",
    ),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});

export const listPipelineRunActionsRoute = createRoute({
  method: "get",
  path: "/pipeline-runs/{runId}/actions",
  tags: ["Pipelines"],
  summary: "List immutable action audit records for a pipeline run",
  request: {
    params: runIdParamSchema,
    query: z.object({
      nodeId: z.string().min(1).optional(),
      action: pipelineActionNameSchema.optional(),
      afterSeq: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        runId: z.string(),
        actions: z.array(pipelineActionRecordSchema),
      }),
      "Ordered pipeline action records",
    ),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});

export const approvePipelineRunRoute = createRoute({
  method: "post",
  path: "/pipeline-runs/{runId}/approve",
  tags: ["Pipelines"],
  summary: "Approve a pipeline run waiting for human confirmation",
  request: {
    params: runIdParamSchema,
    body: jsonBody(
      z.object({
        humanNote: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        actorId: z.string().optional(),
      }),
    ),
  },
  responses: {
    200: jsonContent(z.object({ run: pipelineRunRecordSchema }), "Updated pipeline run"),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});

export const rejectPipelineRunRoute = createRoute({
  method: "post",
  path: "/pipeline-runs/{runId}/reject",
  tags: ["Pipelines"],
  summary: "Reject a pipeline run back to an allowed upstream node",
  request: {
    params: runIdParamSchema,
    body: jsonBody(
      z.object({
        reason: z.string().trim().min(1, "reason is required"),
        feedback: z.string().trim().min(1, "feedback is required"),
        targetNodeId: z.string().trim().min(1).optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        actorId: z.string().optional(),
      }),
    ),
  },
  responses: {
    200: jsonContent(z.object({ run: pipelineRunRecordSchema }), "Updated pipeline run"),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});

export const retryPipelineRunRoute = createRoute({
  method: "post",
  path: "/pipeline-runs/{runId}/retry",
  tags: ["Pipelines"],
  summary: "Retry a failed pipeline run from its current node",
  request: {
    params: runIdParamSchema,
    body: jsonBody(
      z.object({
        preserveStepState: z.boolean().optional(),
        actorId: z.string().optional(),
      }),
    ),
  },
  responses: {
    200: jsonContent(z.object({ run: pipelineRunRecordSchema }), "Updated pipeline run"),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});

export const cancelPipelineRunRoute = createRoute({
  method: "post",
  path: "/pipeline-runs/{runId}/cancel",
  tags: ["Pipelines"],
  summary: "Cancel an active pipeline run and clean up its shared workspace",
  request: {
    params: runIdParamSchema,
    body: jsonBody(
      z.object({
        reason: z.string().optional(),
        actorId: z.string().optional(),
      }),
    ),
  },
  responses: {
    200: jsonContent(z.object({ run: pipelineRunRecordSchema }), "Cancelled pipeline run"),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});

export const signalPipelineRunRoute = createRoute({
  method: "post",
  path: "/pipeline-runs/{runId}/signal",
  tags: ["Pipelines"],
  summary: "Immediately wake a pipeline run waiting on a TS waitUntil poll",
  request: {
    params: runIdParamSchema,
  },
  responses: {
    200: jsonContent(
      z.object({
        woken: z.boolean(),
        run: pipelineRunRecordSchema,
      }),
      "Signal accepted and run queued for re-evaluation",
    ),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});

export const listPipelineNodeLogsRoute = createRoute({
  method: "get",
  path: "/pipeline-node-runs/{nodeRunId}/logs",
  tags: ["Pipelines"],
  summary: "List persisted structured logs for a pipeline node run",
  request: {
    params: nodeRunIdParamSchema,
    query: z.object({
      afterSeq: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
      level: pipelineLogLevelSchema.optional(),
    }),
  },
  responses: {
    200: jsonContent(
      z.object({
        nodeRunId: z.string(),
        logs: z.array(pipelineNodeLogRecordSchema),
      }),
      "Ordered node run log entries",
    ),
    400: badRequestResponse,
    404: notFoundResponse,
    409: conflictResponse,
  },
});
