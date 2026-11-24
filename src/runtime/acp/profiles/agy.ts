import { RequestError } from "@agentclientprotocol/sdk";
import type { RuntimeCapabilities } from "../../runtime.ts";
import type { ACPProfile } from "../profile.ts";

/** Declared capabilities of the Antigravity (`agy acp`) runtime adapter. */
export const AGY_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  steer: false,
  interrupt: true,
  compaction: true,
  approvals: true,
  mcp: true,
  structuredOutput: false,
  sandbox: false,
};

function isAgySessionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (
    message.includes("failed to read session") ||
    message.includes("session not found") ||
    message.includes("unknown session")
  ) {
    return true;
  }
  if (error instanceof RequestError) {
    // ACP Resource not found (-32002) or agy internal missing-session error (-32603)
    return error.code === -32002 || (error.code === -32603 && message.includes("session"));
  }
  return false;
}

/** Antigravity CLI (`agy acp`) profile for `ACPRuntime`. */
export const AGY_PROFILE: ACPProfile = {
  name: "agy",
  type: "agy",
  description: "Antigravity CLI runtime adapter (ACP stdio server)",
  capabilities: AGY_CAPABILITIES,
  defaultReasoningEfforts: ["low", "medium", "high"],
  readOnlyModeId: "plan",
  injectSkillsViaAdditionalDirectories: true,
  compactCommand: "/compact",
  buildCommand: () => ({
    command: ["agy", "acp", "--stdio", "--process-per-session"],
  }),
  isSessionNotFoundError: isAgySessionNotFoundError,
};
