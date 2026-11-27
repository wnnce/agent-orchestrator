import { z } from "zod";
import { defineTool } from "../types.ts";

export const sendNotificationSchema = z.object({
  title: z.string().describe("Title of the notification"),
  text: z.string().describe("Plain text content of the notification"),
  markdown: z.string().optional().describe("Optional markdown formatted content"),
  target: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      "Optional target channel or platform: 'all' (default), 'feishu', 'wecom', 'telegram', 'webhook', or custom channel name",
    ),
  level: z
    .enum(["info", "success", "warning", "error"])
    .optional()
    .describe(
      "Optional notification severity level (maps to card colors or badges in Feishu/WeCom/Telegram)",
    ),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata payload"),
});

export const sendNotificationTool = defineTool({
  name: "send_notification",
  description:
    "Send a notification to configured team channels (Feishu, WeCom, Telegram, Webhooks, etc.) via Project Notification Outbox.",
  input: sendNotificationSchema,
  async run(input, ctx) {
    const target = input.target ?? "all";
    await ctx.notify(
      {
        title: input.title,
        text: input.text,
        ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
      { target },
    );
    return { success: true, title: input.title, target };
  },
});
