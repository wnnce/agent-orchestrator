import type { RuntimeCapabilities } from "../runtime.ts";

/**
 * Declared capabilities of the Pi Agent in-process TypeScript SDK runtime.
 */
export const PI_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  resume: true,
  steer: true,
  interrupt: true,
  compaction: true,
  approvals: false,
  mcp: true,
  structuredOutput: true,
  sandbox: true,
};
