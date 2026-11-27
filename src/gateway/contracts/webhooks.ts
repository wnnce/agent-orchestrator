import { createRoute, z } from "@hono/zod-openapi";
import { jsonBody, jsonContent, projectIdParamSchema } from "./common.ts";

export const webhookRequestSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .openapi({ description: "Existing session ID to append a turn to" }),
  input: z.string().optional().openapi({ description: "Prompt input text" }),
  query: z.string().optional().openapi({ description: "Alias for `input`" }),
  messageId: z
    .string()
    .optional()
    .openapi({ description: "Optional idempotency key for inbound routing" }),
  conversationId: z
    .string()
    .optional()
    .openapi({ description: "Optional external conversation identifier" }),
});

export const ingestWebhookRoute = createRoute({
  method: "post",
  path: "/webhooks/{projectId}",
  tags: ["Webhooks"],
  summary: "Ingest an HTTP webhook event for a project",
  request: {
    params: projectIdParamSchema,
    body: jsonBody(webhookRequestSchema),
  },
  responses: {
    202: jsonContent(z.record(z.string(), z.unknown()), "Webhook event accepted"),
  },
});
