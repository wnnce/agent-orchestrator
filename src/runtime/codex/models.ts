import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "../../observability/logger.ts";
import {
  CachedJsonFile,
  effortValueSchema,
  optionalPositiveInt,
  optionalTrimmedString,
  uniqueEfforts,
  type RuntimeModelLister,
  type RuntimeModelOption,
} from "../models.ts";

const codexModelEntrySchema = z.object({
  slug: z.string().trim().min(1),
  display_name: optionalTrimmedString,
  visibility: optionalTrimmedString,
  default_reasoning_level: optionalTrimmedString,
  supported_reasoning_levels: z.array(z.unknown()).nullish().catch(undefined),
  context_window: optionalPositiveInt,
});

const codexModelsCacheSchema = z.object({
  models: z.array(z.unknown()),
});

/** Parses Codex `models_cache.json` into normalized `RuntimeModelOption` entries. */
export function parseCodexModelsCache(raw: unknown): RuntimeModelOption[] {
  const root = codexModelsCacheSchema.safeParse(raw);
  if (!root.success) return [];

  const result: RuntimeModelOption[] = [];
  for (const item of root.data.models) {
    const parsed = codexModelEntrySchema.safeParse(item);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (entry.visibility === "hide") continue;

    const efforts: string[] = [];
    for (const rawLevel of entry.supported_reasoning_levels ?? []) {
      const level = effortValueSchema.safeParse(rawLevel);
      if (level.success) efforts.push(level.data);
    }

    result.push({
      id: entry.slug,
      displayName: entry.display_name ?? entry.slug,
      reasoningEfforts: uniqueEfforts(efforts),
      ...(entry.default_reasoning_level
        ? { defaultReasoningEffort: entry.default_reasoning_level }
        : {}),
      ...(entry.context_window !== undefined ? { contextWindow: entry.context_window } : {}),
    });
  }
  return result;
}

/** Creates a model lister reading Codex's local `models_cache.json` with mtime caching. */
export function createCodexModelLister(options?: {
  readonly codexHome?: string | undefined;
  readonly logger?: Logger | undefined;
}): RuntimeModelLister {
  const reader = new CachedJsonFile(options?.logger);
  return async () => {
    const codexHome =
      options?.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const raw = await reader.read(path.join(codexHome, "models_cache.json"));
    return parseCodexModelsCache(raw);
  };
}
