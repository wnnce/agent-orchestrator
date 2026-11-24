import { Logger } from "../../observability/logger.ts";
import type {
  ITaskExecutor,
  TaskDefinition,
  TaskExecutionContext,
  TaskRunResult,
} from "../types.ts";

/**
 * Agent runtime delegate interface decoupling task execution from ProjectRuntime.
 */
export interface AgentSessionRunner {
  createSession(task: TaskDefinition): Promise<{ sessionId: string }>;
  renderPrompt(
    template: string,
    data: {
      state: Record<string, unknown>;
      projectId: string;
      taskId: string;
      taskKey: string;
      taskName: string;
      cron?: string | undefined;
      timezone?: string | undefined;
    },
  ): string;
  runTurn(
    sessionId: string,
    input: string,
  ): Promise<{ turnId: string; status: string; error?: string | undefined }>;
  cleanupSession(sessionId: string): Promise<void>;
  getTaskState(taskKey: string): Promise<Record<string, unknown>>;
}

/**
 * Full Agent task executor:
 * creates isolated worktree session -> renders prompt -> executes turn -> cleans up workspace.
 */
export class AgentTaskExecutor implements ITaskExecutor {
  readonly type = "agent";

  constructor(
    private readonly runner: AgentSessionRunner,
    private readonly logger = new Logger(),
  ) {}

  canHandle(task: TaskDefinition): boolean {
    return (task.type ?? "agent") === "agent" || Boolean(task.promptTemplate);
  }

  async execute(context: TaskExecutionContext): Promise<TaskRunResult> {
    const startedAt = Date.now();
    const task = context.task;
    this.logger.info("starting agent task execution", {
      taskKey: task.taskKey,
      taskId: task.taskId,
      projectId: task.projectId,
    });

    let sessionId: string | undefined;
    try {
      // 1. Create isolated session with taskKey for task-scoped actions
      const created = await this.runner.createSession(task);
      sessionId = created.sessionId;

      // 2. Render prompt from template
      const input = this.runner.renderPrompt(task.promptTemplate, {
        state: context.stateBefore,
        projectId: task.projectId,
        taskId: task.taskId,
        taskKey: task.taskKey,
        taskName: task.name,
        cron: task.cron,
        timezone: task.timezone,
      });

      // 3. Dispatch turn execution and await completion
      const turnResult = await this.runner.runTurn(sessionId, input);
      const success = turnResult.status === "completed";

      // 4. Retrieve latest incremental state on success
      const stateAfter = success
        ? await this.runner.getTaskState(task.taskKey)
        : context.stateBefore;

      return {
        success,
        sessionId,
        durationMs: Date.now() - startedAt,
        stateBefore: context.stateBefore,
        stateAfter,
        ...(turnResult.error !== undefined ? { error: turnResult.error } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("agent task execution failed with unhandled exception", {
        taskKey: task.taskKey,
        error: msg,
      });

      return {
        success: false,
        sessionId,
        durationMs: Date.now() - startedAt,
        stateBefore: context.stateBefore,
        stateAfter: context.stateBefore,
        error: msg,
      };
    } finally {
      // 5. Clean up session workspace on finish
      if (sessionId) {
        try {
          await this.runner.cleanupSession(sessionId);
        } catch (cleanupErr) {
          const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          this.logger.warn("failed to clean up task session", {
            sessionId,
            error: msg,
          });
        }
      }
    }
  }
}
