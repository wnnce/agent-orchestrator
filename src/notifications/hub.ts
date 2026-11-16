import { Logger } from "../observability/logger.ts";
import type { NotificationConfig, NotificationDeliveryDetail } from "../domain/types.ts";
import type {
  NotificationMessage,
  NotificationOptions,
  NotificationResult,
  NotificationProvider,
} from "./types.ts";
import { NotificationRegistry } from "./registry.ts";
import { LogNotificationProvider } from "./providers/log.ts";
import { WebhookNotificationProvider } from "./providers/webhook.ts";
import { FeishuNotificationProvider } from "./providers/feishu.ts";
import { WeComNotificationProvider } from "./providers/wecom.ts";
import { TelegramNotificationProvider } from "./providers/telegram.ts";

/**
 * Central dispatcher responsible for dispatching notifications to registered providers.
 */
export class NotificationHub {
  readonly registry: NotificationRegistry;

  constructor(
    private readonly logger = new Logger(),
    registry?: NotificationRegistry,
  ) {
    this.registry = registry ?? new NotificationRegistry();
    if (!registry) {
      this.registry.register(new LogNotificationProvider(this.logger));
      this.registry.register(new WebhookNotificationProvider());
      this.registry.register(new FeishuNotificationProvider());
      this.registry.register(new WeComNotificationProvider());
      this.registry.register(new TelegramNotificationProvider());
    }
  }

  register(provider: NotificationProvider): this {
    this.registry.register(provider);
    return this;
  }

  /**
   * Filters configs based on target option ("all", specific type, specific name, or array).
   */
  filterConfigs(
    configs: NotificationConfig[] | undefined,
    options?: NotificationOptions,
  ): NotificationConfig[] {
    if (!configs || configs.length === 0) return [];
    const target = options?.target ?? "all";

    return configs.filter((config) => {
      if (config.enabled === false) return false;
      if (target === "all") return true;

      const targetList = Array.isArray(target) ? target : [target];
      return targetList.some(
        (t) =>
          t.toLowerCase() === config.type.toLowerCase() ||
          (config.name && t.toLowerCase() === config.name.toLowerCase()),
      );
    });
  }

  async send(
    configs: NotificationConfig[] | undefined,
    message: NotificationMessage,
    options?: NotificationOptions,
  ): Promise<NotificationResult> {
    const targets = this.filterConfigs(configs, options);
    const details: NotificationDeliveryDetail[] = [];
    let sent = 0;
    let failed = 0;

    const tasks = targets.map(async (config) => {
      const provider = this.registry.get(config.type);
      if (!provider) {
        const errorMsg = `No notification provider registered for type: ${config.type}`;
        this.logger.warn(errorMsg, { configName: config.name });
        details.push({
          name: config.name,
          type: config.type,
          success: false,
          error: errorMsg,
        });
        failed++;
        return;
      }

      try {
        await provider.send(message, config);
        details.push({
          name: config.name,
          type: config.type,
          success: true,
        });
        sent++;
      } catch (err: any) {
        const errorMsg = err?.message ?? String(err);
        this.logger.error("Notification delivery failed", {
          name: config.name,
          type: config.type,
          error: errorMsg,
        });
        details.push({
          name: config.name,
          type: config.type,
          success: false,
          error: errorMsg,
        });
        failed++;
      }
    });

    await Promise.allSettled(tasks);

    return {
      total: targets.length,
      sent,
      failed,
      details,
    };
  }
}
