import { Logger } from "../../observability/logger.ts";
import { createActionContext } from "../../actions/context.ts";
import type { ActionRegistry } from "../../actions/registry.ts";
import type { ActionContext } from "../../actions/types.ts";
import type {
  ITaskExecutor,
  TaskDefinition,
  TaskExecutionContext,
  TaskRunResult,
} from "../types.ts";

/**
 * Direct action task executor.
 * Dispatches deterministic actions without agent reasoning.
 */
export class ActionTaskExecutor implements ITaskExecutor {
  readonly type = "action";

  constructor(
    private readonly actionRegistry: ActionRegistry,
    private readonly logger = new Logger(),
    private readonly actionContextFactory?: ((context: TaskExecutionContext) => ActionContext) | undefined,
  ) {}

  canHandle(task: TaskDefinition): boolean {
    return task.type === "action" || Boolean(task.action);
  }

  async execute(context: TaskExecutionContext): Promise<TaskRunResult> {
    const started = Date.now();
    const actionName = context.task.action;

    if (!actionName || actionName.trim() === "") {
      return {
        success: false,
        durationMs: 0,
        stateBefore: context.stateBefore,
        stateAfter: context.stateBefore,
        error: `Action task "${context.task.taskKey}" has no "action" specified`,
      };
    }

    try {
      const params = {
        ...context.stateBefore,
        ...(context.task.actionParams ?? {}),
      };

      const actionContext: ActionContext = this.actionContextFactory
        ? this.actionContextFactory(context)
        : context.createActionContext
          ? context.createActionContext({
              sessionId: `task_action_${context.task.taskId}`,
              signal: context.signal,
            })
          : createActionContext({
              projectId: context.task.projectId,
              sessionId: `task_action_${context.task.taskId}`,
              taskKey: context.task.taskKey,
              workspacePath: context.workspacePath ?? process.cwd(),
              logger: this.logger,
              signal: context.signal,
              onGetTaskState: async () => context.stateBefore,
              onUpdateTaskState: context.updateState
                ? async (delta, opts) => {
                    let newState = delta;
                    if (opts?.merge !== false) {
                      newState = { ...context.stateBefore, ...delta };
                    }
                    context.updateState!(newState);
                    return newState;
                  }
                : undefined,
            });

      this.logger.info("executing direct action task", {
        taskKey: context.task.taskKey,
        action: actionName,
      });

      const output = await this.actionRegistry.execute(actionName, params, actionContext);
      const durationMs = Date.now() - started;

      if (!output.success) {
        return {
          success: false,
          durationMs,
          stateBefore: context.stateBefore,
          stateAfter: context.stateBefore,
          error: output.error,
        };
      }

      let stateAfter = context.stateBefore;
      if (output.data && typeof output.data === "object" && "state" in output.data) {
        const stateOutput = (output.data as { state: unknown }).state;
        if (stateOutput && typeof stateOutput === "object" && !Array.isArray(stateOutput)) {
          stateAfter = {
            ...context.stateBefore,
            ...(stateOutput as Record<string, unknown>),
          };
        }
      }

      if (context.updateState && stateAfter !== context.stateBefore) {
        context.updateState(stateAfter);
      }

      return {
        success: true,
        durationMs,
        stateBefore: context.stateBefore,
        stateAfter,
        actionsSummary: {
          action: actionName,
          result: output.data,
        },
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("direct action task execution failed", {
        taskKey: context.task.taskKey,
        action: actionName,
        error: msg,
      });

      return {
        success: false,
        durationMs,
        stateBefore: context.stateBefore,
        stateAfter: context.stateBefore,
        error: msg,
      };
    }
  }
}
