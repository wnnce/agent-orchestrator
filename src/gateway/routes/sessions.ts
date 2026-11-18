import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Store } from "../../persistence/store.ts";
import type { ProjectManager } from "../../project/manager.ts";
import type { EventHub } from "../../events/hub.ts";
import type { GatewayService, CreateSessionInput } from "../service.ts";

export interface SessionsRouteDeps {
  store: Store;
  projects: ProjectManager;
  eventHub: EventHub;
  service: GatewayService;
}

function externalRef(value: unknown): CreateSessionInput["external"] {
  if (!value || typeof value !== "object") return undefined;
  const external = value as Record<string, unknown>;
  const channel = typeof external.channel === "string" ? external.channel.trim() : "";
  const conversationId =
    typeof external.conversationId === "string" ? external.conversationId.trim() : "";
  const threadId = typeof external.threadId === "string" ? external.threadId.trim() : "";
  if (!channel || !conversationId) return undefined;
  return { channel, conversationId, ...(threadId ? { threadId } : {}) };
}

export function createSessionsRouter(deps: SessionsRouteDeps): Hono {
  const router = new Hono();

  // 1. Create Session (Global or Project-scoped)
  router.post("/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const external = externalRef(body.external);
    const source = external?.channel ?? "web";
    const created = await deps.service.createSession({
      ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.query === "string" ? { query: body.query } : {}),
      ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
      source,
      ...(external ? { external } : {}),
    });
    return c.json(created, 201);
  });

  router.post("/projects/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");
    const body = await c.req.json().catch(() => ({}));
    const external = externalRef(body.external);
    const source = external?.channel ?? "web";
    const created = await deps.service.createSession({
      projectId,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.query === "string" ? { query: body.query } : {}),
      ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
      source,
      ...(external ? { external } : {}),
    });
    return c.json(created, 201);
  });

  // 2. List & Query Sessions
  router.get("/sessions", async (c) => {
    const projectId = c.req.query("projectId");
    const sessions = await deps.store.listSessions(projectId || undefined);
    return c.json({ sessions });
  });

  router.get("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    return c.json({ session: route, project: project.project.routing });
  });

  router.delete("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    await project.cleanupSession(sessionId);
    return c.json({ status: "deleted", sessionId });
  });

  router.patch("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return c.json({ error: "title_required" }, 400);

    const ok = await deps.service.renameSession(sessionId, title);
    if (!ok) return c.json({ error: "session_not_found" }, 404);
    return c.json({ status: "ok", sessionId, title });
  });

  router.post("/sessions/:sessionId/rename", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return c.json({ error: "title_required" }, 400);

    const ok = await deps.service.renameSession(sessionId, title);
    if (!ok) return c.json({ error: "session_not_found" }, 404);
    return c.json({ status: "ok", sessionId, title });
  });

  // 3. Events Stream & History
  router.get("/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);

    const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0);
    const initial = await project.events(sessionId, Number.isFinite(after) ? after : 0);

    if (c.req.header("accept") !== "text/event-stream") {
      return c.json({ events: initial });
    }

    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());

      // Periodic keep-alive comment to keep TCP connection active during quiet periods
      const keepAliveTimer = setInterval(() => {
        if (stream.aborted) {
          clearInterval(keepAliveTimer);
          return;
        }
        void stream.write(": keep-alive\n\n");
      }, 3000);

      try {
        const afterParam = c.req.query("after");
        const source = c.req.query("source") ?? "web";
        const afterSeq = afterParam !== undefined ? Number(afterParam) : undefined;
        for await (const event of deps.eventHub.stream(sessionId, {
          ...(afterSeq !== undefined ? { after: afterSeq } : {}),
          source,
          signal: ac.signal,
        })) {
          if (stream.aborted) break;
          await stream.writeSSE({
            id: String((event as any).sequence),
            data: JSON.stringify(event),
          });
        }
      } finally {
        clearInterval(keepAliveTimer);
      }
    });
  });

  // 4. Artifacts
  router.get("/sessions/:sessionId/artifacts", async (c) => {
    const sessionId = c.req.param("sessionId");
    const includeInternal = c.req.query("includeInternal") === "true";
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    const allArtifacts = await project.listArtifacts(sessionId);
    const artifacts = includeInternal
      ? allArtifacts
      : allArtifacts.filter((a) => a.kind !== "agent-message");
    return c.json({ artifacts });
  });

  router.get("/sessions/:sessionId/artifacts/:artifactId", async (c) => {
    const { sessionId, artifactId } = c.req.param();
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
    });
  });

  // 5. Turns & Interaction (Protected with Task Session Read-Only Guard)
  router.post("/sessions/:sessionId/turns", async (c) => {
    const sessionId = c.req.param("sessionId");
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

    const body = await c.req.json().catch(() => ({}));
    const input = typeof body.input === "string" ? body.input : "";
    const turn = await deps.service.submitTurn(sessionId, input);
    return c.json({ turn }, 202);
  });

  router.post("/sessions/:sessionId/steer", async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    const body = await c.req.json().catch(() => ({}));
    const input = typeof body.input === "string" ? body.input : "";
    await project.steer(sessionId, input);
    return c.json({ status: "accepted" }, 202);
  });

  router.post("/sessions/:sessionId/interrupt", async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    await project.interrupt(sessionId);
    return c.json({ status: "accepted" }, 202);
  });

  router.post("/sessions/:sessionId/compact", async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    await project.compact(sessionId);
    return c.json({ status: "accepted" }, 202);
  });

  router.post("/sessions/:sessionId/approvals", async (c) => {
    const sessionId = c.req.param("sessionId");
    const route = await deps.store.getSession(sessionId);
    if (!route) return c.json({ error: "session_not_found" }, 404);
    const project = deps.projects.get(route.projectId);
    const body = await c.req.json().catch(() => ({}));
    await project.approve(sessionId, String(body.requestId ?? ""), body.result);
    return c.json({ status: "accepted" }, 202);
  });

  return router;
}
