import { z } from "zod";
import type { ActionContext, ActionDefinition } from "../types.ts";

export const dispatchAgentTaskSchema = z.object({
  title: z
    .string()
    .min(1, "title is required")
    .describe("Title of the dispatched task session (e.g. 'Fix Issue #105: ...')"),
  prompt: z
    .string()
    .min(1, "prompt is required")
    .describe("Initial prompt/instruction for the dispatched Agent session"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional metadata payload (e.g. issue_id, source task)"),
});

export type DispatchAgentTaskParams = z.infer<typeof dispatchAgentTaskSchema>;

export interface DispatchAgentTaskResult {
  readonly success: boolean;
  readonly sessionId: string;
  readonly turnId?: string | undefined;
  readonly title: string;
}

export const dispatchAgentTaskAction: ActionDefinition<
  DispatchAgentTaskParams,
  DispatchAgentTaskResult
> = {
  name: "dispatch_agent_task",
  description:
    "Dispatch a new independent development/fix session in the current project, creating an isolated workspace and launching the first turn.",
  parameters: dispatchAgentTaskSchema,
  scopes: ["all"],
  async handler(
    params: DispatchAgentTaskParams,
    context: ActionContext,
  ): Promise<DispatchAgentTaskResult> {
    const result = await context.dispatchTask({
      title: params.title,
      prompt: params.prompt,
      metadata: params.metadata,
    });
    return {
      success: true,
      sessionId: result.sessionId,
      ...(result.turnId ? { turnId: result.turnId } : {}),
      title: params.title,
    };
  },
};
