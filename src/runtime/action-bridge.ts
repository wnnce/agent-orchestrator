import { z } from "zod";
import { createActionContext } from "../actions/context.ts";
import type { ActionRegistry } from "../actions/registry.ts";
import type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  ActionScope,
} from "../actions/types.ts";
import type { ProjectConfig } from "../domain/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { RuntimeContext } from "./runtime.ts";

/** Where an agent's call to an orchestrator action comes from. Shared by all runtime adapters. */
export interface ActionCallSite {
  project: ProjectConfig;
  workspacePath: string;
  sessionId: string;
  turnId?: string | undefined;
  taskKey?: string | undefined;
  actionScope?: ActionScope | undefined;
  actionParameterOverrides?: RuntimeContext["actionParameterOverrides"] | undefined;
  createActionContext?: RuntimeContext["createActionContext"] | undefined;
  logger?: Logger | undefined;
}

/** Actions offered to an agent: task, pipeline, and conversation sessions see different sets. */
export function actionScopeFor(
  taskKey: string | undefined,
  explicitScope?: ActionScope,
): ActionScope {
  if (explicitScope) return explicitScope;
  return taskKey ? "task" : "conversation";
}

/**
 * Lists actions available to `site`, applying any per-session parameter schema overrides
 * (such as a node-specific `pipeline_next` schema).
 */
export function resolveActionsForSite(
  actionRegistry: ActionRegistry,
  site: Pick<ActionCallSite, "taskKey" | "actionScope" | "actionParameterOverrides">,
): ActionDefinition<unknown, unknown>[] {
  const actions = actionRegistry.list(actionScopeFor(site.taskKey, site.actionScope));
  const overrides = site.actionParameterOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return actions;
  return actions.map((action) => {
    const override = overrides[action.name];
    return override ? { ...action, parameters: override } : action;
  });
}

/** The ActionContext for one call, from the session's factory when it has one. */
export function actionContextFor(site: ActionCallSite, signal?: AbortSignal): ActionContext {
  if (site.createActionContext) return site.createActionContext({ turnId: site.turnId, signal });
  return createActionContext({
    projectId: site.project.id,
    sessionId: site.sessionId,
    turnId: site.turnId,
    taskKey: site.taskKey,
    scope: actionScopeFor(site.taskKey, site.actionScope),
    workspacePath: site.workspacePath,
    logger: site.logger,
    signal,
  });
}

/** The text an agent sees as an action's result. */
export function actionResultText(result: ActionResult): string {
  return JSON.stringify(result.success ? (result.data ?? {}) : { error: result.error });
}

/** Converts a Zod or plain object parameter definition into standard JSON Schema. */
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
