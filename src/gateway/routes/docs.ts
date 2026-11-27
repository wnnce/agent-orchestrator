import type { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { errorResponseSchema } from "../contracts/common.ts";
import { createOpenAPIApp } from "../openapi.ts";

export interface DocsRouterOptions {
  readonly specUrl?: string | undefined;
  readonly title?: string | undefined;
  readonly version?: string | undefined;
  readonly description?: string | undefined;
}

const errorResponseRef = {
  "application/json": {
    schema: { $ref: "#/components/schemas/ErrorResponse" },
  },
};

export function createDocsRouter(app: OpenAPIHono, options: DocsRouterOptions = {}): OpenAPIHono {
  const router = createOpenAPIApp();
  const title = options.title ?? "Agent Orchestrator Gateway API";
  const version = options.version ?? "0.1.0";
  const description =
    options.description ??
    "HTTP and SSE gateway API for coordinating agent runtimes, sessions, scheduled tasks, actions, and webhooks.";
  const specUrl = options.specUrl ?? "/openapi.json";

  // Register shared OpenAPI components on the root OpenAPIHono registry
  app.openAPIRegistry.register("ErrorResponse", errorResponseSchema);
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description:
      "Bearer API token configured via `apiToken` (ignored when `allowUnauthenticated` is enabled).",
  });
  app.openAPIRegistry.registerComponent("responses", "BadRequest", {
    description: "Invalid request parameters or payload",
    content: errorResponseRef,
  });
  app.openAPIRegistry.registerComponent("responses", "Unauthorized", {
    description: "Missing or invalid Bearer API token",
    content: errorResponseRef,
  });
  app.openAPIRegistry.registerComponent("responses", "Forbidden", {
    description: "Operation not permitted on this resource",
    content: errorResponseRef,
  });
  app.openAPIRegistry.registerComponent("responses", "NotFound", {
    description: "Requested resource was not found",
    content: errorResponseRef,
  });
  app.openAPIRegistry.registerComponent("responses", "Conflict", {
    description: "Operation conflicts with current resource state",
    content: errorResponseRef,
  });

  router.get("/openapi.json", (c) => {
    const doc = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: {
        title,
        version,
        description,
      },
      servers: [{ url: "/", description: "Current Gateway Server" }],
      security: [{ bearerAuth: [] }],
    });
    return c.json(doc);
  });

  router.get(
    "/docs",
    Scalar({
      url: specUrl,
      pageTitle: `${title} - Docs`,
    }),
  );

  return router;
}
