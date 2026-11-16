import type { NotificationConfig } from "../../domain/types.ts";
import type { NotificationMessage, NotificationProvider } from "../types.ts";

export class WebhookNotificationProvider implements NotificationProvider {
  readonly type = "webhook" as const;

  async send(message: NotificationMessage, config: NotificationConfig): Promise<void> {
    if (!config.url) throw new Error("webhook notification needs url");
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.secret ? { authorization: `Bearer ${config.secret}` } : {}),
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      throw new Error(`webhook notification failed: HTTP ${response.status}`);
    }
  }
}
