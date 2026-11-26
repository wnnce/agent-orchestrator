import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ActionRegistry } from "../../actions/registry.ts";
import {
  type ActionCallSite,
  actionContextFor,
  actionResultText,
  actionToJsonSchema,
  resolveActionsForSite,
} from "../action-bridge.ts";

export { actionToJsonSchema };

/** Reads the session's current call site when a tool runs. */
export type ActionBridgeContextGetter = () => ActionCallSite;

/**
 * Bridges Agent Orchestrator ActionRegistry actions into native Pi ToolDefinitions.
 */
export function bridgeActionsToPiTools(
  actionRegistry: ActionRegistry,
  getContext: ActionBridgeContextGetter,
): ToolDefinition[] {
  const initialSite = getContext();
  const actions = resolveActionsForSite(actionRegistry, initialSite);

  return actions.map((action) => {
    const jsonSchema = actionToJsonSchema(action.parameters);

    return {
      name: action.name,
      label: action.name,
      description: action.description,
      // Pi accepts plain JSON Schema here; its type expects a TypeBox schema object.
      parameters: jsonSchema as unknown as ToolDefinition["parameters"],
      execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
        const site = getContext();
        const actionContext = actionContextFor(site, signal);
        const result = await actionRegistry.execute(action.name, params, actionContext, {
          parameterOverride: site.actionParameterOverrides?.[action.name],
        });
        return {
          content: [{ type: "text" as const, text: actionResultText(result) }],
          isError: !result.success,
          details: result.success ? result.data : { error: result.error },
        };
      },
    };
  });
}
