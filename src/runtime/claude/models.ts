import type { RuntimeModelOption } from "../models.ts";

/** Built-in selectable models exposed by the Claude Code runtime adapter. */
export const BUILTIN_CLAUDE_MODELS: readonly RuntimeModelOption[] = [
  {
    id: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    contextWindow: 1_000_000,
  },
  {
    id: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    contextWindow: 1_000_000,
  },
  {
    id: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "low",
    contextWindow: 200_000,
  },
];

export function listClaudeModels(): readonly RuntimeModelOption[] {
  return BUILTIN_CLAUDE_MODELS;
}
