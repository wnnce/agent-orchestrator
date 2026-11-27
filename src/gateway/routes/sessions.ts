import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import { streamSSE } from "hono/streaming";
import { ErrorCode } from "../../domain/errors.ts";
import type { EventHub } from "../../events/hub.ts";
import type { Store } from "../../persistence/store.ts";
import type { ProjectManager } from "../../project/manager.ts";
import {
  approveSessionToolRoute,
  compactSessionRoute,
  createProjectSessionRoute,
  createSessionRoute,
  deleteSessionRoute,
  downloadSessionArtifactRoute,
  getSessionRoute,
  interruptSessionRoute,
  listSessionArtifactsRoute,
  listSessionsRoute,
  renameSessionPatchRoute,
  renameSessionPostRoute,
  sessionEventsRoute,
  steerSessionRoute,
  submitTurnRoute,
} from "../contracts/sessions.ts";
import { createOpenAPIApp } from "../openapi.ts";
import type { SessionService } from "../../app/sessions.ts";

export interface SessionsRouteDeps {
  store: Store;
  projects: ProjectManager;
  eventHub: EventHub;
  sessions: SessionService;
}

export function createSessionsRouter(deps: SessionsRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  // 1. Create Session (Global or Project-scoped)
  router.openapi(createSessionRoute, async (c) => {
    const body = c.req.valid("json");
    const created = await deps.sessions.create({
      ...body,
      source: body.external?.channel ?? "web",
    });
    return c.json(created, 201);
  });

  router.openapi(createProjectSessionRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const created = await deps.sessions.create({
      ...body,
      projectId,
      source: body.external?.channel ?? "web",
    });
    return c.json(created, 201);
  });

  // 2. List & Query Sessions
  router.openapi(listSessionsRoute, async (c) => {
    const { projectId } = c.req.valid("query");
    const sessions = await deps.store.listSessions(projectId);
    return c.json({ sessions }, 200);
  });

  router.openapi(getSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const runtime = await deps.projects.runtimeForSession(sessionId);
    const session = await runtime.getSession(sessionId);
    const usage = await deps.store.getSessionUsage(sessionId);
    return c.json({ session, project: runtime.project.routing, usage }, 200);
  });

  router.openapi(deleteSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    await (await deps.projects.runtimeForSession(sessionId)).cleanupSession(sessionId);
    return c.json({ status: "deleted" as const, sessionId }, 200);
  });

  const renameValidationHook = (result: { success: boolean }, c: Context) => {
    if (!result.success) {
      return c.json({ error: ErrorCode.TITLE_REQUIRED, message: "title is required" }, 400);
    }
  };

  router.openapi(
    renameSessionPatchRoute,
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const { title } = c.req.valid("json");
      await (await deps.projects.runtimeForSession(sessionId)).renameSession(sessionId, title);
      return c.json({ status: "ok" as const, sessionId, title }, 200);
    },
    renameValidationHook,
  );

  router.openapi(
    renameSessionPostRoute,
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const { title } = c.req.valid("json");
      await (await deps.projects.runtimeForSession(sessionId)).renameSession(sessionId, title);
      return c.json({ status: "ok" as const, sessionId, title }, 200);
    },
    renameValidationHook,
  );

  // 3. Events Stream & History
  router.openapi(sessionEventsRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const project = await deps.projects.runtimeForSession(sessionId);
    const query = c.req.valid("query");

    const headerAfter = Number(c.req.header("last-event-id") ?? 0);
    const after = query.after ?? (Number.isFinite(headerAfter) ? headerAfter : 0);
    const initial = await project.events(sessionId, after);

    if (c.req.header("accept") !== "text/event-stream") {
      return c.json({ events: initial }, 200);
    }

    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());

      const keepAliveTimer = setInterval(() => {
        if (stream.aborted) {
          clearInterval(keepAliveTimer);
          return;
        }
        void stream.write(": keep-alive\n\n");
      }, 3000);

      try {
        const source = query.source ?? "web";
        for await (const event of deps.eventHub.stream(sessionId, {
          ...(query.after !== undefined ? { after: query.after } : {}),
          source,
          signal: ac.signal,
        })) {
          if (stream.aborted) break;
          await stream.writeSSE({
            id: String((event as { sequence?: number }).sequence),
            data: JSON.stringify(event),
          });
        }
      } finally {
        clearInterval(keepAliveTimer);
      }
    }) as unknown as Response & TypedResponse<string, 200, "text/event-stream">;
  });

  // 4. Artifacts
  router.openapi(listSessionArtifactsRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const { includeInternal } = c.req.valid("query");
    const runtime = await deps.projects.runtimeForSession(sessionId);
    const artifacts = await runtime.listArtifacts(sessionId, {
      includeInternal: includeInternal === "true",
    });
    return c.json({ artifacts }, 200);
  });

  router.openapi(downloadSessionArtifactRoute, async (c) => {
    const { sessionId, artifactId } = c.req.valid("param");
    const project = await deps.projects.runtimeForSession(sessionId);
    const artifact = await project.artifact(sessionId, artifactId);
    const content = await project.readArtifact(artifact);
    return new Response(Buffer.from(content), {
      headers: {
        "content-type": artifact.contentType,
        "content-length": String(content.byteLength),
      },
    }) as unknown as Response & TypedResponse<string, 200, "application/octet-stream">;
  });

  // 5. Turns & Interaction (Protected with Task Session Read-Only Guard)
  router.openapi(submitTurnRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const { input } = c.req.valid("json");
    const turn = await deps.sessions.submitTurn(sessionId, input);
    return c.json({ turn }, 202);
  });

  router.openapi(steerSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const { input } = c.req.valid("json");
    await (await deps.projects.runtimeForSession(sessionId)).steer(sessionId, input);
    return c.json({ status: "accepted" as const }, 202);
  });

  router.openapi(interruptSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    await (await deps.projects.runtimeForSession(sessionId)).interrupt(sessionId);
    return c.json({ status: "accepted" as const }, 202);
  });

  router.openapi(compactSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    await (await deps.projects.runtimeForSession(sessionId)).compact(sessionId);
    return c.json({ status: "accepted" as const }, 202);
  });

  router.openapi(
    approveSessionToolRoute,
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const { requestId, decision } = c.req.valid("json");
      await (
        await deps.projects.runtimeForSession(sessionId)
      ).approve(sessionId, requestId, decision);
      return c.json({ status: "accepted" as const }, 202);
    },
    (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: ErrorCode.INVALID_APPROVAL,
            message: 'Expected { requestId, decision: "approved" | "rejected" }',
          },
          400,
        );
      }
    },
  );

  return router;
}
