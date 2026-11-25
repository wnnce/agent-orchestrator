import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { REASONING_EFFORTS } from "../../domain/types.ts";
import type { EventHub } from "../../events/hub.ts";
import type { Store } from "../../persistence/store.ts";
import type { ProjectManager } from "../../project/manager.ts";
import type { GatewayService } from "../service.ts";
import { projectRoutingSchema } from "./projects.ts";

export interface SessionsRouteDeps {
  store: Store;
  projects: ProjectManager;
  eventHub: EventHub;
  service: GatewayService;
}

const sessionExternalRefSchema = z.object({
  channel: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().optional(),
});

const createSessionBodySchema = z.object({
  projectId: z.string().optional().describe("Target project ID; omitted to auto-route by query"),
  title: z.string().optional(),
  query: z.string().optional().describe("Optional initial prompt turn submitted upon creation"),
  runtime: z.string().optional().describe("Optional runtime adapter override"),
  model: z.string().optional().describe("Optional model identifier override"),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional().describe("Optional reasoning effort override"),
  external: sessionExternalRefSchema.optional(),
});

const createProjectSessionBodySchema = createSessionBodySchema.omit({ projectId: true });

const sessionRouteSchema = z
  .object({
    id: z.number().int().optional(),
    sessionId: z.string(),
    title: z.string().optional(),
    projectId: z.string(),
    projectRuntimeId: z.string(),
    runtimeSessionId: z.string().nullable(),
    runtime: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    workspacePath: z.string().optional(),
    configRevision: z.number().int(),
    status: z.enum(["active", "idle", "suspended", "closing", "closed", "archived", "failed"]),
    source: z.string().optional(),
    externalChannel: z.string().optional(),
    externalConversationId: z.string().optional(),
    externalThreadId: z.string().optional(),
    lastActiveAt: z.string(),
    cursors: z.record(z.string(), z.number()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    deletedAt: z.number().int().optional(),
  })
  .meta({ ref: "SessionRoute" });

const tokenUsageSchema = z.object({
  inputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  outputTokens: z.number().int(),
  reasoningTokens: z.number().int(),
  totalTokens: z.number().int(),
});

const turnUsageSchema = tokenUsageSchema.extend({
  model: z.string().optional(),
  byModel: z
    .array(tokenUsageSchema.extend({ model: z.string(), provider: z.string().optional() }))
    .optional(),
  contextUsedTokens: z.number().int().optional(),
  contextWindowTokens: z.number().int().optional(),
});

const sessionUsageSummarySchema = tokenUsageSchema
  .extend({
    turnCount: z.number().int(),
    lastModel: z.string().optional(),
    contextUsedTokens: z.number().int().optional(),
    contextWindowTokens: z.number().int().optional(),
  })
  .meta({ ref: "SessionUsageSummary" });

const turnRecordSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    input: z.string(),
    status: z.enum(["queued", "in_progress", "completed", "failed", "interrupted"]),
    runtimeTurnId: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    usage: turnUsageSchema.optional(),
    createdAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .meta({ ref: "TurnRecord" });

const eventRecordSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    sequence: z.number().int(),
    type: z.string(),
    runtime: z.string(),
    payload: z.unknown(),
    createdAt: z.string(),
    schemaVersion: z.number().int(),
  })
  .meta({ ref: "EventRecord" });

const artifactRecordSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    sessionId: z.string(),
    turnId: z.string().optional(),
    kind: z.string(),
    path: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    createdAt: z.string(),
  })
  .meta({ ref: "ArtifactRecord" });

const createdSessionSchema = z.object({
  session: sessionRouteSchema,
  routedProject: z.string(),
  turn: turnRecordSchema.optional(),
});

const listSessionsQuerySchema = z.object({
  projectId: z.string().min(1).optional().describe("Optional project ID filter"),
});

const renameSessionBodySchema = z.object({
  title: z.string().trim().min(1),
});

const renameSessionResponseSchema = z.object({
  status: z.literal("ok"),
  sessionId: z.string(),
  title: z.string(),
});

const sessionEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional().describe("Return events with sequence > after"),
  source: z.string().optional().describe("Consumer cursor source for SSE (default: web)"),
});

const listArtifactsQuerySchema = z.object({
  includeInternal: z
    .enum(["true", "false"])
    .optional()
    .describe('Set to `"true"` to include internal `agent-message` artifacts'),
});

const turnInputBodySchema = z.object({
  input: z.string().default(""),
});

const approvalBodySchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
});

const acceptedResponseSchema = z.object({
  status: z.literal("accepted"),
});

export function createSessionsRouter(deps: SessionsRouteDeps): Hono {
  const router = new Hono();

  // 1. Create Session (Global or Project-scoped)
  router.post(
    "/sessions",
    describeRoute({
      tags: ["Sessions"],
      summary: "Create a session (auto-routed or explicit project)",
      responses: {
        201: {
          description: "Session created",
          content: { "application/json": { schema: resolver(createdSessionSchema) } },
        },
      },
    }),
    validator("json", createSessionBodySchema),
    async (c) => {
      const body = c.req.valid("json");
      const created = await deps.service.createSession({
        ...body,
        source: body.external?.channel ?? "web",
      });
      return c.json(created, 201);
    },
  );

  router.post(
    "/projects/:projectId/sessions",
    describeRoute({
      tags: ["Sessions"],
      summary: "Create a session within a specific project",
      responses: {
        201: {
          description: "Session created",
          content: { "application/json": { schema: resolver(createdSessionSchema) } },
        },
      },
    }),
    validator("json", createProjectSessionBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const body = c.req.valid("json");
      const created = await deps.service.createSession({
        ...body,
        projectId,
        source: body.external?.channel ?? "web",
      });
      return c.json(created, 201);
    },
  );

  // 2. List & Query Sessions
  router.get(
    "/sessions",
    describeRoute({
      tags: ["Sessions"],
      summary: "List sessions",
      responses: {
        200: {
          description: "List of sessions",
          content: {
            "application/json": {
              schema: resolver(z.object({ sessions: z.array(sessionRouteSchema) })),
            },
          },
        },
      },
    }),
    validator("query", listSessionsQuerySchema),
    async (c) => {
      const { projectId } = c.req.valid("query");
      const sessions = await deps.store.listSessions(projectId);
      return c.json({ sessions });
    },
  );

  router.get(
    "/sessions/:sessionId",
    describeRoute({
      tags: ["Sessions"],
      summary: "Get session details and aggregated token usage",
      responses: {
        200: {
          description: "Session metadata, project routing info, and usage summary",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  session: sessionRouteSchema,
                  project: projectRoutingSchema,
                  usage: sessionUsageSummarySchema,
                }),
              ),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      const usage = await deps.store.getSessionUsage(sessionId);
      return c.json({ session: route, project: project.project.routing, usage });
    },
  );

  router.delete(
    "/sessions/:sessionId",
    describeRoute({
      tags: ["Sessions"],
      summary: "Delete a session and clean up its workspace",
      responses: {
        200: {
          description: "Session deleted",
          content: {
            "application/json": {
              schema: resolver(z.object({ status: z.literal("deleted"), sessionId: z.string() })),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      await project.cleanupSession(sessionId);
      return c.json({ status: "deleted", sessionId });
    },
  );

  const renameValidator = validator("json", renameSessionBodySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "title_required" }, 400);
    }
  });

  router.patch(
    "/sessions/:sessionId",
    describeRoute({
      tags: ["Sessions"],
      summary: "Rename a session",
      responses: {
        200: {
          description: "Session renamed",
          content: { "application/json": { schema: resolver(renameSessionResponseSchema) } },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    renameValidator,
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const { title } = c.req.valid("json");
      const ok = await deps.service.renameSession(sessionId, title);
      if (!ok) return c.json({ error: "session_not_found" }, 404);
      return c.json({ status: "ok", sessionId, title });
    },
  );

  router.post(
    "/sessions/:sessionId/rename",
    describeRoute({
      tags: ["Sessions"],
      summary: "Rename a session (POST alias)",
      responses: {
        200: {
          description: "Session renamed",
          content: { "application/json": { schema: resolver(renameSessionResponseSchema) } },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    renameValidator,
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const { title } = c.req.valid("json");
      const ok = await deps.service.renameSession(sessionId, title);
      if (!ok) return c.json({ error: "session_not_found" }, 404);
      return c.json({ status: "ok", sessionId, title });
    },
  );

  // 3. Events Stream & History
  router.get(
    "/sessions/:sessionId/events",
    describeRoute({
      tags: ["Sessions"],
      summary: "Fetch session event history or subscribe via SSE",
      description:
        "Returns JSON event history by default, or streams canonical events as Server-Sent Events when `Accept: text/event-stream` is set.",
      parameters: [
        {
          name: "last-event-id",
          in: "header",
          description: "Alternative cursor sequence for SSE reconnects",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Event history JSON or live SSE stream",
          content: {
            "application/json": {
              schema: resolver(z.object({ events: z.array(eventRecordSchema) })),
            },
            "text/event-stream": {
              schema: {
                type: "string",
                description: "Server-Sent Events stream of EventRecord payloads",
              },
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("query", sessionEventsQuerySchema),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      const query = c.req.valid("query");

      const headerAfter = Number(c.req.header("last-event-id") ?? 0);
      const after = query.after ?? (Number.isFinite(headerAfter) ? headerAfter : 0);
      const initial = await project.events(sessionId, after);

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
          const source = query.source ?? "web";
          for await (const event of deps.eventHub.stream(sessionId, {
            ...(query.after !== undefined ? { after: query.after } : {}),
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
    },
  );

  // 4. Artifacts
  router.get(
    "/sessions/:sessionId/artifacts",
    describeRoute({
      tags: ["Sessions"],
      summary: "List session artifacts",
      responses: {
        200: {
          description: "Session artifacts",
          content: {
            "application/json": {
              schema: resolver(z.object({ artifacts: z.array(artifactRecordSchema) })),
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("query", listArtifactsQuerySchema),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const { includeInternal } = c.req.valid("query");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      const allArtifacts = await project.listArtifacts(sessionId);
      const artifacts =
        includeInternal === "true"
          ? allArtifacts
          : allArtifacts.filter((a) => a.kind !== "agent-message");
      return c.json({ artifacts });
    },
  );

  router.get(
    "/sessions/:sessionId/artifacts/:artifactId",
    describeRoute({
      tags: ["Sessions"],
      summary: "Download a session artifact",
      responses: {
        200: {
          description: "Raw artifact content",
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
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
    },
  );

  // 5. Turns & Interaction (Protected with Task Session Read-Only Guard)
  router.post(
    "/sessions/:sessionId/turns",
    describeRoute({
      tags: ["Sessions"],
      summary: "Submit a new turn to a session",
      responses: {
        202: {
          description: "Turn accepted and queued",
          content: {
            "application/json": { schema: resolver(z.object({ turn: turnRecordSchema })) },
          },
        },
        403: { $ref: "#/components/responses/Forbidden" },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("json", turnInputBodySchema),
    async (c) => {
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

      const { input } = c.req.valid("json");
      const turn = await deps.service.submitTurn(sessionId, input);
      return c.json({ turn }, 202);
    },
  );

  router.post(
    "/sessions/:sessionId/steer",
    describeRoute({
      tags: ["Sessions"],
      summary: "Steer an in-progress turn",
      responses: {
        202: {
          description: "Control command accepted",
          content: { "application/json": { schema: resolver(acceptedResponseSchema) } },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("json", turnInputBodySchema),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      const { input } = c.req.valid("json");
      await project.steer(sessionId, input);
      return c.json({ status: "accepted" }, 202);
    },
  );

  router.post(
    "/sessions/:sessionId/interrupt",
    describeRoute({
      tags: ["Sessions"],
      summary: "Interrupt the active turn",
      responses: {
        202: {
          description: "Control command accepted",
          content: { "application/json": { schema: resolver(acceptedResponseSchema) } },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      await project.interrupt(sessionId);
      return c.json({ status: "accepted" }, 202);
    },
  );

  router.post(
    "/sessions/:sessionId/compact",
    describeRoute({
      tags: ["Sessions"],
      summary: "Trigger context compaction for a session",
      responses: {
        202: {
          description: "Control command accepted",
          content: { "application/json": { schema: resolver(acceptedResponseSchema) } },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      await project.compact(sessionId);
      return c.json({ status: "accepted" }, 202);
    },
  );

  router.post(
    "/sessions/:sessionId/approvals",
    describeRoute({
      tags: ["Sessions"],
      summary: "Approve or reject a pending runtime tool approval request",
      responses: {
        202: {
          description: "Control command accepted",
          content: { "application/json": { schema: resolver(acceptedResponseSchema) } },
        },
        404: { $ref: "#/components/responses/NotFound" },
      },
    }),
    validator("json", approvalBodySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: "invalid_approval",
            message: 'Expected { requestId, decision: "approved" | "rejected" }',
          },
          400,
        );
      }
    }),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const route = await deps.store.getSession(sessionId);
      if (!route) return c.json({ error: "session_not_found" }, 404);
      const project = deps.projects.get(route.projectId);
      const { requestId, decision } = c.req.valid("json");
      await project.approve(sessionId, requestId, decision);
      return c.json({ status: "accepted" }, 202);
    },
  );

  return router;
}
