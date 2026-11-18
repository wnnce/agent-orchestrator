import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/config.ts";
import type { Store } from "../persistence/store.ts";
import { ProjectManager } from "../project/manager.ts";
import type { Logger } from "../observability/logger.ts";
import { GatewayService } from "./service.ts";
import { FeishuAdapter, FeishuWSAdapter } from "../channels/feishu.ts";
import { WeComClient, WeComWSAdapter } from "../channels/wecom.ts";
import type { EventHub } from "../events/hub.ts";
import type { SessionManager } from "../session/index.ts";
import {
  createSystemRouter,
  createChannelsRouter,
  createProjectsRouter,
  createTasksRouter,
  createActionsRouter,
  createScheduledJobsRouter,
  createSessionsRouter,
  createWebhooksRouter,
} from "./routes/index.ts";

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
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    });

    // 3. Health & Readiness checks (no authentication)
    app.route("/", createSystemRouter(this.projects.getRuntimeRegistry()));

    // 4. Channel adapters (authenticate with platform credentials)
    app.route("/", createChannelsRouter({ feishu: this.feishu }));

    // 5. Authentication middleware
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

    // 6. Domain routes
    app.route("/", createProjectsRouter({ projects: this.projects }));
    app.route(
      "/",
      createTasksRouter({ projects: this.projects, store: this.store }),
    );
    app.route("/", createActionsRouter({ store: this.store }));
    app.route("/", createScheduledJobsRouter({ store: this.store }));
    app.route(
      "/",
      createSessionsRouter({
        store: this.store,
        projects: this.projects,
        eventHub: this.eventHub,
        service: this.service,
      }),
    );
    app.route("/", createWebhooksRouter({ service: this.service }));

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
