import type { NotificationProvider } from "./types.ts";

/**
 * Registry holding NotificationProvider instances by their type identifier.
 */
export class NotificationRegistry {
  private readonly providers = new Map<string, NotificationProvider>();

  register(provider: NotificationProvider): this {
    this.providers.set(provider.type.toLowerCase(), provider);
    return this;
  }

  unregister(type: string): boolean {
    return this.providers.delete(type.toLowerCase());
  }

  get(type: string): NotificationProvider | undefined {
    return this.providers.get(type.toLowerCase());
  }

  has(type: string): boolean {
    return this.providers.has(type.toLowerCase());
  }

  list(): NotificationProvider[] {
    return [...this.providers.values()];
  }
}
