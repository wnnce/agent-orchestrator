export * from "./task-state.ts";
export * from "./notify.ts";
export * from "./artifact.ts";
export * from "./scheduled-job.ts";
export * from "./dispatch-task.ts";

import { updateTaskStateAction } from "./task-state.ts";
import { sendNotificationAction } from "./notify.ts";
import { createArtifactAction } from "./artifact.ts";
import { scheduleJobAction, cancelJobAction } from "./scheduled-job.ts";
import { dispatchAgentTaskAction } from "./dispatch-task.ts";
import type { ActionDefinition } from "../types.ts";

/**
 * Built-in core actions.
 */
export const builtinActions: readonly ActionDefinition<unknown, unknown>[] = [
  updateTaskStateAction as ActionDefinition<unknown, unknown>,
  sendNotificationAction as ActionDefinition<unknown, unknown>,
  createArtifactAction as ActionDefinition<unknown, unknown>,
  scheduleJobAction as ActionDefinition<unknown, unknown>,
  cancelJobAction as ActionDefinition<unknown, unknown>,
  dispatchAgentTaskAction as ActionDefinition<unknown, unknown>,
];
