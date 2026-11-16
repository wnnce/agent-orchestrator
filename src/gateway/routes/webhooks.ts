import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { GatewayService } from "../service.ts";

export interface WebhooksRouteDeps {
  service: GatewayService;
}

export function createWebhooksRouter(deps: WebhooksRouteDeps): Hono {
  const router = new Hono();

  router.post("/webhooks/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const input =
      typeof body.input === "string"
        ? body.input
        : typeof body.query === "string"
          ? body.query
          : "";

    if (sessionId) {
      const turn = await deps.service.submitTurn(sessionId, input);
      return c.json({ sessionId, turn }, 202);
    }

    const result = await deps.service.handleInbound({
      messageId: typeof body.messageId === "string" ? body.messageId : `http_${randomUUID()}`,
      conversation: {
        channel: "http",
        conversationId:
          typeof body.conversationId === "string" ? body.conversationId : `http_${randomUUID()}`,
      },
      projectId,
      text: input,
      receivedAt: new Date().toISOString(),
    });

    return c.json(result, 202);
  });

  return router;
}
