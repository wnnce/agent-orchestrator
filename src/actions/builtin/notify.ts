import { z } from "zod";
import type { ActionContext, ActionDefinition } from "../types.ts";

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
    .describe("Optional notification severity level (maps to card colors or badges in Feishu/WeCom/Telegram)"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Optional metadata payload"),
});

export type SendNotificationParams = z.infer<typeof sendNotificationSchema>;

export interface SendNotificationResult {
  readonly success: boolean;
  readonly title: string;
  readonly target?: string | string[];
}

export const sendNotificationAction: ActionDefinition<
  SendNotificationParams,
  SendNotificationResult
> = {
  name: "send_notification",
  description:
    "Send a notification to configured team channels (Feishu, WeCom, Telegram, Webhooks, etc.) via Project Notification Outbox.",
  parameters: sendNotificationSchema,
  scopes: ["all"],
  async handler(params: SendNotificationParams, context: ActionContext): Promise<SendNotificationResult> {
    const target = params.target ?? "all";
    await context.notify(
      {
        title: params.title,
        text: params.text,
        ...(params.markdown !== undefined ? { markdown: params.markdown } : {}),
        ...(params.level !== undefined ? { level: params.level } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      },
      { target },
    );
    return {
      success: true,
      title: params.title,
      target,
    };
  },
};
