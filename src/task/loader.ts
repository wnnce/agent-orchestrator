import { readdir, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { Logger } from "../observability/logger.ts";
import type { ProjectConfig } from "../domain/types.ts";
import {
  taskFrontmatterSchema,
  type TaskDefinition,
} from "./types.ts";

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
    type: executorType,
    ...(result.data.executor !== undefined ? { executor: result.data.executor } : {}),
    ...(result.data.command !== undefined ? { command: result.data.command } : {}),
    ...(result.data.action !== undefined ? { action: result.data.action } : {}),
    ...(result.data.actionParams !== undefined ? { actionParams: result.data.actionParams } : {}),
    ...(result.data.timeoutMs !== undefined ? { timeoutMs: result.data.timeoutMs } : {}),
    ...(taskRuntime ? { runtime: taskRuntime } : {}),
  };
}

export class TaskLoader {
  constructor(private readonly logger = new Logger()) {}

  /**
   * Scans and loads all tasks/*.md files under the specified project directory.
   */
  async loadProjectTasks(projectDir: string, projectId: string): Promise<TaskDefinition[]> {
    const tasksDir = path.resolve(projectDir, "tasks");

    try {
      await access(tasksDir, constants.R_OK);
    } catch {
      return [];
    }

    const entries = await readdir(tasksDir, { withFileTypes: true });
    const tasks: TaskDefinition[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = path.join(tasksDir, entry.name);
        try {
          const content = await readFile(filePath, "utf8");
          const task = parseTaskMarkdown(content, filePath, projectId);
          tasks.push(task);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error("failed to load task markdown", { filePath, error: msg });
        }
      }
    }

    return tasks;
  }

  /**
   * Scans and loads tasks across all configured projects.
   */
  async loadAllTasks(projects: readonly ProjectConfig[]): Promise<TaskDefinition[]> {
    const allTasks: TaskDefinition[] = [];
    for (const project of projects) {
      if (!project.projectDir) continue;
      const tasks = await this.loadProjectTasks(project.projectDir, project.id);
      allTasks.push(...tasks);
    }
    return allTasks;
  }
}
