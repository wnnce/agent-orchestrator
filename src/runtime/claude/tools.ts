import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionTools } from "../../tools/types.ts";
import { TOOL_SERVER_NAME } from "./options.ts";

/**
 * Exposes the session's orchestrator tools to Claude Code as an in-process MCP server; Claude
 * sees them as `mcp__orchestrator__<tool>`. Returns undefined when there is nothing to expose.
 * Calls go to `current()`, the tools of the session's latest context.
 */
export function createToolServer(
  tools: SessionTools,
  current: () => SessionTools | undefined = () => tools,
): McpSdkServerConfigWithInstance | undefined {
  if (tools.specs.length === 0) return undefined;
  return createSdkMcpServer({
    name: TOOL_SERVER_NAME,
    tools: tools.specs.map((spec) =>
      tool(spec.name, spec.description, spec.input.shape, async (args) => {
        const result = await (current() ?? tools).call(spec.name, args);
        return { content: [{ type: "text", text: result.text }], isError: !result.ok };
      }),
    ),
  });
}
