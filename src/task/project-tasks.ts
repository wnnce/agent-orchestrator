import type { ContextOptions, ScopedContext } from "../context/index.ts";
import { ErrorCode, NotFoundError } from "../domain/errors.ts";
import type { TaskOrigin } from "../domain/origin.ts";
import type { ProjectConfig } from "../domain/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { Store } from "../persistence/store.ts";
import {
  buildNowPromptScope,
  buildProjectPromptScope,
  renderPromptTemplate,
} from "../prompt/template.ts";
import { TaskEngine } from "./engine.ts";
import { AgentTaskExecutor, type AgentSessionRunner } from "./executors/agent.ts";
import { TsTaskExecutor } from "./executors/ts.ts";
import { TaskLoader } from "./loader.ts";
import { TaskExecutorRegistry } from "./registry.ts";
import { TaskScheduler } from "./scheduler.ts";
import type { TaskDefinition } from "./types.ts";

/** What an agent task's prompt template can refer to. */
export type TaskPromptVars = Parameters<AgentSessionRunner["renderPrompt"]>[1];

export interface ProjectTasksDeps {
  readonly project: ProjectConfig;
  readonly store: Store;
  readonly logger: Logger;
  /** How agent tasks get a session and run their turn in it. */
  readonly sessions: Pick<AgentSessionRunner, "createSession" | "runTurn" | "cleanupSession">;
  /** The project's capabilities acting as a TS task. */
  readonly createContext: (origin: TaskOrigin, options: ContextOptions) => ScopedContext;
}

/**
 * The tasks of one project (`projects/<id>/tasks/`): scheduled by their cron, or run on demand.
 * Task files are read when listed or run, so edits take effect without a restart.
 */
export class ProjectTasks {
  readonly engine: TaskEngine;
  readonly scheduler: TaskScheduler;
  private readonly loader: TaskLoader;

  constructor(private readonly deps: ProjectTasksDeps) {
    const { store, logger } = deps;
    this.engine = new TaskEngine(store, logger);
    this.scheduler = new TaskScheduler(this.engine, logger);
    this.loader = new TaskLoader(logger);

    const executors = new TaskExecutorRegistry(logger);
    executors.register(
      new AgentTaskExecutor(
        {
          ...deps.sessions,
          renderPrompt: (template, vars) => this.renderPrompt(template, vars),
          getTaskState: (taskKey) => this.engine.getState(taskKey),
        },
        logger,
      ),
    );
    executors.register(
      new TsTaskExecutor(
        {
          resolveHandler: (task) => this.loader.resolveTsHandler(task),
          createContext: deps.createContext,
          appendLogs: (logs) => store.appendTaskExecutionLogs(logs),
        },
        logger,
      ),
    );
    this.engine.setRegistry(executors);
  }

  async list(): Promise<TaskDefinition[]> {
    const { projectDir, id, vars } = this.deps.project;
    if (!projectDir) return [];
    return this.loader.loadProjectTasks(projectDir, id, { vars });
  }

  /** Reads the task files again and schedules the tasks by their cron. */
  async reload(): Promise<TaskDefinition[]> {
    const tasks = await this.list();
    this.scheduler.reloadTasks(tasks);
    this.deps.logger.info("project tasks loaded and scheduled", {
      projectId: this.deps.project.id,
      taskCount: tasks.length,
    });
    return tasks;
  }

  /** Runs a task now, by ID or key; false when it is already running or queued. */
  async run(taskIdOrKey: string): Promise<boolean> {
    const task = (await this.list()).find(
      (t) => t.taskId === taskIdOrKey || t.taskKey === taskIdOrKey,
    );
    if (!task) {
      throw new NotFoundError(
        `Task ${taskIdOrKey} not found in project ${this.deps.project.id}`,
        ErrorCode.TASK_NOT_FOUND,
      );
    }
    return this.engine.dispatch(task);
  }

  /**
   * Renders an agent task's prompt. Templates can use `project.*`, `vars.*`, `task.*`,
   * `state` / `state.*` and `now.*`; unresolved variables are logged.
   */
  renderPrompt(template: string, vars: TaskPromptVars): string {
    const { project, logger } = this.deps;
    const { rendered, missingVars } = renderPromptTemplate(template, {
      project: buildProjectPromptScope(project),
      vars: project.vars ?? {},
      task: {
        id: vars.taskId,
        key: vars.taskKey,
        name: vars.taskName,
        cron: vars.cron ?? "",
        timezone: vars.timezone ?? "",
      },
      state: vars.state,
      now: buildNowPromptScope(vars.timezone),
    });
    if (missingVars.length > 0) {
      logger.warn("task prompt contains unresolved variables", {
        projectId: project.id,
        taskKey: vars.taskKey,
        missingVars,
      });
    }
    return rendered;
  }

  /** Stops scheduling and waits for the running tasks. */
  async stop(): Promise<void> {
    this.scheduler.stop();
    await this.engine.drain().catch(() => {});
  }
}
