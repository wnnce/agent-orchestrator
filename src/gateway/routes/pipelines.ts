import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import { streamSSE } from "hono/streaming";
import type { Store } from "../../persistence/store.ts";
import {
  PipelineConflictError,
  PipelineNotFoundError,
  PipelineValidationError,
} from "../../pipeline/index.ts";
import type { ProjectManager } from "../../project/manager.ts";
import type { ProjectRuntime } from "../../project/runtime.ts";
import {
  approvePipelineRunRoute,
  cancelPipelineRunRoute,
  getPipelineRunDetailRoute,
  listPipelineNodeLogsRoute,
  listPipelineRunActionsRoute,
  listPipelineRunsRoute,
  listProjectPipelinesRoute,
  pipelineEventsStreamRoute,
  rejectPipelineRunRoute,
  retryPipelineRunRoute,
  signalPipelineRunRoute,
  startPipelineRunRoute,
} from "../contracts/pipelines.ts";
import { createOpenAPIApp } from "../openapi.ts";

export interface PipelinesRouteDeps {
  readonly projects: ProjectManager;
  readonly store: Store;
}

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

export function createPipelinesRouter(deps: PipelinesRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  // 1. Project-scoped Pipeline Definitions & Run Creation / Listing
  router.openapi(listProjectPipelinesRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const runtime = resolveProjectRuntime(deps.projects, projectId);
    if (!runtime) {
      return c.json(
        { error: "project_not_found", message: `project not found: ${projectId}` },
        404,
      );
    }
    const pipelines = await runtime.pipelineEngine.listPipelinesWithVersions();
    return c.json({ projectId, pipelines }, 200);
  });

  router.openapi(listPipelineRunsRoute, async (c) => {
    const { projectId, pipelineId } = c.req.valid("param");
    const runtime = resolveProjectRuntime(deps.projects, projectId);
    if (!runtime) {
      return c.json(
        { error: "project_not_found", message: `project not found: ${projectId}` },
        404,
      );
    }
    const query = c.req.valid("query");
    const runs = await runtime.pipelineEngine.listRuns(pipelineId, query);
    return c.json({ projectId, pipelineId, runs }, 200);
  });

  router.openapi(startPipelineRunRoute, async (c) => {
    const { projectId, pipelineId } = c.req.valid("param");
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
      return result.created ? c.json(result, 201) : c.json(result, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  router.openapi(pipelineEventsStreamRoute, async (c) => {
    const { projectId } = c.req.valid("param");
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
    }) as unknown as Response & TypedResponse<string, 200, "text/event-stream">;
  });

  // 2. Pipeline Run Resources (addressed by globally unique runId)
  router.openapi(getPipelineRunDetailRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await resolveRuntimeForRun(deps, runId);
    if (!runtime) {
      return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
    }
    try {
      const detail = await runtime.pipelineEngine.getRunDetail(runId);
      return c.json(detail, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  router.openapi(listPipelineRunActionsRoute, async (c) => {
    const { runId } = c.req.valid("param");
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
      return c.json({ runId, actions }, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  router.openapi(approvePipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await resolveRuntimeForRun(deps, runId);
    if (!runtime) {
      return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
    }
    const body = c.req.valid("json");
    try {
      const run = await runtime.pipelineEngine.approveRun(runId, body);
      return c.json({ run }, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  router.openapi(rejectPipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await resolveRuntimeForRun(deps, runId);
    if (!runtime) {
      return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
    }
    const body = c.req.valid("json");
    try {
      const run = await runtime.pipelineEngine.rejectRun(runId, body);
      return c.json({ run }, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  router.openapi(retryPipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await resolveRuntimeForRun(deps, runId);
    if (!runtime) {
      return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
    }
    const body = c.req.valid("json");
    try {
      const run = await runtime.pipelineEngine.retryRun(runId, body);
      return c.json({ run }, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  router.openapi(cancelPipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await resolveRuntimeForRun(deps, runId);
    if (!runtime) {
      return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
    }
    const body = c.req.valid("json");
    try {
      const run = await runtime.pipelineEngine.cancelRun(runId, body);
      return c.json({ run }, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  router.openapi(signalPipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await resolveRuntimeForRun(deps, runId);
    if (!runtime) {
      return c.json({ error: "not_found", message: `pipeline run not found: ${runId}` }, 404);
    }
    try {
      const result = await runtime.pipelineEngine.signalRun(runId);
      return c.json(result, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  // 3. Pipeline Node Run Resources (addressed by globally unique nodeRunId)
  router.openapi(listPipelineNodeLogsRoute, async (c) => {
    const { nodeRunId } = c.req.valid("param");
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
      return c.json({ nodeRunId, logs }, 200);
    } catch (err) {
      return handlePipelineError(c, err);
    }
  });

  return router;
}
