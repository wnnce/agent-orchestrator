import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import type { FeishuAdapter } from "../../channels/feishu.ts";

export interface ChannelsRouteDeps {
  feishu: FeishuAdapter;
}

const jsonRecordSchema = z.record(z.string(), z.unknown());

export function createChannelsRouter(deps: ChannelsRouteDeps): Hono {
  const router = new Hono();

  router.post(
    "/channels/feishu/events",
    describeRoute({
      tags: ["Channels"],
      summary: "Receive Feishu event callbacks",
      description:
        "Webhook endpoint for Feishu/Lark URL verification challenges and inbound message events.",
      security: [],
      requestBody: {
        required: true,
        content: { "application/json": { schema: resolver(jsonRecordSchema) } },
      },
      responses: {
        200: {
          description: "Callback acknowledged",
          content: { "application/json": { schema: resolver(jsonRecordSchema) } },
        },
      },
    }),
    (c) => deps.feishu.handle(c.req.raw),
  );

  return router;
}
