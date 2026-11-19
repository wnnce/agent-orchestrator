import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ActionRegistry } from "../../actions/registry.ts";
import {
  type ActionCallSite,
  actionContextFor,
  actionResultText,
  actionScopeFor,
} from "../action-bridge.ts";

/** Reads the session's current call site when a tool runs. */
export type ActionBridgeContextGetter = () => ActionCallSite;

/**
 * Converts a Zod or raw object schema into standard JSON Schema suitable for Pi SDK.
 */
export function actionToJsonSchema(param: unknown): Record<string, unknown> {
  if (
    typeof param === "object" &&
    param !== null &&
    typeof (param as { safeParse?: unknown }).safeParse === "function"
  ) {
    const schema = z.toJSONSchema(param as z.ZodType) as Record<string, unknown>;
    const { $schema, ...clean } = schema;
    return clean;
  }
  if (typeof param === "object" && param !== null) {
    return param as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

/**
 * Bridges Agent Orchestrator ActionRegistry actions into native Pi ToolDefinitions.
 */
export function bridgeActionsToPiTools(
  actionRegistry: ActionRegistry,
  getContext: ActionBridgeContextGetter,
): ToolDefinition[] {
  const actions = actionRegistry.list(actionScopeFor(getContext().taskKey));

  return actions.map((action) => {
    const jsonSchema = actionToJsonSchema(action.parameters);

    return {
      name: action.name,
      label: action.name,
      description: action.description,
      // Pi accepts plain JSON Schema here; its type expects a TypeBox schema object.
      parameters: jsonSchema as unknown as ToolDefinition["parameters"],
      execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
        const actionContext = actionContextFor(getContext(), signal);
        const result = await actionRegistry.execute(action.name, params, actionContext);
        return {
          content: [{ type: "text" as const, text: actionResultText(result) }],
          isError: !result.success,
          details: result.success ? result.data : { error: result.error },
        };
      },
    };
  });
}
