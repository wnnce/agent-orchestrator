import type { RuntimeCapabilities } from "../runtime.ts";

/** Declared capabilities of the Claude Code runtime (Claude Agent SDK). */
export const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  steer: true,
  interrupt: true,
  compaction: true,
  approvals: true,
  mcp: true,
  structuredOutput: true,
  sandbox: false,
};
