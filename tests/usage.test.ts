import { describe, expect, test } from "bun:test";
import type { SDKAssistantMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { extractACPActiveModel, normalizeACPPromptUsage } from "../src/runtime/acp/usage.ts";
import { ClaudeUsageTracker } from "../src/runtime/claude/usage.ts";
import { CodexUsageTracker, normalizeCodexBreakdown } from "../src/runtime/codex/usage.ts";
import {
  addTokenUsage,
  buildSingleTurnUsage,
  buildTurnUsage,
  isTurnUsage,
  normalizeTokenUsage,
  subtractTokenUsage,
} from "../src/runtime/usage.ts";

describe("shared canonical token usage utilities", () => {
  test("normalizes exclusive and inclusive inputs while preserving totalTokens invariant", () => {
    const exclusive = normalizeTokenUsage({
      inputTokens: 1500,
      cacheReadTokens: 8000,
      cacheWriteTokens: 500,
      outputTokens: 300,
      reasoningTokens: 120,
      inputIncludesCache: false,
    });
    expect(exclusive).toEqual({
      inputTokens: 1500,
      cacheReadTokens: 8000,
      cacheWriteTokens: 500,
      outputTokens: 300,
      reasoningTokens: 120,
      totalTokens: 10300,
    });

    const inclusive = normalizeTokenUsage({
      inputTokens: 10000,
      cacheReadTokens: 8000,
      cacheWriteTokens: 500,
      outputTokens: 300,
      reasoningTokens: 120,
      inputIncludesCache: true,
    });
    expect(inclusive).toEqual(exclusive);
  });

  test("clamps invalid/negative token counts and merges multi-model entries", () => {
    const clamped = normalizeTokenUsage({
      inputTokens: -50,
      cacheReadTokens: Number.NaN,
      outputTokens: 12.9,
      inputIncludesCache: true,
    });
    expect(clamped).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 12,
      reasoningTokens: 0,
      totalTokens: 12,
    });

    const turnUsage = buildTurnUsage(
      [
        {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          ...normalizeTokenUsage({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 }),
        },
        {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          ...normalizeTokenUsage({ inputTokens: 200, cacheReadTokens: 1100, outputTokens: 70 }),
        },
        {
          model: "claude-haiku-4-5",
          provider: "anthropic",
          ...normalizeTokenUsage({ inputTokens: 80, outputTokens: 20 }),
        },
      ],
      { contextUsedTokens: 1370, contextWindowTokens: 200000 },
    );

    expect(turnUsage).toEqual({
      model: "claude-sonnet-4-6",
      inputTokens: 380,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
      outputTokens: 140,
      reasoningTokens: 0,
      totalTokens: 2520,
      byModel: [
        {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          inputTokens: 300,
          cacheReadTokens: 2000,
          cacheWriteTokens: 0,
          outputTokens: 120,
          reasoningTokens: 0,
          totalTokens: 2420,
        },
        {
          model: "claude-haiku-4-5",
          provider: "anthropic",
          inputTokens: 80,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
          totalTokens: 100,
        },
      ],
      contextUsedTokens: 1370,
      contextWindowTokens: 200000,
    });

    expect(isTurnUsage(turnUsage)).toBe(true);
    expect(isTurnUsage({ inputTokens: 1 })).toBe(false);
    expect(buildTurnUsage([])).toBeUndefined();
    expect(buildSingleTurnUsage(normalizeTokenUsage({ inputTokens: 0, outputTokens: 0 }))).toBeUndefined();
    expect(addTokenUsage(clamped, clamped).totalTokens).toBe(24);
    expect(subtractTokenUsage(clamped, addTokenUsage(clamped, clamped)).totalTokens).toBe(0);
  });
});

describe("CodexUsageTracker", () => {
  test("sums rawResponse/completed per-call usages with inclusive cache conversion and tracks context window", () => {
    const tracker = new CodexUsageTracker();
    tracker.initThread("thr_1", { model: "gpt-5.4", provider: "openai", resumed: false });
    tracker.onTurnStarted("thr_1");

    // Step 1: tool call
    tracker.onRawResponseCompleted("thr_1", {
      totalTokens: 1100,
      inputTokens: 1000,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 40,
    });
    // Step 2: final answer
    tracker.onRawResponseCompleted("thr_1", {
      totalTokens: 1450,
      inputTokens: 1300,
      cachedInputTokens: 1000,
      cacheWriteInputTokens: 0,
      outputTokens: 150,
      reasoningOutputTokens: 50,
    });
    tracker.onThreadTokenUsageUpdated("thr_1", {
      total: {
        totalTokens: 2550,
        inputTokens: 2300,
        cachedInputTokens: 1600,
        cacheWriteInputTokens: 0,
        outputTokens: 250,
        reasoningOutputTokens: 90,
      },
      last: {
        totalTokens: 1450,
        inputTokens: 1300,
        cachedInputTokens: 1000,
        cacheWriteInputTokens: 0,
        outputTokens: 150,
        reasoningOutputTokens: 50,
      },
      modelContextWindow: 258000,
    });

    const usage = tracker.consumeTurnUsage("thr_1");
    expect(usage).toEqual({
      model: "gpt-5.4",
      inputTokens: 700,
      cacheReadTokens: 1600,
      cacheWriteTokens: 0,
      outputTokens: 250,
      reasoningTokens: 90,
      totalTokens: 2550,
      byModel: [
        {
          model: "gpt-5.4",
          provider: "openai",
          inputTokens: 700,
          cacheReadTokens: 1600,
          cacheWriteTokens: 0,
          outputTokens: 250,
          reasoningTokens: 90,
          totalTokens: 2550,
        },
      ],
      contextUsedTokens: 1450,
      contextWindowTokens: 258000,
    });

    expect(
      normalizeCodexBreakdown({
        totalTokens: 500,
        inputTokens: 400,
        cachedInputTokens: 300,
        cacheWriteInputTokens: 50,
        outputTokens: 100,
        reasoningOutputTokens: 20,
      }),
    ).toEqual({
      inputTokens: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 500,
    });
  });

  test("falls back to last call usage on first resumed turn without rawResponse/completed to avoid history double-counting", () => {
    const tracker = new CodexUsageTracker();
    tracker.initThread("thr_resumed", { model: "gpt-5.4", provider: "openai", resumed: true });
    tracker.onTurnStarted("thr_resumed");

    // Cumulative total includes 50,000 tokens from prior session history, while last is only this turn
    tracker.onThreadTokenUsageUpdated("thr_resumed", {
      total: {
        totalTokens: 51200,
        inputTokens: 50000,
        cachedInputTokens: 40000,
        cacheWriteInputTokens: 0,
        outputTokens: 1200,
        reasoningOutputTokens: 300,
      },
      last: {
        totalTokens: 1200,
        inputTokens: 1000,
        cachedInputTokens: 800,
        cacheWriteInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 60,
      },
      modelContextWindow: 258000,
    });

    const firstTurn = tracker.consumeTurnUsage("thr_resumed");
    expect(firstTurn).toMatchObject({
      model: "gpt-5.4",
      inputTokens: 200,
      cacheReadTokens: 800,
      outputTokens: 200,
      reasoningTokens: 60,
      totalTokens: 1200,
      contextUsedTokens: 1200,
      contextWindowTokens: 258000,
    });

    // Second turn after baseline is established diffs `total` accurately across multi-step calls
    tracker.onModelRerouted("thr_resumed", "gpt-5.4-mini");
    tracker.onTurnStarted("thr_resumed");
    tracker.onThreadTokenUsageUpdated("thr_resumed", {
      total: {
        totalTokens: 53200,
        inputTokens: 51700,
        cachedInputTokens: 41200,
        cacheWriteInputTokens: 0,
        outputTokens: 1500,
        reasoningOutputTokens: 380,
      },
      last: {
        totalTokens: 900,
        inputTokens: 750,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 0,
        outputTokens: 150,
        reasoningOutputTokens: 40,
      },
      modelContextWindow: 258000,
    });

    const secondTurn = tracker.consumeTurnUsage("thr_resumed");
    expect(secondTurn).toMatchObject({
      model: "gpt-5.4-mini",
      inputTokens: 500,
      cacheReadTokens: 1200,
      outputTokens: 300,
      reasoningTokens: 80,
      totalTokens: 2000,
      contextUsedTokens: 900,
      contextWindowTokens: 258000,
    });
  });
});

describe("ClaudeUsageTracker", () => {
  test("diffs cumulative modelUsage across turns and captures subagent models", () => {
    const tracker = new ClaudeUsageTracker(false);
    tracker.onSystemInit("claude-sonnet-4-6");

    tracker.onAssistantMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6",
        content: [],
        usage: {
          input_tokens: 400,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 300,
          output_tokens: 150,
        },
      },
    } as unknown as SDKAssistantMessage);

    tracker.recordResult({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 400,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 300,
        output_tokens: 150,
      },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 400,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 300,
          outputTokens: 150,
          contextWindow: 200000,
        },
        "claude-haiku-4-5": {
          inputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 50,
          contextWindow: 200000,
        },
      },
    } as unknown as SDKResultMessage);

    const turn1 = tracker.consumeTurnUsage();
    expect(turn1).toMatchObject({
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 300,
      outputTokens: 200,
      totalTokens: 3000,
      contextUsedTokens: 2850,
      contextWindowTokens: 200000,
    });
    expect(turn1?.byModel).toHaveLength(2);

    // Turn 2: cumulative modelUsage grows by +300 input, +2500 cacheRead, +100 output
    tracker.onAssistantMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_2",
        model: "claude-sonnet-4-6",
        content: [],
        usage: {
          input_tokens: 300,
          cache_read_input_tokens: 2500,
          cache_creation_input_tokens: 0,
          output_tokens: 100,
        },
      },
    } as unknown as SDKAssistantMessage);

    tracker.recordResult({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 300,
        cache_read_input_tokens: 2500,
        cache_creation_input_tokens: 0,
        output_tokens: 100,
      },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 700,
          cacheReadInputTokens: 4500,
          cacheCreationInputTokens: 300,
          outputTokens: 250,
          contextWindow: 200000,
        },
        "claude-haiku-4-5": {
          inputTokens: 100,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 50,
          contextWindow: 200000,
        },
      },
    } as unknown as SDKResultMessage);

    const turn2 = tracker.consumeTurnUsage();
    expect(turn2).toMatchObject({
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      cacheReadTokens: 2500,
      cacheWriteTokens: 0,
      outputTokens: 100,
      totalTokens: 2900,
      contextUsedTokens: 2900,
      contextWindowTokens: 200000,
    });
    expect(turn2?.byModel).toHaveLength(1);
  });

  test("anchors baseline on first turn after resume using strict per-turn usage without double-counting history", () => {
    const tracker = new ClaudeUsageTracker(true);
    tracker.onSystemInit("claude-opus-4-6");

    // Resumed session: modelUsage already carries 80,000 prior tokens; result.usage is strictly this turn
    tracker.recordResult({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 250,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 100,
        output_tokens: 150,
      },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 10250,
          cacheReadInputTokens: 75000,
          cacheCreationInputTokens: 2100,
          outputTokens: 3150,
          contextWindow: 1000000,
        },
      },
    } as unknown as SDKResultMessage);

    const resumedTurn1 = tracker.consumeTurnUsage();
    expect(resumedTurn1).toMatchObject({
      model: "claude-opus-4-6",
      inputTokens: 250,
      cacheReadTokens: 5000,
      cacheWriteTokens: 100,
      outputTokens: 150,
      totalTokens: 5500,
      contextWindowTokens: 1000000,
    });

    // Compaction runs between turns: syncBaseline absorbs compaction tokens
    tracker.syncBaseline({
      type: "result",
      subtype: "success",
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 11250,
          cacheReadInputTokens: 75000,
          cacheCreationInputTokens: 2100,
          outputTokens: 3650,
          contextWindow: 1000000,
        },
      },
    } as unknown as SDKResultMessage);

    // Next user turn should only diff against post-compaction baseline
    tracker.recordResult({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 0,
        output_tokens: 80,
      },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 11370,
          cacheReadInputTokens: 75900,
          cacheCreationInputTokens: 2100,
          outputTokens: 3730,
          contextWindow: 1000000,
        },
      },
    } as unknown as SDKResultMessage);

    const resumedTurn2 = tracker.consumeTurnUsage();
    expect(resumedTurn2).toMatchObject({
      model: "claude-opus-4-6",
      inputTokens: 120,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      outputTokens: 80,
      totalTokens: 1100,
    });
  });
});

describe("ACP usage normalization", () => {
  test("normalizes exclusive agy PromptResponse.usage and inclusive ACP agent usage accurately", () => {
    // Verified agy shape: inputTokens (15709) + cachedReadTokens (11432) + outputTokens (124) === 27265
    const agyUsage = normalizeACPPromptUsage(
      {
        inputTokens: 15709,
        outputTokens: 124,
        cachedReadTokens: 11432,
        cachedWriteTokens: 0,
        thoughtTokens: 109,
        totalTokens: 27265,
      },
      {
        model: "gemini-4-neon",
        provider: "agy",
        contextUsedTokens: 27265,
        contextWindowTokens: 1048576,
      },
    );

    expect(agyUsage).toEqual({
      model: "gemini-4-neon",
      inputTokens: 15709,
      cacheReadTokens: 11432,
      cacheWriteTokens: 0,
      outputTokens: 124,
      reasoningTokens: 109,
      totalTokens: 27265,
      byModel: [
        {
          model: "gemini-4-neon",
          provider: "agy",
          inputTokens: 15709,
          cacheReadTokens: 11432,
          cacheWriteTokens: 0,
          outputTokens: 124,
          reasoningTokens: 109,
          totalTokens: 27265,
        },
      ],
      contextUsedTokens: 27265,
      contextWindowTokens: 1048576,
    });

    // Inclusive ACP agent shape: inputTokens (20000) includes cachedReadTokens (12000), total = 20500
    const inclusiveUsage = normalizeACPPromptUsage(
      {
        inputTokens: 20000,
        outputTokens: 500,
        cachedReadTokens: 12000,
        cachedWriteTokens: 0,
        thoughtTokens: 0,
        totalTokens: 20500,
      },
      { model: "acp-other-model", provider: "other-acp" },
    );

    expect(inclusiveUsage).toMatchObject({
      model: "acp-other-model",
      inputTokens: 8000,
      cacheReadTokens: 12000,
      outputTokens: 500,
      totalTokens: 20500,
    });
  });

  test("extracts active model id from ACP configOptions and models fallback", () => {
    const configOptions: SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gemini-4-neon",
        options: [],
      },
    ];
    expect(extractACPActiveModel(configOptions)).toBe("gemini-4-neon");
    expect(extractACPActiveModel(undefined, { currentModelId: "fallback-model" })).toBe(
      "fallback-model",
    );
  });
});
