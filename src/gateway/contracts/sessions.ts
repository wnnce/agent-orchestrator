import { createRoute, z } from "@hono/zod-openapi";
import { REASONING_EFFORTS } from "../../domain/types.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonBody,
  jsonContent,
  notFoundResponse,
  projectIdParamSchema,
} from "./common.ts";
import { projectRoutingSchema } from "./projects.ts";

const sessionExternalRefSchema = z.object({
  channel: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().optional(),
});

export const createSessionBodySchema = z.object({
  projectId: z
    .string()
    .optional()
    .openapi({ description: "Target project ID; omitted to auto-route by query" }),
  title: z.string().optional(),
  query: z
    .string()
    .optional()
    .openapi({ description: "Optional initial prompt turn submitted upon creation" }),
  runtime: z.string().optional().openapi({ description: "Optional runtime adapter override" }),
  model: z.string().optional().openapi({ description: "Optional model identifier override" }),
  reasoningEffort: z
    .enum(REASONING_EFFORTS)
    .optional()
    .openapi({ description: "Optional reasoning effort override" }),
  external: sessionExternalRefSchema.optional(),
});

export const createProjectSessionBodySchema = createSessionBodySchema.omit({ projectId: true });

export const sessionRouteSchema = z
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
  .openapi("SessionRoute");

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
    .readonly()
    .optional(),
  contextUsedTokens: z.number().int().optional(),
  contextWindowTokens: z.number().int().optional(),
});

export const sessionUsageSummarySchema = tokenUsageSchema
  .extend({
    turnCount: z.number().int(),
    lastModel: z.string().optional(),
    contextUsedTokens: z.number().int().optional(),
    contextWindowTokens: z.number().int().optional(),
  })
  .openapi("SessionUsageSummary");

export const turnRecordSchema = z
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
  .openapi("TurnRecord");

export const eventRecordSchema = z
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
  .openapi("EventRecord");

export const artifactRecordSchema = z
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
  .openapi("ArtifactRecord");

const createdSessionSchema = z.object({
  session: sessionRouteSchema,
  routedProject: z.string(),
  turn: turnRecordSchema.optional(),
});

const renameSessionBodySchema = z.object({
  title: z.string().trim().min(1),
});

const renameSessionResponseSchema = z.object({
  status: z.literal("ok"),
  sessionId: z.string(),
  title: z.string(),
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

const sessionIdParamSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .openapi({ param: { name: "sessionId", in: "path" } }),
});

export const createSessionRoute = createRoute({
  method: "post",
  path: "/sessions",
  tags: ["Sessions"],
  summary: "Create a session (auto-routed or explicit project)",
  request: {
    body: jsonBody(createSessionBodySchema),
  },
  responses: {
    201: jsonContent(createdSessionSchema, "Session created"),
    400: badRequestResponse,
  },
});

export const createProjectSessionRoute = createRoute({
  method: "post",
  path: "/projects/{projectId}/sessions",
  tags: ["Sessions"],
  summary: "Create a session within a specific project",
  request: {
    params: projectIdParamSchema,
    body: jsonBody(createProjectSessionBodySchema),
  },
  responses: {
    201: jsonContent(createdSessionSchema, "Session created"),
    400: badRequestResponse,
  },
});

export const listSessionsRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Sessions"],
  summary: "List sessions",
  request: {
    query: z.object({
      projectId: z
        .string()
        .min(1)
        .optional()
        .openapi({ description: "Optional project ID filter" }),
    }),
  },
  responses: {
    200: jsonContent(z.object({ sessions: z.array(sessionRouteSchema) }), "List of sessions"),
  },
});

export const getSessionRoute = createRoute({
  method: "get",
  path: "/sessions/{sessionId}",
  tags: ["Sessions"],
  summary: "Get session details and aggregated token usage",
  request: {
    params: sessionIdParamSchema,
  },
  responses: {
    200: jsonContent(
      z.object({
        session: sessionRouteSchema,
        project: projectRoutingSchema,
        usage: sessionUsageSummarySchema.nullable(),
      }),
      "Session metadata, project routing info, and usage summary",
    ),
    404: notFoundResponse,
  },
});

export const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/sessions/{sessionId}",
  tags: ["Sessions"],
  summary: "Delete a session and clean up its workspace",
  request: {
    params: sessionIdParamSchema,
  },
  responses: {
    200: jsonContent(
      z.object({ status: z.literal("deleted"), sessionId: z.string() }),
      "Session deleted",
    ),
    404: notFoundResponse,
  },
});

export const renameSessionPatchRoute = createRoute({
  method: "patch",
  path: "/sessions/{sessionId}",
  tags: ["Sessions"],
  summary: "Rename a session",
  request: {
    params: sessionIdParamSchema,
    body: jsonBody(renameSessionBodySchema),
  },
  responses: {
    200: jsonContent(renameSessionResponseSchema, "Session renamed"),
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

export const renameSessionPostRoute = createRoute({
  method: "post",
  path: "/sessions/{sessionId}/rename",
  tags: ["Sessions"],
  summary: "Rename a session (POST alias)",
  request: {
    params: sessionIdParamSchema,
    body: jsonBody(renameSessionBodySchema),
  },
  responses: {
    200: jsonContent(renameSessionResponseSchema, "Session renamed"),
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

export const sessionEventsRoute = createRoute({
  method: "get",
  path: "/sessions/{sessionId}/events",
  tags: ["Sessions"],
  summary: "Fetch session event history or subscribe via SSE",
  description:
    "Returns JSON event history by default, or streams canonical events as Server-Sent Events when `Accept: text/event-stream` is set.",
  request: {
    params: sessionIdParamSchema,
    headers: z.object({
      "last-event-id": z
        .string()
        .optional()
        .openapi({ description: "Alternative cursor sequence for SSE reconnects" }),
    }),
    query: z.object({
      after: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .openapi({ description: "Return events with sequence > after" }),
      source: z
        .string()
        .optional()
        .openapi({ description: "Consumer cursor source for SSE (default: web)" }),
    }),
  },
  responses: {
    200: {
      description: "Event history JSON or live SSE stream",
      content: {
        "application/json": {
          schema: z.object({ events: z.array(eventRecordSchema) }),
        },
        "text/event-stream": {
          schema: z
            .string()
            .openapi({ description: "Server-Sent Events stream of EventRecord payloads" }),
        },
      },
    },
    404: notFoundResponse,
  },
});

export const listSessionArtifactsRoute = createRoute({
  method: "get",
  path: "/sessions/{sessionId}/artifacts",
  tags: ["Sessions"],
  summary: "List session artifacts",
  request: {
    params: sessionIdParamSchema,
    query: z.object({
      includeInternal: z.enum(["true", "false"]).optional().openapi({
        description: 'Set to `"true"` to include internal `agent-message` artifacts',
      }),
    }),
  },
  responses: {
    200: jsonContent(z.object({ artifacts: z.array(artifactRecordSchema) }), "Session artifacts"),
    404: notFoundResponse,
  },
});

export const downloadSessionArtifactRoute = createRoute({
  method: "get",
  path: "/sessions/{sessionId}/artifacts/{artifactId}",
  tags: ["Sessions"],
  summary: "Download a session artifact",
  request: {
    params: sessionIdParamSchema.extend({
      artifactId: z
        .string()
        .min(1)
        .openapi({ param: { name: "artifactId", in: "path" } }),
    }),
  },
  responses: {
    200: {
      description: "Raw artifact content",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
    },
    404: notFoundResponse,
  },
});

export const submitTurnRoute = createRoute({
  method: "post",
  path: "/sessions/{sessionId}/turns",
  tags: ["Sessions"],
  summary: "Submit a new turn to a session",
  request: {
    params: sessionIdParamSchema,
    body: jsonBody(turnInputBodySchema),
  },
  responses: {
    202: jsonContent(z.object({ turn: turnRecordSchema }), "Turn accepted and queued"),
    400: badRequestResponse,
    403: forbiddenResponse,
    404: notFoundResponse,
  },
});

export const steerSessionRoute = createRoute({
  method: "post",
  path: "/sessions/{sessionId}/steer",
  tags: ["Sessions"],
  summary: "Steer an in-progress turn",
  request: {
    params: sessionIdParamSchema,
    body: jsonBody(turnInputBodySchema),
  },
  responses: {
    202: jsonContent(acceptedResponseSchema, "Control command accepted"),
    400: badRequestResponse,
    404: notFoundResponse,
  },
});

export const interruptSessionRoute = createRoute({
  method: "post",
  path: "/sessions/{sessionId}/interrupt",
  tags: ["Sessions"],
  summary: "Interrupt the active turn",
  request: {
    params: sessionIdParamSchema,
  },
  responses: {
    202: jsonContent(acceptedResponseSchema, "Control command accepted"),
    404: notFoundResponse,
  },
});

export const compactSessionRoute = createRoute({
  method: "post",
  path: "/sessions/{sessionId}/compact",
  tags: ["Sessions"],
  summary: "Trigger context compaction for a session",
  request: {
    params: sessionIdParamSchema,
  },
  responses: {
    202: jsonContent(acceptedResponseSchema, "Control command accepted"),
    404: notFoundResponse,
  },
});

export const approveSessionToolRoute = createRoute({
  method: "post",
  path: "/sessions/{sessionId}/approvals",
  tags: ["Sessions"],
  summary: "Approve or reject a pending runtime tool approval request",
  request: {
    params: sessionIdParamSchema,
    body: jsonBody(approvalBodySchema),
  },
  responses: {
    202: jsonContent(acceptedResponseSchema, "Control command accepted"),
    400: badRequestResponse,
    404: notFoundResponse,
  },
});
