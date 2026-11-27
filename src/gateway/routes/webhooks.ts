import { randomUUID } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { ingestWebhookRoute } from "../contracts/webhooks.ts";
import { createOpenAPIApp } from "../openapi.ts";
import type { SessionService } from "../../app/sessions.ts";
import type { InboundService } from "../../app/inbound.ts";

export interface WebhooksRouteDeps {
  readonly sessions: SessionService;
  readonly inbound: InboundService;
}

export function createWebhooksRouter(deps: WebhooksRouteDeps): OpenAPIHono {
  const router = createOpenAPIApp();

  router.openapi(ingestWebhookRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const input = body.input ?? body.query ?? "";

    if (body.sessionId) {
      const turn = await deps.sessions.submitTurn(body.sessionId, input);
      return c.json({ sessionId: body.sessionId, turn } as Record<string, unknown>, 202);
    }

    const result = await deps.inbound.handle({
      messageId: body.messageId ?? `http_${randomUUID()}`,
      conversation: {
        channel: "http",
        conversationId: body.conversationId ?? `http_${randomUUID()}`,
      },
      projectId,
      text: input,
      receivedAt: new Date().toISOString(),
    });

    return c.json(result as unknown as Record<string, unknown>, 202);
  });

  return router;
}
