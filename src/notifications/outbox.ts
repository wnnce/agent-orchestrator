import crypto from "node:crypto";
import type { OriginRef } from "../domain/origin.ts";
import type { NotificationConfig, NotificationDelivery } from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";
import { Logger } from "../observability/logger.ts";
import type {
  EnqueuedNotification,
  NotificationMessage,
  NotificationOptions,
  NotificationResult,
} from "./types.ts";
import { NotificationHub } from "./hub.ts";

export class NotificationOutbox {
  private readonly queueBuffer: EnqueuedNotification[] = [];
  private activeWorkers = 0;
  private readonly maxConcurrency = 5;

  constructor(
    private readonly store: Store,
    private readonly hub: NotificationHub,
    private readonly logger = new Logger(),
  ) {}

  /**
   * Enqueue a notification into the in-memory queue.
   * Immediately triggers reactive background dispatch without blocking caller or polling DB.
   */
  async queue(
    projectId: string,
    origin: OriginRef | undefined,
    configs: NotificationConfig[] | undefined,
    message: NotificationMessage,
    options?: NotificationOptions,
  ): Promise<string | undefined> {
    const targets = this.hub.filterConfigs(configs, options);
    if (targets.length === 0) {
      this.logger.debug("no matching notification configs to queue", {
        projectId,
        ...(origin ? { originKind: origin.kind, originId: origin.id } : {}),
        target: options?.target ?? "all",
      });
      return undefined;
    }

    const deliveryId = `delivery_${crypto.randomUUID()}`;
    const item: EnqueuedNotification = {
      deliveryId,
      projectId,
      ...(origin ? { origin } : {}),
      configs: targets,
      message,
      options,
    };

    this.queueBuffer.push(item);
    this.logger.info("notification enqueued to memory queue", {
      projectId,
      ...(origin ? { originKind: origin.kind, originId: origin.id } : {}),
      deliveryId,
      providerCount: targets.length,
      target: options?.target ?? "all",
      queueLength: this.queueBuffer.length,
    });

    // Reactive trigger: immediately pump memory queue (0ms latency, zero sleep)
    void this.processNext();
    return deliveryId;
  }

  /**
   * Reactive worker pump consuming from the in-memory queue.
   */
  private async processNext(): Promise<void> {
    if (this.activeWorkers >= this.maxConcurrency || this.queueBuffer.length === 0) {
      return;
    }

    const item = this.queueBuffer.shift();
    if (!item) return;

    this.activeWorkers++;
    try {
      await this.dispatchItem(item);
    } finally {
      this.activeWorkers--;
      if (this.queueBuffer.length > 0) {
        void this.processNext();
      }
    }
  }

  /**
   * Dispatches the notification immediately via NotificationHub,
   * then asynchronously persists the delivery audit record to Store.
   * No retry on failure.
   */
  private async dispatchItem(item: EnqueuedNotification): Promise<void> {
    let result: NotificationResult;
    try {
      result = await this.hub.send(item.configs, item.message);
    } catch (err) {
      result = {
        total: item.configs.length,
        sent: 0,
        failed: item.configs.length,
        details: item.configs.map((c) => ({
          name: c.name,
          type: c.type,
          success: false,
          error: String(err),
        })),
      };
    }

    const status: "sent" | "partial" | "failed" =
      result.failed === 0 ? "sent" : result.sent === 0 ? "failed" : "partial";

    const delivery: NotificationDelivery = {
      id: item.deliveryId,
      projectId: item.projectId,
      ...(item.origin ? { originKind: item.origin.kind, originId: item.origin.id } : {}),
      configs: item.configs,
      message: item.message,
      status,
      details: result.details,
      createdAt: new Date().toISOString(),
    };

    // Asynchronously record delivery audit into store
    try {
      await this.store.recordNotificationDelivery(delivery);
      this.logger.info("notification delivered and recorded", {
        deliveryId: item.deliveryId,
        projectId: item.projectId,
        status,
        sent: result.sent,
        failed: result.failed,
      });
    } catch (dbErr) {
      this.logger.error("failed to record notification delivery into store", {
        deliveryId: item.deliveryId,
        projectId: item.projectId,
        error: dbErr,
      });
    }
  }

  /**
   * Drains remaining items in the in-memory queue (useful for testing and graceful shutdown).
   */
  async drain(_projectId?: string): Promise<void> {
    while (this.queueBuffer.length > 0 || this.activeWorkers > 0) {
      await this.processNext();
      if (this.queueBuffer.length === 0 && this.activeWorkers === 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  get pendingCount(): number {
    return this.queueBuffer.length;
  }
}
