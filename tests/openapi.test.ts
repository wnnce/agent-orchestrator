import { createRoute, z } from "@hono/zod-openapi";
import { describe, expect, it } from "bun:test";
import type { AppConfig } from "../src/config/config.ts";
import type { ProjectConfig } from "../src/domain/types.ts";
import { Gateway } from "../src/gateway/server.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { ProjectManager } from "../src/project/manager.ts";

const sampleProject: ProjectConfig = {
  id: "test-proj",
  displayName: "Test Project",
  description: "Test Project Description",
  routing: {
    projectId: "test-proj",
    displayName: "Test Project",
    summary: "Test Summary",
    keywords: ["test"],
  },
  runtime: { type: "fake" },
  repository: { url: "", baseBranch: "main" },
};

function createTestGateway(customConfig?: Partial<AppConfig>): Gateway {
  const config: AppConfig = {
    port: 7070,
    host: "127.0.0.1",
    dataDir: "/tmp/openapi-test-data",
    artifactDir: "/tmp/openapi-test-artifacts",
    projectConfigPath: "/tmp/openapi-test-projects",
    allowUnauthenticated: true,
    routerModel: "gpt-4o",
    routerBaseUrl: "http://localhost:8317/v1",
    logLevel: "error",
    feishu: { enabled: false },
    ...customConfig,
  };
  const store = new MemoryStore();
  const logger = new Logger();
  const projectManager = new ProjectManager([sampleProject], store, config, logger);
  return new Gateway(config, store, projectManager, logger);
}

function honoPathToOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  security?: Array<Record<string, string[]>>;
  components?: {
    securitySchemes?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
  paths: Record<string, Record<string, Record<string, unknown>>>;
}

describe("Gateway OpenAPI & Docs (@hono/zod-openapi + Scalar)", () => {
  it("generates OpenAPI 3.1.0 JSON at GET /openapi.json from contract routes", async () => {
    const gateway = createTestGateway();
    const res = await gateway.handle(new Request("http://localhost/openapi.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const doc = (await res.json()) as OpenApiDoc;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Agent Orchestrator Gateway API");
    expect(doc.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(doc.components?.responses?.NotFound).toBeDefined();
    expect(doc.components?.responses?.Unauthorized).toBeDefined();
    expect(doc.components?.schemas?.ErrorResponse).toBeDefined();
    expect(doc.components?.schemas?.SessionRoute).toBeDefined();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);

    expect(doc.paths["/healthz"]?.get?.security).toEqual([]);
    expect(doc.paths["/api/v1/runtimes"]?.get?.security).toEqual([]);
    expect(doc.paths["/api/v1/sessions/{sessionId}/events"]?.get).toBeDefined();
    expect(doc.paths["/api/v1/projects/{projectId}/tasks/{taskId}/run"]?.post).toBeDefined();
    expect(doc.paths["/api/v1/projects/{projectId}/overview"]?.get).toBeDefined();
    expect(doc.paths["/api/v1/projects/{projectId}/metrics"]?.get).toBeDefined();
  });

  it("serves Scalar interactive API documentation HTML at GET /docs", async () => {
    const gateway = createTestGateway();
    const res = await gateway.handle(new Request("http://localhost/docs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("/openapi.json");
    expect(html).toContain("Agent Orchestrator Gateway API - Docs");
    expect(html.toLowerCase()).toContain("scalar");
  });

  it("keeps /openapi.json and /docs accessible when Bearer auth is enforced", async () => {
    const gateway = createTestGateway({
      allowUnauthenticated: false,
      apiToken: "secret-api-token",
    });

    const specRes = await gateway.handle(new Request("http://localhost/openapi.json"));
    expect(specRes.status).toBe(200);

    const docsRes = await gateway.handle(new Request("http://localhost/docs"));
    expect(docsRes.status).toBe(200);

    const protectedRes = await gateway.handle(new Request("http://localhost/api/v1/projects"));
    expect(protectedRes.status).toBe(401);
  });

  it("documents every registered HTTP route including dynamically added OpenAPI routes with 100% parity", async () => {
    const gateway = createTestGateway();
    const demoRoute = createRoute({
      method: "get",
      path: "/dynamic-demo/{itemId}",
      request: {
        params: z.object({
          itemId: z.string().openapi({ param: { name: "itemId", in: "path" } }),
        }),
      },
      responses: {
        200: {
          description: "Demo item",
          content: { "application/json": { schema: z.object({ itemId: z.string() }) } },
        },
      },
    });
    gateway.app.openapi(demoRoute, (c) => c.json({ itemId: c.req.valid("param").itemId }, 200));

    const res = await gateway.handle(new Request("http://localhost/openapi.json"));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenApiDoc;

    const dynamicOp = doc.paths["/dynamic-demo/{itemId}"]?.get;
    expect(dynamicOp).toBeDefined();
    expect(dynamicOp?.parameters).toEqual([
      expect.objectContaining({ name: "itemId", in: "path", required: true }),
    ]);

    // Every registered Gateway HTTP route matches the generated OpenAPI paths 1:1
    const ignoredPaths = new Set(["/openapi.json", "/docs", "*", "/*"]);
    const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    const registeredRoutes = new Set<string>();
    for (const route of gateway.app.routes) {
      const method = route.method.toUpperCase();
      if (!httpMethods.has(method)) continue;
      if (ignoredPaths.has(route.path)) continue;
      registeredRoutes.add(`${method} ${honoPathToOpenApiPath(route.path)}`);
    }

    const documentedRoutes = new Set<string>();
    for (const [path, pathItem] of Object.entries(doc.paths)) {
      for (const method of Object.keys(pathItem)) {
        documentedRoutes.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const missingInSpec = [...registeredRoutes].filter((r) => !documentedRoutes.has(r)).sort();
    const extraInSpec = [...documentedRoutes].filter((r) => !registeredRoutes.has(r)).sort();
    expect(missingInSpec).toEqual([]);
    expect(extraInSpec).toEqual([]);
  });
});
