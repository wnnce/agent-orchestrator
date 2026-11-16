import { Logger } from "../../observability/logger.ts";
import type { NotificationMessage, NotificationProvider } from "../types.ts";

export class LogNotificationProvider implements NotificationProvider {
  readonly type = "log" as const;

  constructor(private readonly logger = new Logger()) {}

  async send(message: NotificationMessage): Promise<void> {
    this.logger.info("notification delivered to log provider", { notification: message });
  }
}
