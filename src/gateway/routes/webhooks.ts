import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GatewayService } from "../service.ts";

export interface WebhooksRouteDeps {
  service: GatewayService;
}

const webhookRequestSchema = z.object({
  sessionId: z.string().optional().describe("Existing session ID to append a turn to"),
  input: z.string().optional().describe("Prompt input text"),
  query: z.string().optional().describe("Alias for `input`"),
  messageId: z.string().optional().describe("Optional idempotency key for inbound routing"),
  conversationId: z.string().optional().describe("Optional external conversation identifier"),
});

export function createWebhooksRouter(deps: WebhooksRouteDeps): Hono {
  const router = new Hono();

  router.post(
    "/webhooks/:projectId",
    describeRoute({
      tags: ["Webhooks"],
      summary: "Ingest an HTTP webhook event for a project",
      responses: {
        202: {
          description: "Webhook event accepted",
          content: {
            "application/json": { schema: resolver(z.record(z.string(), z.unknown())) },
          },
        },
      },
    }),
    validator("json", webhookRequestSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const body = c.req.valid("json");
      const input = body.input ?? body.query ?? "";

      if (body.sessionId) {
        const turn = await deps.service.submitTurn(body.sessionId, input);
        return c.json({ sessionId: body.sessionId, turn }, 202);
      }

      const result = await deps.service.handleInbound({
        messageId: body.messageId ?? `http_${randomUUID()}`,
        conversation: {
          channel: "http",
          conversationId: body.conversationId ?? `http_${randomUUID()}`,
        },
        projectId,
        text: input,
        receivedAt: new Date().toISOString(),
      });

      return c.json(result, 202);
    },
  );

  return router;
}
