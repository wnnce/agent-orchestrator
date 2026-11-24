import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectConfig, ProjectVars } from "../domain/types.ts";
import { Logger } from "../observability/logger.ts";
import { findMissingProjectVars } from "../prompt/template.ts";
import {
  type TaskExtensionAPI,
  type TsTaskHandler,
  tsTaskRegistrationSchema,
} from "./sdk.ts";
import { taskFrontmatterSchema, type TaskDefinition } from "./types.ts";

export interface LoadTasksOptions {
  readonly env?: Record<string, string> | undefined;
  readonly vars?: ProjectVars | undefined;
  readonly workdir?: string | undefined;
  readonly initTimeoutMs?: number | undefined;
}

interface LoadedTsModule {
  readonly tasks: TaskDefinition[];
  readonly handlers: Map<string, TsTaskHandler>;
  readonly mtimeMs: number;
}

interface CachedTsHandler {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly handler: TsTaskHandler;
}

const DEFAULT_TS_INIT_TIMEOUT_MS = 10_000;

/**
 * Determines whether a filename under `tasks/` should be loaded as a TypeScript task module.
 * Ignores declaration files (`*.d.ts`), test files (`*.test.ts`, `*.spec.ts`),
 * and underscore-prefixed helper modules (`_*.ts`).
 */
export function isTsTaskFile(fileName: string): boolean {
  if (!fileName.endsWith(".ts")) return false;
  if (fileName.startsWith("_")) return false;
  if (
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".test.ts") ||
    fileName.endsWith(".spec.ts")
  ) {
    return false;
  }
  return true;
}

/**
 * Parses markdown file content and YAML frontmatter into a TaskDefinition.
 */
export function parseTaskMarkdown(
  content: string,
  filePath: string,
  projectId: string,
): TaskDefinition {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(
      `Invalid task markdown format in ${filePath}: Missing YAML frontmatter block (--- ... ---)`,
    );
  }

  const rawYaml = match[1] ?? "";
  const promptTemplate = match[2]?.trim() ?? "";

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML frontmatter in ${filePath}: ${msg}`);
  }

  const result = taskFrontmatterSchema.safeParse(parsedYaml);
  if (!result.success) {
    throw new Error(`Frontmatter validation failed in ${filePath}: ${result.error.message}`);
  }

  const baseName = path.basename(filePath, ".md");
  const taskId = result.data.id || baseName;
  const taskKey = `${projectId}:${taskId}`;
  const executorType = result.data.executor ?? result.data.type ?? "agent";
  const rawRuntime = result.data.runtime;
  const taskRuntime =
    rawRuntime && (rawRuntime.type || rawRuntime.model || rawRuntime.reasoningEffort)
      ? {
          ...(rawRuntime.type ? { type: rawRuntime.type } : {}),
          ...(rawRuntime.model ? { model: rawRuntime.model } : {}),
          ...(rawRuntime.reasoningEffort ? { reasoningEffort: rawRuntime.reasoningEffort } : {}),
        }
      : undefined;

  return {
    taskKey,
    projectId,
    taskId,
    name: result.data.name,
    cron: result.data.cron,
    timezone: result.data.timezone,
    enabled: result.data.enabled,
    description: result.data.description,
    promptTemplate,
    filePath,
    sourceFormat: "markdown",
    type: executorType,
    ...(result.data.executor !== undefined ? { executor: result.data.executor } : {}),
    ...(result.data.command !== undefined ? { command: result.data.command } : {}),
    ...(result.data.action !== undefined ? { action: result.data.action } : {}),
    ...(result.data.actionParams !== undefined ? { actionParams: result.data.actionParams } : {}),
    ...(result.data.timeoutMs !== undefined ? { timeoutMs: result.data.timeoutMs } : {}),
    ...(taskRuntime ? { runtime: taskRuntime } : {}),
  };
}

/**
 * Dynamically imports and validates a Pi-style TypeScript task module:
 * `export default function (api: TaskExtensionAPI) { api.registerTask({ ... }); }`
 */
export async function loadTsTaskModule(
  filePath: string,
  projectId: string,
  options: LoadTasksOptions = {},
  logger = new Logger(),
): Promise<LoadedTsModule> {
  const absPath = path.resolve(filePath);
  const fileStat = await stat(absPath);
  const mtimeMs = fileStat.mtimeMs;
  const initTimeoutMs = options.initTimeoutMs ?? DEFAULT_TS_INIT_TIMEOUT_MS;
  // Note: Bun preserves query-string cache busting on filesystem paths (whereas `file://` URLs strip `?v=`).
  const specifier = `${absPath}?v=${mtimeMs}`;

  let mod: unknown;
  try {
    mod = await withTimeout(
      import(specifier),
      initTimeoutMs,
      `Timed out importing TS task module ${absPath} after ${initTimeoutMs}ms`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to import TS task module ${absPath}: ${msg}`);
  }

  const defaultExport =
    mod && typeof mod === "object" && "default" in mod
      ? (mod as { default?: unknown }).default
      : undefined;

  if (typeof defaultExport !== "function") {
    throw new Error(
      `Invalid TS task module ${absPath}: must default-export a factory function (export default function (api) { ... })`,
    );
  }

  const rawRegistrations: unknown[] = [];
  let registrationOpen = true;
  const workdir = options.workdir ?? path.dirname(path.dirname(absPath));
  const env = Object.freeze({ ...(options.env ?? {}) });

  const api: TaskExtensionAPI = {
    projectId,
    workdir,
    env,
    logger: logger.child({ projectId, filePath: absPath }),
    registerTask(task) {
      if (!registrationOpen) {
        throw new Error(
          `api.registerTask() in ${absPath} can only be called during module initialization`,
        );
      }
      rawRegistrations.push(task);
    },
  };

  try {
    await withTimeout(
      Promise.resolve().then(() => (defaultExport as (api: TaskExtensionAPI) => unknown)(api)),
      initTimeoutMs,
      `Timed out initializing TS task module ${absPath} after ${initTimeoutMs}ms`,
    );
  } finally {
    registrationOpen = false;
  }

  if (rawRegistrations.length === 0) {
    throw new Error(
      `Invalid TS task module ${absPath}: factory did not register any task via api.registerTask(...)`,
    );
  }

  const baseName = path.basename(absPath, ".ts");
  const isMultiTask = rawRegistrations.length > 1;
  const tasks: TaskDefinition[] = [];
  const handlers = new Map<string, TsTaskHandler>();
  const fileTaskIds = new Set<string>();

  for (let idx = 0; idx < rawRegistrations.length; idx++) {
    const parsed = tsTaskRegistrationSchema.safeParse(rawRegistrations[idx]);
    if (!parsed.success) {
      throw new Error(
        `Invalid TS task registration #${idx + 1} in ${absPath}: ${parsed.error.message}`,
      );
    }

    const data = parsed.data;
    if (isMultiTask && !data.id) {
      throw new Error(
        `Invalid TS task module ${absPath}: registered ${rawRegistrations.length} tasks, so every task must specify an explicit "id"`,
      );
    }

    const taskId = data.id ?? baseName;
    if (fileTaskIds.has(taskId)) {
      throw new Error(`Duplicate task id "${taskId}" registered in ${absPath}`);
    }
    fileTaskIds.add(taskId);

    const taskKey = `${projectId}:${taskId}`;
    tasks.push({
      taskKey,
      projectId,
      taskId,
      name: data.name,
      cron: data.cron,
      timezone: data.timezone,
      enabled: data.enabled,
      description: data.description,
      promptTemplate: "",
      filePath: absPath,
      sourceFormat: "typescript",
      fileMtimeMs: mtimeMs,
      type: "ts",
      ...(data.timeoutMs !== undefined ? { timeoutMs: data.timeoutMs } : {}),
    });
    handlers.set(taskKey, data.run);
  }

  return { tasks, handlers, mtimeMs };
}

export class TaskLoader {
  private readonly tsHandlers = new Map<string, CachedTsHandler>();

  constructor(private readonly logger = new Logger()) {}

  /**
   * Scans and loads all tasks/*.md and tasks/*.ts files under the specified project directory.
   */
  async loadProjectTasks(
    projectDir: string,
    projectId: string,
    options: LoadTasksOptions = {},
  ): Promise<TaskDefinition[]> {
    const tasksDir = path.resolve(projectDir, "tasks");

    try {
      await access(tasksDir, constants.R_OK);
    } catch {
      return [];
    }

    const entries = await readdir(tasksDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const tasks: TaskDefinition[] = [];
    const seenTaskKeys = new Set<string>();
    const activeTsTaskKeys = new Set<string>();
    const effectiveOptions: LoadTasksOptions = {
      ...options,
      workdir: options.workdir ?? projectDir,
    };

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(tasksDir, entry.name);

      if (entry.name.endsWith(".md")) {
        try {
          const content = await readFile(filePath, "utf8");
          const task = parseTaskMarkdown(content, filePath, projectId);
          if (seenTaskKeys.has(task.taskKey)) {
            this.logger.error("duplicate task id detected; skipping task", {
              taskKey: task.taskKey,
              filePath,
            });
            continue;
          }
          seenTaskKeys.add(task.taskKey);
          if (task.promptTemplate) {
            const missingVars = findMissingProjectVars(task.promptTemplate, options.vars);
            if (missingVars.length > 0) {
              this.logger.warn("task prompt references undefined project vars", {
                taskKey: task.taskKey,
                filePath,
                missingVars,
              });
            }
          }
          tasks.push(task);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error("failed to load task markdown", { filePath, error: msg });
        }
        continue;
      }

      if (isTsTaskFile(entry.name)) {
        try {
          const loaded = await loadTsTaskModule(filePath, projectId, effectiveOptions, this.logger);
          for (const task of loaded.tasks) {
            if (seenTaskKeys.has(task.taskKey)) {
              this.logger.error("duplicate task id detected; skipping ts task", {
                taskKey: task.taskKey,
                filePath,
              });
              continue;
            }
            const handler = loaded.handlers.get(task.taskKey);
            if (!handler) continue;
            seenTaskKeys.add(task.taskKey);
            activeTsTaskKeys.add(task.taskKey);
            tasks.push(task);
            this.tsHandlers.set(task.taskKey, {
              filePath: task.filePath,
              mtimeMs: loaded.mtimeMs,
              handler,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error("failed to load ts task module", { filePath, error: msg });
        }
      }
    }

    // Prune cached TS handlers belonging to this project that were removed from disk
    const projectPrefix = `${projectId}:`;
    for (const taskKey of Array.from(this.tsHandlers.keys())) {
      if (taskKey.startsWith(projectPrefix) && !activeTsTaskKeys.has(taskKey)) {
        this.tsHandlers.delete(taskKey);
      }
    }

    return tasks;
  }

  /**
   * Resolves the executable handler for a TypeScript task, hot-reloading the module
   * automatically if the file's mtime changed on disk.
   */
  async resolveTsHandler(
    task: TaskDefinition,
    options: LoadTasksOptions = {},
  ): Promise<TsTaskHandler> {
    const absPath = path.resolve(task.filePath);
    const currentStat = await stat(absPath);
    const cached = this.tsHandlers.get(task.taskKey);

    if (cached && cached.filePath === absPath && cached.mtimeMs === currentStat.mtimeMs) {
      return cached.handler;
    }

    const loaded = await loadTsTaskModule(absPath, task.projectId, options, this.logger);

    // Replace cached entries for this file with the freshly loaded handlers
    for (const [key, entry] of Array.from(this.tsHandlers.entries())) {
      if (entry.filePath === absPath && !loaded.handlers.has(key)) {
        this.tsHandlers.delete(key);
      }
    }
    for (const [key, handler] of loaded.handlers.entries()) {
      this.tsHandlers.set(key, {
        filePath: absPath,
        mtimeMs: loaded.mtimeMs,
        handler,
      });
    }

    const handler = loaded.handlers.get(task.taskKey);
    if (!handler) {
      throw new Error(
        `TS task "${task.taskKey}" is no longer registered in ${absPath}`,
      );
    }
    return handler;
  }

  /**
   * Scans and loads tasks across all configured projects.
   */
  async loadAllTasks(projects: readonly ProjectConfig[]): Promise<TaskDefinition[]> {
    const allTasks: TaskDefinition[] = [];
    for (const project of projects) {
      if (!project.projectDir) continue;
      const tasks = await this.loadProjectTasks(project.projectDir, project.id, {
        env: project.env,
        vars: project.vars,
        workdir: project.projectDir,
      });
      allTasks.push(...tasks);
    }
    return allTasks;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
