import type { TokenUsage, TurnUsage } from "../../domain/types.ts";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  buildSingleTurnUsage,
  normalizeTokenUsage,
  subtractTokenUsage,
} from "../usage.ts";
import type { ThreadTokenUsage } from "./generated/v2/ThreadTokenUsage.ts";
import type { TokenUsageBreakdown } from "./generated/v2/TokenUsageBreakdown.ts";

interface CodexThreadUsageState {
  model?: string | undefined;
  provider?: string | undefined;
  resumed: boolean;
  /** Last thread-cumulative total reported by `thread/tokenUsage/updated`. */
  lastTotal?: TokenUsage | undefined;
  /** Snapshot of `lastTotal` captured when the current turn started (or ZERO for fresh threads). */
  turnBaselineTotal?: TokenUsage | undefined;
  /** Sum of per-call `rawResponse/completed` usages observed during the current turn. */
  turnRawSum?: TokenUsage | undefined;
  /** Most recent per-call `last` usage reported by `thread/tokenUsage/updated` during the current turn. */
  turnLastCallUsage?: TokenUsage | undefined;
  /** Most recent context occupancy (tokens) for the active turn. */
  turnContextUsed?: number | undefined;
  /** Model context window size reported by `thread/tokenUsage/updated`. */
  contextWindow?: number | undefined;
}

export function normalizeCodexBreakdown(breakdown: TokenUsageBreakdown): TokenUsage {
  return normalizeTokenUsage({
    inputTokens: breakdown.inputTokens,
    cacheReadTokens: breakdown.cachedInputTokens,
    cacheWriteTokens: breakdown.cacheWriteInputTokens,
    outputTokens: breakdown.outputTokens,
    reasoningTokens: breakdown.reasoningOutputTokens,
    inputIncludesCache: true,
  });
}

/**
 * Tracks per-thread and per-turn token usage for Codex app-server notifications.
 *
 * Prefers summing exact per-call `rawResponse/completed` notifications; falls back to
 * `thread/tokenUsage/updated` delta (or `last` on the first turn of a resumed thread without
 * a prior baseline) if `rawResponse/completed` is absent.
 */
export class CodexUsageTracker {
  private readonly threads = new Map<string, CodexThreadUsageState>();

  initThread(
    threadId: string,
    params: { model?: string | undefined; provider?: string | undefined; resumed: boolean },
  ): void {
    this.threads.set(threadId, {
      model: params.model,
      provider: params.provider,
      resumed: params.resumed,
      turnBaselineTotal: params.resumed ? undefined : ZERO_TOKEN_USAGE,
    });
  }

  onModelRerouted(threadId: string, toModel: string): void {
    const state = this.threads.get(threadId);
    if (state && toModel) {
      state.model = toModel;
    }
  }

  onTurnStarted(threadId: string): void {
    const state = this.threads.get(threadId);
    if (!state) return;
    if (state.lastTotal) {
      state.turnBaselineTotal = state.lastTotal;
    } else if (!state.resumed) {
      state.turnBaselineTotal = ZERO_TOKEN_USAGE;
    }
    state.turnRawSum = undefined;
    state.turnLastCallUsage = undefined;
    state.turnContextUsed = undefined;
  }

  onRawResponseCompleted(threadId: string, usage: TokenUsageBreakdown | null | undefined): void {
    if (!usage) return;
    const state = this.threads.get(threadId);
    if (!state) return;
    const normalized = normalizeCodexBreakdown(usage);
    if (normalized.totalTokens <= 0 && normalized.reasoningTokens <= 0) return;
    state.turnRawSum = state.turnRawSum
      ? addTokenUsage(state.turnRawSum, normalized)
      : normalized;
    state.turnContextUsed = normalized.totalTokens;
  }

  onThreadTokenUsageUpdated(threadId: string, tokenUsage: ThreadTokenUsage): void {
    const state = this.threads.get(threadId);
    if (!state) return;
    const total = normalizeCodexBreakdown(tokenUsage.total);
    const last = normalizeCodexBreakdown(tokenUsage.last);
    state.lastTotal = total;
    state.turnLastCallUsage = last;
    if (last.totalTokens > 0) {
      state.turnContextUsed = last.totalTokens;
    }
    if (typeof tokenUsage.modelContextWindow === "number" && tokenUsage.modelContextWindow > 0) {
      state.contextWindow = tokenUsage.modelContextWindow;
    }
  }

  consumeTurnUsage(threadId: string): TurnUsage | undefined {
    const state = this.threads.get(threadId);
    if (!state) return undefined;

    let turnTokens: TokenUsage | undefined;
    if (state.turnRawSum && state.turnRawSum.totalTokens > 0) {
      turnTokens = state.turnRawSum;
    } else if (state.lastTotal && state.turnBaselineTotal !== undefined) {
      const delta = subtractTokenUsage(state.lastTotal, state.turnBaselineTotal);
      if (delta.totalTokens > 0) {
        turnTokens = delta;
      }
    } else if (state.turnLastCallUsage && state.turnLastCallUsage.totalTokens > 0) {
      // First turn after resume without rawResponse/completed and without a pre-turn baseline:
      // use `last` instead of `total` so prior session history is not double-counted.
      turnTokens = state.turnLastCallUsage;
    }

    const contextUsedTokens = state.turnContextUsed ?? turnTokens?.totalTokens;
    const contextWindowTokens = state.contextWindow;

    // Advance baseline for the next turn on this thread.
    if (state.lastTotal) {
      state.turnBaselineTotal = state.lastTotal;
    }
    state.resumed = false;
    state.turnRawSum = undefined;
    state.turnLastCallUsage = undefined;
    state.turnContextUsed = undefined;

    if (!turnTokens) return undefined;
    return buildSingleTurnUsage(turnTokens, {
      primaryModel: state.model,
      provider: state.provider,
      contextUsedTokens,
      contextWindowTokens,
    });
  }

  deleteThread(threadId: string): void {
    this.threads.delete(threadId);
  }

  clear(): void {
    this.threads.clear();
  }
}
