import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "../../observability/logger.ts";
import {
  CachedJsonFile,
  optionalPositiveInt,
  optionalTrimmedString,
  uniqueEfforts,
  type RuntimeModelLister,
  type RuntimeModelOption,
} from "../models.ts";
import { PI_THINKING_LEVELS } from "./types.ts";

const piModelEntrySchema = z.object({
  id: z.string().trim().min(1),
  name: optionalTrimmedString,
  reasoning: z.boolean().nullish().catch(undefined),
  contextWindow: optionalPositiveInt,
  thinkingLevelMap: z.record(z.string(), z.unknown()).nullish().catch(undefined),
});

const piProviderSchema = z.object({
  models: z.array(z.unknown()),
});

const piModelsFileSchema = z.object({
  providers: z.record(z.string(), z.unknown()),
});

/** Parses Pi `models.json` into normalized `RuntimeModelOption` entries. */
export function parsePiModelsJson(raw: unknown): RuntimeModelOption[] {
  const root = piModelsFileSchema.safeParse(raw);
  if (!root.success) return [];

  const result: RuntimeModelOption[] = [];
  for (const [providerName, providerRaw] of Object.entries(root.data.providers)) {
    const provider = piProviderSchema.safeParse(providerRaw);
    if (!provider.success) continue;

    for (const item of provider.data.models) {
      const parsed = piModelEntrySchema.safeParse(item);
      if (!parsed.success) continue;
      const entry = parsed.data;

      let reasoningEfforts: readonly string[] = [];
      if (entry.reasoning !== false) {
        if (entry.thinkingLevelMap) {
          reasoningEfforts = uniqueEfforts(
            Object.entries(entry.thinkingLevelMap)
              .filter(([, mapped]) => mapped !== null && mapped !== undefined && mapped !== false)
              .map(([level]) => level),
          );
        } else if (entry.reasoning === true) {
          reasoningEfforts = [...PI_THINKING_LEVELS];
        }
      }

      result.push({
        id: `${providerName}/${entry.id}`,
        displayName: entry.name ?? entry.id,
        reasoningEfforts,
        ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      });
    }
  }
  return result;
}

/** Creates a model lister reading Pi's local `models.json` with mtime caching. */
export function createPiModelLister(options?: {
  readonly piAgentDir?: string | undefined;
  readonly logger?: Logger | undefined;
}): RuntimeModelLister {
  const reader = new CachedJsonFile(options?.logger);
  return async () => {
    const piAgentDir =
      options?.piAgentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      path.join(os.homedir(), ".pi", "agent");
    const raw = await reader.read(path.join(piAgentDir, "models.json"));
    return parsePiModelsJson(raw);
  };
}
