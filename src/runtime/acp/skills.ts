import path from "node:path";
import { mkdir, readlink, rm, symlink } from "node:fs/promises";
import type { ProjectConfig } from "../../domain/types.ts";
import { projectSkillSources } from "../skills.ts";

/**
 * Prepares isolated skill directories under `<dataDir>/acp-skills/<projectId>/{global,project}`
 * containing `.agents/skills -> <source.dir>` symlinks so ACP servers that support
 * `additionalDirectories` discover orchestrator-managed skills without touching the repo worktree.
 */
export async function prepareACPSkillDirectories(
  dataDir: string,
  project: ProjectConfig,
  globalProject?: ProjectConfig | undefined,
): Promise<string[]> {
  const sources = projectSkillSources(project, globalProject);
  if (sources.length === 0) return [];

  const dirs: string[] = [];
  for (const source of sources) {
    const scopeName = source.projectId === project.id ? "project" : "global";
    const rootDir = path.resolve(dataDir, "acp-skills", project.id, scopeName);
    const agentsDir = path.join(rootDir, ".agents");
    const linkPath = path.join(agentsDir, "skills");

    await mkdir(agentsDir, { recursive: true });
    if ((await readlink(linkPath).catch(() => undefined)) !== source.dir) {
      await rm(linkPath, { recursive: true, force: true });
      await symlink(source.dir, linkPath, "dir").catch((error: NodeJS.ErrnoException) => {
        // Another concurrent session of the same project created the symlink first.
        if (error.code !== "EEXIST") throw error;
      });
    }
    dirs.push(rootDir);
  }
  return dirs;
}
