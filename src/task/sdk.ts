import { z } from "zod";
import type { ProjectContext, TaskState } from "../context/types.ts";
import type { TaskOrigin } from "../domain/origin.ts";

/**
 * What a TypeScript task's `run` receives: the project context acting as this task execution,
 * the task itself, and its state carried from one execution to the next.
 */
export interface TaskContext<S extends object = Record<string, unknown>> extends ProjectContext {
  readonly origin: TaskOrigin;
  readonly task: {
    readonly id: string;
    readonly name: string;
    readonly cron: string;
    readonly timezone?: string | undefined;
  };
  /** The only way to read and write the task's state; it is saved when the execution succeeds. */
  readonly state: TaskState<S>;
}

/**
 * Runs one execution. A returned object is recorded as the execution's summary.
 */
export type TaskRun<S extends object = Record<string, unknown>> = (
  ctx: TaskContext<S>,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface TaskSpec<S extends object = Record<string, unknown>> {
  /** Unique within the project. Defaults to the file name for a file with a single task. */
  readonly id?: string | undefined;
  readonly name: string;
  readonly cron: string;
  readonly timezone?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly description?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly run: TaskRun<S>;
}

const TASK_BRAND = "AgentOrchestratorTask" as const;

/** A task as `defineTask` returns it; the loader accepts nothing else. */
export interface DefinedTask extends TaskSpec<Record<string, unknown>> {
  readonly __brand: typeof TASK_BRAND;
}

/**
 * Declares a scheduled TypeScript task. A file under `projects/<id>/tasks/` default-exports one
 * task, or an array of tasks that each have an `id`.
 *
 * ```ts
 * export default defineTask({
 *   name: "Issue poll",
 *   cron: "*\/10 * * * *",
 *   async run(ctx) {
 *     const since = ctx.state.get().since;
 *     ctx.state.merge({ since: new Date().toISOString() });
 *   },
 * });
 * ```
 */
export function defineTask<S extends object = Record<string, unknown>>(
  spec: TaskSpec<S>,
): DefinedTask {
  return { ...(spec as unknown as TaskSpec), __brand: TASK_BRAND };
}

export function isDefinedTask(value: unknown): value is DefinedTask {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === TASK_BRAND
  );
}

/** Validates what `defineTask` was given. */
export const taskSpecSchema = z
  .object({
    __brand: z.literal(TASK_BRAND),
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1),
    cron: z.string().trim().min(1),
    timezone: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional().default(true),
    description: z.string().optional(),
    timeoutMs: z.number().positive().optional(),
    run: z.custom<TaskRun>((value) => typeof value === "function", {
      message: "run must be a function",
    }),
  })
  .strict();
