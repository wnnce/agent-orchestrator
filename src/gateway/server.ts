import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/config.ts";
import type { Store } from "../persistence/store.ts";
import { ProjectManager } from "../project/manager.ts";
import type { Logger } from "../observability/logger.ts";
import { GatewayService, type CreateSessionInput } from "./service.ts";
import { FeishuAdapter, FeishuWSAdapter } from "../channels/feishu.ts";
import { WeComClient, WeComWSAdapter } from "../channels/wecom.ts";
import type { EventHub } from "../events/hub.ts";
import type { SessionManager } from "../session/index.ts";

export class Gateway {
  readonly app: Hono;
  private readonly service: GatewayService;
  private readonly feishu: FeishuAdapter;
  private readonly feishuWs?: FeishuWSAdapter;
  private readonly wecomWs?: WeComWSAdapter;
  private readonly eventHub: EventHub;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly projects: ProjectManager,
    private readonly logger: Logger,
    eventHub?: EventHub,
    readonly sessionManager?: SessionManager,
  ) {
    this.eventHub = eventHub ?? projects.eventHub;

    const wecomConfig = config.wecom ?? { enabled: false };
    let wecomClient: WeComClient | undefined;
    if (wecomConfig.enabled && wecomConfig.botId && wecomConfig.secret) {
      wecomClient = new WeComClient(
        {
          botId: wecomConfig.botId,
          secret: wecomConfig.secret,
          ...(wecomConfig.wsUrl ? { wsUrl: wecomConfig.wsUrl } : {}),
        },
        logger,
      );
    }

    this.service = new GatewayService(
      config,
      store,
      projects,
      logger,
      this.eventHub,
      undefined,
      sessionManager ?? projects.sessionManager,
      wecomClient,
    );
    const feishuConfig = config.feishu ?? { enabled: false };
    this.feishu = new FeishuAdapter(
      {
        enabled: feishuConfig.enabled,
        ...(feishuConfig.verificationToken
          ? { verificationToken: feishuConfig.verificationToken }
          : {}),
      },
      (envelope) => this.service.acceptInbound(envelope),
      logger,
    );
    if (feishuConfig.enabled && feishuConfig.appId && feishuConfig.appSecret) {
      this.feishuWs = new FeishuWSAdapter(
        {
          appId: feishuConfig.appId,
          appSecret: feishuConfig.appSecret,
        },
        (envelope) => this.service.acceptInbound(envelope),
        logger,
      );
    }
    if (wecomClient) {
      this.wecomWs = new WeComWSAdapter(
        wecomClient,
        (envelope) => this.service.acceptInbound(envelope),
        logger,
      );
    }
    this.app = this.createApp();
  }

  private createApp(): Hono {
    const app = new Hono();

    // 1. Request logging & x-request-id middleware
    app.use("*", async (c, next) => {
      const requestId = c.req.header("x-request-id") ?? `req_${randomUUID()}`;
      c.header("x-request-id", requestId);
      const startedAt = Date.now();
      await next();
      this.logger.info("gateway request completed", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
      });
    });

    // 2. Global error handler
    app.onError((err, c) => {
      this.logger.error("gateway request failed", {
        method: c.req.method,
        path: c.req.path,
        error: err,
      });
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    });

    // 3. Health & Readiness checks (no authentication)
    app.get("/healthz", (c) => c.json({ status: "ok" }));
    app.get("/readyz", (c) => c.json({ status: "ready" }));

    // Channel adapters authenticate with their own platform credentials.
    app.post("/channels/feishu/events", (c) => this.feishu.handle(c.req.raw));

    // 4. Authentication middleware
    app.use("*", async (c, next) => {
      if (this.config.allowUnauthenticated || !this.config.apiToken) {
        return next();
      }
      const auth = c.req.header("authorization");
      if (auth === `Bearer ${this.config.apiToken}`) {
        return next();
      }
      return c.json({ error: "unauthorized" }, 401);
    });

    // 5. Projects
    app.get("/projects", (c) => {
      return c.json({ projects: this.projects.list().map((project) => project.routing) });
    });

    app.get("/projects/:projectId/skills", async (c) => {
      const projectId = c.req.param("projectId");
      try {
        const skills = await this.projects.listSkills(projectId);
        return c.json({ projectId, skills });
      } catch {
        return c.json({ error: `project not found: ${projectId}` }, 404);
      }
    });

    // 5.1 Project Tasks
    app.get("/projects/:projectId/tasks", async (c) => {
      const projectId = c.req.param("projectId");
      try {
        const runtime = this.projects.get(projectId);
        const tasks = await runtime.listTasks();
        const scheduled = runtime.taskScheduler.getScheduledTasks();
        const scheduledMap = new Map(scheduled.map((s) => [s.taskKey, s]));
        const result = tasks.map((t) => ({
          ...t,
          isScheduled: runtime.taskScheduler.isScheduled(t.taskKey),
          nextRun: scheduledMap.get(t.taskKey)?.nextRun?.toISOString() ?? null,
        }));
        return c.json({ projectId, tasks: result });
      } catch {
        return c.json({ error: `project not found: ${projectId}` }, 404);
      }
    });

    app.post("/projects/:projectId/tasks/:taskId/run", async (c) => {
      const projectId = c.req.param("projectId");
      const taskId = c.req.param("taskId");
      try {
        const runtime = this.projects.get(projectId);
        const queued = await runtime.runTask(taskId);
        return c.json({
          projectId,
          taskId,
          queued,
          message: queued
            ? "task dispatched successfully"
            : "task already running or queued (single-flight skipped)",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: msg }, 400);
      }
    });

    app.get("/projects/:projectId/tasks/:taskId/executions", async (c) => {
      const projectId = c.req.param("projectId");
      const taskId = c.req.param("taskId");
      const limit = Number(c.req.query("limit") ?? 20);
      const taskKey = `${projectId}:${taskId}`;
      const executions = await this.store.listTaskExecutions(taskKey, limit);
      return c.json({ taskKey, executions });
    });

    app.get("/tasks/executions", async (c) => {
      const projectId = c.req.query("projectId");
      const taskKey = c.req.query("taskKey");
      const limitStr = c.req.query("limit");
      const limit = limitStr !== undefined ? Number(limitStr) : 50;
      const executions = await this.store.listTaskExecutions(
        taskKey || undefined,
        limit,
        projectId || undefined,
      );
      return c.json({ executions });
    });

    app.get("/action-executions", async (c) => {
      const projectId = c.req.query("projectId");
      const sessionId = c.req.query("sessionId");
      const actionName = c.req.query("actionName");
      const limitStr = c.req.query("limit");
      const limit = limitStr !== undefined ? Number(limitStr) : 50;
      const executions = await this.store.listActionExecutions({
        projectId: projectId || undefined,
        sessionId: sessionId || undefined,
        actionName: actionName || undefined,
        limit,
      });
      return c.json({ executions });
    });

    app.get("/scheduled-jobs", async (c) => {
      const sessionId = c.req.query("sessionId");
      const projectId = c.req.query("projectId");
      const statusStr = c.req.query("status");
      const limitStr = c.req.query("limit");
      const status = statusStr !== undefined ? Number(statusStr) : undefined;
      const limit = limitStr !== undefined ? Number(limitStr) : 50;
      const jobs = await this.store.listScheduledJobs({
        sessionId: sessionId || undefined,
        projectId: projectId || undefined,
        status: status !== undefined && !isNaN(status) ? (status as any) : undefined,
        limit,
      });
      return c.json({ jobs });
    });

    app.post("/scheduled-jobs/:jobId/cancel", async (c) => {
      const jobId = c.req.param("jobId");
      const success = await this.store.cancelScheduledJobById(jobId);
      return c.json({ success, jobId });
    });

    // 6. Session Creation
    app.post("/sessions", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const external = externalRef(body.external);
      const created = await this.service.createSession({
        ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.query === "string" ? { query: body.query } : {}),
        ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
        ...(external ? { external } : {}),
      });
      return c.json(created, 201);
    });

    app.post("/projects/:projectId/sessions", async (c) => {
      const projectId = c.req.param("projectId");
      const body = await c.req.json().catch(() => ({}));
      const external = externalRef(body.external);
      const created = await this.service.createSession({
        projectId,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.query === "string" ? { query: body.query } : {}),
        ...(typeof body.repositoryId === "string" ? { repositoryId: body.repositoryId } : {}),
        ...(external ? { external } : {}),
      });
      return c.json(created, 201);
    });

    // 7. Session Resource Routes
    app.get("/sessions", async (c) => {
      const projectId = c.req.query("projectId");
      const sessions = await this.store.listSessions(projectId || undefined);
      return c.json({ sessions });
    });

    app.get("/sessions/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      return c.json({ session: route, project: project.project.routing });
    });

    app.delete("/sessions/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      await project.cleanupSession(sessionId);
      return c.json({ status: "deleted", sessionId });
    });

    app.patch("/sessions/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      const body = await c.req.json().catch(() => ({}));
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return c.json({ error: "title_required" }, 400);

      const ok = await this.service.renameSession(sessionId, title);
      if (!ok) return c.json({ error: "session_not_found" }, 404);
      return c.json({ status: "ok", sessionId, title });
    });

    app.post("/sessions/:sessionId/rename", async (c) => {
      const sessionId = c.req.param("sessionId");
      const body = await c.req.json().catch(() => ({}));
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return c.json({ error: "title_required" }, 400);

      const ok = await this.service.renameSession(sessionId, title);
      if (!ok) return c.json({ error: "session_not_found" }, 404);
      return c.json({ status: "ok", sessionId, title });
    });

    app.get("/sessions/:sessionId/events", async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);

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
          for await (const event of this.eventHub.stream(sessionId, {
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

    app.get("/sessions/:sessionId/artifacts", async (c) => {
      const sessionId = c.req.param("sessionId");
      const includeInternal = c.req.query("includeInternal") === "true";
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      const allArtifacts = await project.listArtifacts(sessionId);
      const artifacts = includeInternal
        ? allArtifacts
        : allArtifacts.filter((a) => a.kind !== "agent-message");
      return c.json({ artifacts });
    });

    app.get("/sessions/:sessionId/artifacts/:artifactId", async (c) => {
      const { sessionId, artifactId } = c.req.param();
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      const artifact = await project.artifact(sessionId, artifactId);
      const content = await project.readArtifact(artifact);
      return new Response(Buffer.from(content), {
        headers: {
          "content-type": artifact.contentType,
          "content-length": String(content.byteLength),
        },
      });
    });

    app.post("/sessions/:sessionId/turns", async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      const body = await c.req.json().catch(() => ({}));
      const input = typeof body.input === "string" ? body.input : "";
      const turn = await this.service.submitTurn(sessionId, input);
      return c.json({ turn }, 202);
    });

    app.post("/sessions/:sessionId/steer", async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      const body = await c.req.json().catch(() => ({}));
      const input = typeof body.input === "string" ? body.input : "";
      await project.steer(sessionId, input);
      return c.json({ status: "accepted" }, 202);
    });

    app.post("/sessions/:sessionId/interrupt", async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      await project.interrupt(sessionId);
      return c.json({ status: "accepted" }, 202);
    });

    app.post("/sessions/:sessionId/compact", async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      await project.compact(sessionId);
      return c.json({ status: "accepted" }, 202);
    });

    app.post("/sessions/:sessionId/approvals", async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await this.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = this.projects.get(route.projectId);
      const body = await c.req.json().catch(() => ({}));
      await project.approve(sessionId, String(body.requestId ?? ""), body.result);
      return c.json({ status: "accepted" }, 202);
    });

    // 8. Webhooks
    app.post("/webhooks/:projectId", async (c) => {
      const projectId = c.req.param("projectId");
      const body = await c.req.json().catch(() => ({}));
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const input =
        typeof body.input === "string"
          ? body.input
          : typeof body.query === "string"
            ? body.query
            : "";
      if (sessionId) {
        const turn = await this.service.submitTurn(sessionId, input);
        return c.json({ sessionId, turn }, 202);
      }
      const result = await this.service.handleInbound({
        messageId: typeof body.messageId === "string" ? body.messageId : `http_${randomUUID()}`,
        conversation: {
          channel: "http",
          conversationId:
            typeof body.conversationId === "string" ? body.conversationId : `http_${randomUUID()}`,
        },
        projectId,
        text: input,
        receivedAt: new Date().toISOString(),
      });
      return c.json(result, 202);
    });

    // 9. Static UI (if web/dist exists)
    const staticRoots = [
      "./web/dist",
      "./dist/web",
      "../web/dist",
      "/app/web/dist",
      "/app/dist/web",
    ];
    const staticRoot = staticRoots.find((p) => existsSync(p));
    if (staticRoot) {
      app.get("/*", serveStatic({ root: staticRoot }));
      app.get("*", async (c) => {
        const file = Bun.file(`${staticRoot}/index.html`);
        if (await file.exists()) {
          return new Response(file, { headers: { "content-type": "text/html" } });
        }
        return c.text("Not found", 404);
      });
    }

    return app;
  }

  async handle(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }

  async start(): Promise<void> {
    if (this.feishuWs) {
      await this.feishuWs.start();
    }
    if (this.wecomWs) {
      await this.wecomWs.start();
    }
  }

  async stop(): Promise<void> {
    if (this.feishuWs) {
      this.feishuWs.stop();
    }
    if (this.wecomWs) {
      this.wecomWs.stop();
    }
    await this.service.stop();
  }

  listen(): Bun.Server<undefined> {
    return Bun.serve({
      hostname: this.config.host,
      port: this.config.port,
      fetch: this.app.fetch,
      idleTimeout: 0,
    });
  }
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
