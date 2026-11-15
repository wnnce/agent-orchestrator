import { z } from "zod";
import type { ActionContext, ActionDefinition } from "../types.ts";
import type { TaskEngine } from "../../task/engine.ts";

export const updateTaskStateSchema = z.object({
  state: z
    .record(z.string(), z.unknown())
    .describe("The incremental key-value state to update for the current task"),
  merge: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Whether to merge with existing state (default: true). If false, replaces entire state.",
    ),
});

export type UpdateTaskStateParams = z.infer<typeof updateTaskStateSchema>;

export interface UpdateTaskStateResult {
  readonly success: boolean;
  readonly taskKey: string;
  readonly state: Record<string, unknown>;
}

export function createUpdateTaskStateAction(
  engine?: TaskEngine,
): ActionDefinition<UpdateTaskStateParams, UpdateTaskStateResult> {
  return {
    name: "update_task_state",
    description:
      "Update persistent incremental state/cursor for the current task. Subsequent executions of this task will receive this updated state.",
    parameters: updateTaskStateSchema,
    scopes: ["task"],
    async handler(
      params: UpdateTaskStateParams,
      context: ActionContext,
    ): Promise<UpdateTaskStateResult> {
      if (!context.taskKey) {
        throw new Error(
          "update_task_state can only be invoked within a task execution context (taskKey is missing)",
        );
      }

      if (engine) {
        let newState: Record<string, unknown>;
        if (params.merge) {
          const existing = await engine.getState(context.taskKey);
          newState = { ...existing, ...params.state };
        } else {
          newState = params.state;
        }
        engine.updateState(context.taskKey, newState);
        return {
          success: true,
          taskKey: context.taskKey,
          state: newState,
        };
      }

      const state = await context.updateTaskState(params.state, { merge: params.merge });
      return {
        success: true,
        taskKey: context.taskKey,
        state,
      };
    },
  };
}

export const updateTaskStateAction: ActionDefinition<
  UpdateTaskStateParams,
  UpdateTaskStateResult
> = createUpdateTaskStateAction();
