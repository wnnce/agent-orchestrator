import { existsSync } from "node:fs";
import type { ProjectConfig } from "../domain/types.ts";
import { SkillManager } from "../project/skills.ts";

/** A directory of orchestrator-managed skills and the project it belongs to. */
export interface SkillSource {
  projectId: string;
  dir: string;
}

/**
 * The orchestrator-managed skills a session of `project` loads besides the repository's own:
 * the global project's `.skills` first, then the project's. Each runtime passes them through its
 * own API (Codex extra roots, Pi skill paths, Claude Code plugins).
 */
export function projectSkillSources(
  project: ProjectConfig,
  globalProject?: ProjectConfig | undefined,
): SkillSource[] {
  const projects =
    globalProject && globalProject.id !== project.id ? [globalProject, project] : [project];
  return projects.flatMap((p) => {
    const dir = SkillManager.getSkillsDir(p);
    return dir && existsSync(dir) ? [{ projectId: p.id, dir }] : [];
  });
}
