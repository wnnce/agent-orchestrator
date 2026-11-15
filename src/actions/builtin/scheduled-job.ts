import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionContext, ActionDefinition } from "../types.ts";
import {
  ScheduledJobStatus,
  type ScheduledJobRecord,
} from "../../domain/types.ts";
import type { Store } from "../../persistence/store.ts";

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

export type ScheduleJobParams = z.infer<typeof scheduleJobSchema>;

export interface ScheduleJobResult {
  readonly success: boolean;
  readonly jobId: string;
  readonly name: string;
  readonly delayMinutes: number;
  readonly triggerAt: string;
}

export const scheduleJobAction: ActionDefinition<
  ScheduleJobParams,
  ScheduleJobResult
> = {
  name: "schedule_job",
  description:
    "Schedule a delayed reminder/wakeup for the current conversation session. Triggers a new turn in this session after delay_minutes.",
  parameters: scheduleJobSchema,
  scopes: ["conversation"],
  async handler(
    params: ScheduleJobParams,
    context: ActionContext,
  ): Promise<ScheduleJobResult> {
    const store = context.requireService<Store>("store");
    const delayMs = params.delay_minutes * 60_000;
    const triggerAt = new Date(Date.now() + delayMs).toISOString();
    const jobId = `job_${randomUUID()}`;

    const job: ScheduledJobRecord = {
      jobId,
      projectId: context.projectId,
      sessionId: context.sessionId,
      name: params.name,
      createdAt: new Date().toISOString(),
      delayMinutes: params.delay_minutes,
      triggerAt,
      status: ScheduledJobStatus.PENDING,
      prompt: params.prompt,
      metadata: {
        ...(params.metadata ?? {}),
        ...(context.turnId ? { createdTurnId: context.turnId } : {}),
      },
    };

    await store.createScheduledJob(job);
    context.logger.info("scheduled job created for session", {
      jobId,
      sessionId: context.sessionId,
      name: params.name,
      delayMinutes: params.delay_minutes,
      triggerAt,
    });

    return {
      success: true,
      jobId,
      name: params.name,
      delayMinutes: params.delay_minutes,
      triggerAt,
    };
  },
};

export const cancelJobSchema = z.object({
  name: z.string().describe("Name of the scheduled reminder to cancel"),
});

export type CancelJobParams = z.infer<typeof cancelJobSchema>;

export interface CancelJobResult {
  readonly success: boolean;
  readonly name: string;
}

export const cancelJobAction: ActionDefinition<CancelJobParams, CancelJobResult> = {
  name: "cancel_job",
  description: "Cancel a previously scheduled delayed reminder for the current session.",
  parameters: cancelJobSchema,
  scopes: ["conversation"],
  async handler(
    params: CancelJobParams,
    context: ActionContext,
  ): Promise<CancelJobResult> {
    const store = context.requireService<Store>("store");
    const cancelled = await store.cancelScheduledJob(context.sessionId, params.name);

    context.logger.info("scheduled job cancellation requested", {
      sessionId: context.sessionId,
      name: params.name,
      success: cancelled,
    });

    return {
      success: cancelled,
      name: params.name,
    };
  },
};
