import { z } from "zod";
import type { Logger } from "../observability/logger.ts";
import {
  CachedJsonFile,
  effortValueSchema,
  optionalPositiveInt,
  optionalTrimmedString,
  uniqueEfforts,
  type RuntimeModelOption,
} from "./models.ts";
import type { RuntimeMetadata, RuntimeRegistry } from "./registry.ts";

/** Enriched runtime description returned by `GET /runtimes`. */
export interface RuntimeInfo extends RuntimeMetadata {
  readonly models: readonly RuntimeModelOption[];
}

/** Override/addition entry stored in `runtime-models.json`. */
export interface RuntimeModelOverride {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly reasoningEfforts?: readonly string[] | undefined;
  readonly defaultReasoningEffort?: string | undefined;
  readonly contextWindow?: number | undefined;
  /** Hide a runtime-discovered model from the exposed catalog. */
  readonly disabled?: boolean | undefined;
}

export interface RuntimeModelCatalogOptions {
  /** Path to optional user-maintained JSON catalog (e.g. `runtime-models.json`). */
  readonly modelsFile?: string | undefined;
  readonly logger?: Logger | undefined;
}

const overrideEntrySchema = z.object({
  id: z.string().trim().min(1),
  displayName: optionalTrimmedString,
  reasoningEfforts: z.array(z.unknown()).nullish().catch(undefined),
  defaultReasoningEffort: optionalTrimmedString,
  contextWindow: optionalPositiveInt,
  disabled: z.boolean().nullish().catch(undefined),
});

const rawObjectSchema = z.record(z.string(), z.unknown());

/** Parses a `runtime-models.json` override file (flat or `{ runtimes: { ... } }` format). */
export function parseRuntimeModelsFile(
  raw: unknown,
): Map<string, readonly RuntimeModelOverride[]> {
  const map = new Map<string, readonly RuntimeModelOverride[]>();
  const root = rawObjectSchema.safeParse(raw);
  if (!root.success) return map;

  const nested = rawObjectSchema.safeParse(root.data.runtimes);
  const container = nested.success ? nested.data : root.data;

  for (const [runtimeKey, entriesRaw] of Object.entries(container)) {
    if (runtimeKey.startsWith("$") || !Array.isArray(entriesRaw)) continue;
    const normalizedKey = runtimeKey.trim().toLowerCase();
    if (!normalizedKey) continue;

    const overrides: RuntimeModelOverride[] = [];
    for (const item of entriesRaw) {
      const parsed = overrideEntrySchema.safeParse(item);
      if (!parsed.success) continue;
      const entry = parsed.data;

      let reasoningEfforts: string[] | undefined;
      if (entry.reasoningEfforts !== undefined && entry.reasoningEfforts !== null) {
        const list: string[] = [];
        for (const rawEffort of entry.reasoningEfforts) {
          const effort = effortValueSchema.safeParse(rawEffort);
          if (effort.success) list.push(effort.data);
        }
        reasoningEfforts = uniqueEfforts(list);
      }

      overrides.push({
        id: entry.id,
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
        ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
        ...(entry.defaultReasoningEffort
          ? { defaultReasoningEffort: entry.defaultReasoningEffort }
          : {}),
        ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
        ...(entry.disabled === true ? { disabled: true } : {}),
      });
    }
    map.set(normalizedKey, overrides);
  }
  return map;
}

function mergeModels(
  base: readonly RuntimeModelOption[],
  overrides: readonly RuntimeModelOverride[] | undefined,
  fallbackEfforts: readonly string[],
): RuntimeModelOption[] {
  const byId = new Map<string, RuntimeModelOption>();
  for (const model of base) {
    byId.set(model.id, model);
  }

  for (const override of overrides ?? []) {
    if (override.disabled) {
      byId.delete(override.id);
      continue;
    }
    const existing = byId.get(override.id);
    if (existing) {
      byId.set(override.id, {
        id: existing.id,
        displayName: override.displayName ?? existing.displayName,
        reasoningEfforts: override.reasoningEfforts ?? existing.reasoningEfforts,
        ...(override.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: override.defaultReasoningEffort }
          : existing.defaultReasoningEffort !== undefined
            ? { defaultReasoningEffort: existing.defaultReasoningEffort }
            : {}),
        ...(override.contextWindow !== undefined
          ? { contextWindow: override.contextWindow }
          : existing.contextWindow !== undefined
            ? { contextWindow: existing.contextWindow }
            : {}),
      });
    } else {
      byId.set(override.id, {
        id: override.id,
        displayName: override.displayName ?? override.id,
        reasoningEfforts: override.reasoningEfforts ?? [...fallbackEfforts],
        ...(override.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: override.defaultReasoningEffort }
          : {}),
        ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
      });
    }
  }

  return [...byId.values()];
}

/**
 * Runtime-agnostic model catalog that merges models exposed by each registered runtime
 * (`RuntimeRegistry.listModels`) with optional user-maintained overrides in `runtime-models.json`.
 */
export class RuntimeModelCatalog {
  private readonly overrideFile: CachedJsonFile;

  constructor(private readonly options: RuntimeModelCatalogOptions = {}) {
    this.overrideFile = new CachedJsonFile(options.logger);
  }

  async listModels(registry: RuntimeRegistry, runtimeType: string): Promise<RuntimeModelOption[]> {
    const key = runtimeType.trim().toLowerCase();
    const meta = registry.listRuntimes().find((r) => r.type === key);
    const [discovered, overridesMap] = await Promise.all([
      registry.listModels(key),
      this.loadOverrides(),
    ]);
    return mergeModels(discovered, overridesMap.get(key), meta?.defaultReasoningEfforts ?? []);
  }

  async listRuntimes(
    registry: RuntimeRegistry,
    options?: { readonly includeInternal?: boolean | undefined },
  ): Promise<RuntimeInfo[]> {
    const includeInternal = options?.includeInternal ?? true;
    const overridesMap = await this.loadOverrides();
    const metas = registry.listRuntimes().filter((meta) => includeInternal || !meta.internal);

    return Promise.all(
      metas.map(async (meta) => {
        const discovered = await registry.listModels(meta.type);
        const models = mergeModels(
          discovered,
          overridesMap.get(meta.type),
          meta.defaultReasoningEfforts ?? [],
        );
        return {
          ...meta,
          models,
        };
      }),
    );
  }

  private async loadOverrides(): Promise<Map<string, readonly RuntimeModelOverride[]>> {
    if (!this.options.modelsFile) return new Map();
    const raw = await this.overrideFile.read(this.options.modelsFile);
    return parseRuntimeModelsFile(raw);
  }
}
