import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../domain/types.ts";
import { GLOBAL_PROJECT_ID, DEFAULT_GLOBAL_PROMPT } from "./global.ts";

export class PromptManager {
  constructor(private readonly baseDir: string = process.cwd()) {}

  async load(project: ProjectConfig, promptName: string): Promise<string | undefined> {
    const projectBase = project.projectDir
      ? path.resolve(this.baseDir, project.projectDir)
      : this.baseDir;

    // 1. Check explicit path in project.prompts
    const explicitPath = project.prompts?.[promptName];
    if (explicitPath) {
      return this.readFile(explicitPath, projectBase);
    }

    // 2. Check candidate directories
    const candidateDirs: string[] = [];
    if (project.promptsDir) {
      candidateDirs.push(
        path.isAbsolute(project.promptsDir)
          ? project.promptsDir
          : path.resolve(projectBase, project.promptsDir),
      );
    }
    if (project.projectDir) {
      candidateDirs.push(projectBase);
      candidateDirs.push(path.join(projectBase, "prompts"));
    }

    for (const dir of candidateDirs) {
      const filePath = path.join(dir, `${promptName}.md`);
      const content = await this.readFile(filePath, projectBase);
      if (content !== undefined) return content;
    }

    if (project.id === GLOBAL_PROJECT_ID) {
      // Check for global.md or AGENTS.md
      const customGlobal =
        (await this.readFile(path.join(projectBase, "global.md"), projectBase)) ??
        (await this.readFile(path.join(projectBase, "AGENTS.md"), projectBase));
      if (customGlobal !== undefined) return customGlobal;
      if (promptName === "system" || promptName === "rules") {
        return DEFAULT_GLOBAL_PROMPT;
      }
    }

    return undefined;
  }

  async getGlobalPrompt(projectDir?: string): Promise<string> {
    const dir = projectDir ? path.resolve(this.baseDir, projectDir) : this.baseDir;
    const custom =
      (await this.readFile(path.join(dir, "global.md"), dir)) ??
      (await this.readFile(path.join(dir, "AGENTS.md"), dir));
    return custom ?? DEFAULT_GLOBAL_PROMPT;
  }

  async loadAll(project: ProjectConfig): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (project.prompts) {
      for (const [key] of Object.entries(project.prompts)) {
        const content = await this.load(project, key);
        if (content !== undefined) result[key] = content;
      }
    }
    for (const standard of ["system", "fix", "analyze", "rules"]) {
      if (!result[standard]) {
        const content = await this.load(project, standard);
        if (content !== undefined) result[standard] = content;
      }
    }
    return result;
  }

  private async readFile(
    relativeOrAbsolutePath: string,
    baseDir: string = this.baseDir,
  ): Promise<string | undefined> {
    const fullPath = path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.resolve(baseDir, relativeOrAbsolutePath);

    try {
      const content = await readFile(fullPath, "utf-8");
      return content.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}
