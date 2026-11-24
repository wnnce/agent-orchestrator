import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { TurnUsage } from "../../domain/types.ts";
import { buildSingleTurnUsage, clampTokenCount, normalizeTokenUsage } from "../usage.ts";

/**
 * Structural shape of ACP unstable `PromptResponse.usage` (not exported by stable SDK root types).
 */
export interface ACPPromptUsage {
  readonly inputTokens?: number | null | undefined;
  readonly outputTokens?: number | null | undefined;
  readonly cachedReadTokens?: number | null | undefined;
  readonly cachedWriteTokens?: number | null | undefined;
  readonly thoughtTokens?: number | null | undefined;
  readonly totalTokens?: number | null | undefined;
}

/** Extracts unstable `models.currentModelId` if present on a session creation/resume response. */
export function extractACPResponseModels(
  response: unknown,
): { currentModelId?: string | null | undefined } | undefined {
  if (!response || typeof response !== "object" || !("models" in response)) {
    return undefined;
  }
  const models = (response as { models?: unknown }).models;
  if (!models || typeof models !== "object") return undefined;
  const currentModelId = (models as { currentModelId?: unknown }).currentModelId;
  return typeof currentModelId === "string" ? { currentModelId } : undefined;
}

/** Extracts unstable `usage` payload if present on a `PromptResponse`. */
export function extractACPPromptUsage(response: unknown): ACPPromptUsage | undefined {
  if (!response || typeof response !== "object" || !("usage" in response)) {
    return undefined;
  }
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  return usage as ACPPromptUsage;
}

/**
 * Extracts the active model id from ACP `configOptions` (or optional unstable `models` payload).
 */
export function extractACPActiveModel(
  configOptions: readonly SessionConfigOption[] | null | undefined,
  models?: { currentModelId?: string | null | undefined } | null | undefined,
): string | undefined {
  if (configOptions) {
    for (const opt of configOptions) {
      if (opt.type !== "select") continue;
      if (opt.category === "model" || opt.id === "model") {
        if (typeof opt.currentValue === "string" && opt.currentValue.trim()) {
          return opt.currentValue.trim();
        }
      }
    }
  }
  if (typeof models?.currentModelId === "string" && models.currentModelId.trim()) {
    return models.currentModelId.trim();
  }
  return undefined;
}

/**
 * Normalizes an ACP `PromptResponse.usage` payload into the canonical `TurnUsage` format.
 *
 * Automatically handles both exclusive-input ACP agents (e.g. `agy`, where
 * `inputTokens + cachedReadTokens + outputTokens === totalTokens`) and inclusive-input agents
 * (where `inputTokens + outputTokens === totalTokens` and cached tokens are a subset of `inputTokens`).
 */
export function normalizeACPPromptUsage(
  raw: ACPPromptUsage | null | undefined,
  context?: {
    readonly model?: string | undefined;
    readonly provider?: string | undefined;
    readonly contextUsedTokens?: number | undefined;
    readonly contextWindowTokens?: number | undefined;
  },
): TurnUsage | undefined {
  if (!raw) return undefined;

  const rawInput = clampTokenCount(raw.inputTokens);
  const cacheRead = clampTokenCount(raw.cachedReadTokens);
  const cacheWrite = clampTokenCount(raw.cachedWriteTokens);
  const output = clampTokenCount(raw.outputTokens);
  const thought = clampTokenCount(raw.thoughtTokens);
  const rawTotal = clampTokenCount(raw.totalTokens);

  const inputIncludesCache =
    (cacheRead > 0 || cacheWrite > 0) &&
    rawTotal > 0 &&
    rawInput + output === rawTotal &&
    rawInput >= cacheRead + cacheWrite;

  const normalized = normalizeTokenUsage({
    inputTokens: rawInput,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: thought,
    inputIncludesCache,
  });

  return buildSingleTurnUsage(normalized, {
    primaryModel: context?.model,
    provider: context?.provider,
    contextUsedTokens: context?.contextUsedTokens,
    contextWindowTokens: context?.contextWindowTokens,
  });
}
