import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ActionRegistry } from "../../actions/registry.ts";
import {
  type ActionCallSite,
  actionContextFor,
  actionResultText,
  actionScopeFor,
} from "../action-bridge.ts";
import { ACTION_SERVER_NAME } from "./options.ts";

/**
 * Exposes orchestrator actions to Claude Code as an in-process MCP server; Claude sees them as
 * `mcp__orchestrator__<action>`. Returns undefined when there is nothing to expose.
 */
export function createActionServer(
  actionRegistry: ActionRegistry,
  taskKey: string | undefined,
  getSite: () => ActionCallSite,
): McpSdkServerConfigWithInstance | undefined {
  const actions = actionRegistry.list(actionScopeFor(taskKey));
  if (actions.length === 0) return undefined;
  return createSdkMcpServer({
    name: ACTION_SERVER_NAME,
    tools: actions.map((action) =>
      tool(action.name, action.description, inputShape(action.parameters), async (args) => {
        const result = await actionRegistry.execute(action.name, args, actionContextFor(getSite()));
        return {
          content: [{ type: "text", text: actionResultText(result) }],
          isError: !result.success,
        };
      }),
    ),
  });
}

/**
 * The SDK describes tool inputs as a zod object shape. Actions declared with a plain JSON Schema
 * get an open shape; `ActionRegistry.execute` still validates their arguments.
 */
function inputShape(parameters: unknown): z.ZodRawShape {
  return parameters instanceof z.ZodObject ? parameters.shape : {};
}
