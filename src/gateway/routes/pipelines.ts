import type { OpenAPIHono } from "@hono/zod-openapi";
import type { TypedResponse } from "hono";
import { streamSSE } from "hono/streaming";
import type { ProjectManager } from "../../project/manager.ts";
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
}

export function createPipelinesRouter(deps: PipelinesRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  // 1. Project-scoped Pipeline Definitions & Run Creation / Listing
  router.openapi(listProjectPipelinesRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const runtime = deps.projects.get(projectId);
    const pipelines = await runtime.pipelineEngine.listPipelinesWithVersions();
    return c.json({ projectId, pipelines }, 200);
  });

  router.openapi(listPipelineRunsRoute, async (c) => {
    const { projectId, pipelineId } = c.req.valid("param");
    const runtime = deps.projects.get(projectId);
    const runs = await runtime.pipelineEngine.listRuns(pipelineId, c.req.valid("query"));
    return c.json({ projectId, pipelineId, runs }, 200);
  });

  router.openapi(startPipelineRunRoute, async (c) => {
    const { projectId, pipelineId } = c.req.valid("param");
    const runtime = deps.projects.get(projectId);
    const body = c.req.valid("json");
    const result = await runtime.pipelineEngine.startRun({
      pipelineId,
      ...body,
      createdBy: body.createdBy ?? "api",
    });
    return result.created ? c.json(result, 201) : c.json(result, 200);
  });

  router.openapi(pipelineEventsStreamRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const runtime = deps.projects.get(projectId);
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
    const runtime = await deps.projects.runtimeForPipelineRun(runId);
    const detail = await runtime.pipelineEngine.getRunDetail(runId);
    return c.json(detail, 200);
  });

  router.openapi(listPipelineRunActionsRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await deps.projects.runtimeForPipelineRun(runId);
    const { afterSeq, ...query } = c.req.valid("query");
    const actions = await runtime.pipelineEngine.listRunActions(runId, {
      ...query,
      ...(afterSeq !== undefined ? { afterSequence: afterSeq } : {}),
    });
    return c.json({ runId, actions }, 200);
  });

  router.openapi(approvePipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await deps.projects.runtimeForPipelineRun(runId);
    const run = await runtime.pipelineEngine.approveRun(runId, c.req.valid("json"));
    return c.json({ run }, 200);
  });

  router.openapi(rejectPipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await deps.projects.runtimeForPipelineRun(runId);
    const run = await runtime.pipelineEngine.rejectRun(runId, c.req.valid("json"));
    return c.json({ run }, 200);
  });

  router.openapi(retryPipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await deps.projects.runtimeForPipelineRun(runId);
    const run = await runtime.pipelineEngine.retryRun(runId, c.req.valid("json"));
    return c.json({ run }, 200);
  });

  router.openapi(cancelPipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await deps.projects.runtimeForPipelineRun(runId);
    const run = await runtime.pipelineEngine.cancelRun(runId, c.req.valid("json"));
    return c.json({ run }, 200);
  });

  router.openapi(signalPipelineRunRoute, async (c) => {
    const { runId } = c.req.valid("param");
    const runtime = await deps.projects.runtimeForPipelineRun(runId);
    const result = await runtime.pipelineEngine.signalRun(runId);
    return c.json(result, 200);
  });

  // 3. Pipeline Node Run Resources (addressed by globally unique nodeRunId)
  router.openapi(listPipelineNodeLogsRoute, async (c) => {
    const { nodeRunId } = c.req.valid("param");
    const runtime = await deps.projects.runtimeForNodeRun(nodeRunId);
    const { afterSeq, ...query } = c.req.valid("query");
    const logs = await runtime.pipelineEngine.listNodeRunLogs(nodeRunId, {
      ...query,
      ...(afterSeq !== undefined ? { afterSequence: afterSeq } : {}),
    });
    return c.json({ nodeRunId, logs }, 200);
  });

  return router;
}
