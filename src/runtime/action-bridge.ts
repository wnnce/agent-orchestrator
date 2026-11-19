import { createActionContext } from "../actions/context.ts";
import type { ActionContext, ActionResult, ActionScope } from "../actions/types.ts";
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
  createActionContext?: RuntimeContext["createActionContext"] | undefined;
  logger?: Logger | undefined;
}

/** Actions offered to an agent: task sessions and conversations see different sets. */
export function actionScopeFor(taskKey: string | undefined): ActionScope {
  return taskKey ? "task" : "conversation";
}

/** The ActionContext for one call, from the session's factory when it has one. */
export function actionContextFor(site: ActionCallSite, signal?: AbortSignal): ActionContext {
  if (site.createActionContext) return site.createActionContext({ turnId: site.turnId, signal });
  return createActionContext({
    projectId: site.project.id,
    sessionId: site.sessionId,
    turnId: site.turnId,
    taskKey: site.taskKey,
    workspacePath: site.workspacePath,
    logger: site.logger,
    signal,
  });
}

/** The text an agent sees as an action's result. */
export function actionResultText(result: ActionResult): string {
  return JSON.stringify(result.success ? (result.data ?? {}) : { error: result.error });
}
