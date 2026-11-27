import type { OpenAPIHono } from "@hono/zod-openapi";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/config.ts";
import { UnauthorizedError } from "../domain/errors.ts";
import type { Store } from "../persistence/store.ts";
import type { ProjectManager } from "../project/manager.ts";
import { ProjectStats } from "../project/stats.ts";
import type { Logger } from "../observability/logger.ts";
import { createOpenAPIApp } from "./openapi.ts";
import type { InboundService } from "../app/inbound.ts";
import type { SessionService } from "../app/sessions.ts";
import { httpTracing } from "./tracing.ts";
import { RuntimeModelCatalog } from "../runtime/catalog.ts";
import {
  createHealthRouter,
  createRuntimesRouter,
  createDocsRouter,
  createProjectsRouter,
  createTasksRouter,
  createToolsRouter,
  createScheduledJobsRouter,
  createSessionsRouter,
  createPipelinesRouter,
  createWebhooksRouter,
  createHooksRouter,
} from "./routes/index.ts";

export const API_V1_PREFIX = "/api/v1";

export interface GatewayDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly store: Store;
  readonly projects: ProjectManager;
  readonly sessions: SessionService;
  readonly inbound: InboundService;
}

/** The HTTP API, its event streams and the web UI. */
export class Gateway {
  readonly app: OpenAPIHono;
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly store: Store;
  private readonly projects: ProjectManager;
  private readonly sessions: SessionService;
  private readonly inbound: InboundService;

  constructor(deps: GatewayDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.store = deps.store;
    this.projects = deps.projects;
    this.sessions = deps.sessions;
    this.inbound = deps.inbound;
    this.app = this.createApp();
  }

  private createApp(): OpenAPIHono {
    const app = createOpenAPIApp({ logger: this.logger });

    // 0. Tracing for API and hook requests; registered first so the request log below carries the trace ID
    app.use(`${API_V1_PREFIX}/*`, httpTracing());
    app.use("/hooks/*", httpTracing());

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

    // 2. Health, Readiness & OpenAPI Docs (root paths, no authentication)
    const modelCatalog = new RuntimeModelCatalog({
      modelsFile: this.config.runtimeModelsFile ?? "runtime-models.json",
      logger: this.logger,
    });
    app.route("/", createHealthRouter());
    app.route("/", createDocsRouter(app));

    // 3. Project hooks: external platforms call these without the API token
    app.route("/", createHooksRouter({ projects: this.projects, logger: this.logger }));

    // 4. Versioned API routes (/api/v1)
    const apiV1 = createOpenAPIApp({ logger: this.logger });

    // Public runtime discovery under /api/v1
    apiV1.route("/", createRuntimesRouter(this.projects.getRuntimeRegistry(), modelCatalog));

    // Bearer authentication middleware scoped strictly to /api/v1 domain routes
    apiV1.use("*", async (c, next) => {
      if (this.config.allowUnauthenticated || !this.config.apiToken) {
        return next();
      }
      const auth = c.req.header("authorization");
      if (auth === `Bearer ${this.config.apiToken}`) {
        return next();
      }
      throw new UnauthorizedError("Missing or invalid Bearer API token");
    });

    // Domain routes
    apiV1.route(
      "/",
      createProjectsRouter({
        projects: this.projects,
        stats: new ProjectStats({ projects: this.projects, store: this.store }),
      }),
    );
    apiV1.route("/", createTasksRouter({ projects: this.projects, store: this.store }));
    apiV1.route("/", createToolsRouter({ store: this.store }));
    apiV1.route("/", createScheduledJobsRouter({ store: this.store }));
    apiV1.route(
      "/",
      createSessionsRouter({
        store: this.store,
        projects: this.projects,
        eventHub: this.projects.eventHub,
        sessions: this.sessions,
      }),
    );
    apiV1.route("/", createPipelinesRouter({ projects: this.projects }));
    apiV1.route("/", createWebhooksRouter({ sessions: this.sessions, inbound: this.inbound }));

    app.route(API_V1_PREFIX, apiV1);

    // 7. Static UI (if web/dist exists)
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
        if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
          return c.json({ error: "not_found" }, 404);
        }
        const file = Bun.file(`${staticRoot}/index.html`);
        if (await file.exists()) {
          return new Response(file, {
            headers: { "content-type": "text/html" },
          });
        }
        return c.text("Not found", 404);
      });
    }

    return app;
  }

  async handle(request: Request): Promise<Response> {
    return this.app.fetch(request);
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
