import type { ModelTokenUsage, TokenUsage, TurnUsage } from "../domain/types.ts";

export interface RawTokenUsageInput {
  readonly inputTokens?: number | null | undefined;
  readonly cacheReadTokens?: number | null | undefined;
  readonly cacheWriteTokens?: number | null | undefined;
  readonly outputTokens?: number | null | undefined;
  readonly reasoningTokens?: number | null | undefined;
  /**
   * Set to `true` when the provider's `inputTokens` already includes cached input tokens
   * (e.g. OpenAI / Codex). When `true`, `cacheReadTokens` and `cacheWriteTokens` are subtracted
   * from `inputTokens` so the resulting `TokenUsage` uses strictly exclusive input buckets.
   */
  readonly inputIncludesCache?: boolean | undefined;
}

export interface TurnUsageContext {
  readonly primaryModel?: string | undefined;
  readonly contextUsedTokens?: number | undefined;
  readonly contextWindowTokens?: number | undefined;
}

export const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
};

/** Clamps a numeric candidate to a finite non-negative integer token count. */
export function clampTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.trunc(value);
}

/**
 * Normalizes provider token counts into the canonical exclusive `TokenUsage` format.
 * Guarantees `totalTokens === inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`.
 */
export function normalizeTokenUsage(raw: RawTokenUsageInput): TokenUsage {
  const rawInput = clampTokenCount(raw.inputTokens);
  const cacheReadTokens = clampTokenCount(raw.cacheReadTokens);
  const cacheWriteTokens = clampTokenCount(raw.cacheWriteTokens);
  const outputTokens = clampTokenCount(raw.outputTokens);
  const reasoningTokens = clampTokenCount(raw.reasoningTokens);

  const inputTokens = raw.inputIncludesCache
    ? Math.max(0, rawInput - cacheReadTokens - cacheWriteTokens)
    : rawInput;
  const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;

  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

/** Sums two normalized `TokenUsage` instances. */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const inputTokens = a.inputTokens + b.inputTokens;
  const cacheReadTokens = a.cacheReadTokens + b.cacheReadTokens;
  const cacheWriteTokens = a.cacheWriteTokens + b.cacheWriteTokens;
  const outputTokens = a.outputTokens + b.outputTokens;
  const reasoningTokens = a.reasoningTokens + b.reasoningTokens;
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
  };
}

/**
 * Computes a clamped per-turn delta (`current - previous`) for providers that only report
 * session-cumulative token counters.
 */
export function subtractTokenUsage(current: TokenUsage, previous?: TokenUsage): TokenUsage {
  if (!previous) return current;
  const inputTokens = Math.max(0, current.inputTokens - previous.inputTokens);
  const cacheReadTokens = Math.max(0, current.cacheReadTokens - previous.cacheReadTokens);
  const cacheWriteTokens = Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens);
  const outputTokens = Math.max(0, current.outputTokens - previous.outputTokens);
  const reasoningTokens = Math.max(0, current.reasoningTokens - previous.reasoningTokens);
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
  };
}

/**
 * Aggregates one or more per-model usage entries into a single `TurnUsage`.
 * Entries with identical `(provider, model)` are merged. Returns `undefined` when no tokens were recorded.
 */
export function buildTurnUsage(
  entries: readonly ModelTokenUsage[],
  context?: TurnUsageContext,
): TurnUsage | undefined {
  const mergedMap = new Map<string, ModelTokenUsage>();
  for (const entry of entries) {
    if (entry.totalTokens <= 0 && entry.reasoningTokens <= 0) continue;
    const key = `${entry.provider ?? ""}\0${entry.model}`;
    const existing = mergedMap.get(key);
    if (existing) {
      const summed = addTokenUsage(existing, entry);
      mergedMap.set(key, {
        model: existing.model,
        ...(existing.provider ? { provider: existing.provider } : {}),
        ...summed,
      });
    } else {
      mergedMap.set(key, {
        model: entry.model,
        ...(entry.provider ? { provider: entry.provider } : {}),
        inputTokens: entry.inputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens,
        outputTokens: entry.outputTokens,
        reasoningTokens: entry.reasoningTokens,
        totalTokens: entry.totalTokens,
      });
    }
  }

  const byModel = [...mergedMap.values()];
  if (byModel.length === 0) return undefined;

  let total = ZERO_TOKEN_USAGE;
  let dominant = byModel[0]!;
  for (const item of byModel) {
    total = addTokenUsage(total, item);
    if (item.totalTokens > dominant.totalTokens) {
      dominant = item;
    }
  }

  const primaryModel = context?.primaryModel?.trim() || dominant.model;
  const contextUsedTokens =
    context?.contextUsedTokens !== undefined && context.contextUsedTokens > 0
      ? clampTokenCount(context.contextUsedTokens)
      : undefined;
  const contextWindowTokens =
    context?.contextWindowTokens !== undefined && context.contextWindowTokens > 0
      ? clampTokenCount(context.contextWindowTokens)
      : undefined;

  return {
    ...(primaryModel ? { model: primaryModel } : {}),
    ...total,
    byModel,
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

/** Builds a `TurnUsage` from a single `TokenUsage` total (no multi-model split needed). */
export function buildSingleTurnUsage(
  usage: TokenUsage,
  context?: TurnUsageContext & { readonly provider?: string | undefined },
): TurnUsage | undefined {
  if (usage.totalTokens <= 0 && usage.reasoningTokens <= 0) return undefined;
  const model = context?.primaryModel?.trim() || undefined;
  const provider = context?.provider?.trim() || undefined;
  const contextUsedTokens =
    context?.contextUsedTokens !== undefined && context.contextUsedTokens > 0
      ? clampTokenCount(context.contextUsedTokens)
      : undefined;
  const contextWindowTokens =
    context?.contextWindowTokens !== undefined && context.contextWindowTokens > 0
      ? clampTokenCount(context.contextWindowTokens)
      : undefined;

  return {
    ...(model ? { model } : {}),
    ...usage,
    ...(model ? { byModel: [{ model, ...(provider ? { provider } : {}), ...usage }] } : {}),
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

/** Runtime type guard validating a `TurnUsage` object from an event payload. */
export function isTurnUsage(value: unknown): value is TurnUsage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.inputTokens === "number" &&
    typeof v.cacheReadTokens === "number" &&
    typeof v.cacheWriteTokens === "number" &&
    typeof v.outputTokens === "number" &&
    typeof v.reasoningTokens === "number" &&
    typeof v.totalTokens === "number" &&
    Number.isFinite(v.totalTokens)
  );
}
