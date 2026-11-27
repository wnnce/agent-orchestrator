import type { OriginRef } from "../domain/origin.ts";
import type { NotificationConfig, NotificationDeliveryDetail } from "../domain/types.ts";

export type { NotificationDeliveryDetail } from "../domain/types.ts";

export interface NotificationMessage {
  title: string;
  text: string;
  markdown?: string;
  level?: "info" | "success" | "warning" | "error";
  metadata?: Record<string, unknown>;
}

export interface NotificationOptions {
  /**
   * Target platform or specific channel:
   * - "all" (default): send to all active notification configs of the project
   * - "feishu" / "wecom" / "telegram" / "webhook" / "log": matches config.type
   * - "ops-feishu" / "dev-alert": matches config.name
   * - Array of target strings: ["feishu", "ops-webhook"]
   */
  target?: "all" | string | string[] | undefined;
}

export interface NotificationResult {
  total: number;
  sent: number;
  failed: number;
  details: NotificationDeliveryDetail[];
}

export interface NotificationProvider {
  readonly type: string;
  send(message: NotificationMessage, config: NotificationConfig): Promise<void>;
}

export interface EnqueuedNotification {
  readonly deliveryId: string;
  readonly projectId: string;
  readonly origin?: OriginRef | undefined;
  readonly configs: NotificationConfig[];
  readonly message: NotificationMessage;
  readonly options?: NotificationOptions | undefined;
}
