import type {
  ModelUsage,
  SDKAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelTokenUsage, TokenUsage, TurnUsage } from "../../domain/types.ts";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  buildSingleTurnUsage,
  buildTurnUsage,
  clampTokenCount,
  normalizeTokenUsage,
  subtractTokenUsage,
} from "../usage.ts";

interface RawAnthropicUsage {
  input_tokens?: number | null | undefined;
  output_tokens?: number | null | undefined;
  cache_read_input_tokens?: number | null | undefined;
  cache_creation_input_tokens?: number | null | undefined;
  thinking_tokens?: number | null | undefined;
}

function normalizeAnthropicUsage(raw: RawAnthropicUsage | null | undefined): TokenUsage {
  if (!raw) return ZERO_TOKEN_USAGE;
  return normalizeTokenUsage({
    inputTokens: raw.input_tokens,
    cacheReadTokens: raw.cache_read_input_tokens,
    cacheWriteTokens: raw.cache_creation_input_tokens,
    outputTokens: raw.output_tokens,
    reasoningTokens: raw.thinking_tokens,
    inputIncludesCache: false,
  });
}

function normalizeClaudeModelUsage(raw: ModelUsage): TokenUsage {
  const extended = raw as ModelUsage & { thinkingTokens?: number | null | undefined };
  return normalizeTokenUsage({
    inputTokens: raw.inputTokens,
    cacheReadTokens: raw.cacheReadInputTokens,
    cacheWriteTokens: raw.cacheCreationInputTokens,
    outputTokens: raw.outputTokens,
    reasoningTokens: extended.thinkingTokens,
    inputIncludesCache: false,
  });
}

function snapshotModelUsage(modelUsage: Record<string, ModelUsage>): Map<string, TokenUsage> {
  const map = new Map<string, TokenUsage>();
  for (const [model, usage] of Object.entries(modelUsage)) {
    map.set(model, normalizeClaudeModelUsage(usage));
  }
  return map;
}

/**
 * Tracks per-turn token & cache usage for a long-lived streaming-input `ClaudeSession`.
 *
 * Per `@anthropic-ai/claude-agent-sdk`:
 * - `result.modelUsage` is cumulative across turns in streaming-input mode, and on a resumed
 *   session the first result already contains prior transcript totals.
 * - `result.usage` is strictly per-turn (main loop only).
 *
 * Strategy:
 * - On fresh sessions (or once a baseline is established), diff `result.modelUsage` against
 *   the previous snapshot to capture main + subagent/sidechain per-model usage accurately.
 * - On the very first result of a resumed session (no baseline yet), store `result.modelUsage`
 *   as the baseline and report per-turn `result.usage` so prior history is never double-counted.
 */
export class ClaudeUsageTracker {
  private prevModelUsage: Map<string, TokenUsage> | undefined;
  private sessionModel: string | undefined;
  private contextWindowTokens: number | undefined;
  private turnEntries: ModelTokenUsage[] = [];
  private turnUnattributed: TokenUsage = ZERO_TOKEN_USAGE;
  private turnLastContextUsed: number | undefined;

  constructor(private readonly resumed: boolean) {}

  onSystemInit(model: string | undefined): void {
    if (model?.trim()) {
      this.sessionModel = model.trim();
    }
  }

  onAssistantMessage(message: SDKAssistantMessage): void {
    if (message.parent_tool_use_id) return;
    const inner = message.message as {
      model?: unknown;
      usage?: RawAnthropicUsage | null | undefined;
    };
    if (typeof inner.model === "string" && inner.model.trim()) {
      this.sessionModel = inner.model.trim();
    }
    if (inner.usage) {
      const step = normalizeAnthropicUsage(inner.usage);
      if (step.totalTokens > 0) {
        this.turnLastContextUsed = step.totalTokens;
      }
    }
  }

  /**
   * Advances the cumulative `modelUsage` baseline after non-turn operations such as `/compact`
   * so compaction tokens do not leak into the next user turn's delta.
   */
  syncBaseline(result: SDKResultMessage): void {
    const modelUsage = result.modelUsage;
    if (modelUsage && Object.keys(modelUsage).length > 0) {
      this.prevModelUsage = snapshotModelUsage(modelUsage);
      this.updateContextWindow(modelUsage);
    }
  }

  /** Records usage from one `SDKResultMessage` answering part or all of the current turn. */
  recordResult(result: SDKResultMessage): void {
    const modelUsage = result.modelUsage;
    const hasModelUsage = !!modelUsage && Object.keys(modelUsage).length > 0;
    const perTurnUsage = normalizeAnthropicUsage(result.usage as RawAnthropicUsage | undefined);

    if (hasModelUsage) {
      this.updateContextWindow(modelUsage);
      const currentSnapshot = snapshotModelUsage(modelUsage);
      const primaryFromMap = this.pickPrimaryModel(modelUsage);

      if (this.resumed && !this.prevModelUsage) {
        // First result after resume: anchor cumulative baseline and use strict per-turn `result.usage`.
        this.prevModelUsage = currentSnapshot;
        if (perTurnUsage.totalTokens > 0) {
          if (primaryFromMap) {
            this.turnEntries.push({ model: primaryFromMap, provider: "anthropic", ...perTurnUsage });
          } else {
            this.turnUnattributed = addTokenUsage(this.turnUnattributed, perTurnUsage);
          }
        }
        return;
      }

      const prev = this.prevModelUsage;
      this.prevModelUsage = currentSnapshot;
      let addedFromDiff = false;
      for (const [model, curr] of currentSnapshot) {
        const delta = subtractTokenUsage(curr, prev?.get(model));
        if (delta.totalTokens > 0 || delta.reasoningTokens > 0) {
          this.turnEntries.push({ model, provider: "anthropic", ...delta });
          addedFromDiff = true;
        }
      }

      if (!addedFromDiff && perTurnUsage.totalTokens > 0) {
        if (primaryFromMap) {
          this.turnEntries.push({ model: primaryFromMap, provider: "anthropic", ...perTurnUsage });
        } else {
          this.turnUnattributed = addTokenUsage(this.turnUnattributed, perTurnUsage);
        }
      }
      return;
    }

    if (perTurnUsage.totalTokens > 0) {
      if (this.sessionModel) {
        this.turnEntries.push({
          model: this.sessionModel,
          provider: "anthropic",
          ...perTurnUsage,
        });
      } else {
        this.turnUnattributed = addTokenUsage(this.turnUnattributed, perTurnUsage);
      }
    }
  }

  /** Finalizes and resets per-turn accumulators. */
  consumeTurnUsage(): TurnUsage | undefined {
    const entries = this.turnEntries;
    const unattributed = this.turnUnattributed;
    const contextUsedTokens = this.turnLastContextUsed;
    const contextWindowTokens = this.contextWindowTokens;

    this.turnEntries = [];
    this.turnUnattributed = ZERO_TOKEN_USAGE;
    this.turnLastContextUsed = undefined;

    if (entries.length > 0) {
      return buildTurnUsage(entries, {
        primaryModel: this.sessionModel,
        contextUsedTokens,
        contextWindowTokens,
      });
    }
    if (unattributed.totalTokens > 0) {
      return buildSingleTurnUsage(unattributed, {
        primaryModel: this.sessionModel,
        provider: "anthropic",
        contextUsedTokens,
        contextWindowTokens,
      });
    }
    return undefined;
  }

  private pickPrimaryModel(modelUsage: Record<string, ModelUsage>): string | undefined {
    if (this.sessionModel && this.sessionModel in modelUsage) {
      return this.sessionModel;
    }
    return this.sessionModel ?? Object.keys(modelUsage)[0];
  }

  private updateContextWindow(modelUsage: Record<string, ModelUsage>): void {
    const primary = this.pickPrimaryModel(modelUsage);
    const preferred = primary ? modelUsage[primary] : undefined;
    const windowSize = clampTokenCount(preferred?.contextWindow);
    if (windowSize > 0) {
      this.contextWindowTokens = windowSize;
      return;
    }
    for (const usage of Object.values(modelUsage)) {
      const candidate = clampTokenCount(usage.contextWindow);
      if (candidate > 0) {
        this.contextWindowTokens = candidate;
        return;
      }
    }
  }
}
