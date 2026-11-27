import { z } from "zod";
import { defineTool } from "../types.ts";

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

export const updateTaskStateTool = defineTool({
  name: "update_task_state",
  description:
    "Update persistent incremental state/cursor for the current task. Subsequent executions of this task will receive this updated state.",
  input: updateTaskStateSchema,
  when: (site) => site.owner?.kind === "task",
  async run(input, ctx) {
    if (ctx.owner?.kind !== "task") throw new Error("this session does not run a task");
    if (input.merge) ctx.owner.state.merge(input.state);
    else ctx.owner.state.set(input.state);
    return { success: true, taskId: ctx.owner.taskId, state: ctx.owner.state.get() };
  },
});
