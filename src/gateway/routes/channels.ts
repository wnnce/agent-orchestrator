import { Hono } from "hono";
import type { FeishuAdapter } from "../../channels/feishu.ts";

export interface ChannelsRouteDeps {
  feishu: FeishuAdapter;
}

export function createChannelsRouter(deps: ChannelsRouteDeps): Hono {
  const router = new Hono();
  router.post("/channels/feishu/events", (c) => deps.feishu.handle(c.req.raw));
  return router;
}
