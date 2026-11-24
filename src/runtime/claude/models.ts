import type { RuntimeModelOption } from "../models.ts";

/** Built-in selectable models exposed by the Claude Code runtime adapter. */
export const BUILTIN_CLAUDE_MODELS: readonly RuntimeModelOption[] = [
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    contextWindow: 1_000_000,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    contextWindow: 200_000,
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "low",
    contextWindow: 200_000,
  },
];

export function listClaudeModels(): readonly RuntimeModelOption[] {
  return BUILTIN_CLAUDE_MODELS;
}
