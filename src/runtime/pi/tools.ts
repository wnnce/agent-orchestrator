import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ActionRegistry } from "../../actions/registry.ts";
import { createActionContext } from "../../actions/context.ts";
import type { ProjectConfig } from "../../domain/types.ts";
import type { RuntimeContext } from "../runtime.ts";

/**
 * Accessor providing current dynamic execution context for tool invocations.
 */
export type ActionBridgeContextGetter = () => {
  project: ProjectConfig;
  workspacePath: string;
  sessionId: string;
  currentTurnId?: string | undefined;
  taskKey?: string | undefined;
  createActionContext?: RuntimeContext["createActionContext"] | undefined;
};

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
  const ctx = getContext();
  const scope = ctx.taskKey ? "task" : "conversation";
  const actions = actionRegistry.list(scope);

  return actions.map((action) => {
    const jsonSchema = actionToJsonSchema(action.parameters);

    return {
      name: action.name,
      label: action.name,
      description: action.description,
      parameters: jsonSchema as any,
      execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
        const currentCtx = getContext();
        const actionContext = currentCtx.createActionContext
          ? currentCtx.createActionContext({
              turnId: currentCtx.currentTurnId,
              signal,
            })
          : createActionContext({
              projectId: currentCtx.project.id,
              sessionId: currentCtx.sessionId,
              turnId: currentCtx.currentTurnId,
              taskKey: currentCtx.taskKey,
              workspacePath: currentCtx.workspacePath,
              signal,
            });

        const result = await actionRegistry.execute(action.name, params, actionContext);
        const text = JSON.stringify(result.success ? (result.data ?? {}) : { error: result.error });

        return {
          content: [{ type: "text" as const, text }],
          isError: !result.success,
          details: result.success ? result.data : { error: result.error },
        };
      },
    };
  });
}
