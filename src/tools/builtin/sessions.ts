import { z } from "zod";
import { defineTool, type ToolSite } from "../types.ts";

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

export const dispatchAgentTaskTool = defineTool({
  name: "dispatch_agent_task",
  description:
    "Dispatch a new independent development/fix session in the current project, creating an isolated workspace and launching the first turn.",
  input: dispatchAgentTaskSchema,
  async run(input, ctx) {
    const started = await ctx.sessions.start({
      title: input.title,
      prompt: input.prompt,
      metadata: input.metadata,
    });
    return { success: true, ...started, title: input.title };
  },
});

export const scheduleJobSchema = z.object({
  name: z.string().describe("Unique identifier or name for this scheduled reminder"),
  delay_minutes: z
    .number()
    .int()
    .min(1)
    .describe("Number of minutes to delay before waking up the session (e.g. 5, 10, 60)"),
  prompt: z.string().describe("Prompt message to wake up the session and instruct the agent"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arbitrary key-value metadata to attach to the scheduled job"),
});

export const cancelJobSchema = z.object({
  name: z.string().describe("Name of the scheduled reminder to cancel"),
});

/** Wake-ups belong to conversations; task and pipeline sessions end with their work. */
const isConversation = (site: ToolSite): boolean => site.owner === undefined;

export const scheduleJobTool = defineTool({
  name: "schedule_job",
  description:
    "Schedule a delayed reminder/wakeup for the current conversation session. Triggers a new turn in this session after delay_minutes.",
  input: scheduleJobSchema,
  when: isConversation,
  async run(input, ctx) {
    const job = await ctx.session.schedule({
      name: input.name,
      delayMinutes: input.delay_minutes,
      prompt: input.prompt,
      metadata: input.metadata,
    });
    return {
      success: true,
      jobId: job.jobId,
      name: job.name,
      delayMinutes: job.delayMinutes,
      triggerAt: job.triggerAt,
    };
  },
});

export const cancelJobTool = defineTool({
  name: "cancel_job",
  description: "Cancel a previously scheduled delayed reminder for the current session.",
  input: cancelJobSchema,
  when: isConversation,
  async run(input, ctx) {
    return { success: await ctx.session.cancelSchedule(input.name), name: input.name };
  },
});
