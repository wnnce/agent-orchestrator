import { z } from "zod";
import { REASONING_EFFORTS, type ReasoningEffort } from "../domain/types.ts";
import type { Context } from "../observability/tracing.ts";

/**
 * Optional per-task runtime override schema (mirrors project.yaml `runtime:` shape).
 */
export const taskRuntimeSchema = z
  .object({
    type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Runtime adapter override (e.g. codex, claude, pi, acp)"),
    model: z.string().trim().min(1).optional().describe("Model identifier override for this task"),
    reasoningEffort: z
      .enum(REASONING_EFFORTS)
      .optional()
      .describe("Reasoning effort override for this task"),
  })
  .strict();

export interface TaskRuntimeConfig {
  readonly type?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

/**
 * Task markdown YAML frontmatter validation schema.
 */
export const taskFrontmatterSchema = z.object({
  id: z.string().min(1).optional().describe("Unique task short identifier (defaults to filename without extension)"),
  name: z.string().min(1).describe("Human-readable task name"),
  cron: z.string().min(1).describe("Standard 5-field cron expression (e.g. '*/10 * * * *')"),
  timezone: z.string().optional().describe("Schedule timezone (e.g. 'Asia/Shanghai', defaults to system timezone)"),
  enabled: z.boolean().optional().default(true).describe("Whether task scheduling is enabled"),
  description: z.string().optional().describe("Task description and business purpose"),
  timeoutMs: z.number().positive().optional().describe("Task execution timeout in milliseconds"),
  runtime: taskRuntimeSchema
    .optional()
    .describe("Optional runtime, model, and reasoningEffort override for agent tasks"),
});

export type TaskFrontmatter = z.infer<typeof taskFrontmatterSchema>;

export type TaskSourceFormat = "markdown" | "typescript";

/**
 * Structured static task definition.
 */
export interface TaskDefinition {
  readonly taskKey: string; // Format: `${projectId}:${taskId}`
  readonly projectId: string;
  readonly taskId: string;
  readonly name: string;
  readonly cron: string;
  readonly timezone?: string | undefined;
  readonly enabled: boolean;
  readonly description?: string | undefined;
  readonly promptTemplate: string;
  readonly filePath: string;
  readonly sourceFormat?: TaskSourceFormat | undefined;
  readonly fileMtimeMs?: number | undefined;
  /** Which executor runs it: `agent` for Markdown prompt tasks, `ts` for TypeScript tasks. */
  readonly type: string;
  readonly timeoutMs?: number | undefined;
  readonly runtime?: TaskRuntimeConfig | undefined;
}

/**
 * Queued task awaiting worker execution in memory queue.
 */
export interface QueuedTask {
  readonly taskKey: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly task: TaskDefinition;
  readonly enqueuedAt: Date;
  /** Trace of whoever queued the task (an API request, a cron tick); the run continues it. */
  readonly traceContext: Context;
}

/**
 * Task execution context.
 */
export interface TaskExecutionContext {
  readonly executionId: string;
  readonly task: TaskDefinition;
  readonly stateBefore: Record<string, unknown>;
  readonly signal?: AbortSignal | undefined;
  readonly updateState?: ((state: Record<string, unknown>) => void) | undefined;
  readonly workspacePath?: string | undefined;
}

/**
 * Task execution result.
 */
export interface TaskRunResult {
  readonly success: boolean;
  readonly sessionId?: string | undefined;
  readonly durationMs: number;
  readonly stateBefore: Record<string, unknown>;
  readonly stateAfter: Record<string, unknown>;
  readonly actionsSummary?: Record<string, unknown> | undefined;
  readonly error?: string | undefined;
}

/**
 * Abstract task executor interface.
 */
export interface ITaskExecutor {
  readonly type: string;
  canHandle(task: TaskDefinition): boolean;
  execute(context: TaskExecutionContext): Promise<TaskRunResult>;
}

/**
 * Function signature for custom task executors.
 */
export type TaskExecutorFn = (
  task: TaskDefinition,
  state: Record<string, unknown>,
  context?: TaskExecutionContext | undefined,
) => Promise<TaskRunResult>;

/**
 * Task executor union type.
 */
export type TaskExecutor = ITaskExecutor | TaskExecutorFn;

/**
 * Task engine configuration options.
 */
export interface TaskEngineOptions {
  readonly maxConcurrency?: number | undefined; // Maximum concurrent worker slots (default: 2)
  readonly registry?: import("./registry.ts").TaskExecutorRegistry | undefined;
}
