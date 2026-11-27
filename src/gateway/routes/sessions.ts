import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import { streamSSE } from "hono/streaming";
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
import type { GatewayService } from "../service.ts";

export interface SessionsRouteDeps {
  store: Store;
  projects: ProjectManager;
  eventHub: EventHub;
  service: GatewayService;
}

export function createSessionsRouter(deps: SessionsRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  // 1. Create Session (Global or Project-scoped)
  router.openapi(createSessionRoute, async (c) => {
    const body = c.req.valid("json");
    const created = await deps.service.createSession({
      ...body,
      source: body.external?.channel ?? "web",
    });
    return c.json(created, 201);
  });

  router.openapi(createProjectSessionRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const created = await deps.service.createSession({
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
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    const usage = await deps.store.getSessionUsage(sessionId);
    return c.json({ session: route, project: project.project.routing, usage }, 200);
  });

  router.openapi(deleteSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    await project.cleanupSession(sessionId);
    return c.json({ status: "deleted" as const, sessionId }, 200);
  });

  const renameValidationHook = (result: { success: boolean }, c: Context) => {
    if (!result.success) {
      return c.json({ error: "title_required" }, 400);
    }
  };

  router.openapi(
    renameSessionPatchRoute,
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const { title } = c.req.valid("json");
      const ok = await deps.service.renameSession(sessionId, title);
      if (!ok) return c.json({ error: "session_not_found" }, 404);
      return c.json({ status: "ok" as const, sessionId, title }, 200);
    },
    renameValidationHook,
  );

  router.openapi(
    renameSessionPostRoute,
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const { title } = c.req.valid("json");
      const ok = await deps.service.renameSession(sessionId, title);
      if (!ok) return c.json({ error: "session_not_found" }, 404);
      return c.json({ status: "ok" as const, sessionId, title }, 200);
    },
    renameValidationHook,
  );

  // 3. Events Stream & History
  router.openapi(sessionEventsRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
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
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    const allArtifacts = await project.listArtifacts(sessionId);
    const artifacts =
      includeInternal === "true"
        ? allArtifacts
        : allArtifacts.filter((a) => a.kind !== "agent-message");
    return c.json({ artifacts }, 200);
  });

  router.openapi(downloadSessionArtifactRoute, async (c) => {
    const { sessionId, artifactId } = c.req.valid("param");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
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
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);

    if (route.source === "task") {
      return c.json(
        {
          error: "task_session_read_only",
          message: "Task session is automated and read-only; manual turn input is disabled.",
        },
        403,
      );
    }

    const { input } = c.req.valid("json");
    const turn = await deps.service.submitTurn(sessionId, input);
    return c.json({ turn }, 202);
  });

  router.openapi(steerSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    const { input } = c.req.valid("json");
    await project.steer(sessionId, input);
    return c.json({ status: "accepted" as const }, 202);
  });

  router.openapi(interruptSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    await project.interrupt(sessionId);
    return c.json({ status: "accepted" as const }, 202);
  });

  router.openapi(compactSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    await project.compact(sessionId);
    return c.json({ status: "accepted" as const }, 202);
  });

  router.openapi(
    approveSessionToolRoute,
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      const { requestId, decision } = c.req.valid("json");
      await project.approve(sessionId, requestId, decision);
      return c.json({ status: "accepted" as const }, 202);
    },
    (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "invalid_approval",
            message: 'Expected { requestId, decision: "approved" | "rejected" }',
          },
          400,
        );
      }
    },
  );

  return router;
}
