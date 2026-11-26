import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { openAPIRouteHandler, resolver } from "hono-openapi";
import { z } from "zod";

export interface DocsRouterOptions {
  readonly specUrl?: string | undefined;
  readonly title?: string | undefined;
  readonly version?: string | undefined;
  readonly description?: string | undefined;
}

const errorResponseSchema = z
  .object({
    error: z.string().describe("Machine-readable error code or message"),
    message: z.string().optional().describe("Optional human-readable error detail"),
  })
  .meta({ ref: "ErrorResponse" });

const errorContent = {
  "application/json": {
    schema: resolver(errorResponseSchema),
  },
};

export function createDocsRouter(app: Hono, options: DocsRouterOptions = {}): Hono {
  const router = new Hono();
  const title = options.title ?? "Agent Orchestrator Gateway API";
  const version = options.version ?? "0.1.0";
  const description =
    options.description ??
    "HTTP and SSE gateway API for coordinating agent runtimes, sessions, scheduled tasks, actions, and webhooks.";
  const specUrl = options.specUrl ?? "/openapi.json";

  router.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      includeEmptyPaths: true,
      exclude: ["/openapi.json", "/docs", "*", "/*"],
      defaultValidationErrorResponse: {
        description: "Invalid request parameters or payload",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
          },
        },
      },
      documentation: {
        info: {
          title,
          version,
          description,
        },
        servers: [{ url: "/", description: "Current Gateway Server" }],
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              description:
                "Bearer API token configured via `apiToken` (ignored when `allowUnauthenticated` is enabled).",
            },
          },
          responses: {
            BadRequest: {
              description: "Invalid request parameters or payload",
              content: errorContent,
            },
            Unauthorized: {
              description: "Missing or invalid Bearer API token",
              content: errorContent,
            },
            Forbidden: {
              description: "Operation not permitted on this resource",
              content: errorContent,
            },
            NotFound: {
              description: "Requested resource was not found",
              content: errorContent,
            },
            Conflict: {
              description: "Operation conflicts with current resource state",
              content: errorContent,
            },
          },
        },
      },
    }),
  );

  router.get(
    "/docs",
    Scalar({
      url: specUrl,
      pageTitle: `${title} - Docs`,
    }),
  );

  return router;
}
