interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Bounded in-memory TTL cache with in-flight singleflight deduplication.
 * Prevents concurrent polling bursts from fanning out duplicate aggregation queries.
 */
export class TtlSingleflightCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly maxEntries = 200) {}

  async getOrLoad(
    key: string,
    ttlMs: number,
    loader: () => Promise<V>,
    options?: { bypassCache?: boolean },
  ): Promise<V> {
    const now = Date.now();
    if (!options?.bypassCache) {
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }
    }

    const existingFlight = this.inflight.get(key);
    if (existingFlight) {
      return existingFlight;
    }

    const promise = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private set(key: string, value: V, ttlMs: number): void {
    const now = Date.now();
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      for (const [k, entry] of this.entries) {
        if (entry.expiresAt <= now) {
          this.entries.delete(k);
        }
      }
      if (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) {
          this.entries.delete(oldestKey);
        }
      }
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}
