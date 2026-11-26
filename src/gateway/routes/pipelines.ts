import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import type { Store } from "../../persistence/store.ts";
import {
  PipelineConflictError,
  PipelineNotFoundError,
  PipelineValidationError,
} from "../../pipeline/index.ts";
import type { ProjectManager } from "../../project/manager.ts";
import type { ProjectRuntime } from "../../project/runtime.ts";

export interface PipelinesRouteDeps {
  readonly projects: ProjectManager;
  readonly store: Store;
}

const pipelineRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "waiting_confirmation",
  "completed",
  "failed",
  "cancelled",
]);

const pipelineNodeRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "waiting_confirmation",
  "completed",
  "failed",
  "cancelled",
]);

const pipelineExecutorTypeSchema = z.enum(["agent", "ts", "human", "terminal"]);
const pipelineGateModeSchema = z.enum(["auto", "manual"]);
const pipelineWorkspaceStatusSchema = z.enum(["none", "active", "cleaned"]);
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
const pipelineActorTypeSchema = z.enum(["agent", "ts", "human", "system"]);
const pipelineLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const pipelineNodeSnapshotSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    executor: pipelineExecutorTypeSchema,
    terminal: z.boolean(),
    gate: pipelineGateModeSchema,
    allowPrev: z.boolean(),
    prevTargets: z.array(z.string()),
    maxLoops: z.number().int(),
  })
  .meta({ ref: "PipelineNodeSnapshot" });

const pipelineRevisionRecordSchema = z
  .object({
    id: z.number().int().optional(),
    projectId: z.string(),
    pipelineId: z.string(),
    version: z.number().int(),
    topologyHash: z.string(),
    nodesSnapshot: z.array(pipelineNodeSnapshotSchema),
    createdAt: z.string(),
  })
  .meta({ ref: "PipelineRevisionRecord" });

const pipelineSummaryWithVersionsSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    enabled: z.boolean(),
    currentVersion: z.number().int(),
    currentTopologyHash: z.string(),
    nodes: z.array(pipelineNodeSnapshotSchema),
    entryInputSchema: z.record(z.string(), z.unknown()).optional(),
    notifyOn: z.array(pipelineRunStatusSchema),
    activeVersions: z.array(
      z.object({
        version: z.number().int(),
        activeRunCount: z.number().int(),
        totalRunCount: z.number().int(),
        nodes: z.array(pipelineNodeSnapshotSchema),
      }),
    ),
  })
  .meta({ ref: "PipelineSummaryWithVersions" });

const pipelineNodeOutputSummarySchema = z.object({
  nodeId: z.string(),
  attempt: z.number().int(),
  recordId: z.string(),
  action: pipelineActionNameSchema,
  summary: z.string(),
  createdAt: z.string(),
});

const pipelineRunRecordSchema = z
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
  .meta({ ref: "PipelineRunRecord" });

const pipelineNodeRunRecordSchema = z
  .object({
    nodeRunId: z.string(),
    runId: z.string(),
    projectId: z.string(),
    pipelineId: z.string(),
    nodeId: z.string(),
    attempt: z.number().int(),
    sequence: z.number().int(),
    executorType: pipelineExecutorTypeSchema,
    triggeredByRecordId: z.string().optional(),
    status: pipelineNodeRunStatusSchema,
    sessionId: z.string().optional(),
    inputContext: z.record(z.string(), z.unknown()),
    stepState: z.record(z.string(), z.unknown()),
    nextPollAt: z.string().optional(),
    pollCount: z.number().int(),
    agentTurnId: z.string().optional(),
    reminderSent: z.boolean(),
    pendingDecision: z
      .object({
        action: pipelineActionNameSchema,
        context: z.record(z.string(), z.unknown()),
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
  .meta({ ref: "PipelineNodeRunRecord" });

const pipelineActionRecordSchema = z
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
    context: z.record(z.string(), z.unknown()),
    result: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .meta({ ref: "PipelineActionRecord" });

const pipelineNodeLogRecordSchema = z
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
  .meta({ ref: "PipelineNodeLogRecord" });

const listRunsQuerySchema = z.object({
  status: pipelineRunStatusSchema.optional(),
  version: z.coerce.number().int().positive().optional(),
  nodeId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Keyset pagination: only runs created before the run with this `id`. */
  beforeId: z.coerce.number().int().positive().optional(),
});

const startRunBodySchema = z.object({
  title: z.string().trim().min(1, "title is required"),
  description: z.string().optional(),
  externalKey: z.string().trim().min(1).optional(),
  externalUrl: z.string().trim().min(1).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.string().trim().min(1).optional(),
});

const listActionsQuerySchema = z.object({
  nodeId: z.string().min(1).optional(),
  action: pipelineActionNameSchema.optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const listNodeLogsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  level: pipelineLogLevelSchema.optional(),
});

const approveRunBodySchema = z.object({
  humanNote: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  actorId: z.string().optional(),
});

const rejectRunBodySchema = z.object({
  reason: z.string().trim().min(1, "reason is required"),
  feedback: z.string().trim().min(1, "feedback is required"),
  targetNodeId: z.string().trim().min(1).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  actorId: z.string().optional(),
});

const retryRunBodySchema = z.object({
  preserveStepState: z.boolean().optional(),
  actorId: z.string().optional(),
});

const cancelRunBodySchema = z.object({
  reason: z.string().optional(),
  actorId: z.string().optional(),
});

const streamQuerySchema = z.object({
  pipelineId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
});

function resolveProjectRuntime(projects: ProjectManager, projectId: string): ProjectRuntime | null {
  try {
    return projects.get(projectId);
  } catch {
    return null;
  }
}

async function resolveRuntimeForRun(
  deps: PipelinesRouteDeps,
  runId: string,
): Promise<ProjectRuntime | null> {
  const run = await deps.store.pipelines.getRun(runId);
  if (!run) return null;
  return resolveProjectRuntime(deps.projects, run.projectId);
}

async function resolveRuntimeForNodeRun(
  deps: PipelinesRouteDeps,
  nodeRunId: string,
): Promise<ProjectRuntime | null> {
  const nodeRun = await deps.store.pipelines.getNodeRun(nodeRunId);
  if (!nodeRun) return null;
  return resolveProjectRuntime(deps.projects, nodeRun.projectId);
}

function handlePipelineError(c: Context, err: unknown) {
  if (err instanceof PipelineNotFoundError) {
    return c.json({ error: "not_found", message: err.message }, 404);
  }
  if (err instanceof PipelineConflictError) {
    return c.json({ error: "conflict", message: err.message }, 409);
  }
  if (err instanceof PipelineValidationError) {
    return c.json({ error: "validation_error", message: err.message }, 400);
  }
  throw err;
}

export function createPipelinesRouter(deps: PipelinesRouteDeps): Hono {
  const router = new Hono();

  // =========================================================================
  // Project-scoped Pipeline Definitions & Run Creation / Listing
  // =========================================================================

  // 1. List project pipelines (with topology version summaries)
  router.get(
    "/projects/:projectId/pipelines",
    describeRoute({
      tags: ["Pipelines"],
      summary: "List pipelines configured for a project",
      responses: {
        200: {
          description: "Project pipelines with active run counts and topology versions",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  projectId: z.string(),
                  pipelines: z.array(pipelineSummaryWithVersionsSchema),
                }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      const projectId = c.req.param("projectId");
      const runtime = resolveProjectRuntime(deps.projects, projectId);
      if (!runtime) {
        return c.json(
          { error: "project_not_found", message: `project not found: ${projectId}` },
          404,
        );
      }
      const pipelines = await runtime.pipelineEngine.listPipelinesWithVersions();
      return c.json({ projectId, pipelines });
    },
  );

  // 2. List runs for a specific pipeline (filterable by version, status, nodeId)
  router.get(
    "/projects/:projectId/pipelines/:pipelineId/runs",
    describeRoute({
      tags: ["Pipelines"],
      summary: "List pipeline runs with optional version, status, and node filters",
      responses: {
        200: {
          description: "Matching pipeline runs",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  projectId: z.string(),
                  pipelineId: z.string(),
                  runs: z.array(pipelineRunRecordSchema),
                }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("query", listRunsQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const pipelineId = c.req.param("pipelineId");
      const runtime = resolveProjectRuntime(deps.projects, projectId);
      if (!runtime) {
        return c.json(
          { error: "project_not_found", message: `project not found: ${projectId}` },
          404,
        );
      }
      const query = c.req.valid("query");
      const runs = await runtime.pipelineEngine.listRuns(pipelineId, query);
      return c.json({ projectId, pipelineId, runs });
    },
  );

  // 3. Start a new Pipeline Run (or return existing run on externalKey idempotency hit)
  router.post(
    "/projects/:projectId/pipelines/:pipelineId/runs",
    describeRoute({
      tags: ["Pipelines"],
      summary: "Start a new pipeline run (idempotent when externalKey is provided)",
      responses: {
        200: {
          description: "Existing pipeline run matched by externalKey",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  created: z.boolean(),
                  run: pipelineRunRecordSchema,
                }),
              ),
            },
          },
        },
        201: {
          description: "New pipeline run created",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  created: z.boolean(),
                  run: pipelineRunRecordSchema,
                }),
              ),
            },
          },
        },
        400: { $ref: "#/components/responses/BadRequest" },
        404: { $ref: "#/components/responses/NotFound" },
        409: { $ref: "#/components/responses/Conflict" },
      },
    }),
    validator("json", startRunBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const pipelineId = c.req.param("pipelineId");
      const runtime = resolveProjectRuntime(deps.projects, projectId);
      if (!runtime) {
        return c.json(
          { error: "project_not_found", message: `project not found: ${projectId}` },
          404,
        );
      }
      const body = c.req.valid("json");
      try {
        const result = await runtime.pipelineEngine.startRun({
          pipelineId,
          ...body,
          createdBy: body.createdBy ?? "api",
        });
        return c.json(result, result.created ? 201 : 200);
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  // 4. Project-level real-time Pipeline SSE stream (dedicated sibling resource)
  router.get(
    "/projects/:projectId/pipeline-events",
    describeRoute({
      tags: ["Pipelines"],
      summary: "Subscribe to project pipeline run and action events via SSE",
      responses: {
        200: {
          description: "Server-Sent Events stream of PipelineStreamEvent payloads",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                description: "Server-Sent Events stream of pipeline lifecycle events",
              },
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("query", streamQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const runtime = resolveProjectRuntime(deps.projects, projectId);
      if (!runtime) {
        return c.json(
          { error: "project_not_found", message: `project not found: ${projectId}` },
          404,
        );
      }
      const filter = c.req.valid("query");

      return streamSSE(c, async (stream) => {
        const ac = new AbortController();
        stream.onAbort(() => ac.abort());

        const keepAlive = setInterval(() => {
          void stream.write(": keep-alive\n\n").catch(() => ac.abort());
        }, 15_000);

        try {
          await stream.writeSSE({
            event: "connected",
            data: JSON.stringify({ projectId }),
          });
          for await (const event of runtime.pipelineEventHub.stream(projectId, ac.signal)) {
            if (filter.pipelineId && event.pipelineId !== filter.pipelineId) continue;
            if (filter.runId && event.runId !== filter.runId) continue;
            await stream.writeSSE({
              id: event.id,
              event: event.type,
              data: JSON.stringify(event),
            });
          }
        } finally {
          clearInterval(keepAlive);
          ac.abort();
        }
      });
    },
  );

  // =========================================================================
  // Pipeline Run Resources (addressed by globally unique runId)
  // =========================================================================

  // 5. Get single Pipeline Run detail (run + pinned revision + nodeRuns)
  router.get(
    "/pipeline-runs/:runId",
    describeRoute({
      tags: ["Pipelines"],
      summary: "Get pipeline run detail including pinned topology revision and node run history",
      responses: {
        200: {
          description: "Pipeline run detail",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  run: pipelineRunRecordSchema,
                  revision: pipelineRevisionRecordSchema.nullable(),
                  nodeRuns: z.array(pipelineNodeRunRecordSchema),
                  actionCount: z.number().int(),
                }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      const runId = c.req.param("runId");
      const runtime = await resolveRuntimeForRun(deps, runId);
      if (!runtime) {
        return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
      }
      try {
        const detail = await runtime.pipelineEngine.getRunDetail(runId);
        return c.json(detail);
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  // 6. List immutable Action audit records for a Pipeline Run
  router.get(
    "/pipeline-runs/:runId/actions",
    describeRoute({
      tags: ["Pipelines"],
      summary: "List immutable action audit records for a pipeline run",
      responses: {
        200: {
          description: "Ordered pipeline action records",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  runId: z.string(),
                  actions: z.array(pipelineActionRecordSchema),
                }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("query", listActionsQuerySchema),
    async (c) => {
      const runId = c.req.param("runId");
      const runtime = await resolveRuntimeForRun(deps, runId);
      if (!runtime) {
        return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
      }
      const { afterSeq, ...query } = c.req.valid("query");
      try {
        const actions = await runtime.pipelineEngine.listRunActions(runId, {
          ...query,
          ...(afterSeq !== undefined ? { afterSequence: afterSeq } : {}),
        });
        return c.json({ runId, actions });
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  // 7. Approve a Pipeline Run currently waiting for confirmation
  router.post(
    "/pipeline-runs/:runId/approve",
    describeRoute({
      tags: ["Pipelines"],
      summary: "Approve a pipeline run waiting for human confirmation",
      responses: {
        200: {
          description: "Updated pipeline run",
          content: {
            "application/json": {
              schema: resolver(z.object({ run: pipelineRunRecordSchema })),
            },
          },
        },
        400: { $ref: "#/components/responses/BadRequest" },
        404: { $ref: "#/components/responses/NotFound" },
        409: { $ref: "#/components/responses/Conflict" },
      },
    }),
    validator("json", approveRunBodySchema),
    async (c) => {
      const runId = c.req.param("runId");
      const runtime = await resolveRuntimeForRun(deps, runId);
      if (!runtime) {
        return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
      }
      const body = c.req.valid("json");
      try {
        const run = await runtime.pipelineEngine.approveRun(runId, body);
        return c.json({ run });
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  // 8. Reject a Pipeline Run back to an upstream node
  router.post(
    "/pipeline-runs/:runId/reject",
    describeRoute({
      tags: ["Pipelines"],
      summary: "Reject a pipeline run back to an allowed upstream node",
      responses: {
        200: {
          description: "Updated pipeline run",
          content: {
            "application/json": {
              schema: resolver(z.object({ run: pipelineRunRecordSchema })),
            },
          },
        },
        400: { $ref: "#/components/responses/BadRequest" },
        404: { $ref: "#/components/responses/NotFound" },
        409: { $ref: "#/components/responses/Conflict" },
      },
    }),
    validator("json", rejectRunBodySchema),
    async (c) => {
      const runId = c.req.param("runId");
      const runtime = await resolveRuntimeForRun(deps, runId);
      if (!runtime) {
        return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
      }
      const body = c.req.valid("json");
      try {
        const run = await runtime.pipelineEngine.rejectRun(runId, body);
        return c.json({ run });
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  // 9. Retry a failed Pipeline Run at its current node
  router.post(
    "/pipeline-runs/:runId/retry",
    describeRoute({
      tags: ["Pipelines"],
      summary: "Retry a failed pipeline run from its current node",
      responses: {
        200: {
          description: "Updated pipeline run",
          content: {
            "application/json": {
              schema: resolver(z.object({ run: pipelineRunRecordSchema })),
            },
          },
        },
        400: { $ref: "#/components/responses/BadRequest" },
        404: { $ref: "#/components/responses/NotFound" },
        409: { $ref: "#/components/responses/Conflict" },
      },
    }),
    validator("json", retryRunBodySchema),
    async (c) => {
      const runId = c.req.param("runId");
      const runtime = await resolveRuntimeForRun(deps, runId);
      if (!runtime) {
        return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
      }
      const body = c.req.valid("json");
      try {
        const run = await runtime.pipelineEngine.retryRun(runId, body);
        return c.json({ run });
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  // 10. Force-cancel a non-terminal Pipeline Run with cascading cleanup
  router.post(
    "/pipeline-runs/:runId/cancel",
    describeRoute({
      tags: ["Pipelines"],
      summary: "Cancel an active pipeline run and clean up its shared workspace",
      responses: {
        200: {
          description: "Cancelled pipeline run",
          content: {
            "application/json": {
              schema: resolver(z.object({ run: pipelineRunRecordSchema })),
            },
          },
        },
        400: { $ref: "#/components/responses/BadRequest" },
        404: { $ref: "#/components/responses/NotFound" },
        409: { $ref: "#/components/responses/Conflict" },
      },
    }),
    validator("json", cancelRunBodySchema),
    async (c) => {
      const runId = c.req.param("runId");
      const runtime = await resolveRuntimeForRun(deps, runId);
      if (!runtime) {
        return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
      }
      const body = c.req.valid("json");
      try {
        const run = await runtime.pipelineEngine.cancelRun(runId, body);
        return c.json({ run });
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  // 11. Wake a waiting TS node immediately via external signal
  router.post(
    "/pipeline-runs/:runId/signal",
    describeRoute({
      tags: ["Pipelines"],
      summary: "Immediately wake a pipeline run waiting on a TS waitUntil poll",
      responses: {
        200: {
          description: "Signal accepted and run queued for re-evaluation",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  woken: z.boolean(),
                  run: pipelineRunRecordSchema,
                }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
        409: { $ref: "#/components/responses/Conflict" },
      },
    }),
    async (c) => {
      const runId = c.req.param("runId");
      const runtime = await resolveRuntimeForRun(deps, runId);
      if (!runtime) {
        return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
      }
      try {
        const result = await runtime.pipelineEngine.signalRun(runId);
        return c.json(result);
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  // =========================================================================
  // Pipeline Node Run Resources (addressed by globally unique nodeRunId)
  // =========================================================================

  // 12. Read persisted structured logs for a TS node run
  router.get(
    "/pipeline-node-runs/:nodeRunId/logs",
    describeRoute({
      tags: ["Pipelines"],
      summary: "List persisted structured logs for a pipeline node run",
      responses: {
        200: {
          description: "Ordered node run log entries",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  nodeRunId: z.string(),
                  logs: z.array(pipelineNodeLogRecordSchema),
                }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("query", listNodeLogsQuerySchema),
    async (c) => {
      const nodeRunId = c.req.param("nodeRunId");
      const runtime = await resolveRuntimeForNodeRun(deps, nodeRunId);
      if (!runtime) {
        return c.json(
          { error: "not_found", message: `pipeline node run not found: ${nodeRunId}` },
          404,
        );
      }
      const { afterSeq, ...query } = c.req.valid("query");
      try {
        const logs = await runtime.pipelineEngine.listNodeRunLogs(nodeRunId, {
          ...query,
          ...(afterSeq !== undefined ? { afterSequence: afterSeq } : {}),
        });
        return c.json({ nodeRunId, logs });
      } catch (err) {
        return handlePipelineError(c, err);
      }
    },
  );

  return router;
}
